"""ESPN public scoreboard / summary JSON: schedule, final scores, team box scores and market lines.

Used for (a) seasons after the historical mirror ends (`providers.espn.backfill_from`), (b) the
upcoming game nights, (c) results for locked nights and (d) the lines ESPN shows (comparison only).

Endpoints (no key; polite rate limit and on-disk cache):
  scoreboard  https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=YYYYMMDD
  summary     https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=<id>

The scoreboard gives scores and a partial box score (no offensive rebounds or turnovers), so the full
team box score is read from the game summary for completed games that still miss it — at most
`max_box` per run, so a long backfill resumes on the next run.

These payloads are not a documented API. The parser is defensive: anything it cannot read is left
unknown (never zero) and flagged; it is fixture-tested (tests/fixtures/espn_*.json).
"""
from __future__ import annotations

import datetime as dt
import json

from .. import teams as T
from ..util import utcnow
from .base import Bundle, POdds, PGame, PResult, ProviderError, PTeam, PTeamStats, UpcomingProvider
from .http import fetch

BASE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba"
SEASON_TYPES = {1: "preseason", 2: "regular", 3: "playoffs", 5: "playin"}


def american_to_decimal(a) -> float | None:
    try:
        a = float(str(a).replace("+", "").strip())
    except (TypeError, ValueError):
        return None
    if a >= 100:
        return 1 + a / 100
    if a <= -100:
        return 1 + 100 / abs(a)
    return None


def _num(x):
    try:
        return float(str(x).replace("o", "").replace("u", "").strip())
    except (TypeError, ValueError):
        return None


def _int(x):
    try:
        return int(float(x))
    except (TypeError, ValueError):
        return None


def _team(c: dict) -> tuple[str, str]:
    t = c.get("team") or {}
    tid = T.lookup(t.get("abbreviation") or "") or T.lookup(t.get("displayName") or "") or \
        T.lookup(f"{t.get('location', '')} {t.get('name', '')}")
    if tid:
        return T.external_id(tid), T.TEAMS[tid][1]
    name = t.get("displayName") or t.get("name") or "Unknown team"
    return f"espn-team:{t.get('id') or T.team_key(name)}", name


_SB_STATS = {"points": "pts", "fieldGoalsMade": "fgm", "fieldGoalsAttempted": "fga",
             "threePointFieldGoalsMade": "fg3m", "threePointFieldGoalsAttempted": "fg3a",
             "freeThrowsMade": "ftm", "freeThrowsAttempted": "fta", "assists": "ast"}
_BOX_PAIRS = {"fieldGoalsMade-fieldGoalsAttempted": ("fgm", "fga"),
              "threePointFieldGoalsMade-threePointFieldGoalsAttempted": ("fg3m", "fg3a"),
              "freeThrowsMade-freeThrowsAttempted": ("ftm", "fta")}
_BOX_SINGLE = {"offensiveRebounds": "oreb", "defensiveRebounds": "dreb", "assists": "ast", "steals": "stl",
               "blocks": "blk", "turnovers": "tov", "totalTurnovers": "tov", "fouls": "pf", "personalFouls": "pf",
               "points": "pts"}


def parse_scoreboard(payload: dict, date: str, url: str) -> Bundle:
    """One scoreboard day → games (+ results, partial box scores and lines for that day)."""
    b = Bundle(provider="espn")
    for ev in payload.get("events") or []:
        comp = (ev.get("competitions") or [{}])[0]
        cs = comp.get("competitors") or []
        home = next((c for c in cs if c.get("homeAway") == "home"), None)
        away = next((c for c in cs if c.get("homeAway") == "away"), None)
        ext = f"espn:{ev.get('id')}"
        if not home or not away:
            b.issues.append(("game", ext, "malformed_game", "game without a home and an away team skipped", "warning"))
            continue
        (hx, hn), (ax, an) = _team(home), _team(away)
        for x, n in ((hx, hn), (ax, an)):
            ref = T.TEAMS.get(T.nba_id(x))
            if not any(t.external_id == x for t in b.teams):
                b.teams.append(PTeam(x, n, ref[0] if ref else None, ref[2] if ref else None, ref[3] if ref else None))
        season = ev.get("season") or {}
        stype = SEASON_TYPES.get(season.get("type"), "regular")
        notes = " ".join(n.get("headline", "") for n in comp.get("notes") or []).lower()
        if "cup" in notes and "championship" in notes:
            stype = "cup_final"
        year = season.get("year")
        season_label = f"{year - 1}-{year % 100:02d}" if isinstance(year, int) else T.season_of(date)
        st = ((comp.get("status") or ev.get("status") or {}).get("type") or {})
        state, name = st.get("state"), (st.get("name") or "").upper()
        status = "completed" if (st.get("completed") and state == "post") else \
            "postponed" if "POSTPONED" in name else "canceled" if "CANCELED" in name or "CANCELLED" in name else "scheduled"
        neutral = bool(comp.get("neutralSite"))
        city = ((comp.get("venue") or {}).get("address") or {}).get("city")
        venue_city = city if neutral and city in T.NEUTRAL_VENUES else ("Las Vegas" if stype == "cup_final" else None)
        b.games.append(PGame(ext, date, hn, an, hx, ax, season_label, stype, neutral, venue_city,
                             comp.get("date") or ev.get("date"), status=status,
                             source_url=f"https://www.espn.com/nba/game/_/gameId/{ev.get('id')}"))
        if status == "completed":
            hs, as_ = _int(home.get("score")), _int(away.get("score"))
            periods = _int((comp.get("status") or {}).get("period")) or len(home.get("linescores") or []) or 4
            if hs is None or as_ is None or hs == as_:
                b.issues.append(("game", ext, "invalid_result", f"final score {hs}-{as_} unreadable", "error"))
            else:
                b.results.append(PResult(ext, "win", hs, as_, max(periods, 4), source_url=url))
            for side, c in (("home", home), ("away", away)):
                stats = {v: None for v in ("pts", "fgm", "fga", "fg3m", "fg3a", "ftm", "fta", "oreb", "dreb", "ast",
                                           "stl", "blk", "tov", "pf", "minutes")}
                for s in c.get("statistics") or []:
                    k = _SB_STATS.get(s.get("name"))
                    if k:
                        stats[k] = _int(s.get("displayValue"))
                stats["pts"] = stats["pts"] if stats["pts"] is not None else _int(c.get("score"))
                stats["minutes"] = 240.0 + 25.0 * max(0, (max(periods, 4) - 4))
                b.stats.append(PTeamStats(ext, side, stats))
        o = parse_odds(comp, hx, ax, home, away)
        if o is not None and status == "scheduled":
            o.game_external_id = ext
            o.source_url = url
            b.odds.append(o)
    return b


def parse_odds(comp: dict, hx: str, ax: str, home: dict, away: dict) -> POdds | None:
    lines = comp.get("odds") or []
    if not lines:
        return None
    o = lines[0]
    book = (o.get("provider") or {}).get("name") or "ESPN"
    hab = ((home.get("team") or {}).get("abbreviation") or "").upper()
    aab = ((away.get("team") or {}).get("abbreviation") or "").upper()
    ho, ao = o.get("homeTeamOdds") or {}, o.get("awayTeamOdds") or {}
    ml_h, ml_a = american_to_decimal(ho.get("moneyLine")), american_to_decimal(ao.get("moneyLine"))
    sp_h, sp_hd, sp_ad = None, american_to_decimal(ho.get("spreadOdds")), american_to_decimal(ao.get("spreadOdds"))
    details = (o.get("details") or "").upper().split()
    if len(details) == 2 and _num(details[1]) is not None:
        val = abs(_num(details[1]))
        sp_h = -val if details[0] == hab else val if details[0] == aab else None
    elif details[:1] == ["EVEN"]:
        sp_h = 0.0
    if sp_h is None and _num(o.get("spread")) is not None:
        sp_h = _num(o.get("spread"))
    total = _num(o.get("overUnder"))
    over_d, under_d = american_to_decimal(o.get("overOdds")), american_to_decimal(o.get("underOdds"))
    # newer layout: {"moneyline": {"home": {"close": {"odds": "-220"}}}, "pointSpread": …, "total": …}
    def pick(node, *path):
        for k in path:
            node = (node or {}).get(k) if isinstance(node, dict) else None
        return node
    for when in ("close", "open"):
        ml_h = ml_h or american_to_decimal(pick(o, "moneyline", "home", when, "odds"))
        ml_a = ml_a or american_to_decimal(pick(o, "moneyline", "away", when, "odds"))
        if sp_h is None and _num(pick(o, "pointSpread", "home", when, "line")) is not None:
            sp_h = _num(pick(o, "pointSpread", "home", when, "line"))
            sp_hd = sp_hd or american_to_decimal(pick(o, "pointSpread", "home", when, "odds"))
            sp_ad = sp_ad or american_to_decimal(pick(o, "pointSpread", "away", when, "odds"))
        if total is None and _num(pick(o, "total", "over", when, "line")) is not None:
            total = _num(pick(o, "total", "over", when, "line"))
            over_d = over_d or american_to_decimal(pick(o, "total", "over", when, "odds"))
            under_d = under_d or american_to_decimal(pick(o, "total", "under", when, "odds"))
    if not any(v is not None for v in (ml_h, ml_a, sp_h, total)):
        return None
    if (ml_h is None) != (ml_a is None):
        ml_h = ml_a = None
    return POdds("", utcnow(), ml_h, ml_a, sp_h, sp_hd, sp_ad, total, over_d, under_d, book)


def parse_summary(payload: dict, ext: str) -> list[PTeamStats]:
    """Full team box score from a game summary."""
    out = []
    teams = ((payload.get("boxscore") or {}).get("teams")) or []
    comp = (((payload.get("header") or {}).get("competitions")) or [{}])[0]
    sides = {}
    for c in comp.get("competitors") or []:
        sides[((c.get("team") or {}).get("id"))] = c.get("homeAway")
    periods = _int((comp.get("status") or {}).get("period")) or 4
    for t in teams:
        side = t.get("homeAway") or sides.get((t.get("team") or {}).get("id"))
        if side not in ("home", "away"):
            continue
        st = {}
        for s in t.get("statistics") or []:
            name, val = s.get("name") or "", s.get("displayValue")
            if name in _BOX_PAIRS and isinstance(val, str) and "-" in val:
                m, a = val.split("-", 1)
                st[_BOX_PAIRS[name][0]], st[_BOX_PAIRS[name][1]] = _int(m), _int(a)
            elif name in _BOX_SINGLE and st.get(_BOX_SINGLE[name]) is None:
                st[_BOX_SINGLE[name]] = _int(val)
        if st:
            st["minutes"] = 240.0 + 25.0 * max(0, periods - 4)
            out.append(PTeamStats(ext, side, st))
    return out


class ESPNProvider(UpcomingProvider):
    name = "espn"

    def __init__(self, min_interval_s: float = 1.0):
        self.min_interval_s = min_interval_s

    def _get(self, url: str, resource: str, max_age_s: float | None):
        text, meta = fetch(url, self.name, resource, min_interval_s=self.min_interval_s, max_age_s=max_age_s,
                           check_robots=False, license="ESPN public site data (personal, non-commercial research use)")
        try:
            return json.loads(text), meta
        except ValueError as e:
            raise ProviderError(f"ESPN payload for {resource} is not JSON: {e}") from e

    def fetch_day(self, date: str, today: str | None = None) -> Bundle:
        today = today or utcnow()[:10]
        url = f"{BASE}/scoreboard?dates={date.replace('-', '')}&limit=200"
        old = date < (dt.date.fromisoformat(today) - dt.timedelta(days=3)).isoformat()
        payload, meta = self._get(url, f"scoreboard_{date}.json", 10 ** 9 if old else 600)
        b = parse_scoreboard(payload, date, url)
        meta.rows = len(b.games)
        b.sources.append(meta)
        return b

    def fetch_range(self, start: str, end: str, today: str | None = None, progress=None) -> Bundle:
        """Every day in [start, end]; merged into one bundle."""
        out = Bundle(provider=self.name)
        d, last = dt.date.fromisoformat(start), dt.date.fromisoformat(end)
        while d <= last:
            day = self.fetch_day(d.isoformat(), today)
            for k in ("teams", "games", "results", "stats", "odds", "sources", "issues"):
                getattr(out, k).extend(getattr(day, k))
            if progress and d.day == 1:
                progress(f"espn: {d.isoformat()} ({len(out.games)} games so far)")
            d += dt.timedelta(days=1)
        seen, teams = set(), []
        for t in out.teams:
            if t.external_id not in seen:
                seen.add(t.external_id)
                teams.append(t)
        out.teams = teams
        if out.sources:
            out.sources = [s for s in out.sources if s.status != "cached"] or out.sources[-1:]
        return out

    def fetch_upcoming(self, days_ahead: int = 2) -> Bundle:
        today = utcnow()[:10]
        start = (dt.date.fromisoformat(today) - dt.timedelta(days=1)).isoformat()
        end = (dt.date.fromisoformat(today) + dt.timedelta(days=days_ahead)).isoformat()
        return self.fetch_range(start, end, today)

    def fetch_box(self, ext: str) -> tuple[list[PTeamStats], object]:
        eid = ext.split(":", 1)[1]
        payload, meta = self._get(f"{BASE}/summary?event={eid}", f"summary_{eid}.json", 10 ** 9)
        return parse_summary(payload, ext), meta
