"""Read-side queries for the UI. Every number shown in the interface is computed here from the ledger,
evaluations and official results — nothing is hardcoded."""
from __future__ import annotations

from collections import defaultdict

import numpy as np

from .evaluation import metrics as M
from .models import registry
from .util import loads, utcnow

BUCKET_LABEL = {"CLOSE": "by 1–5", "SOLID": "by 6–12", "BLOWOUT": "by 13+"}
SEASON_TYPE = {"regular": "Regular season", "playoffs": "Playoffs", "playin": "Play-in", "cup_final": "NBA Cup final",
               "preseason": "Preseason"}


def graded(conn, mode: str) -> list[dict]:
    """Graded official predictions against the latest result revision, oldest first."""
    rows = conn.execute(
        """SELECT p.id AS prediction_id, p.game_id, p.event_id, p.p_home, p.p_away, p.predicted_winner_id,
                  p.predicted_margin, p.predicted_total, p.predicted_bucket, p.confidence, p.model_version_id,
                  p.payload_json, p.home_team_id, e.correct_winner, e.p_actual, e.brier, e.log_loss, e.margin_error,
                  e.total_error, e.bucket_correct, e.bucket_log_loss, e.ats_correct, e.total_pick_correct,
                  e.details_json, ev.date, ev.name AS event_name, g.season_type, g.season, g.neutral_site,
                  r.winner_team_id, r.home_score, r.away_score, r.periods
           FROM prediction_evaluations e JOIN predictions p ON p.id=e.prediction_id
           JOIN game_results r ON r.id=e.result_id JOIN events ev ON ev.id=p.event_id JOIN games g ON g.id=p.game_id
           WHERE e.scored=1 AND p.mode=? AND r.revision=(SELECT MAX(revision) FROM game_results r2 WHERE r2.game_id=r.game_id)
           ORDER BY ev.date, p.game_id""", (mode,)).fetchall()
    return [dict(r) for r in rows]


def preferred_mode(conn) -> str:
    n = conn.execute("SELECT COUNT(*) FROM prediction_evaluations e JOIN predictions p ON p.id=e.prediction_id "
                     "WHERE p.mode='live'").fetchone()[0]
    return "live" if n else "replay"


def performance(conn, mode: str) -> dict:
    g = graded(conn, mode)
    if not g:
        return {"n": 0, "mode": mode}
    p = np.array([r["p_home"] for r in g])
    y = np.array([float(r["winner_team_id"] == r["home_team_id"]) for r in g])
    ev = np.array([r["event_id"] for r in g])
    out = {"mode": mode, **M.summarize(p, y, ev)}
    out["reliability"] = M.reliability_full(p, y)
    corr = np.array([r["correct_winner"] for r in g], dtype=float)
    ll = np.array([r["log_loss"] for r in g])
    out["windows"] = []
    for w in (10, 50, 100, 250, 500):
        if len(g) >= w:
            k = int(corr[-w:].sum())
            out["windows"].append({"n": w, "accuracy": k / w, "ci": M.wilson(k, w), "log_loss": float(ll[-w:].mean())})
        else:
            out["windows"].append({"n": w, "accuracy": None, "note": f"needs {w} graded games ({len(g)} so far)"})
    series = []
    for i in range(len(g)):
        lo = max(0, i - 99)
        series.append({"i": i + 1, "date": g[i]["date"], "acc50": float(corr[lo:i + 1].mean()),
                       "ll50": float(ll[lo:i + 1].mean()), "n": i + 1 - lo})
    out["series"] = series
    pl = [loads(r["payload_json"]) for r in g]

    def base(key):
        vals = [x.get("baselines", {}).get(key) for x in pl]
        if any(v is None for v in vals):
            return None
        q = np.array(vals)
        return {"log_loss": float(M.log_loss(q, y).mean()), "brier": float(M.brier(q, y).mean()),
                "accuracy": float(np.mean((q >= .5) == (y == 1))) if key != "coin_flip_p_home" else 0.5}
    out["baselines"] = {"Coin flip (50/50)": base("coin_flip_p_home"),
                        "Home team always wins": base("home_team_p_home"),
                        "Better record wins": base("better_record_p_home"),
                        "Elo only": base("elo_only_p_home")}
    mk = [(i, x["market"]) for i, x in enumerate(pl) if (x.get("market") or {}).get("p_home") is not None]
    if mk:
        idx = [i for i, _ in mk]
        qm = np.array([m["p_home"] for _, m in mk])
        out["market"] = {"n": len(idx), "market_log_loss": float(M.log_loss(qm, y[idx]).mean()),
                         "model_log_loss": float(M.log_loss(p[idx], y[idx]).mean()),
                         "market_accuracy": float(np.mean((qm >= .5) == (y[idx] == 1))),
                         "model_accuracy": float(np.mean((p[idx] >= .5) == (y[idx] == 1)))}
    else:
        out["market"] = None

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
                         "log_loss": float(np.mean([x["log_loss"] for x in rs])),
                         "margin_mae": float(np.mean([abs(x["margin_error"]) for x in rs]))})
        return rows
    out["by_season_type"] = breakdown(lambda r: SEASON_TYPE.get(r["season_type"], r["season_type"]))
    out["by_season"] = breakdown(lambda r: r["season"])
    out["by_month"] = breakdown(lambda r: r["date"][:7])
    out["by_venue"] = breakdown(lambda r: "Neutral site" if r["neutral_site"] else
                                ("Picked the home team" if r["predicted_winner_id"] == r["home_team_id"]
                                 else "Picked the road team"))
    out["by_confidence"] = breakdown(lambda r: r["confidence"])
    out["by_probability"] = breakdown(lambda r: f"{int(max(r['p_home'], r['p_away']) * 10) / 10:.1f}–"
                                                f"{int(max(r['p_home'], r['p_away']) * 10) / 10 + .1:.1f}")
    out["by_event"] = list(reversed(breakdown(lambda r: (r["date"], r["event_name"], r["event_id"]))))
    out["by_model"] = breakdown(lambda r: r["model_version_id"])
    # margin, bands, totals, against the market
    me = np.array([r["margin_error"] for r in g])
    out["margin_mae"] = float(np.mean(np.abs(me)))
    out["margin_bias"] = float(np.mean(me))
    sig = np.array([x["margin"]["sigma"] for x in pl])
    z = me / sig
    out["margin_z"] = {"mean": float(np.mean(z)), "sd": float(np.std(z)),
                       "within_1sd": float(np.mean(np.abs(z) <= 1)), "expected_within_1sd": 0.683}
    te = [r["total_error"] for r in g if r["total_error"] is not None]
    out["total_mae"] = float(np.mean(np.abs(te))) if te else None
    out["total_bias"] = float(np.mean(te)) if te else None
    bands = {}
    for b in BUCKET_LABEL:
        actual = [r for r in g if loads(r["details_json"]).get("actual_bucket") == b]
        predicted = [r for r in g if r["predicted_bucket"] == b]
        hit = [r for r in actual if r["predicted_bucket"] == b and r["correct_winner"]]
        stated = float(np.mean([x["bands"]["home"][b] + x["bands"]["away"][b] for x in pl]))
        bands[b] = {"actual": len(actual), "predicted": len(predicted), "share_actual": len(actual) / len(g),
                    "share_stated": stated, "winner_and_band": len(hit) / len(actual) if actual else None}
    out["bands"] = bands
    bl = [r["bucket_log_loss"] for r in g if r["bucket_log_loss"] is not None]
    out["bucket_log_loss"] = float(np.mean(bl)) if bl else None
    out["bucket_accuracy"] = float(np.mean([r["bucket_correct"] for r in g]))
    ats = [r["ats_correct"] for r in g if r["ats_correct"] is not None]
    tp = [r["total_pick_correct"] for r in g if r["total_pick_correct"] is not None]
    out["ats"] = {"n": len(ats), "rate": float(np.mean(ats)) if ats else None,
                  "ci": M.wilson(int(sum(ats)), len(ats)) if ats else None}
    out["totals_vs_market"] = {"n": len(tp), "rate": float(np.mean(tp)) if tp else None,
                               "ci": M.wilson(int(sum(tp)), len(tp)) if tp else None}
    ot = [float((r["periods"] or 4) > 4) for r in g]
    out["overtime"] = {"actual": float(np.mean(ot)), "stated": float(np.mean([x["p_overtime"] for x in pl]))}
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
    from .models.engine import ensemble_weights
    return {"active": dict(act), "params": params, "last_decision": dict(last_dec) if last_dec else None,
            "weights": ensemble_weights(params) if params else None}


def event_card(conn, event_id: int, mode: str | None = None) -> dict | None:
    ev = conn.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()
    if ev is None:
        return None
    if mode is None:
        mode = "live" if conn.execute("SELECT 1 FROM predictions WHERE event_id=? AND mode='live'",
                                      (event_id,)).fetchone() else "replay"
    lock = conn.execute("SELECT * FROM prediction_locks WHERE event_id=? AND mode=?", (event_id, mode)).fetchone()
    games = conn.execute(
        """SELECT g.*, th.name AS home_name, ta.name AS away_name, th.abbr AS home_abbr, ta.abbr AS away_abbr
           FROM games g JOIN teams th ON th.id=g.home_team_id JOIN teams ta ON ta.id=g.away_team_id
           WHERE g.event_id=? ORDER BY COALESCE(g.tip_time_utc, ''), g.id""", (event_id,)).fetchall()
    locked_ids = set(loads(lock["prediction_ids_json"], [])) if lock else set()
    out = []
    for f in games:
        preds = conn.execute("SELECT * FROM predictions WHERE game_id=? AND mode=? ORDER BY version",
                             (f["id"], mode)).fetchall()
        official = next((p for p in preds if p["id"] in locked_ids), None)
        latest = preds[-1] if preds else None
        shown = official or latest
        res = conn.execute("SELECT * FROM game_results WHERE game_id=? ORDER BY revision DESC LIMIT 1",
                           (f["id"],)).fetchone()
        ev_row = None
        if shown is not None and res is not None:
            ev_row = conn.execute("SELECT * FROM prediction_evaluations WHERE prediction_id=? AND result_id=?",
                                  (shown["id"], res["id"])).fetchone()
        out.append({"game": dict(f), "prediction": dict(shown) if shown else None,
                    "payload": loads(shown["payload_json"]) if shown else None, "versions": len(preds),
                    "is_official": official is not None, "result": dict(res) if res else None,
                    "evaluation": dict(ev_row) if ev_row else None,
                    "post_lock_versions": sum(1 for p in preds if p["is_post_lock"])})
    return {"event": dict(ev), "mode": mode, "lock": dict(lock) if lock else None, "games": out}


def upcoming_event(conn):
    return conn.execute("""SELECT e.* FROM events e WHERE e.date>=? AND e.status IN ('scheduled','locked')
                           AND EXISTS (SELECT 1 FROM games g WHERE g.event_id=e.id AND g.status IN ('scheduled','completed'))
                           ORDER BY e.date LIMIT 1""", (utcnow()[:10],)).fetchone()


def latest_replayed_event(conn):
    return conn.execute("""SELECT e.* FROM events e JOIN prediction_locks l ON l.event_id=e.id AND l.mode='replay'
                           ORDER BY e.date DESC LIMIT 1""").fetchone()


def counts(conn) -> dict:
    q = lambda s, *a: conn.execute(s, a).fetchone()[0]
    return {"teams": q("SELECT COUNT(*) FROM teams"), "events": q("SELECT COUNT(*) FROM events"),
            "games": q("SELECT COUNT(*) FROM games"), "results": q("SELECT COUNT(DISTINCT game_id) FROM game_results"),
            "box_scores": q("SELECT COUNT(DISTINCT game_id) FROM team_game_stats"),
            "predictions_live": q("SELECT COUNT(*) FROM predictions WHERE mode='live'"),
            "predictions_replay": q("SELECT COUNT(*) FROM predictions WHERE mode='replay'"),
            "graded_live": q("SELECT COUNT(*) FROM prediction_evaluations e JOIN predictions p ON p.id=e.prediction_id "
                             "WHERE p.mode='live' AND e.scored=1"),
            "graded_replay": q("SELECT COUNT(*) FROM prediction_evaluations e JOIN predictions p ON p.id=e.prediction_id "
                               "WHERE p.mode='replay' AND e.scored=1"),
            "model_versions": q("SELECT COUNT(*) FROM model_versions"),
            "open_issues": q("SELECT COUNT(*) FROM data_quality_issues WHERE resolved_at IS NULL"),
            "last_game_date": q("SELECT MAX(e.date) FROM games g JOIN events e ON e.id=g.event_id "
                                "WHERE g.status='completed'"),
            "last_history_source": conn.execute("SELECT retrieved_at, status, provider FROM data_sources "
                                                "WHERE provider IN ('nba_mirror','espn') ORDER BY id DESC LIMIT 1").fetchone()}


# ------------------------------------------------------------------ betting edge (comparison only)
# Odds are never an engine input here: they are read only to compare against the engine's own picks.
EDGE_MIN = 0.05   # flag a side when the engine's chance implies at least +5% expected return at the offered price


def latest_odds(conn, game_id: int):
    return conn.execute("SELECT * FROM odds WHERE game_id=? ORDER BY captured_at DESC, id DESC LIMIT 1",
                        (game_id,)).fetchone()


def american(dec: float | None) -> int | None:
    if not dec or dec <= 1:
        return None
    return round((dec - 1) * 100) if dec >= 2 else round(-100 / (dec - 1))


def _edge_for(item: dict, odds) -> dict | None:
    p = item.get("payload")
    if not p or odds is None:
        return None
    from .models.engine import p_home_covers, p_over
    out = {"bookmaker": odds["bookmaker"], "captured_at": odds["captured_at"], "confidence": p["confidence"]["label"],
           "sides": None, "best": None, "flag": False, "spread": None, "total": None}
    if odds["home_decimal"] and odds["away_decimal"]:
        hd, ad = float(odds["home_decimal"]), float(odds["away_decimal"])
        ih, ia = 1 / hd, 1 / ad
        sides = []
        for side, name, pm, dec, imp in (("home", item["game"]["home_name"], p["p_home"], hd, ih / (ih + ia)),
                                         ("away", item["game"]["away_name"], p["p_away"], ad, ia / (ih + ia))):
            sides.append({"side": side, "name": name, "engine": pm, "market": imp, "decimal": dec,
                          "american": american(dec), "gap": pm - imp, "ev": pm * dec - 1})
        best = max(sides, key=lambda s: s["ev"])
        out.update(sides=sides, best=best, flag=best["ev"] >= EDGE_MIN, overround=ih + ia - 1)
    mu, sigma = p["margin"]["mu"], p["margin"]["sigma"]
    if odds["spread_home"] is not None:
        pc = p_home_covers(mu, sigma, odds["spread_home"])
        side = "home" if pc >= 0.5 else "away"
        price = odds["spread_home_decimal"] if side == "home" else odds["spread_away_decimal"]
        pp = max(pc, 1 - pc)
        out["spread"] = {"line_home": odds["spread_home"], "engine_line_home": -mu, "p_home_covers": pc, "side": side,
                         "p_side": pp, "decimal": price, "american": american(price),
                         "ev": None if not price else pp * price - 1}
    if odds["total"] is not None:
        po = p_over(p["total"]["mu"], p["total"]["sd"], odds["total"])
        side = "over" if po >= 0.5 else "under"
        price = odds["over_decimal"] if side == "over" else odds["under_decimal"]
        pp = max(po, 1 - po)
        out["total"] = {"line": odds["total"], "engine": p["total"]["mu"], "p_over": po, "side": side, "p_side": pp,
                        "decimal": price, "american": american(price), "ev": None if not price else pp * price - 1}
    return out


def betting_edge(conn, event_id: int) -> dict:
    card = event_card(conn, event_id, "live")
    rows = []
    for item in card["games"]:
        e = _edge_for(item, latest_odds(conn, item["game"]["id"]))
        res = item["result"]
        outcome = None
        if e and e["flag"] and res and res["outcome"] == "win":
            won = res["winner_team_id"] == item["game"][f"{e['best']['side']}_team_id"]
            outcome = {"won": won, "profit": e["best"]["decimal"] - 1 if won else -1.0}
        rows.append({"item": item, "edge": e, "outcome": outcome})
    return {"card": card, "rows": rows, "n_odds": sum(1 for r in rows if r["edge"])}


def betting_track_record(conn) -> dict:
    """Flat 1-unit stake on every flagged moneyline side of every graded live night that had odds."""
    evs = conn.execute("""SELECT DISTINCT e.id, e.name, e.date FROM events e JOIN games g ON g.event_id=e.id
                          JOIN odds o ON o.game_id=g.id JOIN prediction_locks l ON l.event_id=e.id AND l.mode='live'
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
    """The night the Betting Edge page opens on: the next upcoming night, else the latest night with odds."""
    nxt = upcoming_event(conn)
    if nxt:
        return nxt
    return conn.execute("""SELECT e.* FROM events e JOIN games g ON g.event_id=e.id JOIN odds o ON o.game_id=g.id
                           ORDER BY e.date DESC LIMIT 1""").fetchone()
