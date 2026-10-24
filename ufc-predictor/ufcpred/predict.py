"""Prediction service: full, explained predictions for a card, written to the ledger."""
from __future__ import annotations

import math

import numpy as np

from . import ledger
from .config import ModelConfig
from .db import audit
from .evaluation import metrics as M
from .features.build import StateCache
from .features.history import HistoryStore
from .models import engine, registry
from .providers.odds import devig
from .util import utcnow

METHOD_LABEL = {"KO_TKO": "KO/TKO", "SUB": "Submission", "DEC": "Decision", "DQ_OTHER": "DQ/Other"}
KEY_STATS = ["n_fights", "wins", "losses", "elo", "age", "height", "reach", "stance", "slpm", "sapm", "str_acc",
             "str_def", "td15", "td_acc", "td_def", "sub15", "kd15", "ctrl_share", "ko_loss_rate", "sub_loss_rate",
             "finish_win_rate", "d_slpm", "d_perf", "d_opp_elo", "streak", "days_since_last", "class_change",
             "late_ratio", "short_notice", "weight_miss", "debut", "minutes", "stats_coverage"]


def odds_before(conn, fight_id: int, as_of: str):
    row = conn.execute("SELECT * FROM odds WHERE fight_id=? AND captured_at<=? ORDER BY captured_at DESC LIMIT 1",
                       (fight_id, as_of + "T23:59:59")).fetchone()
    return dict(row) if row else None


def historical_calibration(conn, mode: str, conf: float) -> dict | None:
    rows = conn.execute(
        """SELECT p.p_red, e.correct_winner FROM prediction_evaluations e JOIN predictions p ON p.id=e.prediction_id
           WHERE e.scored=1 AND p.mode=?""", (mode,)).fetchall()
    if not rows:
        return None
    p = np.array([r["p_red"] for r in rows])
    c = np.maximum(p, 1 - p)
    corr = np.array([r["correct_winner"] for r in rows], dtype=float)
    for lo, hi in zip(M.BINS[:-1], M.BINS[1:]):
        if lo <= conf < hi:
            m = (c >= lo) & (c < hi)
            n = int(m.sum())
            if n < 30:
                return {"bin": f"{lo:.1f}–{min(hi, 1):.1f}", "n": n, "sufficient": False}
            k = int(corr[m].sum())
            lo_ci, hi_ci = M.wilson(k, n)
            return {"bin": f"{lo:.1f}–{min(hi, 1):.1f}", "n": n, "sufficient": True, "accuracy": k / n,
                    "mean_conf": float(c[m].mean()), "ci": [lo_ci, hi_ci]}
    return None


def confidence(pred: dict, a: dict, b: dict, hist: dict | None) -> dict:
    sub = np.array(list(pred["submodel_p_red"].values()))
    disagreement = float(np.std(sub))
    sd = pred["logit_sd"]
    dis_logit = float(np.std([math.log(max(min(x, 1 - 1e-6), 1e-6) / (1 - max(min(x, 1 - 1e-6), 1e-6))) for x in sub]))
    total_sd = math.sqrt(sd ** 2 + dis_logit ** 2)
    z = pred["logit"]
    interval = [1 / (1 + math.exp(-(z - 1.2816 * total_sd))), 1 / (1 + math.exp(-(z + 1.2816 * total_sd)))]
    imputed = [c["feature"] for c in pred["contributions"] if c["imputed"]]
    min_fights = min(a["n_fights"], b["n_fights"])
    reasons = []
    score = 1.0
    if min_fights == 0:
        score -= 0.45
        reasons.append("a UFC debutant: statistics are population priors, not observations")
    elif min_fights < 3:
        score -= 0.25
        reasons.append(f"limited UFC sample (minimum {min_fights} prior fights)")
    if total_sd > 0.35:
        score -= 0.2
        reasons.append(f"wide model uncertainty (logit sd {total_sd:.2f})")
    if disagreement > 0.08:
        score -= 0.15
        reasons.append(f"sub-models disagree (sd of sub-model probabilities {disagreement:.2f})")
    if len(imputed) > 4:
        score -= 0.1
        reasons.append(f"{len(imputed)} inputs unknown and imputed")
    if hist and hist.get("sufficient") and abs(hist["accuracy"] - hist["mean_conf"]) > 0.08:
        score -= 0.1
        reasons.append(f"historical predictions in the {hist['bin']} band were miscalibrated "
                       f"({hist['accuracy']:.0%} correct vs {hist['mean_conf']:.0%} stated, n={hist['n']})")
    label = "High" if score >= 0.8 else "Medium" if score >= 0.5 else "Low"
    return {"label": label, "score": round(max(score, 0), 2), "logit_sd": sd, "submodel_disagreement": disagreement,
            "total_logit_sd": total_sd, "interval80_p_red": interval, "reasons": reasons,
            "historical_calibration": hist, "sufficient_data": min_fights >= 3 and len(imputed) <= 4,
            "note": "Confidence describes how reliable this probability is, not how likely the favourite is to win."}


def explain(pred: dict, a: dict, b: dict, names: tuple[str, str]) -> dict:
    red, blue = names
    contribs = sorted(pred["contributions"], key=lambda c: -abs(c["contribution"]))
    def item(c):
        return {"feature": c["feature"], "group": c["group"], "logit": round(c["contribution"], 4),
                "imputed": c["imputed"], "text": engine.describe_feature(c["feature"], a, b)}
    fav_red = [item(c) for c in contribs if c["contribution"] > 0.005][:5]
    fav_blue = [item(c) for c in contribs if c["contribution"] < -0.005][:5]
    style = [item(c) for c in contribs if c["group"] == "C_style" and abs(c["contribution"]) > 0.005][:3]
    adv = []
    for k, lab, fmt, better in (("slpm", "Sig. strikes landed/min", "{:.2f}", 1), ("sapm", "Sig. strikes absorbed/min", "{:.2f}", -1),
                                ("str_def", "Strike defense", "{:.0%}", 1), ("td15", "Takedowns/15 min", "{:.2f}", 1),
                                ("td_def", "Takedown defense", "{:.0%}", 1), ("ctrl_share", "Control-time share", "{:.0%}", 1),
                                ("kd15", "Knockdowns/15 min", "{:.2f}", 1), ("elo", "Elo", "{:.0f}", 1),
                                ("reach", "Reach (in)", "{:.0f}", 1)):
        va, vb = a.get(k), b.get(k)
        if va is None or vb is None:
            adv.append({"stat": lab, "red": None, "blue": None, "edge": "unknown"})
            continue
        edge = "red" if (va - vb) * better > 0 else "blue" if (va - vb) * better < 0 else "even"
        adv.append({"stat": lab, "red": fmt.format(va), "blue": fmt.format(vb), "edge": edge})
    unc = []
    for st, nm in ((a, red), (b, blue)):
        if st["debut"]:
            unc.append(f"{nm} has no UFC fights in the database; their statistics are population priors.")
        elif st["n_fights"] < 3:
            unc.append(f"{nm} has only {st['n_fights']} UFC fight(s) on record.")
        if st.get("missing_profile"):
            unc.append(f"{nm}: unknown {', '.join(st['missing_profile'])}.")
        if st.get("stats_coverage") is not None and st["stats_coverage"] < 0.8:
            unc.append(f"{nm}: per-round statistics exist for only {st['stats_coverage']:.0%} of past fights.")
        if st.get("short_notice") is None:
            unc.append(f"{nm}: short-notice status not documented (treated as unknown, not as 'no').")
        if st.get("days_since_last") and st["days_since_last"] > 450:
            unc.append(f"{nm}: {st['days_since_last']} days since last fight.")
    imputed = sorted({c["feature"] for c in pred["contributions"] if c["imputed"]})
    if imputed:
        unc.append("Imputed (unknown) inputs: " + ", ".join(imputed) + ".")
    unc.append("Records cover UFC bouts only; regional/pre-UFC records are not in the source data.")
    fav_is_red = pred["p_red"] >= 0.5
    dog, dog_side = (blue, "blue") if fav_is_red else (red, "red")
    dog_factors = fav_blue if fav_is_red else fav_red
    dm = pred["methods"][dog_side]
    fail = []
    for f_ in dog_factors[:3]:
        fail.append(f"{dog}'s edge proves decisive: {f_['text']}.")
    best = max(("KO_TKO", "SUB", "DEC"), key=lambda m_: dm[m_])
    fail.append(f"{dog} wins by {METHOD_LABEL[best]} (model: {dm[best]:.0%}; all routes {sum(dm.values()):.0%}).")
    if pred["p_draw_nc"] > 0:
        fail.append(f"Draw or no contest (base rate {pred['p_draw_nc']:.1%}, not matchup-specific).")
    return {"favoring_red": fav_red, "favoring_blue": fav_blue, "statistical_advantages": adv,
            "style_interactions": style, "uncertainties": unc, "failure_modes": fail,
            "basis": "Factors are exact additive contributions to the calibrated log-odds from model inputs."}


def build_prediction(raw: dict, a: dict, b: dict, fight: dict, names: tuple[str, str], params: dict,
                     version_label: str, hist: dict | None, odds: dict | None, base_rate: float = 0.5) -> dict:
    red_id, blue_id = fight["red_fighter_id"], fight["blue_fighter_id"]
    winner_red = raw["p_red"] >= 0.5
    win_side = "red" if winner_red else "blue"
    meth = raw["methods"][win_side]
    pm = max(meth, key=meth.get)
    rounds = raw["rounds"]
    r_best = int(np.argmax(rounds)) + 1
    predicted_round = r_best if rounds[r_best - 1] > raw["p_decision"] else None
    joint = sorted(((s, m_, p_) for s in ("red", "blue") for m_, p_ in raw["methods"][s].items()), key=lambda t: -t[2])
    market = None
    if odds:
        pr, pb, over = devig(odds["red_decimal"], odds["blue_decimal"])
        market = {"p_red": pr, "p_blue": pb, "overround": over, "bookmaker": odds.get("bookmaker"),
                  "captured_at": odds["captured_at"], "used_in_model": "F_market" in params["groups"]}
    pred = {
        "fight_id": fight["id"], "red": {"id": red_id, "name": names[0]}, "blue": {"id": blue_id, "name": names[1]},
        "p_red": raw["p_red"], "p_blue": 1 - raw["p_red"],
        "predicted_winner_id": red_id if winner_red else blue_id,
        "predicted_method": pm, "predicted_round": predicted_round,
        "methods": raw["methods"], "rounds": rounds, "p_decision": raw["p_decision"],
        "p_draw_nc": raw["p_draw_nc"], "most_likely_outcomes": [{"side": s, "method": m_, "p": p_} for s, m_, p_ in joint[:4]],
        "conditional_note": "Winner and method probabilities are conditional on a decisive result; "
                            "draw/no-contest probability is a separate base rate.",
        "submodels": raw["submodel_p_red"], "ensemble_weights": engine.ensemble_weights(params),
        "logit": raw["logit"], "contributions": raw["contributions"],
        "model": {"version": version_label, "config_fingerprint": ModelConfig.from_dict(params["config"]).fingerprint(),
                  "training_cutoff": params["cutoff"], "n_train": params["diagnostics"]["n_train"],
                  "calibration": {k: v for k, v in params["calibration"].items() if k != "isotonic"}},
        "market": market,
        "scheduled_rounds": fight.get("scheduled_rounds") or 3,
        "stats": {"red": {k: a.get(k) for k in KEY_STATS}, "blue": {k: b.get(k) for k in KEY_STATS}},
        "last5": {"red": a.get("last5"), "blue": b.get("last5")},
    }
    pred["baselines"] = {
        "elo_only_p_red": 1 / (1 + 10 ** ((b["elo"] - a["elo"]) / 400)),
        "experience_base_rate_p_red": (0.5 if a["n_fights"] == b["n_fights"] else
                                       base_rate if a["n_fights"] > b["n_fights"] else 1 - base_rate),
        "experience_base_rate": base_rate, "coin_flip_p_red": 0.5,
    }
    pred["confidence"] = confidence(raw, a, b, hist)
    pred["explanation"] = explain(raw, a, b, names)
    pred["data_quality"] = {
        "imputed_features": sorted({c["feature"] for c in raw["contributions"] if c["imputed"]}),
        "red_prior_fights": a["n_fights"], "blue_prior_fights": b["n_fights"],
        "red_missing_profile": a.get("missing_profile"), "blue_missing_profile": b.get("missing_profile"),
        "scheduled_rounds_assumed": fight.get("scheduled_rounds") is None,
    }
    # sanity: method probabilities reconcile with winner probabilities
    for side, p_side in (("red", pred["p_red"]), ("blue", pred["p_blue"])):
        assert abs(sum(pred["methods"][side].values()) - p_side) < 1e-9
    return pred


_BASE_RATE: dict = {}


def _base_rate(h, cutoff: str) -> float:
    key = (id(h), cutoff)
    if key not in _BASE_RATE:
        from .evaluation.backtest import experience_base_rate
        _BASE_RATE[key] = experience_base_rate(h, ModelConfig(), cutoff)
    return _BASE_RATE[key]


def eligible_fights(conn, event_id: int, mode: str) -> list[dict]:
    status = ("scheduled",) if mode == "live" else ("scheduled", "completed")
    rows = conn.execute(
        f"""SELECT f.*, e.date, fr.name AS red_name, fb.name AS blue_name FROM fights f
            JOIN events e ON e.id=f.event_id JOIN fighters fr ON fr.id=f.red_fighter_id
            JOIN fighters fb ON fb.id=f.blue_fighter_id
            WHERE f.event_id=? AND f.status IN ({','.join('?' * len(status))})
            ORDER BY COALESCE(f.bout_order, 999), f.id""", (event_id, *status)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        if d["scheduled_rounds"] not in (3, 5, None):
            continue
        out.append(d)
    return out


def predict_event(conn, event_id: int, *, mode: str = "live", as_of: str | None = None, reason: str = "preliminary",
                  h: HistoryStore | None = None, cache: StateCache | None = None, version_id: int | None = None,
                  allow_post_lock: bool = False, fight_ids: list[int] | None = None) -> list[int]:
    ev = conn.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()
    if ev is None:
        raise KeyError(f"event {event_id} not found")
    as_of = as_of or min(utcnow()[:10], ev["date"])
    if as_of > ev["date"]:
        raise ledger.LedgerError("cannot make a pre-fight prediction after the event date")
    mv = conn.execute("SELECT * FROM model_versions WHERE id=?", (version_id,)).fetchone() if version_id \
        else registry.active_version(conn)
    if mv is None:
        raise RuntimeError("no active model version; run `ufcpred train` (or the replay) first")
    params = registry.load_params(conn, mv["id"])
    if params["cutoff"] > as_of:
        raise ledger.LedgerError(f"model {mv['label']} was trained with data up to {params['cutoff']}, "
                                 f"after decision time {as_of}")
    h = h or HistoryStore.load(conn, elo_k=params["config"]["elo_k"])
    cache = cache or StateCache(h)
    fights = eligible_fights(conn, event_id, mode)
    if fight_ids is not None:
        fights = [f for f in fights if f["id"] in set(fight_ids)]
    if not fights:
        return []
    metas = []
    for f in fights:
        m = dict(h.fights[f["id"]])
        if m.get("scheduled_rounds") is None:
            m["scheduled_rounds"] = 3
        metas.append(m)
    odds = {f["id"]: o for f in fights if (o := odds_before(conn, f["id"], as_of))}
    raws, ds = engine.predict_metas(params, h, metas, as_of, cache, odds)
    audit_res = engine.leakage_audit(params, ds, as_of)
    if not audit_res["passed"]:
        raise ledger.LedgerError(f"leakage audit failed: {audit_res['problems']}")
    base_rate = _base_rate(h, params["cutoff"])
    ids = []
    for f, raw, (a, b, _) in zip(fights, raws, ds.pairs):
        conf_p = max(raw["p_red"], 1 - raw["p_red"])
        pred = build_prediction(raw, a, b, {**f, "scheduled_rounds": f["scheduled_rounds"]},
                                (f["red_name"], f["blue_name"]), params, mv["label"],
                                historical_calibration(conn, mode, conf_p), odds.get(f["id"]), base_rate)
        pred["leakage_audit"] = {"passed": True, "as_of": as_of}
        ids.append(ledger.record(conn, fight=f, pred=pred, model_version_id=mv["id"], mode=mode, as_of=as_of,
                                 reason=reason, red_state=a, blue_state=b, allow_post_lock=allow_post_lock,
                                 commit=False))
    audit(conn, "predictions.generated", "event", event_id, {"mode": mode, "count": len(ids), "reason": reason,
                                                             "model_version": mv["label"]})
    conn.commit()
    return ids
