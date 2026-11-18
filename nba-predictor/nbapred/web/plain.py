"""Plain-English wording for the web UI: stat names, hover descriptions and readable factor lines.

Display only. Stored predictions (and their hashes) are never rewritten; the pages translate them when
they are shown.
"""
from __future__ import annotations

import re

from markupsafe import Markup, escape

from ..features.catalog import BY_NAME

# stat key -> (short label, what it tracks, value format)
STATS: dict[str, tuple[str, str, str]] = {
    "elo": ("Power rating", "A running score built from wins, losses and margins. Everyone starts at 1505; beating a "
            "good team by a lot raises it more than beating a weak one by a little. Around 1500 is average.", "{:.0f}"),
    "net": ("Net rating", "Points scored minus points allowed per 100 possessions this season, nudged toward last "
            "season early on. +5 is a very good team; −5 a poor one.", "{:+.1f}"),
    "ortg": ("Offensive rating", "Points scored per 100 possessions. League average is about 110–115 in recent "
             "seasons.", "{:.1f}"),
    "drtg": ("Defensive rating", "Points allowed per 100 possessions. Lower is better.", "{:.1f}"),
    "pace": ("Pace", "Possessions per 48 minutes: how fast a team plays.", "{:.1f}"),
    "efg": ("Effective FG%", "Shooting percentage that counts a three as 1.5 makes.", "{:.1%}"),
    "opp_efg": ("Opponents' effective FG%", "How well opponents shoot against this team. Lower is better defence.",
                "{:.1%}"),
    "tov_pct": ("Turnover rate", "Share of possessions that end in a turnover. Lower is better.", "{:.1%}"),
    "opp_tov_pct": ("Turnovers forced", "Share of opponents' possessions that end in a turnover.", "{:.1%}"),
    "oreb_pct": ("Offensive rebound %", "Share of their own missed shots they rebound.", "{:.1%}"),
    "dreb_pct": ("Defensive rebound %", "Share of opponents' misses they rebound.", "{:.1%}"),
    "ftr": ("Free-throw rate", "Free throws made per field-goal attempt: how often they get to the line.", "{:.3f}"),
    "fg3a_rate": ("Three-point rate", "Share of shots taken from three.", "{:.0%}"),
    "fg3_pct": ("Three-point %", "Share of threes that go in.", "{:.1%}"),
    "opp_fg3_pct": ("Opponents' three-point %", "How well opponents shoot threes against them.", "{:.1%}"),
    "adj_net": ("Schedule-adjusted net rating", "Net rating corrected for how good each opponent was at the time.",
                "{:+.1f}"),
    "win_pct": ("Win %", "Season win percentage, nudged toward last season early on.", "{:.0%}"),
    "d_net": ("Recent net rating", "Net rating over recent games, with the latest games counting most.", "{:+.1f}"),
    "d_ortg": ("Recent offence", "Points per 100 possessions in recent games.", "{:.1f}"),
    "d_drtg": ("Recent defence", "Points allowed per 100 possessions in recent games. Lower is better.", "{:.1f}"),
    "d_win": ("Recent win rate", "Share of recent games won, with the latest counting most.", "{:.0%}"),
    "d_perf": ("Beating expectations", "How recent results compare with what the power rating predicted. Above 0 "
               "means winning more than expected lately.", "{:+.2f}"),
    "d_opp_elo": ("Recent opponent strength", "Average power rating of recent opponents.", "{:.0f}"),
    "streak": ("Streak", "Current run of wins (+) or losses (−) this season.", "{:+.0f}"),
    "last10": ("Last 10", "Record over the last ten games this season.", "{}"),
    "margin_sd": ("Volatility", "How much the final margin swings from game to game (points).", "{:.1f}"),
    "close_win": ("Close-game record", "Win share in games decided by five points or fewer (nudged toward 50%).",
                  "{:.0%}"),
    "blowout_loss": ("Blowout losses", "Share of games lost by 15 or more.", "{:.0%}"),
    "days_rest": ("Days of rest", "Full days off since the previous game (0 = second night of a back-to-back).",
                  "{:.0f}"),
    "b2b": ("Back-to-back", "Played yesterday.", "{}"),
    "games_last_4": ("Games in last 4 days", "Games already played in the previous three days.", "{:.0f}"),
    "travel_km": ("Travel", "Distance from the previous game's arena to this one (km).", "{:,.0f} km"),
    "tz_shift": ("Time zones crossed", "Time zones between the previous game and this one.", "{:.0f}"),
    "road_trip": ("Road trip", "Games into the current road trip (0 = at home).", "{:.0f}"),
    "venue_elevation": ("Altitude", "Arena elevation in metres; Denver and Salt Lake City are high.", "{:,.0f} m"),
    "opp_ftr": ("Opponents' free-throw rate", "Free throws opponents make per shot attempt: how often this team "
                "fouls.", "{:.3f}"),
    "opp_fg3a_rate": ("Threes conceded", "Share of opponents' shots taken from three.", "{:.0%}"),
    "out": ("Rotation players out", "Players from the regular rotation ruled out for this game (from the injury "
            "report, when recorded).", "{}"),
    "season_games": ("Games played", "Games played this season before tonight.", "{:.0f}"),
    "n_games": ("Games on record", "Games in the database before tonight.", "{:.0f}"),
    "wins": ("Wins", "Wins this season.", "{:.0f}"), "losses": ("Losses", "Losses this season.", "{:.0f}"),
    "market_p": ("Betting odds", "Chance of winning implied by the moneyline.", "{:.0%}"),
    "box_coverage": ("Box scores", "Share of this season's games with a full box score.", "{:.0%}"),
    "is_home": ("Home", "1 = playing at home.", "{}"),
}

FACTORS: dict[str, str] = {
    "elo": "Higher power rating", "net": "Better net rating", "ortg": "Better offence", "drtg": "Defensive rating",
    "win_pct": "Better record", "efg": "Shoots better", "opp_efg": "Opponents shoot against them",
    "tov_pct": "Turnover rate", "opp_tov_pct": "Forces more turnovers", "oreb_pct": "Offensive rebounding",
    "dreb_pct": "Defensive rebounding", "ftr": "Gets to the line", "adj_net": "Better schedule-adjusted rating",
    "d_net": "Playing better lately", "d_ortg": "Scoring more lately", "d_drtg": "Defending better lately",
    "d_win": "Winning more lately", "d_perf": "Recent results better than expected",
    "d_opp_elo": "Has faced tougher recent opponents", "streak": "Current streak", "last10": "Last ten games",
    "shooting_matchup": "Shooting matchup", "turnover_matchup": "Turnover battle", "glass_matchup": "Rebounding matchup",
    "foul_matchup": "Free-throw matchup", "pace_x_offense": "Tempo against this defence",
    "three_matchup": "Three-point matchup", "three_accuracy": "Three-point accuracy matchup",
    "margin_sd": "Consistency (volatility)", "close_win": "Close-game record", "blowout_loss": "Fewer blowout losses",
    "consistency": "Steady quality", "home": "Home court", "rest": "Better rested", "b2b": "Back-to-back",
    "three_in_four": "Three games in four nights", "travel": "Less travel", "tz_shift": "Time-zone change",
    "altitude": "Altitude", "road_trip": "Long road trip", "early_season_elo": "Early-season rating",
    "playoff_elo": "Rating in the playoffs", "players_out": "Players out", "market": "Betting odds",
}

GROUPS = {"A_baseline": "Season strength", "A_oppadj": "Season strength", "B_form": "Recent form",
          "C_style": "Style matchup", "C_style_v2": "Style matchup", "D_volatility": "Consistency",
          "E_context": "Situation", "F_market": "Betting odds"}

BASELINES = {"Coin flip (50/50)": "Coin flip", "Elo only": "Higher power rating always wins",
             "Home team always wins": "Home team always wins", "Better record wins": "Better record always wins"}

TERMS = {
    "replay": "A past game the engine predicted using only information available before that night, then checked "
              "against the real result. Used to test the engine fairly.",
    "confidence": "How much to trust this pick, based on how much is known about both teams tonight and whether the "
                  "engine's parts agree. It is not the chance of winning.",
    "locked": "Saved before tip-off and never changed afterwards. Only locked picks are graded.",
    "estimate": "Produced by the prediction engine, not an official figure.",
    "honest": "When the engine says 70%, that team should win about 7 times out of 10. This shows how far off it has "
              "been on average.",
    "line": "The engine's own point spread: the handicap that would make each side a coin flip. Negative = favoured.",
    "ats": "Against the spread: whether the side the engine preferred covered the bookmaker's point spread.",
}

SEASON_TYPES = {"regular": "Regular season", "playoffs": "Playoffs", "playin": "Play-in", "cup_final": "NBA Cup final",
                "preseason": "Preseason"}
BUCKETS = {"CLOSE": "by 1–5", "SOLID": "by 6–12", "BLOWOUT": "by 13+"}


def _fmt(key: str, v) -> str:
    if v is None:
        return "unknown"
    if key in ("is_home", "b2b", "early_season"):
        return "yes" if v else "no"
    fmt = STATS.get(key, ("", "", "{}"))[2]
    try:
        return fmt.format(v)
    except (ValueError, TypeError):
        return str(v)


def tip(label: str, text: str | None) -> Markup:
    if not text:
        return escape(label)
    return Markup('<span class="tip" tabindex="0" data-tip="{}">{}</span>').format(text, label)


def stat(key: str, label: str | None = None) -> Markup:
    lab, desc, _ = STATS.get(key, (key, "", "{}"))
    return tip(label or lab, desc)


def stat_value(key: str, v) -> str:
    return _fmt(key, v)


def term(key: str, label: str) -> Markup:
    return tip(label, TERMS.get(key))


def strength(logit: float) -> tuple[str, int]:
    a = abs(logit or 0)
    if a >= 0.25:
        return "big edge", 3
    if a >= 0.10:
        return "clear edge", 2
    return "slight edge", 1


def factor(x: dict, stats: dict, home_name: str, away_name: str) -> dict:
    """A stored factor line, rewritten for people: headline, both teams' numbers, edge size."""
    name = x.get("feature")
    f = BY_NAME.get(name)
    keys = list(f.show) if f else []
    vals = []
    for k in keys[:2]:
        label, desc, _ = STATS.get(k, (k, "", "{}"))
        h, a = (stats.get("home") or {}).get(k), (stats.get("away") or {}).get(k)
        vals.append({"key": k, "label": label, "desc": desc, "home": _fmt(k, h), "away": _fmt(k, a)})
    word, level = strength(x.get("logit", 0))
    return {"title": FACTORS.get(name, (f.label if f else name).capitalize()), "group": GROUPS.get(x.get("group"), ""),
            "stats": vals, "strength": word, "level": level, "imputed": x.get("imputed"),
            "home_name": home_name, "away_name": away_name}


_REASONS = [
    (r"^early season: one team has played only (\d+) game\(s\).*",
     r"Early season: one team has played only \1 game(s), so its ratings lean on last season."),
    (r"^limited season sample \(minimum (\d+) games played\)", r"One team has played only \1 games so far this season."),
    (r"^injury report not recorded.*", "We don't know who is ruled out tonight (no injury report recorded)."),
    (r"^(\d+) rotation players out on one side.*", r"\1 rotation players are out for one team; the engine has little "
     r"history of how much that matters."),
    (r"^wide model uncertainty.*", "The numbers point in different directions, so the range of outcomes is wide."),
    (r"^sub-models disagree.*", "Different parts of the engine disagree about this game."),
    (r"^(\d+) inputs unknown and imputed", r"\1 pieces of information are missing and had to be estimated."),
    (r"^historical predictions in the .* band were miscalibrated \((\d+%) correct vs (\d+%) stated, n=(\d+)\)",
     r"Past picks at these odds were right \1 of the time when the engine expected \2 (\3 games)."),
    (r"^Imputed \(unknown\) inputs: .*", None),
]


def plainify(text: str) -> str | None:
    for pat, rep in _REASONS:
        if re.match(pat, text or ""):
            return None if rep is None else re.sub(pat, rep, text)
    return text


def season_label(t: str | None) -> str:
    return SEASON_TYPES.get(t, t or "—")


def bucket_label(b: str | None) -> str:
    return BUCKETS.get(b, b or "—")


def line(v: float | None, who: str = "home") -> str:
    """A point spread from the home side's point of view, e.g. 'BOS −5.5' or 'pick'em'."""
    if v is None:
        return "—"
    if abs(v) < 0.25:
        return "pick'em"
    return f"{who} {'−' if v < 0 else '+'}{abs(v):.1f}"


def install(env) -> None:
    env.globals.update(stat=stat, stat_value=stat_value, term=term, tip=tip, factor=factor, season_label=season_label,
                       bucket_label=bucket_label, line=line, GROUP_NAMES=GROUPS, BASELINE_NAMES=BASELINES,
                       FACTOR_NAMES=FACTORS, plainify=plainify, STATS=STATS)
