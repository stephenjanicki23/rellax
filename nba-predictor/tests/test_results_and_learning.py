"""Grading, result corrections, promotion rules, reproducibility, the full lifecycle and the replay."""
import json

import numpy as np

from nbapred import db, ledger, predict, review, services
from nbapred.config import DEFAULT_SETTINGS
from nbapred.ingest import ingest_bundle, ingest_manual_results, record_result
from nbapred.learning import promotion
from nbapred.models import registry
from nbapred.providers import manual


def _ev_after(conn, d, k=0):
    return conn.execute("SELECT * FROM events WHERE date>=? ORDER BY date LIMIT 1 OFFSET ?", (d, k)).fetchone()


def test_grading_scores_winner_margin_total_and_band(trained):
    conn, truth, h, cache, vid, cutoff = trained
    ev = _ev_after(conn, cutoff)
    predict.predict_event(conn, ev["id"], mode="replay", as_of=ev["date"], reason="t", h=h, cache=cache)
    ledger.lock_event(conn, ev["id"], "replay", ev["date"])
    out = review.evaluate_event(conn, ev["id"], "replay")
    n = conn.execute("SELECT COUNT(*) FROM games WHERE event_id=?", (ev["id"],)).fetchone()[0]
    assert out["graded"] == n and out["pending"] == 0
    e = conn.execute("SELECT * FROM prediction_evaluations LIMIT 1").fetchone()
    p = conn.execute("SELECT * FROM predictions WHERE id=?", (e["prediction_id"],)).fetchone()
    r = conn.execute("SELECT * FROM game_results WHERE id=?", (e["result_id"],)).fetchone()
    assert abs(e["margin_error"] - ((r["home_score"] - r["away_score"]) - p["predicted_margin"])) < 1e-9
    assert e["ats_correct"] is None                         # no market line stored → no ATS grade
    perf = services.performance(conn, "replay")
    assert perf["n"] == out["graded"] and perf["margin_mae"] > 0 and set(perf["bands"]) == {"CLOSE", "SOLID", "BLOWOUT"}


def test_result_correction_creates_revision_and_regrades(trained):
    conn, truth, h, cache, vid, cutoff = trained
    ev = _ev_after(conn, cutoff)
    predict.predict_event(conn, ev["id"], mode="replay", as_of=ev["date"], reason="t", h=h, cache=cache)
    ledger.lock_event(conn, ev["id"], "replay", ev["date"])
    review.evaluate_event(conn, ev["id"], "replay")
    before = services.performance(conn, "replay")
    g = conn.execute("SELECT * FROM games WHERE event_id=? LIMIT 1", (ev["id"],)).fetchone()
    r = conn.execute("SELECT * FROM game_results WHERE game_id=?", (g["id"],)).fetchone()
    assert record_result(conn, g["id"], "win", r["away_score"], r["home_score"], reason="stat correction") == "revised"
    conn.commit()
    review.regrade_after_correction(conn, g["id"], "replay")
    after = services.performance(conn, "replay")
    assert after["n"] == before["n"]
    assert after["accuracy"] != before["accuracy"]
    assert conn.execute("SELECT COUNT(*) FROM prediction_evaluations e JOIN predictions p ON p.id=e.prediction_id "
                        "WHERE p.game_id=?", (g["id"],)).fetchone()[0] == 2     # the old grade is kept


def _fake_bt(p, y, events, passed=True):
    rows = [{"game_id": i, "event_id": int(e), "p_home": float(pp), "home_won": int(yy), "p_elo": 0.5, "p_base": 0.5,
             "p_band_joint": 0.3, "pred_margin": 0.0, "actual_margin": 1, "pred_total": 220.0, "actual_total": 221,
             "date": "2020-01-01"} for i, (pp, yy, e) in enumerate(zip(p, y, events))]
    return {"rows": rows, "leakage_audit": {"passed": passed}, "metrics": {}}


def _settings():
    s = dict(DEFAULT_SETTINGS)
    s.update({"promotion.min_eval_games": 200, "promotion.min_eval_events": 15, "promotion.bootstrap_samples": 300})
    return s


def test_promotion_rules():
    rng = np.random.default_rng(0)
    n, ev = 600, np.repeat(np.arange(40), 15)
    truth = rng.uniform(0.2, 0.8, n)
    y = (rng.random(n) < truth).astype(float)
    weak = np.clip(0.5 + (truth - 0.5) * 0.3, 0.01, 0.99)
    good = np.clip(truth, 0.01, 0.99)
    s = _settings()
    res = promotion.compare(_fake_bt(weak, y, ev), _fake_bt(good, y, ev), s)
    assert res["passed"], [c for c in res["criteria"] if not c["passed"]]
    assert not promotion.compare(_fake_bt(weak, y, ev), _fake_bt(weak, y, ev), s)["passed"]
    small = slice(0, 90)
    r2 = promotion.compare(_fake_bt(weak[small], y[small], ev[small]), _fake_bt(good[small], y[small], ev[small]), s)
    assert not r2["passed"] and not next(c for c in r2["criteria"] if c["criterion"] == "sample_size_games")["passed"]
    cand = weak.copy()
    one = ev == 7
    cand[one] = np.where(y[one] == 1, 0.97, 0.03)
    r3 = promotion.compare(_fake_bt(weak, y, ev), _fake_bt(cand, y, ev), s)
    assert not r3["passed"] and not next(c for c in r3["criteria"] if c["criterion"] == "not_one_night")["passed"]
    assert not promotion.compare(_fake_bt(weak, y, ev), _fake_bt(good, y, ev, passed=False), s)["passed"]


def test_total_points_metric_is_paired():
    rng = np.random.default_rng(1)
    n, ev = 600, np.repeat(np.arange(40), 15)
    y = (rng.random(n) < 0.6).astype(float)
    p = np.full(n, 0.6)
    actual = rng.normal(220, 18, n).round()
    inc, cand = _fake_bt(p, y, ev), _fake_bt(p, y, ev)
    for i, r in enumerate(inc["rows"]):
        r["actual_total"], r["pred_total"] = actual[i], 210.0
    for i, r in enumerate(cand["rows"]):
        r["actual_total"], r["pred_total"] = actual[i], 220.0
    res = promotion.compare(inc, cand, _settings(), "total_mae")
    assert res["paired"]["mean_delta"] > 0 and res["paired"]["p_candidate_better"] > 0.95


def test_training_and_backtesting_are_reproducible(synth):
    conn, truth = synth
    from nbapred.config import ModelConfig
    from nbapred.evaluation.backtest import run_backtest
    from nbapred.features.build import StateCache
    from nbapred.features.history import HistoryStore
    from nbapred.models import engine
    from nbapred.util import dumps, sha256
    cfg = ModelConfig(train_start="2000-01-01")
    h = HistoryStore.load(conn)
    p1 = engine.fit(h, cfg, truth["dates"][150], StateCache(h))
    p2 = engine.fit(HistoryStore.load(conn), cfg, truth["dates"][150])
    assert sha256(dumps(p1)) == sha256(dumps(p2))
    b1 = run_backtest(h, cfg, truth["dates"][150], truth["dates"][170], 10)
    b2 = run_backtest(h, cfg, truth["dates"][150], truth["dates"][170], 10)
    assert [r["p_home"] for r in b1["rows"]] == [r["p_home"] for r in b2["rows"]] and b1["leakage_audit"]["passed"]


def test_full_cycle_import_predict_lock_results_evaluate_learn(synth, fresh_db):
    conn, truth = synth
    from nbapred.config import ModelConfig
    from nbapred.features.history import HistoryStore
    from nbapred.learning.loop import initial_deployment, run_learning
    initial_deployment(conn, HistoryStore.load(conn), "2019-06-01", cfg=ModelConfig(train_start="2000-01-01"),
                       select_half_life=False)
    card = {"night": {"date": "2019-06-05", "source_url": "https://example.org"},
            "games": [{"home": "BOS", "away": "MIA"}, {"home": "LAL", "away": "DEN", "away_out": 1}]}
    ingest_bundle(conn, manual.parse_card(json.dumps(card)))
    ev = conn.execute("SELECT * FROM events WHERE date='2019-06-05'").fetchone()
    assert ev["status"] == "scheduled"
    ids = predict.predict_event(conn, ev["id"], mode="live", reason="preliminary", as_of="2019-06-05")
    assert len(ids) == 2
    ledger.lock_event(conn, ev["id"], "live", "2019-06-05")
    res = manual.parse_results("date,home,away,home_score,away_score,source_url\n"
                               "2019-06-05,BOS,MIA,112,104,https://nba.com\n2019-06-05,LAL,DEN,99,120,https://nba.com\n")
    assert not ingest_manual_results(conn, res)["unmatched"]
    s = review.evaluate_event(conn, ev["id"], "live")
    assert s["graded"] == 2 and s["pending"] == 0
    assert conn.execute("SELECT status FROM events WHERE id=?", (ev["id"],)).fetchone()[0] == "evaluated"
    lr = run_learning(conn, "2019-06-06", "live", ev["id"], force=True)
    assert lr["decision"] in ("promote", "refit", "retain", "pending_approval")
    assert conn.execute("SELECT COUNT(*) FROM analyst_reports").fetchone()[0] == 1
    assert ledger.verify(conn)["ok"]


def test_historical_replay_end_to_end(synth):
    conn, truth = synth
    from nbapred.replay import replay
    out = replay(conn, truth["dates"][150], truth["dates"][175], select_half_life=False, progress=lambda *_: None)
    assert out["events"] == 25 and out["graded"] == 250
    assert out["correct"] / out["graded"] > 0.58
    assert ledger.verify(conn)["ok"]
    decisions = {r[0] for r in conn.execute("SELECT decision FROM promotion_decisions")}
    assert "initial" in decisions and decisions & {"refit", "promote", "reject", "retain"}
    perf = services.performance(conn, "replay")
    assert perf["log_loss"] < perf["baselines"]["Coin flip (50/50)"]["log_loss"]


def test_manual_approval_mode(trained):
    conn, truth, h, cache, vid, cutoff = trained
    from nbapred.learning.loop import approve_candidate, run_learning
    db.set_setting(conn, "promotion.mode", "manual")
    lr = run_learning(conn, truth["dates"][175], "replay", None, h, cache, force=True)
    pending = [c for c in lr["candidates"] if c["status"] == "pending_approval"]
    if pending:
        assert registry.active_version(conn)["id"] == vid
        new = approve_candidate(conn, pending[0]["id"])
        assert registry.active_version(conn)["id"] == new
    else:
        assert lr["decision"] in ("refit", "retain")
