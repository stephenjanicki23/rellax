"""Simulated betting tracker: P/L maths, settlement rules, idempotent sync, corrections and persistence."""
import json

import pytest

from ufcpred import betting, db, predict
from ufcpred.ingest import ingest_bundle
from ufcpred.providers import manual
from ufcpred.util import utcnow


# ------------------------------------------------------------------ pure maths (examples A–F)
def _row(tier, stake, status, net=None, odds=None, event=1, p=0.6, date="2026-01-01", **kw):
    return {"id": kw.get("id", 0), "event_id": event, "event_name": f"Event {event}", "event_date": date,
            "tier": tier, "stake_cents": stake, "status": status, "net_cents": net, "odds_decimal": odds,
            "odds_american": None if odds is None else betting.decimal_to_american(odds), "p_pick": p,
            "pick_name": "A", "opponent_name": "B", "confidence_score": 0.85, "weight_class": "Lightweight",
            "settle_note": kw.get("note"), "rationale_json": "{}"}


def test_example_a_high_confidence_win():
    amt = betting.settle_amounts(10000, "win", american=150)
    assert amt == {"net": 15000, "stake_returned": 10000, "total_returned": 25000}


def test_example_b_medium_confidence_win_rounds_to_the_cent():
    amt = betting.settle_amounts(5000, "win", american=-110)
    assert amt == {"net": 4545, "stake_returned": 5000, "total_returned": 9545}
    # the same bet stored as decimal odds settles identically
    assert betting.settle_amounts(5000, "win", decimal=betting.american_to_decimal(-110))["net"] == 4545


def test_examples_c_d_losses_and_push_void():
    assert betting.settle_amounts(10000, "loss")["net"] == -10000
    assert betting.settle_amounts(5000, "loss")["net"] == -5000
    for kind in ("push", "void"):
        assert betting.settle_amounts(5000, kind) == {"net": 0, "stake_returned": 5000, "total_returned": 5000}
    assert betting.settle_amounts(5000, "pending")["net"] is None
    assert betting.profit_cents(10000, american=-250) == 4000 and betting.profit_cents(10000, american=100) == 10000
    with pytest.raises(ValueError):
        betting.profit_cents(10000, american=-99)


def test_example_e_mixed_event_and_example_f_pending():
    rows = [_row("High", 10000, "win", 15000, 2.5), _row("Medium", 5000, "loss", -5000, 1.8),
            _row("High", 10000, "loss", -10000, 1.5), _row("High", 10000, "pending", odds=2.0),
            _row("Low", 0, "no_bet", note="pick won")]
    ev = betting.event_stats(rows)[0]
    assert ev["net"] == 0 and ev["roi"] == 0 and ev["staked"] == 35000 and ev["pending"] == 1
    assert ev["tiers"]["High"]["picks"] == 3 and ev["tiers"]["Medium"]["picks"] == 1
    assert ev["tiers"]["High"]["net"] == 5000 and ev["tiers"]["Medium"]["net"] == -5000
    s = betting.summary(rows)
    assert s["net"] == 0 and s["settled_stake"] == 25000 and s["roi"] == 0       # pending is not realised
    assert s["exposure"] == 10000 and s["pending"] == 1 and s["total"] == 4      # Low is tracked, not a bet
    assert s["win_rate"] == pytest.approx(1 / 3) and s["high_net"] == 5000 and s["medium_net"] == -5000


def test_tier_stats_streaks_gross_and_cumulative():
    rows = [_row("High", 10000, s, n, 2.0, date=f"2026-01-0{i}") for i, (s, n) in
            enumerate([("win", 10000), ("win", 10000), ("loss", -10000), ("loss", -10000), ("loss", -10000),
                       ("push", 0), ("void", 0)], start=1)]
    t = betting.tier_stats(rows, "High")
    assert (t["wins"], t["losses"], t["pushes"], t["voids"]) == (2, 3, 1, 1)
    assert t["gross_winnings"] == 20000 and t["total_losses"] == 30000 and t["net"] == -10000
    assert t["settled_stake"] == 50000 and t["roi"] == pytest.approx(-0.2)
    assert t["longest_win"] == 2 and t["longest_loss"] == 3 and t["avg_american"] == 100
    pts = betting.cumulative(rows)
    assert pts[-1]["High"] == -100 and pts[-1]["all"] == -100 and len(pts) == 7


# ------------------------------------------------------------------ database integration
def _card(conn, pairs, date="2099-02-01", name="Bet Night"):
    card = {"event": {"name": name, "date": date, "source_url": "https://example.org/card"},
            "fights": [{"red": r, "blue": b, "weight_class": "Lightweight", "scheduled_rounds": 3} for r, b in pairs]}
    ingest_bundle(conn, manual.parse_card(json.dumps(card)), reconcile_cards=True)
    return conn.execute("SELECT id FROM events WHERE name=?", (name,)).fetchone()[0]


def _fights(conn, ev):
    return conn.execute("SELECT * FROM fights WHERE event_id=? ORDER BY id", (ev,)).fetchall()


def _result(conn, fight, outcome, winner=None, revision=1):
    conn.execute("INSERT INTO fight_results(fight_id, revision, outcome, winner_fighter_id, method, origin, "
                 "recorded_at) VALUES (?,?,?,?,?,?,?)",
                 (fight["id"], revision, outcome, winner, "DEC" if outcome == "win" else outcome.upper(), "manual",
                  utcnow()))
    conn.commit()


def _odds(conn, fight, red, blue, at="2020-01-01T00:00:00Z"):
    conn.execute("INSERT INTO odds(fight_id, provider, bookmaker, red_decimal, blue_decimal, captured_at, created_at) "
                 "VALUES (?,?,?,?,?,?,?)", (fight["id"], "manual", "TestBook", red, blue, at, utcnow()))
    conn.commit()


def _bet(conn, fight):
    return conn.execute("SELECT * FROM sim_bets WHERE fight_id=?", (fight["id"],)).fetchone()


@pytest.fixture
def card(trained, monkeypatch):
    """A live card with locked-in tiers: fight 1 High, fight 2 Medium, fight 3 Low (the engine's label is
    replaced only inside the tracker's snapshot, to make the tiers deterministic)."""
    conn = trained[0]
    ev = _card(conn, [("Synthetic Fighter 1", "Synthetic Fighter 2"), ("Synthetic Fighter 3", "Synthetic Fighter 4"),
                      ("Synthetic Fighter 5", "Synthetic Fighter 6")])
    predict.predict_event(conn, ev, mode="live", reason="test")
    fights = _fights(conn, ev)
    tier_of = {fights[0]["id"]: "High", fights[1]["id"]: "Medium", fights[2]["id"]: "Low"}
    real = betting._snapshot

    def snap(pred, fight, e, stakes):
        s = real(pred, fight, e, stakes)
        t = tier_of.get(fight["id"], s["tier"])
        if pred["version"] > 1 and fight["id"] == fights[0]["id"]:
            t = "Medium"                                   # a re-prediction drops fight 1 to Medium
        s.update(tier=t, stake_cents=stakes[t])
        return s
    monkeypatch.setattr(betting, "_snapshot", snap)
    return conn, ev, fights


def _win_for_pick(conn, fight, bet):
    _result(conn, fight, "win", bet["pick_fighter_id"])


def _loss_for_pick(conn, fight, bet):
    _result(conn, fight, "win", bet["opponent_fighter_id"])


def test_qualification_stakes_and_duplicate_prevention(card):
    conn, ev, fights = card
    for _ in range(3):                                     # Example G: repeated syncs, one bet per fight
        betting.sync(conn)
    predict.predict_event(conn, ev, mode="live", reason="re-run")   # predictions recalculated
    betting.sync(conn)
    rows = conn.execute("SELECT fight_id, COUNT(*) AS n FROM sim_bets GROUP BY fight_id").fetchall()
    assert len(rows) == 3 and all(r["n"] == 1 for r in rows)
    b1, b2, b3 = (_bet(conn, f) for f in fights)
    assert b1["stake_cents"] == 5000 and b1["tier"] == "Medium"     # re-prediction before lock → followed, logged
    assert b2["tier"] == "Medium" and b2["stake_cents"] == 5000 and b2["status"] == "pending"
    assert b3["tier"] == "Low" and b3["stake_cents"] == 0 and b3["status"] == "no_bet"
    acts = [h["action"] for h in betting.history(conn, b1["id"])]
    assert acts[0] == "created" and "prediction_changed" in acts
    assert json.loads(b1["rationale_json"])["prediction_version"] == 2
    with pytest.raises(db.IntegrityError):                 # the unique constraint backs the logic up
        conn.execute("INSERT INTO sim_bets(strategy, event_id, fight_id, prediction_id, tier, stake_cents, status, "
                     "created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
                     (betting.STRATEGY, ev, fights[1]["id"], b2["prediction_id"], "High", 1, "pending", "x", "x"))
    conn.rollback()


def test_lock_freezes_selection_stake_and_odds(card):
    from ufcpred import ledger
    conn, ev, fights = card
    _odds(conn, fights[1], 1.8, 2.1)
    betting.sync(conn)
    ledger.lock_event(conn, ev, "live", utcnow()[:10], "test lock")
    betting.sync(conn)
    b2 = _bet(conn, fights[1])
    assert b2["locked_at"] and b2["odds_decimal"] is not None
    first_odds = b2["odds_decimal"]
    db.set_setting(conn, "betting.stake_medium", 75)       # a later stake change never rewrites a bet
    conn.commit()
    _odds(conn, fights[1], 1.5, 2.6, at="2021-01-01T00:00:00Z")    # the line moves after the lock
    predict.predict_event(conn, ev, mode="live", reason="post-lock check", allow_post_lock=True)
    betting.sync(conn)
    b2 = _bet(conn, fights[1])
    assert b2["stake_cents"] == 5000 and b2["odds_decimal"] == first_odds    # nothing silently changed
    assert any(h["action"] == "locked" for h in betting.history(conn, b2["id"]))


def test_settlement_win_loss_draw_nc_cancel_and_revisions(card):
    from ufcpred import ledger
    conn, ev, fights = card
    for f in fights:
        _odds(conn, f, 2.5, 1.6)
    betting.sync(conn)
    ledger.lock_event(conn, ev, "live", utcnow()[:10], "test lock")
    betting.sync(conn)
    b1, b2, b3 = (_bet(conn, f) for f in fights)
    _win_for_pick(conn, fights[0], b1)
    _result(conn, fights[1], "draw")
    _loss_for_pick(conn, fights[2], b3)
    betting.sync(conn)
    b1, b2, b3 = (_bet(conn, f) for f in fights)
    exp = betting.profit_cents(b1["stake_cents"], decimal=b1["odds_decimal"])
    assert b1["status"] == "win" and b1["net_cents"] == exp
    assert b2["status"] == "push" and b2["net_cents"] == 0
    assert b3["status"] == "no_bet" and b3["settle_note"] == "pick lost" and b3["net_cents"] is None
    # an overturned result (win → no contest) re-settles with a logged reason, never double-counted
    _result(conn, fights[0], "nc", revision=2)
    betting.sync(conn)
    betting.sync(conn)
    b1 = _bet(conn, fights[0])
    assert b1["status"] == "void" and b1["net_cents"] == 0
    assert [h["action"] for h in betting.history(conn, b1["id"])].count("resettled") == 1
    s = betting.summary(betting.bets(conn))
    assert s["net"] == 0 and s["settled"] == 2 and s["decided"] == 0


def test_canceled_bout_voids_and_unlocked_bet_is_not_graded(card):
    conn, ev, fights = card
    betting.sync(conn)
    conn.execute("UPDATE fights SET status='canceled' WHERE id=?", (fights[1]["id"],))
    conn.commit()
    b1 = _bet(conn, fights[0])
    _win_for_pick(conn, fights[0], b1)                     # card never locked: no graded bet
    betting.sync(conn)
    assert _bet(conn, fights[1])["status"] == "void" and _bet(conn, fights[1])["net_cents"] == 0
    b1 = _bet(conn, fights[0])
    assert b1["status"] == "void" and "not locked" in b1["settle_note"]


def test_missing_odds_wait_then_admin_entry_settles_with_audit(card):
    from ufcpred import ledger
    conn, ev, fights = card
    betting.sync(conn)
    ledger.lock_event(conn, ev, "live", utcnow()[:10], "test lock")
    betting.sync(conn)
    b2 = _bet(conn, fights[1])
    _loss_for_pick(conn, fights[1], b2)
    _odds(conn, fights[1], 1.9, 1.9, at="2999-01-01T00:00:00Z")   # captured after the result: never used
    betting.sync(conn)
    b2 = _bet(conn, fights[1])
    assert b2["status"] == "loss" and b2["net_cents"] is None and betting.needs_odds(dict(b2))
    s = betting.summary(betting.bets(conn))
    assert s["net"] == 0 and s["needs_odds"] == 1 and s["exposure"] >= 5000
    with pytest.raises(betting.CorrectionError):
        betting.correct(conn, b2["id"], reason="", odds_american="-110")
    betting.correct(conn, b2["id"], reason="line from the sportsbook screenshot", odds_american="-110")
    b2 = _bet(conn, fights[1])
    assert b2["net_cents"] == -5000 and b2["odds_american"] == -110 and b2["odds_source"] == "manual"
    # admin void, then back to automatic settlement
    betting.correct(conn, b2["id"], reason="fighter missed weight; book voided", status="void")
    assert _bet(conn, fights[1])["net_cents"] == 0
    betting.sync(conn)
    assert _bet(conn, fights[1])["status"] == "void"       # pinned: sync does not undo an admin correction
    betting.correct(conn, b2["id"], reason="undo", status="auto")
    assert _bet(conn, fights[1])["net_cents"] == -5000
    acts = [h for h in betting.history(conn, b2["id"]) if h["action"] == "corrected"]
    assert len(acts) == 3 and all(h["reason"] for h in acts)
    with pytest.raises(Exception):                         # history is append-only
        conn.execute("DELETE FROM sim_bet_events WHERE bet_id=?", (b2["id"],))
    conn.rollback()


def test_persistence_across_restart_and_export_roundtrip(card, fresh_db, tmp_path):
    """Example H: reopen the database; bets, event summaries and lifetime P/L are unchanged."""
    from conftest import db_target

    from ufcpred import ledger
    conn, ev, fights = card
    for f in fights:
        _odds(conn, f, 2.5, 1.6)
    betting.sync(conn)
    ledger.lock_event(conn, ev, "live", utcnow()[:10], "test lock")
    betting.sync(conn)
    _win_for_pick(conn, fights[0], _bet(conn, fights[0]))
    _loss_for_pick(conn, fights[1], _bet(conn, fights[1]))
    betting.sync(conn)
    before = (betting.summary(betting.bets(conn)), betting.event_stats(betting.bets(conn)))
    target = db_target(conn)
    conn.close()
    conn2 = db.connect(target)
    betting.sync(conn2)
    after = (betting.summary(betting.bets(conn2)), betting.event_stats(betting.bets(conn2)))
    assert before == after and before[0]["settled"] == 2
    csv = betting.to_csv(betting.filter_rows(betting.bets(conn2), {}))
    assert csv.splitlines()[0].startswith("bet_id,event_date") and len(csv.splitlines()) == 3


def test_engine_is_untouched_by_tracking(card):
    conn, ev, fights = card
    before = conn.execute("SELECT id, content_sha256 FROM predictions ORDER BY id").fetchall()
    betting.sync(conn)
    after = conn.execute("SELECT id, content_sha256 FROM predictions ORDER BY id").fetchall()
    assert [tuple(r) for r in before] == [tuple(r) for r in after]


def test_ledger_filters_sort_and_dashboard_pages(card):
    from fastapi.testclient import TestClient

    from ufcpred import ledger
    from ufcpred.web.app import app
    conn, ev, fights = card
    for f in fights:
        _odds(conn, f, 2.5, 1.6)
    betting.sync(conn)
    ledger.lock_event(conn, ev, "live", utcnow()[:10], "test lock")
    betting.sync(conn)
    _win_for_pick(conn, fights[0], _bet(conn, fights[0]))
    betting.sync(conn)
    rows = betting.bets(conn)
    assert len(betting.filter_rows(rows, {})) == 2                       # Low hidden unless asked
    assert len(betting.filter_rows(rows, {"tier": "Low"})) == 1
    assert len(betting.filter_rows(rows, {"status": "win"})) == 1
    assert len(betting.filter_rows(rows, {"fighter": "fighter 3"})) == 1
    c = TestClient(app)
    for url in ["/edge", f"/edge/event/{ev}", "/edge/bets", "/edge/bets?tier=High&sort=pl&dir=asc",
                f"/edge/bet/{_bet(conn, fights[0])['id']}"]:
        r = c.get(url)
        assert r.status_code == 200, (url, r.text[-600:])
    assert "Lifetime net P/L" in c.get("/edge").text
    r = c.get("/edge/bets.csv")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
