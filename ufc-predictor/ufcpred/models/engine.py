"""The prediction engine: fit a ModelConfig on data before a cutoff; predict any fight.

Structure
---------
* Sub-models A–E (and F when odds exist): Bayesian logistic regressions on antisymmetric
  feature groups, no intercept (so corner cannot matter and P(A)+P(B)=1 by construction).
* Ensemble: a stacking regression over the sub-models' *out-of-fold* logits, produced by
  chronological inner folds of the training window. Its weights are learned, with a prior
  centred on equal weights. Optional evidence gating lets trust vary with experience.
* Calibration: temperature scaling (or symmetrised isotonic) fitted on the most recent
  slice of out-of-fold ensemble predictions — never on the rows it is evaluated on.
* Method model: multinomial logistic for P(method | winner), oriented winner-vs-loser,
  so method probabilities reconcile exactly with winner probabilities.
* Round model: Dirichlet-smoothed finish-round distribution by method and format.

Everything learned is serialised into `params` and stored with the model version.
"""
from __future__ import annotations

import math
from collections import Counter

import numpy as np

from ..config import ModelConfig
from ..features.build import (METHOD_CLASSES, Dataset, StateCache, build_rows, groups_for, method_class,
                              method_matrix, pair_states, training_metas)
from ..features.catalog import BY_NAME, METHOD_FEATURES, features_for
from ..features.history import HistoryStore
from ..util import days_between
from .logistic import Standardizer, fit_logistic, fit_softmax, softmax_predict

ENGINE_VERSION = "1.0"


def _sig(z):
    return 1 / (1 + np.exp(-np.clip(z, -35, 35)))


def _logit(p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


# ---------------------------------------------------------------------- sub-models
def fit_submodel(X: np.ndarray, y: np.ndarray, l2: float) -> dict:
    """Orientation-augmented fit: each fight contributes (x, y) and (−x, 1−y) at weight ½."""
    Xa = np.vstack([X, -X])
    ya = np.concatenate([y, 1 - y])
    sc = Standardizer().fit(Xa)
    Z = sc.transform(Xa)
    fit = fit_logistic(Z, ya, l2=l2, weights=np.full(len(ya), 0.5))
    return {"scaler": sc.to_dict(), "w": fit["w"].tolist(), "cov": fit["cov"].tolist(), "n": int(len(y))}


def sub_logits(model: dict, X: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    sc = Standardizer.from_dict(model["scaler"])
    Z = sc.transform(X)
    w = np.array(model["w"])
    cov = np.array(model["cov"])
    z = Z @ w
    var = np.einsum("ij,jk,ik->i", Z, cov, Z)
    return z, var, Z


def _stack_design(logits: np.ndarray, gate: np.ndarray | None) -> np.ndarray:
    return logits if gate is None else np.hstack([logits, logits * gate[:, None]])


def _gate(pairs) -> np.ndarray:
    return np.array([float(min(a["n_fights"], b["n_fights"]) < 3) for a, b, _ in pairs])


# ---------------------------------------------------------------------- calibration
def _pav(x: np.ndarray, y: np.ndarray):
    order = np.argsort(x)
    xs, ys = x[order], y[order].astype(float)
    blocks = [[ys[i], 1.0, xs[i], xs[i]] for i in range(len(xs))]
    out = []
    for b in blocks:
        out.append(b)
        while len(out) > 1 and out[-2][0] / out[-2][1] > out[-1][0] / out[-1][1]:
            s, n, lo, _ = out.pop(-2)
            out[-1] = [out[-1][0] + s, out[-1][1] + n, lo, out[-1][3]]
    xk = [ (b[2] + b[3]) / 2 for b in out]
    yk = [b[0] / b[1] for b in out]
    return xk, yk


def fit_isotonic(p: np.ndarray, y: np.ndarray) -> dict:
    xs = np.concatenate([p, 1 - p])
    ys = np.concatenate([y, 1 - y])
    xk, yk = _pav(xs, ys)
    return {"x": xk, "y": yk}


def apply_isotonic(iso: dict, p: np.ndarray) -> np.ndarray:
    f = lambda q: np.interp(q, iso["x"], iso["y"])
    out = (f(p) + 1 - f(1 - p)) / 2
    return np.clip(out, 0.01, 0.99)


def fit_temperature(z: np.ndarray, y: np.ndarray) -> float:
    best, best_t = None, 1.0
    for t in np.linspace(0.3, 2.0, 69):
        p = _sig(t * z)
        ll = -np.mean(y * np.log(np.clip(p, 1e-12, 1)) + (1 - y) * np.log(np.clip(1 - p, 1e-12, 1)))
        if best is None or ll < best:
            best, best_t = ll, float(t)
    return best_t


def _ll(p, y):
    p = np.clip(p, 1e-12, 1 - 1e-12)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


# ---------------------------------------------------------------------- fitting
def fit(h: HistoryStore, cfg: ModelConfig, cutoff: str, cache: StateCache | None = None,
        odds_by_fight: dict | None = None) -> dict:
    """Fit every component on fights strictly before `cutoff`. Returns serialisable params."""
    cache = cache or StateCache(h)
    metas, labels = training_metas(h, cfg, cutoff)
    if len(metas) < 200:
        raise ValueError(f"only {len(metas)} eligible training fights before {cutoff}; need at least 200")
    if cfg.use_market:
        metas = [m for m in metas if m["id"] in (odds_by_fight or {})]
    ds = build_rows(cache, metas, cfg, None, odds_by_fight, labels)
    assert max(ds.dates) < cutoff, "training data leaks past cutoff"
    groups = groups_for(cfg)
    n = len(ds)

    # Out-of-fold sub-model logits from chronological inner folds
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

    # Out-of-sample diagnostics within the training window (honest: none of these rows trained the stacker)
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
    }

    # Final sub-models on the full training window
    subs = {g: fit_submodel(ds.X[g], ds.y, cfg.l2[g]) for g in groups}

    # Method model, oriented winner vs loser
    red_won = [bool(v) for v in ds.y]
    keep = [i for i, mth in enumerate(ds.method) if mth is not None]
    MX = method_matrix([ds.pairs[i] for i in keep], [red_won[i] for i in keep])
    msc = Standardizer().fit(MX)
    MY = np.zeros((len(keep), len(METHOD_CLASSES)))
    for r, i in enumerate(keep):
        MY[r, METHOD_CLASSES.index(ds.method[i])] = 1
    freq = (MY.sum(axis=0) + 1) / (MY.sum() + len(METHOD_CLASSES))
    msm = fit_softmax(msc.transform(MX), MY, l2=cfg.l2["method"], class_prior=freq)

    # Finish-round distributions by method and format (Dirichlet α=1)
    rounds = {}
    for R in (3, 5):
        for mth in ("KO_TKO", "SUB", "DQ_OTHER"):
            c = Counter()
            for i in keep:
                if ds.pairs[i][2]["scheduled_rounds"] == R and ds.method[i] == mth and ds.end_round[i]:
                    c[int(ds.end_round[i])] += 1
            alpha = np.ones(R)
            counts = np.array([c.get(r, 0) for r in range(1, R + 1)], dtype=float)
            rounds[f"{mth}|{R}"] = ((counts + alpha) / (counts + alpha).sum()).tolist()

    # Draw / no-contest base rate over the last three years of the window
    recent = [m for fid, m in h.fights.items() if m["status"] == "completed" and m["date"] < cutoff
              and days_between(m["date"], cutoff) <= 3 * 365 and fid in h.results]
    n_dnc = sum(1 for m in recent if h.results[m["id"]]["outcome"] in ("draw", "nc"))
    dnc_rate = (n_dnc + 1) / (len(recent) + 2) if recent else 0.02

    return {
        "engine_version": ENGINE_VERSION, "cutoff": cutoff, "config": cfg.to_dict(), "groups": groups,
        "feature_names": {g: ds.names[g] for g in groups},
        "submodels": subs, "stack": {"w": sw.tolist(), "cov": stack["cov"].tolist(), "gated": cfg.evidence_gating},
        "calibration": calib, "method_model": {"scaler": msc.to_dict(), "W": msm["W"].tolist(),
                                               "classes": METHOD_CLASSES, "features": [f for f, _ in METHOD_FEATURES]},
        "rounds": rounds, "draw_nc_rate": dnc_rate, "diagnostics": diag,
        "max_train_date": ds.dates[-1],
    }


def _calibrated(z: np.ndarray, calib: dict) -> np.ndarray:
    if calib["method"] == "temperature":
        return _sig(calib["temperature"] * z)
    if calib["method"] == "isotonic":
        return apply_isotonic(calib["isotonic"], _sig(z))
    return _sig(z)


# ---------------------------------------------------------------------- prediction
def ensemble_weights(params: dict) -> dict:
    g = params["groups"]
    w = params["stack"]["w"]
    t = params["calibration"].get("temperature", 1.0) if params["calibration"]["method"] == "temperature" else 1.0
    out = {name: {"weight": w[i], "effective": w[i] * t} for i, name in enumerate(g)}
    if params["stack"]["gated"]:
        for i, name in enumerate(g):
            out[name]["low_experience_adjustment"] = w[len(g) + i]
    return out


def predict_rows(params: dict, ds: Dataset) -> list[dict]:
    """Full prediction for every row of a Dataset (states already point-in-time)."""
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
    D = _stack_design(L, gate)
    z_ens = D @ sw
    calib = params["calibration"]
    p_red = _calibrated(z_ens, calib)
    T = calib.get("temperature", 1.0) if calib["method"] == "temperature" else 1.0
    k = len(groups)
    coef = np.tile(sw[:k], (n, 1)) * T
    if gate is not None:
        coef = coef + gate[:, None] * sw[k:] * T
    logit_var = np.sum(coef ** 2 * V, axis=1)

    # method model, both orientations
    mm = params["method_model"]
    msc = Standardizer.from_dict(mm["scaler"])
    Wm = np.array(mm["W"])
    P_red_m = softmax_predict(Wm, msc.transform(method_matrix(ds.pairs, [True] * n)))
    P_blue_m = softmax_predict(Wm, msc.transform(method_matrix(ds.pairs, [False] * n)))

    out = []
    for i in range(n):
        a, b, ctx = ds.pairs[i]
        pr = float(p_red[i])
        pb = 1.0 - pr
        R = int(ctx["scheduled_rounds"] or 3)
        methods = {"red": {c: pr * float(P_red_m[i, j]) for j, c in enumerate(METHOD_CLASSES)},
                   "blue": {c: pb * float(P_blue_m[i, j]) for j, c in enumerate(METHOD_CLASSES)}}
        round_probs = [0.0] * R
        for side in ("red", "blue"):
            for mth in ("KO_TKO", "SUB", "DQ_OTHER"):
                dist = params["rounds"].get(f"{mth}|{R}") or [1 / R] * R
                for r in range(R):
                    round_probs[r] += methods[side][mth] * dist[r]
        p_dec = methods["red"]["DEC"] + methods["blue"]["DEC"]
        # contributions in calibrated-logit space (exact for temperature/none)
        contribs = []
        for gi, g in enumerate(groups):
            w = np.array(params["submodels"][g]["w"])
            names = params["feature_names"][g]
            raw = ds.X[g][i]
            for j, name in enumerate(names):
                c = float(coef[i, gi] * w[j] * Zs[g][i, j])
                contribs.append({"feature": name, "group": g, "contribution": c,
                                 "imputed": bool(np.isnan(raw[j])), "raw_diff": None if np.isnan(raw[j]) else float(raw[j])})
        sub_p = {g: float(_sig(L[i, gi])) for gi, g in enumerate(groups)}
        out.append({
            "p_red": pr, "p_blue": pb, "logit": float(z_ens[i] * T), "logit_sd": float(math.sqrt(logit_var[i])),
            "submodel_p_red": sub_p, "methods": methods, "rounds": round_probs, "p_decision": p_dec,
            "p_draw_nc": params["draw_nc_rate"], "contributions": contribs,
        })
    return out


def predict_metas(params: dict, h: HistoryStore, metas: list[dict], as_of: str, cache: StateCache | None = None,
                  odds_by_fight: dict | None = None) -> tuple[list[dict], Dataset]:
    cfg = ModelConfig.from_dict(params["config"])
    cache = cache or StateCache(h)
    ds = build_rows(cache, metas, cfg, lambda m: min(m["date"], as_of), odds_by_fight)
    return predict_rows(params, ds), ds


def leakage_audit(params: dict, ds: Dataset, as_of: str) -> dict:
    """Verify no input to these predictions post-dates its cutoff."""
    problems = []
    if params["max_train_date"] >= params["cutoff"]:
        problems.append("model trained on data at/after its cutoff")
    if params["cutoff"] > as_of:
        problems.append(f"model cutoff {params['cutoff']} is after decision time {as_of}")
    for fid, date, (a, b, _) in zip(ds.fight_ids, ds.dates, ds.pairs):
        limit = min(date, as_of)
        for st in (a, b):
            if st.get("last_fight_date") and st["last_fight_date"] >= limit:
                problems.append(f"fight {fid}: state uses a fight on {st['last_fight_date']} (limit {limit})")
            if st.get("as_of") and st["as_of"] > limit:
                problems.append(f"fight {fid}: state as_of {st['as_of']} after {limit}")
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
    return f"{f.label} ({a.get('name') or 'red'}: {show(a)} vs {b.get('name') or 'blue'}: {show(b)})"


def feature_list(cfg: ModelConfig) -> dict:
    return {g: [f.name for f in features_for(g, cfg.style_v2, cfg.strike_location, cfg.opp_adjusted)] for g in groups_for(cfg)}
