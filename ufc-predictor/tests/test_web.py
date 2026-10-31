"""Every screen renders against a database produced by a short synthetic replay."""
import json

from fastapi.testclient import TestClient


def test_all_screens_render(synth, monkeypatch):
    conn, truth = synth
    from ufcpred.replay import replay
    replay(conn, truth["dates"][82], truth["dates"][86], select_half_life=False, progress=lambda *_: None)
    from ufcpred.web.app import app
    c = TestClient(app)
    ev = conn.execute("SELECT event_id FROM prediction_locks LIMIT 1").fetchone()[0]
    fight = conn.execute("SELECT fight_id FROM predictions LIMIT 1").fetchone()[0]
    fighter = conn.execute("SELECT red_fighter_id FROM predictions LIMIT 1").fetchone()[0]
    for url in ["/", "/events", f"/event/{ev}", f"/fight/{fight}", "/history", "/reviews", f"/review/{ev}",
                "/learning", "/performance", "/fighters", "/fighters?q=Synthetic", f"/fighter/{fighter}",
                "/data-quality", "/settings", "/api/ledger/verify", f"/api/event/{ev}"]:
        r = c.get(url)
        assert r.status_code == 200, (url, r.text[-800:])
    assert "No upcoming event yet" in c.get("/").text          # nothing is invented
    card = {"event": {"name": "Web Import Night", "date": "2099-01-01", "source_url": "https://example.org"},
            "fights": [{"red": "Synthetic Fighter 1", "blue": "Synthetic Fighter 2", "weight_class": "Lightweight",
                        "scheduled_rounds": 3}]}
    r = c.post("/import/card", files={"file": ("card.json", json.dumps(card), "application/json")})
    assert r.status_code == 200 and "card imported" in r.text
    r = c.post("/import/card", files={"file": ("bad.json", json.dumps({"event": {"name": "x"}, "fights": []}), "application/json")})
    assert "rejected" in r.text
    assert "Web Import Night" in c.get("/").text


def test_betting_edge_compares_odds_without_feeding_the_engine(synth):
    conn, truth = synth
    from ufcpred.replay import replay
    replay(conn, truth["dates"][82], truth["dates"][84], select_half_life=False, progress=lambda *_: None)
    from ufcpred.web.app import app
    c = TestClient(app)
    card = {"event": {"name": "Odds Night", "date": "2099-02-01", "source_url": "https://example.org"},
            "fights": [{"red": "Synthetic Fighter 1", "blue": "Synthetic Fighter 2", "weight_class": "Lightweight",
                        "scheduled_rounds": 3}]}
    c.post("/import/card", files={"file": ("card.json", json.dumps(card), "application/json")})
    ev = conn.execute("SELECT id FROM events WHERE name='Odds Night'").fetchone()[0]
    c.post("/actions/predict", data={"event_id": ev})
    before = conn.execute("SELECT id, p_red, content_sha256 FROM predictions WHERE event_id=? AND mode='live'",
                          (ev,)).fetchall()
    assert before
    assert "No odds imported" in c.get("/edge").text
    csv = ("event_date,red,blue,red_odds,blue_odds,format,bookmaker,captured_at,source_url\n"
           "2099-02-01,Synthetic Fighter 2,Synthetic Fighter 1,+400,-600,american,TestBook,2020-01-01T12:00:00Z,\n")
    r = c.post("/import/odds", files={"file": ("odds.csv", csv, "text/csv")}, follow_redirects=False)
    from urllib.parse import unquote
    assert "'stored': 1" in unquote(r.headers["location"])
    page = c.get("/edge").text
    assert "Expected return" in page and "TestBook" in page
    # importing odds changes nothing the engine produced, and re-predicting does not use them either
    after = conn.execute("SELECT id, p_red, content_sha256 FROM predictions WHERE event_id=? AND mode='live'",
                         (ev,)).fetchall()
    assert [tuple(x) for x in after] == [tuple(x) for x in before]
    c.post("/actions/predict", data={"event_id": ev})
    newest = conn.execute("SELECT p_red, payload_json FROM predictions WHERE event_id=? AND mode='live' "
                          "ORDER BY id DESC LIMIT 1", (ev,)).fetchone()
    assert abs(newest[0] - before[-1][1]) < 1e-9
    assert json.loads(newest[1])["market"]["used_in_model"] is False
    # corners swapped in the odds file are matched to the right fighters
    from ufcpred import services
    e = services.betting_edge(conn, ev)["rows"][0]["edge"]
    red = next(s for s in e["sides"] if s["side"] == "red")
    assert red["american"] == -600 and red["market"] > 0.8
