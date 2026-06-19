"""
Gradio app for the Sports Betting Edge Finder.
Deploy to Hugging Face Spaces — set ODDS_API_KEY as a Space Secret.
"""

import os
import sys
sys.path.insert(0, os.path.dirname(__file__))

import gradio as gr
import pandas as pd

from odds.client import OddsClient, OddsAPIError
from analysis.value import scan_games
import config

SPORT_OPTIONS = {
    "NFL": "americanfootball_nfl",
    "College Football (NCAAF)": "americanfootball_ncaaf",
    "MLB Baseball": "baseball_mlb",
    "MLS Soccer": "soccer_usa_mls",
}

COLUMNS = [
    "Game", "Bet On", "Best Odds (decimal)", "Best Odds (American)",
    "Best Book", "Fair Prob %", "Implied Prob %", "EV %", "Rec Stake (25% Kelly)",
    "Tip Time",
]


def _american(decimal: float) -> str:
    if decimal >= 2.0:
        return f"+{int((decimal - 1) * 100)}"
    return f"-{int(100 / (decimal - 1))}"


def _fmt_time(iso: str) -> str:
    from datetime import datetime
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return dt.strftime("%a %b %d %H:%M UTC")
    except Exception:
        return iso


def scan(sports: list[str], min_ev_pct: float) -> tuple[pd.DataFrame, str]:
    key = os.getenv("ODDS_API_KEY", "")
    if not key:
        return pd.DataFrame(columns=COLUMNS), "❌ ODDS_API_KEY is not configured. Add it as a Space Secret."

    config.MIN_EV = min_ev_pct / 100.0
    config.MIN_EDGE = max(0.01, min_ev_pct / 200.0)

    sport_keys = {s: SPORT_OPTIONS[s] for s in sports if s in SPORT_OPTIONS}
    if not sport_keys:
        return pd.DataFrame(columns=COLUMNS), "Select at least one sport."

    client = OddsClient(api_key=key)
    rows = []
    status_parts = []

    for label, sport_key in sport_keys.items():
        try:
            games = client.get_odds(sport_key)
        except OddsAPIError as e:
            status_parts.append(f"⚠️ {label}: {e}")
            continue

        if not games:
            status_parts.append(f"ℹ️ {label}: no games available right now.")
            continue

        edges = scan_games(games, sport_key)
        status_parts.append(f"✅ {label}: {len(games)} games scanned, {len(edges)} with edges.")

        for ge in edges:
            game_str = f"{ge.away_team} @ {ge.home_team}"
            for o in sorted(ge.outcomes, key=lambda x: x.ev, reverse=True):
                rows.append({
                    "Game": game_str,
                    "Bet On": o.name,
                    "Best Odds (decimal)": round(o.best_odds, 3),
                    "Best Odds (American)": _american(o.best_odds),
                    "Best Book": o.best_book,
                    "Fair Prob %": round(o.fair_prob * 100, 1),
                    "Implied Prob %": round(100 / o.best_odds, 1),
                    "EV %": round(o.ev * 100, 2),
                    "Rec Stake (25% Kelly)": f"{round(o.kelly * 25, 1)}% of bankroll",
                    "Tip Time": _fmt_time(ge.commence_time),
                })

    df = pd.DataFrame(rows, columns=COLUMNS) if rows else pd.DataFrame(columns=COLUMNS)
    if not df.empty:
        df = df.sort_values("EV %", ascending=False).reset_index(drop=True)

    status = "\n".join(status_parts)
    if rows:
        status += f"\n\n🎯 {len(rows)} value bet(s) found."
    else:
        status += "\n\nNo value bets found at the current threshold."

    return df, status


with gr.Blocks(title="Sports Betting Edge Finder", theme=gr.themes.Soft()) as demo:
    gr.Markdown(
        """
        # 🏈⚾⚽ Sports Betting Edge Finder
        Pulls live moneyline odds from multiple sportsbooks, strips the vig to find the
        **true probability**, then flags bets where a book is offering *better-than-fair* odds.

        > ⚠️ For informational purposes only. Gamble responsibly.
        """
    )

    with gr.Row():
        with gr.Column(scale=1):
            sports_in = gr.CheckboxGroup(
                choices=list(SPORT_OPTIONS.keys()),
                value=["NFL", "MLB Baseball"],
                label="Sports to scan",
            )
            min_ev_in = gr.Slider(
                minimum=0.5, maximum=10.0, value=2.0, step=0.5,
                label="Minimum EV % threshold",
                info="Higher = fewer, higher-confidence edges",
            )
            scan_btn = gr.Button("🔍 Scan for Edges", variant="primary")

        with gr.Column(scale=3):
            results_table = gr.Dataframe(
                headers=COLUMNS,
                label="Value Bets",
                wrap=True,
            )
            status_box = gr.Textbox(label="Status", lines=5, interactive=False)

    scan_btn.click(
        fn=scan,
        inputs=[sports_in, min_ev_in],
        outputs=[results_table, status_box],
    )

if __name__ == "__main__":
    demo.launch()
