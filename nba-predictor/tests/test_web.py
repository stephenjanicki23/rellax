"""Every screen renders against a database produced by a short synthetic replay."""
import json
from urllib.parse import unquote

from fastapi.testclient import TestClient


def test_all_screens_render(synth):
    conn, truth = synth
    from nbapred.replay import replay
    replay(conn, truth["dates"][150], truth["dates"][154], select_half_life=False, progress=lambda *_: None)
    from nbapred.web.app import app
    c = TestClient(app)
    ev = conn.execute("SELECT event_id FROM prediction_locks LIMIT 1").fetchone()[0]
    game = conn.execute("SELECT game_id FROM predictions LIMIT 1").fetchone()[0]
    team = conn.execute("SELECT home_team_id FROM predictions LIMIT 1").fetchone()[0]
    for url in ["/", "/nights", f"/night/{ev}", f"/game/{game}", "/history", "/reviews", f"/review/{ev}",
                "/learning", "/performance", "/teams", f"/team/{team}", "/data-quality", "/settings", "/edge",
                f"/edge/night/{ev}", "/edge/bets", "/edge/bets.csv", "/api/ledger/verify", f"/api/night/{ev}"]:
        r = c.get(url)
        assert r.status_code == 200, (url, r.text[-800:])
    assert "No upcoming games loaded" in c.get("/").text          # nothing is invented
    card = {"night": {"date": "2099-01-01", "source_url": "https://example.org"},
            "games": [{"home": "Boston Celtics", "away": "Miami Heat"}]}
    r = c.post("/import/night", files={"file": ("night.json", json.dumps(card), "application/json")})
    assert r.status_code == 200 and "night imported" in r.text
    r = c.post("/import/night", files={"file": ("bad.json", json.dumps({"night": {"date": "x"}, "games": []}),
                                                "application/json")})
    assert "rejected" in r.text
    assert "Miami Heat" in c.get("/").text


def test_betting_edge_compares_lines_without_feeding_the_engine(synth):
    conn, truth = synth
    from nbapred.replay import replay
    replay(conn, truth["dates"][150], truth["dates"][152], select_half_life=False, progress=lambda *_: None)
    from nbapred.web.app import app
    c = TestClient(app)
    card = {"night": {"date": "2099-02-01", "source_url": "https://example.org"}, "games": [{"home": "BOS", "away": "MIA"}]}
    c.post("/import/night", files={"file": ("n.json", json.dumps(card), "application/json")})
    ev = conn.execute("SELECT id FROM events WHERE date='2099-02-01'").fetchone()[0]
    c.post("/actions/predict", data={"event_id": ev})
    before = [tuple(x) for x in conn.execute("SELECT id, p_home, content_sha256 FROM predictions WHERE event_id=?", (ev,))]
    assert before
    assert "No lines stored" in c.get(f"/edge/night/{ev}").text
    csv = ("date,home,away,home_ml,away_ml,spread_home,spread_home_price,spread_away_price,total,over_price,under_price,"
           "bookmaker,captured_at\n2099-02-01,BOS,MIA,-200,+170,-5.5,-110,-110,221.5,-110,-110,TestBook,2020-01-01T12:00:00Z\n")
    r = c.post("/import/odds", files={"file": ("odds.csv", csv, "text/csv")}, follow_redirects=False)
    assert "'stored': 1" in unquote(r.headers["location"])
    page = c.get(f"/edge/night/{ev}").text
    assert "Expected return" in page and "TestBook" in page and "Spread" in page and "Total 221.5" in page
    after = [tuple(x) for x in conn.execute("SELECT id, p_home, content_sha256 FROM predictions WHERE event_id=?", (ev,))]
    assert after == before
    # both markets are tracked and every betting screen renders them
    from nbapred import betting
    betting.sync(conn)
    assert {r["strategy"] for r in betting.bets(conn)} == {"moneyline", "spread"}
    spread_bet = betting.bets(conn, "spread")[0]
    for url, text in [("/edge", "Point spread"), ("/edge?market=spread", "cover"), (f"/edge/bets?market=spread&tier={spread_bet['tier']}", "Spread"),
                      (f"/edge/night/{ev}", "Spread"), (f"/edge/bet/{spread_bet['id']}", "Line taken"),
                      (f"/edge/bets.csv?market=spread&tier={spread_bet['tier']}", "\r\n" + str(spread_bet["id"]) + ",spread,")]:
        r = c.get(url)
        assert r.status_code == 200 and text in r.text, (url, r.text[-800:])


def test_game_day_form_records_absences_and_repredicts(synth):
    conn, truth = synth
    from nbapred.replay import replay
    replay(conn, truth["dates"][150], truth["dates"][151], select_half_life=False, progress=lambda *_: None)
    from nbapred.web.app import app
    c = TestClient(app)
    card = {"night": {"date": "2099-02-02", "source_url": "https://example.org"}, "games": [{"home": "BOS", "away": "MIA"}]}
    c.post("/import/night", files={"file": ("n.json", json.dumps(card), "application/json")})
    ev = conn.execute("SELECT id FROM events WHERE date='2099-02-02'").fetchone()[0]
    c.post("/actions/predict", data={"event_id": ev})
    gid = conn.execute("SELECT id FROM games WHERE event_id=?", (ev,)).fetchone()[0]
    r = c.post(f"/game/{gid}/gameday", data={"home_out": "2", "away_out": "0", "source": ""}, follow_redirects=False)
    assert "refused" in unquote(r.headers["location"])
    r = c.post(f"/game/{gid}/gameday", data={"home_out": "2", "away_out": "0", "source": "injury report"},
               follow_redirects=False)
    assert "re-predicted" in unquote(r.headers["location"])
    g = conn.execute("SELECT home_out, away_out FROM games WHERE id=?", (gid,)).fetchone()
    assert (g[0], g[1]) == (2, 0)
    assert conn.execute("SELECT MAX(version) FROM predictions WHERE game_id=?", (gid,)).fetchone()[0] == 2
