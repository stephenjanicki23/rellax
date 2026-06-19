"""
Tennis match outcome model.

Methodology:
  1. Each player has surface-specific Elo ratings (hard / clay / grass).
  2. Supporting attributes (serve, return, fitness, mental) are used to
     explain *why* a player performs the way they do on each surface and
     to add a small calibrated adjustment to the base Elo prediction.
  3. Elo difference → win probability via the standard formula.
  4. Surface modifier adjusts for skill sets that benefit certain surfaces
     (big servers get a small boost on grass, baseliners on clay, etc.).

Surface keys: "hard" | "clay" | "grass"
"""

from __future__ import annotations
import math

# ---------------------------------------------------------------------------
# Player profiles
# Each entry: {surface_elo, serve, return_, fitness, mental, preferred}
#   serve    0-100: first-serve effectiveness (aces, free points)
#   return_  0-100: break-point conversion / return game quality
#   fitness  0-100: movement, endurance, 5-set stamina
#   mental   0-100: clutch under pressure, tiebreak record
# ---------------------------------------------------------------------------

PLAYERS: dict[str, dict] = {
    # ── ATP ────────────────────────────────────────────────────────────────
    "Jannik Sinner": {
        "hard": 2150, "clay": 2060, "grass": 2020,
        "serve": 77, "return_": 84, "fitness": 91, "mental": 87,
        "preferred": "hard",
    },
    "Carlos Alcaraz": {
        "hard": 2100, "clay": 2130, "grass": 2090,
        "serve": 80, "return_": 85, "fitness": 93, "mental": 90,
        "preferred": "clay",
    },
    "Alexander Zverev": {
        "hard": 2060, "clay": 2040, "grass": 1950,
        "serve": 82, "return_": 72, "fitness": 80, "mental": 72,
        "preferred": "hard",
    },
    "Daniil Medvedev": {
        "hard": 2040, "clay": 1890, "grass": 1940,
        "serve": 78, "return_": 80, "fitness": 82, "mental": 83,
        "preferred": "hard",
    },
    "Novak Djokovic": {
        "hard": 2010, "clay": 2030, "grass": 2020,
        "serve": 76, "return_": 92, "fitness": 94, "mental": 96,
        "preferred": "clay",
    },
    "Casper Ruud": {
        "hard": 1930, "clay": 2010, "grass": 1820,
        "serve": 68, "return_": 73, "fitness": 83, "mental": 76,
        "preferred": "clay",
    },
    "Holger Rune": {
        "hard": 1960, "clay": 1990, "grass": 1910,
        "serve": 74, "return_": 76, "fitness": 80, "mental": 75,
        "preferred": "clay",
    },
    "Andrey Rublev": {
        "hard": 1970, "clay": 1950, "grass": 1880,
        "serve": 73, "return_": 71, "fitness": 79, "mental": 68,
        "preferred": "hard",
    },
    "Stefanos Tsitsipas": {
        "hard": 1950, "clay": 2000, "grass": 1870,
        "serve": 77, "return_": 70, "fitness": 78, "mental": 72,
        "preferred": "clay",
    },
    "Taylor Fritz": {
        "hard": 1950, "clay": 1840, "grass": 1900,
        "serve": 83, "return_": 67, "fitness": 77, "mental": 74,
        "preferred": "hard",
    },
    "Ben Shelton": {
        "hard": 1930, "clay": 1820, "grass": 1880,
        "serve": 88, "return_": 65, "fitness": 82, "mental": 72,
        "preferred": "hard",
    },
    "Tommy Paul": {
        "hard": 1920, "clay": 1870, "grass": 1870,
        "serve": 74, "return_": 71, "fitness": 80, "mental": 73,
        "preferred": "hard",
    },
    "Grigor Dimitrov": {
        "hard": 1910, "clay": 1870, "grass": 1900,
        "serve": 76, "return_": 69, "fitness": 75, "mental": 71,
        "preferred": "hard",
    },
    "Hubert Hurkacz": {
        "hard": 1940, "clay": 1860, "grass": 1970,
        "serve": 86, "return_": 68, "fitness": 79, "mental": 73,
        "preferred": "grass",
    },
    "Lorenzo Musetti": {
        "hard": 1890, "clay": 1950, "grass": 1920,
        "serve": 72, "return_": 71, "fitness": 77, "mental": 74,
        "preferred": "clay",
    },
    "Felix Auger-Aliassime": {
        "hard": 1900, "clay": 1850, "grass": 1900,
        "serve": 84, "return_": 67, "fitness": 80, "mental": 70,
        "preferred": "hard",
    },
    "Ugo Humbert": {
        "hard": 1880, "clay": 1820, "grass": 1920,
        "serve": 86, "return_": 66, "fitness": 76, "mental": 71,
        "preferred": "grass",
    },
    "Arthur Fils": {
        "hard": 1890, "clay": 1870, "grass": 1840,
        "serve": 75, "return_": 70, "fitness": 81, "mental": 70,
        "preferred": "hard",
    },
    "Matteo Berrettini": {
        "hard": 1900, "clay": 1870, "grass": 1940,
        "serve": 90, "return_": 65, "fitness": 74, "mental": 75,
        "preferred": "grass",
    },
    "Sebastian Korda": {
        "hard": 1880, "clay": 1840, "grass": 1860,
        "serve": 78, "return_": 68, "fitness": 78, "mental": 69,
        "preferred": "hard",
    },
    "Francisco Cerundolo": {
        "hard": 1860, "clay": 1910, "grass": 1800,
        "serve": 70, "return_": 69, "fitness": 79, "mental": 70,
        "preferred": "clay",
    },
    "Nicolas Jarry": {
        "hard": 1860, "clay": 1900, "grass": 1820,
        "serve": 83, "return_": 64, "fitness": 74, "mental": 68,
        "preferred": "clay",
    },
    "Karen Khachanov": {
        "hard": 1880, "clay": 1840, "grass": 1850,
        "serve": 79, "return_": 67, "fitness": 76, "mental": 70,
        "preferred": "hard",
    },
    "Jack Draper": {
        "hard": 1890, "clay": 1870, "grass": 1900,
        "serve": 82, "return_": 70, "fitness": 79, "mental": 72,
        "preferred": "hard",
    },
    "Francisco Comesana": {
        "hard": 1820, "clay": 1860, "grass": 1780,
        "serve": 68, "return_": 65, "fitness": 76, "mental": 66,
        "preferred": "clay",
    },
    "Alejandro Davidovich Fokina": {
        "hard": 1840, "clay": 1890, "grass": 1800,
        "serve": 69, "return_": 67, "fitness": 80, "mental": 68,
        "preferred": "clay",
    },
    "Alexei Popyrin": {
        "hard": 1860, "clay": 1810, "grass": 1850,
        "serve": 80, "return_": 63, "fitness": 75, "mental": 68,
        "preferred": "hard",
    },
    "Nuno Borges": {
        "hard": 1850, "clay": 1870, "grass": 1820,
        "serve": 74, "return_": 65, "fitness": 76, "mental": 67,
        "preferred": "clay",
    },
    "Jordan Thompson": {
        "hard": 1840, "clay": 1790, "grass": 1850,
        "serve": 76, "return_": 63, "fitness": 75, "mental": 66,
        "preferred": "hard",
    },
    # ── WTA ────────────────────────────────────────────────────────────────
    "Aryna Sabalenka": {
        "hard": 2080, "clay": 1970, "grass": 2000,
        "serve": 86, "return_": 80, "fitness": 84, "mental": 82,
        "preferred": "hard",
    },
    "Iga Swiatek": {
        "hard": 2030, "clay": 2120, "grass": 1880,
        "serve": 72, "return_": 88, "fitness": 89, "mental": 88,
        "preferred": "clay",
    },
    "Coco Gauff": {
        "hard": 2000, "clay": 1960, "grass": 1920,
        "serve": 74, "return_": 79, "fitness": 83, "mental": 80,
        "preferred": "hard",
    },
    "Elena Rybakina": {
        "hard": 1990, "clay": 1900, "grass": 2020,
        "serve": 90, "return_": 73, "fitness": 79, "mental": 78,
        "preferred": "grass",
    },
    "Jessica Pegula": {
        "hard": 1970, "clay": 1900, "grass": 1880,
        "serve": 72, "return_": 76, "fitness": 79, "mental": 76,
        "preferred": "hard",
    },
    "Qinwen Zheng": {
        "hard": 1960, "clay": 1900, "grass": 1870,
        "serve": 77, "return_": 73, "fitness": 81, "mental": 75,
        "preferred": "hard",
    },
    "Madison Keys": {
        "hard": 1960, "clay": 1870, "grass": 1880,
        "serve": 83, "return_": 70, "fitness": 77, "mental": 79,
        "preferred": "hard",
    },
    "Emma Navarro": {
        "hard": 1930, "clay": 1890, "grass": 1920,
        "serve": 71, "return_": 74, "fitness": 80, "mental": 76,
        "preferred": "hard",
    },
    "Mirra Andreeva": {
        "hard": 1920, "clay": 1940, "grass": 1880,
        "serve": 70, "return_": 76, "fitness": 81, "mental": 74,
        "preferred": "clay",
    },
    "Daria Kasatkina": {
        "hard": 1900, "clay": 1940, "grass": 1860,
        "serve": 68, "return_": 73, "fitness": 77, "mental": 74,
        "preferred": "clay",
    },
    "Barbora Krejcikova": {
        "hard": 1880, "clay": 1920, "grass": 1940,
        "serve": 72, "return_": 71, "fitness": 76, "mental": 78,
        "preferred": "grass",
    },
    "Paula Badosa": {
        "hard": 1900, "clay": 1930, "grass": 1860,
        "serve": 76, "return_": 71, "fitness": 76, "mental": 72,
        "preferred": "clay",
    },
    "Jelena Ostapenko": {
        "hard": 1880, "clay": 1890, "grass": 1920,
        "serve": 74, "return_": 70, "fitness": 74, "mental": 70,
        "preferred": "grass",
    },
    "Liudmila Samsonova": {
        "hard": 1890, "clay": 1840, "grass": 1870,
        "serve": 78, "return_": 68, "fitness": 76, "mental": 69,
        "preferred": "hard",
    },
    "Beatriz Haddad Maia": {
        "hard": 1870, "clay": 1900, "grass": 1880,
        "serve": 73, "return_": 70, "fitness": 78, "mental": 71,
        "preferred": "clay",
    },
    "Anna Kalinskaya": {
        "hard": 1880, "clay": 1840, "grass": 1870,
        "serve": 74, "return_": 69, "fitness": 76, "mental": 70,
        "preferred": "hard",
    },
    "Jasmine Paolini": {
        "hard": 1890, "clay": 1920, "grass": 1910,
        "serve": 67, "return_": 75, "fitness": 82, "mental": 77,
        "preferred": "clay",
    },
    "Diana Shnaider": {
        "hard": 1880, "clay": 1870, "grass": 1850,
        "serve": 80, "return_": 67, "fitness": 78, "mental": 70,
        "preferred": "hard",
    },
    "Caroline Garcia": {
        "hard": 1870, "clay": 1850, "grass": 1880,
        "serve": 79, "return_": 67, "fitness": 74, "mental": 70,
        "preferred": "hard",
    },
}

# ---------------------------------------------------------------------------
# Surface keyword → court surface mapping (keyed against Odds API sport keys)
# ---------------------------------------------------------------------------
_SURFACE_MAP: dict[str, str] = {
    "french_open": "clay", "roland_garros": "clay",
    "clay": "clay",
    "wimbledon": "grass", "queens": "grass", "halle": "grass",
    "stuttgart": "grass", "eastbourne": "grass", "grass": "grass",
    "aus_open": "hard", "australian_open": "hard",
    "us_open": "hard", "indian_wells": "hard",
    "miami": "hard", "montreal": "hard", "toronto": "hard",
    "cincinnati": "hard", "paris": "hard",
}

# Surface weights for small skill-based adjustments (after Elo calculation)
# Values are multipliers: how much serve/return/fitness matters on each surface
_SURFACE_WEIGHTS: dict[str, dict[str, float]] = {
    "grass": {"serve": 0.08, "return_": -0.02, "fitness": 0.02},
    "clay":  {"serve": -0.03, "return_": 0.04, "fitness": 0.06},
    "hard":  {"serve": 0.03, "return_": 0.03, "fitness": 0.03},
}

_ELO_SCALE = 400.0


def detect_surface(sport_key: str) -> str:
    """Infer court surface from Odds API sport key. Defaults to 'hard'."""
    sk = sport_key.lower()
    for keyword, surface in _SURFACE_MAP.items():
        if keyword in sk:
            return surface
    return "hard"


def lookup(name: str) -> dict | None:
    """Return player profile, trying case-insensitive match."""
    if name in PLAYERS:
        return PLAYERS[name]
    lower = {k.lower(): v for k, v in PLAYERS.items()}
    return lower.get(name.lower())


def _elo_win_prob(elo_a: float, elo_b: float) -> float:
    return 1.0 / (1.0 + 10.0 ** ((elo_b - elo_a) / _ELO_SCALE))


def _skill_adjustment(p1: dict, p2: dict, surface: str) -> float:
    """
    Small win-probability adjustment based on serve/return/fitness deltas.
    Kept deliberately small so surface Elo is the primary driver.
    """
    weights = _SURFACE_WEIGHTS.get(surface, _SURFACE_WEIGHTS["hard"])
    adj = 0.0
    for attr, w in weights.items():
        adj += w * (p1[attr] - p2[attr]) / 100.0
    return max(-0.08, min(0.08, adj))  # cap at ±8%


def predict(player1: str, player2: str, surface: str = "hard") -> dict | None:
    """
    Predict P(player1 wins) for a tennis match on a given surface.

    Returns None if either player is not in the database.

    Result keys:
      player1, player2, surface,
      elo1, elo2,
      serve1, serve2, return1, return2, fitness1, fitness2, mental1, mental2,
      p1_win, p2_win,          # final model probabilities
      preferred1, preferred2,  # best surface for each player
      surface_advantage        # name of player who benefits most from surface
    """
    surface = surface.lower()
    if surface not in ("hard", "clay", "grass"):
        surface = "hard"

    p1 = lookup(player1)
    p2 = lookup(player2)
    if p1 is None or p2 is None:
        return None

    elo1 = p1[surface]
    elo2 = p2[surface]

    base_prob = _elo_win_prob(elo1, elo2)
    skill_adj = _skill_adjustment(p1, p2, surface)
    p1_win = max(0.01, min(0.99, base_prob + skill_adj))
    p2_win = 1.0 - p1_win

    # Which player benefits more from this surface?
    # Compare surface Elo vs overall Elo (average of all 3 surfaces)
    avg1 = (p1["hard"] + p1["clay"] + p1["grass"]) / 3
    avg2 = (p2["hard"] + p2["clay"] + p2["grass"]) / 3
    boost1 = p1[surface] - avg1
    boost2 = p2[surface] - avg2
    if boost1 > boost2 + 5:
        surface_advantage = player1
    elif boost2 > boost1 + 5:
        surface_advantage = player2
    else:
        surface_advantage = "Neutral"

    return {
        "player1": player1,
        "player2": player2,
        "surface": surface,
        "elo1": int(elo1),
        "elo2": int(elo2),
        "serve1": p1["serve"],
        "serve2": p2["serve"],
        "return1": p1["return_"],
        "return2": p2["return_"],
        "fitness1": p1["fitness"],
        "fitness2": p2["fitness"],
        "mental1": p1["mental"],
        "mental2": p2["mental"],
        "preferred1": p1["preferred"],
        "preferred2": p2["preferred"],
        "p1_win": round(p1_win, 4),
        "p2_win": round(p2_win, 4),
        "surface_advantage": surface_advantage,
    }
