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


def test_learning_loop_tries_it_early_and_not_once_adopted():
    cands = C.generate(ModelConfig(), [], max_candidates=3)
    assert any(c.config.strike_location and "body and leg" in c.description for c in cands[:2])
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


# ------------------------------------------------------------------ strength-adjusted stats (opp_adjusted)
def test_opp_adjusted_is_off_by_default_and_offered_first():
    base = ModelConfig()
    assert "opp_adjusted" not in base.to_dict()
    on = base.with_changes(opp_adjusted=True)
    assert on.fingerprint() != base.fingerprint() and ModelConfig.from_dict(on.to_dict()).opp_adjusted
    names = lambda flag: {f.name for f in features_for("A_baseline", False, False, flag)}
    assert {"adj_striking", "adj_absorbed", "adj_wrestling"} <= names(True)
    assert not names(False) & {"adj_striking", "adj_absorbed", "adj_wrestling"}
    first = C.generate(base, [], max_candidates=3)[0]
    assert first.config.opp_adjusted and "strength-adjusted" in first.description
    assert not any(c.config.opp_adjusted for c in C.generate(on, [], max_candidates=5) if "strength" in c.description)


def test_opp_adjusted_stats_use_only_earlier_fights(synth):
    """The opponent's 'usual' rates for a fight come from that opponent's fights on earlier dates only."""
    from ufcpred.features.history import HistoryStore, fighter_state
    conn, truth = synth
    h = HistoryStore.load(conn)
    rec = next(r for recs in h.records.values() for r in recs if r.own and r.opp_sapm_pre is not None)
    earlier = [x for x in h.records.get(rec.opp_id, []) if x.date < rec.date and x.own and x.opp and x.seconds]
    mins = sum(x.seconds for x in earlier) / 60
    absorbed = sum(x.opp.get("sig_l") or 0 for x in earlier)
    pp = h.population(rec.date)
    assert abs(rec.opp_sapm_pre - (absorbed + pp["slpm"] * 15) / (mins + 15)) < 1e-9
    st = fighter_state(h, rec.fighter_id, truth["dates"][-1])
    for k in ("adj_striking", "adj_absorbed", "adj_wrestling"):
        assert st[k] > 0


# ------------------------------------------------------------------ fight-week info form
def test_fight_week_info_is_recorded_audited_and_repredicts(trained):
    import json

    from fastapi.testclient import TestClient

    from ufcpred import ledger, predict
    from ufcpred.ingest import ingest_bundle
    from ufcpred.providers import manual
    from ufcpred.util import utcnow
    from ufcpred.web.app import app
    conn = trained[0]
    card = {"event": {"name": "Weigh-in Night", "date": "2099-03-01", "source_url": "https://example.org/c"},
            "fights": [{"red": "Synthetic Fighter 1", "blue": "Synthetic Fighter 2", "weight_class": "Lightweight",
                        "scheduled_rounds": 3}]}
    ingest_bundle(conn, manual.parse_card(json.dumps(card)), reconcile_cards=True)
    ev = conn.execute("SELECT id FROM events WHERE name='Weigh-in Night'").fetchone()[0]
    fid = conn.execute("SELECT id FROM fights WHERE event_id=?", (ev,)).fetchone()[0]
    predict.predict_event(conn, ev, mode="live", reason="test")
    c = TestClient(app)
    assert "Fight-week info" in c.get(f"/fight/{fid}?mode=live").text
    r = c.post(f"/fight/{fid}/fightweek", data={"weight_miss_blue": "yes", "short_notice_red": "no", "source": ""},
               follow_redirects=False)
    assert "refused" in r.headers["location"]                     # a source is required
    r = c.post(f"/fight/{fid}/fightweek", data={"weight_miss_blue": "yes", "short_notice_red": "no",
                                                 "source": "official weigh-ins"}, follow_redirects=False)
    f = conn.execute("SELECT * FROM fights WHERE id=?", (fid,)).fetchone()
    assert (f["weight_miss_blue"], f["short_notice_red"], f["weight_miss_red"]) == (1, 0, None)
    assert conn.execute("SELECT COUNT(*) FROM predictions WHERE fight_id=? AND mode='live'", (fid,)).fetchone()[0] == 2
    assert conn.execute("SELECT COUNT(*) FROM audit_log WHERE action='fight.fight_week'").fetchone()[0] == 1
    ledger.lock_event(conn, ev, "live", utcnow()[:10], "test lock")
    r = c.post(f"/fight/{fid}/fightweek", data={"weight_miss_blue": "no", "source": "x"}, follow_redirects=False)
    assert "refused" in r.headers["location"] and "locked" in r.headers["location"]
    assert conn.execute("SELECT weight_miss_blue FROM fights WHERE id=?", (fid,)).fetchone()[0] == 1
