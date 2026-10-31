"""FastAPI web application: dashboard and analysis screens (server-rendered)."""
from __future__ import annotations

import hashlib
import hmac
import os
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from .. import db, ledger, lifecycle, predict, review, services
from ..config import DEFAULT_SETTINGS, env_status, setting
from ..features.build import StateCache
from ..features.history import HistoryStore, fighter_state
from ..ingest import ingest_bundle, ingest_corrections, ingest_manual_odds, ingest_manual_results
from ..learning import loop
from ..models import registry
from ..providers import manual
from ..util import loads, utcnow
from . import charts, plain

HERE = Path(__file__).parent
app = FastAPI(title="UFC Prediction Engine")
app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")
templates = Jinja2Templates(directory=HERE / "templates")
T = templates.env
T.filters["pct"] = lambda v, d=0: "—" if v is None else f"{v * 100:.{d}f}%"
T.filters["f"] = lambda v, d=3: "—" if v is None else f"{v:.{d}f}"
T.filters["method"] = lambda m: services.METHOD_LABEL.get(m, m or "—")
T.filters["loads"] = lambda s: loads(s, {})
T.filters["clock"] = lambda s: "—" if s is None else f"{s // 60}:{s % 60:02d}"
T.globals.update(charts=charts, now=lambda: utcnow())
plain.install(T)

# ------------------------------------------------------------------ access control
# Reads are public unless UFCPRED_PRIVATE=1. Every write (POST) needs the admin token when
# UFCPRED_ADMIN_TOKEN is set; on Vercel, writes are refused outright until a token is set.
ADMIN_COOKIE = "ufcpred_admin"
HEAVY_ON_VERCEL = {"refresh_history", "tick", "backup"}
JOBS_HINT = ("runs in GitHub Actions on Vercel deployments: Actions → “UFC Predictor jobs” → Run workflow "
             "(a serverless request cannot finish it within its time limit)")


def _token() -> str | None:
    return os.environ.get("UFCPRED_ADMIN_TOKEN") or None


def _cookie_value(token: str) -> str:
    return hashlib.sha256(("ufcpred:" + token).encode()).hexdigest()


def is_admin(request: Request) -> bool:
    tok = _token()
    if tok is None:
        return not db.on_vercel()
    return hmac.compare_digest(request.cookies.get(ADMIN_COOKIE, ""), _cookie_value(tok))


@app.middleware("http")
async def access_control(request: Request, call_next):
    path = request.url.path
    if path.startswith(("/login", "/logout", "/static")):
        return await call_next(request)
    if request.method == "POST" and not is_admin(request):
        msg = ("Writes are disabled: set UFCPRED_ADMIN_TOKEN in the Vercel project, then log in."
               if _token() is None else "Log in with the admin token to make changes.")
        return RedirectResponse(f"/login?msg={msg}", status_code=303)
    if os.environ.get("UFCPRED_PRIVATE") == "1" and not is_admin(request):
        return RedirectResponse("/login", status_code=303)
    return await call_next(request)


@app.get("/login", response_class=HTMLResponse)
def login_page(request: Request, msg: str = ""):
    return render(request, "login.html", msg=msg, token_configured=_token() is not None)


@app.post("/login")
def login(token: str = Form(...)):
    tok = _token()
    if tok is None or not hmac.compare_digest(token, tok):
        return RedirectResponse("/login?msg=Wrong token", status_code=303)
    r = RedirectResponse("/settings", status_code=303)
    r.set_cookie(ADMIN_COOKIE, _cookie_value(tok), httponly=True, secure=db.on_vercel(), samesite="lax",
                 max_age=30 * 86400)
    return r


@app.get("/logout")
def logout():
    r = RedirectResponse("/", status_code=303)
    r.delete_cookie(ADMIN_COOKIE)
    return r


def get_db():
    conn = db.connect()
    try:
        yield conn
    finally:
        conn.close()


def render(request: Request, name: str, **ctx):
    return templates.TemplateResponse(request, name, {"page": name.split(".")[0], "admin": is_admin(request),
                                                      "on_vercel": db.on_vercel(), **ctx})


# ------------------------------------------------------------------ dashboard
@app.get("/", response_class=HTMLResponse)
def dashboard(request: Request, conn=Depends(get_db)):
    mode = services.preferred_mode(conn)
    nxt = services.upcoming_event(conn)
    card = services.event_card(conn, nxt["id"], "live") if nxt else None
    shown_replay = None
    if not nxt:
        ev = services.latest_replayed_event(conn)
        shown_replay = services.event_card(conn, ev["id"], "replay") if ev else None
    perf = services.performance(conn, mode)
    return render(request, "dashboard.html", next=nxt, card=card, replay_card=shown_replay, perf=perf, mode=mode,
                  counts=services.counts(conn), model=services.model_status(conn),
                  comparison=services.latest_promotion_comparison(conn),
                  upcoming_provider=setting(conn, "providers.upcoming"))


@app.get("/events", response_class=HTMLResponse)
def events(request: Request, conn=Depends(get_db), page: int = 0):
    rows = conn.execute(
        """SELECT e.*, (SELECT COUNT(*) FROM fights f WHERE f.event_id=e.id) AS n_fights,
                  (SELECT COUNT(*) FROM prediction_locks l WHERE l.event_id=e.id) AS n_locks
           FROM events e ORDER BY e.date DESC LIMIT 50 OFFSET ?""", (page * 50,)).fetchall()
    return render(request, "events.html", events=rows, page_no=page)


@app.get("/event/{event_id}", response_class=HTMLResponse)
def event(request: Request, event_id: int, mode: str | None = None, conn=Depends(get_db)):
    card = services.event_card(conn, event_id, mode)
    if card is None:
        raise HTTPException(404)
    return render(request, "event.html", card=card, lock_at=lifecycle.lock_time(conn, card["event"]))


@app.get("/fight/{fight_id}", response_class=HTMLResponse)
def fight(request: Request, fight_id: int, mode: str | None = None, version: int | None = None, conn=Depends(get_db)):
    f = conn.execute("""SELECT f.*, e.name AS event_name, e.date, fr.name AS red_name, fb.name AS blue_name
                        FROM fights f JOIN events e ON e.id=f.event_id JOIN fighters fr ON fr.id=f.red_fighter_id
                        JOIN fighters fb ON fb.id=f.blue_fighter_id WHERE f.id=?""", (fight_id,)).fetchone()
    if f is None:
        raise HTTPException(404)
    if mode is None:
        mode = "live" if conn.execute("SELECT 1 FROM predictions WHERE fight_id=? AND mode='live'",
                                      (fight_id,)).fetchone() else "replay"
    versions = conn.execute("SELECT * FROM predictions WHERE fight_id=? AND mode=? ORDER BY version",
                            (fight_id, mode)).fetchall()
    pred = next((v for v in versions if v["version"] == version), versions[-1] if versions else None)
    official = {p["id"] for p in ledger.official_predictions(conn, f["event_id"], mode)}
    res = conn.execute("SELECT * FROM fight_results WHERE fight_id=? ORDER BY revision", (fight_id,)).fetchall()
    evals = conn.execute("""SELECT e.*, d.report_json, d.category FROM prediction_evaluations e
                            LEFT JOIN error_diagnostics d ON d.evaluation_id=e.id
                            WHERE e.prediction_id IN (SELECT id FROM predictions WHERE fight_id=? AND mode=?)
                            ORDER BY e.id""", (fight_id, mode)).fetchall()
    mv = conn.execute("SELECT label, config_json FROM model_versions WHERE id=?",
                      (pred["model_version_id"],)).fetchone() if pred else None
    return render(request, "fight.html", f=f, mode=mode, versions=versions, pred=pred,
                  payload=loads(pred["payload_json"]) if pred else None, official=official, results=res,
                  evals=evals, model=mv)


# ------------------------------------------------------------------ history & review
@app.get("/history", response_class=HTMLResponse)
def history(request: Request, mode: str | None = None, page: int = 0, conn=Depends(get_db)):
    mode = mode or services.preferred_mode(conn)
    rows = conn.execute(
        """SELECT p.*, ev.name AS event_name, ev.date, fr.name AS red_name, fb.name AS blue_name,
                  r.outcome, r.winner_fighter_id, r.method AS actual_method, r.end_round, r.end_time_sec,
                  e.correct_winner, e.log_loss, e.brier, e.method_correct, e.round_correct, e.scored
           FROM predictions p JOIN events ev ON ev.id=p.event_id JOIN fighters fr ON fr.id=p.red_fighter_id
           JOIN fighters fb ON fb.id=p.blue_fighter_id
           LEFT JOIN prediction_evaluations e ON e.prediction_id=p.id
           LEFT JOIN fight_results r ON r.id=e.result_id
           WHERE p.mode=? AND p.id IN (SELECT m.prediction_id FROM prediction_lock_members m)
           ORDER BY ev.date DESC, p.fight_id LIMIT 100 OFFSET ?""", (mode, page * 100)).fetchall()
    return render(request, "history.html", rows=rows, mode=mode, page_no=page)


@app.get("/reviews", response_class=HTMLResponse)
def reviews(request: Request, mode: str | None = None, conn=Depends(get_db)):
    mode = mode or services.preferred_mode(conn)
    rows = conn.execute(
        """SELECT ev.id, ev.name, ev.date, COUNT(e.id) AS graded, SUM(e.correct_winner) AS correct,
                  AVG(e.log_loss) AS ll, AVG(e.brier) AS brier, SUM(e.method_correct) AS mc
           FROM prediction_locks l JOIN events ev ON ev.id=l.event_id
           LEFT JOIN predictions p ON p.event_id=ev.id AND p.mode=l.mode
           LEFT JOIN prediction_evaluations e ON e.prediction_id=p.id AND e.scored=1
           WHERE l.mode=? GROUP BY ev.id ORDER BY ev.date DESC LIMIT 200""", (mode,)).fetchall()
    return render(request, "reviews.html", rows=rows, mode=mode)


@app.get("/review/{event_id}", response_class=HTMLResponse)
def review_page(request: Request, event_id: int, mode: str | None = None, conn=Depends(get_db)):
    card = services.event_card(conn, event_id, mode)
    if card is None:
        raise HTTPException(404)
    diags = {r["prediction_id"]: r for r in conn.execute(
        "SELECT * FROM error_diagnostics WHERE prediction_id IN (SELECT id FROM predictions WHERE event_id=? AND mode=?)",
        (event_id, card["mode"]))}
    reports = conn.execute("SELECT * FROM analyst_reports WHERE event_id=? ORDER BY id DESC LIMIT 1", (event_id,)).fetchall()
    return render(request, "review.html", card=card, diags=diags, reports=reports)


# ------------------------------------------------------------------ learning & models
@app.get("/learning", response_class=HTMLResponse)
def learning(request: Request, conn=Depends(get_db)):
    runs = conn.execute("SELECT * FROM learning_runs ORDER BY id DESC LIMIT 30").fetchall()
    latest_h = conn.execute("""SELECT * FROM weakness_hypotheses WHERE learning_run_id=(SELECT MAX(learning_run_id)
                               FROM weakness_hypotheses) ORDER BY status DESC, q_value""").fetchall()
    cands = conn.execute("""SELECT c.*, lr.as_of FROM candidate_changes c JOIN learning_runs lr ON lr.id=c.learning_run_id
                            ORDER BY c.id DESC LIMIT 60""").fetchall()
    decisions = conn.execute("""SELECT d.*, mi.label AS inc_label, mc.label AS cand_label FROM promotion_decisions d
                                LEFT JOIN model_versions mi ON mi.id=d.incumbent_version_id
                                LEFT JOIN model_versions mc ON mc.id=d.candidate_version_id ORDER BY d.id DESC LIMIT 60""").fetchall()
    versions = conn.execute("SELECT id, label, status, training_cutoff, n_train, notes, created_at, activated_at, parent_id, "
                            "config_json FROM model_versions ORDER BY id DESC").fetchall()
    report = conn.execute("SELECT * FROM analyst_reports ORDER BY id DESC LIMIT 1").fetchone()
    return render(request, "learning.html", runs=runs, hyps=latest_h, cands=cands, decisions=decisions,
                  versions=versions, report=report, model=services.model_status(conn),
                  promotion_mode=setting(conn, "promotion.mode"))


@app.post("/learning/run")
def learning_run(conn=Depends(get_db), mode: str = Form("live"), force: bool = Form(False)):
    if db.on_vercel():
        return RedirectResponse(f"/settings?msg=The learning loop {JOBS_HINT}", status_code=303)
    loop.run_learning(conn, utcnow()[:10], mode, None, force=force)
    return RedirectResponse("/learning", status_code=303)


@app.post("/learning/approve/{cc_id}")
def learning_approve(cc_id: int, conn=Depends(get_db)):
    loop.approve_candidate(conn, cc_id)
    return RedirectResponse("/learning", status_code=303)


@app.post("/models/rollback/{version_id}")
def rollback(version_id: int, reason: str = Form("manual rollback from Learning Center"), conn=Depends(get_db)):
    registry.rollback(conn, version_id, actor="user", reason=reason)
    return RedirectResponse("/learning", status_code=303)


@app.get("/edge", response_class=HTMLResponse)
def edge(request: Request, event: int | None = None, conn=Depends(get_db)):
    ev = conn.execute("SELECT * FROM events WHERE id=?", (event,)).fetchone() if event else services.edge_event(conn)
    data = services.betting_edge(conn, ev["id"]) if ev else None
    return render(request, "edge.html", data=data, record=services.betting_track_record(conn),
                  edge_min=services.EDGE_MIN)


@app.get("/performance", response_class=HTMLResponse)
def performance(request: Request, mode: str | None = None, conn=Depends(get_db)):
    mode = mode or services.preferred_mode(conn)
    return render(request, "performance.html", perf=services.performance(conn, mode), mode=mode,
                  comparison=services.latest_promotion_comparison(conn))


# ------------------------------------------------------------------ fighters
@app.get("/fighters", response_class=HTMLResponse)
def fighters(request: Request, q: str = "", conn=Depends(get_db)):
    rows = []
    if q:
        rows = conn.execute("""SELECT f.*, (SELECT COUNT(*) FROM fights x WHERE x.red_fighter_id=f.id OR x.blue_fighter_id=f.id)
                               AS n FROM fighters f WHERE LOWER(f.name) LIKE LOWER(?) ORDER BY n DESC LIMIT 100""", (f"%{q}%",)).fetchall()
    else:
        rows = conn.execute("""SELECT f.*, COUNT(*) AS n, MAX(e.date) AS last FROM fighters f JOIN fights x ON
                               (x.red_fighter_id=f.id OR x.blue_fighter_id=f.id) JOIN events e ON e.id=x.event_id
                               GROUP BY f.id ORDER BY last DESC LIMIT 60""").fetchall()
    return render(request, "fighters.html", rows=rows, q=q)


@app.get("/fighter/{fighter_id}", response_class=HTMLResponse)
def fighter(request: Request, fighter_id: int, conn=Depends(get_db)):
    f = conn.execute("SELECT * FROM fighters WHERE id=?", (fighter_id,)).fetchone()
    if f is None:
        raise HTTPException(404)
    h = HistoryStore.load(conn)
    today = utcnow()[:10]
    st = fighter_state(h, fighter_id, today)
    fights = conn.execute(
        """SELECT x.*, e.date, e.name AS event_name, r.outcome, r.winner_fighter_id, r.method, r.end_round, r.end_time_sec,
                  CASE WHEN x.red_fighter_id=? THEN x.blue_fighter_id ELSE x.red_fighter_id END AS opp_id,
                  o.name AS opp_name
           FROM fights x JOIN events e ON e.id=x.event_id
           LEFT JOIN fight_results r ON r.fight_id=x.id AND r.revision=(SELECT MAX(revision) FROM fight_results WHERE fight_id=x.id)
           JOIN fighters o ON o.id = CASE WHEN x.red_fighter_id=? THEN x.blue_fighter_id ELSE x.red_fighter_id END
           WHERE x.red_fighter_id=? OR x.blue_fighter_id=? ORDER BY e.date DESC""",
        (fighter_id, fighter_id, fighter_id, fighter_id)).fetchall()
    per = {}
    for s in conn.execute("""SELECT fight_id, SUM(sig_l) sl, SUM(td_l) tl, SUM(ctrl_sec) c, SUM(kd) kd FROM fight_stats
                             WHERE fighter_id=? GROUP BY fight_id""", (fighter_id,)):
        per[s["fight_id"]] = dict(s)
    opp = {}
    ids = [x["id"] for x in fights]
    if ids:
        for s in conn.execute(f"""SELECT fight_id, SUM(sig_l) sl, SUM(td_l) tl FROM fight_stats WHERE fighter_id<>?
                                  AND fight_id IN ({','.join('?' * len(ids))}) GROUP BY fight_id""", (fighter_id, *ids)):
            opp[s["fight_id"]] = dict(s)
    # trend: point-in-time Elo and striking differential after each fight
    trend = []
    for r in h.records.get(fighter_id, []):
        trend.append({"i": len(trend) + 1, "date": r.date, "elo": r.elo_pre + h.elo_k * ((r.result or 0.5) - r.expected)
                      if r.result is not None else r.elo_pre, "n": 1})
    corr = conn.execute("SELECT * FROM fighter_corrections WHERE fighter_id=?", (fighter_id,)).fetchall()
    issues = conn.execute("SELECT * FROM data_quality_issues WHERE entity='fighter' AND entity_id=?",
                          (str(fighter_id),)).fetchall()
    return render(request, "fighter.html", f=f, st=st, fights=fights, per=per, opp=opp, trend=trend, corr=corr,
                  issues=issues, today=today)


# ------------------------------------------------------------------ data quality & settings
@app.get("/data-quality", response_class=HTMLResponse)
def data_quality(request: Request, kind: str | None = None, conn=Depends(get_db)):
    summary = conn.execute("""SELECT kind, severity, COUNT(*) n FROM data_quality_issues WHERE resolved_at IS NULL
                              GROUP BY kind, severity ORDER BY severity='error' DESC, n DESC""").fetchall()
    q = "SELECT * FROM data_quality_issues WHERE resolved_at IS NULL"
    args = []
    if kind:
        q += " AND kind=?"
        args.append(kind)
    issues = conn.execute(q + " ORDER BY severity='error' DESC, id DESC LIMIT 300", args).fetchall()
    sources = conn.execute("SELECT * FROM data_sources ORDER BY id DESC LIMIT 30").fetchall()
    jobs = conn.execute("SELECT * FROM job_runs ORDER BY id DESC LIMIT 20").fetchall()
    stale = conn.execute("""SELECT e.* FROM events e WHERE e.status IN ('scheduled','locked') AND e.date < ?""",
                         (utcnow()[:10],)).fetchall()
    missing = conn.execute("""SELECT
        SUM(CASE WHEN dob IS NULL THEN 1 ELSE 0 END) AS dob, SUM(CASE WHEN height_in IS NULL THEN 1 ELSE 0 END) AS height,
        SUM(CASE WHEN reach_in IS NULL THEN 1 ELSE 0 END) AS reach, SUM(CASE WHEN stance IS NULL THEN 1 ELSE 0 END) AS stance,
        COUNT(*) n FROM fighters""").fetchone()
    return render(request, "data_quality.html", summary=summary, issues=issues, sources=sources, jobs=jobs,
                  stale=stale, missing=missing, kind=kind, verify=ledger.verify(conn))


@app.post("/data-quality/resolve/{issue_id}")
def resolve_issue(issue_id: int, conn=Depends(get_db)):
    conn.execute("UPDATE data_quality_issues SET resolved_at=? WHERE id=?", (utcnow(), issue_id))
    db.audit(conn, "issue.resolved", "data_quality_issue", issue_id, actor="user")
    conn.commit()
    return RedirectResponse("/data-quality", status_code=303)


@app.get("/settings", response_class=HTMLResponse)
def settings_page(request: Request, msg: str = "", conn=Depends(get_db)):
    values = {k: setting(conn, k) for k in DEFAULT_SETTINGS}
    upcoming = conn.execute("SELECT * FROM events WHERE status IN ('scheduled','locked') ORDER BY date").fetchall()
    return render(request, "settings.html", values=values, defaults=DEFAULT_SETTINGS, env=env_status(), msg=msg,
                  backups=[] if db.on_vercel() else db.list_backups(), upcoming=upcoming,
                  backend=db.backend(conn), token_configured=_token() is not None,
                  audit=conn.execute("SELECT * FROM audit_log ORDER BY id DESC LIMIT 30").fetchall())


@app.post("/settings")
async def settings_save(request: Request, conn=Depends(get_db)):
    form = await request.form()
    for k, default in DEFAULT_SETTINGS.items():
        if k not in form:
            if isinstance(default, bool):
                db.set_setting(conn, k, False) if setting(conn, k) else None
            continue
        raw = form[k]
        if isinstance(default, bool):
            val = raw in ("on", "true", "1")
        elif isinstance(default, int):
            val = int(raw)
        elif isinstance(default, float):
            val = float(raw)
        else:
            val = str(raw)
        if val != setting(conn, k):
            db.set_setting(conn, k, val)
    return RedirectResponse("/settings?msg=Saved", status_code=303)


@app.post("/actions/{name}")
def action(name: str, event_id: int | None = Form(None), reason: str = Form(""), conn=Depends(get_db)):
    if db.on_vercel() and name in HEAVY_ON_VERCEL:
        return RedirectResponse(f"/settings?msg={name} {JOBS_HINT}", status_code=303)
    try:
        if name == "refresh_history":
            msg = str(lifecycle.refresh_history(conn))
        elif name == "refresh_upcoming":
            msg = str(lifecycle.refresh_upcoming(conn))
        elif name == "refresh_odds":
            msg = "odds: " + str(lifecycle.refresh_odds(conn))
        elif name == "tick":
            msg = "tick complete"
            lifecycle.tick(conn)
        elif name == "backup":
            msg = "backup written: " + db.backup(conn)
        elif name == "predict" and event_id:
            ids = predict.predict_event(conn, event_id, mode="live", reason=reason or "manual refresh",
                                        allow_post_lock=ledger.is_locked(conn, event_id, "live") and bool(reason))
            msg = f"{len(ids)} predictions recorded"
        elif name == "lock" and event_id:
            msg = str(ledger.lock_event(conn, event_id, "live", utcnow()[:10], "manual lock"))
        elif name == "evaluate" and event_id:
            msg = str(review.evaluate_event(conn, event_id, "live"))
        else:
            raise HTTPException(400, "unknown action")
    except (ledger.LedgerError, RuntimeError, ValueError) as e:
        msg = f"refused: {e}"
    return RedirectResponse(f"/settings?msg={msg[:300]}", status_code=303)


@app.post("/import/{kind}")
async def import_file(kind: str, file: UploadFile = File(...), conn=Depends(get_db)):
    text = (await file.read()).decode("utf-8")
    fmt = "json" if file.filename.lower().endswith(".json") else "csv"
    try:
        if kind == "card":
            out = ingest_bundle(conn, manual.parse_card(text, fmt, file.filename), reconcile_cards=True, actor="user")
        elif kind == "results":
            out = ingest_manual_results(conn, manual.parse_results(text, fmt))
        elif kind == "odds":
            out = ingest_manual_odds(conn, manual.parse_odds(text, fmt))
        elif kind == "corrections":
            out = ingest_corrections(conn, manual.parse_corrections(text, fmt))
        else:
            raise HTTPException(400, "unknown import kind")
        msg = f"{kind} imported: {out}"
    except manual.ValidationError as e:
        msg = f"{kind} rejected — " + "; ".join(e.errors[:8])
    return RedirectResponse(f"/settings?msg={msg[:500]}", status_code=303)


# ------------------------------------------------------------------ JSON API
@app.get("/api/event/{event_id}")
def api_event(event_id: int, mode: str | None = None, conn=Depends(get_db)):
    card = services.event_card(conn, event_id, mode)
    if card is None:
        raise HTTPException(404)
    return JSONResponse(card)


@app.get("/api/ledger/verify")
def api_verify(conn=Depends(get_db)):
    return ledger.verify(conn)


@app.get("/api/performance")
def api_perf(mode: str = "replay", conn=Depends(get_db)):
    p = services.performance(conn, mode)
    p.pop("series", None)
    return JSONResponse(p)
