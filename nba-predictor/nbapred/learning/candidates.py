"""Candidate model changes, each tied to the evidence that motivated it.

A candidate is a *methodology* change (a ModelConfig diff). It is only ever adopted after a
chronological out-of-sample comparison against the incumbent (see promotion.py).
"""
from __future__ import annotations

from dataclasses import dataclass

from ..config import ModelConfig

HALF_LIVES = [15.0, 30.0, 60.0]


@dataclass
class Candidate:
    kind: str
    description: str
    config: ModelConfig
    hypothesis_key: str | None = None
    primary_metric: str = "winner_log_loss"     # or bucket_log_loss | total_mae


def _scale_l2(cfg: ModelConfig, groups: list[str], factor: float) -> dict:
    return {g: cfg.l2[g] * factor for g in groups}


def generate(incumbent: ModelConfig, hypotheses: list[dict], max_candidates: int = 3,
             tried: set[str] | None = None) -> list[Candidate]:
    """Map supported weaknesses to testable changes; fall back to routine re-tuning experiments."""
    tried = tried or set()
    out: list[Candidate] = []
    supported = sorted((h for h in hypotheses if h["status"] == "supported"), key=lambda h: h["q_value"])

    def add(c: Candidate):
        fp = c.config.fingerprint()
        if fp == incumbent.fingerprint() or fp in tried or any(x.config.fingerprint() == fp for x in out):
            return
        out.append(c)

    for h in supported:
        k, eff = h["key"], h["effect"] or 0
        if k in ("favorites", "big_favorites", "road_favorites", "playoffs"):
            if eff < 0:
                add(Candidate("regularisation", f"Favourites over-estimated ({h['interpretation']}): strengthen priors "
                              "on A/B by 2×", incumbent.with_changes(l2=_scale_l2(incumbent, ["A_baseline", "B_form"],
                                                                                    2.0)), k))
                add(Candidate("calibration", "Favourites over-estimated: try symmetrised isotonic calibration",
                              incumbent.with_changes(calibration="isotonic"), k))
            else:
                add(Candidate("regularisation", f"Favourites under-estimated ({h['interpretation']}): weaken priors "
                              "on A/B by 2×", incumbent.with_changes(l2=_scale_l2(incumbent, ["A_baseline", "B_form"],
                                                                                    0.5)), k))
        elif k in ("home_court", "back_to_back", "rest_advantage", "long_road_trip", "altitude"):
            add(Candidate("regularisation", f"{h['description']}: loosen Model E (situation) prior",
                          incumbent.with_changes(l2=_scale_l2(incumbent, ["E_context"], 0.5)), k))
            add(Candidate("regularisation", f"{h['description']}: tighten Model E (situation) prior",
                          incumbent.with_changes(l2=_scale_l2(incumbent, ["E_context"], 2.0)), k))
        elif k == "early_season":
            add(Candidate("ensemble", f"{h['description']}: let ensemble weights shift in the first 10 games",
                          incumbent.with_changes(evidence_gating=True), k))
            add(Candidate("shrinkage", f"{h['description']}: lean on last season for longer (prior games ×2)",
                          incumbent.with_changes(prior_games=incumbent.prior_games * 2), k))
            add(Candidate("shrinkage", f"{h['description']}: carry less of last season over",
                          incumbent.with_changes(carryover=max(0.3, incumbent.carryover - 0.2)), k))
        elif k in ("hot_streak", "form_vs_season"):
            add(Candidate("decay", f"{h['description']}: lengthen the form half-life",
                          incumbent.with_changes(half_life_days=min(incumbent.half_life_days * 2, 120)), k))
            add(Candidate("decay", f"{h['description']}: shorten the form half-life",
                          incumbent.with_changes(half_life_days=max(incumbent.half_life_days / 2, 7)), k))
        elif k in ("blowout_rate", "close_game_rate"):
            add(Candidate("calibration", f"{h['description']}: isotonic calibration (reshapes the margin spread)",
                          incumbent.with_changes(calibration="isotonic"), k, "bucket_log_loss"))
        elif k in ("total_bias", "fast_pace_totals"):
            add(Candidate("total_model", f"{h['description']}: weaker regularisation of the total-points model",
                          incumbent.with_changes(l2={"total": incumbent.l2["total"] / 3}), k, "total_mae"))
            add(Candidate("total_model", f"{h['description']}: stronger regularisation of the total-points model",
                          incumbent.with_changes(l2={"total": incumbent.l2["total"] * 3}), k, "total_mae"))
        if len(out) >= max_candidates:
            return out[:max_candidates]

    # Routine experiments: re-validate structure even when no weakness is supported.
    if not incumbent.opp_adjusted:
        add(Candidate("feature_group", "Routine experiment: add a schedule-adjusted net rating (margins relative to "
                      "how good each opponent was at the time)", incumbent.with_changes(opp_adjusted=True)))
    if not incumbent.style_v2:
        add(Candidate("feature_group", "Routine experiment: add three-point matchup terms (volume vs. opponent's "
                      "three-point defence, accuracy vs. threes conceded)", incumbent.with_changes(style_v2=True)))
    for hl in HALF_LIVES:
        if hl != incumbent.half_life_days:
            add(Candidate("decay", f"Routine re-validation of the form half-life ({incumbent.half_life_days:.0f} → "
                          f"{hl:.0f} days)", incumbent.with_changes(half_life_days=hl)))
    add(Candidate("ensemble", "Routine experiment: early-season-gated ensemble weights",
                  incumbent.with_changes(evidence_gating=not incumbent.evidence_gating)))
    add(Candidate("shrinkage", "Routine experiment: season prior worth 20 games instead of "
                  f"{incumbent.prior_games:.0f}", incumbent.with_changes(prior_games=20.0 if incumbent.prior_games != 20 else 8.0)))
    return out[:max_candidates]
