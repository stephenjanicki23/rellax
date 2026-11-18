"""Model Lab: alternative models are scored on graded fights for tracking only; the engine is untouched."""
import pytest
from fastapi.testclient import TestClient

from ufcpred import model_lab


def _replayed(synth):
    conn, truth = synth
    from ufcpred.replay import replay
    replay(conn, truth["dates"][82], truth["dates"][86], select_half_life=False, progress=lambda *_: None)
    return conn


def test_model_probs_reads_each_submodel_from_the_payload():
    payload = {"p_red": 0.61, "submodels": {"A_baseline": 0.7, "B_form": 0.4, "C_style": 0.55, "D_durability": 0.5},
               "baselines": {"elo_only_p_red": 0.58}}
    assert model_lab.model_probs(payload, 0.61) == {"p_engine": 0.61, "p_elo": 0.58, "p_ratings": 0.7,
                                                    "p_form": 0.4, "p_style": 0.55, "p_durability": 0.5}
    assert model_lab.model_probs({}, None)["p_ratings"] is None


def test_scores_and_verdict_need_enough_fights_and_a_clear_gap():
    rows = [{"p_engine": 0.6, "p_ratings": 0.9, "red_won": 1, "red_decimal": 2.0, "blue_decimal": 1.8}] * 60 + \
           [{"p_engine": 0.6, "p_ratings": 0.9, "red_won": 0, "red_decimal": 2.0, "blue_decimal": 1.8}] * 2
    s = model_lab.score(rows, "ratings")
    assert s["n"] == 62 and s["accuracy"] == pytest.approx(60 / 62) and s["vs_engine"] > 0
    assert s["flat_n"] == 62 and s["flat_pl"] == pytest.approx(60 * 50 - 2 * 50)
    assert model_lab.verdict(s, 50) == "better" and model_lab.verdict(s, 100) == "too few"
    e = model_lab.score(rows, "engine")
    assert "vs_engine" not in e and e["accuracy"] == pytest.approx(60 / 62)
    assert model_lab.score([], "style") == {"n": 0}


def test_sync_scores_every_graded_prediction_once_and_leaves_the_engine_alone(synth):
    conn = _replayed(synth)
    before = tuple(conn.execute("SELECT COUNT(*), SUM(p_red) FROM predictions").fetchone())
    models = [tuple(r) for r in conn.execute("SELECT * FROM model_versions ORDER BY id").fetchall()]
    graded = conn.execute("SELECT COUNT(DISTINCT prediction_id) FROM prediction_evaluations e JOIN fight_results r "
                          "ON r.id=e.result_id WHERE e.scored=1 AND r.outcome='win'").fetchone()[0]
    out = model_lab.sync(conn)
    assert out["added"] == graded > 0
    assert model_lab.sync(conn) == {"added": 0, "refreshed": 0, "skipped": 0}       # idempotent
    rows = model_lab.rows(conn)
    assert len(rows) == graded and all(r["p_ratings"] is not None and r["p_style"] is not None for r in rows)
    # the engine column matches the engine's own grading
    acc = conn.execute("SELECT AVG(correct_winner) FROM prediction_evaluations WHERE scored=1").fetchone()[0]
    assert model_lab.score(rows, "engine")["accuracy"] == pytest.approx(float(acc), abs=0.02)
    rep = model_lab.report(conn)
    assert rep["n"] == graded and {o["key"] for o in rep["overall"]} == {k for k, *_ in model_lab.MODELS}
    assert sum(g["n"] for g in rep["splits"][0]["rows"]) == graded
    assert tuple(conn.execute("SELECT COUNT(*), SUM(p_red) FROM predictions").fetchone()) == before
    assert [tuple(r) for r in conn.execute("SELECT * FROM model_versions ORDER BY id").fetchall()] == models


def test_model_lab_page_renders_empty_and_full(synth):
    conn = _replayed(synth)
    from ufcpred.web.app import app
    c = TestClient(app)
    r = c.get("/lab")
    assert r.status_code == 200 and "No graded fights yet" in r.text
    model_lab.sync(conn)
    for url in ("/lab", "/lab?mode=replay", "/lab?mode=live", "/lab?mode=nonsense"):
        r = c.get(url)
        assert r.status_code == 200, (url, r.text[-600:])
    r = c.get("/lab")
    assert "By weight class" in r.text and "Career stats model" in r.text and "Model Lab" in c.get("/").text
