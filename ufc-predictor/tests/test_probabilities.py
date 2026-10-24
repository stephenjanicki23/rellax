import math

import numpy as np

from ufcpred import predict
from ufcpred.config import ModelConfig
from ufcpred.features.build import build_rows, training_metas
from ufcpred.models import engine, registry
from ufcpred.providers.odds import devig
from ufcpred.util import loads


def _event_after(conn, cutoff):
    return conn.execute("SELECT * FROM events WHERE date>=? ORDER BY date LIMIT 1", (cutoff,)).fetchone()


def test_winner_probabilities_sum_to_one_and_methods_reconcile(trained):
    conn, truth, h, cache, vid, cutoff = trained
    ev = _event_after(conn, cutoff)
    ids = predict.predict_event(conn, ev["id"], mode="replay", as_of=ev["date"], reason="test", h=h, cache=cache)
    assert ids
    for row in conn.execute(f"SELECT * FROM predictions WHERE id IN ({','.join(map(str, ids))})"):
        p = loads(row["payload_json"])
        assert abs(p["p_red"] + p["p_blue"] - 1) < 1e-12
        assert abs(sum(p["methods"]["red"].values()) - p["p_red"]) < 1e-9
        assert abs(sum(p["methods"]["blue"].values()) - p["p_blue"]) < 1e-9
        assert abs(sum(p["rounds"]) + p["p_decision"] - 1) < 1e-9          # finishes by round + decision = 1
        assert len(p["rounds"]) == p["scheduled_rounds"]
        assert all(0 <= v <= 1 for s in ("red", "blue") for v in p["methods"][s].values())
        # explanation contributions sum exactly to the calibrated logit
        assert abs(sum(c["contribution"] for c in p["contributions"]) - p["logit"]) < 1e-6
        assert p["confidence"]["label"] in ("High", "Medium", "Low")


def test_corner_swap_is_exact_complement(trained):
    conn, truth, h, cache, vid, cutoff = trained
    params = registry.load_params(conn, vid)
    metas, _ = training_metas(h, ModelConfig.from_dict(params["config"]), "2100-01-01", start=cutoff)
    metas = metas[:20]
    swapped = [{**m, "red_fighter_id": m["blue_fighter_id"], "blue_fighter_id": m["red_fighter_id"]} for m in metas]
    a, _ = engine.predict_metas(params, h, metas, cutoff, cache)
    b, _ = engine.predict_metas(params, h, swapped, cutoff, cache)
    for x, y in zip(a, b):
        assert abs(x["p_red"] - (1 - y["p_red"])) < 1e-9
        assert abs(x["methods"]["red"]["KO_TKO"] - y["methods"]["blue"]["KO_TKO"]) < 1e-9


def test_devig_removes_margin():
    pr, pb, over = devig(1.5, 2.6)
    assert abs(pr + pb - 1) < 1e-12 and over > 0
    pr2, pb2, _ = devig(1.5, 2.6, "power")
    assert abs(pr2 + pb2 - 1) < 1e-6


def test_model_learns_signal_out_of_sample(trained):
    """On synthetic data with known skill, the fitted model beats a coin flip on later, unseen fights."""
    conn, truth, h, cache, vid, cutoff = trained
    params = registry.load_params(conn, vid)
    metas, labels = training_metas(h, ModelConfig.from_dict(params["config"]), "2100-01-01", start=cutoff)
    preds, _ = engine.predict_metas(params, h, metas, cutoff, cache)
    p = np.array([x["p_red"] for x in preds])
    y = np.array([labels[m["id"]]["red_won"] for m in metas])
    ll = -np.mean(y * np.log(p) + (1 - y) * np.log(1 - p))
    assert ll < math.log(2) - 0.02
