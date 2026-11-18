"""Recurring-error analysis over graded predictions.

Each hypothesis names a segment (e.g. "teams on a back-to-back") and asks whether the model's
probabilities for that side are biased: residual = actual − predicted. A hypothesis is
`supported` only when the segment has enough games AND the bias survives a
Benjamini–Hochberg false-discovery correction across all hypotheses tested together.
One surprising game can never pass this test.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable

import numpy as np

from ..evaluation.metrics import bootstrap_ci
from ..util import dumps, loads, utcnow


@dataclass
class Hypothesis:
    key: str
    description: str
    kind: str                       # winner | band | total
    side: Callable | None = None    # (payload) -> 'home' | 'away' | None
    target: Callable | None = None  # (payload, details) -> (actual, predicted) | None


def _fav(p):
    return "home" if p["p_home"] >= 0.5 else "away"


def _other(s):
    return "away" if s == "home" else "home"


def _st(p, s):
    return p["stats"][s]


def _first(p, cond):
    hits = [s for s in ("home", "away") if cond(_st(p, s), _st(p, _other(s)))]
    return hits[0] if len(hits) == 1 else None


def _blowout_target(p, d):
    if d.get("actual_bucket") is None:
        return None
    pb = p["bands"]["home"]["BLOWOUT"] + p["bands"]["away"]["BLOWOUT"]
    return (1.0 if d["actual_bucket"] == "BLOWOUT" else 0.0, pb)


def _close_target(p, d):
    if d.get("actual_bucket") is None:
        return None
    pc = p["bands"]["home"]["CLOSE"] + p["bands"]["away"]["CLOSE"]
    return (1.0 if d["actual_bucket"] == "CLOSE" else 0.0, pc)


def _total_target(cond):
    def f(p, d):
        if d.get("actual_total") is None or p.get("predicted_total") is None or not cond(p):
            return None
        # residual in units of the stated sd, so segments of different variance are comparable
        return (float(d["actual_total"] - p["predicted_total"]) / p["total"]["sd"], 0.0)
    return f


HYPOTHESES = [
    Hypothesis("favorites", "Probabilities given to favourites are biased (calibration slope)", "winner", _fav),
    Hypothesis("big_favorites", "Favourites priced at 75%+ win at a different rate than stated", "winner",
               lambda p: _fav(p) if max(p["p_home"], p["p_away"]) >= 0.75 else None),
    Hypothesis("home_court", "Home court is mis-weighted (home teams win at a different rate than stated)", "winner",
               lambda p: None if p.get("neutral_site") else "home"),
    Hypothesis("road_favorites", "Road favourites are mis-rated", "winner",
               lambda p: "away" if p["p_away"] > 0.5 and not p.get("neutral_site") else None),
    Hypothesis("back_to_back", "Teams on the second night of a back-to-back are mis-rated", "winner",
               lambda p: _first(p, lambda a, b: a.get("b2b") == 1.0 and b.get("b2b") != 1.0)),
    Hypothesis("rest_advantage", "Teams with two or more extra days of rest are mis-rated", "winner",
               lambda p: _first(p, lambda a, b: a.get("days_rest") is not None and b.get("days_rest") is not None
                                and a["days_rest"] - b["days_rest"] >= 2)),
    Hypothesis("long_road_trip", "Teams four or more games into a road trip are mis-rated", "winner",
               lambda p: _first(p, lambda a, b: (a.get("road_trip") or 0) >= 4)),
    Hypothesis("altitude", "Visitors at altitude (Denver, Utah) are mis-rated", "winner",
               lambda p: "away" if (_st(p, "home").get("venue_elevation") or 0) > 1000 and not p.get("neutral_site")
               else None),
    Hypothesis("early_season", "Early-season ratings (fewer than 10 games) carry the wrong weight", "winner",
               lambda p: _fav(p) if min(_st(p, "home").get("season_games") or 0,
                                        _st(p, "away").get("season_games") or 0) < 10 else None),
    Hypothesis("hot_streak", "Win streaks of five or more are over-valued", "winner",
               lambda p: _first(p, lambda a, b: (a.get("streak") or 0) >= 5)),
    Hypothesis("form_vs_season", "Teams whose recent form diverges from their season rating are mis-rated", "winner",
               lambda p: _first(p, lambda a, b: a.get("d_net") is not None and a.get("net") is not None
                                and a["d_net"] - a["net"] >= 4)),
    Hypothesis("playoffs", "Playoff games are mis-rated", "winner",
               lambda p: _fav(p) if p.get("season_type") in ("playoffs", "playin") else None),
    Hypothesis("blowout_rate", "The probability of a 13+ point game is biased", "band", target=_blowout_target),
    Hypothesis("close_game_rate", "The probability of a game decided by 5 or fewer is biased", "band",
               target=_close_target),
    Hypothesis("total_bias", "Total points are biased overall", "total", target=_total_target(lambda p: True)),
    Hypothesis("fast_pace_totals", "Totals are biased when both teams play faster than the league", "total",
               target=_total_target(lambda p: all((_st(p, s).get("pace") or 0) > (p["total"].get("league_pace") or 1e9) + 1
                                                  for s in ("home", "away")))),
]
BY_KEY = {h.key: h for h in HYPOTHESES}


def _bh(pvals: list[float]) -> list[float]:
    m = len(pvals)
    order = np.argsort(pvals)
    q = np.empty(m)
    prev = 1.0
    for rank, i in reversed(list(enumerate(order, start=1))):
        prev = min(prev, pvals[i] * m / rank)
        q[i] = prev
    return q.tolist()


def graded_rows(conn, mode: str, before: str | None = None) -> list[dict]:
    """Graded predictions using each prediction's evaluation against the latest result revision."""
    sql = """SELECT p.payload_json, p.p_home, p.home_team_id, e.details_json, e.correct_winner, ev.date, ev.id AS event_id,
                    r.winner_team_id, p.game_id
             FROM prediction_evaluations e JOIN predictions p ON p.id=e.prediction_id
             JOIN game_results r ON r.id=e.result_id JOIN events ev ON ev.id=p.event_id
             WHERE e.scored=1 AND p.mode=? AND r.revision=(SELECT MAX(revision) FROM game_results r2
                                                         WHERE r2.game_id=r.game_id)"""
    args = [mode]
    if before:
        sql += " AND ev.date < ?"
        args.append(before)
    out = []
    for r in conn.execute(sql + " ORDER BY ev.date", args):
        out.append({"payload": loads(r["payload_json"]), "details": loads(r["details_json"]),
                    "home_won": float(r["winner_team_id"] == r["home_team_id"]), "event_id": r["event_id"],
                    "date": r["date"], "game_id": r["game_id"]})
    return out


def analyze(conn, mode: str, min_n: int = 40, fdr_q: float = 0.10, learning_run_id: int | None = None,
            before: str | None = None, store: bool = True) -> list[dict]:
    rows = graded_rows(conn, mode, before)
    results = []
    for hyp in HYPOTHESES:
        resid, events, examples = [], [], []
        for r in rows:
            p = r["payload"]
            if hyp.kind == "winner":
                s = hyp.side(p)
                if s is None:
                    continue
                y = r["home_won"] if s == "home" else 1 - r["home_won"]
                ps = p["p_home"] if s == "home" else p["p_away"]
                resid.append(y - ps)
            else:
                t = hyp.target(p, r["details"])
                if t is None:
                    continue
                resid.append(t[0] - t[1])
            events.append(r["event_id"])
            if len(examples) < 8:
                examples.append(r["game_id"])
        n = len(resid)
        res = {"key": hyp.key, "description": hyp.description, "kind": hyp.kind, "n": n, "effect": None,
               "ci_low": None, "ci_high": None, "p_value": None, "q_value": None, "status": "insufficient_data",
               "example_game_ids": examples}
        if n >= 2:
            a = np.array(resid)
            se = a.std(ddof=1) / math.sqrt(n) if n > 1 and a.std(ddof=1) > 0 else float("inf")
            zstat = a.mean() / se if se and math.isfinite(se) else 0.0
            pval = math.erfc(abs(zstat) / math.sqrt(2))
            lo, hi = bootstrap_ci(a, np.array(events), B=400)
            res.update(effect=float(a.mean()), ci_low=lo, ci_high=hi, p_value=pval)
        results.append(res)
    testable = [r for r in results if r["n"] >= min_n and r["p_value"] is not None]
    if testable:
        qs = _bh([r["p_value"] for r in testable])
        for r, q in zip(testable, qs):
            r["q_value"] = q
            r["status"] = "supported" if q <= fdr_q else "not_supported"
    for r in results:
        if r["effect"] is not None:
            direction = "under" if r["effect"] > 0 else "over"
            if r["kind"] == "total":
                r["interpretation"] = (f"actual totals run {abs(r['effect']):.2f} sd {'above' if r['effect'] > 0 else 'below'} "
                                       f"the projection on average (n={r['n']})")
            else:
                r["interpretation"] = (f"model {direction}-estimates this segment by {abs(r['effect']):.1%} on average "
                                       f"(n={r['n']})")
    if store:
        now = utcnow()
        for r in results:
            conn.execute(
                """INSERT INTO weakness_hypotheses(key, learning_run_id, description, n, effect, ci_low, ci_high, p_value,
                   q_value, status, evidence_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (r["key"], learning_run_id, r["description"], r["n"], r["effect"], r["ci_low"], r["ci_high"],
                 r["p_value"], r["q_value"], r["status"], dumps({"examples": r["example_game_ids"],
                                                                 "interpretation": r.get("interpretation")}), now))
        conn.commit()
    return results
