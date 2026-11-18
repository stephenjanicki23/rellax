"""The prediction engine: fit a ModelConfig on games before a cutoff; predict any game.

Structure
---------
* Sub-models A–E (and F when odds exist): Bayesian logistic regressions on antisymmetric feature
  groups, no intercept (home court is a learned feature), so P(home) + P(away) = 1 by construction.
* Ensemble: a stacking regression over the sub-models' *out-of-fold* logits from chronological inner
  folds of the training window, with a prior centred on equal weights; optional early-season gating.
* Calibration: temperature scaling (or symmetrised isotonic) on the most recent out-of-fold slice.
* Margin: home margin ~ Normal(μ, σ²) with μ = σ·Φ⁻¹(P(home)), so the margin distribution, the spread
  probabilities and the winning-margin bands reconcile exactly with the win probability. σ is fitted by
  maximum likelihood on out-of-fold rows.
* Total points: Bayesian linear regression on symmetric pace/efficiency features, relative to the
  point-in-time league average total (so scoring eras are handled), with an honest residual sd.
* Overtime: base rate scaled by how close the game is expected to be.

Everything learned is serialised into `params` and stored with the model version.
"""
from __future__ import annotations

import math

import numpy as np

from ..config import ModelConfig
from ..features.build import BUCKET_EDGES, BUCKETS, Dataset, StateCache, build_rows, groups_for, training_metas
from ..features.catalog import BY_NAME, TOTAL_FEATURES, features_for
from ..features.history import HistoryStore
from .logistic import Standardizer, fit_logistic, fit_ridge, ridge_predict

ENGINE_VERSION = "1.0"


def _sig(z):
    return 1 / (1 + np.exp(-np.clip(z, -35, 35)))


def norm_cdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def norm_pdf(x):
    return math.exp(-0.5 * x * x) / math.sqrt(2 * math.pi)


def norm_ppf(p: float) -> float:
    """Inverse standard normal CDF (Acklam's rational approximation, |error| < 1.2e-9)."""
    p = min(max(p, 1e-12), 1 - 1e-12)
    a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02,
         -3.066479806614716e+01, 2.506628277459239e+00]
    b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01,
         -1.328068155288572e+01]
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00,
         4.374664141464968e+00, 2.938163982698783e+00]
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00]
    lo = 0.02425
    if p < lo:
        q = math.sqrt(-2 * math.log(p))
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    if p > 1 - lo:
        q = math.sqrt(-2 * math.log(1 - p))
        return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    q = p - 0.5
    r = q * q
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / \
        (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)


# ---------------------------------------------------------------------- sub-models
def fit_submodel(X: np.ndarray, y: np.ndarray, l2: float) -> dict:
    """Orientation-augmented fit: each game contributes (x, y) and (−x, 1−y) at weight ½."""
    Xa = np.vstack([X, -X])
    ya = np.concatenate([y, 1 - y])
    sc = Standardizer().fit(Xa)
    Z = sc.transform(Xa)
    fit = fit_logistic(Z, ya, l2=l2, weights=np.full(len(ya), 0.5))
    return {"scaler": sc.to_dict(), "w": fit["w"].tolist(), "cov": fit["cov"].tolist(), "n": int(len(y))}


def sub_logits(model: dict, X: np.ndarray):
    sc = Standardizer.from_dict(model["scaler"])
    Z = sc.transform(X)
    w = np.array(model["w"])
    cov = np.array(model["cov"])
    return Z @ w, np.einsum("ij,jk,ik->i", Z, cov, Z), Z


def _stack_design(logits: np.ndarray, gate: np.ndarray | None) -> np.ndarray:
    return logits if gate is None else np.hstack([logits, logits * gate[:, None]])


def _gate(pairs) -> np.ndarray:
    return np.array([float(min(a["season_games"], b["season_games"]) < 10) for a, b, _ in pairs])


# ---------------------------------------------------------------------- calibration
def _pav(x, y):
    order = np.argsort(x)
    xs, ys = x[order], y[order].astype(float)
    out = []
    for i in range(len(xs)):
        out.append([ys[i], 1.0, xs[i], xs[i]])
        while len(out) > 1 and out[-2][0] / out[-2][1] > out[-1][0] / out[-1][1]:
            s, n, lo, _ = out.pop(-2)
            out[-1] = [out[-1][0] + s, out[-1][1] + n, lo, out[-1][3]]
    return [(b[2] + b[3]) / 2 for b in out], [b[0] / b[1] for b in out]


def fit_isotonic(p, y) -> dict:
    xk, yk = _pav(np.concatenate([p, 1 - p]), np.concatenate([y, 1 - y]))
    return {"x": xk, "y": yk}


def apply_isotonic(iso: dict, p):
    f = lambda q: np.interp(q, iso["x"], iso["y"])
    return np.clip((f(p) + 1 - f(1 - p)) / 2, 0.01, 0.99)


def fit_temperature(z, y) -> float:
    best, best_t = None, 1.0
    for t in np.linspace(0.3, 2.0, 69):
        p = _sig(t * z)
        ll = -np.mean(y * np.log(np.clip(p, 1e-12, 1)) + (1 - y) * np.log(np.clip(1 - p, 1e-12, 1)))
        if best is None or ll < best:
            best, best_t = ll, float(t)
    return best_t


def _calibrated(z, calib: dict):
    if calib["method"] == "temperature":
        return _sig(calib["temperature"] * z)
    if calib["method"] == "isotonic":
        return apply_isotonic(calib["isotonic"], _sig(z))
    return _sig(z)


def _ll(p, y):
    p = np.clip(p, 1e-12, 1 - 1e-12)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def fit_margin_sigma(p: np.ndarray, margin: np.ndarray) -> float:
    q = np.array([norm_ppf(float(x)) for x in p])
    best, best_s = None, 12.0
    for s in np.arange(6.0, 20.0, 0.05):
        ll = -np.sum((margin - s * q) ** 2) / (2 * s * s) - len(q) * math.log(s)
        if best is None or ll > best:
            best, best_s = ll, float(s)
    return best_s


# ---------------------------------------------------------------------- fitting
def fit(h: HistoryStore, cfg: ModelConfig, cutoff: str, cache: StateCache | None = None,
        odds_by_game: dict | None = None) -> dict:
    """Fit every component on games strictly before `cutoff`. Returns serialisable params."""
    cache = cache or StateCache(h)
    metas, labels = training_metas(h, cfg, cutoff)
    if cfg.use_market:
        metas = [m for m in metas if m["id"] in (odds_by_game or {})]
    if len(metas) < 300:
        raise ValueError(f"only {len(metas)} eligible training games before {cutoff}; need at least 300")
    ds = build_rows(cache, metas, cfg, None, odds_by_game, labels)
    assert max(ds.dates) < cutoff, "training data leaks past cutoff"
    groups = groups_for(cfg)
    n = len(ds)

    K = cfg.stack_inner_folds
    bounds = np.linspace(0, n, K + 2).astype(int)
    oof = np.full((n, len(groups)), np.nan)
    for j in range(1, K + 1):
        tr, te = slice(0, bounds[j]), slice(bounds[j], bounds[j + 1])
        for gi, g in enumerate(groups):
            m = fit_submodel(ds.X[g][tr], ds.y[tr], cfg.l2[g])
            oof[te, gi] = sub_logits(m, ds.X[g][te])[0]
    oof_idx = np.arange(bounds[1], n)
    n_cal = max(int(len(oof_idx) * cfg.calibration_frac), 100)
    stack_idx, cal_idx = oof_idx[:-n_cal], oof_idx[-n_cal:]
    gate = _gate(ds.pairs) if cfg.evidence_gating else None

    D = _stack_design(oof, gate)
    prior = np.zeros(D.shape[1])
    prior[: len(groups)] = 1.0 / len(groups)
    Ds = np.vstack([D[stack_idx], -D[stack_idx]])
    ys = np.concatenate([ds.y[stack_idx], 1 - ds.y[stack_idx]])
    stack = fit_logistic(Ds, ys, l2=cfg.l2["stack"], prior_mean=prior, weights=np.full(len(ys), 0.5))
    sw = stack["w"]

    z_cal = D[cal_idx] @ sw
    y_cal = ds.y[cal_idx]
    calib = {"method": cfg.calibration, "temperature": 1.0}
    if cfg.calibration == "temperature":
        calib["temperature"] = fit_temperature(z_cal, y_cal)
    elif cfg.calibration == "isotonic":
        calib["isotonic"] = fit_isotonic(_sig(z_cal), y_cal)

    # margin spread, from out-of-fold calibrated probabilities (rows the stacker/calibrator are not fitted on
    # for the calibration slice; the stack slice is out-of-fold for the sub-models)
    p_oof = _calibrated(D[oof_idx] @ sw, calib)
    sigma = fit_margin_sigma(p_oof, ds.margin[oof_idx])
    phis = np.array([norm_pdf(norm_ppf(float(p))) for p in p_oof])
    ot = np.array([1.0 if (pp or 4) > 4 else 0.0 for pp in [ds.periods[i] for i in oof_idx]])
    ot_rate = float((ot.sum() + 1) / (len(ot) + 2))

    # total points: fit before the calibration slice, judge on it, then refit on everything
    yt = ds.total - ds.league_total
    tsc_tmp = Standardizer().fit(ds.XT[: cal_idx[0]])
    tm_tmp = fit_ridge(tsc_tmp.transform(ds.XT[: cal_idx[0]]), yt[: cal_idx[0]], cfg.l2["total"])
    resid_cal = yt[cal_idx] - ridge_predict(tm_tmp, tsc_tmp.transform(ds.XT[cal_idx]))
    tsc = Standardizer().fit(ds.XT)
    tm = fit_ridge(tsc.transform(ds.XT), yt, cfg.l2["total"])

    diag = {"n_train": n, "n_oof": int(len(oof_idx)), "n_calibration": int(n_cal), "cutoff": cutoff,
            "train_first": ds.dates[0], "train_last": ds.dates[-1]}
    yo = ds.y[cal_idx]
    diag["calibration_slice"] = {
        "ensemble_log_loss": _ll(_calibrated(z_cal, calib), yo),
        "uncalibrated_log_loss": _ll(_sig(z_cal), yo),
        "submodels": {g: {"log_loss": _ll(_sig(oof[cal_idx, gi]), yo),
                          "accuracy": float(np.mean((oof[cal_idx, gi] > 0) == (yo == 1)))}
                      for gi, g in enumerate(groups)},
        "base_rate_log_loss": math.log(2),
        "home_win_rate": float(np.mean(ds.y)),
        "margin_sigma": sigma, "total_mae_holdout": float(np.mean(np.abs(resid_cal))),
        "total_sd_holdout": float(np.sqrt(np.mean(resid_cal ** 2))), "overtime_rate": ot_rate,
    }
    subs = {g: fit_submodel(ds.X[g], ds.y, cfg.l2[g]) for g in groups}
    return {
        "engine_version": ENGINE_VERSION, "cutoff": cutoff, "config": cfg.to_dict(), "groups": groups,
        "feature_names": {g: ds.names[g] for g in groups},
        "submodels": subs, "stack": {"w": sw.tolist(), "cov": stack["cov"].tolist(), "gated": cfg.evidence_gating},
        "calibration": calib,
        "margin": {"sigma": sigma, "ot_rate": ot_rate, "mean_phi": float(phis.mean())},
        "total_model": {"scaler": tsc.to_dict(), "w": tm["w"].tolist(), "cov": tm["cov"].tolist(),
                        "sigma": float(np.sqrt(np.mean(resid_cal ** 2))),
                        "features": [name for name, _, _ in TOTAL_FEATURES]},
        "diagnostics": diag, "max_train_date": ds.dates[-1],
    }


# ---------------------------------------------------------------------- prediction
def ensemble_weights(params: dict) -> dict:
    g = params["groups"]
    w = params["stack"]["w"]
    t = params["calibration"].get("temperature", 1.0) if params["calibration"]["method"] == "temperature" else 1.0
    out = {name: {"weight": w[i], "effective": w[i] * t} for i, name in enumerate(g)}
    if params["stack"]["gated"]:
        for i, name in enumerate(g):
            out[name]["early_season_adjustment"] = w[len(g) + i]
    return out


def margin_view(p_home: float, sigma: float) -> dict:
    """Margin distribution implied by the win probability: mean, bands for each side, spread probabilities."""
    mu = sigma * norm_ppf(p_home)
    F = lambda x: norm_cdf((x - mu) / sigma)
    bands = {"home": {}, "away": {}}
    for name, lo, hi in zip(BUCKETS, BUCKET_EDGES[:-1], BUCKET_EDGES[1:]):
        bands["home"][name] = (1.0 if hi == float("inf") else F(hi)) - F(lo)
        bands["away"][name] = F(-lo) - (0.0 if hi == float("inf") else F(-hi))
    return {"mu": mu, "sigma": sigma, "bands": bands}


def p_home_covers(mu: float, sigma: float, spread_home: float) -> float:
    """P(home margin + spread_home > 0), ignoring the exact-push mass for half-point lines."""
    return 1 - norm_cdf((-spread_home - mu) / sigma)


def p_over(total_mu: float, total_sd: float, line: float) -> float:
    return 1 - norm_cdf((line - total_mu) / total_sd)


def predict_rows(params: dict, ds: Dataset) -> list[dict]:
    groups = params["groups"]
    n = len(ds)
    L = np.zeros((n, len(groups)))
    V = np.zeros((n, len(groups)))
    Zs = {}
    for gi, g in enumerate(groups):
        z, var, Z = sub_logits(params["submodels"][g], ds.X[g])
        L[:, gi], V[:, gi], Zs[g] = z, var, Z
    sw = np.array(params["stack"]["w"])
    gate = _gate(ds.pairs) if params["stack"]["gated"] else None
    z_ens = _stack_design(L, gate) @ sw
    calib = params["calibration"]
    p_home = _calibrated(z_ens, calib)
    T = calib.get("temperature", 1.0) if calib["method"] == "temperature" else 1.0
    k = len(groups)
    coef = np.tile(sw[:k], (n, 1)) * T
    if gate is not None:
        coef = coef + gate[:, None] * sw[k:] * T
    logit_var = np.sum(coef ** 2 * V, axis=1)
    tm = params["total_model"]
    ZT = Standardizer.from_dict(tm["scaler"]).transform(ds.XT)
    tot_dev = ridge_predict(tm, ZT)
    tcov = np.array(tm["cov"])
    ZTa = np.hstack([np.ones((n, 1)), ZT])
    tvar = np.einsum("ij,jk,ik->i", ZTa, tcov, ZTa)
    wt = np.array(tm["w"])
    mg = params["margin"]
    out = []
    for i in range(n):
        ph = float(p_home[i])
        mv = margin_view(ph, mg["sigma"])
        p_ot = min(0.30, mg["ot_rate"] * norm_pdf(mv["mu"] / mg["sigma"]) / max(mg["mean_phi"], 1e-6))
        contribs = []
        for gi, g in enumerate(groups):
            w = np.array(params["submodels"][g]["w"])
            raw = ds.X[g][i]
            for j, name in enumerate(params["feature_names"][g]):
                contribs.append({"feature": name, "group": g, "contribution": float(coef[i, gi] * w[j] * Zs[g][i, j]),
                                 "imputed": bool(np.isnan(raw[j])),
                                 "raw_diff": None if np.isnan(raw[j]) else float(raw[j])})
        total_mu = float(ds.league_total[i] + tot_dev[i])
        total_terms = [{"feature": name, "points": float(wt[j + 1] * ZT[i, j]),
                        "imputed": bool(np.isnan(ds.XT[i, j]))} for j, (name, _, _) in enumerate(TOTAL_FEATURES)]
        out.append({
            "p_home": ph, "p_away": 1.0 - ph, "logit": float(z_ens[i] * T), "logit_sd": float(math.sqrt(logit_var[i])),
            "submodel_p_home": {g: float(_sig(L[i, gi])) for gi, g in enumerate(groups)},
            "margin": mv, "p_overtime": p_ot,
            "total": {"mu": total_mu, "sd": float(math.sqrt(tm["sigma"] ** 2 + tvar[i])),
                      "league_avg": float(ds.league_total[i]), "terms": total_terms,
                      "league_pace": float(ds.pairs[i][0]["league"]["pace"])},
            "contributions": contribs,
        })
    return out


def predict_metas(params: dict, h: HistoryStore, metas: list[dict], as_of: str, cache: StateCache | None = None,
                  odds_by_game: dict | None = None) -> tuple[list[dict], Dataset]:
    cfg = ModelConfig.from_dict(params["config"])
    cache = cache or StateCache(h)
    ds = build_rows(cache, metas, cfg, lambda m: min(m["date"], as_of), odds_by_game)
    return predict_rows(params, ds), ds


def leakage_audit(params: dict, ds: Dataset, as_of: str) -> dict:
    """Verify no input to these predictions post-dates its cutoff."""
    problems = []
    if params["max_train_date"] >= params["cutoff"]:
        problems.append("model trained on data at/after its cutoff")
    if params["cutoff"] > as_of:
        problems.append(f"model cutoff {params['cutoff']} is after decision time {as_of}")
    for gid, date, (a, b, _) in zip(ds.game_ids, ds.dates, ds.pairs):
        limit = min(date, as_of)
        for st in (a, b):
            if st.get("last_game_date") and st["last_game_date"] >= limit:
                problems.append(f"game {gid}: state uses a game on {st['last_game_date']} (limit {limit})")
            if st.get("as_of") and st["as_of"] > limit:
                problems.append(f"game {gid}: state as_of {st['as_of']} after {limit}")
    return {"passed": not problems, "problems": problems[:20], "checked": len(ds)}


def describe_feature(name: str, a: dict, b: dict) -> str:
    f = BY_NAME.get(name)
    if not f:
        return name

    def show(st):
        parts = []
        for k in f.show:
            v = st.get(k)
            if v is None:
                parts.append(f"{k}=unknown")
            elif isinstance(v, (int, float)):
                try:
                    parts.append(f"{k}={f.fmt.format(v)}")
                except (ValueError, TypeError):
                    parts.append(f"{k}={v}")
            else:
                parts.append(f"{k}={v}")
        return ", ".join(parts)
    return f"{f.label} ({a.get('name') or 'home'}: {show(a)} vs {b.get('name') or 'away'}: {show(b)})"


def feature_list(cfg: ModelConfig) -> dict:
    return {g: [f.name for f in features_for(g, cfg.style_v2, cfg.opp_adjusted)] for g in groups_for(cfg)}
