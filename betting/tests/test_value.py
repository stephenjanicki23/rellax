"""Unit tests for the value-bet analysis logic (no API calls)."""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from analysis.value import (
    decimal_to_implied,
    strip_vig_two_way,
    expected_value,
    kelly_fraction,
    find_edges,
)


def test_implied_probability():
    assert abs(decimal_to_implied(2.0) - 0.5) < 1e-9
    assert abs(decimal_to_implied(4.0) - 0.25) < 1e-9


def test_strip_vig_two_way_sums_to_one():
    pa, pb = strip_vig_two_way(1.91, 1.91)
    assert abs(pa - 0.5) < 1e-9
    assert abs(pa + pb - 1.0) < 1e-9


def test_strip_vig_favorite():
    # Heavy favorite: -200 American = 1.5 decimal; underdog: +160 = 2.6
    pa, pb = strip_vig_two_way(1.5, 2.6)
    assert pa > pb  # favourite should have higher fair prob
    assert abs(pa + pb - 1.0) < 1e-9


def test_ev_positive_when_odds_generous():
    # Fair prob 55%, book offering 2.10 (implied 47.6%) → positive EV
    ev = expected_value(0.55, 2.10)
    assert ev > 0


def test_ev_negative_when_odds_tight():
    ev = expected_value(0.45, 1.80)
    assert ev < 0


def test_kelly_zero_when_no_edge():
    k = kelly_fraction(0.40, 2.10)   # implied prob 47.6% > model 40%
    assert k == 0.0


def test_kelly_positive_with_edge():
    k = kelly_fraction(0.60, 2.10)
    assert k > 0


def _make_game(home_odds: float, away_odds: float, books: int = 3) -> dict:
    """Build a minimal game dict mimicking The Odds API response."""
    bookmakers = []
    for i in range(books):
        bookmakers.append({
            "key": f"book{i}",
            "markets": [{
                "key": "h2h",
                "outcomes": [
                    {"name": "Home Team", "price": home_odds},
                    {"name": "Away Team", "price": away_odds},
                ],
            }],
        })
    return {
        "id": "test123",
        "sport_key": "americanfootball_nfl",
        "home_team": "Home Team",
        "away_team": "Away Team",
        "commence_time": "2025-09-07T17:00:00Z",
        "bookmakers": bookmakers,
    }


def test_find_edges_detects_value():
    # One book offers 2.20 on Away when fair is ~50% (implied 45.5%) → edge
    game = {
        "id": "test",
        "sport_key": "americanfootball_nfl",
        "home_team": "Home Team",
        "away_team": "Away Team",
        "commence_time": "2025-09-07T17:00:00Z",
        "bookmakers": [
            {
                "key": "book0",
                "markets": [{"key": "h2h", "outcomes": [
                    {"name": "Home Team", "price": 1.90},
                    {"name": "Away Team", "price": 1.90},
                ]}],
            },
            {
                "key": "book1",
                "markets": [{"key": "h2h", "outcomes": [
                    {"name": "Home Team", "price": 1.85},
                    {"name": "Away Team", "price": 2.20},  # generous on Away
                ]}],
            },
        ],
    }
    result = find_edges(game, "americanfootball_nfl")
    assert result is not None
    away_bets = [o for o in result.outcomes if o.name == "Away Team"]
    assert len(away_bets) == 1
    assert away_bets[0].best_odds == 2.20
    assert away_bets[0].ev > 0


def test_find_edges_no_value_returns_none():
    # Standard -110/-110 lines, all books identical — no edge
    game = _make_game(home_odds=1.909, away_odds=1.909, books=5)
    result = find_edges(game, "americanfootball_nfl")
    assert result is None


if __name__ == "__main__":
    tests = [
        test_implied_probability,
        test_strip_vig_two_way_sums_to_one,
        test_strip_vig_favorite,
        test_ev_positive_when_odds_generous,
        test_ev_negative_when_odds_tight,
        test_kelly_zero_when_no_edge,
        test_kelly_positive_with_edge,
        test_find_edges_detects_value,
        test_find_edges_no_value_returns_none,
    ]
    passed = 0
    for t in tests:
        try:
            t()
            print(f"  PASS  {t.__name__}")
            passed += 1
        except Exception as e:
            print(f"  FAIL  {t.__name__}: {e}")
    print(f"\n{passed}/{len(tests)} tests passed.")
