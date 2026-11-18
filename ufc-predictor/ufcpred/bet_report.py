"""Read-only dump of the simulated-bet ledger with the market price for every pick (staked or not).

Used to study betting rules offline; it never writes and never touches the prediction engine.
"""
import sys


def main() -> int:
    from .db import connect
    conn = connect()
    rows = conn.execute(
        """SELECT b.event_date, b.pick_name, b.opponent_name, b.tier, b.confidence_score, b.p_pick, b.stake_cents,
                  b.odds_decimal, b.status, b.net_cents, b.fight_id, b.pick_fighter_id, f.red_fighter_id, f.status AS fstatus,
                  (SELECT r.outcome FROM fight_results r WHERE r.fight_id=b.fight_id ORDER BY r.revision DESC LIMIT 1) AS outcome,
                  (SELECT r.winner_fighter_id FROM fight_results r WHERE r.fight_id=b.fight_id ORDER BY r.revision DESC LIMIT 1) AS winner,
                  (SELECT r.method FROM fight_results r WHERE r.fight_id=b.fight_id ORDER BY r.revision DESC LIMIT 1) AS method,
                  (SELECT MIN(r.recorded_at) FROM fight_results r WHERE r.fight_id=b.fight_id) AS first_res
           FROM sim_bets b JOIN fights f ON f.id=b.fight_id WHERE b.strategy='confidence_flat'
           ORDER BY b.event_date, b.id""").fetchall()
    cols = ["date", "pick", "opp", "tier", "conf", "p", "stake", "bet_dec", "status", "net", "mkt_dec_pick", "mkt_dec_opp",
            "n_odds", "outcome", "pick_won", "method", "fight_status"]
    print("\t".join(cols))
    for b in rows:
        odds = conn.execute("SELECT red_decimal, blue_decimal, captured_at FROM odds WHERE fight_id=? ORDER BY captured_at",
                            (b["fight_id"],)).fetchall()
        if b["first_res"]:
            odds = [o for o in odds if str(o["captured_at"]) < str(b["first_res"])] or odds
        red = b["pick_fighter_id"] == b["red_fighter_id"]
        mp = mo = None
        if odds:
            o = odds[-1]
            mp, mo = (o["red_decimal"], o["blue_decimal"]) if red else (o["blue_decimal"], o["red_decimal"])
        won = "" if b["winner"] is None else int(b["winner"] == b["pick_fighter_id"])
        vals = [b["event_date"], b["pick_name"], b["opponent_name"], b["tier"], b["confidence_score"],
                None if b["p_pick"] is None else round(b["p_pick"], 4), b["stake_cents"], b["odds_decimal"], b["status"],
                b["net_cents"], None if mp is None else round(mp, 4), None if mo is None else round(mo, 4), len(odds),
                b["outcome"], won, b["method"], b["fstatus"]]
        print("\t".join("" if v is None else str(v) for v in vals))
    return 0


if __name__ == "__main__":
    sys.exit(main())
