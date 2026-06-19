"""Persistent bet history storage using a JSON file."""

import json
import os
import uuid
from datetime import datetime

# Use HF Spaces persistent storage (/data) when available, else local file
_DATA_DIR = "/data" if os.path.isdir("/data") else os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(_DATA_DIR, "bet_history.json")

BANKROLL = 200.0


def load_bets() -> list[dict]:
    if not os.path.exists(DATA_FILE):
        return []
    try:
        with open(DATA_FILE) as f:
            return json.load(f)
    except Exception:
        return []


def _save(bets: list[dict]) -> None:
    with open(DATA_FILE, "w") as f:
        json.dump(bets, f, indent=2)


def add_bets(new_bets: list[dict]) -> int:
    """Append a list of edge bets to history. Returns count added."""
    existing = load_bets()
    for b in new_bets:
        b["id"] = str(uuid.uuid4())[:8].upper()
        b["date_added"] = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
        b["result"] = "Pending"
        b["score"] = "—"
        b["profit_loss"] = None
        existing.append(b)
    _save(existing)
    return len(new_bets)


def settle_bet(bet_id: str, result: str, score: str) -> tuple[bool, str]:
    bets = load_bets()
    for bet in bets:
        if bet["id"] == bet_id.strip().upper():
            if bet["result"] != "Pending":
                return False, f"Bet {bet_id} is already settled ({bet['result']})."
            bet["result"] = result
            bet["score"] = score.strip() or "—"
            if result == "Win":
                bet["profit_loss"] = round(bet["bet_size"] * (bet["odds_decimal"] - 1), 2)
            else:
                bet["profit_loss"] = -round(bet["bet_size"], 2)
            _save(bets)
            pl = bet["profit_loss"]
            sign = "+" if pl >= 0 else ""
            return True, f"✅ {bet_id} settled as {result}. P&L: {sign}${pl:.2f}"
    return False, f"Bet ID '{bet_id}' not found."


def delete_bet(bet_id: str) -> tuple[bool, str]:
    bets = load_bets()
    before = len(bets)
    bets = [b for b in bets if b["id"] != bet_id.strip().upper()]
    if len(bets) == before:
        return False, f"Bet ID '{bet_id}' not found."
    _save(bets)
    return True, f"🗑️ Bet {bet_id} deleted."


def get_filtered(sport_filter: str) -> list[dict]:
    bets = load_bets()
    if sport_filter != "All":
        bets = [b for b in bets if b.get("sport") == sport_filter]
    return bets


def summary(bets: list[dict]) -> dict:
    settled = [b for b in bets if b["result"] != "Pending"]
    wins = [b for b in settled if b["result"] == "Win"]
    total_pl = sum(b["profit_loss"] for b in settled if b["profit_loss"] is not None)
    return {
        "total": len(bets),
        "pending": len(bets) - len(settled),
        "settled": len(settled),
        "wins": len(wins),
        "losses": len(settled) - len(wins),
        "win_rate": f"{len(wins)/len(settled)*100:.1f}%" if settled else "—",
        "pl": total_pl,
    }
