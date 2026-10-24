"""Event lifecycle: upcoming → preliminary predictions → lock → results → evaluation → learning.

`tick()` runs every due step once and is safe to call repeatedly (cron, the in-process
scheduler, or the Settings screen's "Run now" button). A step that cannot run because a
provider is not configured is reported as such, never faked.
"""
from __future__ import annotations

import datetime as dt
import threading
import time

from . import ledger, predict, review
from .config import setting
from .db import audit, flag_issue
from .ingest import ingest_bundle
from .learning import loop
from .providers.base import ProviderError, ProviderUnavailable
from .util import utcnow


def _job(conn, name: str):
    cur = conn.execute("INSERT INTO job_runs(job, started_at, status) VALUES (?,?,?)", (name, utcnow(), "running"))
    conn.commit()
    return cur.lastrowid


def _finish(conn, jid: int, status: str, message: str):
    conn.execute("UPDATE job_runs SET finished_at=?, status=?, message=? WHERE id=?", (utcnow(), status, message[:2000], jid))
    conn.commit()


def historical_provider(conn):
    from .providers.ufcstats_mirror import UFCStatsMirrorProvider
    return UFCStatsMirrorProvider(base_url=setting(conn, "providers.ufcstats_mirror.base_url"))


def upcoming_provider(conn):
    name = setting(conn, "providers.upcoming")
    if name == "ufcstats_live":
        from .providers.ufcstats_live import UFCStatsLiveProvider
        return UFCStatsLiveProvider(min_interval_s=float(setting(conn, "providers.min_request_interval_s")))
    return None


def refresh_history(conn) -> dict:
    jid = _job(conn, "refresh_history")
    try:
        out = ingest_bundle(conn, historical_provider(conn).fetch_history())
        _finish(conn, jid, "ok", str(out))
        return out
    except (ProviderError, OSError) as e:
        flag_issue(conn, "source", "ufcstats_mirror", "source_failure", str(e), "error")
        conn.commit()
        _finish(conn, jid, "error", str(e))
        return {"error": str(e), "config_required": getattr(e, "config_required", "")}


def refresh_upcoming(conn) -> dict:
    jid = _job(conn, "refresh_upcoming")
    prov = upcoming_provider(conn)
    if prov is None:
        msg = ("no automatic upcoming-card provider configured (providers.upcoming=manual): import the card with "
               "templates/import/card_template.json")
        _finish(conn, jid, "skipped", msg)
        return {"skipped": msg}
    try:
        out = ingest_bundle(conn, prov.fetch_upcoming(), reconcile_cards=True)
        _finish(conn, jid, "ok", str(out))
        return out
    except ProviderError as e:
        flag_issue(conn, "source", prov.name, "source_failure", str(e), "error")
        conn.commit()
        _finish(conn, jid, "error", str(e))
        return {"error": str(e), "config_required": getattr(e, "config_required", "")}


def lock_time(conn, ev) -> str:
    hours = float(setting(conn, "lifecycle.lock_hours_before"))
    if ev["start_time_utc"]:
        start = dt.datetime.fromisoformat(ev["start_time_utc"].replace("Z", "+00:00"))
    else:
        # unknown start time: assume the card could begin at 00:00 UTC on the event date (conservative)
        start = dt.datetime.fromisoformat(ev["date"] + "T00:00:00+00:00")
    return (start - dt.timedelta(hours=hours)).isoformat()


def next_event(conn):
    today = utcnow()[:10]
    return conn.execute("SELECT * FROM events WHERE date>=? AND status IN ('scheduled','locked') ORDER BY date LIMIT 1",
                        (today,)).fetchone()


def predict_upcoming(conn, reason: str = "preliminary (scheduled refresh)") -> list:
    out = []
    now = utcnow()
    for ev in conn.execute("SELECT * FROM events WHERE status='scheduled' AND date>=? ORDER BY date",
                           (now[:10],)).fetchall():
        if now >= lock_time(conn, ev):
            continue
        try:
            ids = predict.predict_event(conn, ev["id"], mode="live", reason=reason)
            out.append({"event_id": ev["id"], "predictions": len(ids)})
        except (ledger.LedgerError, RuntimeError) as e:
            out.append({"event_id": ev["id"], "error": str(e)})
    return out


def lock_due(conn) -> list:
    out = []
    now = utcnow()
    for ev in conn.execute("SELECT * FROM events WHERE status='scheduled'").fetchall():
        if now < lock_time(conn, ev):
            continue
        n = conn.execute("SELECT COUNT(*) FROM predictions WHERE event_id=? AND mode='live'", (ev["id"],)).fetchone()[0]
        if n == 0:
            conn.execute("UPDATE events SET status='missed_lock', updated_at=? WHERE id=?", (now, ev["id"]))
            audit(conn, "event.missed_lock", "event", ev["id"],
                  {"note": "no predictions existed before the lock time; none will be created after it"})
            conn.commit()
            out.append({"event_id": ev["id"], "status": "missed_lock"})
        else:
            out.append(ledger.lock_event(conn, ev["id"], "live", now[:10], "automatic pre-event lock"))
    return out


def process_results(conn) -> list:
    out = []
    for ev in conn.execute("""SELECT * FROM events WHERE status IN ('locked','completed') AND EXISTS
                              (SELECT 1 FROM prediction_locks l WHERE l.event_id=events.id AND l.mode='live')""").fetchall():
        res = review.evaluate_event(conn, ev["id"], "live")
        out.append(res)
        if res.get("graded") and res.get("pending", 0) == 0:
            next_day = (dt.date.fromisoformat(ev["date"]) + dt.timedelta(days=1)).isoformat()
            try:
                out.append(loop.run_learning(conn, next_day, "live", ev["id"]))
            except Exception as e:  # learning failure must not lose the evaluation
                out.append({"learning_error": str(e)})
    return out


def tick(conn) -> dict:
    jid = _job(conn, "tick")
    report = {"history": refresh_history(conn), "upcoming": refresh_upcoming(conn)}
    report["locks"] = lock_due(conn)
    report["predictions"] = predict_upcoming(conn)
    report["results"] = process_results(conn)
    _finish(conn, jid, "ok", str({k: (v if k != "results" else len(v)) for k, v in report.items()}))
    return report


class Scheduler(threading.Thread):
    """Optional in-process scheduler (enable in Settings). Cron + `ufcpred tick` is the recommended alternative."""

    def __init__(self, db_path: str | None = None):
        super().__init__(daemon=True)
        self.db_path = db_path
        self.stop = threading.Event()

    def run(self):
        from .db import connect
        while not self.stop.is_set():
            conn = connect(self.db_path)
            try:
                if setting(conn, "lifecycle.scheduler_enabled"):
                    tick(conn)
                interval = float(setting(conn, "lifecycle.scheduler_interval_minutes")) * 60
            except Exception as e:
                interval = 600
                audit(conn, "scheduler.error", "scheduler", None, {"error": str(e)})
                conn.commit()
            finally:
                conn.close()
            self.stop.wait(max(interval, 60))
