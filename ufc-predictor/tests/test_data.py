"""Ingestion: duplicates, missing/contradictory data, provider failures, fabricated data."""
import json
import textwrap

import pytest

from ufcpred.features.history import HistoryStore, fighter_state
from ufcpred.ingest import ingest_bundle, ingest_manual_results
from ufcpred.providers import manual
from ufcpred.providers.base import Bundle, PEvent, PFight, PFighter, PRoundStats, ProviderError, ProviderUnavailable
from ufcpred.providers.ufcstats_live import parse_event_card, parse_upcoming_list
from ufcpred.providers.ufcstats_mirror import UFCStatsMirrorProvider
from synthetic import make_bundle


def test_reingest_is_idempotent(synth):
    conn, truth = synth
    n = {t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("fighters", "events", "fights", "fight_results")}
    bundle, _ = make_bundle(seed=3)
    out = ingest_bundle(conn, bundle)
    assert out["fights_new"] == 0 and out["results_new"] == 0 and out["results_revised"] == 0
    assert n == {t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in n}


def test_duplicate_fight_and_event_detection(tmp_db):
    b = Bundle(provider="test", events=[PEvent("e1", "Card", "2025-01-01"), PEvent("e2", "Card (dup)", "2025-01-01")],
               fighters=[PFighter("a", "Alpha One"), PFighter("b", "Bravo Two")],
               fights=[PFight("x1", "e1", "Alpha One", "Bravo Two", "a", "b", "Lightweight", scheduled_rounds=3),
                       PFight("x2", "e1", "Bravo Two", "Alpha One", "b", "a", "Lightweight", scheduled_rounds=3)])
    out = ingest_bundle(tmp_db, b)
    assert out["fights_new"] == 1 and out["duplicates_skipped"] == 1
    kinds = {r[0] for r in tmp_db.execute("SELECT kind FROM data_quality_issues")}
    assert {"duplicate_fight", "possible_duplicate_event"} <= kinds


def test_invalid_statistics_are_discarded_not_used(tmp_db):
    b = Bundle(provider="test", events=[PEvent("e1", "Card", "2025-01-01")],
               fighters=[PFighter("a", "Alpha One"), PFighter("b", "Bravo Two")],
               fights=[PFight("x1", "e1", "Alpha One", "Bravo Two", "a", "b", "Lightweight", scheduled_rounds=3)],
               stats=[PRoundStats("x1", "red", 1, {"sig_l": 50, "sig_a": 20, "td_l": -1, "td_a": 2, "ctrl_sec": 900})])
    ingest_bundle(tmp_db, b)
    row = tmp_db.execute("SELECT sig_l, sig_a, td_l, ctrl_sec FROM fight_stats").fetchone()
    assert tuple(row) == (None, None, None, None)
    assert tmp_db.execute("SELECT COUNT(*) FROM data_quality_issues WHERE kind='invalid_stats'").fetchone()[0] == 1


def test_missing_data_is_unknown_not_zero(synth):
    conn, truth = synth
    conn.execute("UPDATE fighters SET reach_in=NULL, dob=NULL WHERE external_id='syn:f1'")
    conn.commit()
    h = HistoryStore.load(conn)
    fid = conn.execute("SELECT id FROM fighters WHERE external_id='syn:f1'").fetchone()[0]
    st = fighter_state(h, fid, truth["dates"][50])
    assert st["reach"] is None and st["age"] is None and {"age", "reach"} <= set(st["missing_profile"])
    # debut fighter: rates equal the point-in-time population prior, not zero
    deb = fighter_state(h, fid, truth["dates"][0])
    assert deb["debut"] and deb["slpm"] > 1 and abs(deb["slpm"] - deb["population_prior"]["slpm"]) < 1e-3


def test_manual_card_validation_rejects_bad_and_unsourced_cards(tmp_db):
    bad = {"event": {"name": "X", "date": "2026-11-01"}, "fights": [
        {"red": "A", "blue": "A", "scheduled_rounds": 3},
        {"red": "B", "blue": "C", "scheduled_rounds": 4, "weight_class": "Superheavy"}]}
    with pytest.raises(manual.ValidationError) as e:
        manual.parse_card(json.dumps(bad))
    msg = " ".join(e.value.errors)
    assert "source_url" in msg and "themself" in msg and "scheduled_rounds" in msg and "weight class" in msg
    assert tmp_db.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 0


def test_manual_card_import_and_replacement_reconciliation(tmp_db):
    card = {"event": {"name": "UFC Test Night", "date": "2030-05-01", "source_url": "https://example.org/card"},
            "fights": [{"red": "New Guy", "blue": "Other Guy", "weight_class": "Lightweight", "scheduled_rounds": 5,
                        "card_segment": "main"},
                       {"red": "Third Guy", "blue": "Fourth Guy", "weight_class": "Welterweight", "scheduled_rounds": 3}]}
    ingest_bundle(tmp_db, manual.parse_card(json.dumps(card)), reconcile_cards=True)
    # Other Guy withdraws; Fifth Guy replaces him; Third/Fourth bout is cancelled entirely
    card["fights"] = [{"red": "New Guy", "blue": "Fifth Guy", "weight_class": "Lightweight", "scheduled_rounds": 5,
                       "card_segment": "main"}]
    out = ingest_bundle(tmp_db, manual.parse_card(json.dumps(card)), reconcile_cards=True)
    assert out["replaced"] == 1 and out["canceled"] == 1
    st = dict(tmp_db.execute("SELECT status, COUNT(*) FROM fights GROUP BY status").fetchall())
    assert st == {"replaced": 1, "canceled": 1, "scheduled": 1}
    new = tmp_db.execute("SELECT short_notice_blue FROM fights WHERE status='scheduled'").fetchone()[0]
    assert new == 1                                  # the replacement is recorded as short notice
    kinds = {r[0] for r in tmp_db.execute("SELECT kind FROM data_quality_issues")}
    assert "no_history" in kinds                     # unknown fighters are flagged, never given invented stats


def test_manual_results_validation(tmp_db):
    with pytest.raises(manual.ValidationError):
        manual.parse_results("event_date,red,blue,outcome,winner,method,round,time,source_url\n"
                             "2030-05-01,A,B,win,C,KO_TKO,2,1:00,https://x\n", "csv")
    with pytest.raises(manual.ValidationError):      # official result without a source
        manual.parse_results("event_date,red,blue,outcome,winner,method,round,time,source_url\n"
                             "2030-05-01,A,B,win,A,DEC,3,5:00,\n", "csv")
    with pytest.raises(manual.ValidationError):      # finish without a time
        manual.parse_results("event_date,red,blue,outcome,winner,method,round,time,source_url\n"
                             "2030-05-01,A,B,win,A,SUB,,,https://x\n", "csv")


def test_mirror_provider_parses_ufcstats_format_and_flags_identity_conflicts(tmp_path):
    d = tmp_path / "mirror"
    d.mkdir()
    (d / "ufc_event_details.csv").write_text(textwrap.dedent("""\
        EVENT,URL,DATE,LOCATION
        UFC Test: A vs. B,http://ufcstats.com/event-details/aaaa1111,"March 01, 2025","Las Vegas, Nevada, USA"
        """))
    (d / "ufc_fight_results.csv").write_text(textwrap.dedent("""\
        EVENT,BOUT,OUTCOME,WEIGHTCLASS,METHOD,ROUND,TIME,TIME FORMAT,REFEREE,DETAILS,URL
        UFC Test: A vs. B ,John Smith vs. Bruno Silva,L/W,Middleweight Bout,KO/TKO ,2,1:05,3 Rnd (5-5-5),Ref,Punch,http://ufcstats.com/fight-details/ffff0001
        UFC Test: A vs. B ,John Smith vs. Bruno Silva,L/W,Middleweight Bout,KO/TKO ,2,1:05,3 Rnd (5-5-5),Ref,Punch,http://ufcstats.com/fight-details/ffff0001
        UFC Test: A vs. B ,Carl Doe vs. Dan Roe,NC/NC,Lightweight Bout,Overturned ,3,5:00,3 Rnd (5-5-5),Ref,,http://ufcstats.com/fight-details/ffff0002
        """))
    (d / "ufc_fight_stats.csv").write_text(textwrap.dedent("""\
        EVENT,BOUT,ROUND,FIGHTER,KD,SIG.STR.,SIG.STR. %,TOTAL STR.,TD,TD %,SUB.ATT,REV.,CTRL,HEAD,BODY,LEG,DISTANCE,CLINCH,GROUND
        UFC Test: A vs. B,John Smith vs. Bruno Silva,Round 1,John Smith,0,9 of 37,24%,9 of 37,0 of 1,0%,0,0,0:10,5 of 33,1 of 1,3 of 3,9 of 37,0 of 0,0 of 0
        UFC Test: A vs. B,John Smith vs. Bruno Silva,Round 1,Bruno Silva,1,15 of 25,60%,15 of 25,1 of 2,50%,0,0,1:30,9 of 16,4 of 7,2 of 2,15 of 25,0 of 0,0 of 0
        """))
    (d / "ufc_fighter_details.csv").write_text("FIRST,LAST,NICKNAME,URL\n")
    (d / "ufc_fighter_tott.csv").write_text(textwrap.dedent('''\
        FIGHTER,HEIGHT,WEIGHT,REACH,STANCE,DOB,URL
        John Smith,"6' 0""",185 lbs.,"74""",Orthodox,"Jan 01, 1990",http://ufcstats.com/fighter-details/0001
        Bruno Silva,"5' 6""",125 lbs.,--,Orthodox,"Jan 01, 1990",http://ufcstats.com/fighter-details/0002
        Bruno Silva,"6' 0""",185 lbs.,"74""",Orthodox,"Jan 01, 1989",http://ufcstats.com/fighter-details/0003
        Carl Doe,--,155 lbs.,--,,,http://ufcstats.com/fighter-details/0004
        '''))
    b = UFCStatsMirrorProvider(local_dir=str(d)).fetch_history()
    assert len(b.fights) == 2 and len(b.results) == 2
    f = b.fights[0]
    assert f.blue_external_id == "ufcstats:0003"     # middleweight Bruno Silva chosen by weight
    assert f.scheduled_rounds == 3 and f.weight_class == "Middleweight"
    r = b.results[0]
    assert r.winner_corner == "blue" and r.method == "KO_TKO" and r.end_time_sec == 65
    assert b.results[1].outcome == "nc" and b.results[1].method == "NC"
    kinds = {i[2] for i in b.issues}
    assert {"duplicate_fight", "duplicate_name", "missing_profile"} <= kinds
    s = [x for x in b.stats if x.corner == "blue"][0]
    assert s.stats["sig_l"] == 15 and s.stats["ctrl_sec"] == 90
    bro = next(x for x in b.fighters if x.external_id == "ufcstats:0002")
    assert bro.reach_in is None                       # '--' is unknown, not zero


def test_provider_failure_uses_cache_or_reports_configuration(tmp_db, monkeypatch, tmp_path):
    from ufcpred.providers import http
    def boom(url, timeout):
        raise OSError("network down")
    monkeypatch.setattr(http, "_get", boom)
    with pytest.raises(ProviderUnavailable) as e:
        http.fetch("https://unreachable.example/x.csv", "p", "x.csv", min_interval_s=0, check_robots=False)
    assert e.value.config_required
    cache = http.cache_dir() / "p" / "x.csv"
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text("cached")
    text, meta = http.fetch("https://unreachable.example/x.csv", "p", "x.csv", min_interval_s=0, check_robots=False)
    assert text == "cached" and meta.status == "stale"
    monkeypatch.setattr(http, "_get", lambda url, t: (503, ""))
    with pytest.raises(ProviderError):
        http.fetch("https://unreachable.example/y.csv", "p", "y.csv", min_interval_s=0, check_robots=False)
    from ufcpred import lifecycle
    monkeypatch.setattr(http, "_get", boom)
    out = lifecycle.refresh_history(tmp_db)
    assert "error" in out
    assert tmp_db.execute("SELECT COUNT(*) FROM data_quality_issues WHERE kind='source_failure'").fetchone()[0] == 1
    assert tmp_db.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 0        # nothing invented


def test_upcoming_without_provider_is_skipped_not_faked(tmp_db):
    from ufcpred import lifecycle
    out = lifecycle.refresh_upcoming(tmp_db)
    assert "skipped" in out
    assert tmp_db.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 0


def test_ufcstats_live_parser_on_fixture():
    listing = """<table class="b-statistics__table-events"><tr><td><i class="b-statistics__table-content">
      <a href="http://ufcstats.com/event-details/abc123" class="b-link b-link_style_white">UFC Fight Night: X vs. Y</a>
      <span class="b-statistics__date">November 07, 2026</span></i></td>
      <td class="b-statistics__table-col b-statistics__table-col_style_big-top-padding">Las Vegas, Nevada, USA</td></tr></table>"""
    evs = parse_upcoming_list(listing)
    assert len(evs) == 1 and evs[0].date == "2026-11-07" and evs[0].location.startswith("Las Vegas")
    card = """<tr class="b-fight-details__table-row b-fight-details__table-row__hover js-fight-details-click" data-link="http://ufcstats.com/fight-details/f001">
      <td><p><a href="http://ufcstats.com/fighter-details/aa11" class="b-link">Red Fighter</a></p>
      <p><a href="http://ufcstats.com/fighter-details/bb22" class="b-link">Blue Fighter</a></p></td>
      <td><p class="b-fight-details__table-text">Lightweight</p></td></tr>"""
    fights = parse_event_card(card, evs[0])
    assert len(fights) == 1 and fights[0].red_name == "Red Fighter" and fights[0].weight_class == "Lightweight"
    assert fights[0].red_external_id == "ufcstats:aa11" and fights[0].scheduled_rounds == 5


def test_manual_card_merges_with_the_providers_copy_and_results_attach(tmp_db):
    """A card imported by hand before the event, then published by the provider with results
    (and the corners listed the other way round), is one event: results grade the manual fights."""
    card = {"event": {"name": "UFC Test Night: A vs. B", "date": "2030-06-01", "source_url": "https://example.org/c"},
            "fights": [{"red": "Alpha One", "blue": "Bravo Two", "weight_class": "Lightweight", "scheduled_rounds": 5,
                        "card_segment": "main"}]}
    ingest_bundle(tmp_db, manual.parse_card(json.dumps(card)))
    manual_fight = tmp_db.execute("SELECT id, red_fighter_id, blue_fighter_id FROM fights").fetchone()
    from ufcpred.providers.base import PResult
    prov = Bundle(provider="ufcstats_mirror",
                  events=[PEvent("ufcstats:ev1", "UFC Test Night: A vs. B", "2030-06-01", location="Las Vegas")],
                  fighters=[PFighter("ufcstats:a", "Alpha One"), PFighter("ufcstats:b", "Bravo Two")],
                  fights=[PFight("ufcstats:f1", "ufcstats:ev1", "Bravo Two", "Alpha One", "ufcstats:b", "ufcstats:a",
                                 "Lightweight", scheduled_rounds=5)],
                  results=[PResult("ufcstats:f1", "win", "red", "KO_TKO", "Punches", 2, 65)],
                  stats=[PRoundStats("ufcstats:f1", "red", 1, {"sig_l": 30, "sig_a": 50})])
    ingest_bundle(tmp_db, prov)
    assert tmp_db.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 1
    assert tmp_db.execute("SELECT COUNT(*) FROM fights").fetchone()[0] == 1
    res = tmp_db.execute("SELECT * FROM fight_results WHERE fight_id=?", (manual_fight["id"],)).fetchone()
    # the provider listed Bravo first and said the first-listed fighter won: Bravo is the manual card's blue corner
    assert res["winner_fighter_id"] == manual_fight["blue_fighter_id"]
    st = tmp_db.execute("SELECT fighter_id, sig_l FROM fight_stats WHERE fight_id=?", (manual_fight["id"],)).fetchone()
    assert st["fighter_id"] == manual_fight["blue_fighter_id"] and st["sig_l"] == 30
    assert tmp_db.execute("SELECT status FROM events").fetchone()[0] == "completed"


def test_odds_feed_keeps_only_the_chosen_bookmaker_and_never_leaks_the_key(tmp_db, monkeypatch):
    import pytest
    from ufcpred import lifecycle
    from ufcpred.db import set_setting
    from ufcpred.providers import odds as odds_mod
    from ufcpred.providers.base import ProviderError, SourceMeta
    from ufcpred.util import utcnow
    card = {"event": {"name": "UFC Odds Night", "date": "2099-03-01", "source_url": "https://example.org/card"},
            "fights": [{"red": "Alpha One", "blue": "Bravo Two", "weight_class": "Lightweight", "scheduled_rounds": 3}]}
    ingest_bundle(tmp_db, manual.parse_card(json.dumps(card)), reconcile_cards=True)
    assert "skipped" in lifecycle.refresh_odds(tmp_db)            # provider off by default
    set_setting(tmp_db, "providers.odds", "the_odds_api")
    monkeypatch.setenv("ODDS_API_KEY", "SECRETKEY123")
    payload = [{"home_team": "Bravo Two", "away_team": "Alpha One", "bookmakers": [
        {"key": "williamhill_us", "title": "Caesars", "last_update": "2099-02-28T12:00:00Z",
         "markets": [{"key": "h2h", "outcomes": [{"name": "Alpha One", "price": 1.5}, {"name": "Bravo Two", "price": 2.7}]}]},
        {"key": "draftkings", "title": "DraftKings", "last_update": "2099-02-28T12:00:00Z",
         "markets": [{"key": "h2h", "outcomes": [{"name": "Alpha One", "price": 1.4}, {"name": "Bravo Two", "price": 3.0}]}]}]}]
    seen_urls = []

    def fake_fetch(url, provider, resource, **kw):
        seen_urls.append(url)
        return json.dumps(payload), SourceMeta(provider, resource, url, utcnow(), "x", "ok", 200, None, "")
    monkeypatch.setattr(odds_mod, "fetch", fake_fetch)
    out = lifecycle.refresh_odds(tmp_db)
    assert out["stored"] == 1 and out["bookmakers_seen"] == ["draftkings", "williamhill_us"]
    assert "bookmakers=williamhill_us" in seen_urls[0]
    row = tmp_db.execute("SELECT * FROM odds").fetchone()
    assert row["bookmaker"] == "Caesars" and row["red_decimal"] == 1.5 and row["blue_decimal"] == 2.7  # corners kept
    assert lifecycle.refresh_odds(tmp_db)["stored"] == 0          # an unchanged line is not stored twice
    # a failing request reports the error without the key, on the public Data Quality page too

    def failing(url, provider, resource, **kw):
        from ufcpred.providers.http import redact
        raise ProviderError(f"HTTP 401 for {redact(url)}")
    monkeypatch.setattr(odds_mod, "fetch", failing)
    err = lifecycle.refresh_odds(tmp_db)
    assert "error" in err and "SECRETKEY123" not in err["error"]
    issues = " ".join(r[0] or "" for r in tmp_db.execute("SELECT message FROM data_quality_issues"))
    assert "SECRETKEY123" not in issues
    from ufcpred.providers.http import redact
    assert redact("https://h/x?apiKey=SECRETKEY123&a=1") == "https://h/x?apiKey=***&a=1"
    monkeypatch.setattr(odds_mod, "fetch", lambda url, provider, resource, **k: (
        '{"message": "quota exceeded"}', SourceMeta(provider, resource, url, utcnow(), "x", "ok", 200, None, "")))
    with pytest.raises(ProviderError):                            # an error object instead of a list of fights
        odds_mod.TheOddsAPIProvider(api_key="k").fetch_odds([])
