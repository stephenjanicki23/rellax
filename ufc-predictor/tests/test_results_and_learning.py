"""Results (draws, NC, cancellations, corrections), promotion rules, reproducibility, full cycle."""
import numpy as np
import pytest

from ufcpred import db, ledger, predict, review, services
from ufcpred.config import DEFAULT_SETTINGS, ModelConfig
from ufcpred.evaluation.backtest import run_backtest
from ufcpred.ingest import ingest_bundle, ingest_manual_results, record_result
from ufcpred.learning import loop, promotion
from ufcpred.models import engine, registry
from ufcpred.providers import manual
from ufcpred.util import dumps, sha256


def _ev_after(conn, d, k=0):
    return conn.execute("SELECT * FROM events WHERE date>=? ORDER BY date LIMIT 1 OFFSET ?", (d, k)).fetchone()


def test_draws_nc_and_canceled_fights_are_excluded_from_winner_metrics(trained):
    conn, truth, h, cache, vid, cutoff = trained
    ev = _ev_after(conn, cutoff)
    fights = conn.execute("SELECT * FROM fights WHERE event_id=? ORDER BY id", (ev["id"],)).fetchall()
    predict.predict_event(conn, ev["id"], mode="replay", as_of=ev["date"], reason="t", h=h, cache=cache)
    ledger.lock_event(conn, ev["id"], "replay", ev["date"])
    record_result(conn, fights[0]["id"], "draw", None, "DRAW", "Split draw", 3, 300, reason="test draw")
    record_result(conn, fights[1]["id"], "nc", None, "NC", "Eye poke", 1, 40, reason="test NC")
    out = review.evaluate_event(conn, ev["id"], "replay")
    assert out["excluded"] >= 2
    scored = conn.execute("SELECT COUNT(*) FROM prediction_evaluations WHERE scored=1").fetchone()[0]
    assert scored == out["graded"] and out["graded"] == len(fights) - out["excluded"]
    perf = services.performance(conn, "replay")
    assert perf["n"] == out["graded"]


def test_result_correction_creates_revision_and_regrades(trained):
    conn, truth, h, cache, vid, cutoff = trained
    ev = _ev_after(conn, cutoff)
    predict.predict_event(conn, ev["id"], mode="replay", as_of=ev["date"], reason="t", h=h, cache=cache)
    ledger.lock_event(conn, ev["id"], "replay", ev["date"])
    review.evaluate_event(conn, ev["id"], "replay")
    before = services.performance(conn, "replay")
    f = conn.execute("""SELECT f.* FROM fights f JOIN fight_results r ON r.fight_id=f.id WHERE f.event_id=?
                        AND r.outcome='win' LIMIT 1""", (ev["id"],)).fetchone()
    res = conn.execute("SELECT * FROM fight_results WHERE fight_id=?", (f["id"],)).fetchone()
    loser = f["blue_fighter_id"] if res["winner_fighter_id"] == f["red_fighter_id"] else f["red_fighter_id"]
    assert record_result(conn, f["id"], "win", loser, "DEC", "overturned on appeal", 3, 300,
                         reason="decision overturned") == "revised"
    assert conn.execute("SELECT MAX(revision) FROM fight_results WHERE fight_id=?", (f["id"],)).fetchone()[0] == 2
    review.regrade_after_correction(conn, f["id"], "replay")
    after = services.performance(conn, "replay")
    assert after["n"] == before["n"]                    # each fight graded once, against the latest revision
    assert after["accuracy"] != before["accuracy"]
    assert conn.execute("SELECT COUNT(*) FROM prediction_evaluations WHERE prediction_id IN (SELECT id FROM predictions "
                        "WHERE fight_id=?)", (f["id"],)).fetchone()[0] == 2   # old evaluation kept for audit
    with pytest.raises(ValueError):
        record_result(conn, f["id"], "win", 999999, "DEC", None, 3, 300)


def _fake_bt(p, y, events, passed=True):
    rows = [{"fight_id": i, "event_id": int(e), "p_red": float(pp), "red_won": int(yy), "p_elo": 0.5, "p_exp": 0.5,
             "p_actual_joint": 0.3, "date": "2020-01-01"} for i, (pp, yy, e) in enumerate(zip(p, y, events))]
    return {"rows": rows, "leakage_audit": {"passed": passed}, "metrics": {}}


def _settings():
    s = dict(DEFAULT_SETTINGS)
    s.update({"promotion.min_eval_fights": 200, "promotion.min_eval_events": 15, "promotion.bootstrap_samples": 300})
    return s


def test_promotion_rules():
    rng = np.random.default_rng(0)
    n, ev = 600, np.repeat(np.arange(40), 15)
    truth = rng.uniform(0.2, 0.8, n)
    y = (rng.random(n) < truth).astype(float)
    weak = np.clip(0.5 + (truth - 0.5) * 0.3, 0.01, 0.99)
    good = np.clip(truth, 0.01, 0.99)
    s = _settings()
    # genuinely better across many events → promote
    res = promotion.compare(_fake_bt(weak, y, ev), _fake_bt(good, y, ev), s)
    assert res["passed"], [c for c in res["criteria"] if not c["passed"]]
    # identical → reject
    assert not promotion.compare(_fake_bt(weak, y, ev), _fake_bt(weak, y, ev), s)["passed"]
    # too few fights → reject even if better
    small = slice(0, 90)
    r2 = promotion.compare(_fake_bt(weak[small], y[small], ev[small]), _fake_bt(good[small], y[small], ev[small]), s)
    assert not r2["passed"] and not next(c for c in r2["criteria"] if c["criterion"] == "sample_size_fights")["passed"]
    # gain confined to one unusual card → reject
    cand = weak.copy()
    one = ev == 7
    cand[one] = np.where(y[one] == 1, 0.97, 0.03)
    r3 = promotion.compare(_fake_bt(weak, y, ev), _fake_bt(cand, y, ev), s)
    assert not r3["passed"] and not next(c for c in r3["criteria"] if c["criterion"] == "not_one_card")["passed"]
    # leakage → reject
    assert not promotion.compare(_fake_bt(weak, y, ev), _fake_bt(good, y, ev, passed=False), s)["passed"]


def test_training_and_backtesting_are_reproducible(synth):
    conn, truth = synth
    from ufcpred.features.history import HistoryStore
    h = HistoryStore.load(conn)
    p1 = engine.fit(h, ModelConfig(), truth["dates"][70])
    p2 = engine.fit(HistoryStore.load(conn), ModelConfig(), truth["dates"][70])
    assert sha256(dumps(p1)) == sha256(dumps(p2))
    b1 = run_backtest(h, ModelConfig(), truth["dates"][60], truth["dates"][80], 6)
    b2 = run_backtest(h, ModelConfig(), truth["dates"][60], truth["dates"][80], 6)
    assert [r["p_red"] for r in b1["rows"]] == [r["p_red"] for r in b2["rows"]]


def test_full_cycle_import_predict_freeze_results_evaluate_learn_predict_next(synth, fresh_db):
    """Integration: a historical card is re-imported as an *upcoming* card (results withheld), then the full loop runs."""
    conn, truth = synth
    from ufcpred.features.build import StateCache
    from ufcpred.features.history import HistoryStore
    # 1. hold out the last two events' results: rebuild a database without them
    settings = [tuple(r) for r in conn.execute("SELECT key, value_json FROM settings").fetchall()]
    c = fresh_db(conn)
    for k, v in settings:
        c.execute("INSERT INTO settings(key, value_json, updated_at) VALUES (?,?,?)", (k, v, "t"))
    from synthetic import make_bundle
    bundle, _ = make_bundle(seed=3)
    held = {e.external_id for e in bundle.events[-2:]}
    held_fights = {f.external_id for f in bundle.fights if f.event_external_id in held}
    hidden_results = [r for r in bundle.results if r.fight_external_id in held_fights]
    bundle.results = [r for r in bundle.results if r.fight_external_id not in held_fights]
    bundle.stats = [s for s in bundle.stats if s.fight_external_id not in held_fights]
    ingest_bundle(c, bundle)
    ev1 = c.execute("SELECT * FROM events WHERE external_id=?", (bundle.events[-2].external_id,)).fetchone()
    ev2 = c.execute("SELECT * FROM events WHERE external_id=?", (bundle.events[-1].external_id,)).fetchone()
    assert ev1["status"] == "scheduled"
    # 2. initial model on data before the card
    h = HistoryStore.load(c)
    v1 = loop.initial_deployment(c, h, ev1["date"], StateCache(h), select_half_life=False)
    # 3. predictions using only pre-fight data, then freeze
    ids = predict.predict_event(c, ev1["id"], mode="live", as_of=ev1["date"], reason="pre-event")
    assert len(ids) == c.execute("SELECT COUNT(*) FROM fights WHERE event_id=?", (ev1["id"],)).fetchone()[0]
    ledger.lock_event(c, ev1["id"], "live", ev1["date"])
    with pytest.raises(ledger.LedgerError):
        predict.predict_event(c, ev1["id"], mode="live", as_of=ev1["date"], reason="overwrite attempt")
    # 4. import official results through the manual (validated) path
    fights = {f.external_id: f for f in bundle.fights}
    lines = ["event_date,red,blue,outcome,winner,method,round,time,source_url"]
    for r in hidden_results:
        f = fights[r.fight_external_id]
        if f.event_external_id != ev1["external_id"]:
            continue
        win = f.red_name if r.winner_corner == "red" else f.blue_name if r.winner_corner == "blue" else ""
        m = r.method if r.outcome == "win" else ""
        lines.append(f"{ev1['date']},{f.red_name},{f.blue_name},{r.outcome},{win},{m},{r.end_round},"
                     f"{r.end_time_sec // 60}:{r.end_time_sec % 60:02d},https://example.org/results")
    out = ingest_manual_results(c, manual.parse_results("\n".join(lines) + "\n", "csv"))
    assert not out["unmatched"]
    # 5. evaluate
    summary = review.evaluate_event(c, ev1["id"], "live")
    assert summary["graded"] > 0 and summary["pending"] == 0
    assert c.execute("SELECT status FROM events WHERE id=?", (ev1["id"],)).fetchone()[0] == "evaluated"
    # 6–8. learning: candidate trained and compared; decision recorded either way
    lr = loop.run_learning(c, ev2["date"], "live", ev1["id"], force=True)
    assert lr["decision"] in ("promote", "refit", "retain", "pending_approval")
    assert c.execute("SELECT COUNT(*) FROM candidate_changes").fetchone()[0] >= 1
    assert c.execute("SELECT COUNT(*) FROM promotion_decisions WHERE decision IN ('reject','promote','refit')").fetchone()[0] >= 1
    assert c.execute("SELECT COUNT(*) FROM analyst_reports").fetchone()[0] == 1
    # 9. predict the later card with the approved model; its results are unknown to the system
    act = registry.active_version(c)
    params = registry.load_params(c, act["id"])
    assert params["max_train_date"] < ev2["date"]
    ids2 = predict.predict_event(c, ev2["id"], mode="live", as_of=ev2["date"], reason="pre-event")
    assert ids2 and ledger.verify(c)["ok"]
    assert c.execute("SELECT COUNT(*) FROM fight_results r JOIN fights f ON f.id=r.fight_id WHERE f.event_id=?",
                     (ev2["id"],)).fetchone()[0] == 0
    c.close()


def test_historical_replay_end_to_end(synth):
    conn, truth = synth
    from ufcpred.replay import replay
    out = replay(conn, truth["dates"][82], truth["dates"][100], select_half_life=False, progress=lambda *_: None)
    assert out["events"] == 18 and out["graded"] > 100
    assert out["correct"] / out["graded"] > 0.55          # synthetic skill is learnable
    assert ledger.verify(conn)["ok"]
    assert conn.execute("SELECT COUNT(*) FROM learning_runs").fetchone()[0] == 18
    decisions = {r[0] for r in conn.execute("SELECT decision FROM promotion_decisions")}
    assert "initial" in decisions and decisions & {"refit", "promote", "reject"}
    perf = services.performance(conn, "replay")
    assert perf["log_loss"] < perf["baselines"]["Coin flip (50/50)"]["log_loss"]
    # every graded replay prediction was made with a model trained strictly before its event
    bad = conn.execute("""SELECT COUNT(*) FROM predictions p JOIN model_versions m ON m.id=p.model_version_id
                          JOIN events e ON e.id=p.event_id WHERE m.training_cutoff > e.date""").fetchone()[0]
    assert bad == 0


def test_manual_approval_mode(trained):
    conn, truth, h, cache, vid, cutoff = trained
    db.set_setting(conn, "promotion.mode", "manual")
    lr = loop.run_learning(conn, truth["dates"][90], "replay", None, h, cache, force=True)
    if lr["decision"] == "pending_approval":
        cc = conn.execute("SELECT id FROM candidate_changes WHERE status='pending_approval'").fetchone()[0]
        assert registry.active_version(conn)["id"] == vid
        new = loop.approve_candidate(conn, cc)
        assert registry.active_version(conn)["id"] == new
    else:
        assert lr["decision"] in ("refit", "retain")
