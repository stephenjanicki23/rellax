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
    half_life_days: float = 540.0          # Model B time-decay; alternatives are tested as candidates
    prior_minutes: float = 15.0            # shrinkage of per-minute rates toward the population
    elo_k: float = 40.0
    # Which sub-models participate in the ensemble
    submodels: tuple = ("A_baseline", "B_form", "C_style", "D_durability", "E_context")
    style_v2: bool = False                 # extra grappling/control interactions in Model C
    # Regularisation (Gaussian prior precision, on standardised features)
    l2: dict = field(default_factory=lambda: {
        "A_baseline": 2.0, "B_form": 4.0, "C_style": 12.0, "D_durability": 6.0, "E_context": 6.0,
        "F_market": 1.0, "stack": 4.0, "method": 3.0,
    })
    # Ensemble
    stack_inner_folds: int = 3
    evidence_gating: bool = False          # let ensemble trust shift with fighter experience
    calibration: str = "temperature"       # temperature | none | isotonic
    calibration_frac: float = 0.2          # most-recent share of training data held out for calibration
    # Training window
    train_start: str = "2005-01-01"
    min_prior_fights_any: int = 0          # rows used for training need >= this many prior UFC fights (either side)
    use_market: bool = False               # Model F: only when odds exist for training fights

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
    "promotion.min_eval_fights": 200,
    "promotion.min_eval_events": 15,
    "promotion.confidence": 0.90,                # one-sided bootstrap confidence that log loss improves
    "promotion.max_brier_regression": 0.002,
    "promotion.max_ece_regression": 0.02,
    "promotion.max_single_event_share": 0.40,    # no single card may account for more of the gain
    "promotion.bootstrap_samples": 1000,
    "learning.eval_window_fights": 450,          # most recent graded fights used for candidate backtests
    "learning.backtest_fold_events": 8,          # events per rolling-origin fold
    "learning.min_new_fights_for_retrain": 60,
    "learning.max_candidates": 3,
    "learning.min_segment_n": 40,
    "learning.fdr_q": 0.10,
    "lifecycle.lock_hours_before": 2,
    "lifecycle.scheduler_enabled": False,
    "lifecycle.scheduler_interval_minutes": 60,
    "providers.historical": "ufcstats_mirror",
    "providers.upcoming": "manual",              # manual | ufcstats_live
    "providers.odds": "none",                    # none | manual | the_odds_api
    "providers.odds.bookmakers": "williamhill_us",  # The Odds API bookmaker keys, comma-separated; empty = all US books
    "providers.ufcstats_mirror.base_url": "https://raw.githubusercontent.com/Greco1899/scrape_ufc_stats/main",
    "providers.min_request_interval_s": 2.0,
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
