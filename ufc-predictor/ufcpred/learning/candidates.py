"""Candidate model changes, each tied to the evidence that motivated it.

A candidate is a *methodology* change (a ModelConfig diff). It is only ever adopted after
a chronological out-of-sample comparison against the incumbent (see promotion.py).
"""
from __future__ import annotations

from dataclasses import dataclass

from ..config import ModelConfig

HALF_LIVES = [270.0, 540.0, 1080.0]


@dataclass
class Candidate:
    kind: str
    description: str
    config: ModelConfig
    hypothesis_key: str | None = None
    primary_metric: str = "winner_log_loss"     # or method_log_loss


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
        if k in ("favorites", "big_favorites", "five_round_favorites"):
            if eff < 0:
                add(Candidate("regularisation", f"Favourites over-estimated ({h['interpretation']}): strengthen priors on "
                              "A/B/D by 2×", incumbent.with_changes(l2=_scale_l2(incumbent, ["A_baseline", "B_form",
                                                                                              "D_durability"], 2.0)), k))
                add(Candidate("calibration", "Favourites over-estimated: try symmetrised isotonic calibration",
                              incumbent.with_changes(calibration="isotonic"), k))
            else:
                add(Candidate("regularisation", f"Favourites under-estimated ({h['interpretation']}): weaken priors on "
                              "A/B/D by 2×", incumbent.with_changes(l2=_scale_l2(incumbent, ["A_baseline", "B_form",
                                                                                              "D_durability"], 0.5)), k))
        elif k in ("top_control_wrestlers", "takedown_defense"):
            add(Candidate("feature_group", f"{h['description']}: add grappling/control interaction terms to Model C",
                          incumbent.with_changes(style_v2=True), k))
            add(Candidate("regularisation", f"{h['description']}: loosen Model C prior",
                          incumbent.with_changes(l2=_scale_l2(incumbent, ["C_style"], 0.5)), k))
        elif k == "weak_opposition_streak":
            add(Candidate("decay", "Recent streaks over-valued: lengthen form half-life",
                          incumbent.with_changes(half_life_days=min(incumbent.half_life_days * 2, 2160)), k))
        elif k in ("low_experience_favorites", "debutants"):
            add(Candidate("ensemble", f"{h['description']}: let ensemble weights vary with experience",
                          incumbent.with_changes(evidence_gating=True), k))
            add(Candidate("shrinkage", f"{h['description']}: stronger shrinkage of small-sample rates",
                          incumbent.with_changes(prior_minutes=incumbent.prior_minutes * 2), k))
        elif k in ("aging_fighters", "long_layoff", "moving_up", "short_notice"):
            add(Candidate("regularisation", f"{h['description']}: loosen Model E (context) prior",
                          incumbent.with_changes(l2=_scale_l2(incumbent, ["E_context"], 0.5)), k))
        elif k in ("ko_vs_durable", "decision_rate"):
            add(Candidate("method_model", f"{h['description']}: stronger regularisation of the method model",
                          incumbent.with_changes(l2={"method": incumbent.l2["method"] * 3}), k, "method_log_loss"))
            add(Candidate("method_model", f"{h['description']}: weaker regularisation of the method model",
                          incumbent.with_changes(l2={"method": incumbent.l2["method"] / 3}), k, "method_log_loss"))
        if len(out) >= max_candidates:
            return out[:max_candidates]

    # Routine experiments: re-validate the decay rate and ensemble structure even when no weakness is supported.
    for hl in HALF_LIVES:
        if hl != incumbent.half_life_days:
            add(Candidate("decay", f"Routine re-validation of the form half-life ({incumbent.half_life_days:.0f} → "
                          f"{hl:.0f} days)", incumbent.with_changes(half_life_days=hl)))
    add(Candidate("ensemble", "Routine experiment: experience-gated ensemble weights",
                  incumbent.with_changes(evidence_gating=not incumbent.evidence_gating)))
    add(Candidate("feature_group", "Routine experiment: toggle extended style interactions",
                  incumbent.with_changes(style_v2=not incumbent.style_v2)))
    return out[:max_candidates]
