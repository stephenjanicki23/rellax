"""SYNTHETIC TEST DATA — never used by the application.

A seeded fictional league (the 30 franchise identities, so arena/travel lookups work, but invented
strengths and results) with known latent team strength, so tests can check that the pipeline learns real
signal and never sees future data. Provider name is `synthetic_test`.
"""
from __future__ import annotations

import datetime as dt

import numpy as np

from nbapred import teams as T
from nbapred.providers.base import Bundle, PGame, PResult, PTeam, PTeamStats

HOME_EDGE = 3.0


def _box(rng, pts: int) -> dict:
    fta = int(rng.integers(16, 28))
    ftm = min(fta, int(round(fta * 0.77)))
    fg3a = int(rng.integers(26, 40))
    fg3m = min(fg3a, int(rng.binomial(fg3a, 0.36)))
    fgm = max((pts - ftm - 3 * fg3m) // 2 + fg3m, fg3m)
    ftm = pts - 2 * (fgm - fg3m) - 3 * fg3m              # make the points add up exactly
    if ftm < 0 or ftm > fta:
        fta = max(fta, ftm, 0)
        ftm = max(ftm, 0)
    fga = max(fgm + int(rng.integers(35, 50)), fg3a + 10)
    return {"pts": pts, "fgm": fgm, "fga": fga, "fg3m": fg3m, "fg3a": fg3a, "ftm": ftm, "fta": fta,
            "oreb": int(rng.integers(6, 15)), "dreb": int(rng.integers(28, 40)), "ast": int(rng.integers(18, 32)),
            "stl": int(rng.integers(4, 12)), "blk": int(rng.integers(2, 9)), "tov": int(rng.integers(9, 18)),
            "pf": int(rng.integers(14, 24)), "minutes": 240.0}


def make_bundle(seed: int = 1, seasons: int = 3, nights: int = 90, games_per_night: int = 10,
                start_year: int = 2016) -> tuple[Bundle, dict]:
    rng = np.random.default_rng(seed)
    ids = list(T.TEAMS)
    b = Bundle(provider="synthetic_test")
    for tid in ids:
        ref = T.TEAMS[tid]
        b.teams.append(PTeam(T.external_id(tid), ref[1], ref[0], ref[2], ref[3]))
    strength = {tid: rng.normal(0, 5) for tid in ids}
    truth, dates, season_of_night = {}, [], []
    for s in range(seasons):
        y = start_year + s
        season = f"{y}-{(y + 1) % 100:02d}"
        # carry most of last season's strength over, as in the real league
        strength = {t: 0.7 * v + rng.normal(0, 2.5) for t, v in strength.items()}
        d0 = dt.date(y, 10, 25)
        for n in range(nights):
            date = (d0 + dt.timedelta(days=int(n * 1.8))).isoformat()
            dates.append(date)
            season_of_night.append(season)
            order = list(rng.permutation(ids))
            for k in range(games_per_night):
                h, a = int(order[2 * k]), int(order[2 * k + 1])
                for tid in (h, a):                          # slow within-season drift
                    strength[tid] += rng.normal(0, 0.15)
                exp_margin = strength[h] - strength[a] + HOME_EDGE
                margin = int(round(exp_margin + rng.normal(0, 12)))
                periods = 4
                if margin == 0:
                    margin, periods = (1 if rng.random() < 0.5 else -1) * int(rng.integers(1, 8)), 5
                total = int(round(220 + rng.normal(0, 18)))
                hp = (total + margin) // 2
                ap = hp - margin
                ext = f"syn:g{s}_{n}_{k}"
                b.games.append(PGame(ext, date, T.TEAMS[h][1], T.TEAMS[a][1], T.external_id(h), T.external_id(a),
                                     season, "regular", status="completed"))
                b.results.append(PResult(ext, "win", hp, ap, periods))
                b.stats.append(PTeamStats(ext, "home", _box(rng, hp)))
                b.stats.append(PTeamStats(ext, "away", _box(rng, ap)))
                from math import erf, sqrt
                truth[ext] = {"p_home": 0.5 * (1 + erf(exp_margin / 12 / sqrt(2))), "home_won": margin > 0}
    return b, {"strength": strength, "truth": truth, "dates": dates, "seasons": season_of_night}
