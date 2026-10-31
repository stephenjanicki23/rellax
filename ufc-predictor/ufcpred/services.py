"""Read-side queries for the UI. Every number shown in the interface is computed here from
the ledger, evaluations and official results — nothing is hardcoded."""
from __future__ import annotations

from collections import defaultdict

import numpy as np

from .evaluation import metrics as M
from .features.build import method_class
from .models import registry
from .util import loads, utcnow

METHOD_LABEL = {"KO_TKO": "KO/TKO", "SUB": "Submission", "DEC": "Decision", "DQ_OTHER": "DQ/Other", "DQ": "DQ",
                "OTHER": "Other", "NC": "No contest", "DRAW": "Draw"}


def graded(conn, mode: str) -> list[dict]:
    """Graded official predictions against the latest result revision, oldest first."""
    rows = conn.execute(
        """SELECT p.id AS prediction_id, p.fight_id, p.event_id, p.p_red, p.p_blue, p.predicted_winner_id,
                  p.predicted_method, p.predicted_round, p.confidence, p.model_version_id, p.payload_json,
                  p.red_fighter_id, e.correct_winner, e.p_actual, e.brier, e.log_loss, e.method_correct,
                  e.round_correct, e.method_log_loss, e.details_json, ev.date, ev.name AS event_name, f.weight_class,
                  f.scheduled_rounds, r.winner_fighter_id, r.method AS actual_method, r.end_round
           FROM prediction_evaluations e JOIN predictions p ON p.id=e.prediction_id
           JOIN fight_results r ON r.id=e.result_id JOIN events ev ON ev.id=p.event_id JOIN fights f ON f.id=p.fight_id
           WHERE e.scored=1 AND p.mode=? AND r.revision=(SELECT MAX(revision) FROM fight_results r2 WHERE r2.fight_id=r.fight_id)
           ORDER BY ev.date, p.fight_id""", (mode,)).fetchall()
    return [dict(r) for r in rows]


def preferred_mode(conn) -> str:
    n = conn.execute("SELECT COUNT(*) FROM prediction_evaluations e JOIN predictions p ON p.id=e.prediction_id "
                     "WHERE p.mode='live'").fetchone()[0]
    return "live" if n else "replay"


def performance(conn, mode: str) -> dict:
    g = graded(conn, mode)
    if not g:
        return {"n": 0, "mode": mode}
    p = np.array([r["p_red"] for r in g])
    y = np.array([float(r["winner_fighter_id"] == r["red_fighter_id"]) for r in g])
    ev = np.array([r["event_id"] for r in g])
    out = {"mode": mode, **M.summarize(p, y, ev)}
    out["reliability"] = M.reliability_full(p, y)
    # rolling windows
    corr = np.array([r["correct_winner"] for r in g], dtype=float)
    ll = np.array([r["log_loss"] for r in g])
    out["windows"] = []
    for w in (5, 10, 25, 50, 100):
        if len(g) >= w:
            k = int(corr[-w:].sum())
            out["windows"].append({"n": w, "accuracy": k / w, "ci": M.wilson(k, w), "log_loss": float(ll[-w:].mean())})
        else:
            out["windows"].append({"n": w, "accuracy": None, "note": f"needs {w} graded fights ({len(g)} so far)"})
    # rolling series for chart (window 25)
    series = []
    for i in range(len(g)):
        lo = max(0, i - 49)
        series.append({"i": i + 1, "date": g[i]["date"], "acc50": float(corr[lo:i + 1].mean()),
                       "ll50": float(ll[lo:i + 1].mean()), "n": i + 1 - lo})
    out["series"] = series
    # baselines on the same fights
    pl = [loads(r["payload_json"]) for r in g]
    def base(key):
        vals = [x.get("baselines", {}).get(key) for x in pl]
        if any(v is None for v in vals):
            return None
        q = np.array(vals)
        return {"log_loss": float(M.log_loss(q, y).mean()), "brier": float(M.brier(q, y).mean()),
                "accuracy": float(np.mean((q >= .5) == (y == 1))) if key != "coin_flip_p_red" else 0.5}
    out["baselines"] = {"Coin flip (50/50)": base("coin_flip_p_red"),
                        "Historical base rate (more-experienced fighter)": base("experience_base_rate_p_red"),
                        "Elo only": base("elo_only_p_red")}
    mk = [(i, x["market"]) for i, x in enumerate(pl) if x.get("market")]
    if mk:
        idx = [i for i, _ in mk]
        qm = np.array([m["p_red"] for _, m in mk])
        out["market"] = {"n": len(idx), "market_log_loss": float(M.log_loss(qm, y[idx]).mean()),
                         "model_log_loss": float(M.log_loss(p[idx], y[idx]).mean()),
                         "market_accuracy": float(np.mean((qm >= .5) == (y[idx] == 1))),
                         "model_accuracy": float(np.mean((p[idx] >= .5) == (y[idx] == 1)))}
    else:
        out["market"] = None
    # breakdowns
    def breakdown(keyfn):
        d = defaultdict(list)
        for r in g:
            d[keyfn(r)].append(r)
        rows = []
        for k, rs in sorted(d.items(), key=lambda kv: str(kv[0])):
            n = len(rs)
            c = sum(x["correct_winner"] for x in rs)
            lo, hi = M.wilson(c, n)
            rows.append({"key": k, "n": n, "accuracy": c / n, "ci": (lo, hi),
                         "log_loss": float(np.mean([x["log_loss"] for x in rs]))})
        return rows
    out["by_weight_class"] = breakdown(lambda r: r["weight_class"] or "Catch/Open weight")
    out["by_format"] = breakdown(lambda r: f"{r['scheduled_rounds']} rounds")
    out["by_confidence"] = breakdown(lambda r: r["confidence"])
    out["by_probability"] = breakdown(lambda r: f"{int(max(r['p_red'], r['p_blue']) * 10) / 10:.1f}–"
                                                f"{int(max(r['p_red'], r['p_blue']) * 10) / 10 + .1:.1f}")
    out["by_event"] = list(reversed(breakdown(lambda r: (r["date"], r["event_name"], r["event_id"]))))
    out["by_model"] = breakdown(lambda r: r["model_version_id"])
    # method accuracy
    mrows = [r for r in g if method_class(r["actual_method"])]
    meth = {}
    for m in ("KO_TKO", "SUB", "DEC"):
        actual = [r for r in mrows if method_class(r["actual_method"]) == m]
        predicted = [r for r in mrows if r["predicted_method"] == m]
        hit = [r for r in actual if r["predicted_method"] == m]
        full = [r for r in actual if r["predicted_method"] == m and r["correct_winner"]]
        meth[m] = {"actual": len(actual), "predicted": len(predicted),
                   "recall": len(hit) / len(actual) if actual else None,
                   "precision": len(hit) / len(predicted) if predicted else None,
                   "winner_and_method": len(full) / len(actual) if actual else None}
    out["method"] = meth
    mll = [r["method_log_loss"] for r in g if r["method_log_loss"] is not None]
    out["method_log_loss"] = float(np.mean(mll)) if mll else None
    # multiclass (8-way: corner × method) Brier
    P, Yi = [], []
    order = [(s, m) for s in ("red", "blue") for m in ("KO_TKO", "SUB", "DEC", "DQ_OTHER")]
    for r, x in zip(g, pl):
        mc = method_class(r["actual_method"])
        if not mc:
            continue
        side = "red" if r["winner_fighter_id"] == r["red_fighter_id"] else "blue"
        P.append([x["methods"][s][m] for s, m in order])
        Yi.append(order.index((side, mc)))
    if P:
        out["method_brier"] = M.multiclass_brier(np.array(P), np.array(Yi))
        out["method_mc_log_loss"] = M.multiclass_log_loss(np.array(P), np.array(Yi))
    rr = [r["round_correct"] for r in g if r["round_correct"] is not None]
    out["round_accuracy"] = float(np.mean(rr)) if rr else None
    out["models"] = {r["id"]: r["label"] for r in conn.execute("SELECT id, label FROM model_versions")}
    return out


def latest_promotion_comparison(conn) -> dict | None:
    row = conn.execute("""SELECT c.*, d.decision, d.decided_at FROM candidate_changes c JOIN promotion_decisions d
                          ON d.candidate_change_id=c.id ORDER BY d.id DESC LIMIT 1""").fetchone()
    if row is None:
        return None
    res = loads(row["result_json"])
    return {"description": row["description"], "decision": row["decision"], "decided_at": row["decided_at"],
            "incumbent": res["incumbent"], "candidate": res["candidate"], "paired": res["paired"]}


def model_status(conn) -> dict:
    act = registry.active_version(conn)
    if act is None:
        return {"active": None}
    params = loads(act["params_json"])
    last_dec = conn.execute("SELECT * FROM promotion_decisions ORDER BY id DESC LIMIT 1").fetchone()
    return {"active": dict(act), "params": params, "last_decision": dict(last_dec) if last_dec else None,
            "weights": None if not params else _weights(params)}


def _weights(params):
    from .models.engine import ensemble_weights
    return ensemble_weights(params)


def event_card(conn, event_id: int, mode: str | None = None) -> dict:
    ev = conn.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()
    if ev is None:
        return None
    if mode is None:
        mode = "live" if conn.execute("SELECT 1 FROM predictions WHERE event_id=? AND mode='live'",
                                      (event_id,)).fetchone() else "replay"
    lock = conn.execute("SELECT * FROM prediction_locks WHERE event_id=? AND mode=?", (event_id, mode)).fetchone()
    fights = conn.execute(
        """SELECT f.*, fr.name AS red_name, fb.name AS blue_name FROM fights f JOIN fighters fr ON fr.id=f.red_fighter_id
           JOIN fighters fb ON fb.id=f.blue_fighter_id WHERE f.event_id=? ORDER BY COALESCE(f.bout_order, 999), f.id DESC""",
        (event_id,)).fetchall()
    locked_ids = set(loads(lock["prediction_ids_json"], [])) if lock else set()
    out = []
    for f in fights:
        preds = conn.execute("SELECT * FROM predictions WHERE fight_id=? AND mode=? ORDER BY version",
                             (f["id"], mode)).fetchall()
        official = next((p for p in preds if p["id"] in locked_ids), None)
        latest = preds[-1] if preds else None
        shown = official or latest
        res = conn.execute("SELECT * FROM fight_results WHERE fight_id=? ORDER BY revision DESC LIMIT 1",
                           (f["id"],)).fetchone()
        ev_row = None
        if shown is not None and res is not None:
            ev_row = conn.execute("SELECT * FROM prediction_evaluations WHERE prediction_id=? AND result_id=?",
                                  (shown["id"], res["id"])).fetchone()
        out.append({"fight": dict(f), "prediction": dict(shown) if shown else None,
                    "payload": loads(shown["payload_json"]) if shown else None, "versions": len(preds),
                    "is_official": official is not None, "result": dict(res) if res else None,
                    "evaluation": dict(ev_row) if ev_row else None,
                    "post_lock_versions": sum(1 for p in preds if p["is_post_lock"])})
    return {"event": dict(ev), "mode": mode, "lock": dict(lock) if lock else None, "fights": out}


def upcoming_event(conn):
    return conn.execute("SELECT * FROM events WHERE date>=? AND status IN ('scheduled','locked') ORDER BY date LIMIT 1",
                        (utcnow()[:10],)).fetchone()


def latest_replayed_event(conn):
    return conn.execute("""SELECT e.* FROM events e JOIN prediction_locks l ON l.event_id=e.id AND l.mode='replay'
                           ORDER BY e.date DESC LIMIT 1""").fetchone()


def counts(conn) -> dict:
    q = lambda s, *a: conn.execute(s, a).fetchone()[0]
    return {"fighters": q("SELECT COUNT(*) FROM fighters"), "events": q("SELECT COUNT(*) FROM events"),
            "fights": q("SELECT COUNT(*) FROM fights"), "results": q("SELECT COUNT(DISTINCT fight_id) FROM fight_results"),
            "predictions_live": q("SELECT COUNT(*) FROM predictions WHERE mode='live'"),
            "predictions_replay": q("SELECT COUNT(*) FROM predictions WHERE mode='replay'"),
            "graded_live": q("SELECT COUNT(*) FROM prediction_evaluations e JOIN predictions p ON p.id=e.prediction_id "
                             "WHERE p.mode='live' AND e.scored=1"),
            "graded_replay": q("SELECT COUNT(*) FROM prediction_evaluations e JOIN predictions p ON p.id=e.prediction_id "
                               "WHERE p.mode='replay' AND e.scored=1"),
            "model_versions": q("SELECT COUNT(*) FROM model_versions"),
            "open_issues": q("SELECT COUNT(*) FROM data_quality_issues WHERE resolved_at IS NULL"),
            "last_history_source": conn.execute("SELECT retrieved_at, status FROM data_sources WHERE provider='ufcstats_mirror' "
                                                "ORDER BY id DESC LIMIT 1").fetchone()}


# ------------------------------------------------------------------ betting edge (comparison only)
# Odds are never an engine input here: they are read only to compare against the engine's own picks.
EDGE_MIN = 0.05   # flag a side when the engine's chance implies at least +5% expected return at the offered odds


def latest_odds(conn, fight_id: int):
    return conn.execute("SELECT * FROM odds WHERE fight_id=? ORDER BY captured_at DESC, id DESC LIMIT 1",
                        (fight_id,)).fetchone()


def _edge_for(item: dict, odds) -> dict | None:
    p = item.get("payload")
    if not p or odds is None:
        return None
    rd, bd = float(odds["red_decimal"]), float(odds["blue_decimal"])
    ir, ib = 1 / rd, 1 / bd
    sides = []
    for side, name, pm, dec, imp in (("red", item["fight"]["red_name"], p["p_red"], rd, ir / (ir + ib)),
                                     ("blue", item["fight"]["blue_name"], p["p_blue"], bd, ib / (ir + ib))):
        sides.append({"side": side, "name": name, "engine": pm, "market": imp, "decimal": dec,
                      "american": round((dec - 1) * 100) if dec >= 2 else round(-100 / (dec - 1)),
                      "gap": pm - imp, "ev": pm * dec - 1})
    best = max(sides, key=lambda s: s["ev"])
    return {"sides": sides, "best": best, "flag": best["ev"] >= EDGE_MIN, "overround": ir + ib - 1,
            "bookmaker": odds["bookmaker"], "captured_at": odds["captured_at"],
            "confidence": p["confidence"]["label"]}


def betting_edge(conn, event_id: int) -> dict:
    card = event_card(conn, event_id, "live")
    rows = []
    for item in card["fights"]:
        e = _edge_for(item, latest_odds(conn, item["fight"]["id"]))
        res = item["result"]
        outcome = None
        if e and e["flag"] and res and res["outcome"] == "win":
            won = res["winner_fighter_id"] == item["fight"][f"{e['best']['side']}_fighter_id"]
            outcome = {"won": won, "profit": e["best"]["decimal"] - 1 if won else -1.0}
        rows.append({"item": item, "edge": e, "outcome": outcome})
    return {"card": card, "rows": rows, "n_odds": sum(1 for r in rows if r["edge"])}


def betting_track_record(conn) -> dict:
    """Flat 1-unit stake on every flagged side of every graded live event that had odds (draws/NC excluded)."""
    evs = conn.execute("""SELECT DISTINCT e.id, e.name, e.date FROM events e JOIN fights f ON f.event_id=e.id
                          JOIN odds o ON o.fight_id=f.id JOIN prediction_locks l ON l.event_id=e.id AND l.mode='live'
                          ORDER BY e.date DESC""").fetchall()
    bets, events = [], []
    for ev in evs:
        b = betting_edge(conn, ev["id"])
        done = [r["outcome"] for r in b["rows"] if r["outcome"]]
        bets += done
        events.append({"id": ev["id"], "name": ev["name"], "date": ev["date"], "n_odds": b["n_odds"],
                       "flagged": sum(1 for r in b["rows"] if r["edge"] and r["edge"]["flag"]),
                       "settled": len(done), "profit": sum(x["profit"] for x in done)})
    n = len(bets)
    return {"n": n, "wins": sum(1 for x in bets if x["won"]), "profit": sum(x["profit"] for x in bets),
            "roi": (sum(x["profit"] for x in bets) / n) if n else None, "events": events}


def edge_event(conn):
    """The card the Betting Edge page opens on: the next upcoming card, else the latest card with odds."""
    nxt = upcoming_event(conn)
    if nxt:
        return nxt
    return conn.execute("""SELECT e.* FROM events e JOIN fights f ON f.event_id=e.id JOIN odds o ON o.fight_id=f.id
                           ORDER BY e.date DESC LIMIT 1""").fetchone()
