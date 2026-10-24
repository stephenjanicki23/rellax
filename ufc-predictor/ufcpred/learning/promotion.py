"""Model promotion rules. A candidate replaces the incumbent only if every criterion passes.

Both configurations are evaluated on the *same* fights with the same rolling-origin folds,
so differences are paired. The decision and every criterion value are stored.
"""
from __future__ import annotations

import numpy as np

from ..evaluation import metrics as M
from ..evaluation.backtest import bt_arrays


def compare(inc_bt: dict, cand_bt: dict, settings: dict, primary_metric: str = "winner_log_loss") -> dict:
    a, b = bt_arrays(inc_bt), bt_arrays(cand_bt)
    pos_b = {f: i for i, f in enumerate(b["fight_id"])}
    pairs = [(i, pos_b[f]) for i, f in enumerate(a["fight_id"]) if f in pos_b]
    ia = np.array([i for i, _ in pairs], dtype=int)
    ib = np.array([j for _, j in pairs], dtype=int)
    y = a["y"][ia]
    ev = a["event"][ia]
    pa, pb = a["p"][ia], b["p"][ib]
    ll_a, ll_b = M.log_loss(pa, y), M.log_loss(pb, y)
    if primary_metric == "method_log_loss":
        ja, jb = a["p_joint"][ia], b["p_joint"][ib]
        ok = ~np.isnan(ja) & ~np.isnan(jb)
        prim_a, prim_b, prim_ev = -np.log(np.clip(ja[ok], 1e-12, 1)), -np.log(np.clip(jb[ok], 1e-12, 1)), ev[ok]
    else:
        prim_a, prim_b, prim_ev = ll_a, ll_b, ev
    B = int(settings["promotion.bootstrap_samples"])
    pc = M.paired_comparison(prim_a, prim_b, prim_ev, B=B)
    brier_a, brier_b = float(M.brier(pa, y).mean()), float(M.brier(pb, y).mean())
    ece_a, ece_b = M.ece(pa, y), M.ece(pb, y)
    cal_a, cal_b = M.calibration_table(pa, y), M.calibration_table(pb, y)
    worst_bin = 0.0
    for ta, tb in zip(cal_a, cal_b):
        if ta["n"] >= 30 and tb["n"] >= 30:
            worst_bin = max(worst_bin, abs(tb["accuracy"] - tb["mean_conf"]) - abs(ta["accuracy"] - ta["mean_conf"]))
    base = M.baselines(y, a["p_exp"][ia])
    cand_ll = float(ll_b.mean())
    crit = []

    def c(name, passed, value, threshold, note=""):
        crit.append({"criterion": name, "passed": bool(passed), "value": value, "threshold": threshold, "note": note})

    c("no_leakage", inc_bt["leakage_audit"]["passed"] and cand_bt["leakage_audit"]["passed"],
      {"incumbent": inc_bt["leakage_audit"]["passed"], "candidate": cand_bt["leakage_audit"]["passed"]}, True,
      "every fold trained strictly before its first event")
    c("sample_size_fights", pc["n"] >= settings["promotion.min_eval_fights"], pc["n"],
      settings["promotion.min_eval_fights"])
    c("sample_size_events", pc["n_events"] >= settings["promotion.min_eval_events"], pc["n_events"],
      settings["promotion.min_eval_events"])
    c(f"improves_{primary_metric}", pc["p_candidate_better"] >= settings["promotion.confidence"],
      {"mean_delta": pc["mean_delta"], "p_candidate_better": pc["p_candidate_better"], "ci90": pc["ci"]},
      settings["promotion.confidence"], "event-clustered paired bootstrap; delta = incumbent − candidate")
    c("brier_not_worse", brier_b - brier_a <= settings["promotion.max_brier_regression"],
      {"incumbent": brier_a, "candidate": brier_b}, settings["promotion.max_brier_regression"])
    c("calibration_not_worse", (ece_b - ece_a) <= settings["promotion.max_ece_regression"],
      {"incumbent_ece": ece_a, "candidate_ece": ece_b}, settings["promotion.max_ece_regression"],
      "5 equal-width bins on predicted-winner probability")
    c("calibration_by_range", worst_bin <= 0.05, worst_bin, 0.05,
      "no probability band (n≥30) may lose more than 5 points of calibration")
    c("beats_baselines", cand_ll < base["coin_flip"]["log_loss"] and cand_ll < base["base_rate"]["log_loss"],
      {"candidate": cand_ll, "coin_flip": base["coin_flip"]["log_loss"], "base_rate": base["base_rate"]["log_loss"]},
      "lower log loss")
    c("not_one_card", (pc["max_single_event_share"] <= settings["promotion.max_single_event_share"]
                       and pc["min_leave_one_event_out_delta"] > 0) if pc["mean_delta"] > 0 else False,
      {"max_single_event_share": pc["max_single_event_share"],
       "min_leave_one_event_out_delta": pc["min_leave_one_event_out_delta"]},
      settings["promotion.max_single_event_share"], "gain must survive dropping any single event")
    passed = all(x["passed"] for x in crit)
    return {"passed": passed, "criteria": crit, "primary_metric": primary_metric, "paired": pc,
            "incumbent": {"log_loss": float(ll_a.mean()), "brier": brier_a, "ece": ece_a,
                          "accuracy": float(np.mean((pa >= .5) == (y == 1)))},
            "candidate": {"log_loss": cand_ll, "brier": brier_b, "ece": ece_b,
                          "accuracy": float(np.mean((pb >= .5) == (y == 1)))},
            "baselines": base}


def refit_gate(inc_bt: dict) -> dict:
    """Re-estimating the *validated* configuration on more data: requires a clean, baseline-beating backtest."""
    m = inc_bt["metrics"]
    base = m.get("baselines", {})
    crit = [
        {"criterion": "no_leakage", "passed": inc_bt["leakage_audit"]["passed"], "value": inc_bt["leakage_audit"]["passed"],
         "threshold": True, "note": ""},
        {"criterion": "beats_coin_flip", "passed": m.get("log_loss", 9) < base.get("coin_flip", {}).get("log_loss", 0),
         "value": m.get("log_loss"), "threshold": base.get("coin_flip", {}).get("log_loss"), "note": ""},
        {"criterion": "beats_base_rate", "passed": m.get("log_loss", 9) < base.get("base_rate", {}).get("log_loss", 0),
         "value": m.get("log_loss"), "threshold": base.get("base_rate", {}).get("log_loss"), "note": ""},
    ]
    return {"passed": all(c["passed"] for c in crit), "criteria": crit}
