"""Body/leg strike features: off by default, offered to the learning loop as a validated-only candidate."""
from ufcpred.config import ModelConfig
from ufcpred.features.catalog import features_for
from ufcpred.learning import candidates as C


def test_off_by_default_and_existing_fingerprints_unchanged():
    base = ModelConfig()
    assert "strike_location" not in base.to_dict()                  # older configs keep their fingerprint
    old = ModelConfig.from_dict({k: v for k, v in base.to_dict().items()})
    assert old.fingerprint() == base.fingerprint() and old.strike_location is False
    on = base.with_changes(strike_location=True)
    assert on.fingerprint() != base.fingerprint() and ModelConfig.from_dict(on.to_dict()).strike_location


def test_features_only_appear_when_enabled():
    names = lambda g, on: {f.name for f in features_for(g, False, on)}
    assert not names("A_baseline", False) & {"body_pm", "leg_pm", "body_diff", "leg_diff"}
    assert {"body_pm", "leg_pm", "body_diff", "leg_diff"} <= names("A_baseline", True)
    assert "legs_vs_leg_defense" in names("C_style", True) and "legs_vs_leg_defense" not in names("C_style", False)
    assert names("D_durability", True) == names("D_durability", False)


def test_learning_loop_tries_it_first_and_not_once_adopted():
    cands = C.generate(ModelConfig(), [], max_candidates=3)
    assert cands[0].config.strike_location and "body and leg" in cands[0].description
    adopted = ModelConfig().with_changes(strike_location=True)
    assert not any("body and leg" in c.description for c in C.generate(adopted, [], max_candidates=5))


def test_strike_location_stats_are_point_in_time(synth):
    from ufcpred.features.history import HistoryStore, fighter_state
    conn, truth = synth
    h = HistoryStore.load(conn)
    fid = conn.execute("SELECT red_fighter_id FROM fights LIMIT 1").fetchone()[0]
    st = fighter_state(h, fid, truth["dates"][60])
    for k in ("body_pm", "leg_pm", "body_abs_pm", "leg_abs_pm"):
        assert st[k] >= 0
    assert abs(st["leg_diff_pm"] - (st["leg_pm"] - st["leg_abs_pm"])) < 1e-12
