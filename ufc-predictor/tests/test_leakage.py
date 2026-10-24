"""Historical data leakage and time-based validation."""
import pytest

from ufcpred.config import ModelConfig
from ufcpred.evaluation.backtest import event_folds, run_backtest
from ufcpred.features.build import StateCache, build_rows, training_metas
from ufcpred.features.history import HistoryStore, fighter_state
from ufcpred.models import engine


def _future_mutation(conn, after_date):
    """Flip every result and wipe stats for fights on/after a date."""
    fights = conn.execute("""SELECT f.id, f.red_fighter_id, f.blue_fighter_id FROM fights f JOIN events e ON e.id=f.event_id
                             WHERE e.date>=?""", (after_date,)).fetchall()
    for f in fights:
        r = conn.execute("SELECT * FROM fight_results WHERE fight_id=? ORDER BY revision DESC", (f["id"],)).fetchone()
        if r and r["outcome"] == "win":
            other = f["blue_fighter_id"] if r["winner_fighter_id"] == f["red_fighter_id"] else f["red_fighter_id"]
            conn.execute("INSERT INTO fight_results(fight_id, revision, outcome, winner_fighter_id, method, end_round, "
                         "end_time_sec, reason, recorded_at) VALUES (?,?,?,?,?,?,?,?,?)",
                         (f["id"], r["revision"] + 1, "win", other, "SUB", 1, 30, "test mutation", "t"))
    conn.execute("UPDATE fight_stats SET sig_l=0, td_l=0 WHERE fight_id IN (SELECT f.id FROM fights f JOIN events e "
                 "ON e.id=f.event_id WHERE e.date>=?)", (after_date,))
    conn.commit()


def test_features_ignore_the_fight_itself_and_the_future(synth):
    conn, truth = synth
    cutoff = truth["dates"][70]
    h1 = HistoryStore.load(conn)
    cfg = ModelConfig()
    metas, labels = training_metas(h1, cfg, truth["dates"][71], start=cutoff)   # only the event on `cutoff`
    assert metas
    before = build_rows(StateCache(h1), metas, cfg, None, None, labels)
    _future_mutation(conn, cutoff)       # change the predicted fights' own results/stats and everything later
    h2 = HistoryStore.load(conn)
    after = build_rows(StateCache(h2), metas, cfg, None, None, None)
    for g in before.X:
        assert ((before.X[g] == after.X[g]) | (before.X[g] != before.X[g])).all(), g


def test_state_respects_cutoff_before_fight_date(synth):
    conn, truth = synth
    h = HistoryStore.load(conn)
    fid = next(iter(h.records))
    late = h.records[fid][-1].date
    st = fighter_state(h, fid, late, cutoff=truth["dates"][10])
    assert st["last_fight_date"] is None or st["last_fight_date"] < truth["dates"][10]


def test_fit_uses_only_data_before_cutoff_and_audit_catches_violations(synth):
    conn, truth = synth
    h = HistoryStore.load(conn)
    cutoff = truth["dates"][60]
    params = engine.fit(h, ModelConfig(), cutoff)
    assert params["max_train_date"] < cutoff
    metas, _ = training_metas(h, ModelConfig(), truth["dates"][65], start=cutoff)
    _, ds = engine.predict_metas(params, h, metas, cutoff)
    assert engine.leakage_audit(params, ds, cutoff)["passed"]
    # a decision time earlier than the model's cutoff is a violation
    assert not engine.leakage_audit(params, ds, truth["dates"][50])["passed"]
    # a tampered state that saw the fight itself is caught
    ds.pairs[0][0]["last_fight_date"] = ds.dates[0]
    assert not engine.leakage_audit(params, ds, cutoff)["passed"]


def test_rolling_origin_folds_are_chronological_and_leak_free(synth):
    conn, truth = synth
    h = HistoryStore.load(conn)
    start, end = truth["dates"][60], truth["dates"][84]
    folds = event_folds(h, start, end, 6)
    assert [f[0] for f in folds] == sorted(f[0] for f in folds)
    for (s1, e1, _), (s2, _, _) in zip(folds, folds[1:]):
        assert e1 < s2
    bt = run_backtest(h, ModelConfig(), start, end, 6)
    assert bt["leakage_audit"]["passed"]
    for r in bt["rows"]:
        assert r["train_cutoff"] <= r["date"]
    for f in bt["folds"]:
        assert f["n_train"] > 0


def test_training_rejects_tiny_history(synth):
    conn, truth = synth
    with pytest.raises(ValueError):
        engine.fit(HistoryStore.load(conn), ModelConfig(), truth["dates"][5])
