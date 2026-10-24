"""The immutable prediction ledger.

* Rows are append-only (SQLite triggers abort UPDATE/DELETE).
* Each row stores a SHA-256 of its canonical content and the hash of the previous row,
  forming a chain; `verify()` detects any tampering done outside the triggers.
* An event lock freezes the official pre-event prediction per fight. After the lock, a
  new version needs an explicit reason and is marked `is_post_lock`; it never replaces
  the locked one for grading. Fights with a recorded result accept no new predictions.
"""
from __future__ import annotations

from .db import audit
from .util import dumps, loads, sha256, utcnow


class LedgerError(Exception):
    pass


CONTENT_FIELDS = ["fight_id", "event_id", "version", "supersedes_id", "reason", "mode", "created_at", "as_of",
                  "data_cutoff", "model_version_id", "red_fighter_id", "blue_fighter_id", "red_snapshot_id",
                  "blue_snapshot_id", "p_red", "p_blue", "predicted_winner_id", "predicted_method", "predicted_round",
                  "confidence", "is_post_lock", "payload_json"]


def _content_hash(row: dict) -> str:
    return sha256(dumps({k: row[k] for k in CONTENT_FIELDS}))


def is_locked(conn, event_id: int, mode: str) -> bool:
    return conn.execute("SELECT 1 FROM prediction_locks WHERE event_id=? AND mode=?", (event_id, mode)).fetchone() is not None


def save_snapshot(conn, fighter_id: int, fight_id: int, as_of: str, state: dict) -> int:
    js = dumps(state)
    h = sha256(js)
    row = conn.execute("SELECT id FROM fighter_snapshots WHERE fighter_id=? AND fight_id=? AND sha256=?",
                       (fighter_id, fight_id, h)).fetchone()
    if row:
        return row["id"]
    cur = conn.execute("INSERT INTO fighter_snapshots(fighter_id, fight_id, as_of, state_json, sha256, created_at) "
                       "VALUES (?,?,?,?,?,?)", (fighter_id, fight_id, as_of, js, h, utcnow()))
    return cur.lastrowid


def record(conn, *, fight: dict, pred: dict, model_version_id: int, mode: str, as_of: str, reason: str,
           red_state: dict, blue_state: dict, allow_post_lock: bool = False, commit: bool = True) -> int:
    if mode not in ("live", "replay"):
        raise LedgerError("mode must be live or replay")
    if not reason:
        raise LedgerError("every prediction needs a reason")
    fid, eid = fight["id"], fight["event_id"]
    if conn.execute("SELECT 1 FROM fight_results WHERE fight_id=?", (fid,)).fetchone() and mode == "live":
        raise LedgerError(f"fight {fid} already has a result; predictions after the fact are not allowed")
    if as_of > fight["date"]:
        raise LedgerError(f"decision time {as_of} is after the fight date {fight['date']}")
    locked = is_locked(conn, eid, mode)
    if locked and not allow_post_lock:
        raise LedgerError(f"event {eid} is locked for {mode} predictions; a post-lock version needs an explicit "
                          f"reason (late replacement / verified new information)")
    prev = conn.execute("SELECT id, version FROM predictions WHERE fight_id=? AND mode=? ORDER BY version DESC LIMIT 1",
                        (fid, mode)).fetchone()
    last = conn.execute("SELECT content_sha256 FROM predictions ORDER BY id DESC LIMIT 1").fetchone()
    red_snap = save_snapshot(conn, fight["red_fighter_id"], fid, red_state["as_of"], red_state)
    blue_snap = save_snapshot(conn, fight["blue_fighter_id"], fid, blue_state["as_of"], blue_state)
    row = {
        "fight_id": fid, "event_id": eid, "version": 1 if prev is None else prev["version"] + 1,
        "supersedes_id": None if prev is None else prev["id"], "reason": reason, "mode": mode,
        "created_at": utcnow(), "as_of": as_of, "data_cutoff": min(as_of, fight["date"]),
        "model_version_id": model_version_id, "red_fighter_id": fight["red_fighter_id"],
        "blue_fighter_id": fight["blue_fighter_id"], "red_snapshot_id": red_snap, "blue_snapshot_id": blue_snap,
        "p_red": pred["p_red"], "p_blue": pred["p_blue"], "predicted_winner_id": pred["predicted_winner_id"],
        "predicted_method": pred["predicted_method"], "predicted_round": pred["predicted_round"],
        "confidence": pred["confidence"]["label"], "is_post_lock": int(locked), "payload_json": dumps(pred),
    }
    if abs(row["p_red"] + row["p_blue"] - 1) > 1e-9:
        raise LedgerError("winner probabilities must sum to 1")
    row["content_sha256"] = _content_hash(row)
    row["prev_sha256"] = last["content_sha256"] if last else None
    cols = list(row)
    cur = conn.execute(f"INSERT INTO predictions({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                       [row[c] for c in cols])
    if locked:
        audit(conn, "prediction.post_lock_version", "prediction", cur.lastrowid, {"reason": reason})
    if commit:
        conn.commit()
    return cur.lastrowid


def lock_event(conn, event_id: int, mode: str, as_of: str, reason: str = "pre-event lock") -> dict:
    if is_locked(conn, event_id, mode):
        raise LedgerError(f"event {event_id} already locked for {mode}")
    rows = conn.execute(
        """SELECT p.id, p.fight_id FROM predictions p JOIN fights f ON f.id=p.fight_id
           WHERE p.event_id=? AND p.mode=? AND f.status IN ('scheduled','completed')
           AND p.version=(SELECT MAX(version) FROM predictions q WHERE q.fight_id=p.fight_id AND q.mode=p.mode)""",
        (event_id, mode)).fetchall()
    ids = [r["id"] for r in rows]
    lock_id = conn.execute("INSERT INTO prediction_locks(event_id, mode, locked_at, as_of, reason, prediction_ids_json) "
                           "VALUES (?,?,?,?,?,?)", (event_id, mode, utcnow(), as_of, reason, dumps(ids))).lastrowid
    if ids:
        conn.executemany("INSERT INTO prediction_lock_members(lock_id, prediction_id) VALUES (?,?)",
                         [(lock_id, i) for i in ids])
    if mode == "live":
        conn.execute("UPDATE events SET status='locked', updated_at=? WHERE id=? AND status='scheduled'",
                     (utcnow(), event_id))
    audit(conn, "event.locked", "event", event_id, {"mode": mode, "predictions": len(ids)})
    conn.commit()
    return {"event_id": event_id, "locked_predictions": len(ids)}


def official_predictions(conn, event_id: int, mode: str) -> list:
    """The graded prediction per fight: the locked version, or the first post-lock version for a fight that
    did not exist at lock time (late replacement)."""
    lock = conn.execute("SELECT prediction_ids_json FROM prediction_locks WHERE event_id=? AND mode=?",
                        (event_id, mode)).fetchone()
    if lock is None:
        return []
    ids = loads(lock["prediction_ids_json"], [])
    rows = {r["fight_id"]: r for r in conn.execute(
        f"SELECT * FROM predictions WHERE id IN ({','.join('?' * len(ids)) or 'NULL'})", ids)}
    late = conn.execute(
        """SELECT * FROM predictions p WHERE event_id=? AND mode=? AND is_post_lock=1
           AND version=(SELECT MIN(version) FROM predictions q WHERE q.fight_id=p.fight_id AND q.mode=p.mode
                        AND q.is_post_lock=1)""", (event_id, mode)).fetchall()
    for r in late:
        rows.setdefault(r["fight_id"], r)
    return list(rows.values())


def latest_predictions(conn, event_id: int, mode: str) -> list:
    return conn.execute(
        """SELECT p.* FROM predictions p WHERE p.event_id=? AND p.mode=?
           AND p.version=(SELECT MAX(version) FROM predictions q WHERE q.fight_id=p.fight_id AND q.mode=p.mode)""",
        (event_id, mode)).fetchall()


def verify(conn) -> dict:
    bad, broken = [], []
    prev = None
    for r in conn.execute("SELECT * FROM predictions ORDER BY id"):
        d = dict(r)
        if _content_hash(d) != d["content_sha256"]:
            bad.append(d["id"])
        if d["prev_sha256"] != prev:
            broken.append(d["id"])
        prev = d["content_sha256"]
    n = conn.execute("SELECT COUNT(*) FROM predictions").fetchone()[0]
    return {"rows": n, "hash_mismatches": bad, "chain_breaks": broken, "ok": not bad and not broken}
