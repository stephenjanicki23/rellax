"""Historical provider: NBA.com team game logs mirrored on GitHub.

Source: https://github.com/NocturneBear/NBA-Data-2010-2024 — team box-score totals for every
regular-season and playoff game from 2010-11 through 2023-24, as published by NBA.com. Downloaded
at runtime into the local cache and never vendored into this repository. Seasons after the mirror's
last season come from the ESPN provider (`providers/espn.py`).

Caveats that are surfaced, not hidden:
  * One row per team per game; the two rows are paired by GAME_ID. MATCHUP "A @ B" means A was the
    away team, "A vs. B" means A was at home.
  * The 2020 restart ("bubble", 2020-07-30 to 2020-10-11) was played at a neutral site; those games
    are stored as neutral even though the source still lists a nominal home team.
  * Play-in games and the NBA Cup final are not in this source.
  * A few playoff games appear more than once in the source; exact duplicates are dropped and any
    other inconsistency is flagged.
"""
from __future__ import annotations

import csv
import io
import os
from collections import defaultdict
from pathlib import Path

from .. import teams as T
from ..util import sha256, utcnow
from .base import Bundle, HistoricalProvider, PGame, PResult, PTeam, PTeamStats, SourceMeta
from .http import fetch

FILES = {"regular": "regular_season_totals_2010_2024", "playoffs": "play_off_totals_2010_2024"}
LICENSE = "NocturneBear/NBA-Data-2010-2024 (public GitHub dataset); underlying data from NBA.com"
DEFAULT_BASE = "https://raw.githubusercontent.com/NocturneBear/NBA-Data-2010-2024/main"
STAT_MAP = {"pts": "PTS", "fgm": "FGM", "fga": "FGA", "fg3m": "FG3M", "fg3a": "FG3A", "ftm": "FTM", "fta": "FTA",
            "oreb": "OREB", "dreb": "DREB", "ast": "AST", "stl": "STL", "blk": "BLK", "tov": "TOV", "pf": "PF"}


def _num(v):
    if v in (None, ""):
        return None
    try:
        return int(float(v))
    except ValueError:
        return None


def _float(v):
    try:
        return float(v) if v not in (None, "") else None
    except ValueError:
        return None


class NBAMirrorProvider(HistoricalProvider):
    name = "nba_mirror"

    def __init__(self, base_url: str = DEFAULT_BASE, local_dir: str | None = None,
                 max_age_s: float | None = 7 * 86400, min_interval_s: float = 1.0):
        self.base_url = base_url.rstrip("/")
        self.local_dir = local_dir or os.environ.get("NBAPRED_MIRROR_DIR")
        self.max_age_s = max_age_s
        self.min_interval_s = min_interval_s

    def _load(self, fname: str) -> tuple[list[dict], SourceMeta]:
        if self.local_dir:
            path = Path(self.local_dir) / f"{fname}.csv"
            text = path.read_text(encoding="utf-8")
            meta = SourceMeta(self.name, fname, f"file://{path}", utcnow(), sha256(text), "ok",
                              cache_path=str(path), license=LICENSE)
        else:
            text, meta = fetch(f"{self.base_url}/{fname}.csv", self.name, f"{fname}.csv",
                               min_interval_s=self.min_interval_s, max_age_s=self.max_age_s,
                               check_robots=False, license=LICENSE)
        rows = list(csv.DictReader(io.StringIO(text)))
        meta.rows = len(rows)
        return rows, meta

    def fetch_history(self) -> Bundle:
        b = Bundle(provider=self.name)
        seen_teams = {}
        for stype, fname in FILES.items():
            rows, meta = self._load(fname)
            b.sources.append(meta)
            parse_rows(rows, stype, b, seen_teams)
        b.teams = list(seen_teams.values())
        return b


def parse_rows(rows: list[dict], season_type: str, b: Bundle, seen_teams: dict) -> None:
    by_game: dict[str, dict] = defaultdict(dict)
    for r in rows:
        gid, tid = (r.get("GAME_ID") or "").strip(), _num(r.get("TEAM_ID"))
        if not gid or tid is None:
            b.issues.append(("source_row", gid or "?", "malformed_row", "row without GAME_ID/TEAM_ID skipped", "warning"))
            continue
        prev = by_game[gid].get(tid)
        if prev is not None:
            if {k: prev.get(k) for k in STAT_MAP.values()} != {k: r.get(k) for k in STAT_MAP.values()}:
                b.issues.append(("game", f"nba:{gid}", "conflicting_duplicate",
                                 f"source lists game {gid} twice for team {tid} with different numbers; first kept",
                                 "warning"))
            continue
        by_game[gid][tid] = r
        ref = T.TEAMS.get(tid)
        ext = T.external_id(tid)
        if ext not in seen_teams:
            seen_teams[ext] = PTeam(ext, ref[1] if ref else r.get("TEAM_NAME") or str(tid),
                                    ref[0] if ref else r.get("TEAM_ABBREVIATION"), ref[2] if ref else None,
                                    ref[3] if ref else None)
    for gid, sides in by_game.items():
        if len(sides) != 2:
            b.issues.append(("game", f"nba:{gid}", "incomplete_game", f"game {gid} has {len(sides)} team rows; skipped",
                             "warning"))
            continue
        (t1, r1), (t2, r2) = sides.items()
        if "@" in (r1.get("MATCHUP") or ""):
            home, away, hr, ar = t2, t1, r2, r1
        else:
            home, away, hr, ar = t1, t2, r1, r2
        date = (r1.get("GAME_DATE") or "")[:10]
        neutral = T.BUBBLE[0] <= date <= T.BUBBLE[1]
        ext = f"nba:{gid}"
        hp, ap = _num(hr.get("PTS")), _num(ar.get("PTS"))
        b.games.append(PGame(ext, date, T.TEAMS.get(home, (None, str(home)))[1], T.TEAMS.get(away, (None, str(away)))[1],
                             T.external_id(home), T.external_id(away), (r1.get("SEASON_YEAR") or "").strip() or None,
                             season_type, neutral, "Orlando bubble" if neutral else None, status="completed"))
        mins = _float(hr.get("MIN"))
        periods = 4 + max(0, round(((mins or 48.0) - 48.0) / 5.0))
        if hp is None or ap is None or hp == ap:
            b.issues.append(("game", ext, "invalid_result", f"scores {hp}-{ap} are not a decided game", "error"))
        else:
            b.results.append(PResult(ext, "win", hp, ap, periods))
        for side, rr in (("home", hr), ("away", ar)):
            st = {k: _num(rr.get(src)) for k, src in STAT_MAP.items()}
            st["minutes"] = None if mins is None else mins * 5      # team minutes (5 players on court)
            b.stats.append(PTeamStats(ext, side, st))
