"""Recent seasons, schedules and results: the SportsDataverse hoopR NBA data mirror on GitHub.

Source: https://github.com/sportsdataverse/hoopR-nba-data — a daily, public mirror of ESPN's NBA data
(schedules with final scores, team box scores) maintained by the SportsDataverse project. It is read
from raw.githubusercontent.com, so it works from GitHub Actions and Vercel, where ESPN and NBA.com refuse
requests from cloud servers. Game ids are ESPN ids, stored as `espn:<id>` like the ESPN provider's.

Files (hoopR labels a season by the year it ends: 2027 = 2026-27):
  nba/schedules/parquet/nba_schedule_<season>.parquet  every game of the season, played or not
  nba/team_box/parquet/team_box_<season>.parquet        one row per team per completed game

The mirror updates once a day, so last night's finals usually arrive the next afternoon (US Eastern).
It carries no betting lines. Reading Parquet needs `pyarrow` (installed by the jobs workflow only).
"""
from __future__ import annotations

import datetime as dt
import io

from .. import teams as T
from ..util import sha256, utcnow
from .base import Bundle, PGame, ProviderError, PResult, PTeam, PTeamStats, SourceMeta, UpcomingProvider
from .http import fetch

BASE = "https://raw.githubusercontent.com/sportsdataverse/hoopR-nba-data/main/nba"
LICENSE = "SportsDataverse hoopR-nba-data (public GitHub dataset); underlying data from ESPN"
SEASON_TYPES = {1: "preseason", 2: "regular", 3: "playoffs", 5: "playin"}
BOX_MAP = {"pts": "team_score", "fgm": "field_goals_made", "fga": "field_goals_attempted",
           "fg3m": "three_point_field_goals_made", "fg3a": "three_point_field_goals_attempted",
           "ftm": "free_throws_made", "fta": "free_throws_attempted", "oreb": "offensive_rebounds",
           "dreb": "defensive_rebounds", "ast": "assists", "stl": "steals", "blk": "blocks",
           "tov": "total_turnovers", "pf": "fouls"}


def hoopr_season(date: str) -> int:
    """hoopR season label (the year the season ends) for a date."""
    return int(T.season_of(date)[:4]) + 1


def _int(v):
    try:
        return None if v is None or v == "" else int(float(v))
    except (TypeError, ValueError):
        return None


def _date(v) -> str:
    return v.isoformat()[:10] if hasattr(v, "isoformat") else str(v)[:10]


def _team(abbr: str | None, name: str | None) -> tuple[str, str]:
    tid = T.lookup(abbr or "") or T.lookup(name or "")
    if tid:
        return T.external_id(tid), T.TEAMS[tid][1]
    return f"espn-team:{T.team_key(name or abbr or 'unknown')}", name or abbr or "Unknown team"


def parse_schedule(rows: list[dict], bundle: Bundle, start: str | None = None, end: str | None = None,
                   source_url: str | None = None) -> None:
    """Schedule rows → games (and results for finals) dated within [start, end]."""
    seen = {t.external_id for t in bundle.teams}
    for r in rows:
        date = _date(r.get("game_date") or r.get("date"))
        if (start and date < start) or (end and date > end):
            continue
        ext = f"espn:{r.get('game_id') or r.get('id')}"
        (hx, hn), (ax, an) = _team(r.get("home_abbreviation"), r.get("home_display_name")), \
            _team(r.get("away_abbreviation"), r.get("away_display_name"))
        if not (hx.startswith("nba:") and ax.startswith("nba:")):
            continue        # All-Star games, Rising Stars and exhibitions against non-NBA teams are not modelled
        for x, n in ((hx, hn), (ax, an)):
            if x not in seen:
                ref = T.TEAMS.get(T.nba_id(x))
                bundle.teams.append(PTeam(x, n, ref[0] if ref else None, ref[2] if ref else None,
                                          ref[3] if ref else None))
                seen.add(x)
        stype = SEASON_TYPES.get(_int(r.get("season_type")), "regular")
        notes = str(r.get("notes_headline") or "").lower()
        if "cup" in notes and "championship" in notes:
            stype = "cup_final"
        season = _int(r.get("season"))
        label = f"{season - 1}-{season % 100:02d}" if season else T.season_of(date)
        name = str(r.get("status_type_name") or "").upper()
        status = ("completed" if r.get("status_type_completed") and "FINAL" in name else
                  "postponed" if "POSTPONED" in name else
                  "canceled" if "CANCEL" in name else "scheduled")
        neutral = bool(r.get("neutral_site"))
        city = r.get("venue_address_city")
        venue_city = city if neutral and city in T.NEUTRAL_VENUES else ("Las Vegas" if stype == "cup_final" else None)
        tip = r.get("start_date") or r.get("date")
        bundle.games.append(PGame(ext, date, hn, an, hx, ax, label, stype, neutral, venue_city,
                                  str(tip) if tip else None, status=status, source_url=source_url))
        if status == "completed":
            hs, as_ = _int(r.get("home_score")), _int(r.get("away_score"))
            periods = max(_int(r.get("status_period")) or 4, 4)
            if hs is None or as_ is None or hs == as_:
                bundle.issues.append(("game", ext, "invalid_result", f"final score {hs}-{as_} unreadable", "error"))
            else:
                bundle.results.append(PResult(ext, "win", hs, as_, periods, source_url=source_url))


def parse_team_box(rows: list[dict], bundle: Bundle, game_ids: set[str] | None = None,
                   periods: dict | None = None) -> None:
    """Team box-score rows → per-side stats (only for games in `game_ids` when given)."""
    for r in rows:
        ext = f"espn:{r.get('game_id')}"
        if game_ids is not None and ext not in game_ids:
            continue
        side = str(r.get("team_home_away") or "").lower()
        if side not in ("home", "away"):
            continue
        st = {k: _int(r.get(src)) for k, src in BOX_MAP.items()}
        if st["tov"] is None:
            st["tov"] = _int(r.get("turnovers"))
        p = (periods or {}).get(ext, 4)
        st["minutes"] = 240.0 + 25.0 * max(0, p - 4)
        bundle.stats.append(PTeamStats(ext, side, st))


def read_parquet(data: bytes) -> list[dict]:
    try:
        import pyarrow.parquet as pq
    except ImportError as e:  # pragma: no cover - depends on the environment
        raise ProviderError("reading the hoopR mirror needs pyarrow (pip install -r requirements-jobs.txt)") from e
    return pq.read_table(io.BytesIO(data)).to_pylist()


class HoopRProvider(UpcomingProvider):
    name = "hoopr"

    def __init__(self, base_url: str = BASE, min_interval_s: float = 1.0):
        self.base_url = base_url.rstrip("/")
        self.min_interval_s = min_interval_s

    def _load(self, kind: str, season: int, max_age_s: float) -> tuple[list[dict], SourceMeta]:
        path = {"schedule": f"schedules/parquet/nba_schedule_{season}.parquet",
                "team_box": f"team_box/parquet/team_box_{season}.parquet"}[kind]
        url = f"{self.base_url}/{path}"
        data, meta = fetch(url, self.name, path.replace("/", "_"), min_interval_s=self.min_interval_s,
                           max_age_s=max_age_s, check_robots=False, license=LICENSE, binary=True)
        rows = read_parquet(data)
        meta.rows = len(rows)
        return rows, meta

    def fetch_range(self, start: str, end: str, today: str | None = None, include_box: bool = True) -> Bundle:
        """Every game dated within [start, end]: schedule, finals and (optionally) team box scores."""
        today = today or utcnow()[:10]
        b = Bundle(provider=self.name)
        current = hoopr_season(today)
        for season in range(hoopr_season(start), hoopr_season(end) + 1):
            fresh = 3 * 3600 if season >= current else 7 * 86400
            sched, meta = self._load("schedule", season, fresh)
            b.sources.append(meta)
            parse_schedule(sched, b, start, end, source_url="https://github.com/sportsdataverse/hoopR-nba-data")
            if include_box:
                finals = {g.external_id for g in b.games if g.status == "completed"}
                if finals:
                    periods = {r.game_external_id: r.periods for r in b.results}
                    try:
                        box, bmeta = self._load("team_box", season, fresh)
                    except ProviderError as e:
                        if "HTTP 404" not in str(e):
                            raise
                        continue            # a brand-new season may not have a box-score file yet
                    b.sources.append(bmeta)
                    parse_team_box(box, b, finals, periods)
        return b

    def fetch_upcoming(self, days_ahead: int = 2) -> Bundle:
        today = utcnow()[:10]
        start = (dt.date.fromisoformat(today) - dt.timedelta(days=1)).isoformat()
        end = (dt.date.fromisoformat(today) + dt.timedelta(days=days_ahead)).isoformat()
        return self.fetch_range(start, end, today, include_box=False)


__all__ = ["HoopRProvider", "parse_schedule", "parse_team_box", "hoopr_season", "read_parquet", "sha256"]
