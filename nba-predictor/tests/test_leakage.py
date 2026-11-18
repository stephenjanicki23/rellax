"""No future information reaches a prediction."""
import pytest

from nbapred import predict
from nbapred.features.history import HistoryStore, team_state
from nbapred.ingest import record_result


def test_state_ignores_games_on_or_after_the_date(synth):
    conn, truth = synth
    h = HistoryStore.load(conn)
    d = truth["dates"][120]
    team = conn.execute("SELECT id FROM teams LIMIT 1").fetchone()[0]
    st = team_state(h, team, d)
    assert st["last_game_date"] < d
    assert st["n_games"] == sum(1 for x in h.series[team].dates if x < d)


def test_changing_a_future_result_does_not_change_a_past_prediction(trained):
    conn, truth, h, cache, vid, cutoff = trained
    ev = conn.execute("SELECT * FROM events WHERE date>=? ORDER BY date LIMIT 1", (cutoff,)).fetchone()
    ids = predict.predict_event(conn, ev["id"], mode="replay", as_of=ev["date"], reason="before", h=h, cache=cache)
    before = [r["p_home"] for r in conn.execute(f"SELECT p_home FROM predictions WHERE id IN ({','.join(map(str, ids))}) ORDER BY game_id")]
    later = conn.execute("""SELECT g.id, r.home_score, r.away_score FROM games g JOIN events e ON e.id=g.event_id
                            JOIN game_results r ON r.game_id=g.id WHERE e.date>? LIMIT 25""", (ev["date"],)).fetchall()
    for g in later:          # flip every later result
        record_result(conn, g["id"], "win", g["away_score"], g["home_score"], reason="test flip")
    conn.commit()
    h2 = HistoryStore.load(conn)
    ids2 = predict.predict_event(conn, ev["id"], mode="replay", as_of=ev["date"], reason="after", h=h2)
    after = [r["p_home"] for r in conn.execute(f"SELECT p_home FROM predictions WHERE id IN ({','.join(map(str, ids2))}) ORDER BY game_id")]
    assert after == pytest.approx(before, abs=1e-12)


def test_leakage_audit_rejects_states_that_saw_the_game(trained):
    conn, truth, h, cache, vid, cutoff = trained
    from nbapred.models import engine, registry
    from nbapred.features.build import build_rows
    from nbapred.config import ModelConfig
    params = registry.load_params(conn, vid)
    m = next(x for x in h.games.values() if x["date"] > cutoff and x["status"] == "completed")
    cfg = ModelConfig.from_dict(params["config"])
    ok = build_rows(cache, [m], cfg)
    assert engine.leakage_audit(params, ok, m["date"])["passed"]
    later = dict(m, date="2099-01-01", id=-5)          # a state computed as of a much later date…
    bad = build_rows(cache, [later], cfg)
    bad.dates[0] = m["date"]                           # …presented as if it were this game's
    assert not engine.leakage_audit(params, bad, m["date"])["passed"]
