"""Provider interfaces and the normalised records every provider must emit.

Data acquisition is kept separate from prediction logic: nothing outside
`ufcpred/providers/` performs network I/O against a data source, and the engine only
ever sees these normalised records after `ufcpred.ingest` has validated them.
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
class PEvent:
    external_id: str
    name: str
    date: str                      # ISO date
    location: Optional[str] = None
    venue: Optional[str] = None
    start_time_utc: Optional[str] = None
    source_url: Optional[str] = None


@dataclass
class PFighter:
    external_id: str
    name: str
    nickname: Optional[str] = None
    dob: Optional[str] = None
    height_in: Optional[float] = None
    reach_in: Optional[float] = None
    stance: Optional[str] = None
    listed_weight_lbs: Optional[float] = None


@dataclass
class PFight:
    external_id: str
    event_external_id: str
    red_name: str
    blue_name: str
    red_external_id: Optional[str] = None
    blue_external_id: Optional[str] = None
    weight_class: Optional[str] = None
    is_title: bool = False
    is_women: bool = False
    scheduled_rounds: Optional[int] = None
    time_format: Optional[str] = None
    card_segment: str = "unknown"
    bout_order: Optional[int] = None
    short_notice_red: Optional[bool] = None
    short_notice_blue: Optional[bool] = None
    weight_miss_red: Optional[bool] = None
    weight_miss_blue: Optional[bool] = None
    canceled: bool = False


@dataclass
class PResult:
    fight_external_id: str
    outcome: str                   # win | draw | nc
    winner_corner: Optional[str]   # red | blue | None
    method: Optional[str]          # KO_TKO | SUB | DEC | DQ | OTHER | NC | DRAW
    method_detail: Optional[str] = None
    end_round: Optional[int] = None
    end_time_sec: Optional[int] = None
    referee: Optional[str] = None
    details: Optional[str] = None
    source_url: Optional[str] = None
    reason: Optional[str] = None


@dataclass
class PRoundStats:
    fight_external_id: str
    corner: str                    # red | blue
    round: int
    stats: dict


@dataclass
class POdds:
    fight_external_id: str
    red_decimal: float
    blue_decimal: float
    captured_at: str
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
    events: list = field(default_factory=list)
    fighters: list = field(default_factory=list)
    fights: list = field(default_factory=list)
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


class ResultsProvider:
    name = "abstract"

    def fetch_results(self, event_external_id: str) -> Bundle:
        raise NotImplementedError


class OddsProvider:
    name = "abstract"

    def fetch_odds(self, fights: list[dict]) -> Bundle:
        raise NotImplementedError
