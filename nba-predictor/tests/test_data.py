"""Providers, validation and ingest: identity, duplicates, revisions, reconciliation, missing data."""
import json
import shutil
from pathlib import Path

import pytest

from nbapred import teams as T
from nbapred.ingest import ingest_bundle, ingest_manual_odds, ingest_manual_results, record_result
from nbapred.providers import espn, manual
from nbapred.providers.nba_mirror import NBAMirrorProvider
from nbapred.providers.odds import devig, parse_the_odds_api

FIX = Path(__file__).parent / "fixtures"


def _mirror(tmp_path):
    d = tmp_path / "mirror"
    d.mkdir()
    shutil.copy(FIX / "mirror_regular.csv", d / "regular_season_totals_2010_2024.csv")
    shutil.copy(FIX / "mirror_playoffs.csv", d / "play_off_totals_2010_2024.csv")
    return NBAMirrorProvider(local_dir=str(d)).fetch_history()


def test_team_aliases_cover_old_names_and_espn_codes():
    for alias, abbr in [("NJN", "BKN"), ("Charlotte Bobcats", "CHA"), ("NOH", "NOP"), ("GS", "GSW"), ("UTAH", "UTA"),
                        ("WSH", "WAS"), ("NY", "NYK"), ("SA", "SAS"), ("LA Clippers", "LAC"), ("Los Angeles Lakers", "LAL")]:
        assert T.abbr(T.lookup(alias)) == abbr, alias
    assert T.lookup("Springfield Isotopes") is None
    assert T.season_of("2025-11-05") == "2025-26" and T.season_of("2026-04-10") == "2025-26"


def test_mirror_parser_pairs_rows_marks_bubble_and_drops_duplicates(tmp_path):
    b = _mirror(tmp_path)
    by = {g.external_id: g for g in b.games}
    assert set(by) == {"nba:0022300001", "nba:0021901281"}            # GSW row without opponent is skipped
    g = by["nba:0022300001"]
    assert (g.home_name, g.away_name) == ("New York Knicks", "Boston Celtics") and not g.neutral_site
    bubble = by["nba:0021901281"]
    assert bubble.neutral_site and bubble.venue_city == "Orlando bubble"
    res = {r.game_external_id: r for r in b.results}
    assert (res["nba:0022300001"].home_score, res["nba:0022300001"].away_score) == (104, 108)
    assert res["nba:0021901281"].periods == 5                          # 53 minutes = one overtime
    assert any(i[2] == "incomplete_game" for i in b.issues)


def test_ingest_is_idempotent_and_completes_nights(tmp_db, tmp_path):
    b = _mirror(tmp_path)
    first = ingest_bundle(tmp_db, b)
    assert first["games_new"] == 2 and first["results_new"] == 2 and first["stats_rows"] == 4
    again = ingest_bundle(tmp_db, b)
    assert again["games_new"] == 0 and again["results_new"] == 0 and again["stats_rows"] == 0
    assert {r[0] for r in tmp_db.execute("SELECT status FROM events")} == {"completed"}


def test_result_revisions_keep_history(tmp_db, tmp_path):
    ingest_bundle(tmp_db, _mirror(tmp_path))
    gid = tmp_db.execute("SELECT id FROM games WHERE external_id='nba:0022300001'").fetchone()[0]
    assert record_result(tmp_db, gid, "win", 104, 108) == "unchanged"
    assert record_result(tmp_db, gid, "win", 110, 108, reason="scoring correction") == "revised"
    revs = tmp_db.execute("SELECT revision, winner_team_id FROM game_results WHERE game_id=? ORDER BY revision",
                          (gid,)).fetchall()
    assert len(revs) == 2 and revs[0][1] != revs[1][1]
    with pytest.raises(ValueError):
        record_result(tmp_db, gid, "win", 100, 100)                   # NBA games cannot end tied


def test_espn_scoreboard_final_and_summary_box_scores(tmp_db):
    payload = json.loads((FIX / "espn_scoreboard_final.json").read_text())
    b = espn.parse_scoreboard(payload, "2025-11-04", "fixture")
    assert len(b.games) == 2 and len(b.results) == 2
    g = {x.external_id: x for x in b.games}["espn:401700001"]
    assert (g.home_name, g.away_name, g.season) == ("New York Knicks", "Boston Celtics", "2025-26")
    ot = {r.game_external_id: r for r in b.results}["espn:401700002"]
    assert ot.periods == 5 and ot.away_score == 121
    home_stats = next(s for s in b.stats if s.game_external_id == "espn:401700001" and s.side == "home").stats
    assert home_stats["fga"] == 88 and home_stats["oreb"] is None and home_stats["tov"] is None   # unknown, not zero
    ingest_bundle(tmp_db, b)
    from nbapred.ingest import games_missing_box, store_stats
    missing = games_missing_box(tmp_db, 10)
    assert {r["external_id"] for r in missing} == {"espn:401700001", "espn:401700002"}
    rows = espn.parse_summary(json.loads((FIX / "espn_summary.json").read_text()), "espn:401700001")
    away = next(r for r in rows if r.side == "away").stats
    assert (away["fgm"], away["fga"], away["oreb"], away["tov"]) == (38, 90, 11, 13)
    games = {r["external_id"]: r for r in tmp_db.execute("SELECT * FROM games")}
    store_stats(tmp_db, rows, games)
    assert {r["external_id"] for r in games_missing_box(tmp_db, 10)} == {"espn:401700002"}


def test_espn_upcoming_lines_neutral_site_and_postponement(tmp_db):
    payload = json.loads((FIX / "espn_scoreboard_upcoming.json").read_text())
    b = espn.parse_scoreboard(payload, "2099-01-10", "fixture")
    odds = {o.game_external_id: o for o in b.odds}
    gs = odds["espn:401800010"]
    assert gs.spread_home == -7.5 and gs.total == 229.5
    assert gs.home_decimal == pytest.approx(1 + 100 / 310) and gs.away_decimal == pytest.approx(3.5)
    mx = odds["espn:401800011"]
    assert mx.spread_home == -3.5 and mx.total == 231.5 and mx.home_decimal == pytest.approx(1 + 100 / 150)
    games = {g.external_id: g for g in b.games}
    assert games["espn:401800011"].neutral_site and games["espn:401800011"].venue_city == "Mexico City"
    assert games["espn:401800012"].status == "postponed"
    out = ingest_bundle(tmp_db, b, reconcile_nights=True)
    assert out["odds_new"] == 2
    ev = tmp_db.execute("SELECT * FROM events").fetchone()
    assert ev["start_time_utc"] == "2099-01-11T00:00Z" and ev["status"] == "scheduled"


def test_manual_card_validation_and_merge_with_provider(tmp_db):
    bad = {"night": {"date": "2099-01-10"}, "games": [{"home": "GSW", "away": "GSW"}, {"home": "Isotopes", "away": "BOS"}]}
    with pytest.raises(manual.ValidationError) as e:
        manual.parse_card(json.dumps(bad), "json")
    msg = " ".join(e.value.errors)
    assert "source_url" in msg and "cannot play itself" in msg and "unknown team" in msg
    card = {"night": {"date": "2099-01-10", "source_url": "https://nba.com/schedule"},
            "games": [{"home": "Golden State Warriors", "away": "UTA", "home_out": 2}]}
    ingest_bundle(tmp_db, manual.parse_card(json.dumps(card), "json"))
    payload = json.loads((FIX / "espn_scoreboard_upcoming.json").read_text())
    out = ingest_bundle(tmp_db, espn.parse_scoreboard(payload, "2099-01-10", "fixture"), reconcile_nights=True)
    assert out["merged"] == 1                                         # same game: attached, not duplicated
    g = tmp_db.execute("""SELECT g.* FROM games g JOIN teams t ON t.id=g.home_team_id WHERE t.abbr='GSW'""").fetchall()
    assert len(g) == 1 and g[0]["home_out"] == 2 and g[0]["tip_time_utc"] == "2099-01-11T00:00Z"


def test_manual_results_and_odds_import(tmp_db):
    card = {"night": {"date": "2099-01-10", "source_url": "x"}, "games": [{"home": "BOS", "away": "MIA"}]}
    ingest_bundle(tmp_db, manual.parse_card(json.dumps(card), "json"))
    with pytest.raises(manual.ValidationError):
        manual.parse_results("date,home,away,home_score,away_score,source_url\n2099-01-10,BOS,MIA,100,100,x\n")
    rows = manual.parse_odds("date,home,away,home_ml,away_ml,spread_home,total,bookmaker\n"
                             "2099-01-10,BOS,MIA,-200,+170,-5.5,221.5,TestBook\n")
    assert ingest_manual_odds(tmp_db, rows)["stored"] == 1
    assert ingest_manual_odds(tmp_db, rows)["unchanged"] == 1
    res = manual.parse_results("date,home,away,home_score,away_score,periods,source_url\n"
                               "2099-01-10,Boston Celtics,Miami Heat,101,99,5,https://nba.com\n")
    assert ingest_manual_results(tmp_db, res)["new"] == 1
    r = tmp_db.execute("SELECT * FROM game_results").fetchone()
    assert r["periods"] == 5 and r["winner_team_id"] == tmp_db.execute("SELECT id FROM teams WHERE abbr='BOS'").fetchone()[0]


def test_devig_and_the_odds_api_parser():
    ph, pa, over = devig(1.5, 2.8)
    assert abs(ph + pa - 1) < 1e-12 and over > 0
    data = [{"home_team": "Boston Celtics", "away_team": "Miami Heat", "bookmakers": [
        {"key": "williamhill_us", "title": "Caesars", "markets": [
            {"key": "h2h", "outcomes": [{"name": "Boston Celtics", "price": 1.4}, {"name": "Miami Heat", "price": 3.1}]},
            {"key": "spreads", "outcomes": [{"name": "Boston Celtics", "price": 1.91, "point": -7.5},
                                            {"name": "Miami Heat", "price": 1.91, "point": 7.5}]},
            {"key": "totals", "outcomes": [{"name": "Over", "price": 1.9, "point": 220.5},
                                           {"name": "Under", "price": 1.92, "point": 220.5}]}]}]}]
    b = parse_the_odds_api(data, [{"external_id": "7", "home_name": "Boston Celtics", "away_name": "Miami Heat"}])
    o = b.odds[0]
    assert (o.home_decimal, o.spread_home, o.total, o.under_decimal) == (1.4, -7.5, 220.5, 1.92)
