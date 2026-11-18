"""Prediction immutability, locking, versioning and rollback."""
import pytest

from nbapred import db, ledger, predict
from nbapred.models import registry
from conftest import PG_URL


def _first_event_after(conn, d):
    return conn.execute("SELECT * FROM events WHERE date>=? ORDER BY date LIMIT 1", (d,)).fetchone()


def test_predictions_cannot_be_updated_or_deleted(trained):
    conn, truth, h, cache, vid, cutoff = trained
    ev = _first_event_after(conn, cutoff)
    ids = predict.predict_event(conn, ev["id"], mode="replay", as_of=ev["date"], reason="t", h=h, cache=cache)
    with pytest.raises(db.IntegrityError):
        conn.execute("UPDATE predictions SET p_home=0.99 WHERE id=?", (ids[0],))
    conn.rollback()
    with pytest.raises(db.IntegrityError):
        conn.execute("DELETE FROM predictions WHERE id=?", (ids[0],))
    conn.rollback()
    assert ledger.verify(conn)["ok"]


def test_lock_blocks_overwrite_and_post_lock_versions_are_separate(trained):
    conn, truth, h, cache, vid, cutoff = trained
    ev = _first_event_after(conn, cutoff)
    first = predict.predict_event(conn, ev["id"], mode="replay", as_of=ev["date"], reason="preliminary", h=h, cache=cache)
    second = predict.predict_event(conn, ev["id"], mode="replay", as_of=ev["date"], reason="refresh", h=h, cache=cache)
    ledger.lock_event(conn, ev["id"], "replay", ev["date"])
    with pytest.raises(ledger.LedgerError):
        predict.predict_event(conn, ev["id"], mode="replay", as_of=ev["date"], reason="sneaky", h=h, cache=cache)
    late = predict.predict_event(conn, ev["id"], mode="replay", as_of=ev["date"], reason="injury news",
                                 h=h, cache=cache, allow_post_lock=True)
    official = {p["id"] for p in ledger.official_predictions(conn, ev["id"], "replay")}
    assert official == set(second)
    assert not official & set(late) and not official & set(first)
    rows = conn.execute(f"SELECT is_post_lock, supersedes_id FROM predictions WHERE id IN ({','.join(map(str, late))})").fetchall()
    assert all(r["is_post_lock"] == 1 and r["supersedes_id"] for r in rows)
    with pytest.raises(ledger.LedgerError):
        ledger.lock_event(conn, ev["id"], "replay", ev["date"])


def test_no_prediction_after_game_date_or_with_future_model(trained):
    conn, truth, h, cache, vid, cutoff = trained
    ev = _first_event_after(conn, cutoff)
    with pytest.raises(ledger.LedgerError):
        predict.predict_event(conn, ev["id"], mode="replay", as_of="2100-01-01", reason="t", h=h, cache=cache)
    early = conn.execute("SELECT * FROM events WHERE date<? ORDER BY date DESC LIMIT 1", (cutoff,)).fetchone()
    with pytest.raises(ledger.LedgerError):
        predict.predict_event(conn, early["id"], mode="replay", as_of=early["date"], reason="t", h=h, cache=cache)


def test_live_mode_refuses_games_with_results(trained):
    conn, truth, h, cache, vid, cutoff = trained
    ev = _first_event_after(conn, cutoff)
    g = dict(conn.execute("SELECT g.*, e.date FROM games g JOIN events e ON e.id=g.event_id WHERE g.event_id=? LIMIT 1",
                          (ev["id"],)).fetchone())
    with pytest.raises(ledger.LedgerError):
        ledger.record(conn, game=g, pred={}, model_version_id=vid, mode="live", as_of=ev["date"], reason="x",
                      home_state={}, away_state={})


def test_tampering_is_detected(trained):
    conn, truth, h, cache, vid, cutoff = trained
    ev = _first_event_after(conn, cutoff)
    ids = predict.predict_event(conn, ev["id"], mode="replay", as_of=ev["date"], reason="t", h=h, cache=cache)
    assert ledger.verify(conn)["ok"]
    conn.execute("DROP TRIGGER trg_predictions_append_only ON predictions" if PG_URL else
                 "DROP TRIGGER trg_predictions_no_update")
    conn.execute("UPDATE predictions SET p_home=0.99, p_away=0.01 WHERE id=?", (ids[0],))
    v = ledger.verify(conn)
    assert not v["ok"] and ids[0] in v["hash_mismatches"]


def test_snapshots_record_point_in_time_state(trained):
    conn, truth, h, cache, vid, cutoff = trained
    ev = _first_event_after(conn, cutoff)
    ids = predict.predict_event(conn, ev["id"], mode="replay", as_of=ev["date"], reason="t", h=h, cache=cache)
    row = conn.execute("""SELECT s.state_json FROM predictions p JOIN team_snapshots s ON s.id=p.home_snapshot_id
                          WHERE p.id=?""", (ids[0],)).fetchone()
    from nbapred.util import loads
    st = loads(row["state_json"])
    assert st["last_game_date"] < ev["date"] and st["as_of"] == ev["date"]


def test_rollback_reactivates_a_previous_version(trained):
    conn, truth, h, cache, vid, cutoff = trained
    from nbapred.config import ModelConfig
    from nbapred.learning.loop import _fit_and_save
    v2, _ = _fit_and_save(conn, h, ModelConfig(train_start="2000-01-01", half_life_days=15), cutoff, cache, parent_id=vid)
    registry.activate(conn, v2)
    assert registry.active_version(conn)["id"] == v2
    registry.rollback(conn, vid, reason="test")
    assert registry.active_version(conn)["id"] == vid
    assert conn.execute("SELECT decision FROM promotion_decisions ORDER BY id DESC LIMIT 1").fetchone()[0] == "rollback"
