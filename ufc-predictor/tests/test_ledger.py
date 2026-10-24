"""Prediction immutability, locking, versioning and rollback."""
import sqlite3

import pytest

from ufcpred import db, ledger, predict
from ufcpred.models import registry
from ufcpred.util import loads


def _first_event_after(conn, d):
    return conn.execute("SELECT * FROM events WHERE date>=? ORDER BY date LIMIT 1", (d,)).fetchone()


def test_predictions_cannot_be_updated_or_deleted(trained):
    conn, truth, h, cache, vid, cutoff = trained
    ev = _first_event_after(conn, cutoff)
    ids = predict.predict_event(conn, ev["id"], mode="replay", as_of=ev["date"], reason="t", h=h, cache=cache)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("UPDATE predictions SET p_red=0.99 WHERE id=?", (ids[0],))
    with pytest.raises(sqlite3.IntegrityError):
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
    late = predict.predict_event(conn, ev["id"], mode="replay", as_of=ev["date"], reason="late replacement",
                                 h=h, cache=cache, allow_post_lock=True)
    official = {p["id"] for p in ledger.official_predictions(conn, ev["id"], "replay")}
    assert official == set(second)                       # the locked (latest pre-lock) versions are graded
    assert not official & set(late) and not official & set(first)
    rows = conn.execute(f"SELECT is_post_lock, supersedes_id FROM predictions WHERE id IN ({','.join(map(str, late))})").fetchall()
    assert all(r["is_post_lock"] == 1 and r["supersedes_id"] for r in rows)
    with pytest.raises(ledger.LedgerError):
        ledger.lock_event(conn, ev["id"], "replay", ev["date"])


def test_no_prediction_after_event_date_or_with_future_model(trained):
    conn, truth, h, cache, vid, cutoff = trained
    ev = _first_event_after(conn, cutoff)
    with pytest.raises(ledger.LedgerError):
        predict.predict_event(conn, ev["id"], mode="replay", as_of="2100-01-01", reason="t", h=h, cache=cache)
    early = conn.execute("SELECT * FROM events WHERE date<? ORDER BY date DESC LIMIT 1", (cutoff,)).fetchone()
    with pytest.raises(ledger.LedgerError):       # active model was trained on data after this event
        predict.predict_event(conn, early["id"], mode="replay", as_of=early["date"], reason="t", h=h, cache=cache)


def test_live_mode_refuses_fights_with_results(trained):
    conn, truth, h, cache, vid, cutoff = trained
    ev = _first_event_after(conn, cutoff)
    f = dict(conn.execute("SELECT f.*, e.date FROM fights f JOIN events e ON e.id=f.event_id WHERE f.event_id=? LIMIT 1",
                          (ev["id"],)).fetchone())
    with pytest.raises(ledger.LedgerError):
        ledger.record(conn, fight=f, pred={}, model_version_id=vid, mode="live", as_of=ev["date"], reason="x",
                      red_state={}, blue_state={})


def test_tampering_is_detected(trained):
    conn, truth, h, cache, vid, cutoff = trained
    ev = _first_event_after(conn, cutoff)
    ids = predict.predict_event(conn, ev["id"], mode="replay", as_of=ev["date"], reason="t", h=h, cache=cache)
    assert ledger.verify(conn)["ok"]
    conn.execute("DROP TRIGGER trg_predictions_no_update")      # simulate someone bypassing the database guard
    conn.execute("UPDATE predictions SET p_red=0.99, p_blue=0.01 WHERE id=?", (ids[0],))
    v = ledger.verify(conn)
    assert not v["ok"] and ids[0] in v["hash_mismatches"]


def test_snapshots_record_point_in_time_state(trained):
    conn, truth, h, cache, vid, cutoff = trained
    ev = _first_event_after(conn, cutoff)
    ids = predict.predict_event(conn, ev["id"], mode="replay", as_of=ev["date"], reason="t", h=h, cache=cache)
    row = conn.execute("SELECT * FROM predictions WHERE id=?", (ids[0],)).fetchone()
    snap = conn.execute("SELECT * FROM fighter_snapshots WHERE id=?", (row["red_snapshot_id"],)).fetchone()
    st = loads(snap["state_json"])
    assert st["as_of"] <= ev["date"] and (st["last_fight_date"] is None or st["last_fight_date"] < ev["date"])


def test_versioning_and_rollback(trained):
    conn, truth, h, cache, vid, cutoff = trained
    from ufcpred.config import ModelConfig
    from ufcpred.models import engine
    cfg = ModelConfig(half_life_days=270)
    params = engine.fit(h, cfg, truth["dates"][85], cache)
    v2 = registry.save_version(conn, params, cfg, parent_id=vid)
    registry.activate(conn, v2, reason="test")
    assert registry.active_version(conn)["id"] == v2
    assert conn.execute("SELECT status FROM model_versions WHERE id=?", (vid,)).fetchone()[0] == "retired"
    registry.rollback(conn, vid, reason="test rollback")
    assert registry.active_version(conn)["id"] == vid
    dec = conn.execute("SELECT decision FROM promotion_decisions ORDER BY id DESC LIMIT 1").fetchone()[0]
    assert dec == "rollback"
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("DELETE FROM promotion_decisions")
    # corrupted parameters are refused
    conn.execute("UPDATE model_versions SET params_json=replace(params_json, '\"cutoff\"', '\"cutof\"') WHERE id=?", (v2,))
    with pytest.raises(RuntimeError):
        registry.load_params(conn, v2)


def test_persistence_across_restart(trained, tmp_path):
    conn, truth, h, cache, vid, cutoff = trained
    ev = _first_event_after(conn, cutoff)
    predict.predict_event(conn, ev["id"], mode="replay", as_of=ev["date"], reason="t", h=h, cache=cache)
    path = conn.execute("PRAGMA database_list").fetchone()[2]
    n = conn.execute("SELECT COUNT(*) FROM predictions").fetchone()[0]
    conn.close()
    c2 = db.connect(path)                     # re-running migrations is a no-op and keeps history
    assert c2.execute("SELECT COUNT(*) FROM predictions").fetchone()[0] == n
    assert registry.active_version(c2)["id"] == vid
    assert ledger.verify(c2)["ok"]
    bk = db.backup(c2, str(tmp_path / "bk"))
    assert db.verify_backup(bk)["predictions"] == n
    c2.close()
    db.restore(bk, path)
    c3 = db.connect(path)
    assert c3.execute("SELECT COUNT(*) FROM predictions").fetchone()[0] == n
    c3.close()
