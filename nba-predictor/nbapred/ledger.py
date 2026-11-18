"""The immutable prediction ledger.

* Rows are append-only (SQLite triggers abort UPDATE/DELETE).
* Each row stores a SHA-256 of its canonical content and the hash of the previous row,
  forming a chain; `verify()` detects any tampering done outside the triggers.
* A game-night lock freezes the official pre-game prediction per game. After the lock, a
  new version needs an explicit reason and is marked `is_post_lock`; it never replaces
  the locked one for grading. Games with a recorded result accept no new predictions.
"""
from __future__ import annotations

from .db import audit
from .util import dumps, loads, sha256, utcnow


class LedgerError(Exception):
    pass


CONTENT_FIELDS = ["game_id", "event_id", "version", "supersedes_id", "reason", "mode", "created_at", "as_of",
                  "data_cutoff", "model_version_id", "home_team_id", "away_team_id", "home_snapshot_id",
                  "away_snapshot_id", "p_home", "p_away", "predicted_winner_id", "predicted_margin", "predicted_total",
                  "predicted_bucket", "confidence", "is_post_lock", "payload_json"]


def _content_hash(row: dict) -> str:
    return sha256(dumps({k: row[k] for k in CONTENT_FIELDS}))


def is_locked(conn, event_id: int, mode: str) -> bool:
    return conn.execute("SELECT 1 FROM prediction_locks WHERE event_id=? AND mode=?", (event_id, mode)).fetchone() is not None


def save_snapshot(conn, team_id: int, game_id: int, as_of: str, state: dict) -> int:
    js = dumps(state)
    h = sha256(js)
    row = conn.execute("SELECT id FROM team_snapshots WHERE team_id=? AND game_id=? AND sha256=?",
                       (team_id, game_id, h)).fetchone()
    if row:
        return row["id"]
    cur = conn.execute("INSERT INTO team_snapshots(team_id, game_id, as_of, state_json, sha256, created_at) "
                       "VALUES (?,?,?,?,?,?)", (team_id, game_id, as_of, js, h, utcnow()))
    return cur.lastrowid


def record(conn, *, game: dict, pred: dict, model_version_id: int, mode: str, as_of: str, reason: str,
           home_state: dict, away_state: dict, allow_post_lock: bool = False, commit: bool = True) -> int:
    if mode not in ("live", "replay"):
        raise LedgerError("mode must be live or replay")
    if not reason:
        raise LedgerError("every prediction needs a reason")
    fid, eid = game["id"], game["event_id"]
    if conn.execute("SELECT 1 FROM game_results WHERE game_id=?", (fid,)).fetchone() and mode == "live":
        raise LedgerError(f"game {fid} already has a result; predictions after the fact are not allowed")
    if as_of > game["date"]:
        raise LedgerError(f"decision time {as_of} is after the game date {game['date']}")
    locked = is_locked(conn, eid, mode)
    if locked and not allow_post_lock:
        raise LedgerError(f"event {eid} is locked for {mode} predictions; a post-lock version needs an explicit "
                          f"reason (verified new information such as an injury report)")
    prev = conn.execute("SELECT id, version FROM predictions WHERE game_id=? AND mode=? ORDER BY version DESC LIMIT 1",
                        (fid, mode)).fetchone()
    last = conn.execute("SELECT content_sha256 FROM predictions ORDER BY id DESC LIMIT 1").fetchone()
    home_snap = save_snapshot(conn, game["home_team_id"], fid, home_state["as_of"], home_state)
    away_snap = save_snapshot(conn, game["away_team_id"], fid, away_state["as_of"], away_state)
    row = {
        "game_id": fid, "event_id": eid, "version": 1 if prev is None else prev["version"] + 1,
        "supersedes_id": None if prev is None else prev["id"], "reason": reason, "mode": mode,
        "created_at": utcnow(), "as_of": as_of, "data_cutoff": min(as_of, game["date"]),
        "model_version_id": model_version_id, "home_team_id": game["home_team_id"],
        "away_team_id": game["away_team_id"], "home_snapshot_id": home_snap, "away_snapshot_id": away_snap,
        "p_home": pred["p_home"], "p_away": pred["p_away"], "predicted_winner_id": pred["predicted_winner_id"],
        "predicted_margin": pred["predicted_margin"], "predicted_total": pred["predicted_total"],
        "predicted_bucket": pred["predicted_bucket"],
        "confidence": pred["confidence"]["label"], "is_post_lock": int(locked), "payload_json": dumps(pred),
    }
    if abs(row["p_home"] + row["p_away"] - 1) > 1e-9:
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
        """SELECT p.id, p.game_id FROM predictions p JOIN games g ON g.id=p.game_id
           WHERE p.event_id=? AND p.mode=? AND g.status IN ('scheduled','completed')
           AND p.version=(SELECT MAX(version) FROM predictions q WHERE q.game_id=p.game_id AND q.mode=p.mode)""",
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
    """The graded prediction per game: the locked version, or the first post-lock version for a game that
    did not exist at lock time (rescheduled into the night)."""
    lock = conn.execute("SELECT prediction_ids_json FROM prediction_locks WHERE event_id=? AND mode=?",
                        (event_id, mode)).fetchone()
    if lock is None:
        return []
    ids = loads(lock["prediction_ids_json"], [])
    rows = {r["game_id"]: r for r in conn.execute(
        f"SELECT * FROM predictions WHERE id IN ({','.join('?' * len(ids)) or 'NULL'})", ids)}
    late = conn.execute(
        """SELECT * FROM predictions p WHERE event_id=? AND mode=? AND is_post_lock=1
           AND version=(SELECT MIN(version) FROM predictions q WHERE q.game_id=p.game_id AND q.mode=p.mode
                        AND q.is_post_lock=1)""", (event_id, mode)).fetchall()
    for r in late:
        rows.setdefault(r["game_id"], r)
    return list(rows.values())


def latest_predictions(conn, event_id: int, mode: str) -> list:
    return conn.execute(
        """SELECT p.* FROM predictions p WHERE p.event_id=? AND p.mode=?
           AND p.version=(SELECT MAX(version) FROM predictions q WHERE q.game_id=p.game_id AND q.mode=p.mode)""",
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
