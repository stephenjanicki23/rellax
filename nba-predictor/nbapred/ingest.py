"""Validate normalised provider records and write them to the database.

Responsibilities: source attribution, team identity resolution, duplicate detection (the same game
imported by hand and published by a provider is one game), statistic validation, result
revisioning, and night reconciliation (postponements and cancellations). Prediction logic never
reads provider output directly.
"""
from __future__ import annotations

import datetime as dt

from . import teams as T
from .db import audit, flag_issue
from .providers.base import Bundle
from .util import utcnow

STAT_KEYS = ["minutes", "pts", "fgm", "fga", "fg3m", "fg3a", "ftm", "fta", "oreb", "dreb", "ast", "stl", "blk",
             "tov", "pf"]


def night_name(date: str) -> str:
    d = dt.date.fromisoformat(date)
    return f"NBA · {d.strftime('%a')} {d.strftime('%b')} {d.day}, {d.year}"


def _record_sources(conn, bundle: Bundle) -> int | None:
    last = None
    for s in bundle.sources:
        cur = conn.execute(
            """INSERT INTO data_sources(provider, resource, url, license, retrieved_at, sha256, status, http_status,
               error, cache_path, rows) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (s.provider, s.resource, s.url, s.license, s.retrieved_at, s.sha256, s.status, s.http_status, s.error,
             s.cache_path, s.rows))
        last = cur.lastrowid
        if s.status == "stale":
            flag_issue(conn, "source", f"{s.provider}:{s.resource}", "stale_source",
                       f"{s.provider} unreachable; using cached copy ({s.error})", "warning")
    return last


def _validate_stats(st: dict) -> list[str]:
    problems = []
    for k in STAT_KEYS:
        v = st.get(k)
        if v is not None and v < 0:
            problems.append(f"{k} negative")
            st[k] = None
    for m, a in (("fgm", "fga"), ("fg3m", "fg3a"), ("ftm", "fta")):
        if st.get(m) is not None and st.get(a) is not None and st[m] > st[a]:
            problems.append(f"{m} {st[m]} > {a} {st[a]}")
            st[m] = st[a] = None
    if st.get("fg3m") is not None and st.get("fgm") is not None and st["fg3m"] > st["fgm"]:
        problems.append("threes made exceed field goals made")
        st["fg3m"] = None
    if st.get("pts") is not None and st["pts"] > 250:
        problems.append(f"{st['pts']} points is not plausible")
        st["pts"] = None
    return problems


def _b(v):
    return None if v is None else int(bool(v))


def ensure_event(conn, date: str, origin: str, src_id, now: str, cache: dict) -> int:
    if date in cache:
        return cache[date]
    ext = f"night:{date}"
    row = conn.execute("SELECT id FROM events WHERE external_id=?", (ext,)).fetchone()
    if row is None:
        row_id = conn.execute(
            "INSERT INTO events(external_id, name, date, status, origin, source_id, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?)", (ext, night_name(date), date, "scheduled", origin, src_id, now, now)).lastrowid
    else:
        row_id = row["id"]
    cache[date] = row_id
    return row_id


def ingest_bundle(conn, bundle: Bundle, *, reconcile_nights: bool = False, actor: str = "system") -> dict:
    now = utcnow()
    summary = {"provider": bundle.provider, "events_new": 0, "games_new": 0, "teams_new": 0, "results_new": 0,
               "results_revised": 0, "stats_rows": 0, "odds_new": 0, "issues": 0, "canceled": 0, "postponed": 0,
               "merged": 0}
    src_id = _record_sources(conn, bundle)
    origin = "manual" if bundle.provider == "manual" else "provider"

    # Teams
    existing = {r["external_id"]: r for r in conn.execute("SELECT id, external_id, name, abbr FROM teams")}
    for t in bundle.teams:
        old = existing.get(t.external_id)
        if old is None:
            cur = conn.execute("INSERT INTO teams(external_id, abbr, name, conference, division, source_id, origin, "
                               "created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
                               (t.external_id, t.abbr, t.name, t.conference, t.division, src_id, origin, now, now))
            existing[t.external_id] = {"id": cur.lastrowid, "external_id": t.external_id, "name": t.name, "abbr": t.abbr}
            summary["teams_new"] += 1
            if not t.external_id.startswith("nba:"):
                flag_issue(conn, "team", cur.lastrowid, "unknown_team",
                           f"'{t.name}' is not one of the 30 NBA franchises (exhibition opponent?)", "info")
        elif (old["name"], old["abbr"]) != (t.name, t.abbr) and t.external_id.startswith("nba:"):
            conn.execute("UPDATE teams SET name=?, abbr=?, updated_at=? WHERE id=?", (t.name, t.abbr, now, old["id"]))
    team_ids = {k: v["id"] for k, v in existing.items()}

    def team_for(name, ext):
        if ext and ext in team_ids:
            return team_ids[ext]
        tid = T.lookup(name or "")
        if tid and T.external_id(tid) in team_ids:
            return team_ids[T.external_id(tid)]
        return None

    # Events (one per night) and games
    ev_cache: dict[str, int] = {}
    before_events = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    GCOLS = ("season", "season_type", "neutral_site", "venue_city", "tip_time_utc", "home_out", "away_out")
    rows = {r["external_id"]: r for r in conn.execute(
        f"SELECT id, external_id, event_id, home_team_id, away_team_id, status, origin, {', '.join(GCOLS)} FROM games")}
    by_pair = {}
    for r in rows.values():
        by_pair[(r["event_id"], r["home_team_id"], r["away_team_id"])] = r
    alias: dict[str, int] = {}
    listed: dict[int, set] = {}
    ins, upd, status_upd = [], [], []
    for g in bundle.games:
        home, away = team_for(g.home_name, g.home_external_id), team_for(g.away_name, g.away_external_id)
        if home is None or away is None or home == away:
            flag_issue(conn, "game", g.external_id, "unresolved_team",
                       f"{g.away_name} at {g.home_name}: team not resolved; game skipped", "error")
            continue
        ev_id = ensure_event(conn, g.date, origin, src_id, now, ev_cache)
        vals = (g.season or T.season_of(g.date), g.season_type, int(bool(g.neutral_site)), g.venue_city,
                g.tip_time_utc, g.home_out, g.away_out)
        old = rows.get(g.external_id)
        if old is None:
            other = by_pair.get((ev_id, home, away))
            if other is not None and other["id"] is None:
                flag_issue(conn, "game", g.external_id, "duplicate_game",
                           f"{g.away_name} at {g.home_name} on {g.date} listed twice by {bundle.provider}; "
                           "second copy skipped", "warning")
                continue
            if other is not None:
                alias[g.external_id] = other["id"]
                old = other
                if other["origin"] != origin:
                    summary["merged"] += 1
            else:
                swapped = by_pair.get((ev_id, away, home))
                if swapped is not None:
                    flag_issue(conn, "game", swapped["id"], "home_away_conflict",
                               f"{bundle.provider} lists {g.away_name} at {g.home_name}; stored game has the teams "
                               "the other way round — verify", "error")
                    alias[g.external_id] = swapped["id"]
                    continue
        if old is not None:
            merged = tuple(v if (v is not None and (c not in ("home_out", "away_out") or origin == "manual"
                                                     or old[c] is None)) else old[c]
                           for c, v in zip(GCOLS, vals))
            if merged != tuple(old[c] for c in GCOLS):
                upd.append((*merged, now, old["id"]))
            if g.status in ("postponed", "canceled") and old["status"] == "scheduled":
                status_upd.append((g.status, now, old["id"]))
                summary[g.status] += 1
            listed.setdefault(ev_id, set()).add(old["id"])
            continue
        ins.append((g.external_id, ev_id, home, away, *vals,
                    g.status if g.status in ("scheduled", "postponed", "canceled") else "scheduled", origin, src_id,
                    now, now))
        by_pair[(ev_id, home, away)] = {"id": None, "origin": origin, "external_id": g.external_id}
        listed.setdefault(ev_id, set()).add(g.external_id)
    if ins:
        conn.executemany(
            f"""INSERT INTO games(external_id, event_id, home_team_id, away_team_id, {', '.join(GCOLS)}, status, origin,
                source_id, created_at, updated_at) VALUES ({', '.join('?' * (len(GCOLS) + 9))})""", ins)
        summary["games_new"] += len(ins)
    if upd:
        conn.executemany(f"UPDATE games SET {', '.join(c + '=?' for c in GCOLS)}, updated_at=? WHERE id=?", upd)
    if status_upd:
        conn.executemany("UPDATE games SET status=?, updated_at=? WHERE id=?", status_upd)
    summary["events_new"] = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0] - before_events
    games = {r["external_id"]: r for r in conn.execute("SELECT id, external_id, home_team_id, away_team_id, status "
                                                       "FROM games")}
    by_id = {r["id"]: r for r in games.values()}
    for ext, gid in alias.items():
        games[ext] = by_id[gid]
    for ev_id, s in listed.items():
        listed[ev_id] = {games[x]["id"] if isinstance(x, str) else x for x in s}
    if reconcile_nights:
        for ev_id, ids in listed.items():
            summary["canceled"] += reconcile_night(conn, ev_id, ids, bundle.provider)
    _update_night_times(conn, list(listed))

    # Results
    latest = {r["game_id"]: r for r in conn.execute(
        """SELECT r.game_id, r.outcome, r.home_score, r.away_score, r.periods FROM game_results r
           JOIN (SELECT game_id, MAX(revision) rv FROM game_results GROUP BY game_id) m
           ON m.game_id=r.game_id AND m.rv=r.revision""")}
    ins, done = [], []
    for r in bundle.results:
        g = games.get(r.game_external_id)
        if g is None:
            continue
        winner = (g["home_team_id"] if r.home_score > r.away_score else g["away_team_id"]) if r.outcome == "win" else None
        prev = latest.get(g["id"])
        if prev is None:
            ins.append((g["id"], 1, r.outcome, winner, r.home_score, r.away_score, r.periods, r.details,
                        r.reason or "initial official result", origin, src_id, r.source_url, now))
            done.append((now, g["id"]))
            latest[g["id"]] = {"outcome": r.outcome, "home_score": r.home_score, "away_score": r.away_score,
                               "periods": r.periods}
            continue
        if (prev["outcome"], prev["home_score"], prev["away_score"]) == (r.outcome, r.home_score, r.away_score):
            continue
        if record_result(conn, g["id"], r.outcome, r.home_score, r.away_score, r.periods, source_url=r.source_url,
                         source_id=src_id, origin=origin, reason=r.reason) == "revised":
            summary["results_revised"] += 1
    if ins:
        conn.executemany(
            """INSERT INTO game_results(game_id, revision, outcome, winner_team_id, home_score, away_score, periods,
               details, reason, origin, source_id, source_url, recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""", ins)
        conn.executemany("UPDATE games SET status='completed', updated_at=? WHERE id=? AND status<>'replaced'", done)
        summary["results_new"] += len(ins)

    # Team box scores: fill what is missing; never overwrite a known value with unknown
    summary["stats_rows"] = store_stats(conn, bundle.stats, games)

    # Odds (only for games not yet decided; unchanged lines are not repeated)
    for o in bundle.odds:
        g = games.get(o.game_external_id)
        if g is None or g["id"] in latest:
            continue
        if store_odds(conn, g["id"], bundle.provider, o.bookmaker, o, now):
            summary["odds_new"] += 1

    for ent, ent_id, kind, msg, sev in bundle.issues:
        flag_issue(conn, ent, ent_id, kind, msg, sev)
    summary["issues"] = len(bundle.issues)
    complete_nights(conn)
    audit(conn, "ingest", "provider", bundle.provider, summary, actor=actor)
    conn.commit()
    return summary


ODDS_COLS = ("home_decimal", "away_decimal", "spread_home", "spread_home_decimal", "spread_away_decimal", "total",
             "over_decimal", "under_decimal")


def store_odds(conn, game_id: int, provider: str, bookmaker, o, now: str) -> bool:
    vals = tuple(getattr(o, c) if not isinstance(o, dict) else o.get(c) for c in ODDS_COLS)
    last = conn.execute(f"SELECT {', '.join(ODDS_COLS)} FROM odds WHERE game_id=? AND provider=? "
                        "AND COALESCE(bookmaker,'')=COALESCE(?,'') ORDER BY captured_at DESC, id DESC LIMIT 1",
                        (game_id, provider, bookmaker)).fetchone()
    if last is not None and tuple(last) == vals:
        return False
    cap = o.captured_at if not isinstance(o, dict) else o["captured_at"]
    url = o.source_url if not isinstance(o, dict) else o.get("source_url")
    conn.execute(f"INSERT INTO odds(game_id, provider, bookmaker, {', '.join(ODDS_COLS)}, captured_at, source_url, "
                 f"created_at) VALUES ({', '.join('?' * (len(ODDS_COLS) + 6))})",
                 (game_id, provider, bookmaker, *vals, cap, url, now))
    return True


def store_stats(conn, stats: list, games: dict) -> int:
    have = {(r["game_id"], r["team_id"]): r for r in conn.execute("SELECT * FROM team_game_stats")} if stats else {}
    ins, upd = [], []
    for s in stats:
        g = games.get(s.game_external_id)
        if g is None:
            continue
        team = g["home_team_id"] if s.side == "home" else g["away_team_id"]
        st = dict(s.stats)
        problems = _validate_stats(st)
        if problems:
            flag_issue(conn, "team_game_stats", f"{g['id']}:{team}", "invalid_stats",
                       "; ".join(problems) + " — values discarded", "warning")
        old = have.get((g["id"], team))
        if old is None:
            ins.append((g["id"], team, *[st.get(k) for k in STAT_KEYS]))
            have[(g["id"], team)] = {k: st.get(k) for k in STAT_KEYS}
        else:
            merged = [old[k] if st.get(k) is None else st[k] for k in STAT_KEYS]
            if merged != [old[k] for k in STAT_KEYS]:
                upd.append((*merged, g["id"], team))
    if ins:
        conn.executemany(f"INSERT INTO team_game_stats(game_id, team_id, {', '.join(STAT_KEYS)}) "
                         f"VALUES ({', '.join('?' * (2 + len(STAT_KEYS)))})", ins)
    if upd:
        conn.executemany(f"UPDATE team_game_stats SET {', '.join(k + '=?' for k in STAT_KEYS)} "
                         "WHERE game_id=? AND team_id=?", upd)
    return len(ins) + len(upd)


def _update_night_times(conn, event_ids: list[int]) -> None:
    for eid in event_ids:
        t = conn.execute("SELECT MIN(tip_time_utc) FROM games WHERE event_id=? AND status IN ('scheduled','completed')",
                         (eid,)).fetchone()[0]
        if t:
            conn.execute("UPDATE events SET start_time_utc=?, updated_at=? WHERE id=? AND "
                         "(start_time_utc IS NULL OR start_time_utc<>?) AND status='scheduled'", (t, utcnow(), eid, t))


def complete_nights(conn) -> None:
    """A night whose games are all decided (or called off) is completed (the lifecycle grades it next)."""
    conn.execute("""UPDATE events SET status='completed', updated_at=? WHERE status IN ('scheduled','locked')
                    AND EXISTS (SELECT 1 FROM games g JOIN game_results r ON r.game_id=g.id WHERE g.event_id=events.id)
                    AND NOT EXISTS (SELECT 1 FROM games g2 WHERE g2.event_id=events.id AND g2.status='scheduled')""",
                 (utcnow(),))


def reconcile_night(conn, event_id: int, current: set[int], provider: str) -> int:
    """Scheduled games that the provider no longer lists for that night are called off."""
    n = 0
    for g in conn.execute("SELECT id FROM games WHERE event_id=? AND status='scheduled'", (event_id,)).fetchall():
        if g["id"] not in current:
            conn.execute("UPDATE games SET status='canceled', updated_at=? WHERE id=?", (utcnow(), g["id"]))
            audit(conn, "game.removed_from_schedule", "game", g["id"], {"provider": provider})
            n += 1
    return n


def latest_result(conn, game_id: int):
    return conn.execute("SELECT * FROM game_results WHERE game_id=? ORDER BY revision DESC LIMIT 1",
                        (game_id,)).fetchone()


def record_result(conn, game_id: int, outcome: str, home_score, away_score, periods=4, *, details=None,
                  source_url=None, source_id=None, origin="provider", reason=None) -> str:
    """Store an official result. Returns 'new', 'revised' or 'unchanged'. Never edits a revision."""
    g = conn.execute("SELECT * FROM games WHERE id=?", (game_id,)).fetchone()
    if outcome not in ("win", "nc"):
        raise ValueError(f"invalid outcome {outcome}")
    winner = None
    if outcome == "win":
        if home_score is None or away_score is None or home_score == away_score:
            raise ValueError("a final needs two different scores")
        winner = g["home_team_id"] if home_score > away_score else g["away_team_id"]
    prev = latest_result(conn, game_id)
    if prev is not None and (prev["outcome"], prev["home_score"], prev["away_score"]) == (outcome, home_score, away_score):
        return "unchanged"
    rev = 1 if prev is None else prev["revision"] + 1
    if prev is not None and not reason:
        reason = "result changed at source (correction)"
    conn.execute(
        """INSERT INTO game_results(game_id, revision, outcome, winner_team_id, home_score, away_score, periods, details,
           reason, origin, source_id, source_url, recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (game_id, rev, outcome, winner, home_score, away_score, periods, details, reason or "initial official result",
         origin, source_id, source_url, utcnow()))
    conn.execute("UPDATE games SET status='completed', updated_at=? WHERE id=? AND status<>'replaced'",
                 (utcnow(), game_id))
    if prev is not None:
        flag_issue(conn, "game", game_id, "result_revised",
                   f"result revision {rev}: {prev['home_score']}-{prev['away_score']} → {home_score}-{away_score} "
                   f"({reason})", "info")
        audit(conn, "result.revised", "game", game_id, {"revision": rev, "reason": reason})
    return "new" if prev is None else "revised"


def find_game(conn, date: str, home_id: int, away_id: int):
    return conn.execute(
        """SELECT g.* FROM games g JOIN events e ON e.id=g.event_id JOIN teams h ON h.id=g.home_team_id
           JOIN teams a ON a.id=g.away_team_id WHERE e.date=? AND h.external_id=? AND a.external_id=?""",
        (date, T.external_id(home_id), T.external_id(away_id))).fetchone()


def ingest_manual_results(conn, rows: list[dict], actor: str = "user") -> dict:
    out = {"new": 0, "revised": 0, "unchanged": 0, "unmatched": []}
    for r in rows:
        g = find_game(conn, r["date"], r["home_id"], r["away_id"])
        if g is None:
            out["unmatched"].append(f"{T.abbr(r['away_id'])} at {T.abbr(r['home_id'])} on {r['date']}")
            continue
        out[record_result(conn, g["id"], r["outcome"], r["home_score"], r["away_score"], r["periods"],
                          source_url=r["source_url"], origin="manual", reason=r.get("reason"))] += 1
    complete_nights(conn)
    audit(conn, "results.manual_import", "results", None, out, actor=actor)
    conn.commit()
    return out


def ingest_manual_odds(conn, rows: list[dict], actor: str = "user") -> dict:
    out = {"stored": 0, "unchanged": 0, "unmatched": []}
    now = utcnow()
    for r in rows:
        g = find_game(conn, r["date"], r["home_id"], r["away_id"])
        if g is None:
            out["unmatched"].append(f"{T.abbr(r['away_id'])} at {T.abbr(r['home_id'])} on {r['date']}")
            continue
        out["stored" if store_odds(conn, g["id"], "manual", r["bookmaker"], r, now) else "unchanged"] += 1
    audit(conn, "odds.manual_import", "odds", None, out, actor=actor)
    conn.commit()
    return out


def ingest_availability(conn, rows: list[dict], actor: str = "user") -> dict:
    """Record documented absences for unplayed games (the lifecycle re-predicts before the lock)."""
    out = {"stored": 0, "unmatched": [], "refused": [], "game_ids": []}
    for r in rows:
        g = find_game(conn, r["date"], r["home_id"], r["away_id"])
        if g is None:
            out["unmatched"].append(f"{T.abbr(r['away_id'])} at {T.abbr(r['home_id'])} on {r['date']}")
            continue
        locked = conn.execute("SELECT 1 FROM prediction_locks WHERE event_id=? AND mode='live'",
                              (g["event_id"],)).fetchone()
        if locked or g["status"] != "scheduled":
            out["refused"].append(f"game #{g['id']}: night locked or game over")
            continue
        conn.execute("UPDATE games SET home_out=?, away_out=?, updated_at=? WHERE id=?",
                     (r["home_out"], r["away_out"], utcnow(), g["id"]))
        audit(conn, "game.availability", "game", g["id"], {"home_out": r["home_out"], "away_out": r["away_out"],
                                                           "source": r["source_url"], "note": r.get("note")}, actor=actor)
        out["stored"] += 1
        out["game_ids"].append(g["id"])
    conn.commit()
    return out


def games_missing_box(conn, limit: int) -> list:
    """Completed ESPN games whose team box score lacks possessions inputs (offensive rebounds or turnovers)."""
    return conn.execute(
        """SELECT g.id, g.external_id FROM games g JOIN events e ON e.id=g.event_id
           WHERE g.external_id LIKE 'espn:%' AND g.status='completed'
             AND (SELECT COUNT(*) FROM team_game_stats s WHERE s.game_id=g.id AND s.oreb IS NOT NULL
                  AND s.tov IS NOT NULL) < 2
           ORDER BY e.date DESC LIMIT ?""", (limit,)).fetchall()
