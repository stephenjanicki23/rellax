"""
Value bet detection via no-vig consensus model.

Strategy:
  1. For each game, collect all bookmaker lines.
  2. Find the best (highest) available decimal odds for each outcome.
  3. Build a "sharp consensus" no-vig probability by averaging the vig-stripped
     probabilities across all books (or the sharp subset when available).
  4. A value bet exists when:
       model_prob > 1 / best_available_odds
     i.e. the best book is paying more than the true probability justifies.
  5. Rank by Expected Value.
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional
import config
from config import SHARP_BOOKS

_WORLD_CUP_KEY = "soccer_fifa_world_cup"
_TENNIS_KEYS = {"tennis_atp", "tennis_wta"}


# ---------------------------------------------------------------------------
# Core math
# ---------------------------------------------------------------------------

def decimal_to_implied(decimal_odds: float) -> float:
    return 1.0 / decimal_odds


def strip_vig_two_way(odds_a: float, odds_b: float) -> tuple[float, float]:
    """Return fair (no-vig) probabilities for a two-outcome market."""
    p_a = decimal_to_implied(odds_a)
    p_b = decimal_to_implied(odds_b)
    total = p_a + p_b
    return p_a / total, p_b / total


def strip_vig_three_way(
    odds_a: float, odds_b: float, odds_draw: float
) -> tuple[float, float, float]:
    p_a = decimal_to_implied(odds_a)
    p_b = decimal_to_implied(odds_b)
    p_d = decimal_to_implied(odds_draw)
    total = p_a + p_b + p_d
    return p_a / total, p_b / total, p_d / total


def expected_value(model_prob: float, decimal_odds: float) -> float:
    """EV per unit staked (positive → profitable)."""
    return model_prob * (decimal_odds - 1) - (1 - model_prob)


def kelly_fraction(model_prob: float, decimal_odds: float) -> float:
    """Full Kelly stake as fraction of bankroll. Use ≤25% for safety."""
    b = decimal_odds - 1
    return max(0.0, (model_prob * b - (1 - model_prob)) / b)


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class Outcome:
    name: str
    best_odds: float        # highest decimal odds available across books
    best_book: str
    fair_prob: float        # consensus no-vig probability
    edge: float             # fair_prob - implied_prob(best_odds)
    ev: float               # expected value per unit
    kelly: float            # full kelly fraction
    model_prob: Optional[float] = None   # team-model probability (World Cup)
    model_ev: Optional[float] = None     # EV using model probability


@dataclass
class GameEdges:
    sport: str
    home_team: str
    away_team: str
    commence_time: str
    outcomes: list[Outcome] = field(default_factory=list)

    @property
    def best_edge(self) -> float:
        return max((o.edge for o in self.outcomes), default=0.0)


# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------

def _best_odds_per_outcome(bookmakers: list[dict]) -> dict[str, tuple[float, str]]:
    """
    Returns {outcome_name: (best_decimal_odds, bookmaker_key)}.
    Scans all books and keeps the highest odds for each side.
    """
    best: dict[str, tuple[float, str]] = {}
    for book in bookmakers:
        book_key = book["key"]
        for market in book.get("markets", []):
            if market["key"] != "h2h":
                continue
            for outcome in market["outcomes"]:
                name = outcome["name"]
                odds = float(outcome["price"])
                if name not in best or odds > best[name][0]:
                    best[name] = (odds, book_key)
    return best


def _consensus_fair_probs(
    bookmakers: list[dict], outcome_names: list[str]
) -> dict[str, float]:
    """
    Average no-vig probability across all books (prefer sharp books when present).
    Returns {outcome_name: fair_prob}.
    """
    sharp = [b for b in bookmakers if b["key"] in SHARP_BOOKS]
    pool = sharp if sharp else bookmakers

    accumulated: dict[str, list[float]] = {n: [] for n in outcome_names}

    for book in pool:
        for market in book.get("markets", []):
            if market["key"] != "h2h":
                continue
            odds_map = {o["name"]: float(o["price"]) for o in market["outcomes"]}
            # only process if all outcomes present in this book
            if not all(n in odds_map for n in outcome_names):
                continue
            raw_probs = [decimal_to_implied(odds_map[n]) for n in outcome_names]
            total = sum(raw_probs)
            fair = [p / total for p in raw_probs]
            for name, fp in zip(outcome_names, fair):
                accumulated[name].append(fp)

    result: dict[str, float] = {}
    for name in outcome_names:
        vals = accumulated[name]
        result[name] = sum(vals) / len(vals) if vals else 0.5
    return result


def _world_cup_model_probs(home: str, away: str) -> dict[str, float] | None:
    """
    Return {team_name: model_prob} for a World Cup fixture, or None if
    either team isn't in the Elo database.
    Outcome names use Draw for the draw side.
    """
    try:
        from models.world_cup import predict
    except ImportError:
        return None
    result = predict(home, away)
    if result is None:
        return None
    return {
        home: result["p_home"],
        "Draw": result["p_draw"],
        away: result["p_away"],
    }


def _tennis_model_probs(player1: str, player2: str, sport_key: str) -> dict[str, float] | None:
    """
    Return {player_name: model_prob} for a tennis match using surface-adjusted
    Elo ratings. Returns None if either player isn't in the database.
    """
    try:
        from models.tennis import predict, detect_surface
    except ImportError:
        return None
    surface = detect_surface(sport_key)
    result = predict(player1, player2, surface)
    if result is None:
        return None
    return {
        player1: result["p1_win"],
        player2: result["p2_win"],
    }


def find_edges(game: dict, sport_key: str) -> GameEdges | None:
    """
    Analyze a single game dict (as returned by The Odds API) and return
    GameEdges containing any value bets, or None if no data.
    """
    bookmakers = game.get("bookmakers", [])
    if not bookmakers:
        return None

    home = game["home_team"]
    away = game["away_team"]
    commence = game.get("commence_time", "")

    # Collect all outcome names (h2h may be 2-way or 3-way for soccer)
    all_names: set[str] = set()
    for book in bookmakers:
        for market in book.get("markets", []):
            if market["key"] == "h2h":
                for o in market["outcomes"]:
                    all_names.add(o["name"])

    outcome_names = sorted(all_names)
    if len(outcome_names) < 2:
        return None

    best_odds_map = _best_odds_per_outcome(bookmakers)
    fair_probs = _consensus_fair_probs(bookmakers, outcome_names)

    # Load sport-specific model probabilities when available
    model_probs: dict[str, float] | None = None
    if sport_key == _WORLD_CUP_KEY:
        model_probs = _world_cup_model_probs(home, away)
    elif sport_key in _TENNIS_KEYS:
        model_probs = _tennis_model_probs(home, away, sport_key)

    edges = GameEdges(
        sport=sport_key,
        home_team=home,
        away_team=away,
        commence_time=commence,
    )

    for name in outcome_names:
        if name not in best_odds_map or name not in fair_probs:
            continue
        odds, book = best_odds_map[name]
        fp = fair_probs[name]
        implied = decimal_to_implied(odds)
        edge = fp - implied
        ev = expected_value(fp, odds)
        kelly = kelly_fraction(fp, odds)

        # Model-based EV (World Cup only)
        mp: float | None = None
        mev: float | None = None
        if model_probs is not None:
            mp = model_probs.get(name)
            if mp is not None:
                mev = expected_value(mp, odds)

        # Qualify: either market EV or model EV clears the threshold
        if ev >= config.MIN_EV or (mev is not None and mev >= config.MIN_EV):
            edges.outcomes.append(
                Outcome(
                    name=name,
                    best_odds=odds,
                    best_book=book,
                    fair_prob=fp,
                    edge=edge,
                    ev=ev,
                    kelly=kelly,
                    model_prob=mp,
                    model_ev=mev,
                )
            )

    return edges if edges.outcomes else None


def scan_games(games: list[dict], sport_key: str) -> list[GameEdges]:
    """Process a list of game dicts and return sorted value bets."""
    results = []
    for game in games:
        ge = find_edges(game, sport_key)
        if ge:
            results.append(ge)
    results.sort(key=lambda g: g.best_edge, reverse=True)
    return results
