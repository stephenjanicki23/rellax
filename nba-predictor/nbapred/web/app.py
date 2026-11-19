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

from .. import betting, db, ledger, lifecycle, predict, review, services
from ..config import DEFAULT_SETTINGS, env_status, setting
from ..features.build import StateCache
from ..features.history import HistoryStore, team_state
from ..ingest import ingest_availability, ingest_bundle, ingest_manual_odds, ingest_manual_results
from ..learning import loop
from ..models import registry
from ..providers import manual
from ..util import loads, utcnow
from . import charts, plain

HERE = Path(__file__).parent
app = FastAPI(title="NBA Prediction Engine")
app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")
templates = Jinja2Templates(directory=HERE / "templates")
T = templates.env
T.filters["pct"] = lambda v, d=0: "—" if v is None else f"{v * 100:.{d}f}%"
T.filters["f"] = lambda v, d=3: "—" if v is None else f"{v:.{d}f}"
T.filters["loads"] = lambda s: loads(s, {})
T.filters["money"] = betting.money
T.filters["american"] = betting.decimal_to_american
T.filters["betline"] = lambda r: ("" if r.get("line") is None else ("PK" if r["line"] == 0 else "%+g" % r["line"]))
T.filters["market"] = lambda r: betting.MARKET_LABEL.get(r.get("strategy"), "Moneyline")
T.filters["stake_label"] = lambda t: {"High": "Big", "Medium": "Standard", "Low": "Not bet"}.get(t, t)
T.globals.update(charts=charts, now=lambda: utcnow())
plain.install(T)

# ------------------------------------------------------------------ access control
# Reads are public unless NBAPRED_PRIVATE=1. Every write (POST) needs the admin token when
# NBAPRED_ADMIN_TOKEN is set; on Vercel, writes are refused outright until a token is set.
ADMIN_COOKIE = "nbapred_admin"
HEAVY_ON_VERCEL = {"refresh_history", "refresh_boxes", "tick", "backup"}
JOBS_HINT = ("runs in GitHub Actions on Vercel deployments: Actions → “NBA Predictor jobs” → Run workflow "
             "(a serverless request cannot finish it within its time limit)")


def _token() -> str | None:
    return os.environ.get("NBAPRED_ADMIN_TOKEN") or None


def _cookie_value(token: str) -> str:
    return hashlib.sha256(("nbapred:" + token).encode()).hexdigest()


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
        msg = ("Writes are disabled: set NBAPRED_ADMIN_TOKEN in the Vercel project, then log in."
               if _token() is None else "Log in with the admin token to make changes.")
        return RedirectResponse(f"/login?msg={msg}", status_code=303)
    if os.environ.get("NBAPRED_PRIVATE") == "1" and not is_admin(request):
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


@app.get("/nights", response_class=HTMLResponse)
def nights(request: Request, conn=Depends(get_db), page: int = 0):
    rows = conn.execute(
        """SELECT e.*, (SELECT COUNT(*) FROM games g WHERE g.event_id=e.id) AS n_games,
                  (SELECT COUNT(*) FROM prediction_locks l WHERE l.event_id=e.id) AS n_locks
           FROM events e ORDER BY e.date DESC LIMIT 50 OFFSET ?""", (page * 50,)).fetchall()
    return render(request, "nights.html", events=rows, page_no=page)


@app.get("/events")
def events_redirect():
    return RedirectResponse("/nights", status_code=307)


@app.get("/night/{event_id}", response_class=HTMLResponse)
def night(request: Request, event_id: int, mode: str | None = None, conn=Depends(get_db)):
    card = services.event_card(conn, event_id, mode)
    if card is None:
        raise HTTPException(404)
    return render(request, "night.html", card=card, lock_at=lifecycle.lock_time(conn, card["event"]))


@app.get("/game/{game_id}", response_class=HTMLResponse)
def game(request: Request, game_id: int, mode: str | None = None, version: int | None = None, conn=Depends(get_db)):
    g = conn.execute("""SELECT g.*, e.name AS event_name, e.date, th.name AS home_name, ta.name AS away_name,
                               th.abbr AS home_abbr, ta.abbr AS away_abbr
                        FROM games g JOIN events e ON e.id=g.event_id JOIN teams th ON th.id=g.home_team_id
                        JOIN teams ta ON ta.id=g.away_team_id WHERE g.id=?""", (game_id,)).fetchone()
    if g is None:
        raise HTTPException(404)
    if mode is None:
        mode = "live" if conn.execute("SELECT 1 FROM predictions WHERE game_id=? AND mode='live'",
                                      (game_id,)).fetchone() else "replay"
    versions = conn.execute("SELECT * FROM predictions WHERE game_id=? AND mode=? ORDER BY version",
                            (game_id, mode)).fetchall()
    pred = next((v for v in versions if v["version"] == version), versions[-1] if versions else None)
    official = {p["id"] for p in ledger.official_predictions(conn, g["event_id"], mode)}
    res = conn.execute("SELECT * FROM game_results WHERE game_id=? ORDER BY revision", (game_id,)).fetchall()
    evals = conn.execute("""SELECT e.*, d.report_json, d.category FROM prediction_evaluations e
                            LEFT JOIN error_diagnostics d ON d.evaluation_id=e.id
                            WHERE e.prediction_id IN (SELECT id FROM predictions WHERE game_id=? AND mode=?)
                            ORDER BY e.id""", (game_id, mode)).fetchall()
    box = conn.execute("""SELECT s.*, t.name FROM team_game_stats s JOIN teams t ON t.id=s.team_id WHERE s.game_id=?
                          ORDER BY s.team_id=? DESC""", (game_id, g["away_team_id"])).fetchall()
    mv = conn.execute("SELECT label, config_json FROM model_versions WHERE id=?",
                      (pred["model_version_id"],)).fetchone() if pred else None
    locked = ledger.is_locked(conn, g["event_id"], "live")
    return render(request, "game.html", g=g, mode=mode, versions=versions, pred=pred,
                  payload=loads(pred["payload_json"]) if pred else None, official=official, results=res,
                  evals=evals, model=mv, box=box, gameday_open=not res and not locked and g["status"] == "scheduled",
                  msg=request.query_params.get("msg", ""))


@app.post("/game/{game_id}/gameday")
def game_day(game_id: int, home_out: str = Form("unknown"), away_out: str = Form("unknown"), source: str = Form(""),
             conn=Depends(get_db)):
    """Record documented absences (rotation players ruled out) before the night locks, then re-predict."""
    g = conn.execute("SELECT * FROM games WHERE id=?", (game_id,)).fetchone()
    if g is None:
        raise HTTPException(404)
    back = f"/game/{game_id}?mode=live&msg="
    if ledger.is_locked(conn, g["event_id"], "live") or g["status"] != "scheduled":
        return RedirectResponse(back + "refused: the night is locked or the game is over, so its pick can no "
                                "longer change", status_code=303)
    if not source.strip():
        return RedirectResponse(back + "refused: say where this information comes from", status_code=303)

    def val(v):
        v = (v or "").strip().lower()
        return int(v) if v.isdigit() and int(v) <= 15 else None
    vals = {"home_out": val(home_out), "away_out": val(away_out)}
    before = {k: g[k] for k in vals}
    conn.execute("UPDATE games SET home_out=?, away_out=?, updated_at=? WHERE id=?",
                 (vals["home_out"], vals["away_out"], utcnow(), game_id))
    db.audit(conn, "game.availability", "game", game_id, {"before": before, "after": vals, "source": source.strip()},
             actor="admin")
    conn.commit()
    msg = "game-day info saved"
    if before != vals:
        try:
            ids = predict.predict_event(conn, g["event_id"], mode="live", reason="injury report updated",
                                        game_ids=[game_id])
            msg += f"; re-predicted ({len(ids)} new version)" + _sync_note(conn)
        except (ledger.LedgerError, RuntimeError, ValueError) as e:
            msg += f"; prediction not refreshed: {e}"
    return RedirectResponse(back + msg[:300], status_code=303)


# ------------------------------------------------------------------ history & review
@app.get("/history", response_class=HTMLResponse)
def history(request: Request, mode: str | None = None, page: int = 0, conn=Depends(get_db)):
    mode = mode or services.preferred_mode(conn)
    rows = conn.execute(
        """SELECT p.*, ev.name AS event_name, ev.date, th.name AS home_name, ta.name AS away_name,
                  r.outcome, r.winner_team_id, r.home_score, r.away_score, r.periods,
                  e.correct_winner, e.log_loss, e.brier, e.margin_error, e.total_error, e.ats_correct, e.scored
           FROM predictions p JOIN events ev ON ev.id=p.event_id JOIN teams th ON th.id=p.home_team_id
           JOIN teams ta ON ta.id=p.away_team_id
           LEFT JOIN prediction_evaluations e ON e.prediction_id=p.id
           LEFT JOIN game_results r ON r.id=e.result_id
           WHERE p.mode=? AND p.id IN (SELECT m.prediction_id FROM prediction_lock_members m)
           ORDER BY ev.date DESC, p.game_id LIMIT 100 OFFSET ?""", (mode, page * 100)).fetchall()
    return render(request, "history.html", rows=rows, mode=mode, page_no=page)


@app.get("/reviews", response_class=HTMLResponse)
def reviews(request: Request, mode: str | None = None, conn=Depends(get_db)):
    mode = mode or services.preferred_mode(conn)
    rows = conn.execute(
        """SELECT ev.id, ev.name, ev.date, COUNT(e.id) AS graded, SUM(e.correct_winner) AS correct,
                  AVG(e.log_loss) AS ll, AVG(e.brier) AS brier, SUM(e.bucket_correct) AS bc,
                  AVG(ABS(e.margin_error)) AS mae
           FROM prediction_locks l JOIN events ev ON ev.id=l.event_id
           LEFT JOIN predictions p ON p.event_id=ev.id AND p.mode=l.mode
           LEFT JOIN prediction_evaluations e ON e.prediction_id=p.id AND e.scored=1
           WHERE l.mode=? GROUP BY ev.id, ev.name, ev.date ORDER BY ev.date DESC LIMIT 200""", (mode,)).fetchall()
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
def edge(request: Request, market: str = "moneyline", conn=Depends(get_db)):
    market = market if market in betting.MARKETS else "moneyline"
    rows = betting.bets(conn, market)
    both = betting.bets(conn)
    ev = services.edge_event(conn)
    min_n = int(setting(conn, "betting.min_sample"))
    g = lambda k: float(setting(conn, k))
    return render(request, "edge.html", rows=rows, s=betting.summary(rows), market=market,
                  market_label=betting.MARKET_LABEL[market],
                  totals={m: betting.summary([r for r in both if r["strategy"] == m]) for m in betting.MARKETS},
                  tiers=[betting.tier_stats(rows, t) for t in ("High", "Medium")], events=betting.event_stats(rows),
                  curve=betting.cumulative(rows), fb=betting.feedback(rows, min_n), next_ev=ev,
                  sc=betting.scorecard(rows, min_n), min_ev=g("betting.min_ev"),
                  record=services.betting_track_record(conn), edge_min=services.EDGE_MIN,
                  stakes={t: setting(conn, f"betting.stake_{t.lower()}") for t in ("High", "Medium", "Low")},
                  rules={"high": g(f"betting.{market}_prob_high"), "bet": g(f"betting.{market}_prob_bet"),
                         "games": int(g("betting.min_season_games"))})


@app.get("/edge/night/{event_id}", response_class=HTMLResponse)
def edge_event(request: Request, event_id: int, conn=Depends(get_db)):
    ev = conn.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()
    if ev is None:
        raise HTTPException(404, "no such game night")
    rows = [r for r in betting.bets(conn) if r["event_id"] == event_id]
    stats = betting.event_stats(rows)
    rows.sort(key=lambda r: (r["tip_time_utc"] or "", r["game_id"], r["strategy"] != "moneyline", r["id"]))
    return render(request, "edge_night.html", ev=ev, rows=rows, st=stats[0] if stats else None,
                  data=services.betting_edge(conn, event_id), edge_min=services.EDGE_MIN)


def _ledger_query(request: Request) -> dict:
    keys = ("market", "tier", "event", "date_from", "date_to", "status", "team", "odds_min", "odds_max", "sort", "dir")
    return {k: request.query_params.get(k, "") for k in keys}


@app.get("/edge/bets", response_class=HTMLResponse)
def edge_bets(request: Request, conn=Depends(get_db)):
    q = _ledger_query(request)
    all_rows = betting.bets(conn)
    rows = betting.filter_rows(all_rows, q)
    events = sorted({(r["event_id"], r["event_date"], r["event_name"]) for r in all_rows}, key=lambda e: e[1] or "",
                    reverse=True)
    return render(request, "edge_bets.html", rows=rows, q=q, s=betting.summary(rows), events=events,
                  qs=request.url.query)


@app.get("/edge/bets.csv")
def edge_bets_csv(request: Request, conn=Depends(get_db)):
    from fastapi.responses import Response
    rows = betting.filter_rows(betting.bets(conn), _ledger_query(request))
    return Response(betting.to_csv(rows), media_type="text/csv",
                    headers={"Content-Disposition": "attachment; filename=nba-bet-ledger.csv"})


@app.get("/edge/bet/{bet_id}", response_class=HTMLResponse)
def edge_bet(request: Request, bet_id: int, msg: str = "", conn=Depends(get_db)):
    row = next((r for r in betting.bets(conn) if r["id"] == bet_id), None)
    if row is None:
        raise HTTPException(404, "no such bet")
    hist = [h | {"changes": betting.describe(h)} for h in betting.history(conn, bet_id)]
    return render(request, "edge_bet.html", b=row, hist=hist,
                  why=loads(row["rationale_json"], {}), msg=msg)


@app.post("/edge/bet/{bet_id}/correct")
def edge_bet_correct(bet_id: int, reason: str = Form(""), odds_american: str = Form(""), status: str = Form(""),
                     stake: str = Form(""), conn=Depends(get_db)):
    try:
        betting.correct(conn, bet_id, reason=reason, actor="admin", odds_american=odds_american or None,
                        status=status or None, stake_dollars=stake or None)
        msg = "correction saved"
    except betting.CorrectionError as e:
        msg = f"refused: {e}"
    return RedirectResponse(f"/edge/bet/{bet_id}?msg={msg[:300]}", status_code=303)


@app.get("/performance", response_class=HTMLResponse)
def performance(request: Request, mode: str | None = None, conn=Depends(get_db)):
    mode = mode or services.preferred_mode(conn)
    return render(request, "performance.html", perf=services.performance(conn, mode), mode=mode,
                  comparison=services.latest_promotion_comparison(conn))


# ------------------------------------------------------------------ teams
def _today_states(conn):
    h = HistoryStore.load(conn)
    today = utcnow()[:10]
    last = conn.execute("SELECT season FROM games g JOIN events e ON e.id=g.event_id WHERE e.date<=? "
                        "ORDER BY e.date DESC LIMIT 1", (today,)).fetchone()
    from ..teams import season_of
    season = season_of(today)
    if last and last["season"] and last["season"] > season:
        season = last["season"]
    if last and last["season"] and last["season"] < season and today[5:7] in ("07", "08", "09"):
        season = last["season"]          # off-season: show the season just finished
    return h, today, season


@app.get("/teams", response_class=HTMLResponse)
def teams_page(request: Request, conn=Depends(get_db)):
    h, today, season = _today_states(conn)
    rows = []
    for t in conn.execute("SELECT * FROM teams WHERE external_id LIKE 'nba:%' ORDER BY name").fetchall():
        rows.append({**dict(t), "st": team_state(h, t["id"], today, season=season)})
    rows.sort(key=lambda r: -(r["st"]["net"] or 0))
    return render(request, "teams.html", rows=rows, season=season)


@app.get("/team/{team_id}", response_class=HTMLResponse)
def team_page(request: Request, team_id: int, conn=Depends(get_db)):
    t = conn.execute("SELECT * FROM teams WHERE id=?", (team_id,)).fetchone()
    if t is None:
        raise HTTPException(404)
    h, today, season = _today_states(conn)
    st = team_state(h, team_id, today, season=season)
    games = conn.execute(
        """SELECT g.*, e.date, r.winner_team_id, r.home_score, r.away_score,
                  o.name AS opp_name
           FROM games g JOIN events e ON e.id=g.event_id
           LEFT JOIN game_results r ON r.game_id=g.id AND r.revision=(SELECT MAX(revision) FROM game_results WHERE game_id=g.id)
           JOIN teams o ON o.id = CASE WHEN g.home_team_id=? THEN g.away_team_id ELSE g.home_team_id END
           WHERE g.home_team_id=? OR g.away_team_id=? ORDER BY e.date DESC LIMIT 120""",
        (team_id, team_id, team_id)).fetchall()
    ser = h.series.get(team_id)
    trend = []
    if ser:
        step = max(1, len(ser.dates) // 400)
        for i in range(0, len(ser.dates), step):
            trend.append({"i": len(trend) + 1, "date": ser.dates[i], "elo": ser.elo_post[i], "n": 1})
    issues = conn.execute("SELECT * FROM data_quality_issues WHERE entity='team' AND entity_id=?",
                          (str(team_id),)).fetchall()
    return render(request, "team.html", t=t, st=st, games=games, trend=trend, issues=issues, today=today)


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
    stale = conn.execute("""SELECT e.* FROM events e WHERE e.status IN ('scheduled','locked') AND e.date < ?
                            AND EXISTS (SELECT 1 FROM games g WHERE g.event_id=e.id AND g.status='scheduled')
                            ORDER BY e.date DESC LIMIT 50""", (utcnow()[:10],)).fetchall()
    q = lambda sql: conn.execute(sql).fetchone()[0]
    cov = {"games": q("SELECT COUNT(*) FROM games"), "results": q("SELECT COUNT(DISTINCT game_id) FROM game_results"),
           "full_box": q("SELECT COUNT(*) FROM (SELECT game_id FROM team_game_stats WHERE oreb IS NOT NULL AND tov IS NOT NULL "
                         "GROUP BY game_id HAVING COUNT(*)=2) x"),
           "partial_box": q("SELECT COUNT(*) FROM (SELECT game_id FROM team_game_stats GROUP BY game_id "
                            "HAVING SUM(CASE WHEN oreb IS NULL OR tov IS NULL THEN 1 ELSE 0 END) > 0) x")}
    seasons = conn.execute("""SELECT g.season, COUNT(*) AS n,
                                     SUM(CASE WHEN g.status='completed' THEN 1 ELSE 0 END) AS finals,
                                     SUM(CASE WHEN (SELECT COUNT(*) FROM team_game_stats s WHERE s.game_id=g.id
                                                    AND s.oreb IS NOT NULL AND s.tov IS NOT NULL)=2 THEN 1 ELSE 0 END) AS box,
                                     MIN(CASE WHEN g.external_id LIKE 'espn:%' THEN 'ESPN' WHEN g.external_id LIKE 'nba:%'
                                              THEN 'NBA.com mirror' ELSE 'manual' END) AS src
                              FROM games g GROUP BY g.season ORDER BY g.season DESC""").fetchall()
    return render(request, "data_quality.html", summary=summary, issues=issues, sources=sources, jobs=jobs,
                  stale=stale, cov=cov, seasons=seasons, kind=kind, verify=ledger.verify(conn))


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
            msg = "odds: " + str(lifecycle.refresh_odds(conn, force=True))
        elif name == "refresh_boxes":
            msg = "box scores: " + str(lifecycle.refresh_boxes(conn))
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
        elif name == "sync_bets":
            msg = "bets: " + str(betting.sync(conn, actor="admin"))
        else:
            raise HTTPException(400, "unknown action")
        if name in ("predict", "lock", "evaluate", "refresh_odds", "refresh_upcoming"):
            msg += _sync_note(conn)
    except (ledger.LedgerError, RuntimeError, ValueError) as e:
        msg = f"refused: {e}"
    if name == "sync_bets":
        return RedirectResponse("/edge", status_code=303)
    return RedirectResponse(f"/settings?msg={msg[:300]}", status_code=303)


def _sync_note(conn) -> str:
    """Keep the simulated-bet ledger current after anything that changes picks, odds or results."""
    try:
        out = betting.sync(conn)
        return f" · bets {out}" if out else ""
    except Exception as e:  # tracking must never block the prediction workflow
        return f" · bet tracking failed: {type(e).__name__}"


@app.post("/import/{kind}")
async def import_file(kind: str, file: UploadFile = File(...), conn=Depends(get_db)):
    text = (await file.read()).decode("utf-8")
    fmt = "json" if file.filename.lower().endswith(".json") else "csv"
    try:
        if kind in ("night", "card"):
            out = ingest_bundle(conn, manual.parse_card(text, fmt, file.filename), actor="user")
        elif kind == "results":
            out = ingest_manual_results(conn, manual.parse_results(text, fmt))
        elif kind == "odds":
            out = ingest_manual_odds(conn, manual.parse_odds(text, fmt))
        elif kind == "availability":
            out = ingest_availability(conn, manual.parse_availability(text, fmt))
            for gid in out.get("game_ids", []):
                ev = conn.execute("SELECT event_id FROM games WHERE id=?", (gid,)).fetchone()
                try:
                    predict.predict_event(conn, ev["event_id"], mode="live", reason="injury report imported",
                                          game_ids=[gid])
                except (ledger.LedgerError, RuntimeError, ValueError):
                    pass
        else:
            raise HTTPException(400, "unknown import kind")
        msg = f"{kind} imported: {out}" + (_sync_note(conn) if kind in ("night", "card", "results", "odds", "availability") else "")
    except manual.ValidationError as e:
        msg = f"{kind} rejected — " + "; ".join(e.errors[:8])
    return RedirectResponse(f"/settings?msg={msg[:500]}", status_code=303)


# ------------------------------------------------------------------ JSON API
@app.get("/api/night/{event_id}")
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
