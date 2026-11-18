"""Probability coherence: symmetry, reconciliation of margin bands, spreads and totals."""
import math

import numpy as np

from nbapred.config import ModelConfig
from nbapred.features.build import StateCache, build_rows, training_metas
from nbapred.models import engine


def test_swapping_sides_at_a_neutral_site_flips_the_probability(trained):
    conn, truth, h, cache, vid, cutoff = trained
    from nbapred.models import registry
    params = registry.load_params(conn, vid)
    metas, _ = training_metas(h, ModelConfig(train_start="2000-01-01"), "2099-01-01", start=cutoff)
    m = dict(metas[0], neutral_site=1, venue_city="Las Vegas")
    sw = dict(m, home_team_id=m["away_team_id"], away_team_id=m["home_team_id"], id=-1)
    (p1,), _ = engine.predict_metas(params, h, [m], cutoff, StateCache(h))
    (p2,), _ = engine.predict_metas(params, h, [sw], cutoff, StateCache(h))
    assert abs(p1["p_home"] + p2["p_home"] - 1) < 1e-6
    assert abs(p1["margin"]["mu"] + p2["margin"]["mu"]) < 1e-6


def test_home_court_is_learned(trained):
    conn, truth, h, cache, vid, cutoff = trained
    from nbapred.models import registry
    params = registry.load_params(conn, vid)
    i = params["feature_names"]["E_context"].index("home")
    assert params["submodels"]["E_context"]["w"][i] > 0          # synthetic league has a +3 home edge


def test_margin_bands_reconcile_with_win_probability():
    for p in (0.05, 0.3, 0.5, 0.72, 0.97):
        mv = engine.margin_view(p, 12.5)
        assert abs(sum(mv["bands"]["home"].values()) - p) < 1e-9
        assert abs(sum(mv["bands"]["away"].values()) - (1 - p)) < 1e-9
        assert abs(engine.p_home_covers(mv["mu"], 12.5, 0.0) - p) < 1e-9     # pick'em line == moneyline
    assert engine.p_home_covers(5.0, 12.0, -5.0) == 0.5


def test_inverse_normal_round_trips():
    for p in (1e-6, 0.01, 0.2, 0.5, 0.8, 0.999):
        assert abs(engine.norm_cdf(engine.norm_ppf(p)) - p) < 1e-8


def test_predictions_beat_coin_flip_on_held_out_synthetic_games(trained):
    conn, truth, h, cache, vid, cutoff = trained
    from nbapred.models import registry
    from nbapred.evaluation import metrics as M
    params = registry.load_params(conn, vid)
    metas, labels = training_metas(h, ModelConfig(train_start="2000-01-01"), "2099-01-01", start=cutoff)
    preds, _ = engine.predict_metas(params, h, metas, "2099-01-01", cache)
    p = np.array([x["p_home"] for x in preds])
    y = np.array([labels[m["id"]]["home_won"] for m in metas])
    assert M.log_loss(p, y).mean() < math.log(2) - 0.02
    assert np.mean((p >= .5) == (y == 1)) > 0.6
    tot = np.array([x["total"]["mu"] for x in preds])
    actual = np.array([labels[m["id"]]["total"] for m in metas])
    assert abs(np.mean(actual - tot)) < 5                     # total model is unbiased on held-out games
