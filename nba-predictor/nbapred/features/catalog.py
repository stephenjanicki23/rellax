"""Feature catalog for the sub-models.

Every win-probability feature is *antisymmetric*: value(A, B) = side(A, B) − side(B, A). With no
intercept, the models satisfy P(A beats B) = 1 − P(B beats A) exactly. Home court is itself a
feature (side = 1 for the home team, 0 for the visitor and for both teams at a neutral site), so its
size is learned rather than assumed. `side` returns None when an input is unknown; the matrix builder
records the gap and imputes the training-fold mean (never a silent zero).

The total-points model uses *symmetric* features (both teams together) relative to the league
average at that date, so it adapts to scoring eras.
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
    label: str
    show: tuple = ()
    fmt: str = "{:.2f}"


def _A(k):
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


def _B(k):
    return lambda a, b, c: b.get(k)


def _one_minus_B(k):
    return lambda a, b, c: None if b.get(k) is None else 1 - b[k]


def _home(a, b, c):
    return float(a.get("is_home") == 1)


def _rest(a, b, c):
    r = a.get("days_rest")
    return None if r is None else float(min(r, 3))


def _b2b(a, b, c):
    return a.get("b2b")


def _travel(a, b, c):
    km = a.get("travel_km")
    return None if km is None else math.log1p(km / 1000.0)


def _tz(a, b, c):
    return a.get("tz_shift")


def _altitude(a, b, c):
    e = a.get("venue_elevation")
    if e is None:
        return None
    return float(a.get("is_home") == 1) * e / 1000.0


def _road(a, b, c):
    return math.log1p(a.get("road_trip") or 0)


def _out(a, b, c):
    return a.get("out")


def _early_elo(a, b, c):
    return a.get("early_season", 0) * (a["elo"] - 1505) / 100


def _sharpe(a, b, c):
    if a.get("net") is None or not a.get("margin_sd"):
        return None
    return a["net"] / a["margin_sd"]


def _market(a, b, c):
    p = a.get("market_p")
    if p is None:
        return None
    p = min(max(p, 1e-4), 1 - 1e-4)
    return 0.5 * math.log(p / (1 - p))


def _playoff_elo(a, b, c):
    return c.get("playoffs", 0) * (a["elo"] - 1505) / 100


FEATURES: list[Feat] = [
    # ---------------- Model A: season strength (shrunk toward last season, regressed to the mean)
    Feat("elo", "A_baseline", _A("elo"), "Elo rating (results and margins, opponent-adjusted)", ("elo",), "{:.0f}"),
    Feat("net", "A_baseline", _A("net"), "net rating (points per 100 possessions, scored minus allowed)", ("net",), "{:+.1f}"),
    Feat("ortg", "A_baseline", _A("ortg"), "offensive rating", ("ortg",), "{:.1f}"),
    Feat("drtg", "A_baseline", _A("drtg"), "defensive rating (points allowed per 100)", ("drtg",), "{:.1f}"),
    Feat("win_pct", "A_baseline", _A("win_pct"), "season win percentage (shrunk)", ("wins", "losses"), "{:.3f}"),
    Feat("efg", "A_baseline", _A("efg"), "effective field-goal %", ("efg",), "{:.1%}"),
    Feat("opp_efg", "A_baseline", _A("opp_efg"), "opponents' effective field-goal %", ("opp_efg",), "{:.1%}"),
    Feat("tov_pct", "A_baseline", _A("tov_pct"), "turnover rate", ("tov_pct",), "{:.1%}"),
    Feat("opp_tov_pct", "A_baseline", _A("opp_tov_pct"), "turnovers forced", ("opp_tov_pct",), "{:.1%}"),
    Feat("oreb_pct", "A_baseline", _A("oreb_pct"), "offensive rebound %", ("oreb_pct",), "{:.1%}"),
    Feat("dreb_pct", "A_baseline", _A("dreb_pct"), "defensive rebound %", ("dreb_pct",), "{:.1%}"),
    Feat("ftr", "A_baseline", _A("ftr"), "free throws made per shot attempt", ("ftr",), "{:.3f}"),
    # strength-adjusted (enabled only by a validated candidate: ModelConfig.opp_adjusted)
    Feat("adj_net", "A_oppadj", _A("adj_net"), "schedule-adjusted net rating", ("adj_net",), "{:+.1f}"),
    # ---------------- Model B: recent form (time-decayed)
    Feat("d_net", "B_form", _A("d_net"), "recent net rating (time-decayed)", ("d_net",), "{:+.1f}"),
    Feat("d_ortg", "B_form", _A("d_ortg"), "recent offensive rating", ("d_ortg",), "{:.1f}"),
    Feat("d_drtg", "B_form", _A("d_drtg"), "recent defensive rating", ("d_drtg",), "{:.1f}"),
    Feat("d_win", "B_form", _A("d_win"), "recent win rate", ("d_win",), "{:.0%}"),
    Feat("d_perf", "B_form", _A("d_perf"), "recent results vs. Elo expectation", ("d_perf",), "{:+.2f}"),
    Feat("d_opp_elo", "B_form", _A("d_opp_elo"), "strength of recent opponents", ("d_opp_elo",), "{:.0f}"),
    Feat("streak", "B_form", _A("streak"), "current streak", ("streak",), "{:+.0f}"),
    Feat("last10", "B_form", _A("last10_win"), "last ten games", ("last10",), "{}"),
    # ---------------- Model C: style matchup (interactions)
    Feat("shooting_matchup", "C_style", _prod(_A("efg"), _B("opp_efg")),
         "shooting vs. opponent's shooting defense", ("efg", "opp_efg")),
    Feat("turnover_matchup", "C_style", _prod(_A("opp_tov_pct"), _B("tov_pct")),
         "turnovers forced vs. opponent's ball security", ("opp_tov_pct", "tov_pct")),
    Feat("glass_matchup", "C_style", _prod(_A("oreb_pct"), _one_minus_B("dreb_pct")),
         "offensive rebounding vs. opponent's defensive rebounding", ("oreb_pct", "dreb_pct")),
    Feat("foul_matchup", "C_style", _prod(_A("ftr"), _B("opp_ftr")),
         "getting to the line vs. opponent's fouling", ("ftr", "opp_ftr")),
    Feat("pace_x_offense", "C_style", _prod(_A("pace"), _B("drtg")),
         "tempo against opponent's defence", ("pace", "drtg")),
    # style_v2 (enabled only by a validated candidate)
    Feat("three_matchup", "C_style_v2", _prod(_A("fg3a_rate"), _B("opp_fg3_pct")),
         "three-point volume vs. opponent's three-point defence", ("fg3a_rate", "opp_fg3_pct")),
    Feat("three_accuracy", "C_style_v2", _prod(_A("fg3_pct"), _B("opp_fg3a_rate")),
         "three-point accuracy vs. threes the opponent concedes", ("fg3_pct", "opp_fg3a_rate")),
    # ---------------- Model D: volatility and close games
    Feat("margin_sd", "D_volatility", _A("margin_sd"), "game-to-game margin volatility", ("margin_sd",), "{:.1f}"),
    Feat("close_win", "D_volatility", _A("close_win"), "record in games decided by 5 or fewer (shrunk)",
         ("close_win",), "{:.0%}"),
    Feat("blowout_loss", "D_volatility", _A("blowout_loss"), "share of games lost by 15+", ("blowout_loss",), "{:.0%}"),
    Feat("consistency", "D_volatility", _sharpe, "net rating relative to volatility", ("net", "margin_sd")),
    # ---------------- Model E: situation
    Feat("home", "E_context", _home, "home court", ("is_home",), "{}"),
    Feat("rest", "E_context", _rest, "days of rest", ("days_rest",), "{:.0f}"),
    Feat("b2b", "E_context", _b2b, "second night of a back-to-back", ("b2b",), "{}"),
    Feat("three_in_four", "E_context", _A("three_in_four"), "third game in four nights", ("games_last_4",), "{:.0f}"),
    Feat("travel", "E_context", _travel, "distance travelled since the last game", ("travel_km",), "{:.0f}"),
    Feat("tz_shift", "E_context", _tz, "time zones crossed since the last game", ("tz_shift",), "{:.0f}"),
    Feat("altitude", "E_context", _altitude, "home altitude", ("venue_elevation",), "{:.0f}"),
    Feat("road_trip", "E_context", _road, "length of the current road trip", ("road_trip",), "{:.0f}"),
    Feat("early_season_elo", "E_context", _early_elo, "early-season rating (fewer than 10 games)",
         ("season_games", "elo"), "{:.0f}"),
    Feat("playoff_elo", "E_context", _playoff_elo, "rating in a playoff game", ("elo",), "{:.0f}"),
    Feat("players_out", "E_context", _out, "rotation players ruled out", ("out",), "{}"),
    # ---------------- Model F: market (only with odds)
    Feat("market", "F_market", _market, "de-vigged market probability", ("market_p",), "{:.0%}"),
]

BY_NAME = {f.name: f for f in FEATURES}


def features_for(group: str, style_v2: bool = False, opp_adjusted: bool = False) -> list[Feat]:
    out = [f for f in FEATURES if f.group == group]
    if opp_adjusted and group == "A_baseline":
        out += [f for f in FEATURES if f.group == "A_oppadj"]
    if group == "C_style" and style_v2:
        out += [f for f in FEATURES if f.group == "C_style_v2"]
    return out


def value(feat: Feat, a: dict, b: dict, ctx: dict) -> Optional[float]:
    va, vb = feat.side(a, b, ctx), feat.side(b, a, ctx)
    if va is None or vb is None:
        return None
    return float(va) - float(vb)


# ---------------------------------------------------------------------- total-points model (symmetric)
def _lg(a, k):
    return a["league"][k]


def _sum_dev(k):
    def f(a, b, c):
        if a.get(k) is None or b.get(k) is None:
            return None
        return a[k] + b[k] - 2 * _lg(a, k)
    return f


def _expected_total(a, b, c):
    """Possessions × efficiency: both offences against the other defence, relative to the league total."""
    need = ("pace", "ortg", "drtg")
    if any(a.get(k) is None or b.get(k) is None for k in need):
        return None
    lg_o = _lg(a, "ortg")
    poss = (a["pace"] + b["pace"]) / 2
    pts_a = poss * (a["ortg"] + b["drtg"] - lg_o) / 100
    pts_b = poss * (b["ortg"] + a["drtg"] - lg_o) / 100
    return pts_a + pts_b - _lg(a, "total")


def _form_total(a, b, c):
    if any(x.get(k) is None for x in (a, b) for k in ("d_ortg", "d_drtg")):
        return None
    return (a["d_ortg"] + b["d_ortg"] + a["d_drtg"] + b["d_drtg"]) - 4 * _lg(a, "ortg")


TOTAL_FEATURES = [
    ("expected_total", _expected_total, "pace × efficiency projection"),
    ("pace_sum", _sum_dev("pace"), "combined pace"),
    ("offense_sum", _sum_dev("ortg"), "combined offensive rating"),
    ("defense_sum", _sum_dev("drtg"), "combined defensive rating"),
    ("form_total", _form_total, "recent scoring and allowing"),
    ("ftr_sum", _sum_dev("ftr"), "combined free-throw rate"),
    ("fg3_sum", _sum_dev("fg3a_rate"), "combined three-point volume"),
    ("b2b_any", lambda a, b, c: None if a.get("b2b") is None or b.get("b2b") is None else a["b2b"] + b["b2b"],
     "tired legs (back-to-backs)"),
    ("altitude", lambda a, b, c: (a.get("venue_elevation") or 0) / 1000.0, "altitude"),
    ("playoffs", lambda a, b, c: float(c.get("playoffs", 0)), "playoff game"),
    ("early", lambda a, b, c: a.get("early_season", 0) + b.get("early_season", 0), "early season"),
]
