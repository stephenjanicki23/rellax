"""Post-game review: grade the official (locked) predictions against official results.

Winner, winning-margin band, margin and total are graded separately; when a market line was stored
before the lock, the engine's side against the spread and its over/under lean are graded too.
Abandoned games are recorded but excluded. Each wrong pick gets a structured diagnostic built only from
pre-game inputs and the official result / box score.
"""
from __future__ import annotations

import math

from . import ledger
from .db import audit
from .features.build import bucket_of
from .ingest import latest_result
from .models.engine import norm_cdf
from .util import dumps, loads, utcnow

# feature -> realised box-score quantity that can test it: the favoured side should out-do the opponent on it
TESTABLE = {
    "efg": "efg", "shooting_matchup": "efg", "opp_efg": "efg", "three_matchup": "fg3", "three_accuracy": "fg3",
    "tov_pct": "tov", "opp_tov_pct": "tov", "turnover_matchup": "tov",
    "oreb_pct": "oreb", "dreb_pct": "oreb", "glass_matchup": "oreb",
    "ftr": "ftm", "foul_matchup": "ftm", "ortg": "pts", "d_ortg": "pts", "net": "pts", "d_net": "pts",
}


def _box(conn, game_id: int, team_id: int) -> dict | None:
    r = conn.execute("SELECT * FROM team_game_stats WHERE game_id=? AND team_id=?", (game_id, team_id)).fetchone()
    return dict(r) if r else None


def _edge(stat: str, me: dict, op: dict) -> float | None:
    try:
        if stat == "efg":
            return (me["fgm"] + 0.5 * me["fg3m"]) / me["fga"] - (op["fgm"] + 0.5 * op["fg3m"]) / op["fga"]
        if stat == "fg3":
            return me["fg3m"] - op["fg3m"]
        if stat == "tov":
            return op["tov"] - me["tov"]          # fewer of our own turnovers than theirs
        if stat == "oreb":
            return me["oreb"] - op["oreb"]
        if stat == "ftm":
            return me["ftm"] - op["ftm"]
        if stat == "pts":
            return me["pts"] - op["pts"]
    except (TypeError, KeyError, ZeroDivisionError):
        return None
    return None


def factor_support(conn, p, payload: dict) -> list[dict]:
    hb, ab = _box(conn, p["game_id"], p["home_team_id"]), _box(conn, p["game_id"], p["away_team_id"])
    out = []
    expl = payload["explanation"]
    for side, items in (("home", expl["favoring_home"]), ("away", expl["favoring_away"])):
        for it in items:
            stat = TESTABLE.get(it["feature"])
            me, op = (hb, ab) if side == "home" else (ab, hb)
            v = _edge(stat, me, op) if stat and me and op else None
            if v is None:
                out.append({"feature": it["feature"], "favoured": side, "verdict": "not testable from the box score",
                            "text": it["text"]})
                continue
            verdict = "supported" if v > 0 else "contradicted" if v < 0 else "neutral"
            out.append({"feature": it["feature"], "favoured": side, "verdict": verdict, "realised_stat": stat,
                        "realised_edge": round(v, 4), "text": it["text"]})
    return out


def evaluate_event(conn, event_id: int, mode: str) -> dict:
    preds = ledger.official_predictions(conn, event_id, mode)
    if not preds:
        return {"event_id": event_id, "mode": mode, "graded": 0, "note": "no locked predictions for this night"}
    summary = {"event_id": event_id, "mode": mode, "graded": 0, "excluded": 0, "pending": 0, "correct": 0}
    for p in preds:
        res = latest_result(conn, p["game_id"])
        g = conn.execute("SELECT status FROM games WHERE id=?", (p["game_id"],)).fetchone()
        if res is None:
            summary["pending" if g["status"] == "scheduled" else "excluded"] += 1
            continue
        if conn.execute("SELECT 1 FROM prediction_evaluations WHERE prediction_id=? AND result_id=?",
                        (p["id"], res["id"])).fetchone():
            continue
        payload = loads(p["payload_json"])
        details = {"result_revision": res["revision"], "actual_outcome": res["outcome"],
                   "home_score": res["home_score"], "away_score": res["away_score"], "periods": res["periods"],
                   "predicted_margin": p["predicted_margin"], "predicted_total": p["predicted_total"],
                   "predicted_bucket": p["predicted_bucket"]}
        if res["outcome"] != "win":
            conn.execute("""INSERT INTO prediction_evaluations(prediction_id, result_id, evaluated_at, scored, details_json)
                            VALUES (?,?,?,0,?)""", (p["id"], res["id"], utcnow(), dumps(details)))
            summary["excluded"] += 1
            continue
        margin = res["home_score"] - res["away_score"]
        total = res["home_score"] + res["away_score"]
        home_won = margin > 0
        p_actual = p["p_home"] if home_won else p["p_away"]
        correct = int(res["winner_team_id"] == p["predicted_winner_id"])
        y = 1.0 if home_won else 0.0
        brier = (p["p_home"] - y) ** 2
        ll = -math.log(max(p_actual, 1e-12))
        side = "home" if home_won else "away"
        band = bucket_of(abs(margin))
        p_joint = payload["bands"][side].get(band)
        bucket_correct = int(bool(correct) and band == p["predicted_bucket"])
        bucket_ll = -math.log(max(p_joint, 1e-12)) if p_joint is not None else None
        mu, sigma = payload["margin"]["mu"], payload["margin"]["sigma"]
        margin_ll = 0.5 * ((margin - mu) / sigma) ** 2 + math.log(sigma * math.sqrt(2 * math.pi))
        mk = payload.get("market") or {}
        ats = tot_pick = None
        if mk.get("spread_home") is not None:
            covered = margin + mk["spread_home"]
            if covered != 0:
                engine_home = mk["p_home_covers"] >= 0.5
                ats = int(engine_home == (covered > 0))
        if mk.get("total") is not None and total != mk["total"]:
            tot_pick = int((mk["p_over"] >= 0.5) == (total > mk["total"]))
        tmu = p["predicted_total"]
        note = "consistent" if p_actual >= 0.35 else "surprising" if p_actual >= 0.2 else "very_surprising"
        details.update({
            "p_actual_winner": p_actual, "actual_margin": margin, "actual_total": total, "actual_bucket": band,
            "p_actual_band_joint": p_joint, "margin_z": (margin - mu) / sigma, "margin_log_lik": -margin_ll,
            "total_z": None if tmu is None else (total - tmu) / payload["total"]["sd"],
            "p_margin_at_least_as_extreme": 2 * (1 - norm_cdf(abs(margin - mu) / sigma)),
            "factor_support": factor_support(conn, p, payload),
            "hindsight": ("engine leaned to the loser; single-game evidence of a weakness only if it recurs"
                          if not correct else f"engine picked the winner; confidence gap to certainty {1 - p_actual:.0%}"),
        })
        cur = conn.execute(
            """INSERT INTO prediction_evaluations(prediction_id, result_id, evaluated_at, scored, correct_winner, p_actual,
               brier, log_loss, margin_error, total_error, bucket_correct, bucket_log_loss, ats_correct,
               total_pick_correct, calibration_note, details_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (p["id"], res["id"], utcnow(), 1, correct, p_actual, brier, ll, margin - mu,
             None if tmu is None else total - tmu, bucket_correct, bucket_ll, ats, tot_pick, note, dumps(details)))
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
    home_won = details["actual_margin"] > 0
    winner = payload["home" if home_won else "away"]["name"]
    loser = payload["away" if home_won else "home"]["name"]
    dq = payload["data_quality"]
    p_actual = details["p_actual_winner"]
    wrong = [s for s in details["factor_support"] if s["verdict"] == "contradicted"]
    data_issue = min(dq["home_season_games"], dq["away_season_games"]) < 10 or len(dq["imputed_features"]) > 4
    category = "data_quality" if data_issue else "ordinary_uncertainty" if p_actual >= 0.30 else "model_weakness"
    underweighted = payload["explanation"]["favoring_home" if home_won else "favoring_away"][:3]
    report = {
        "q1_predicted": f"{loser} {max(p['p_home'], p['p_away']):.0%}, expected margin "
                        f"{abs(p['predicted_margin']):.1f} ({'home' if p['predicted_margin'] > 0 else 'away'})",
        "q2_actual": f"{winner} won {max(res['home_score'], res['away_score'])}–{min(res['home_score'], res['away_score'])}"
                     + (" in overtime" if (res["periods"] or 4) > 4 else ""),
        "q3_incorrect_assumptions": [f"{s['text']} — contradicted ({s['realised_stat']} edge {s['realised_edge']:+g})"
                                     for s in wrong] or ["no testable pre-game factor was contradicted by the box score"],
        "q4_underestimated_factors": [u["text"] for u in underweighted] or ["no pre-game factor favoured the winner"],
        "q5_consistent_with_probabilities": (
            f"Yes — the winner had {p_actual:.0%}; results like this are expected about {p_actual:.0%} of the time."
            if p_actual >= 0.30 else
            f"Weakly — the winner had only {p_actual:.0%}. Still possible by chance; one game cannot show a flaw."),
        "q6_classification": category,
        "q6_reason": {"data_quality": "early-season sample or imputed inputs",
                      "ordinary_uncertainty": "the result was reasonably likely under the stated probabilities",
                      "model_weakness": "a low-probability result with adequate data; treated as a hypothesis "
                                        "until it recurs across games"}[category],
        "q7_recurring_pattern": "evaluated by the learning loop's segment analysis (Learning Center)",
        "q8_justified_change": "none from this game alone; changes require out-of-sample evidence across game nights",
    }
    conn.execute("INSERT INTO error_diagnostics(evaluation_id, prediction_id, category, report_json, created_at) "
                 "VALUES (?,?,?,?,?) ON CONFLICT(evaluation_id) DO NOTHING",
                 (evaluation_id, p["id"], category, dumps(report), utcnow()))


def regrade_after_correction(conn, game_id: int, mode: str) -> dict:
    """A result correction produces a new evaluation against the new revision; the old one is kept."""
    g = conn.execute("SELECT event_id FROM games WHERE id=?", (game_id,)).fetchone()
    return evaluate_event(conn, g["event_id"], mode)
