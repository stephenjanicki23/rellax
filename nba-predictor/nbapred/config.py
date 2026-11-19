"""Configuration: model configuration (versioned with each model) and system settings.

Model configuration is *methodology* (which feature groups, decay half-life, priors,
calibration). Fitted coefficients are not configuration; they are learned and stored in
`model_versions.params_json`.
"""
from __future__ import annotations

import copy
import os
from dataclasses import asdict, dataclass, field

from .util import dumps, sha256


@dataclass
class ModelConfig:
    # Feature construction
    half_life_days: float = 30.0           # Model B time-decay; alternatives are tested as candidates
    prior_games: float = 12.0              # shrinkage of season-to-date rates toward last season (regressed)
    carryover: float = 0.67                # share of last season's edge kept in this season's prior
    elo_k: float = 20.0
    elo_home: float = 100.0                # Elo points of home-court advantage in the Elo expectation
    # Which sub-models participate in the ensemble
    submodels: tuple = ("A_baseline", "B_form", "C_style", "D_volatility", "E_context")
    style_v2: bool = False                 # extra shot-profile interactions in Model C (adopted only if validated)
    opp_adjusted: bool = False             # strength-adjusted (schedule-adjusted) ratings in Model A
    # Regularisation (Gaussian prior precision, on standardised features)
    l2: dict = field(default_factory=lambda: {
        "A_baseline": 4.0, "B_form": 4.0, "C_style": 12.0, "D_volatility": 8.0, "E_context": 4.0,
        "F_market": 1.0, "stack": 4.0, "total": 10.0,
    })
    # Ensemble
    stack_inner_folds: int = 3
    evidence_gating: bool = False          # let ensemble trust shift early in the season (few games played)
    calibration: str = "temperature"       # temperature | none | isotonic
    calibration_frac: float = 0.2          # most-recent share of training data held out for calibration
    # Training window
    train_start: str = "2011-07-01"        # the first mirror season (2010-11) only serves as the prior season
    train_window_days: int = 2200          # use about six seasons of games before the cutoff
    use_market: bool = False               # Model F: only when odds exist for training games

    def to_dict(self) -> dict:
        d = asdict(self)
        d["submodels"] = list(self.submodels)
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "ModelConfig":
        d = copy.deepcopy(d)
        if "submodels" in d:
            d["submodels"] = tuple(d["submodels"])
        base = cls()
        if "l2" in d:
            merged = dict(base.l2)
            merged.update(d["l2"])
            d["l2"] = merged
        known = {k: v for k, v in d.items() if k in base.__dataclass_fields__}
        return cls(**known)

    def fingerprint(self) -> str:
        return sha256(dumps(self.to_dict()))[:12]

    def with_changes(self, **changes) -> "ModelConfig":
        d = self.to_dict()
        for k, v in changes.items():
            if k == "l2":
                d["l2"] = {**d["l2"], **v}
            else:
                d[k] = v
        return ModelConfig.from_dict(d)


# System settings; overridable at runtime through the `settings` table (Settings screen).
DEFAULT_SETTINGS: dict = {
    "promotion.mode": "auto",                    # auto | manual
    "promotion.min_eval_games": 400,
    "promotion.min_eval_events": 30,             # game nights
    "promotion.confidence": 0.90,                # one-sided bootstrap confidence that the primary metric improves
    "promotion.max_brier_regression": 0.002,
    "promotion.max_ece_regression": 0.02,
    "promotion.max_single_event_share": 0.40,    # no single game night may account for more of the gain
    "promotion.bootstrap_samples": 1000,
    "learning.eval_window_games": 1200,          # most recent games used for candidate backtests (~one season)
    "learning.backtest_fold_events": 25,         # game nights per rolling-origin fold
    "learning.min_new_games_for_retrain": 150,   # about two weeks of the regular season
    "learning.max_candidates": 3,
    "learning.min_segment_n": 80,
    "learning.fdr_q": 0.10,
    "lifecycle.lock_minutes_before": 30,         # before the night's first tip-off
    "lifecycle.scheduler_enabled": False,
    "lifecycle.scheduler_interval_minutes": 60,
    "providers.historical": "nba_mirror",
    "providers.upcoming": "hoopr",               # hoopr (GitHub mirror of ESPN data) | espn | manual
    "providers.recent": "hoopr",                 # seasons after the mirror's last season: hoopr | espn | none
    "providers.espn.backfill_from": "2024-10-01",
    "providers.espn.days_ahead": 2,              # how many days of upcoming games to load
    "providers.espn.max_box_fetch": 1500,        # per run: full box scores fetched for games missing them
    "providers.odds": "the_odds_api",            # the_odds_api (needs ODDS_API_KEY) | manual | espn | none
    "providers.odds.bookmakers": "williamhill_us",  # The Odds API bookmaker keys, comma-separated; empty = all US books
    "providers.odds.markets": "h2h,spreads",     # each market costs one API credit per request
    "providers.odds.min_interval_hours": 6,      # at most one odds request per this many hours (free tier: 500/month)
    "betting.stake_high": 100,                   # simulated stake (dollars) for a big-stake pick
    "betting.stake_medium": 50,                  # for a standard-stake pick
    "betting.stake_low": 0,                      # picks below the thresholds are tracked, not bet
    "betting.moneyline_prob_high": 0.65,         # moneyline: big stake from this win chance
    "betting.moneyline_prob_bet": 0.55,          # moneyline: standard stake from this win chance
    "betting.spread_prob_high": 0.60,            # spread: big stake from this chance to cover
    "betting.spread_prob_bet": 0.55,             # spread: standard stake from this chance to cover
    "betting.min_season_games": 10,              # no stakes until both teams have played this many games
    "betting.min_ev": 0.05,                      # stake only when expected return at the offered price is at least this
    "betting.min_sample": 30,                    # settled bets before a segment is treated as evidence
    "providers.nba_mirror.base_url": "https://raw.githubusercontent.com/NocturneBear/NBA-Data-2010-2024/main",
    "providers.min_request_interval_s": 1.0,
    "analyst.provider": "deterministic",         # deterministic | anthropic
    "backup.keep": 20,
}


def env_status() -> dict:
    """Which optional credentials are configured (never returns the secrets themselves)."""
    return {
        "ANTHROPIC_API_KEY": bool(os.environ.get("ANTHROPIC_API_KEY")),
        "ODDS_API_KEY": bool(os.environ.get("ODDS_API_KEY")),
        "database": _db_describe(),
    }


def _db_describe() -> str:
    from .db import describe
    return describe()


def setting(conn, key: str):
    from .db import get_setting
    return get_setting(conn, key, DEFAULT_SETTINGS.get(key))
