"""Game-night lifecycle: schedule → preliminary predictions → lock → results → evaluation → learning.

`tick()` runs every due step once and is safe to call repeatedly (cron, the in-process scheduler, or the
Settings screen's "Run now" button). A step that cannot run because a provider is unreachable or not
configured is reported as such, never faked.
"""
from __future__ import annotations

import datetime as dt
import threading

from . import betting, ledger, predict, review
from .config import setting
from .db import audit, flag_issue
from .ingest import games_missing_box, ingest_bundle, store_stats
from .learning import loop
from .providers.base import Bundle, ProviderError
from .util import utcnow


def _job(conn, name: str):
    cur = conn.execute("INSERT INTO job_runs(job, started_at, status) VALUES (?,?,?)", (name, utcnow(), "running"))
    conn.commit()
    return cur.lastrowid


def _finish(conn, jid: int, status: str, message: str):
    conn.execute("UPDATE job_runs SET finished_at=?, status=?, message=? WHERE id=?", (utcnow(), status, message[:2000], jid))
    conn.commit()


def historical_provider(conn):
    from .providers.nba_mirror import NBAMirrorProvider
    return NBAMirrorProvider(base_url=setting(conn, "providers.nba_mirror.base_url"))


def hoopr(conn):
    from .providers.hoopr import HoopRProvider
    return HoopRProvider(min_interval_s=float(setting(conn, "providers.min_request_interval_s")))


def recent_provider(conn, name: str | None = None):
    """The provider for seasons after the mirror and for upcoming games: hoopr (default) or espn."""
    return espn(conn) if (name or setting(conn, "providers.recent")) == "espn" else hoopr(conn)


def espn(conn):
    from .providers.espn import ESPNProvider
    return ESPNProvider(min_interval_s=float(setting(conn, "providers.min_request_interval_s")))


def _fail(conn, jid, provider: str, e: Exception) -> dict:
    flag_issue(conn, "source", provider, "source_failure", str(e), "error")
    conn.commit()
    _finish(conn, jid, "error", str(e))
    return {"error": str(e), "config_required": getattr(e, "config_required", "")}


def refresh_history(conn, progress=None, force_mirror: bool = False) -> dict:
    """Mirror seasons (2010-11 → 2023-24) plus later seasons from ESPN, then missing box scores."""
    jid = _job(conn, "refresh_history")
    out = {}
    week_ago = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=7)).isoformat(timespec="seconds")
    fresh = conn.execute("""SELECT 1 FROM data_sources WHERE provider='nba_mirror' AND status IN ('ok','cached')
                            AND retrieved_at>=? LIMIT 1""", (week_ago,)).fetchone()
    has_games = conn.execute("SELECT 1 FROM games WHERE external_id LIKE 'nba:%' LIMIT 1").fetchone()
    if fresh and has_games and not force_mirror:
        out["mirror"] = {"skipped": "mirror seasons (2010-11 → 2023-24) already loaded this week"}
    else:
        try:
            out["mirror"] = ingest_bundle(conn, historical_provider(conn).fetch_history())
        except (ProviderError, OSError) as e:
            out["mirror"] = _fail(conn, jid, "nba_mirror", e)
            jid = _job(conn, "refresh_history")
    if setting(conn, "providers.recent") in ("espn", "hoopr"):
        out["recent"] = refresh_recent(conn, progress)
        if setting(conn, "providers.recent") == "espn":     # hoopr already carries full box scores
            out["box_scores"] = refresh_boxes(conn)
    _finish(conn, jid, "ok" if not any("error" in (v or {}) for v in out.values()) else "partial", str(out))
    return out


def refresh_recent(conn, progress=None) -> dict:
    """Results and box scores for every date from `providers.espn.backfill_from` (resuming where the database
    ends), from the hoopR mirror (default) or ESPN directly."""
    jid = _job(conn, "refresh_recent")
    today = utcnow()[:10]
    start = setting(conn, "providers.espn.backfill_from")
    have = conn.execute("""SELECT MAX(e.date) FROM games g JOIN events e ON e.id=g.event_id
                           WHERE g.external_id LIKE 'espn:%' AND g.status='completed'""").fetchone()[0]
    if have and have > start:
        start = (dt.date.fromisoformat(have) - dt.timedelta(days=3)).isoformat()
    end = (dt.date.fromisoformat(today) - dt.timedelta(days=1)).isoformat()
    if start > end:
        _finish(conn, jid, "skipped", "up to date")
        return {"skipped": "up to date"}
    try:
        prov = recent_provider(conn)
        b = prov.fetch_range(start, end, today, progress) if prov.name == "espn" else prov.fetch_range(start, end, today)
    except ProviderError as e:
        return _fail(conn, jid, setting(conn, "providers.recent"), e)
    out = ingest_bundle(conn, b)
    out["dates"] = f"{start} → {end}"
    _finish(conn, jid, "ok", str(out))
    return out


def refresh_boxes(conn, limit: int | None = None) -> dict:
    """Full team box scores (offensive rebounds, turnovers…) for completed ESPN games that lack them."""
    if setting(conn, "providers.recent") != "espn":
        return {"skipped": "box scores come with the hoopR mirror"}
    limit = int(limit or setting(conn, "providers.espn.max_box_fetch"))
    todo = games_missing_box(conn, limit)
    if not todo:
        return {"skipped": "no games missing box scores"}
    jid = _job(conn, "refresh_boxes")
    prov, stats, fetched, failed = espn(conn), [], 0, 0
    for g in todo:
        try:
            rows, _ = prov.fetch_box(g["external_id"])
        except ProviderError as e:
            failed += 1
            if failed >= 5:
                flag_issue(conn, "source", "espn_summary", "source_failure", str(e), "warning")
                break
            continue
        stats.extend(rows)
        fetched += 1
    games = {r["external_id"]: r for r in conn.execute(
        "SELECT id, external_id, home_team_id, away_team_id FROM games WHERE external_id LIKE 'espn:%'")}
    n = store_stats(conn, stats, games)
    conn.commit()
    out = {"requested": len(todo), "fetched": fetched, "failed": failed, "rows": n}
    _finish(conn, jid, "ok", str(out))
    return out


def refresh_upcoming(conn) -> dict:
    jid = _job(conn, "refresh_upcoming")
    if setting(conn, "providers.upcoming") not in ("espn", "hoopr"):
        msg = ("no automatic schedule provider configured (providers.upcoming=manual): import the night with "
               "templates/import/night_template.json")
        _finish(conn, jid, "skipped", msg)
        return {"skipped": msg}
    try:
        b = recent_provider(conn, setting(conn, "providers.upcoming")).fetch_upcoming(
            int(setting(conn, "providers.espn.days_ahead")))
    except ProviderError as e:
        return _fail(conn, jid, setting(conn, "providers.upcoming"), e)
    if setting(conn, "providers.odds") != "espn":
        b.odds = []
    out = ingest_bundle(conn, b, reconcile_nights=True)
    _finish(conn, jid, "ok", str(out))
    return out


def refresh_odds(conn, force: bool = False) -> dict:
    """Store current lines from The Odds API for unplayed games. Comparison only: the engine never reads them."""
    from .ingest import store_odds
    from .providers.odds import TheOddsAPIProvider
    if setting(conn, "providers.odds") != "the_odds_api":
        return {"skipped": f"odds provider is {setting(conn, 'providers.odds')}"}
    import os
    if not os.environ.get("ODDS_API_KEY"):
        return {"skipped": "ODDS_API_KEY is not set: add it as a repository secret (GitHub Actions) to track lines"}
    hours = float(setting(conn, "providers.odds.min_interval_hours"))
    since = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=hours)).isoformat(timespec="seconds")
    if not force and conn.execute("SELECT 1 FROM job_runs WHERE job='refresh_odds' AND status='ok' AND started_at>=?",
                                  (since,)).fetchone():
        return {"skipped": f"lines were fetched less than {hours:g} hours ago (API credit budget)"}
    jid = _job(conn, "refresh_odds")
    rows = conn.execute(
        """SELECT g.id, th.name AS home_name, ta.name AS away_name FROM games g JOIN events e ON e.id=g.event_id
           JOIN teams th ON th.id=g.home_team_id JOIN teams ta ON ta.id=g.away_team_id
           WHERE e.date>=? AND g.status='scheduled'
             AND NOT EXISTS (SELECT 1 FROM game_results r WHERE r.game_id=g.id)""",
        ((dt.date.fromisoformat(utcnow()[:10]) - dt.timedelta(days=1)).isoformat(),)).fetchall()
    if not rows:
        _finish(conn, jid, "skipped", "no upcoming games")
        return {"skipped": "no upcoming games"}
    books = [b.strip() for b in str(setting(conn, "providers.odds.bookmakers") or "").split(",") if b.strip()]
    prov = TheOddsAPIProvider(bookmakers=books, markets=str(setting(conn, "providers.odds.markets")))
    games = [{"external_id": str(r["id"]), "home_name": r["home_name"], "away_name": r["away_name"]} for r in rows]
    try:
        b: Bundle = prov.fetch_odds(games)
    except ProviderError as e:
        return _fail(conn, jid, prov.name, e)
    now = utcnow()
    stored = sum(1 for o in b.odds if store_odds(conn, int(o.game_external_id), prov.name, o.bookmaker, o, now))
    out = {"games": len(games), "games_with_odds": len({o.game_external_id for o in b.odds}), "stored": stored,
           "bookmakers_requested": books or ["all US"], "bookmakers_seen": sorted(prov.seen_bookmakers)}
    audit(conn, "odds.refresh", "odds", None, out)
    conn.commit()
    _finish(conn, jid, "ok", str(out))
    return out


def lock_time(conn, ev) -> str:
    mins = float(setting(conn, "lifecycle.lock_minutes_before"))
    if ev["start_time_utc"]:
        start = dt.datetime.fromisoformat(ev["start_time_utc"].replace("Z", "+00:00"))
    else:
        # unknown tip-off: assume the earliest NBA start (noon Eastern, 16:00 UTC) — conservative
        start = dt.datetime.fromisoformat(ev["date"] + "T16:00:00+00:00")
    return (start - dt.timedelta(minutes=mins)).isoformat()


def predict_upcoming(conn, reason: str = "preliminary (scheduled refresh)") -> list:
    """Predict scheduled games that have no prediction yet today, or whose model has changed since."""
    from .models import registry
    out = []
    now = utcnow()
    act = registry.active_version(conn)
    for ev in conn.execute("SELECT * FROM events WHERE status='scheduled' AND date>=? ORDER BY date",
                           (now[:10],)).fetchall():
        if now >= lock_time(conn, ev):
            continue
        as_of = min(now[:10], ev["date"])
        stale = [g["id"] for g in predict.eligible_games(conn, ev["id"], "live")
                 if not conn.execute("""SELECT 1 FROM predictions WHERE game_id=? AND mode='live' AND as_of=?
                                        AND model_version_id=? AND version=(SELECT MAX(version) FROM predictions
                                        WHERE game_id=? AND mode='live')""",
                                     (g["id"], as_of, act["id"] if act else -1, g["id"])).fetchone()]
        if not stale:
            continue
        try:
            ids = predict.predict_event(conn, ev["id"], mode="live", reason=reason, game_ids=stale)
            out.append({"event_id": ev["id"], "predictions": len(ids)})
        except (ledger.LedgerError, RuntimeError, ValueError) as e:
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
            if ev["date"] >= (dt.date.fromisoformat(now[:10]) - dt.timedelta(days=2)).isoformat():
                conn.execute("UPDATE events SET status='missed_lock', updated_at=? WHERE id=?", (now, ev["id"]))
                audit(conn, "event.missed_lock", "event", ev["id"],
                      {"note": "no predictions existed before the lock time; none will be created after it"})
                conn.commit()
                out.append({"event_id": ev["id"], "status": "missed_lock"})
        else:
            out.append(ledger.lock_event(conn, ev["id"], "live", now[:10], "automatic pre-tip-off lock"))
    return out


def process_results(conn) -> list:
    out = []
    for ev in conn.execute("""SELECT * FROM events WHERE status IN ('locked','completed') AND EXISTS
                              (SELECT 1 FROM prediction_locks l WHERE l.event_id=events.id AND l.mode='live')
                              ORDER BY date""").fetchall():
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
    report["odds"] = refresh_odds(conn)
    report["locks"] = lock_due(conn)
    report["predictions"] = predict_upcoming(conn)
    report["results"] = process_results(conn)
    try:   # simulated-bet tracking reads picks/odds/results; it never feeds the engine and never blocks the tick
        report["bets"] = betting.sync(conn)
    except Exception as e:
        report["bets"] = {"error": f"{type(e).__name__}: {e}"}
    _finish(conn, jid, "ok", str({k: (v if k != "results" else len(v)) for k, v in report.items()}))
    return report


class Scheduler(threading.Thread):
    """Optional in-process scheduler (enable in Settings). Cron + `nbapred tick` is the recommended alternative."""

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
