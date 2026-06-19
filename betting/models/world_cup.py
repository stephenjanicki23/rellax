"""
World Cup match outcome model using Elo ratings + Poisson distribution.

Methodology:
  1. Each national team has an Elo rating reflecting historical performance.
  2. Elo difference → expected score (win probability in a 2-outcome game).
  3. Expected score → expected goals for each team via a calibrated formula.
  4. Poisson distribution over scorelines → P(home win), P(draw), P(away win).
"""

from __future__ import annotations
import math

# ---------------------------------------------------------------------------
# National team Elo ratings (source: eloratings.net, updated June 2025)
# Higher = stronger. Argentina won 2022 WC (~2040).
# ---------------------------------------------------------------------------
ELO_RATINGS: dict[str, float] = {
    # Elite
    "Argentina": 2050,
    "France": 2010,
    "England": 1990,
    "Brazil": 1980,
    "Spain": 1975,
    "Portugal": 1960,
    "Belgium": 1945,
    "Netherlands": 1940,
    "Germany": 1930,
    "Italy": 1920,
    # Strong contenders
    "Croatia": 1905,
    "Uruguay": 1895,
    "Colombia": 1885,
    "Morocco": 1875,
    "Switzerland": 1865,
    "Denmark": 1860,
    "Senegal": 1850,
    "Mexico": 1845,
    "USA": 1840,
    "United States": 1840,
    "Ecuador": 1835,
    "Austria": 1830,
    "Turkey": 1825,
    "Japan": 1820,
    "South Korea": 1815,
    "Korea Republic": 1815,
    "Australia": 1805,
    # Qualifiers / dark horses
    "Iran": 1800,
    "Poland": 1798,
    "Sweden": 1795,
    "Norway": 1790,
    "Ukraine": 1785,
    "Serbia": 1780,
    "Hungary": 1778,
    "Scotland": 1775,
    "Wales": 1770,
    "Canada": 1768,
    "Chile": 1765,
    "Peru": 1762,
    "Venezuela": 1758,
    "Paraguay": 1755,
    "Bolivia": 1740,
    "Algeria": 1738,
    "Egypt": 1735,
    "Cameroon": 1730,
    "Ghana": 1728,
    "Nigeria": 1725,
    "Ivory Coast": 1720,
    "Cote d'Ivoire": 1720,
    "Tunisia": 1715,
    "Costa Rica": 1710,
    "Honduras": 1700,
    "Panama": 1698,
    "Jamaica": 1690,
    "Saudi Arabia": 1685,
    "Qatar": 1660,
    "New Zealand": 1640,
}

# Approximate average goals per team per international match
_BASE_GOALS = 1.22

# Scale factor: how much Elo difference translates to goal difference
# Calibrated so 200 Elo pts ≈ 0.5 extra expected goals per game
_ELO_SCALE = 400.0
_GOAL_EXPONENT = 0.45


def _elo_expected(elo_a: float, elo_b: float) -> float:
    """Standard Elo expected score (P win + 0.5 * P draw) for team A."""
    return 1.0 / (1.0 + 10.0 ** ((elo_b - elo_a) / _ELO_SCALE))


def _expected_goals(elo_a: float, elo_b: float) -> tuple[float, float]:
    """Estimate λ (expected goals) for each team."""
    ea = _elo_expected(elo_a, elo_b)
    # Scale symmetrically: stronger team scores more, weaker scores less
    lam_a = _BASE_GOALS * (ea / 0.5) ** _GOAL_EXPONENT
    lam_b = _BASE_GOALS * ((1.0 - ea) / 0.5) ** _GOAL_EXPONENT
    return lam_a, lam_b


def _poisson_pmf(k: int, lam: float) -> float:
    return math.exp(-lam) * (lam ** k) / math.factorial(k)


def _three_way(lam_a: float, lam_b: float, max_goals: int = 8) -> tuple[float, float, float]:
    """
    Compute P(A wins), P(draw), P(B wins) via Poisson scoreline simulation.
    """
    p_win = p_draw = p_loss = 0.0
    for i in range(max_goals + 1):
        pa = _poisson_pmf(i, lam_a)
        for j in range(max_goals + 1):
            pb = _poisson_pmf(j, lam_b)
            p = pa * pb
            if i > j:
                p_win += p
            elif i == j:
                p_draw += p
            else:
                p_loss += p
    # Normalise the truncated sum
    total = p_win + p_draw + p_loss
    return p_win / total, p_draw / total, p_loss / total


def lookup(name: str) -> float | None:
    """Return Elo rating for a team name, trying common aliases."""
    if name in ELO_RATINGS:
        return ELO_RATINGS[name]
    # Try case-insensitive
    lower = {k.lower(): v for k, v in ELO_RATINGS.items()}
    return lower.get(name.lower())


def predict(home_team: str, away_team: str) -> dict | None:
    """
    Return model win/draw/loss probabilities for a match.
    Returns None if either team is not in the Elo database.

    Result keys:
      home_team, away_team, elo_home, elo_away,
      xg_home, xg_away,
      p_home (home win prob), p_draw, p_away (away win prob)
    """
    elo_h = lookup(home_team)
    elo_a = lookup(away_team)
    if elo_h is None or elo_a is None:
        return None

    lam_h, lam_a = _expected_goals(elo_h, elo_a)
    p_h, p_d, p_a = _three_way(lam_h, lam_a)

    return {
        "home_team": home_team,
        "away_team": away_team,
        "elo_home": int(elo_h),
        "elo_away": int(elo_a),
        "xg_home": round(lam_h, 2),
        "xg_away": round(lam_a, 2),
        "p_home": round(p_h, 4),
        "p_draw": round(p_d, 4),
        "p_away": round(p_a, 4),
    }
