"""Post-event review: grade the official (locked) predictions against official results.

Winner, method and round are graded separately. Draws, no contests and canceled bouts
are recorded but excluded from winner metrics. Each incorrect pick gets a structured
diagnostic built only from pre-fight inputs and the official result/statistics.
"""
from __future__ import annotations

import math

from . import ledger
from .db import audit
from .features.build import method_class
from .ingest import latest_result
from .util import dumps, loads, utcnow

# feature -> realised statistic that can test it: the favoured side should out-do the opponent on it
TESTABLE = {
    "slpm": "sig_l", "d_slpm": "sig_l", "strike_exchange": "sig_l", "str_acc": "sig_l", "pressure_vs_defense": "sig_l",
    "sapm": "sig_l", "d_sapm": "sig_l", "str_def": "sig_l", "head_abs": "sig_l",
    "td15": "td_l", "d_td15": "td_l", "takedown_threat": "td_l", "td_def": "td_l", "d_td_def": "td_l",
    "ctrl_share": "ctrl_sec", "d_ctrl": "ctrl_sec", "ctrl_vs_tddef": "ctrl_sec", "pin_vs_getup": "ctrl_sec",
    "kd15": "kd", "d_kd15": "kd", "power_vs_chin": "kd", "kd_abs15": "kd",
    "sub15": "sub_att", "sub_threat": "sub_att", "ground_threat": "ground_l",
}


def _fight_totals(conn, fight_id: int, fighter_id: int) -> dict | None:
    rows = conn.execute("SELECT * FROM fight_stats WHERE fight_id=? AND fighter_id=?", (fight_id, fighter_id)).fetchall()
    if not rows:
        return None
    keys = ["sig_l", "td_l", "ctrl_sec", "kd", "sub_att", "ground_l"]
    return {k: sum((r[k] or 0) for r in rows) for k in keys}


def factor_support(conn, pred_row, payload: dict) -> list[dict]:
    red_t = _fight_totals(conn, pred_row["fight_id"], pred_row["red_fighter_id"])
    blue_t = _fight_totals(conn, pred_row["fight_id"], pred_row["blue_fighter_id"])
    out = []
    expl = payload["explanation"]
    for side, items in (("red", expl["favoring_red"]), ("blue", expl["favoring_blue"])):
        for it in items:
            stat = TESTABLE.get(it["feature"])
            if stat is None or red_t is None or blue_t is None:
                out.append({"feature": it["feature"], "favoured": side, "verdict": "not testable from fight statistics",
                            "text": it["text"]})
                continue
            # every testable factor claims an in-fight edge for the favoured side on this statistic
            key = stat
            v = (red_t[key] - blue_t[key]) if side == "red" else (blue_t[key] - red_t[key])
            verdict = "supported" if v > 0 else "contradicted" if v < 0 else "neutral"
            out.append({"feature": it["feature"], "favoured": side, "verdict": verdict, "realised_stat": key,
                        "realised_edge": v, "text": it["text"]})
    return out


def evaluate_event(conn, event_id: int, mode: str) -> dict:
    preds = ledger.official_predictions(conn, event_id, mode)
    if not preds:
        return {"event_id": event_id, "mode": mode, "graded": 0, "note": "no locked predictions for this event"}
    summary = {"event_id": event_id, "mode": mode, "graded": 0, "excluded": 0, "pending": 0, "correct": 0}
    for p in preds:
        res = latest_result(conn, p["fight_id"])
        fight = conn.execute("SELECT status FROM fights WHERE id=?", (p["fight_id"],)).fetchone()
        if res is None:
            summary["pending" if fight["status"] == "scheduled" else "excluded"] += 1
            continue
        if conn.execute("SELECT 1 FROM prediction_evaluations WHERE prediction_id=? AND result_id=?",
                        (p["id"], res["id"])).fetchone():
            continue
        payload = loads(p["payload_json"])
        details = {"result_revision": res["revision"], "actual_outcome": res["outcome"], "actual_method": res["method"],
                   "actual_round": res["end_round"], "actual_time_sec": res["end_time_sec"],
                   "fight_seconds": res["total_time_sec"], "predicted_method": p["predicted_method"],
                   "predicted_round": p["predicted_round"]}
        if res["outcome"] != "win":
            conn.execute("""INSERT INTO prediction_evaluations(prediction_id, result_id, evaluated_at, scored, details_json)
                            VALUES (?,?,?,0,?)""", (p["id"], res["id"], utcnow(), dumps(details)))
            summary["excluded"] += 1
            continue
        red_won = res["winner_fighter_id"] == p["red_fighter_id"]
        p_actual = p["p_red"] if red_won else p["p_blue"]
        correct = int(res["winner_fighter_id"] == p["predicted_winner_id"])
        y = 1.0 if red_won else 0.0
        brier = (p["p_red"] - y) ** 2
        ll = -math.log(max(p_actual, 1e-12))
        side = "red" if red_won else "blue"
        mclass = method_class(res["method"])
        p_joint = payload["methods"][side].get(mclass, 0.0) if mclass else None
        method_correct = int(correct and mclass == p["predicted_method"]) if mclass else None
        method_ll = -math.log(max(p_joint, 1e-12)) if p_joint is not None else None
        if mclass == "DEC":
            round_correct = int(p["predicted_round"] is None)
        elif mclass in ("KO_TKO", "SUB", "DQ_OTHER"):
            round_correct = int(p["predicted_round"] == res["end_round"])
        else:
            round_correct = None
        if p_actual >= 0.35:
            note = "consistent"
        elif p_actual >= 0.2:
            note = "surprising"
        else:
            note = "very_surprising"
        details.update({
            "p_actual_winner": p_actual, "p_actual_method_joint": p_joint,
            "hindsight": ("model leaned to the loser; single-fight evidence of overconfidence only if recurring"
                          if not correct else "model picked the winner; confidence gap to certainty "
                          f"{1 - p_actual:.0%}"),
            "factor_support": factor_support(conn, p, payload),
            "method_probability_of_actual": p_joint,
        })
        cur = conn.execute(
            """INSERT INTO prediction_evaluations(prediction_id, result_id, evaluated_at, scored, correct_winner, p_actual,
               brier, log_loss, method_correct, round_correct, method_log_loss, calibration_note, details_json)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (p["id"], res["id"], utcnow(), 1, correct, p_actual, brier, ll, method_correct, round_correct, method_ll,
             note, dumps(details)))
        summary["graded"] += 1
        summary["correct"] += correct
        if not correct:
            diagnose(conn, cur.lastrowid, p, payload, res, details)
    audit(conn, "event.evaluated", "event", event_id, summary)
    if mode == "live" and summary["pending"] == 0:
        conn.execute("UPDATE events SET status='evaluated', updated_at=? WHERE id=?", (utcnow(), event_id))
    conn.commit()
    return summary


def diagnose(conn, evaluation_id: int, p, payload: dict, res, details: dict) -> None:
    red_won = res["winner_fighter_id"] == p["red_fighter_id"]
    winner = payload["red" if red_won else "blue"]["name"]
    loser = payload["blue" if red_won else "red"]["name"]
    dq = payload["data_quality"]
    p_actual = details["p_actual_winner"]
    support = details["factor_support"]
    wrong_factors = [s for s in support if s["verdict"] == "contradicted"]
    data_issue = (min(dq["red_prior_fights"], dq["blue_prior_fights"]) < 3 or len(dq["imputed_features"]) > 4)
    if data_issue:
        category = "data_quality"
    elif p_actual >= 0.30:
        category = "ordinary_uncertainty"
    else:
        category = "model_weakness"
    winner_side = "favoring_red" if red_won else "favoring_blue"
    underweighted = payload["explanation"][winner_side][:3]
    report = {
        "q1_predicted": f"{loser} {max(p['p_red'], p['p_blue']):.0%} by {p['predicted_method']}"
                        + (f" in R{p['predicted_round']}" if p["predicted_round"] else " (decision)"),
        "q2_actual": f"{winner} by {res['method']}" + (f" R{res['end_round']} {res['end_time_sec'] // 60}:"
                                                        f"{res['end_time_sec'] % 60:02d}" if res["end_round"] and
                                                        res["end_time_sec"] is not None else ""),
        "q3_incorrect_assumptions": [f"{s['text']} — {s['verdict']} ({s['realised_stat']} edge {s['realised_edge']:+g})"
                                     for s in wrong_factors] or ["no testable pre-fight factor was contradicted"],
        "q4_underestimated_factors": [u["text"] for u in underweighted] or ["no pre-fight factor favoured the winner"],
        "q5_consistent_with_probabilities": (
            f"Yes — the winner had {p_actual:.0%}; outcomes like this are expected about "
            f"{p_actual:.0%} of the time." if p_actual >= 0.30 else
            f"Weakly — the winner had only {p_actual:.0%}. Still possible by chance; one result cannot show a flaw."),
        "q6_classification": category,
        "q6_reason": {"data_quality": "limited or imputed inputs (debut/low sample/unknown attributes)",
                      "ordinary_uncertainty": "the result was reasonably likely under the stated probabilities",
                      "model_weakness": "a low-probability result with adequate data; treated as a hypothesis "
                                        "until it recurs across fights"}[category],
        "q7_recurring_pattern": "evaluated by the learning loop's segment analysis (Learning Center)",
        "q8_justified_change": "none from this fight alone; changes require out-of-sample evidence across events",
    }
    conn.execute("INSERT OR IGNORE INTO error_diagnostics(evaluation_id, prediction_id, category, report_json, "
                 "created_at) VALUES (?,?,?,?,?)", (evaluation_id, p["id"], category, dumps(report), utcnow()))


def regrade_after_correction(conn, fight_id: int, mode: str) -> dict:
    """A result correction produces a new evaluation against the new revision; the old one is kept."""
    ev = conn.execute("SELECT event_id FROM fights WHERE id=?", (fight_id,)).fetchone()
    return evaluate_event(conn, ev["event_id"], mode)
