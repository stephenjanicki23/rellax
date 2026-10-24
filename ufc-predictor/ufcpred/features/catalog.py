"""Feature catalog for the sub-models.

Every feature is *antisymmetric*: value(A, B) = side(A, B) − side(B, A). With no intercept,
the models therefore satisfy P(A beats B) = 1 − P(B beats A) exactly, and corner position
cannot leak into a prediction. `side` returns None when an input is unknown; the matrix
builder records the gap and imputes the training-fold mean (never a silent zero).
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable, Optional


@dataclass(frozen=True)
class Feat:
    name: str
    group: str
    side: Callable[[dict, dict, dict], Optional[float]]
    label: str                    # neutral name of the quantity (direction comes from the contribution sign)
    show: tuple = ()              # state keys to display for both fighters in explanations
    fmt: str = "{:.2f}"


def _g(k):
    return lambda a, b, c: a.get(k)


def _prod(*parts):
    def f(a, b, c):
        vals = [p(a, b, c) for p in parts]
        if any(v is None for v in vals):
            return None
        out = 1.0
        for v in vals:
            out *= v
        return out
    return f


def _A(k):
    return lambda a, b, c: a.get(k)


def _B(k):
    return lambda a, b, c: b.get(k)


def _one_minus_B(k):
    return lambda a, b, c: None if b.get(k) is None else 1 - b[k]


def _southpaw_edge(a, b, c):
    if not a.get("stance") or not b.get("stance"):
        return None
    return 1.0 if (a["stance"] == "Southpaw" and b["stance"] == "Orthodox") else 0.0


def _age_sq(a, b, c):
    return None if a.get("age") is None else ((a["age"] - 29.0) / 5.0) ** 2


def _log_layoff(a, b, c):
    d = a.get("days_since_last")
    return None if d is None else math.log1p(max(d, 0) / 30.0)


def _long_layoff(a, b, c):
    d = a.get("days_since_last")
    return None if d is None else float(d > 450)


def _five(k):
    def f(a, b, c):
        v = a.get(k)
        return None if v is None else v * c.get("five_round", 0)
    return f


def _short_notice(a, b, c):
    return a.get("short_notice")


def _weight_miss(a, b, c):
    return a.get("weight_miss")


def _low_exp(a, b, c):
    return float(a.get("n_fights", 0) < 3)


def _age_x_koloss(a, b, c):
    if a.get("age") is None:
        return None
    return max(a["age"] - 32, 0) * a["ko_loss_rate"]


def _market(a, b, c):
    p = a.get("market_p")
    if p is None:
        return None
    p = min(max(p, 1e-4), 1 - 1e-4)
    return 0.5 * math.log(p / (1 - p))   # side value; antisymmetric difference = full logit


FEATURES: list[Feat] = [
    # ---------------- Model A: statistical baseline (career, opponent-adjusted via Elo)
    Feat("elo", "A_baseline", _A("elo"), "Elo rating (results-based, opponent-adjusted)", ("elo",), "{:.0f}"),
    Feat("win_rate", "A_baseline", _A("win_rate"), "UFC win rate (shrunk)", ("wins", "losses"), "{:.2f}"),
    Feat("slpm", "A_baseline", _A("slpm"), "significant strikes landed per minute", ("slpm",)),
    Feat("sapm", "A_baseline", _A("sapm"), "significant strikes absorbed per minute", ("sapm",)),
    Feat("str_acc", "A_baseline", _A("str_acc"), "significant-strike accuracy", ("str_acc",), "{:.0%}"),
    Feat("str_def", "A_baseline", _A("str_def"), "significant-strike defense", ("str_def",), "{:.0%}"),
    Feat("td15", "A_baseline", _A("td15"), "takedowns landed per 15 min", ("td15",)),
    Feat("td_def", "A_baseline", _A("td_def"), "takedown defense", ("td_def",), "{:.0%}"),
    Feat("sub15", "A_baseline", _A("sub15"), "submission attempts per 15 min", ("sub15",)),
    Feat("kd15", "A_baseline", _A("kd15"), "knockdowns per 15 min", ("kd15",)),
    Feat("ctrl_share", "A_baseline", _A("ctrl_share"), "share of fight time in control", ("ctrl_share",), "{:.0%}"),
    Feat("log_exp", "A_baseline", _A("log_exp"), "UFC experience", ("n_fights",), "{:.0f}"),
    Feat("age", "A_baseline", _A("age"), "age on fight night", ("age",), "{:.1f}"),
    Feat("height", "A_baseline", _A("height"), "height", ("height",), "{:.0f}"),
    Feat("reach", "A_baseline", _A("reach"), "reach", ("reach",), "{:.0f}"),
    # ---------------- Model B: recent form (time-decayed, opponent-strength aware)
    Feat("d_slpm", "B_form", _A("d_slpm"), "recent (time-decayed) striking output", ("d_slpm",)),
    Feat("d_sapm", "B_form", _A("d_sapm"), "recent (time-decayed) strikes absorbed", ("d_sapm",)),
    Feat("d_td15", "B_form", _A("d_td15"), "recent takedown volume", ("d_td15",)),
    Feat("d_td_def", "B_form", _A("d_td_def"), "recent takedown defense", ("d_td_def",), "{:.0%}"),
    Feat("d_kd15", "B_form", _A("d_kd15"), "recent knockdown rate", ("d_kd15",)),
    Feat("d_ctrl", "B_form", _A("d_ctrl_share"), "recent control time", ("d_ctrl_share",), "{:.0%}"),
    Feat("d_perf", "B_form", _A("d_perf"), "recent results vs. Elo expectation", ("d_perf",)),
    Feat("d_opp_elo", "B_form", _A("d_opp_elo"), "strength of recent opponents", ("d_opp_elo",), "{:.0f}"),
    Feat("d_win_rate", "B_form", _A("d_win_rate"), "time-decayed win rate", ("d_win_rate",)),
    Feat("streak", "B_form", _A("streak"), "current streak", ("streak",), "{:+.0f}"),
    # ---------------- Model C: style matchup (interactions)
    Feat("strike_exchange", "C_style", _prod(_A("slpm"), _one_minus_B("str_def")),
         "striking output vs. opponent's striking defense", ("slpm", "str_def")),
    Feat("takedown_threat", "C_style", _prod(_A("td15"), _one_minus_B("td_def")),
         "takedown offense vs. opponent's takedown defense", ("td15", "td_def")),
    Feat("sub_threat", "C_style", _prod(_A("sub15"), _B("sub_loss_rate")),
         "submission threat vs. opponent's submission losses", ("sub15", "sub_loss_rate")),
    Feat("reach_distance", "C_style", _prod(_A("reach"), _A("dist_share")),
         "reach used at distance", ("reach", "dist_share")),
    Feat("southpaw_edge", "C_style", _southpaw_edge, "southpaw vs. orthodox stance matchup", ("stance",), "{}"),
    Feat("pressure_vs_defense", "C_style", _prod(_A("pace"), _B("str_def")),
         "pace vs. opponent's striking defense", ("pace", "str_def")),
    Feat("ctrl_vs_tddef", "C_style", _prod(_A("ctrl_share"), _one_minus_B("td_def")),
         "control game vs. opponent's takedown defense", ("ctrl_share", "td_def")),
    # style_v2 (enabled only by a validated candidate)
    Feat("ground_threat", "C_style_v2", _prod(_A("ground_share"), _A("slpm"), _one_minus_B("td_def")),
         "ground striking vs. opponent's takedown defense", ("ground_share", "td_def")),
    Feat("pin_vs_getup", "C_style_v2", _prod(_A("ctrl_share"), _B("opp_ctrl_share")),
         "top control vs. opponent's time spent controlled", ("ctrl_share", "opp_ctrl_share")),
    Feat("power_vs_chin", "C_style_v2", _prod(_A("kd15"), _B("kd_abs15")),
         "knockdown power vs. opponent's knockdowns absorbed", ("kd15", "kd_abs15")),
    # ---------------- Model D: durability and finish risk
    Feat("ko_loss_rate", "D_durability", _A("ko_loss_rate"), "KO-loss rate", ("ko_loss_rate",), "{:.0%}"),
    Feat("sub_loss_rate", "D_durability", _A("sub_loss_rate"), "submission-loss rate", ("sub_loss_rate",), "{:.0%}"),
    Feat("kd_abs15", "D_durability", _A("kd_abs15"), "knockdowns absorbed per 15 min", ("kd_abs15",)),
    Feat("head_abs", "D_durability", _A("head_abs_pm"), "head strikes absorbed per minute", ("head_abs_pm",)),
    Feat("finish_win_rate", "D_durability", _A("finish_win_rate"), "finish rate", ("finish_win_rate",), "{:.0%}"),
    Feat("age_x_koloss", "D_durability", _age_x_koloss, "age × KO losses (durability erosion)", ("age", "ko_loss_rate")),
    # ---------------- Model E: context
    Feat("layoff", "E_context", _log_layoff, "layoff since last fight", ("days_since_last",), "{:.0f}"),
    Feat("long_layoff", "E_context", _long_layoff, "layoff over 15 months", ("days_since_last",), "{:.0f}"),
    Feat("age_sq", "E_context", _age_sq, "distance from peak age (~29)", ("age",), "{:.1f}"),
    Feat("class_change", "E_context", _A("class_change"), "weight-class change", ("class_change",), "{:+.0f}"),
    Feat("low_exp", "E_context", _low_exp, "fewer than 3 UFC fights", ("n_fights",), "{:.0f}"),
    Feat("five_round_cardio", "E_context", _five("late_ratio"), "late-round output in a five-round fight", ("late_ratio",)),
    Feat("five_round_age", "E_context", _five("age"), "age in a five-round fight", ("age",), "{:.1f}"),
    Feat("short_notice", "E_context", _short_notice, "short-notice replacement", ("short_notice",), "{}"),
    Feat("weight_miss", "E_context", _weight_miss, "missed weight", ("weight_miss",), "{}"),
    # ---------------- Model F: market (only with odds)
    Feat("market", "F_market", _market, "de-vigged market probability", ("market_p",), "{:.0%}"),
]

BY_NAME = {f.name: f for f in FEATURES}


def features_for(group: str, style_v2: bool = False) -> list[Feat]:
    out = [f for f in FEATURES if f.group == group]
    if group == "C_style" and style_v2:
        out += [f for f in FEATURES if f.group == "C_style_v2"]
    return out


def value(feat: Feat, a: dict, b: dict, ctx: dict) -> Optional[float]:
    va, vb = feat.side(a, b, ctx), feat.side(b, a, ctx)
    if va is None or vb is None:
        return None
    return float(va) - float(vb)


# Features for the method-of-victory model, oriented winner (W) vs loser (L). Not antisymmetric.
METHOD_FEATURES = [
    ("w_ko_win", lambda w, l, c: w["ko_win_rate"]),
    ("w_sub_win", lambda w, l, c: w["sub_win_rate"]),
    ("w_dec_win", lambda w, l, c: w["dec_win_rate"]),
    ("l_ko_loss", lambda w, l, c: l["ko_loss_rate"]),
    ("l_sub_loss", lambda w, l, c: l["sub_loss_rate"]),
    ("w_kd15", lambda w, l, c: w["kd15"]),
    ("l_kd_abs15", lambda w, l, c: l["kd_abs15"]),
    ("w_sub15", lambda w, l, c: w["sub15"]),
    ("w_td15", lambda w, l, c: w["td15"]),
    ("l_td_def", lambda w, l, c: l["td_def"]),
    ("pace_sum", lambda w, l, c: w["pace"] + l["pace"]),
    ("def_sum", lambda w, l, c: w["str_def"] + l["str_def"]),
    ("five_round", lambda w, l, c: float(c.get("five_round", 0))),
    ("heavy", lambda w, l, c: float(c.get("class_idx") is not None and c["class_idx"] >= 7)),
    ("light", lambda w, l, c: float(c.get("class_idx") is not None and c["class_idx"] <= 2)),
    ("women", lambda w, l, c: float(c.get("women", 0))),
    ("elo_gap", lambda w, l, c: (w["elo"] - l["elo"]) / 100),
]
METHOD_CLASSES = ["KO_TKO", "SUB", "DEC", "DQ_OTHER"]
