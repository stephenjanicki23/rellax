"""Plain-English wording for the web UI: stat names, hover descriptions and readable factor lines.

Display only. Stored predictions (and their hashes) are never rewritten; the pages translate
them when they are shown.
"""
from __future__ import annotations

from markupsafe import Markup, escape

from ..features.catalog import BY_NAME

# stat key -> (short label, what it tracks, value format)
STATS: dict[str, tuple[str, str, str]] = {
    "elo": ("Power rating", "A running score built only from wins and losses. Everyone starts at 1500; beating a "
            "highly rated opponent raises it more than beating a low-rated one. Around 1500 is average.", "{:.0f}"),
    "opp_elo_mean": ("Avg. opponent rating", "The average power rating of the fighters they have faced. Higher means "
                     "a tougher schedule.", "{:.0f}"),
    "d_opp_elo": ("Recent opponent strength", "Average power rating of recent opponents, with the latest fights "
                  "counting most.", "{:.0f}"),
    "d_perf": ("Beating expectations", "How their recent results compare with what their rating predicted. "
               "Above 0 means they have been winning more than expected lately.", "{:+.2f}"),
    "win_rate": ("UFC win rate", "Share of UFC fights won.", "{:.0%}"),
    "d_win_rate": ("Recent win rate", "Share of recent UFC fights won, with the latest fights counting most.", "{:.0%}"),
    "wins": ("UFC wins", "Wins inside the UFC.", "{:.0f}"),
    "losses": ("UFC losses", "Losses inside the UFC.", "{:.0f}"),
    "n_fights": ("UFC fights", "How many UFC fights they have had. Fights before the UFC are not counted.", "{:.0f}"),
    "slpm": ("Strikes landed per minute", "Significant strikes (clean, meaningful shots) landed for every minute "
             "of fighting. Higher means more offense.", "{:.2f}"),
    "sapm": ("Strikes absorbed per minute", "Significant strikes taken from opponents for every minute of fighting. "
             "Lower is better.", "{:.2f}"),
    "d_slpm": ("Recent strikes landed / min", "Strikes landed per minute in recent fights, with the latest fights "
               "counting most.", "{:.2f}"),
    "d_sapm": ("Recent strikes absorbed / min", "Strikes absorbed per minute in recent fights. Lower is better.", "{:.2f}"),
    "str_acc": ("Striking accuracy", "Share of significant strikes thrown that land.", "{:.0%}"),
    "str_def": ("Striking defense", "Share of opponents' significant strikes they avoid or block.", "{:.0%}"),
    "td15": ("Takedowns per 15 min", "Takedowns landed for every 15 minutes of fighting (about one full 3-round "
             "fight).", "{:.2f}"),
    "d_td15": ("Recent takedowns per 15 min", "Takedowns per 15 minutes in recent fights.", "{:.2f}"),
    "td_acc": ("Takedown accuracy", "Share of takedown attempts that succeed.", "{:.0%}"),
    "td_def": ("Takedown defense", "Share of opponents' takedown attempts they stop.", "{:.0%}"),
    "d_td_def": ("Recent takedown defense", "Takedown defense in recent fights.", "{:.0%}"),
    "sub15": ("Submission attempts per 15 min", "How often they go for a choke or joint lock, per 15 minutes.", "{:.2f}"),
    "kd15": ("Knockdowns per 15 min", "How often they knock an opponent down, per 15 minutes. A sign of punching "
             "power.", "{:.2f}"),
    "d_kd15": ("Recent knockdowns per 15 min", "Knockdown rate in recent fights.", "{:.2f}"),
    "kd_abs15": ("Knocked down per 15 min", "How often they get knocked down, per 15 minutes. Lower suggests a "
                 "sturdier chin.", "{:.2f}"),
    "adj_striking": ("Striking vs. opposition", "Strikes landed compared with what their opponents usually allow. "
                     "1.0 is typical; 1.2 means 20% more than those opponents normally give up.", "{:.2f}×"),
    "adj_absorbed": ("Strikes taken vs. opposition", "Strikes absorbed compared with what their opponents usually "
                     "land. Below 1.0 means better defence than those opponents usually face.", "{:.2f}×"),
    "adj_wrestling": ("Takedowns vs. opposition", "Takedowns landed compared with what their opponents usually give "
                      "up. Above 1.0 means a better wrestler than the opposition usually faces.", "{:.2f}×"),
    "body_pm": ("Body strikes landed / min", "Significant strikes to the body landed per minute.", "{:.2f}"),
    "leg_pm": ("Leg kicks landed / min", "Significant strikes to the legs landed per minute.", "{:.2f}"),
    "body_abs_pm": ("Body strikes absorbed / min", "Body strikes taken per minute. Lower is better.", "{:.2f}"),
    "leg_abs_pm": ("Leg kicks absorbed / min", "Leg kicks taken per minute. Lower is better.", "{:.2f}"),
    "head_abs_pm": ("Head strikes absorbed / min", "Strikes to the head taken per minute. Lower is better.", "{:.2f}"),
    "ctrl_share": ("Control time", "Share of fight time spent controlling the opponent (holding them down or "
                   "against the fence).", "{:.0%}"),
    "d_ctrl_share": ("Recent control time", "Control time in recent fights.", "{:.0%}"),
    "opp_ctrl_share": ("Time being controlled", "Share of fight time the opponent spent controlling them. Lower "
                       "is better.", "{:.0%}"),
    "ko_loss_rate": ("Knocked-out rate", "How often their UFC fights end with them being knocked out. Lower is "
                     "better.", "{:.0%}"),
    "sub_loss_rate": ("Submitted rate", "How often their UFC fights end with them being submitted. Lower is "
                      "better.", "{:.0%}"),
    "finish_win_rate": ("Finish rate", "Share of their wins by knockout or submission rather than the judges.", "{:.0%}"),
    "age": ("Age", "Age on fight night. Fighters tend to peak around 29.", "{:.0f}"),
    "height": ("Height", "Height in inches.", "{:.0f} in"),
    "reach": ("Reach", "Arm span in inches. A longer reach helps land strikes from distance.", "{:.0f} in"),
    "stance": ("Stance", "Orthodox (left foot forward), southpaw (right foot forward) or switch.", "{}"),
    "days_since_last": ("Days since last fight", "Time out of the cage. Long layoffs can mean rust.", "{:.0f}"),
    "streak": ("Streak", "Current run of wins (+) or losses (−).", "{:+.0f}"),
    "class_change": ("Weight-class change", "Moving up (+) or down (−) a division for this fight.", "{:+.0f}"),
    "late_ratio": ("Late-round output", "Strikes landed in later rounds compared with round 1. Above 1 means they "
                   "keep up the pace; below 1 means they slow down.", "{:.2f}×"),
    "dist_share": ("Strikes at distance", "Share of their strikes landed at range rather than in the clinch or on "
                   "the ground.", "{:.0%}"),
    "ground_share": ("Ground strikes", "Share of their strikes landed on the ground.", "{:.0%}"),
    "head_share": ("Head strikes", "Share of their landed strikes aimed at the head.", "{:.0%}"),
    "pace": ("Pace", "How busy they are: strikes thrown per minute.", "{:.1f}"),
    "short_notice": ("Short notice", "Took the fight with little preparation time.", "{}"),
    "weight_miss": ("Missed weight", "Came in over the agreed weight limit.", "{}"),
    "market_p": ("Betting odds", "Chance of winning implied by the betting odds.", "{:.0%}"),
    "minutes": ("Minutes tracked", "Total fight minutes with detailed statistics available.", "{:.0f}"),
}

# labels used by the stored "statistical comparison" rows -> stat key
_ADV_LABELS = {"Sig. strikes landed/min": "slpm", "Sig. strikes absorbed/min": "sapm", "Strike defense": "str_def",
               "Takedowns/15 min": "td15", "Takedown defense": "td_def", "Control-time share": "ctrl_share",
               "Knockdowns/15 min": "kd15", "Elo": "elo", "Reach (in)": "reach"}

# factor (model feature) -> plain headline
FACTORS: dict[str, str] = {
    "elo": "Higher power rating", "win_rate": "Better UFC win rate", "slpm": "Lands more strikes",
    "sapm": "Absorbs fewer strikes", "str_acc": "More accurate striker", "str_def": "Better striking defense",
    "td15": "More takedowns", "td_def": "Better takedown defense", "sub15": "More submission attempts",
    "kd15": "More knockdown power", "ctrl_share": "More control time", "log_exp": "More UFC experience",
    "age": "Age", "height": "Height", "reach": "Longer reach",
    "d_slpm": "Striking more in recent fights", "d_sapm": "Getting hit less in recent fights",
    "d_td15": "More takedowns in recent fights", "d_td_def": "Better recent takedown defense",
    "d_kd15": "More knockdowns in recent fights", "d_ctrl": "More recent control time",
    "d_perf": "Recent results better than expected", "d_opp_elo": "Has faced tougher recent opponents",
    "d_win_rate": "Better recent win rate", "streak": "Better current streak",
    "strike_exchange": "Striking matchup", "takedown_threat": "Wrestling matchup",
    "sub_threat": "Submission threat", "reach_distance": "Uses reach well at distance",
    "southpaw_edge": "Stance matchup", "pressure_vs_defense": "Pace against opponent's defense",
    "ctrl_vs_tddef": "Can control this opponent on the mat", "ground_threat": "Ground striking matchup",
    "pin_vs_getup": "Top control matchup", "power_vs_chin": "Power against opponent's chin",
    "ko_loss_rate": "Knocked out less often", "sub_loss_rate": "Submitted less often",
    "kd_abs15": "Knocked down less often", "head_abs": "Takes fewer head strikes",
    "finish_win_rate": "Finishes fights more often", "age_x_koloss": "Durability (age and past knockouts)",
    "layoff": "Ring rust (time off)", "long_layoff": "Long layoff (over 15 months)", "age_sq": "Closer to peak age",
    "class_change": "Weight-class move", "low_exp": "Experience (fewer than 3 UFC fights)",
    "five_round_cardio": "Cardio in a 5-round fight", "five_round_age": "Age in a 5-round fight",
    "short_notice": "Short-notice replacement", "weight_miss": "Missed weight", "market": "Betting odds",
    "adj_striking": "Out-lands the usual for these opponents", "adj_absorbed": "Gets hit less than these opponents usually manage",
    "adj_wrestling": "Out-wrestles the usual for these opponents", "body_pm": "More body work", "leg_pm": "More leg kicks", "body_diff": "Wins the body exchanges",
    "leg_diff": "Wins the leg-kick exchanges", "legs_vs_leg_defense": "Leg kicks against a fighter who absorbs them",
}

GROUPS = {"A_baseline": "Career stats", "B_form": "Recent form", "C_style": "Style matchup",
          "C_style_v2": "Style matchup", "A_strikeloc": "Career stats", "A_oppadj": "Career stats", "C_strikeloc": "Style matchup", "D_durability": "Durability", "E_context": "Situation",
          "F_market": "Betting odds"}

BASELINES = {"Coin flip (50/50)": "Coin flip", "Elo only": "Higher power rating always wins",
             "Historical base rate (more-experienced fighter)": "More experienced fighter always wins"}

TERMS = {
    "replay": "A past event the engine predicted using only information available before that night, then "
              "checked against the real results. Used to test the engine fairly.",
    "confidence": "How much to trust this pick, based on how much data exists on both fighters and whether the "
                  "engine's parts agree. It is not the chance of winning.",
    "locked": "Saved before the event and never changed afterwards. Only locked picks are graded.",
    "estimate": "Produced by the prediction engine, not an official figure.",
    "honest": "When the engine says 70%, that fighter should win about 7 times out of 10. This shows how far off "
              "it has been on average.",
}


def _fmt(key: str, v) -> str:
    if v is None:
        return "unknown"
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
    """A stat name with its hover description."""
    lab, desc, _ = STATS.get(key, (key, "", "{}"))
    return tip(label or lab, desc)


def stat_value(key: str, v) -> str:
    return _fmt(key, v)


def adv_key(label: str) -> str | None:
    return _ADV_LABELS.get(label)


def term(key: str, label: str) -> Markup:
    return tip(label, TERMS.get(key))


def strength(logit: float) -> tuple[str, int]:
    a = abs(logit or 0)
    if a >= 0.25:
        return "big edge", 3
    if a >= 0.10:
        return "clear edge", 2
    return "slight edge", 1


def factor(x: dict, stats: dict, red_name: str, blue_name: str) -> dict:
    """A stored factor line, rewritten for people: headline, both fighters' numbers, edge size."""
    name = x.get("feature")
    f = BY_NAME.get(name)
    keys = list(f.show) if f else []
    vals = []
    for k in keys[:2]:
        label, desc, _ = STATS.get(k, (k, "", "{}"))
        r, b = (stats.get("red") or {}).get(k), (stats.get("blue") or {}).get(k)
        vals.append({"key": k, "label": label, "desc": desc, "red": _fmt(k, r), "blue": _fmt(k, b)})
    word, level = strength(x.get("logit", 0))
    return {"title": FACTORS.get(name, (f.label if f else name).capitalize()), "group": GROUPS.get(x.get("group"), ""),
            "stats": vals, "strength": word, "level": level, "imputed": x.get("imputed"),
            "red_name": red_name, "blue_name": blue_name}



_REASONS = [
    (r"^a UFC debutant.*", "One fighter is making their UFC debut, so their stats are estimates."),
    (r"^limited UFC sample \(minimum (\d+) prior fights\)", r"One fighter has only \1 UFC fight(s) to learn from."),
    (r"^wide model uncertainty.*", "The numbers point in different directions, so the range of outcomes is wide."),
    (r"^sub-models disagree.*", "Different parts of the engine disagree about this fight."),
    (r"^(\d+) inputs unknown and imputed", r"\1 pieces of information are missing and had to be estimated."),
    (r"^historical predictions in the .* band were miscalibrated \((\d+%) correct vs (\d+%) stated, n=(\d+)\)",
     r"Past picks at these odds were right \1 of the time when the engine expected \2 (\3 fights)."),
    (r"^(.+) has no UFC fights in the database; their statistics are population priors\.",
     r"\1 is making their UFC debut, so their stats are estimated from typical newcomers."),
    (r"^(.+) has only (\d+) UFC fight\(s\) on record\.", r"\1 has only \2 UFC fight(s) to learn from."),
    (r"^(.+): unknown (.+)\.$", r"\1: \2 not known."),
    (r"^(.+): per-round statistics exist for only (\d+%) of past fights\.",
     r"\1: detailed stats exist for only \2 of their past fights."),
    (r"^(.+): short-notice status not documented.*", r"\1: we don't know if they took this fight on short notice."),
    (r"^(.+): (\d+) days since last fight\.", r"\1: \2 days since their last fight (possible ring rust)."),
    (r"^Imputed \(unknown\) inputs: .*", None),
    (r"^Records cover UFC bouts only.*", "Only UFC fights are counted; fights in other promotions aren't included."),
]


def plainify(text: str) -> str | None:
    """Rewrite a stored technical sentence in plain English (None = hide it)."""
    import re
    for pat, rep in _REASONS:
        if re.match(pat, text or ""):
            return None if rep is None else re.sub(pat, rep, text)
    return text


def install(env) -> None:
    env.globals.update(stat=stat, stat_value=stat_value, term=term, tip=tip, factor=factor, adv_key=adv_key,
                       GROUP_NAMES=GROUPS, BASELINE_NAMES=BASELINES, FACTOR_NAMES=FACTORS,
                       plainify=plainify)

