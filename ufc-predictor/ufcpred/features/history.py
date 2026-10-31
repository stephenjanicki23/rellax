"""Point-in-time fight history.

`HistoryStore` loads every completed fight once and answers one question:
*what did we know about fighter X strictly before date D?* Every feature in the engine is
computed through `fighter_state(fighter, at_date, cutoff)` which only reads records with
`date < min(at_date, cutoff)`. Post-fight statistics of the fight being predicted, and
anything later, are structurally unreachable.

Elo ratings are computed sequentially (pre-fight values), so they are point-in-time too.
"""
from __future__ import annotations

import bisect
import math
from collections import defaultdict
from dataclasses import dataclass, field

from ..providers.parse import CLASS_ORDER
from ..util import days_between, parse_date

TOTAL_KEYS = ["kd", "sig_l", "sig_a", "tot_l", "tot_a", "td_l", "td_a", "sub_att", "ctrl_sec", "head_l", "body_l",
              "leg_l", "dist_l", "clinch_l", "ground_l"]


@dataclass
class FightRecord:
    fight_id: int
    event_id: int
    date: str
    fighter_id: int
    opp_id: int
    result: float | None          # 1 win, 0 loss, 0.5 draw, None no contest
    method: str | None
    end_round: int | None
    seconds: float | None         # fight duration
    scheduled_rounds: int | None
    weight_class: str | None
    own: dict | None              # totals over rounds (None when no stats exist)
    opp: dict | None
    late_own_sig: float | None    # sig landed in rounds >= 3
    late_seconds: float | None
    early_own_sig: float | None   # sig landed in round 1
    early_seconds: float | None
    elo_pre: float = 1500.0
    opp_elo_pre: float = 1500.0
    expected: float = 0.5


@dataclass
class Fighter:
    id: int
    name: str
    dob: str | None
    height_in: float | None
    reach_in: float | None
    stance: str | None


@dataclass
class HistoryStore:
    fighters: dict = field(default_factory=dict)
    records: dict = field(default_factory=lambda: defaultdict(list))   # fighter_id -> [FightRecord] by date
    record_dates: dict = field(default_factory=dict)
    fights: dict = field(default_factory=dict)                          # fight_id -> meta row (dict)
    pop_dates: list = field(default_factory=list)
    pop_cum: list = field(default_factory=list)
    elo_k: float = 40.0

    # ------------------------------------------------------------------ loading
    @classmethod
    def load(cls, conn, elo_k: float = 40.0) -> "HistoryStore":
        h = cls(elo_k=elo_k)
        corr = defaultdict(dict)
        for c in conn.execute("SELECT fighter_id, field, value FROM fighter_corrections ORDER BY id"):
            corr[c["fighter_id"]][c["field"]] = c["value"]
        for r in conn.execute("SELECT id, name, dob, height_in, reach_in, stance FROM fighters"):
            d = dict(r)
            for k, v in corr.get(r["id"], {}).items():
                d[k] = float(v) if k in ("height_in", "reach_in") and v not in (None, "") else (v or None)
            h.fighters[r["id"]] = Fighter(d["id"], d["name"], d["dob"], d["height_in"], d["reach_in"], d["stance"])

        rows = conn.execute(
            """SELECT f.id, f.event_id, e.date, f.red_fighter_id, f.blue_fighter_id, f.weight_class, f.is_title,
                      f.is_women, f.scheduled_rounds, f.status, f.card_segment, f.bout_order,
                      f.short_notice_red, f.short_notice_blue, f.weight_miss_red, f.weight_miss_blue
               FROM fights f JOIN events e ON e.id=f.event_id ORDER BY e.date, f.id""").fetchall()
        for r in rows:
            h.fights[r["id"]] = dict(r)
        results = {}
        for r in conn.execute(
                """SELECT r.* FROM fight_results r JOIN (SELECT fight_id, MAX(revision) rv FROM fight_results
                   GROUP BY fight_id) m ON m.fight_id=r.fight_id AND m.rv=r.revision"""):
            results[r["fight_id"]] = dict(r)
        stats = defaultdict(lambda: defaultdict(list))
        for s in conn.execute("SELECT * FROM fight_stats"):
            stats[s["fight_id"]][s["fighter_id"]].append(dict(s))

        elo = defaultdict(lambda: 1500.0)
        pop = defaultdict(float)
        last_date = None
        pending_elo = []
        for r in rows:
            res = results.get(r["id"])
            if res is None or r["status"] not in ("completed",):
                continue
            date = r["date"]
            if last_date is not None and date != last_date:
                # apply Elo updates only once the whole date is processed: same-day fights never see each other
                for fid_, delta in pending_elo:
                    elo[fid_] += delta
                pending_elo = []
            last_date = date
            red, blue = r["red_fighter_id"], r["blue_fighter_id"]
            secs = res["total_time_sec"]
            if secs is None and res["end_round"] and res["end_time_sec"] is not None:
                secs = (res["end_round"] - 1) * 300 + res["end_time_sec"]
            tot = {fid_: _totals(stats[r["id"]].get(fid_)) for fid_ in (red, blue)}
            er, eb = elo[red], elo[blue]
            exp_red = 1 / (1 + 10 ** ((eb - er) / 400))
            if res["outcome"] == "win":
                s_red = 1.0 if res["winner_fighter_id"] == red else 0.0
            elif res["outcome"] == "draw":
                s_red = 0.5
            else:
                s_red = None
            for me, opp, s, e_me, e_opp, exp in ((red, blue, s_red, er, eb, exp_red),
                                                 (blue, red, None if s_red is None else 1 - s_red, eb, er,
                                                  1 - exp_red)):
                own, oth = tot[me], tot[opp]
                late = _late(stats[r["id"]].get(me))
                early = _early(stats[r["id"]].get(me))
                h.records[me].append(FightRecord(
                    r["id"], r["event_id"], date, me, opp, s, res["method"], res["end_round"], secs,
                    r["scheduled_rounds"], r["weight_class"], own[0] if own else None, oth[0] if oth else None,
                    late[0], late[1], early[0], early[1], e_me, e_opp, exp))
            if s_red is not None:
                k = h.elo_k
                pending_elo.append((red, k * (s_red - exp_red)))
                pending_elo.append((blue, k * ((1 - s_red) - (1 - exp_red))))
            # population totals (point-in-time priors)
            for fid_ in (red, blue):
                if tot[fid_] and secs:
                    for kk, vv in tot[fid_][0].items():
                        pop[kk] += vv or 0
                    pop["seconds"] += secs
                    pop["fighter_fights"] += 1
            if res["outcome"] == "win":
                pop["wins"] += 1
                pop[f"m_{res['method']}"] += 1
            pop["fights"] += 1
            h.pop_dates.append(date)
            h.pop_cum.append(dict(pop))
        h._elo_now = dict(elo)
        for fid_, delta in pending_elo:
            h._elo_now[fid_] = h._elo_now.get(fid_, 1500.0) + delta
        for fid_, recs in h.records.items():
            h.record_dates[fid_] = [x.date for x in recs]
        h.results = results
        return h

    # ------------------------------------------------------------------ queries
    def records_before(self, fighter_id: int, date: str) -> list[FightRecord]:
        recs = self.records.get(fighter_id, [])
        i = bisect.bisect_left(self.record_dates.get(fighter_id, []), date)
        return recs[:i]

    def population(self, date: str) -> dict:
        i = bisect.bisect_left(self.pop_dates, date)
        raw = self.pop_cum[i - 1] if i > 0 else {}
        mins = raw.get("seconds", 0) / 60
        def rate(k, default):
            return raw.get(k, 0) / mins if mins > 100 else default
        def ratio(a, b, default):
            return raw.get(a, 0) / raw[b] if raw.get(b, 0) > 50 else default
        wins = raw.get("wins", 0)
        def mrate(m, default):
            return raw.get(f"m_{m}", 0) / wins if wins > 50 else default
        return {
            "slpm": rate("sig_l", 3.5), "sig_att_pm": rate("sig_a", 8.0), "td_pm": rate("td_l", 0.1),
            "td_att_pm": rate("td_a", 0.27), "sub_pm": rate("sub_att", 0.04), "kd_pm": rate("kd", 0.02),
            "ctrl_share": raw.get("ctrl_sec", 0) / raw["seconds"] if raw.get("seconds", 0) > 6000 else 0.12,
            "str_acc": ratio("sig_l", "sig_a", 0.45), "td_acc": ratio("td_l", "td_a", 0.38),
            "ko_rate": mrate("KO_TKO", 0.33), "sub_rate": mrate("SUB", 0.20), "dec_rate": mrate("DEC", 0.45),
            "n_fights": raw.get("fights", 0),
        }

    def elo_before(self, fighter_id: int, date: str) -> float:
        """Elo entering a fight on `date`: the post-fight rating of the last fight before it."""
        recs = self.records_before(fighter_id, date)
        if not recs:
            return 1500.0
        last = recs[-1]
        if last.result is None:
            return last.elo_pre
        return last.elo_pre + self.elo_k * (last.result - last.expected)


def _totals(rounds: list[dict] | None):
    if not rounds:
        return None
    t = {k: 0 for k in TOTAL_KEYS}
    missing = False
    for r in rounds:
        for k in TOTAL_KEYS:
            v = r.get(k)
            if v is None:
                missing = True
            else:
                t[k] += v
    return (t, missing)


def _late(rounds):
    if not rounds:
        return None, None
    late = [r for r in rounds if r["round"] >= 3]
    if not late:
        return None, None
    return sum(r["sig_l"] or 0 for r in late), 300.0 * len(late)


def _early(rounds):
    if not rounds:
        return None, None
    r1 = [r for r in rounds if r["round"] == 1]
    if not r1:
        return None, None
    return sum(r["sig_l"] or 0 for r in r1), 300.0


def class_index(weight_class: str | None) -> int | None:
    if not weight_class:
        return None
    base = weight_class.replace("Women's ", "")
    return CLASS_ORDER.index(base) if base in CLASS_ORDER else None


def fighter_state(h: HistoryStore, fighter_id: int, at_date: str, cutoff: str | None = None, *,
                  half_life_days: float = 540.0, prior_minutes: float = 15.0,
                  bout_weight_class: str | None = None) -> dict:
    """Everything known about a fighter strictly before min(at_date, cutoff)."""
    limit = min(at_date, cutoff) if cutoff else at_date
    recs = h.records_before(fighter_id, limit)
    pop = h.population(limit)
    f = h.fighters.get(fighter_id)
    st: dict = {"fighter_id": fighter_id, "as_of": limit, "name": f.name if f else None}
    # --- profile
    st["age"] = (parse_date(at_date) - parse_date(f.dob)).days / 365.25 if f and f.dob else None
    st["height"] = f.height_in if f else None
    st["reach"] = f.reach_in if f else None
    st["stance"] = f.stance if f else None
    missing_profile = [k for k in ("age", "height", "reach", "stance") if st[k] is None]
    # --- record
    decided = [r for r in recs if r.result is not None]
    n = len(recs)
    wins = sum(1 for r in decided if r.result == 1)
    losses = sum(1 for r in decided if r.result == 0)
    st.update(n_fights=n, wins=wins, losses=losses, draws=sum(1 for r in decided if r.result == 0.5),
              no_contests=n - len(decided), debut=n == 0)
    st["win_rate"] = (wins + 1) / (wins + losses + 2)
    st["log_exp"] = math.log1p(n)
    # method rates, shrunk toward population with 3 pseudo-fights
    def rate(cnt, total, prior, k=3.0):
        return (cnt + prior * k) / (total + k)
    wm = defaultdict(int)
    lm = defaultdict(int)
    for r in decided:
        if r.result == 1:
            wm[r.method] += 1
        elif r.result == 0:
            lm[r.method] += 1
    st["ko_win_rate"] = rate(wm["KO_TKO"], max(n, 0), pop["ko_rate"] * 0.5)
    st["sub_win_rate"] = rate(wm["SUB"], n, pop["sub_rate"] * 0.5)
    st["dec_win_rate"] = rate(wm["DEC"], n, pop["dec_rate"] * 0.5)
    st["ko_loss_rate"] = rate(lm["KO_TKO"], n, pop["ko_rate"] * 0.5)
    st["sub_loss_rate"] = rate(lm["SUB"], n, pop["sub_rate"] * 0.5)
    st["finish_win_rate"] = st["ko_win_rate"] + st["sub_win_rate"]
    st["finished_rate"] = st["ko_loss_rate"] + st["sub_loss_rate"]
    st["record_counts"] = {"wins_by": dict(wm), "losses_by": dict(lm)}
    # --- rates from per-round statistics
    tot = defaultdict(float)
    opp = defaultdict(float)
    secs = 0.0
    n_stats = 0
    late_sig = late_s = early_sig = early_s = 0.0
    for r in recs:
        if r.own is None or r.opp is None or not r.seconds:
            continue
        n_stats += 1
        secs += r.seconds
        for k, v in r.own.items():
            tot[k] += v or 0
        for k, v in r.opp.items():
            opp[k] += v or 0
        if r.late_own_sig is not None:
            late_sig += r.late_own_sig
            late_s += r.late_seconds
        if r.early_own_sig is not None:
            early_sig += r.early_own_sig
            early_s += r.early_seconds
    mins = secs / 60
    pm = prior_minutes
    def per_min(x, prior):
        return (x + prior * pm) / (mins + pm)
    def pct(l, a, prior, k=20.0):
        return (l + prior * k) / (a + k)
    st["minutes"] = mins
    st["n_with_stats"] = n_stats
    st["slpm"] = per_min(tot["sig_l"], pop["slpm"])
    st["sapm"] = per_min(opp["sig_l"], pop["slpm"])
    st["pace"] = per_min(tot["sig_a"], pop["sig_att_pm"])
    st["str_acc"] = pct(tot["sig_l"], tot["sig_a"], pop["str_acc"])
    st["str_def"] = 1 - pct(opp["sig_l"], opp["sig_a"], pop["str_acc"])
    st["td15"] = 15 * per_min(tot["td_l"], pop["td_pm"])
    st["td_acc"] = pct(tot["td_l"], tot["td_a"], pop["td_acc"], 6.0)
    st["td_def"] = 1 - pct(opp["td_l"], opp["td_a"], pop["td_acc"], 6.0)
    st["sub15"] = 15 * per_min(tot["sub_att"], pop["sub_pm"])
    st["kd15"] = 15 * per_min(tot["kd"], pop["kd_pm"])
    st["kd_abs15"] = 15 * per_min(opp["kd"], pop["kd_pm"])
    st["head_abs_pm"] = per_min(opp["head_l"], pop["slpm"] * 0.6)
    # strike location (body / legs): per-minute volume landed and absorbed, shrunk like the other rates
    st["body_pm"] = per_min(tot["body_l"], pop["slpm"] * 0.2)
    st["leg_pm"] = per_min(tot["leg_l"], pop["slpm"] * 0.15)
    st["body_abs_pm"] = per_min(opp["body_l"], pop["slpm"] * 0.2)
    st["leg_abs_pm"] = per_min(opp["leg_l"], pop["slpm"] * 0.15)
    st["body_diff_pm"] = st["body_pm"] - st["body_abs_pm"]
    st["leg_diff_pm"] = st["leg_pm"] - st["leg_abs_pm"]
    st["ctrl_share"] = (tot["ctrl_sec"] + pop["ctrl_share"] * pm * 60) / (secs + pm * 60)
    st["opp_ctrl_share"] = (opp["ctrl_sec"] + pop["ctrl_share"] * pm * 60) / (secs + pm * 60)
    sig_total = tot["sig_l"]
    st["dist_share"] = (tot["dist_l"] + 0.7 * 20) / (sig_total + 20)
    st["ground_share"] = (tot["ground_l"] + 0.12 * 20) / (sig_total + 20)
    st["head_share"] = (tot["head_l"] + 0.65 * 20) / (sig_total + 20)
    # cardio: late-round output relative to round-one output (1.0 = no fade), shrunk to 0.9
    if early_s > 0 and late_s > 0:
        ratio = (late_sig / late_s) / max(early_sig / early_s, 1e-3)
        w = late_s / (late_s + 900)
        st["late_ratio"] = w * min(ratio, 3.0) + (1 - w) * 0.9
    else:
        st["late_ratio"] = None
    # --- time-decayed form (Model B)
    lam = math.log(2) / max(half_life_days, 1)
    wsum = wres = wperf = wopp = 0.0
    dt_ = defaultdict(float)
    do_ = defaultdict(float)
    dsecs = 0.0
    for r in recs:
        age_d = days_between(r.date, limit)
        w = math.exp(-lam * age_d)
        if r.result is not None:
            wsum += w
            wres += w * r.result
            wperf += w * (r.result - r.expected)
            wopp += w * r.opp_elo_pre
        if r.own is not None and r.opp is not None and r.seconds:
            dsecs += w * r.seconds
            for k, v in r.own.items():
                dt_[k] += w * (v or 0)
            for k, v in r.opp.items():
                do_[k] += w * (v or 0)
    dmins = dsecs / 60
    def dper_min(x, prior):
        return (x + prior * pm) / (dmins + pm)
    st["d_slpm"] = dper_min(dt_["sig_l"], pop["slpm"])
    st["d_sapm"] = dper_min(do_["sig_l"], pop["slpm"])
    st["d_td15"] = 15 * dper_min(dt_["td_l"], pop["td_pm"])
    st["d_td_def"] = 1 - (do_["td_l"] + pop["td_acc"] * 6) / (do_["td_a"] + 6)
    st["d_kd15"] = 15 * dper_min(dt_["kd"], pop["kd_pm"])
    st["d_ctrl_share"] = (dt_["ctrl_sec"] + pop["ctrl_share"] * pm * 60) / (dsecs + pm * 60)
    st["d_win_rate"] = (wres + 1) / (wsum + 2)
    st["d_perf"] = wperf / (wsum + 1)
    st["d_opp_elo"] = (wopp + 1500 * 1) / (wsum + 1)
    st["effective_fights"] = wsum
    # --- opponent quality, Elo, streaks
    st["elo"] = h.elo_before(fighter_id, limit)
    st["opp_elo_mean"] = (sum(r.opp_elo_pre for r in decided) + 1500 * 2) / (len(decided) + 2)
    streak = 0
    for r in reversed(decided):
        if r.result == 1 and streak >= 0:
            streak += 1
        elif r.result == 0 and streak <= 0:
            streak -= 1
        else:
            break
    st["streak"] = max(min(streak, 6), -6)
    st["last3_wins"] = sum(1 for r in decided[-3:] if r.result == 1)
    st["last5"] = [{"date": r.date, "fight_id": r.fight_id, "opp_id": r.opp_id, "result": r.result,
                    "method": r.method, "opp_elo": round(r.opp_elo_pre, 1)} for r in recs[-5:]]
    # --- context
    st["days_since_last"] = days_between(recs[-1].date, at_date) if recs else None
    st["last_fight_date"] = recs[-1].date if recs else None
    prev_cls = next((class_index(r.weight_class) for r in reversed(recs) if class_index(r.weight_class) is not None),
                    None)
    cur_cls = class_index(bout_weight_class)
    st["class_change"] = (cur_cls - prev_cls) if (prev_cls is not None and cur_cls is not None) else (0 if recs else None)
    st["five_round_exp"] = sum(1 for r in recs if r.scheduled_rounds == 5)
    st["avg_time_share"] = (sum((r.seconds or 0) / (300 * (r.scheduled_rounds or 3)) for r in recs) / n) if n else None
    st["missing_profile"] = missing_profile
    st["stats_coverage"] = n_stats / n if n else None
    st["population_prior"] = {k: round(v, 4) for k, v in pop.items()}
    return st
