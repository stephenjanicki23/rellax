"""Provider interfaces and the normalised records every provider must emit.

Data acquisition is kept separate from prediction logic: nothing outside
`nbapred/providers/` performs network I/O against a data source, and the engine only
ever sees these normalised records after `nbapred.ingest` has validated them.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


class ProviderError(Exception):
    """A provider was reachable but failed (HTTP error, parse error, bad payload)."""


class ProviderUnavailable(ProviderError):
    """A provider cannot run in this environment. `config_required` says what to set."""

    def __init__(self, message: str, config_required: str = ""):
        super().__init__(message)
        self.config_required = config_required


@dataclass
class PTeam:
    external_id: str              # nba:<id> for known franchises
    name: str
    abbr: Optional[str] = None
    conference: Optional[str] = None
    division: Optional[str] = None


@dataclass
class PGame:
    external_id: str
    date: str                      # US local date of the game (ISO)
    home_name: str
    away_name: str
    home_external_id: Optional[str] = None
    away_external_id: Optional[str] = None
    season: Optional[str] = None
    season_type: str = "regular"   # regular | playin | playoffs | cup_final | preseason
    neutral_site: bool = False
    venue_city: Optional[str] = None
    tip_time_utc: Optional[str] = None
    home_out: Optional[int] = None
    away_out: Optional[int] = None
    status: str = "scheduled"      # scheduled | completed | postponed | canceled
    source_url: Optional[str] = None


@dataclass
class PResult:
    game_external_id: str
    outcome: str                   # win | nc
    home_score: Optional[int]
    away_score: Optional[int]
    periods: Optional[int] = 4
    details: Optional[str] = None
    source_url: Optional[str] = None
    reason: Optional[str] = None


@dataclass
class PTeamStats:
    game_external_id: str
    side: str                      # home | away
    stats: dict                    # pts fgm fga fg3m fg3a ftm fta oreb dreb ast stl blk tov pf minutes


@dataclass
class POdds:
    game_external_id: str
    captured_at: str
    home_decimal: Optional[float] = None
    away_decimal: Optional[float] = None
    spread_home: Optional[float] = None
    spread_home_decimal: Optional[float] = None
    spread_away_decimal: Optional[float] = None
    total: Optional[float] = None
    over_decimal: Optional[float] = None
    under_decimal: Optional[float] = None
    bookmaker: Optional[str] = None
    source_url: Optional[str] = None


@dataclass
class SourceMeta:
    provider: str
    resource: str
    url: Optional[str]
    retrieved_at: str
    sha256: Optional[str] = None
    status: str = "ok"
    http_status: Optional[int] = None
    error: Optional[str] = None
    cache_path: Optional[str] = None
    rows: Optional[int] = None
    license: Optional[str] = None


@dataclass
class Bundle:
    provider: str
    teams: list = field(default_factory=list)
    games: list = field(default_factory=list)
    results: list = field(default_factory=list)
    stats: list = field(default_factory=list)
    odds: list = field(default_factory=list)
    sources: list = field(default_factory=list)
    issues: list = field(default_factory=list)   # (entity, entity_id, kind, message, severity)


class HistoricalProvider:
    name = "abstract"

    def fetch_history(self) -> Bundle:
        raise NotImplementedError


class UpcomingProvider:
    name = "abstract"

    def fetch_upcoming(self) -> Bundle:
        raise NotImplementedError


class OddsProvider:
    name = "abstract"

    def fetch_odds(self, games: list[dict]) -> Bundle:
        raise NotImplementedError
