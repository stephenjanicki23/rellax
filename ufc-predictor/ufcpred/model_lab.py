"""Model Lab: track alternative prediction models side by side, by weight class and other splits.

Tracking only. The official engine is a stack of sub-models, each of which makes its own prediction from one
kind of evidence; every prediction already stores their individual chances. This module copies those chances
for graded fights into a small table (``model_lab``) and scores them. It never trains, changes or feeds the
engine, and none of these models places a bet.
"""
from __future__ import annotations

import math
from collections import defaultdict

from .config import setting
from .util import loads, utcnow

# key, column, name, what it looks at, payload source
MODELS = [
    ("engine", "p_engine", "Official engine", "The combined prediction you see on every fight page."),
    ("ratings", "p_ratings", "Career stats model",
     "Elo rating, win rate, striking and grappling rates, experience, age, height and reach."),
    ("form", "p_form", "Recent form model",
     "How the last few fights went: output trends, performance, opponent quality and streaks."),
    ("style", "p_style", "Style matchup model",
     "How the styles clash: striking exchanges, takedown and submission threat, reach, stance, pressure."),
    ("durability", "p_durability", "Durability model",
     "Chin and finishing: KO and submission loss rates, damage absorbed, finishing rate."),
    ("elo", "p_elo", "Elo only (benchmark)", "Just the Elo rating: the simplest sensible model."),
    ("market", "market_red", "Betting market (benchmark)",
     "The odds' no-vig chance, where odds were imported before the fight. Not a model: a yardstick."),
]
ALT = ("ratings", "form", "style", "durability")
SUBMODEL = {"p_ratings": "A_baseline", "p_form": "B_form", "p_style": "C_style", "p_durability": "D_durability"}
COLS = ("prediction_id", "fight_id", "event_id", "mode", "event_date", "weight_class", "is_women", "card_segment",
        "scheduled_rounds", "result_id", "red_won", "p_engine", "p_ratings", "p_form", "p_style", "p_durability",
        "p_elo", "market_red", "red_decimal", "blue_decimal", "created_at")


def _t(ts) -> str:
    return str(ts or "")[:19]


def model_probs(payload: dict, p_red: float | None) -> dict:
    """Each model's chance for the red corner, from a stored prediction payload."""
    subs = payload.get("submodels") or payload.get("submodel_p_red") or {}
    base = payload.get("baselines") or {}
    out = {"p_engine": p_red if p_red is not None else payload.get("p_red"), "p_elo": base.get("elo_only_p_red")}
    for col, group in SUBMODEL.items():
        out[col] = subs.get(group)
    return {k: (None if v is None else float(v)) for k, v in out.items()}


def _market(conn, fight_id: int, cutoff) -> tuple | None:
    for o in conn.execute("SELECT red_decimal, blue_decimal, captured_at FROM odds WHERE fight_id=? "
                          "ORDER BY captured_at DESC, id DESC", (fight_id,)).fetchall():
        if cutoff and _t(o["captured_at"]) >= _t(cutoff):
            continue
        r, b = float(o["red_decimal"]), float(o["blue_decimal"])
        return (1 / r) / (1 / r + 1 / b), r, b
    return None


def sync(conn, batch: int = 200) -> dict:
    """Add (or refresh) a row for every graded official prediction. Idempotent; only new or re-graded
    predictions are read, so the first run is the only slow one."""
    graded = conn.execute(
        """SELECT e.prediction_id, e.result_id FROM prediction_evaluations e
           WHERE e.scored=1 AND e.id IN (SELECT MAX(id) FROM prediction_evaluations WHERE scored=1
                                         GROUP BY prediction_id)""").fetchall()
    have = {r["prediction_id"]: r["result_id"] for r in conn.execute("SELECT prediction_id, result_id FROM model_lab")}
    todo = [(r["prediction_id"], r["result_id"]) for r in graded if have.get(r["prediction_id"], -1) != r["result_id"]]
    out = {"added": 0, "refreshed": 0, "skipped": 0}
    for i in range(0, len(todo), batch):
        chunk = dict(todo[i:i + batch])
        q = ",".join("?" * len(chunk))
        preds = conn.execute(
            f"""SELECT p.id, p.fight_id, p.event_id, p.mode, p.p_red, p.red_fighter_id, p.payload_json,
                       f.weight_class, f.is_women, f.card_segment, f.scheduled_rounds, ev.date AS event_date
                FROM predictions p JOIN fights f ON f.id=p.fight_id JOIN events ev ON ev.id=p.event_id
                WHERE p.id IN ({q})""", tuple(chunk)).fetchall()
        for p in preds:
            res = conn.execute("SELECT * FROM fight_results WHERE id=?", (chunk[p["id"]],)).fetchone()
            if res is None or res["outcome"] != "win" or res["winner_fighter_id"] is None:
                out["skipped"] += 1
                continue
            first = conn.execute("SELECT MIN(recorded_at) FROM fight_results WHERE fight_id=?",
                                 (p["fight_id"],)).fetchone()[0]
            m = _market(conn, p["fight_id"], first)
            row = {"prediction_id": p["id"], "fight_id": p["fight_id"], "event_id": p["event_id"], "mode": p["mode"],
                   "event_date": p["event_date"], "weight_class": p["weight_class"],
                   "is_women": int(bool(p["is_women"])), "card_segment": p["card_segment"],
                   "scheduled_rounds": p["scheduled_rounds"], "result_id": res["id"],
                   "red_won": int(res["winner_fighter_id"] == p["red_fighter_id"]),
                   **model_probs(loads(p["payload_json"], {}) or {}, p["p_red"]),
                   "market_red": m[0] if m else None, "red_decimal": m[1] if m else None,
                   "blue_decimal": m[2] if m else None, "created_at": utcnow()}
            existed = p["id"] in have
            conn.execute("DELETE FROM model_lab WHERE prediction_id=?", (p["id"],))
            conn.execute(f"INSERT INTO model_lab({', '.join(COLS)}) VALUES ({', '.join('?' * len(COLS))})",
                         tuple(row[c] for c in COLS))
            out["refreshed" if existed else "added"] += 1
        conn.commit()
    return out


# ------------------------------------------------------------------ scoring
def rows(conn, mode: str = "all") -> list[dict]:
    sql = "SELECT * FROM model_lab"
    args: tuple = ()
    if mode in ("live", "replay"):
        sql += " WHERE mode=?"
        args = (mode,)
    return [dict(r) for r in conn.execute(sql + " ORDER BY event_date, id", args).fetchall()]


def _clip(p: float) -> float:
    return min(max(p, 1e-6), 1 - 1e-6)


def _ll(p: float, y: int) -> float:
    p = _clip(p)
    return -math.log(p if y else 1 - p)


def score(rs: list[dict], key: str) -> dict:
    col = dict((k, c) for k, c, *_ in MODELS)[key]
    xs = [(r[col], r["red_won"]) for r in rs if r[col] is not None]
    n = len(xs)
    if not n:
        return {"n": 0}
    correct = sum(1.0 if (p > 0.5) == bool(y) else 0.5 if p == 0.5 else 0.0 for p, y in xs)
    out = {"n": n, "accuracy": correct / n, "log_loss": sum(_ll(p, y) for p, y in xs) / n,
           "brier": sum((p - y) ** 2 for p, y in xs) / n}
    # paired comparison with the official engine on the same fights: positive = this model is better
    if key != "engine":
        d = [_ll(r["p_engine"], r["red_won"]) - _ll(r[col], r["red_won"])
             for r in rs if r[col] is not None and r["p_engine"] is not None]
        if len(d) > 1:
            mean = sum(d) / len(d)
            sd = math.sqrt(sum((x - mean) ** 2 for x in d) / (len(d) - 1))
            out["vs_engine"] = mean
            out["vs_engine_se"] = sd / math.sqrt(len(d))
    # what $50 on each of its picks would have made, on fights with a pre-fight price
    priced = [(r[col], r["red_won"], r["red_decimal"], r["blue_decimal"]) for r in rs
              if r[col] is not None and r["red_decimal"] and r[col] != 0.5]
    if priced:
        pl = sum((50 * ((rd if p > 0.5 else bd) - 1)) if (p > 0.5) == bool(y) else -50 for p, y, rd, bd in priced)
        out["flat_pl"], out["flat_n"] = pl, len(priced)
    return out


def verdict(s: dict, min_n: int) -> str:
    """'better' / 'worse' than the engine only with enough fights and a clear gap (2 standard errors)."""
    if s.get("n", 0) < min_n or "vs_engine" not in s:
        return "too few"
    if s["vs_engine"] > 2 * s["vs_engine_se"]:
        return "better"
    if s["vs_engine"] < -2 * s["vs_engine_se"]:
        return "worse"
    return "same"


def _weight(r) -> str:
    wc = (r["weight_class"] or "Catch weight").replace("UFC ", "").replace(" Title", "").replace(" Bout", "").strip()
    if r["is_women"] and not wc.lower().startswith("women"):
        wc = "Women's " + wc
    return wc


def _sure(r) -> str:
    p = r["p_engine"]
    if p is None:
        return "unknown"
    c = max(p, 1 - p)
    return "Close call (under 60%)" if c < 0.6 else "Leaning (60–70%)" if c < 0.7 else "Strong pick (70%+)"


SPLITS = [
    ("weight", "By weight class", _weight),
    ("gender", "Men vs women", lambda r: "Women" if r["is_women"] else "Men"),
    ("segment", "By place on the card", lambda r: {"main": "Main card", "prelim": "Prelims",
                                                    "early_prelim": "Early prelims"}.get(r["card_segment"] or "",
                                                                                         "Not recorded")),
    ("rounds", "3 vs 5 rounds", lambda r: f"{r['scheduled_rounds'] or 3} rounds"),
    ("sure", "By how sure the engine was", _sure),
]


def report(conn, mode: str = "all") -> dict:
    rs = rows(conn, mode)
    min_n = int(setting(conn, "lab.min_sample"))
    keys = [k for k, *_ in MODELS]
    overall = []
    for k in keys:
        s = score(rs, k)
        overall.append({"key": k, "s": s, "verdict": verdict(s, min_n) if k != "engine" else ""})
    splits = []
    for sk, title, fn in SPLITS:
        groups = defaultdict(list)
        for r in rs:
            groups[fn(r)].append(r)
        table = []
        for g in sorted(groups, key=lambda g: (-len(groups[g]), g)):
            cells = {k: score(groups[g], k) for k in keys}
            for k in keys:
                cells[k]["verdict"] = verdict(cells[k], min_n) if k != "engine" else ""
            best = max((k for k in ("engine",) + ALT if cells[k].get("n")),
                       key=lambda k: -cells[k]["log_loss"], default=None)
            table.append({"group": g, "n": len(groups[g]), "cells": cells, "best": best})
        splits.append({"key": sk, "title": title, "rows": table})
    modes = {m: n for m, n in conn.execute("SELECT mode, COUNT(*) FROM model_lab GROUP BY mode").fetchall()}
    return {"n": len(rs), "overall": overall, "splits": splits, "min_n": min_n, "modes": modes}


def upcoming(conn, event_id: int) -> list[dict]:
    """Each model's pick for every fight on a card, from the newest live prediction."""
    from . import ledger
    out = []
    preds = {r["fight_id"]: r for r in ledger.latest_predictions(conn, event_id, "live")}
    for f in conn.execute("""SELECT f.*, fr.name AS red_name, fb.name AS blue_name FROM fights f
                             JOIN fighters fr ON fr.id=f.red_fighter_id JOIN fighters fb ON fb.id=f.blue_fighter_id
                             WHERE f.event_id=? AND f.status NOT IN ('canceled','replaced')
                             ORDER BY COALESCE(f.bout_order, 999), f.id""", (event_id,)).fetchall():
        p = preds.get(f["id"])
        if p is None:
            continue
        probs = model_probs(loads(p["payload_json"], {}) or {}, p["p_red"])
        picks = {}
        for k, col, *_ in MODELS:
            v = probs.get(col)
            if v is None:
                continue
            red = v >= 0.5
            picks[k] = {"name": f["red_name"] if red else f["blue_name"], "p": v if red else 1 - v, "red": red}
        agree = len({x["red"] for k, x in picks.items() if k in ("engine",) + ALT}) == 1
        out.append({"fight": dict(f), "picks": picks, "agree": agree})
    return out
