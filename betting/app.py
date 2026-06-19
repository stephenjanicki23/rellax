"""
Gradio app for the Sports Betting Edge Finder.
Deploy to Hugging Face Spaces — set ODDS_API_KEY as a Space Secret.
Enable Persistent Storage in Space settings to keep bet history across restarts.
"""

import os
import sys
sys.path.insert(0, os.path.dirname(__file__))

import gradio as gr
import pandas as pd

from odds.client import OddsClient, OddsAPIError
from analysis.value import scan_games
import config
import storage

SPORT_OPTIONS = {
    "NFL": "americanfootball_nfl",
    "MLB Baseball": "baseball_mlb",
    "FIFA World Cup": "soccer_fifa_world_cup",
    "Tennis ATP": "tennis_atp",
    "Tennis WTA": "tennis_wta",
}
ALL_SPORTS = list(SPORT_OPTIONS.keys())

BANKROLL = storage.BANKROLL

SCAN_COLS = [
    "Game", "Bet On", "Best Odds", "American",
    "Book", "Fair %", "Implied %", "EV %",
    "Model %", "Model EV %",
    "Bet Size ($)", "Game Time",
]

HISTORY_COLS = [
    "ID", "Date", "Sport", "Game", "Bet On",
    "Odds", "Bet Size ($)", "Result", "Score", "P&L ($)",
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

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


def _bet_size(kelly: float) -> float:
    """Quarter-Kelly stake on $200 bankroll, rounded to nearest $0.50."""
    raw = kelly * 0.25 * BANKROLL
    return round(raw * 2) / 2  # round to nearest $0.50


def _signal_style(df: pd.DataFrame):
    """
    Color each row by signal strength:
      Green  — both market EV and model EV are positive (double signal)
      Yellow — exactly one is positive (single signal)
      Red    — neither is positive
    """
    if df.empty:
        return df

    def _row_bg(row):
        try:
            ev_pos = float(row["EV %"]) > 0
        except (ValueError, TypeError):
            ev_pos = False

        mev = row.get("Model EV %", "—")
        try:
            mev_pos = float(mev) > 0
        except (ValueError, TypeError):
            mev_pos = False

        if ev_pos and mev_pos:
            bg = "background-color: #c8f7c5; color: black"   # green
        elif ev_pos or mev_pos:
            bg = "background-color: #fef9c3; color: black"   # yellow
        else:
            bg = "background-color: #fde8e8; color: black"   # red

        return [bg] * len(row)

    return df.style.apply(_row_bg, axis=1)


# ---------------------------------------------------------------------------
# Scanner tab
# ---------------------------------------------------------------------------

# Store last scan results so "Save to History" knows what to save
_last_scan: list[dict] = []


def scan(sports: list[str], min_ev_pct: float):
    global _last_scan
    _last_scan = []

    key = os.getenv("ODDS_API_KEY", "").strip()
    if not key:
        return (
            pd.DataFrame(columns=SCAN_COLS),
            "❌ ODDS_API_KEY not loaded. Add it as a Space Secret, then restart the Space.",
            gr.update(interactive=False),
        )

    config.MIN_EV = min_ev_pct / 100.0

    sport_keys = {s: SPORT_OPTIONS[s] for s in sports if s in SPORT_OPTIONS}
    if not sport_keys:
        return pd.DataFrame(columns=SCAN_COLS), "Select at least one sport.", gr.update(interactive=False)

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
        status_parts.append(f"✅ {label}: {len(games)} games, {len(edges)} with edges.")

        for ge in edges:
            game_str = f"{ge.away_team} @ {ge.home_team}"
            # Sort by best of market EV or model EV
            def _sort_key(o):
                return max(o.ev, o.model_ev if o.model_ev is not None else o.ev)
            for o in sorted(ge.outcomes, key=_sort_key, reverse=True):
                bs = _bet_size(o.kelly)
                rows.append({
                    "Game": game_str,
                    "Bet On": o.name,
                    "Best Odds": round(o.best_odds, 3),
                    "American": _american(o.best_odds),
                    "Book": o.best_book,
                    "Fair %": round(o.fair_prob * 100, 1),
                    "Implied %": round(100 / o.best_odds, 1),
                    "EV %": round(o.ev * 100, 2),
                    "Model %": round(o.model_prob * 100, 1) if o.model_prob is not None else "—",
                    "Model EV %": round(o.model_ev * 100, 2) if o.model_ev is not None else "—",
                    "Bet Size ($)": bs,
                    "Game Time": _fmt_time(ge.commence_time),
                    # extra fields for history (not shown in scan table)
                    "_sport": label,
                    "_odds_decimal": o.best_odds,
                    "_kelly": o.kelly,
                    "_game": game_str,
                    "_bet_on": o.name,
                    "_game_time": ge.commence_time,
                })

    _last_scan = rows

    df = pd.DataFrame(rows, columns=SCAN_COLS) if rows else pd.DataFrame(columns=SCAN_COLS)
    if not df.empty:
        df = df.sort_values("EV %", ascending=False).reset_index(drop=True)
    df = _signal_style(df)

    status = "\n".join(status_parts)
    if rows:
        status += f"\n\n🎯 {len(rows)} value bet(s) found."
    else:
        status += "\n\nNo value bets at this threshold."

    save_btn_state = gr.update(interactive=bool(rows), value=f"💾 Save {len(rows)} bet(s) to History")
    return df, status, save_btn_state


def save_to_history():
    if not _last_scan:
        return "Nothing to save — run a scan first."
    bets_to_save = [
        {
            "sport": r["_sport"],
            "game": r["_game"],
            "bet_on": r["_bet_on"],
            "odds_decimal": r["_odds_decimal"],
            "odds_american": r["American"],
            "bet_size": r["Bet Size ($)"],
            "ev_pct": r["EV %"],
            "game_time": r["_game_time"],
        }
        for r in _last_scan
    ]
    n = storage.add_bets(bets_to_save)
    return f"✅ {n} bet(s) saved to history."


# ---------------------------------------------------------------------------
# History tab
# ---------------------------------------------------------------------------

def load_history(sport_filter: str):
    bets = storage.get_filtered(sport_filter)
    s = storage.summary(bets)

    rows = []
    for b in sorted(bets, key=lambda x: x["date_added"], reverse=True):
        pl = b["profit_loss"]
        pl_str = f"+${pl:.2f}" if pl and pl >= 0 else (f"-${abs(pl):.2f}" if pl else "—")
        rows.append({
            "ID": b["id"],
            "Date": b["date_added"],
            "Sport": b["sport"],
            "Game": b["game"],
            "Bet On": b["bet_on"],
            "Odds": b.get("odds_american", ""),
            "Bet Size ($)": f"${b['bet_size']:.2f}",
            "Result": b["result"],
            "Score": b["score"],
            "P&L ($)": pl_str,
        })

    df = pd.DataFrame(rows, columns=HISTORY_COLS) if rows else pd.DataFrame(columns=HISTORY_COLS)

    pl_color = "🟢" if s["pl"] >= 0 else "🔴"
    summary_md = (
        f"### Summary ({sport_filter})\n"
        f"| Bets | Pending | Won | Lost | Win Rate | {pl_color} P&L |\n"
        f"|------|---------|-----|------|----------|--------|\n"
        f"| {s['total']} | {s['pending']} | {s['wins']} | {s['losses']} | {s['win_rate']} | "
        f"{'+'if s['pl']>=0 else ''}${s['pl']:.2f} |"
    )

    return df, summary_md


def settle(bet_id: str, result: str, score: str, sport_filter: str):
    if not bet_id.strip():
        return "Enter a Bet ID.", *load_history(sport_filter)
    ok, msg = storage.settle_bet(bet_id, result, score)
    df, summary_md = load_history(sport_filter)
    return msg, df, summary_md


def delete(bet_id: str, sport_filter: str):
    if not bet_id.strip():
        return "Enter a Bet ID.", *load_history(sport_filter)
    ok, msg = storage.delete_bet(bet_id)
    df, summary_md = load_history(sport_filter)
    return msg, df, summary_md


# ---------------------------------------------------------------------------
# Tennis Matchup tab
# ---------------------------------------------------------------------------

_TENNIS_PLAYERS = sorted([
    "Jannik Sinner", "Carlos Alcaraz", "Alexander Zverev", "Daniil Medvedev",
    "Novak Djokovic", "Casper Ruud", "Holger Rune", "Andrey Rublev",
    "Stefanos Tsitsipas", "Taylor Fritz", "Ben Shelton", "Tommy Paul",
    "Grigor Dimitrov", "Hubert Hurkacz", "Lorenzo Musetti",
    "Felix Auger-Aliassime", "Ugo Humbert", "Arthur Fils", "Matteo Berrettini",
    "Sebastian Korda", "Francisco Cerundolo", "Nicolas Jarry", "Karen Khachanov",
    "Jack Draper", "Alejandro Davidovich Fokina", "Alexei Popyrin",
    "Nuno Borges", "Jordan Thompson",
    # WTA
    "Aryna Sabalenka", "Iga Swiatek", "Coco Gauff", "Elena Rybakina",
    "Jessica Pegula", "Qinwen Zheng", "Madison Keys", "Emma Navarro",
    "Mirra Andreeva", "Daria Kasatkina", "Barbora Krejcikova", "Paula Badosa",
    "Jelena Ostapenko", "Liudmila Samsonova", "Beatriz Haddad Maia",
    "Anna Kalinskaya", "Jasmine Paolini", "Diana Shnaider", "Caroline Garcia",
])


def tennis_matchup(player1: str, player2: str, surface: str) -> str:
    """Return a markdown breakdown of the tennis model prediction."""
    try:
        from models.tennis import predict, lookup
    except ImportError:
        return "Tennis model not available."

    if not player1 or not player2:
        return "Select both players."
    if player1 == player2:
        return "Select two different players."

    result = predict(player1, player2, surface)
    if result is None:
        p1_known = lookup(player1) is not None
        p2_known = lookup(player2) is not None
        missing = []
        if not p1_known:
            missing.append(player1)
        if not p2_known:
            missing.append(player2)
        return f"Player(s) not in database: {', '.join(missing)}"

    p1_pct = result["p1_win"] * 100
    p2_pct = result["p2_win"] * 100
    fav = player1 if p1_pct >= p2_pct else player2
    fav_pct = max(p1_pct, p2_pct)

    def bar(val: int, max_val: int = 100) -> str:
        filled = round(val / max_val * 20)
        return "█" * filled + "░" * (20 - filled)

    adv_note = ""
    if result["surface_advantage"] not in ("Neutral", player1, player2):
        adv_note = ""
    elif result["surface_advantage"] == player1:
        adv_note = f"  ← surface suits **{player1}**"
    elif result["surface_advantage"] == player2:
        adv_note = f"  ← surface suits **{player2}**"
    else:
        adv_note = "  (surface neutral)"

    def _pref_tag(preferred: str, current: str) -> str:
        return f"✅ home surface" if preferred == current else f"({preferred} preferred)"

    md = f"""
### {player1} vs {player2} — {surface.title()} Court

**Model Prediction:** {fav} wins with **{fav_pct:.1f}%** probability{adv_note}

| | {player1} | {player2} |
|---|---|---|
| **Win Prob** | **{p1_pct:.1f}%** | **{p2_pct:.1f}%** |
| Surface Elo | {result['elo1']} | {result['elo2']} |
| Serve | {result['serve1']}/100 `{bar(result['serve1'])}` | {result['serve2']}/100 `{bar(result['serve2'])}` |
| Return | {result['return1']}/100 `{bar(result['return1'])}` | {result['return2']}/100 `{bar(result['return2'])}` |
| Fitness | {result['fitness1']}/100 `{bar(result['fitness1'])}` | {result['fitness2']}/100 `{bar(result['fitness2'])}` |
| Mental | {result['mental1']}/100 `{bar(result['mental1'])}` | {result['mental2']}/100 `{bar(result['mental2'])}` |
| Best surface | {_pref_tag(result['preferred1'], surface)} | {_pref_tag(result['preferred2'], surface)} |

> **How to use:** Compare these model probabilities to the implied odds at your sportsbook.
> If the model says 60% but the book prices it at 50% (2.00 decimal), that's a +EV bet.
"""
    return md.strip()


# ---------------------------------------------------------------------------
# App layout
# ---------------------------------------------------------------------------

_key_status = (
    "🟢 API key loaded"
    if os.getenv("ODDS_API_KEY", "").strip()
    else "🔴 API key missing — add ODDS_API_KEY as a Space Secret, then restart"
)

with gr.Blocks(title="Sports Betting Edge Finder", theme=gr.themes.Soft()) as demo:
    gr.Markdown(
        f"""
        # 🏈⚾⚽🎾 Sports Betting Edge Finder
        **Status:** {_key_status} &nbsp;|&nbsp; Bankroll: **${BANKROLL:.0f}** &nbsp;|&nbsp;
        Bet sizes use **¼ Kelly**
        > ⚠️ For informational purposes only. Gamble responsibly.
        """
    )

    with gr.Tabs():

        # ── Tab 1: Scanner ─────────────────────────────────────────────────
        with gr.Tab("🔍 Edge Scanner"):
            with gr.Row():
                with gr.Column(scale=1):
                    sports_in = gr.CheckboxGroup(
                        choices=ALL_SPORTS,
                        value=ALL_SPORTS,
                        label="Sports to scan",
                    )
                    min_ev_in = gr.Slider(
                        minimum=0.0, maximum=10.0, value=2.0, step=0.5,
                        label="Minimum EV % threshold",
                        info="Slide to 0 to see all edges",
                    )
                    scan_btn = gr.Button("🔍 Scan for Edges", variant="primary")
                    save_btn = gr.Button("💾 Save to History", interactive=False)
                    save_status = gr.Textbox(label="", lines=1, interactive=False, show_label=False)

                with gr.Column(scale=3):
                    scan_table = gr.Dataframe(headers=SCAN_COLS, label="Value Bets", wrap=True)
                    scan_status = gr.Textbox(label="Status", lines=4, interactive=False)

            scan_btn.click(
                fn=scan,
                inputs=[sports_in, min_ev_in],
                outputs=[scan_table, scan_status, save_btn],
            )
            save_btn.click(
                fn=save_to_history,
                inputs=[],
                outputs=[save_status],
            )

        # ── Tab 2: Bet History ──────────────────────────────────────────────
        with gr.Tab("📋 Bet History"):
            with gr.Row():
                sport_filter = gr.Dropdown(
                    choices=["All"] + ALL_SPORTS,
                    value="All",
                    label="Filter by sport",
                    scale=1,
                )
                refresh_btn = gr.Button("🔄 Refresh", scale=0)

            summary_md = gr.Markdown()
            history_table = gr.Dataframe(headers=HISTORY_COLS, label="Bet History", wrap=True)

            gr.Markdown("### Settle a Bet")
            with gr.Row():
                settle_id = gr.Textbox(label="Bet ID", placeholder="e.g. A3F2B1C4", scale=1)
                settle_result = gr.Radio(["Win", "Loss"], label="Result", value="Win", scale=1)
                settle_score = gr.Textbox(label="Score (optional)", placeholder="e.g. NYY 5 – BOS 3", scale=2)
                settle_btn = gr.Button("✅ Settle", variant="primary", scale=0)

            gr.Markdown("### Delete a Bet")
            with gr.Row():
                delete_id = gr.Textbox(label="Bet ID to delete", placeholder="e.g. A3F2B1C4", scale=1)
                delete_btn = gr.Button("🗑️ Delete", variant="stop", scale=0)

            action_status = gr.Textbox(label="", lines=1, interactive=False, show_label=False)

            # Load history on tab open / filter change / refresh
            sport_filter.change(
                fn=load_history, inputs=[sport_filter], outputs=[history_table, summary_md]
            )
            refresh_btn.click(
                fn=load_history, inputs=[sport_filter], outputs=[history_table, summary_md]
            )
            settle_btn.click(
                fn=settle,
                inputs=[settle_id, settle_result, settle_score, sport_filter],
                outputs=[action_status, history_table, summary_md],
            )
            delete_btn.click(
                fn=delete,
                inputs=[delete_id, sport_filter],
                outputs=[action_status, history_table, summary_md],
            )

            # Initial load
            demo.load(fn=load_history, inputs=[sport_filter], outputs=[history_table, summary_md])

        # ── Tab 3: Tennis Matchup Analyzer ─────────────────────────────────
        with gr.Tab("🎾 Tennis Matchup"):
            gr.Markdown(
                """
                ### Player vs Player Analysis
                Select two players and a surface to see the model's win probability breakdown,
                including serve, return, fitness, and mental ratings.
                Use this alongside the Edge Scanner to find value in live tennis odds.
                """
            )
            with gr.Row():
                p1_in = gr.Dropdown(
                    choices=_TENNIS_PLAYERS,
                    label="Player 1",
                    scale=2,
                )
                p2_in = gr.Dropdown(
                    choices=_TENNIS_PLAYERS,
                    label="Player 2",
                    scale=2,
                )
                surface_in = gr.Radio(
                    choices=["hard", "clay", "grass"],
                    value="hard",
                    label="Surface",
                    scale=1,
                )
                analyze_btn = gr.Button("Analyze", variant="primary", scale=0)

            matchup_out = gr.Markdown()

            analyze_btn.click(
                fn=tennis_matchup,
                inputs=[p1_in, p2_in, surface_in],
                outputs=[matchup_out],
            )
            # Also re-run when surface changes (if players already selected)
            surface_in.change(
                fn=tennis_matchup,
                inputs=[p1_in, p2_in, surface_in],
                outputs=[matchup_out],
            )


if __name__ == "__main__":
    demo.launch()
