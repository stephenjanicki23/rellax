"""Simulated betting tracker: flat stakes by confidence tier, settled against official results.

This module only *reads* predictions, results and odds. Nothing in the prediction engine or the learning
loop reads from here, so tracking bets can never change a prediction.

Rules
-----
* One bet per fight per strategy (``UNIQUE(fight_id, strategy)``); every sync is idempotent.
* The bet follows the engine's confidence label (High / Medium / Low) as stored on the prediction.
  Stakes come from settings at the moment the bet is recorded; changing settings never rewrites
  recorded stakes. Low-confidence picks are tracked with a $0 stake and never count as bets.
* Before the card locks, a bet follows the newest prediction; each change is logged. When the card's
  predictions lock (before the first fight), the bet is locked to the official prediction.
* Odds are snapshotted from imported/feed odds captured before the fight's result arrived. A locked bet
  keeps its odds; odds are never invented. Without odds a decided bet waits ("needs odds") and is left
  out of realised P/L until an admin enters them.
* Settlement: win → +profit; loss → −stake; draw → push (0); no contest → void (0); canceled or replaced
  bout → void (0). Pending bets never touch realised P/L. A returned stake is never counted as profit.
* Admin corrections are explicit, require a reason, and are logged in ``sim_bet_events`` (append-only).
"""
from __future__ import annotations

import csv
import io
import math
from collections import defaultdict
from decimal import ROUND_HALF_UP, Decimal

from . import ledger
from .config import setting
from .db import audit
from .evaluation.metrics import wilson
from .util import dumps, loads, utcnow

STRATEGY = "confidence_flat"
TIERS = ("High", "Medium", "Low")
SETTLED = ("win", "loss", "push", "void")


# ------------------------------------------------------------------ money (integer cents, exact)
def _cents(x) -> int:
    return int(Decimal(str(x)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def american_to_decimal(american: float) -> float:
    a = float(american)
    if a >= 100:
        return 1 + a / 100
    if a <= -100:
        return 1 + 100 / abs(a)
    raise ValueError(f"invalid American odds {american}: use +100 or more, or -100 or less")


def decimal_to_american(dec: float) -> int:
    if dec is None or dec <= 1:
        raise ValueError("decimal odds must exceed 1.0")
    return round((dec - 1) * 100) if dec >= 2 else round(-100 / (dec - 1))


def profit_cents(stake_cents: int, american: float | None = None, decimal: float | None = None) -> int:
    """Profit on a winning bet (excludes the returned stake), rounded half-up to the cent.
    Positive American odds: stake × odds/100; negative: stake × 100/|odds|."""
    s = Decimal(stake_cents)
    if american is not None:
        a = Decimal(str(american))
        if a >= 100:
            p = s * a / 100
        elif a <= -100:
            p = s * 100 / abs(a)
        else:
            raise ValueError(f"invalid American odds {american}")
    elif decimal is not None:
        p = s * (Decimal(str(decimal)) - 1)
    else:
        raise ValueError("odds required")
    return int(p.quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def settle_amounts(stake_cents: int, outcome: str, american: float | None = None,
                   decimal: float | None = None) -> dict:
    """Net P/L, stake returned and total returned for one bet. Pending returns no realised amounts."""
    if outcome == "win":
        net = profit_cents(stake_cents, american, decimal)
        return {"net": net, "stake_returned": stake_cents, "total_returned": stake_cents + net}
    if outcome == "loss":
        return {"net": -stake_cents, "stake_returned": 0, "total_returned": 0}
    if outcome in ("push", "void"):
        return {"net": 0, "stake_returned": stake_cents, "total_returned": stake_cents}
    if outcome == "pending":
        return {"net": None, "stake_returned": None, "total_returned": None}
    raise ValueError(f"unknown outcome {outcome}")


def money(cents, signed: bool = True) -> str:
    if cents is None:
        return "—"
    v = cents / 100
    s = f"${abs(v):,.2f}"
    if not signed:
        return s if v >= 0 else "−" + s
    return ("+" if v > 0 else "−" if v < 0 else "") + s


# ------------------------------------------------------------------ helpers
def _t(ts: str | None) -> str:
    """Comparable timestamp prefix (formats differ: 'Z' vs '+00:00')."""
    return (ts or "")[:19]


def _stakes(conn) -> dict:
    return {"High": _cents(float(setting(conn, "betting.stake_high")) * 100),
            "Medium": _cents(float(setting(conn, "betting.stake_medium")) * 100),
            "Low": _cents(float(setting(conn, "betting.stake_low")) * 100)}


def _log(conn, bet_id, action, before=None, after=None, reason=None, actor="system"):
    conn.execute("INSERT INTO sim_bet_events(bet_id, ts, actor, action, before_json, after_json, reason) "
                 "VALUES (?,?,?,?,?,?,?)", (bet_id, utcnow(), actor, action,
                                             dumps(before) if before is not None else None,
                                             dumps(after) if after is not None else None, reason))


def _snapshot(pred, fight, ev, stakes) -> dict:
    """Bet fields taken from one prediction, as it was when the bet was recorded."""
    p = loads(pred["payload_json"], {})
    red = pred["predicted_winner_id"] == fight["red_fighter_id"]
    side, other = ("red", "blue") if red else ("blue", "red")
    conf = p.get("confidence") or {}
    tier = conf.get("label") if conf.get("label") in TIERS else "Low"
    expl = p.get("explanation") or {}
    favour = expl.get("favoring_red" if red else "favoring_blue") or []
    against = expl.get("favoring_blue" if red else "favoring_red") or []
    rationale = {
        "prediction_id": pred["id"], "prediction_version": pred["version"], "made_at": pred["created_at"],
        "model": (p.get("model") or {}).get("version"), "p_pick": p.get(f"p_{side}"),
        "method": pred["predicted_method"], "round": pred["predicted_round"],
        "confidence": {"label": conf.get("label"), "score": conf.get("score"), "reasons": conf.get("reasons", [])},
        "for_pick": [{"feature": x.get("feature"), "logit": x.get("logit"), "text": x.get("text")} for x in favour[:3]],
        "against_pick": [{"feature": x.get("feature"), "logit": x.get("logit"), "text": x.get("text")}
                         for x in against[:3]],
    }
    return {
        "prediction_id": pred["id"], "prediction_version": pred["version"], "tier": tier,
        "confidence_score": conf.get("score"),
        "pick_fighter_id": fight[f"{side}_fighter_id"], "pick_name": fight[f"{side}_name"],
        "opponent_fighter_id": fight[f"{other}_fighter_id"], "opponent_name": fight[f"{other}_name"],
        "p_pick": p.get(f"p_{side}"), "stake_cents": stakes[tier],
        "event_name": ev["name"], "event_date": ev["date"], "weight_class": fight["weight_class"],
        "rationale_json": dumps(rationale),
    }


def _odds_for(conn, bet, fight, cutoff: str | None):
    """Latest stored odds for the pick, captured before `cutoff` (the fight's first result)."""
    rows = conn.execute("SELECT * FROM odds WHERE fight_id=? ORDER BY captured_at DESC, id DESC",
                        (fight["id"],)).fetchall()
    for o in rows:
        if cutoff and _t(o["captured_at"]) >= _t(cutoff):
            continue
        red = bet["pick_fighter_id"] == fight["red_fighter_id"]
        dec = float(o["red_decimal"] if red else o["blue_decimal"])
        return {"odds_decimal": dec, "odds_american": decimal_to_american(dec),
                "odds_source": "feed" if o["provider"] != "manual" else "import",
                "odds_bookmaker": o["bookmaker"], "odds_captured_at": o["captured_at"], "odds_id": o["id"]}
    return None


def _decide(bet, fight, ev, res) -> dict:
    """Settlement state implied by the facts (ignores manual overrides)."""
    stake = bet["stake_cents"]
    if res is None:
        if fight["status"] in ("canceled", "replaced") or ev["status"] == "canceled":
            note = "bout replaced; the new bout is tracked separately" if fight["status"] == "replaced" \
                else "bout canceled"
            return {"status": "void" if stake else "no_bet", "net_cents": 0 if stake else None, "settle_note": note,
                    "result_id": None}
        return {"status": "pending" if stake else "no_bet", "net_cents": None, "settle_note": None,
                "result_id": None}
    if not bet["locked_at"]:
        return {"status": "void" if stake else "no_bet", "net_cents": 0 if stake else None, "result_id": res["id"],
                "settle_note": "not locked before the fight (card missed its lock), so it is not graded"}
    if res["outcome"] == "win":
        won = res["winner_fighter_id"] == bet["pick_fighter_id"]
        if not stake:
            return {"status": "no_bet", "net_cents": None, "result_id": res["id"],
                    "settle_note": "pick won" if won else "pick lost"}
        if bet["odds_decimal"] is None:
            return {"status": "win" if won else "loss", "net_cents": None, "result_id": res["id"],
                    "settle_note": "needs odds: enter the odds that were available to settle this bet"}
        amt = settle_amounts(stake, "win" if won else "loss", bet["odds_american"] if bet["odds_source"] == "manual"
                             else None, bet["odds_decimal"])
        return {"status": "win" if won else "loss", "net_cents": amt["net"], "result_id": res["id"],
                "settle_note": None}
    kind, note = ("push", "draw: stake returned") if res["outcome"] == "draw" else ("void", "no contest: stake returned")
    if not stake:
        return {"status": "no_bet", "net_cents": None, "result_id": res["id"], "settle_note": note.split(":")[0]}
    return {"status": kind, "net_cents": 0, "result_id": res["id"], "settle_note": note}


def _update(conn, bet_id: int, fields: dict) -> None:
    cols = ", ".join(f"{k}=?" for k in fields)
    conn.execute(f"UPDATE sim_bets SET {cols}, updated_at=? WHERE id=?", (*fields.values(), utcnow(), bet_id))


# ------------------------------------------------------------------ sync (idempotent)
def sync(conn, actor: str = "system") -> dict:
    """Create, update, lock, price and settle bets for every live-predicted fight. Safe to run any time."""
    stakes = _stakes(conn)
    out = defaultdict(int)
    try:
        for (event_id,) in conn.execute("SELECT DISTINCT event_id FROM predictions WHERE mode='live' "
                                        "ORDER BY event_id").fetchall():
            ev = conn.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()
            lock = conn.execute("SELECT * FROM prediction_locks WHERE event_id=? AND mode='live'",
                                (event_id,)).fetchone()
            official = {r["fight_id"]: r for r in ledger.official_predictions(conn, event_id, "live")} if lock else {}
            latest = {r["fight_id"]: r for r in ledger.latest_predictions(conn, event_id, "live")}
            fights = conn.execute(
                """SELECT f.*, fr.name AS red_name, fb.name AS blue_name FROM fights f
                   JOIN fighters fr ON fr.id=f.red_fighter_id JOIN fighters fb ON fb.id=f.blue_fighter_id
                   WHERE f.event_id=?""", (event_id,)).fetchall()
            for f in fights:
                _sync_fight(conn, ev, lock, f, official.get(f["id"]), latest.get(f["id"]), stakes, out, actor)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return dict(out)


def _sync_fight(conn, ev, lock, f, official, latest, stakes, out, actor):
    bet = conn.execute("SELECT * FROM sim_bets WHERE fight_id=? AND strategy=?", (f["id"], STRATEGY)).fetchone()
    res = conn.execute("SELECT * FROM fight_results WHERE fight_id=? ORDER BY revision DESC LIMIT 1",
                       (f["id"],)).fetchone()
    first_res = conn.execute("SELECT MIN(recorded_at) FROM fight_results WHERE fight_id=?", (f["id"],)).fetchone()[0]
    pred = official if lock else latest
    if bet is None:
        # a bet needs a pre-fight pick: the locked prediction, or (before the lock) the newest one
        if pred is None or (res is not None and not (lock and official)):
            return
        snap = _snapshot(pred, f, ev, stakes)
        now = utcnow()
        snap.update(strategy=STRATEGY, event_id=ev["id"], fight_id=f["id"],
                    status="pending" if snap["stake_cents"] else "no_bet",
                    locked_at=lock["locked_at"] if lock else None, created_at=now, updated_at=now)
        if res is not None:
            snap["rationale_json"] = dumps({**loads(snap["rationale_json"], {}),
                                            "recorded_after_result": True})
        cols = ", ".join(snap)
        bid = conn.execute(f"INSERT INTO sim_bets({cols}) VALUES ({', '.join('?' * len(snap))})",
                           tuple(snap.values())).lastrowid
        _log(conn, bid, "created", None, {k: snap[k] for k in ("tier", "pick_name", "stake_cents", "prediction_id")},
             "recorded from the locked pre-fight prediction after the result arrived" if res is not None else None,
             actor)
        out["created"] += 1
        bet = conn.execute("SELECT * FROM sim_bets WHERE id=?", (bid,)).fetchone()
    elif not bet["locked_at"] and pred is not None and pred["id"] != bet["prediction_id"] and res is None:
        snap = _snapshot(pred, f, ev, stakes)
        before = {k: bet[k] for k in ("prediction_id", "tier", "pick_name", "stake_cents", "p_pick")}
        _update(conn, bet["id"], {k: v for k, v in snap.items() if k not in ("event_name", "event_date")}
                | {"status": "pending" if snap["stake_cents"] else "no_bet"})
        _log(conn, bet["id"], "prediction_changed", before,
             {k: snap[k] for k in ("prediction_id", "tier", "pick_name", "stake_cents", "p_pick")},
             "the engine re-predicted this fight before the card locked; the bet follows the newest prediction",
             actor)
        out["updated"] += 1
        bet = conn.execute("SELECT * FROM sim_bets WHERE id=?", (bet["id"],)).fetchone()

    if not bet["locked_at"] and lock is not None:
        before = {k: bet[k] for k in ("prediction_id", "tier", "pick_name", "stake_cents")}
        if official is not None and official["id"] != bet["prediction_id"]:
            snap = _snapshot(official, f, ev, stakes)
            _update(conn, bet["id"], {k: v for k, v in snap.items() if k not in ("event_name", "event_date")}
                    | {"status": "pending" if snap["stake_cents"] else "no_bet"})
        _update(conn, bet["id"], {"locked_at": lock["locked_at"]})
        bet = conn.execute("SELECT * FROM sim_bets WHERE id=?", (bet["id"],)).fetchone()
        _log(conn, bet["id"], "locked", before, {k: bet[k] for k in before},
             "card predictions locked: selection and stake are now final", actor)
        out["locked"] += 1

    # odds: follow the market until the lock; afterwards only fill a missing price, never replace one
    if bet["stake_cents"] and not bet["manual_override"] and (not bet["locked_at"] or bet["odds_decimal"] is None):
        o = _odds_for(conn, bet, f, first_res)
        if o and (o["odds_id"] != bet["odds_id"]) and bet["odds_source"] != "manual":
            before = {k: bet[k] for k in ("odds_american", "odds_bookmaker", "odds_captured_at")}
            _update(conn, bet["id"], o)
            _log(conn, bet["id"], "odds_set", before if bet["odds_decimal"] is not None else None,
                 {k: o[k] for k in ("odds_american", "odds_bookmaker", "odds_captured_at")}, None, actor)
            out["odds_set"] += 1
            bet = conn.execute("SELECT * FROM sim_bets WHERE id=?", (bet["id"],)).fetchone()

    if bet["manual_override"]:
        return
    d = _decide(bet, f, ev, res)
    cur = {k: bet[k] for k in d}
    if cur != d:
        was_settled = bet["status"] in SETTLED and bet["result_id"] is not None
        _update(conn, bet["id"], d | {"settled_at": utcnow() if d["status"] != "pending" else None})
        action = "resettled" if was_settled else "settled"
        _log(conn, bet["id"], action, cur, d,
             "official result revised" if was_settled and d.get("result_id") != cur.get("result_id") else None, actor)
        out[action] += 1


# ------------------------------------------------------------------ admin corrections (audited)
class CorrectionError(ValueError):
    pass


def correct(conn, bet_id: int, *, reason: str, actor: str = "admin", odds_american: str | float | None = None,
            status: str | None = None, stake_dollars: str | float | None = None) -> dict:
    """Explicit correction of one bet. `status` = auto (follow the official result) or win/loss/push/void."""
    if not (reason or "").strip():
        raise CorrectionError("a reason is required for every correction")
    bet = conn.execute("SELECT * FROM sim_bets WHERE id=?", (bet_id,)).fetchone()
    if bet is None:
        raise CorrectionError("no such bet")
    before = dict(bet)
    fields = {}
    try:
        if odds_american not in (None, ""):
            a = float(odds_american)
            fields.update(odds_decimal=american_to_decimal(a), odds_american=int(a), odds_source="manual",
                          odds_bookmaker="entered by admin", odds_captured_at=utcnow(), odds_id=None)
        if stake_dollars not in (None, ""):
            s = _cents(float(stake_dollars) * 100)
            if s < 0:
                raise CorrectionError("stake cannot be negative")
            fields["stake_cents"] = s
    except ValueError as e:
        raise CorrectionError(str(e)) from None
    try:
        if fields:
            _update(conn, bet_id, fields)
        bet = conn.execute("SELECT * FROM sim_bets WHERE id=?", (bet_id,)).fetchone()
        st = (status or "").strip().lower()
        if st and st != "auto":
            if st not in SETTLED:
                raise CorrectionError("status must be auto, win, loss, push or void")
            if st in ("win", "loss") and bet["odds_decimal"] is None:
                raise CorrectionError("enter the odds before settling a bet as a win or loss")
            amt = settle_amounts(bet["stake_cents"], st, bet["odds_american"] if bet["odds_source"] == "manual"
                                 else None, bet["odds_decimal"])
            _update(conn, bet_id, {"status": st, "net_cents": amt["net"], "manual_override": 1,
                                   "settle_note": f"set by admin: {reason.strip()}", "settled_at": utcnow()})
        elif st == "auto" or fields:
            if st == "auto":
                _update(conn, bet_id, {"manual_override": 0})
            bet = conn.execute("SELECT * FROM sim_bets WHERE id=?", (bet_id,)).fetchone()
            if not bet["manual_override"]:
                f = conn.execute("SELECT * FROM fights WHERE id=?", (bet["fight_id"],)).fetchone()
                ev = conn.execute("SELECT * FROM events WHERE id=?", (bet["event_id"],)).fetchone()
                res = conn.execute("SELECT * FROM fight_results WHERE fight_id=? ORDER BY revision DESC LIMIT 1",
                                   (bet["fight_id"],)).fetchone()
                d = _decide(bet, f, ev, res)
                _update(conn, bet_id, d | {"settled_at": utcnow() if d["status"] != "pending" else None})
        after = dict(conn.execute("SELECT * FROM sim_bets WHERE id=?", (bet_id,)).fetchone())
        changed = {k: (before[k], after[k]) for k in after if k not in ("updated_at",) and before.get(k) != after[k]}
        _log(conn, bet_id, "corrected", {k: v[0] for k, v in changed.items()}, {k: v[1] for k, v in changed.items()},
             reason.strip(), actor)
        audit(conn, "bet.corrected", "sim_bet", bet_id, {"changed": sorted(changed), "reason": reason.strip()},
              actor=actor)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return after


# ------------------------------------------------------------------ reading & statistics
def bets(conn) -> list[dict]:
    rows = conn.execute(
        """SELECT b.*, f.bout_order FROM sim_bets b JOIN fights f ON f.id=b.fight_id WHERE b.strategy=?
           ORDER BY b.event_date, b.event_id, COALESCE(f.bout_order, 999) DESC, b.id""", (STRATEGY,)).fetchall()
    return [dict(r) for r in rows]


def history(conn, bet_id: int) -> list[dict]:
    return [dict(r) for r in conn.execute("SELECT * FROM sim_bet_events WHERE bet_id=? ORDER BY id", (bet_id,))]


_LABELS = {"tier": "confidence", "pick_name": "pick", "stake_cents": "stake", "p_pick": "engine chance",
           "prediction_id": "prediction", "odds_american": "odds", "odds_bookmaker": "odds from",
           "odds_captured_at": "odds time", "status": "result", "net_cents": "P/L", "settle_note": "note",
           "result_id": "official result", "odds_decimal": "decimal odds", "odds_source": "odds source",
           "manual_override": "admin override", "locked_at": "locked"}


def _fmt_field(k, v):
    if v is None:
        return "—"
    if k in ("stake_cents", "net_cents"):
        return money(v, signed=k == "net_cents")
    if k == "p_pick":
        return f"{v:.0%}"
    if k == "odds_american":
        return f"{int(v):+d}"
    if k == "odds_decimal":
        return f"{v:.3f}"
    if k in ("prediction_id", "result_id"):
        return f"#{v}"
    if k in ("odds_captured_at", "locked_at"):
        return str(v)[:16].replace("T", " ")
    return str(v)


def describe(h: dict) -> list[str]:
    """One history entry as short readable changes, e.g. 'stake: $100.00 → $50.00'."""
    before, after = loads(h.get("before_json"), {}) or {}, loads(h.get("after_json"), {}) or {}
    out = []
    for k in list(after) + [k for k in before if k not in after]:
        if k in ("created_at", "updated_at", "settled_at", "rationale_json"):
            continue
        b, a = before.get(k), after.get(k)
        if k in before and b == a:
            continue
        lab = _LABELS.get(k, k.replace("_", " "))
        out.append(f"{lab}: {_fmt_field(k, b)} → {_fmt_field(k, a)}" if k in before else f"{lab}: {_fmt_field(k, a)}")
    return out


def is_bet(r) -> bool:
    return (r["stake_cents"] or 0) > 0 and r["status"] != "no_bet"


def is_realised(r) -> bool:
    return is_bet(r) and r["status"] in SETTLED and r["net_cents"] is not None


def needs_odds(r) -> bool:
    return is_bet(r) and r["status"] in ("win", "loss") and r["net_cents"] is None


def pick_won(r):
    """Whether the pick won, for every tracked pick including Low (None = undecided/no result)."""
    if r["status"] in ("win", "loss"):
        return r["status"] == "win"
    if r["status"] == "no_bet" and r["settle_note"] in ("pick won", "pick lost"):
        return r["settle_note"] == "pick won"
    return None


def _pct(a, b):
    return a / b if b else None


def summary(rows: list[dict]) -> dict:
    b = [r for r in rows if is_bet(r)]
    real = [r for r in b if is_realised(r)]
    action = [r for r in real if r["status"] in ("win", "loss")]
    pending = [r for r in b if r["status"] == "pending"]
    waiting = [r for r in b if needs_odds(r)]
    wins = sum(1 for r in action if r["status"] == "win")
    net = sum(r["net_cents"] for r in real)
    action_stake = sum(r["stake_cents"] for r in action)
    tier_net = {t: sum(r["net_cents"] for r in real if r["tier"] == t) for t in ("High", "Medium")}
    return {
        "net": net, "high_net": tier_net["High"], "medium_net": tier_net["Medium"],
        "roi": _pct(net, action_stake), "win_rate": _pct(wins, len(action)), "wins": wins, "decided": len(action),
        "settled": len(real), "pending": len(pending), "needs_odds": len(waiting), "total": len(b),
        "risked": sum(r["stake_cents"] for r in b if r["status"] != "void"),
        "settled_stake": action_stake,
        "exposure": sum(r["stake_cents"] for r in pending + waiting),
        "tracked_low": sum(1 for r in rows if r["tier"] == "Low"),
    }


def _streaks(seq: list[bool]) -> tuple[int, int]:
    best_w = best_l = cur = 0
    last = None
    for x in seq:
        cur = cur + 1 if x == last else 1
        last = x
        if x:
            best_w = max(best_w, cur)
        else:
            best_l = max(best_l, cur)
    return best_w, best_l


def tier_stats(rows: list[dict], tier: str) -> dict:
    b = [r for r in rows if is_bet(r) and r["tier"] == tier]
    real = [r for r in b if is_realised(r)]
    action = [r for r in real if r["status"] in ("win", "loss")]
    wins = [r for r in action if r["status"] == "win"]
    losses = [r for r in action if r["status"] == "loss"]
    stake = sum(r["stake_cents"] for r in action)
    net = sum(r["net_cents"] for r in real)
    decs = [r["odds_decimal"] for r in action if r["odds_decimal"]]
    ps = [r["p_pick"] for r in action if r["p_pick"] is not None]
    lo, hi = wilson(len(wins), len(action)) if action else (None, None)
    w, l = _streaks([r["status"] == "win" for r in action])
    avg_dec = sum(decs) / len(decs) if decs else None
    return {
        "tier": tier, "bets": len(b), "wins": len(wins), "losses": len(losses),
        "pushes": sum(1 for r in real if r["status"] == "push"), "voids": sum(1 for r in real if r["status"] == "void"),
        "pending": sum(1 for r in b if r["status"] == "pending") + sum(1 for r in b if needs_odds(r)),
        "win_rate": _pct(len(wins), len(action)), "win_ci": (lo, hi), "settled_stake": stake,
        "gross_winnings": sum(r["net_cents"] for r in wins), "total_losses": -sum(r["net_cents"] for r in losses),
        "net": net, "roi": _pct(net, stake),
        "avg_decimal": avg_dec, "avg_american": decimal_to_american(avg_dec) if avg_dec and avg_dec > 1 else None,
        "avg_p": sum(ps) / len(ps) if ps else None,
        "longest_win": w, "longest_loss": l, "avg_pl": (net / len(real)) if real else None,
    }


def event_stats(rows: list[dict]) -> list[dict]:
    by = defaultdict(list)
    for r in rows:
        by[r["event_id"]].append(r)
    out = []
    for eid, rs in by.items():
        b = [r for r in rs if is_bet(r)]
        real = [r for r in b if is_realised(r)]
        action = [r for r in real if r["status"] in ("win", "loss")]
        stake = sum(r["stake_cents"] for r in action)
        net = sum(r["net_cents"] for r in real)
        pend = sum(1 for r in b if r["status"] == "pending" or needs_odds(r))
        tiers = {}
        for t in ("High", "Medium"):
            tb = [r for r in b if r["tier"] == t]
            ta = [r for r in tb if is_realised(r) and r["status"] in ("win", "loss")]
            tiers[t] = {"picks": len(tb), "net": sum(r["net_cents"] for r in tb if is_realised(r)),
                        "win_rate": _pct(sum(1 for r in ta if r["status"] == "win"), len(ta)), "decided": len(ta)}
        state = ("no bets" if not b else "in progress" if pend and not real else
                 ("profitable" if net > 0 else "losing" if net < 0 else "break-even") + (" so far" if pend else ""))
        out.append({"event_id": eid, "name": rs[0]["event_name"], "date": rs[0]["event_date"], "tiers": tiers,
                    "bets": len(b), "low": sum(1 for r in rs if r["tier"] == "Low"),
                    "staked": sum(r["stake_cents"] for r in b if r["status"] != "void"),
                    "net": net, "roi": _pct(net, stake), "pending": pend, "state": state, "settled": len(real)})
    out.sort(key=lambda e: (e["date"] or "", e["event_id"]), reverse=True)
    return out


def cumulative(rows: list[dict]) -> list[dict]:
    pts, tot = [], {"High": 0, "Medium": 0, "all": 0}
    for i, r in enumerate([r for r in rows if is_realised(r)]):
        tot[r["tier"]] = tot.get(r["tier"], 0) + r["net_cents"]
        tot["all"] += r["net_cents"]
        pts.append({"i": i + 1, "date": r["event_date"], "label": f"{r['pick_name']} ({r['event_name']})",
                    "High": tot["High"] / 100, "Medium": tot["Medium"] / 100, "all": tot["all"] / 100})
    return pts


def _segment(name, rs, min_n) -> dict:
    decided = [r for r in rs if pick_won(r) is not None]
    won = sum(1 for r in decided if pick_won(r))
    action = [r for r in decided if is_realised(r) and r["status"] in ("win", "loss")]
    net = sum(r["net_cents"] for r in action)
    stake = sum(r["stake_cents"] for r in action)
    ps = [r["p_pick"] for r in decided if r["p_pick"] is not None]
    lo, hi = wilson(won, len(decided)) if decided else (None, None)
    avg_p = sum(ps) / len(ps) if ps else None
    verdict = "too few to judge"
    if len(decided) >= min_n and avg_p is not None:
        verdict = ("as expected" if lo <= avg_p <= hi else
                   "engine overconfident here" if avg_p > hi else "engine underconfident here")
    return {"name": name, "n": len(decided), "won": won, "rate": _pct(won, len(decided)), "ci": (lo, hi),
            "avg_p": avg_p, "bets": len(action), "net": net, "roi": _pct(net, stake), "evidence": len(decided) >= min_n,
            "verdict": verdict}


def feedback(rows: list[dict], min_n: int = 30) -> dict:
    """How the engine's picks and tiers held up. Descriptive only: nothing here feeds back into the model."""
    seg = lambda groups: sorted((_segment(k, v, min_n) for k, v in groups.items()), key=lambda s: -s["n"])
    by = lambda key: seg(_group(rows, key))
    tiers = [_segment(t, [r for r in rows if r["tier"] == t], min_n) for t in TIERS]
    hi, med = tiers[0], tiers[1]
    if hi["n"] >= min_n and med["n"] >= min_n:
        diff = hi["rate"] - med["rate"]
        se = math.sqrt(hi["rate"] * (1 - hi["rate"]) / hi["n"] + med["rate"] * (1 - med["rate"]) / med["n"]) or 1e-9
        z = diff / se
        tier_verdict = (f"High-confidence picks win {diff * 100:+.0f} points more often than Medium "
                        + ("— a clear difference." if z > 1.96 else
                           "— but not yet a clear difference." if z > -1.96 else
                           "— Medium is doing clearly better, so the tiers are not ordered as expected."))
    else:
        tier_verdict = (f"Not enough settled picks yet to compare tiers (need {min_n} each; have "
                        f"{hi['n']} High and {med['n']} Medium).")
    action = [r for r in rows if is_realised(r) and r["status"] in ("win", "loss") and r["odds_decimal"]]
    expected = sum(r["stake_cents"] * (r["p_pick"] * r["odds_decimal"] - 1) for r in action if r["p_pick"] is not None)
    fav = _group([r for r in rows if r["odds_decimal"]],
                 lambda r: "Pick was the betting favourite" if r["odds_decimal"] < 2 else "Pick was the underdog")
    band = lambda r: (None if r["confidence_score"] is None else
                      f"score {min(int(r['confidence_score'] * 10), 9) / 10:.1f}–{min(int(r['confidence_score'] * 10), 9) / 10 + .1:.1f}")
    return {"min_n": min_n, "tiers": tiers, "tier_verdict": tier_verdict,
            "expected_net": round(expected), "realised_net": sum(r["net_cents"] for r in action), "n_priced": len(action),
            "favourite": seg(fav), "weight_class": by(lambda r: r["weight_class"] or "Unknown"),
            "score_band": by(band), "top_factor": by(_top_factor)}


def _group(rows, key):
    g = defaultdict(list)
    for r in rows:
        k = key(r) if callable(key) else r[key]
        if k is not None:
            g[k].append(r)
    return g


def _top_factor(r):
    from .web.plain import FACTORS
    fs = (loads(r["rationale_json"], {}) or {}).get("for_pick") or []
    return FACTORS.get(fs[0]["feature"], fs[0]["feature"]) if fs else None


# ------------------------------------------------------------------ ledger filters & CSV
def filter_rows(rows: list[dict], q: dict) -> list[dict]:
    def num(k):
        try:
            return float(q.get(k)) if q.get(k) not in (None, "") else None
        except ValueError:
            return None
    out = [r for r in rows if r["tier"] in ("High", "Medium") or q.get("tier") == "Low"]
    if q.get("tier"):
        out = [r for r in out if r["tier"] == q["tier"]]
    if q.get("event"):
        out = [r for r in out if str(r["event_id"]) == str(q["event"])]
    if q.get("date_from"):
        out = [r for r in out if (r["event_date"] or "") >= q["date_from"]]
    if q.get("date_to"):
        out = [r for r in out if (r["event_date"] or "") <= q["date_to"]]
    st = q.get("status")
    if st == "needs_odds":
        out = [r for r in out if needs_odds(r)]
    elif st:
        out = [r for r in out if r["status"] == st and not needs_odds(r)]
    if q.get("fighter"):
        s = q["fighter"].lower()
        out = [r for r in out if s in (r["pick_name"] or "").lower() or s in (r["opponent_name"] or "").lower()]
    lo, hi = num("odds_min"), num("odds_max")
    if lo is not None or hi is not None:
        out = [r for r in out if r["odds_american"] is not None and (lo is None or r["odds_american"] >= lo)
               and (hi is None or r["odds_american"] <= hi)]
    key = {"date": lambda r: (r["event_date"] or "", r["id"]), "confidence": lambda r: (r["confidence_score"] or 0),
           "stake": lambda r: r["stake_cents"], "odds": lambda r: (r["odds_decimal"] or 0),
           "pl": lambda r: (r["net_cents"] if r["net_cents"] is not None else -10 ** 12)}.get(q.get("sort") or "date")
    out.sort(key=key, reverse=(q.get("dir") or "desc") == "desc")
    return out


CSV_COLUMNS = ["bet_id", "event_date", "event", "weight_class", "pick", "opponent", "tier", "confidence_score",
               "predicted_win_probability", "odds_american", "odds_decimal", "odds_source", "odds_bookmaker",
               "stake", "status", "net_pl", "stake_returned", "total_returned", "settle_note", "prediction_id",
               "recorded_at", "locked_at", "settled_at"]


def to_csv(rows: list[dict]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(CSV_COLUMNS)
    for r in rows:
        realised = is_realised(r)
        amt = settle_amounts(r["stake_cents"], r["status"]) if realised and r["status"] in ("push", "void") else None
        ret = (amt or {}).get("stake_returned") if amt else (
            r["stake_cents"] if realised and r["status"] == "win" else 0 if realised else None)
        tot = (r["stake_cents"] + r["net_cents"]) if realised and r["status"] == "win" else (
            ret if realised else None)
        w.writerow([r["id"], r["event_date"], r["event_name"], r["weight_class"], r["pick_name"], r["opponent_name"],
                    r["tier"], r["confidence_score"], None if r["p_pick"] is None else round(r["p_pick"], 4),
                    r["odds_american"], None if r["odds_decimal"] is None else round(r["odds_decimal"], 4),
                    r["odds_source"], r["odds_bookmaker"], f"{r['stake_cents'] / 100:.2f}",
                    "needs_odds" if needs_odds(r) else r["status"],
                    "" if r["net_cents"] is None else f"{r['net_cents'] / 100:.2f}",
                    "" if ret is None else f"{ret / 100:.2f}", "" if tot is None else f"{tot / 100:.2f}",
                    r["settle_note"] or "", r["prediction_id"], r["created_at"], r["locked_at"] or "",
                    r["settled_at"] or ""])
    return buf.getvalue()
