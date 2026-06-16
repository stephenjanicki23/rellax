#!/usr/bin/env python3
"""
Rellax Sports Betting Edge Finder
----------------------------------
Scans live moneyline odds across NFL, NCAAF, MLB, and MLS and surfaces
value bets — situations where the market's best available price implies a
lower win probability than the sharp consensus says is fair.

Usage:
    python main.py [--sport nfl|ncaaf|mlb|mls] [--min-ev 0.02] [--all]

Requirements:
    pip install -r requirements.txt
    export ODDS_API_KEY=your_key_here   # free at https://the-odds-api.com
"""

import argparse
import sys
from datetime import datetime, timezone

from tabulate import tabulate

import config
from odds.client import OddsClient, OddsAPIError
from analysis.value import scan_games, GameEdges


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------

def _pct(v: float) -> str:
    return f"{v * 100:.1f}%"


def _odds_str(decimal: float) -> str:
    """Show both decimal and American odds."""
    if decimal >= 2.0:
        american = f"+{int((decimal - 1) * 100)}"
    else:
        american = f"-{int(100 / (decimal - 1))}"
    return f"{decimal:.2f} ({american})"


def _format_time(iso: str) -> str:
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        local = dt.astimezone()
        return local.strftime("%a %b %d %I:%M %p")
    except Exception:
        return iso


def print_edges(edges: list[GameEdges], sport_label: str) -> int:
    """Print a formatted table of value bets. Returns count printed."""
    rows = []
    for ge in edges:
        game_str = f"{ge.away_team} @ {ge.home_team}"
        time_str = _format_time(ge.commence_time)
        for o in sorted(ge.outcomes, key=lambda x: x.ev, reverse=True):
            ev_sign = "+" if o.ev >= 0 else ""
            rows.append([
                sport_label,
                time_str,
                game_str,
                o.name,
                _odds_str(o.best_odds),
                o.best_book,
                _pct(o.fair_prob),
                _pct(1 / o.best_odds),   # implied prob at best odds
                f"{ev_sign}{_pct(o.ev)}",
                f"{_pct(o.kelly * 0.25)} bk",  # quarter-Kelly recommended
            ])

    if not rows:
        return 0

    headers = [
        "Sport", "Time", "Game", "Bet On",
        "Best Odds", "Best Book",
        "Fair Prob", "Implied", "EV", "Rec Stake",
    ]
    print(tabulate(rows, headers=headers, tablefmt="rounded_outline"))
    return len(rows)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def run(sports: dict[str, str], min_ev: float) -> None:
    config.MIN_EV = min_ev

    client = OddsClient()
    all_edges: list[tuple[str, GameEdges]] = []

    for label, sport_key in sports.items():
        print(f"\nFetching {label.upper()} odds...")
        try:
            games = client.get_odds(sport_key)
        except OddsAPIError as e:
            print(f"  Skipped ({e})")
            continue

        if not games:
            print("  No games currently available.")
            continue

        print(f"  {len(games)} game(s) found.")
        sport_edges = scan_games(games, sport_key)
        all_edges.extend((label.upper(), ge) for ge in sport_edges)

    print()
    if not all_edges:
        print("No value bets found matching your criteria.")
        print(f"  Min EV: {min_ev * 100:.1f}%  |  Min Edge: {config.MIN_EDGE * 100:.1f}%")
        return

    # Group by sport for display
    by_sport: dict[str, list[GameEdges]] = {}
    for label, ge in all_edges:
        by_sport.setdefault(label, []).append(ge)

    total = 0
    for label, edges in by_sport.items():
        print(f"\n{'─' * 60}")
        print(f"  {label} VALUE BETS")
        print(f"{'─' * 60}")
        total += print_edges(edges, label)

    print(f"\n{total} value bet(s) found across {len(by_sport)} sport(s).")
    print(
        "\nNote: Rec Stake = 25% Kelly. Never bet more than you can afford to lose."
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Find value bets in live sports odds."
    )
    parser.add_argument(
        "--sport",
        choices=list(config.SPORTS.keys()),
        help="Scan a single sport (default: all)",
    )
    parser.add_argument(
        "--min-ev",
        type=float,
        default=config.MIN_EV,
        metavar="FLOAT",
        help=f"Minimum EV threshold (default: {config.MIN_EV})",
    )
    args = parser.parse_args()

    sports = (
        {args.sport: config.SPORTS[args.sport]} if args.sport else config.SPORTS
    )

    try:
        run(sports, args.min_ev)
    except OddsAPIError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("\nAborted.")


if __name__ == "__main__":
    main()
