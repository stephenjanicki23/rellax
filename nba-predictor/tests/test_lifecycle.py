"""Lifecycle: lock timing, no duplicate preliminary versions, missed locks, live grading."""
import json

from nbapred import lifecycle, predict
from nbapred.ingest import ingest_bundle
from nbapred.providers import manual


def _night(conn, date, tip=None):
    card = {"night": {"date": date, "source_url": "https://example.org"},
            "games": [{"home": "BOS", "away": "MIA", "tip_time_utc": tip}]}
    ingest_bundle(conn, manual.parse_card(json.dumps(card)))
    return conn.execute("SELECT * FROM events WHERE date=?", (date,)).fetchone()


def test_lock_time_uses_first_tip_or_noon_eastern(tmp_db):
    ev = _night(tmp_db, "2099-03-01", "2099-03-02T00:30:00Z")
    assert lifecycle.lock_time(tmp_db, ev).startswith("2099-03-02T00:00")        # 30 minutes before tip-off
    ev2 = _night(tmp_db, "2099-03-03")
    assert lifecycle.lock_time(tmp_db, ev2).startswith("2099-03-03T15:30")       # unknown: noon ET − 30 min


def test_predict_upcoming_does_not_repeat_unchanged_predictions(trained):
    conn = trained[0]
    _night(conn, "2099-03-01", "2099-03-02T00:30:00Z")
    first = lifecycle.predict_upcoming(conn)
    assert first and first[0]["predictions"] == 1
    assert lifecycle.predict_upcoming(conn) == []
    n = conn.execute("SELECT COUNT(*) FROM predictions WHERE mode='live'").fetchone()[0]
    assert n == 1


def test_past_night_without_predictions_becomes_missed_lock(tmp_db):
    from nbapred.util import utcnow
    import datetime as dt
    today = utcnow()[:10]
    yesterday = (dt.date.fromisoformat(today) - dt.timedelta(days=1)).isoformat()
    _night(tmp_db, yesterday, yesterday + "T23:00:00Z")
    out = lifecycle.lock_due(tmp_db)
    assert out and out[0]["status"] == "missed_lock"


def test_upcoming_without_provider_is_reported_not_faked(tmp_db):
    from nbapred import db
    db.set_setting(tmp_db, "providers.upcoming", "manual")
    assert "skipped" in lifecycle.refresh_upcoming(tmp_db)
    assert "skipped" in lifecycle.refresh_odds(tmp_db)
