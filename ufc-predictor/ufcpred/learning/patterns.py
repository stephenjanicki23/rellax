"""Recurring-error analysis over graded predictions.

Each hypothesis names a segment (e.g. "fighters aged 35+") and asks whether the model's
probabilities for that side are biased: residual = actual − predicted. A hypothesis is
`supported` only when the segment has enough fights AND the bias survives a
Benjamini–Hochberg false-discovery correction across all hypotheses tested together.
One surprising result can never pass this test.
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
    kind: str                       # winner | method
    side: Callable | None = None    # (payload) -> 'red' | 'blue' | None
    method_target: Callable | None = None   # (payload, details) -> (actual 0/1, predicted p) | None


def _fav(p):
    return "red" if p["p_red"] >= 0.5 else "blue"


def _other(s):
    return "blue" if s == "red" else "red"


def _st(p, s):
    return p["stats"][s]


def _first(p, cond):
    hits = [s for s in ("red", "blue") if cond(_st(p, s), _st(p, _other(s)))]
    return hits[0] if len(hits) == 1 else None


def _ko_target(p, d):
    if d.get("actual_method") is None:
        return None
    pk = p["methods"]["red"]["KO_TKO"] + p["methods"]["blue"]["KO_TKO"]
    if pk < 0.35:
        return None
    dur = min(_st(p, "red").get("ko_loss_rate") or 1, _st(p, "blue").get("ko_loss_rate") or 1)
    if dur > 0.15:
        return None
    return (1.0 if d["actual_method"] == "KO_TKO" else 0.0, pk)


def _dec_target(p, d):
    if d.get("actual_method") is None:
        return None
    return (1.0 if d["actual_method"] == "DEC" else 0.0, p["p_decision"])


HYPOTHESES = [
    Hypothesis("favorites", "Probabilities given to favourites are biased (calibration slope)", "winner", _fav),
    Hypothesis("big_favorites", "Favourites priced at 70%+ win at a different rate than stated", "winner",
               lambda p: _fav(p) if max(p["p_red"], p["p_blue"]) >= 0.70 else None),
    Hypothesis("top_control_wrestlers", "Wrestlers with strong top control are mis-rated", "winner",
               lambda p: _first(p, lambda a, b: (a.get("ctrl_share") or 0) >= 0.25 and (a.get("td15") or 0) >= 2.0)),
    Hypothesis("weak_opposition_streak", "Recent win streaks built against weak opposition are over-valued", "winner",
               lambda p: _first(p, lambda a, b: (a.get("streak") or 0) >= 3 and (a.get("d_opp_elo") or 1500) < 1500)),
    Hypothesis("takedown_defense", "Fighters with elite takedown defense facing wrestlers are mis-rated", "winner",
               lambda p: _first(p, lambda a, b: (a.get("td_def") or 0) >= 0.80 and (b.get("td15") or 0) >= 2.0)),
    Hypothesis("aging_fighters", "Fighters aged 35+ are mis-rated from career averages", "winner",
               lambda p: _first(p, lambda a, b: (a.get("age") or 0) >= 35)),
    Hypothesis("low_experience_favorites", "Favourites with fewer than 3 UFC fights get excessive confidence", "winner",
               lambda p: _fav(p) if (_st(p, _fav(p)).get("n_fights") or 0) < 3 else None),
    Hypothesis("debutants", "UFC debutants are mis-rated", "winner",
               lambda p: _first(p, lambda a, b: bool(a.get("debut")))),
    Hypothesis("long_layoff", "Fighters returning from 15+ month layoffs are mis-rated", "winner",
               lambda p: _first(p, lambda a, b: (a.get("days_since_last") or 0) > 450)),
    Hypothesis("moving_up", "Fighters moving up a weight class are mis-rated", "winner",
               lambda p: _first(p, lambda a, b: (a.get("class_change") or 0) > 0)),
    Hypothesis("short_notice", "Short-notice replacements are mis-priced", "winner",
               lambda p: _first(p, lambda a, b: a.get("short_notice") == 1.0)),
    Hypothesis("five_round_favorites", "Favourites in five-round fights are mis-rated", "winner",
               lambda p: _fav(p) if p.get("scheduled_rounds") == 5 else None),
    Hypothesis("ko_vs_durable", "Knockout probability is over-estimated against durable opponents", "method",
               method_target=_ko_target),
    Hypothesis("decision_rate", "The probability of a decision is biased", "method", method_target=_dec_target),
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
    sql = """SELECT p.payload_json, p.p_red, p.red_fighter_id, e.details_json, e.correct_winner, ev.date, ev.id AS event_id,
                    r.winner_fighter_id, p.fight_id
             FROM prediction_evaluations e JOIN predictions p ON p.id=e.prediction_id
             JOIN fight_results r ON r.id=e.result_id JOIN events ev ON ev.id=p.event_id
             WHERE e.scored=1 AND p.mode=? AND r.revision=(SELECT MAX(revision) FROM fight_results r2
                                                         WHERE r2.fight_id=r.fight_id)"""
    args = [mode]
    if before:
        sql += " AND ev.date < ?"
        args.append(before)
    out = []
    for r in conn.execute(sql + " ORDER BY ev.date", args):
        out.append({"payload": loads(r["payload_json"]), "details": loads(r["details_json"]),
                    "red_won": float(r["winner_fighter_id"] == r["red_fighter_id"]), "event_id": r["event_id"],
                    "date": r["date"], "fight_id": r["fight_id"]})
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
                y = r["red_won"] if s == "red" else 1 - r["red_won"]
                ps = p["p_red"] if s == "red" else p["p_blue"]
                resid.append(y - ps)
            else:
                t = hyp.method_target(p, r["details"])
                if t is None:
                    continue
                resid.append(t[0] - t[1])
            events.append(r["event_id"])
            if len(examples) < 8:
                examples.append(r["fight_id"])
        n = len(resid)
        res = {"key": hyp.key, "description": hyp.description, "kind": hyp.kind, "n": n, "effect": None,
               "ci_low": None, "ci_high": None, "p_value": None, "q_value": None, "status": "insufficient_data",
               "example_fight_ids": examples}
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
            r["interpretation"] = (f"model {direction}-estimates this segment by {abs(r['effect']):.1%} on average "
                                   f"(n={r['n']})")
    if store:
        now = utcnow()
        for r in results:
            conn.execute(
                """INSERT INTO weakness_hypotheses(key, learning_run_id, description, n, effect, ci_low, ci_high, p_value,
                   q_value, status, evidence_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (r["key"], learning_run_id, r["description"], r["n"], r["effect"], r["ci_low"], r["ci_high"],
                 r["p_value"], r["q_value"], r["status"], dumps({"examples": r["example_fight_ids"],
                                                                 "interpretation": r.get("interpretation")}), now))
        conn.commit()
    return results
