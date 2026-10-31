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
