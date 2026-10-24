"""Deployment concerns: write protection, Vercel limits, SQL translation, portable export/import."""
from urllib.parse import unquote

from fastapi.testclient import TestClient

from ufcpred import db
from ufcpred.db import _translate


def test_sql_translation_for_postgres():
    assert _translate("SELECT * FROM t WHERE a=? AND b LIKE ?") == "SELECT * FROM t WHERE a=%s AND b LIKE %s"
    assert _translate("INSERT INTO events(name) VALUES (?)").endswith("RETURNING id")
    assert not _translate("INSERT INTO fight_stats(fight_id) VALUES (?)").endswith("RETURNING id")
    assert "100%%" in _translate("SELECT '100%' AS x")


def test_writes_need_admin_token_when_configured(tmp_db, monkeypatch):
    monkeypatch.setenv("UFCPRED_ADMIN_TOKEN", "s3cret-token")
    from ufcpred.web.app import app
    c = TestClient(app)
    assert c.get("/").status_code == 200                       # reads stay public
    r = c.post("/actions/backup", follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"].startswith("/login")
    assert c.post("/login", data={"token": "wrong"}, follow_redirects=False).headers["location"].startswith("/login")
    r = c.post("/login", data={"token": "s3cret-token"}, follow_redirects=False)
    assert r.headers["location"] == "/settings" and "ufcpred_admin" in r.cookies
    r = c.post("/actions/backup", follow_redirects=False)
    assert "backup written" in unquote(r.headers["location"])


def test_vercel_refuses_writes_without_token_and_heavy_jobs(tmp_db, monkeypatch):
    monkeypatch.setenv("VERCEL", "1")
    monkeypatch.delenv("UFCPRED_ADMIN_TOKEN", raising=False)
    from ufcpred.web.app import app
    c = TestClient(app, base_url="https://testserver")      # the admin cookie is Secure on Vercel
    r = c.post("/settings", data={}, follow_redirects=False)
    assert r.status_code == 303 and "disabled" in unquote(r.headers["location"])
    monkeypatch.setenv("UFCPRED_ADMIN_TOKEN", "tok")
    c.post("/login", data={"token": "tok"})
    for name in ("refresh_history", "tick", "backup"):
        r = c.post(f"/actions/{name}", follow_redirects=False)
        assert "GitHub Actions" in unquote(r.headers["location"]), name
    r = c.post("/learning/run", data={"mode": "live"}, follow_redirects=False)
    assert "GitHub Actions" in unquote(r.headers["location"])


def test_private_mode_hides_reads(tmp_db, monkeypatch):
    monkeypatch.setenv("UFCPRED_ADMIN_TOKEN", "tok")
    monkeypatch.setenv("UFCPRED_PRIVATE", "1")
    from ufcpred.web.app import app
    c = TestClient(app)
    assert c.get("/", follow_redirects=False).headers["location"] == "/login"


def test_export_import_round_trip(synth, tmp_path, fresh_db):
    conn, truth = synth
    from ufcpred.replay import replay
    replay(conn, truth["dates"][82], truth["dates"][84], select_half_life=False, progress=lambda *_: None)
    counts = {t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("fights", "predictions",
                                                                                 "prediction_lock_members")}
    dump = db.export_json(conn, str(tmp_path / "dump.jsonl.gz"))
    c2 = fresh_db(conn)
    db.import_json(c2, dump)
    assert {t: c2.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in counts} == counts
    from ufcpred import ledger
    assert ledger.verify(c2)["ok"]
    # identity sequences continue after the imported ids
    nid = c2.execute("INSERT INTO audit_log(ts, actor, action) VALUES ('t','test','x')").lastrowid
    assert nid > max(r[0] for r in c2.execute("SELECT id FROM audit_log WHERE action<>'x'"))
    try:
        db.import_json(c2, dump)
        raise AssertionError("import into a non-empty database must be refused")
    except RuntimeError:
        pass
