"""Simulated betting tracker: P/L maths, settlement rules, idempotent sync, corrections and persistence."""
import json

import pytest

from nbapred import betting, db, predict
from nbapred.ingest import ingest_bundle
from nbapred.providers import manual
from nbapred.util import utcnow


# ------------------------------------------------------------------ pure maths (examples A–F)
def _row(tier, stake, status, net=None, odds=None, event=1, p=0.6, date="2026-01-01", **kw):
    return {"id": kw.get("id", 0), "event_id": event, "event_name": f"Event {event}", "event_date": date,
            "tier": tier, "stake_cents": stake, "status": status, "net_cents": net, "odds_decimal": odds,
            "odds_american": None if odds is None else betting.decimal_to_american(odds), "p_pick": p,
            "pick_name": "A", "opponent_name": "B", "confidence_score": 0.85, "season_type": "regular", "pick_is_home": 1,
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
def _night(conn, pairs, date="2099-02-01"):
    card = {"night": {"date": date, "source_url": "https://example.org/schedule"},
            "games": [{"home": h, "away": a} for h, a in pairs]}
    ingest_bundle(conn, manual.parse_card(json.dumps(card)))
    return conn.execute("SELECT id FROM events WHERE date=?", (date,)).fetchone()[0]


def _games(conn, ev):
    return conn.execute("SELECT * FROM games WHERE event_id=? ORDER BY id", (ev,)).fetchall()


def _result(conn, game, home_score, away_score, outcome="win", revision=1):
    winner = None if outcome != "win" else (game["home_team_id"] if home_score > away_score else game["away_team_id"])
    conn.execute("INSERT INTO game_results(game_id, revision, outcome, winner_team_id, home_score, away_score, periods, "
                 "origin, recorded_at) VALUES (?,?,?,?,?,?,4,?,?)",
                 (game["id"], revision, outcome, winner, home_score, away_score, "manual", utcnow()))
    conn.execute("UPDATE games SET status='completed' WHERE id=?", (game["id"],))
    conn.commit()


def _odds(conn, game, home, away, at="2020-01-01T00:00:00Z"):
    conn.execute("INSERT INTO odds(game_id, provider, bookmaker, home_decimal, away_decimal, captured_at, created_at) "
                 "VALUES (?,?,?,?,?,?,?)", (game["id"], "manual", "TestBook", home, away, at, utcnow()))
    conn.commit()


def _bet(conn, game):
    return conn.execute("SELECT * FROM sim_bets WHERE game_id=?", (game["id"],)).fetchone()


def _pick_wins(conn, game, bet):
    if bet["pick_team_id"] == game["home_team_id"]:
        _result(conn, game, 110, 100)
    else:
        _result(conn, game, 100, 110)


def _pick_loses(conn, game, bet):
    if bet["pick_team_id"] == game["home_team_id"]:
        _result(conn, game, 100, 110)
    else:
        _result(conn, game, 110, 100)


@pytest.fixture
def night(trained, monkeypatch):
    """A live night with deterministic tiers: game 1 High, game 2 Medium, game 3 Low."""
    conn = trained[0]
    db.set_setting(conn, "betting.min_ev", -1.0)       # these tests cover settlement mechanics, not the price rule
    ev = _night(conn, [("BOS", "MIA"), ("LAL", "PHX"), ("DEN", "UTA")])
    predict.predict_event(conn, ev, mode="live", reason="test")
    games = _games(conn, ev)
    tier_of = {games[0]["id"]: "High", games[1]["id"]: "Medium", games[2]["id"]: "Low"}
    real = betting._snapshot

    def snap(pred, game, e, stakes):
        s = real(pred, game, e, stakes)
        t = tier_of.get(game["id"], s["tier"])
        if pred["version"] > 1 and game["id"] == games[0]["id"]:
            t = "Medium"
        s.update(tier=t, stake_cents=stakes[t])
        return s
    monkeypatch.setattr(betting, "_snapshot", snap)
    return conn, ev, games


def test_qualification_stakes_and_duplicate_prevention(night):
    conn, ev, games = night
    out = betting.sync(conn)
    assert out["created"] == 3
    assert [_bet(conn, g)["stake_cents"] for g in games] == [10000, 5000, 0]
    assert _bet(conn, games[2])["status"] == "no_bet"
    assert betting.sync(conn).get("created", 0) == 0
    with pytest.raises(db.IntegrityError):
        b = dict(_bet(conn, games[0]))
        conn.execute("INSERT INTO sim_bets(strategy, event_id, game_id, prediction_id, tier, stake_cents, status, "
                     "created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
                     (b["strategy"], b["event_id"], b["game_id"], b["prediction_id"], "High", 1, "pending", "t", "t"))
    conn.rollback()


def test_lock_freezes_selection_stake_and_odds(night):
    conn, ev, games = night
    betting.sync(conn)
    _odds(conn, games[0], 1.6, 2.4)
    betting.sync(conn)
    assert _bet(conn, games[0])["odds_decimal"] in (1.6, 2.4)
    predict.predict_event(conn, ev, mode="live", reason="re-predict")
    betting.sync(conn)
    assert _bet(conn, games[0])["tier"] == "Medium"            # follows the newest prediction before the lock
    from nbapred import ledger
    ledger.lock_event(conn, ev, "live", "2099-02-01")
    betting.sync(conn)
    b = _bet(conn, games[0])
    assert b["locked_at"]
    before = b["odds_decimal"]
    _odds(conn, games[0], 1.3, 3.6, at="2021-01-01T00:00:00Z")
    betting.sync(conn)
    assert _bet(conn, games[0])["odds_decimal"] == before          # locked odds are never replaced


def test_settlement_win_loss_abandon_cancel_and_revisions(night):
    conn, ev, games = night
    for g in games:
        _odds(conn, g, 1.9, 1.9)
    from nbapred import ledger
    ledger.lock_event(conn, ev, "live", "2099-02-01")
    betting.sync(conn)
    b0, b1 = _bet(conn, games[0]), _bet(conn, games[1])
    _pick_wins(conn, games[0], b0)
    _pick_loses(conn, games[1], b1)
    betting.sync(conn)
    assert _bet(conn, games[0])["status"] == "win" and _bet(conn, games[0])["net_cents"] == 9000
    assert _bet(conn, games[1])["status"] == "loss" and _bet(conn, games[1])["net_cents"] == -5000
    # a corrected result re-settles once, with a log entry
    g0 = games[0]
    flip = (100, 110) if b0["pick_team_id"] == g0["home_team_id"] else (110, 100)
    _result(conn, g0, *flip, revision=2)
    out = betting.sync(conn)
    assert out["resettled"] == 1 and _bet(conn, g0)["status"] == "loss"
    assert betting.history(conn, b0["id"])[-1]["action"] == "resettled"
    # an abandoned game voids the stake
    _result(conn, games[1], None, None, outcome="nc", revision=2)
    betting.sync(conn)
    assert _bet(conn, games[1])["status"] == "void" and _bet(conn, games[1])["net_cents"] == 0


def test_postponed_game_voids_and_missing_odds_wait_for_admin(night):
    conn, ev, games = night
    from nbapred import ledger
    ledger.lock_event(conn, ev, "live", "2099-02-01")
    betting.sync(conn)
    conn.execute("UPDATE games SET status='postponed' WHERE id=?", (games[1]["id"],))
    conn.commit()
    b0 = _bet(conn, games[0])
    _pick_wins(conn, games[0], b0)
    betting.sync(conn)
    assert _bet(conn, games[1])["status"] == "void"
    b = _bet(conn, games[0])
    assert b["status"] == "win" and b["net_cents"] is None and betting.needs_odds(dict(b))
    with pytest.raises(betting.CorrectionError):
        betting.correct(conn, b["id"], reason="", odds_american="-150")
    betting.correct(conn, b["id"], reason="closing price from the book", odds_american="-150")
    b = _bet(conn, games[0])
    assert b["net_cents"] == 6667 and b["odds_source"] == "manual"
    assert betting.history(conn, b["id"])[-1]["action"] == "corrected"


def test_engine_is_untouched_by_tracking(night):
    conn, ev, games = night
    before = [tuple(r) for r in conn.execute("SELECT id, content_sha256 FROM predictions ORDER BY id")]
    betting.sync(conn)
    after = [tuple(r) for r in conn.execute("SELECT id, content_sha256 FROM predictions ORDER BY id")]
    assert before == after


def test_bets_are_never_deleted(night):
    conn, ev, games = night
    betting.sync(conn)
    with pytest.raises(db.IntegrityError):
        conn.execute("DELETE FROM sim_bets WHERE game_id=?", (games[0]["id"],))
    conn.rollback()


def test_ledger_filters_and_csv(night):
    conn, ev, games = night
    betting.sync(conn)
    rows = betting.bets(conn)
    assert len(betting.filter_rows(rows, {})) == 2                      # Low hidden by default
    assert len(betting.filter_rows(rows, {"tier": "Low"})) == 1
    team = rows[0]["pick_name"][:5]
    assert all(team.lower() in (r["pick_name"] + r["opponent_name"]).lower()
               for r in betting.filter_rows(rows, {"team": team}))
    csv = betting.to_csv(rows)
    assert csv.splitlines()[0].startswith("bet_id,event_date,event,season_type,pick,opponent,pick_is_home")


def test_price_check_requires_positive_expected_return():
    rules = {"_min_ev": 0.05}
    assert betting.price_check(0.6, 1.9, rules)[0] is True          # 0.6 × 1.9 − 1 = +14%
    assert betting.price_check(0.6, 1.6, rules)[0] is False         # −4%: price too short
    assert betting.price_check(None, 1.6, rules)[0] is False
