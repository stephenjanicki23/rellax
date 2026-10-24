"""SYNTHETIC TEST DATA — never used by the application.

A seeded generator of a fictional league with known latent skill, so tests can check
that the pipeline learns real signal and never sees future data. All names are
"Synthetic Fighter N"; provider name is `synthetic_test`.
"""
from __future__ import annotations

import datetime as dt
import math

import numpy as np

from ufcpred.providers.base import Bundle, PEvent, PFight, PFighter, PResult, PRoundStats

CLASSES = ["Lightweight", "Welterweight", "Middleweight"]


def make_bundle(seed: int = 1, n_fighters: int = 150, n_events: int = 110, fights_per_event: int = 10,
                start: str = "2016-01-02", gap_days: int = 14) -> tuple[Bundle, dict]:
    rng = np.random.default_rng(seed)
    b = Bundle(provider="synthetic_test")
    skill = rng.normal(0, 1, n_fighters)
    wrest = rng.uniform(0, 1, n_fighters)
    cls = rng.integers(0, len(CLASSES), n_fighters)
    for i in range(n_fighters):
        dob = (dt.date(1984, 1, 1) + dt.timedelta(days=int(rng.integers(0, 4000)))).isoformat()
        reach = None if rng.random() < 0.1 else float(68 + int(rng.integers(0, 10)))
        b.fighters.append(PFighter(f"syn:f{i}", f"Synthetic Fighter {i}", dob=dob, height_in=float(66 + int(rng.integers(0, 10))),
                                   reach_in=reach, stance="Southpaw" if rng.random() < 0.25 else "Orthodox",
                                   listed_weight_lbs=float([155, 170, 185][cls[i]])))
    d0 = dt.date.fromisoformat(start)
    truth = {}
    for e in range(n_events):
        date = (d0 + dt.timedelta(days=e * gap_days)).isoformat()
        eid = f"syn:e{e}"
        b.events.append(PEvent(eid, f"Synthetic Event {e}", date, location="Test City"))
        used = set()
        for k in range(fights_per_event):
            c = int(rng.integers(0, len(CLASSES)))
            pool = [i for i in range(n_fighters) if cls[i] == c and i not in used]
            if len(pool) < 2:
                continue
            a, bb = rng.choice(pool, 2, replace=False)
            used.update({int(a), int(bb)})
            rounds = 5 if k == 0 else 3
            fid = f"syn:x{e}_{k}"
            b.fights.append(PFight(fid, eid, f"Synthetic Fighter {a}", f"Synthetic Fighter {bb}", f"syn:f{a}", f"syn:f{bb}",
                                   CLASSES[c], False, False, rounds, f"{rounds} Rnd", "main" if k < 5 else "prelim", k + 1))
            p_a = 1 / (1 + math.exp(-1.3 * (skill[a] - skill[bb])))
            r = rng.random()
            if r < 0.01:
                b.results.append(PResult(fid, "draw", None, "DRAW", "Decision - Split", rounds, 300))
                truth[fid] = {"p_red": p_a, "outcome": "draw"}
                end_round = rounds
            else:
                a_wins = rng.random() < p_a
                w, l = (a, bb) if a_wins else (bb, a)
                m = rng.random()
                if m < 0.30 + 0.1 * (1 - wrest[w]):
                    method, end_round, t = "KO_TKO", int(rng.integers(1, rounds + 1)), int(rng.integers(10, 300))
                elif m < 0.50 + 0.2 * wrest[w]:
                    method, end_round, t = "SUB", int(rng.integers(1, rounds + 1)), int(rng.integers(10, 300))
                else:
                    method, end_round, t = "DEC", rounds, 300
                b.results.append(PResult(fid, "win", "red" if a_wins else "blue", method, method, end_round, t))
                truth[fid] = {"p_red": p_a, "outcome": "win", "red_won": a_wins}
            for corner, me, opp in (("red", a, bb), ("blue", bb, a)):
                for rd in range(1, end_round + 1):
                    att = int(rng.poisson(18))
                    acc = min(max(0.42 + 0.06 * (skill[me] - skill[opp]), 0.1), 0.9)
                    landed = int(rng.binomial(att, acc))
                    td_a = int(rng.poisson(0.2 + 1.2 * wrest[me]))
                    td_l = int(rng.binomial(td_a, min(max(0.35 + 0.1 * (skill[me] - skill[opp]), 0.05), 0.95)))
                    st = {"kd": int(rng.random() < 0.05 + 0.03 * max(skill[me] - skill[opp], 0)), "sub_att": int(rng.poisson(0.2 * wrest[me])),
                          "rev": 0, "ctrl_sec": int(min(td_l * 60, 280)), "sig_l": landed, "sig_a": att, "tot_l": landed + 3,
                          "tot_a": att + 4, "td_l": td_l, "td_a": td_a, "head_l": int(landed * 0.6), "head_a": int(att * 0.6),
                          "body_l": int(landed * 0.2), "body_a": int(att * 0.2), "leg_l": landed - int(landed * 0.6) - int(landed * 0.2),
                          "leg_a": att - int(att * 0.6) - int(att * 0.2), "dist_l": int(landed * 0.7), "dist_a": int(att * 0.7),
                          "clinch_l": int(landed * 0.1), "clinch_a": int(att * 0.1), "ground_l": landed - int(landed * 0.7) - int(landed * 0.1),
                          "ground_a": att - int(att * 0.7) - int(att * 0.1)}
                    b.stats.append(PRoundStats(fid, corner, rd, st))
    return b, {"skill": skill, "truth": truth, "dates": [e.date for e in b.events]}
