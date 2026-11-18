"""Point-in-time team history.

`HistoryStore` loads every completed game once and answers one question: *what did we know about
team X strictly before date D?* Every feature in the engine is computed through
`team_state(team, at_date, cutoff)`, which only reads games with `date < min(at_date, cutoff)`.
Box scores of the game being predicted, and anything later, are structurally unreachable.

Implementation: one row per team-game in date order, with running within-season sums and
exponentially decayed sums (per half-life, cached), so a state is O(features) to compute.

Elo is computed sequentially (pre-game values, FiveThirtyEight-style: home-court term, margin-of-
victory multiplier, one-quarter regression to the mean between seasons), so it is point-in-time too.
"""
from __future__ import annotations

import bisect
import datetime as dt
import math
from collections import defaultdict
from dataclasses import dataclass, field

import numpy as np

from .. import teams as T

# columns of the per-team-game value matrix
COLS = ["n", "win", "margin", "margin_sq", "pts", "opp_pts", "has", "pts_s", "opp_pts_s", "poss", "len",
        "fgm", "fga", "fg3m", "fg3a", "ftm", "fta", "oreb", "dreb", "tov",
        "o_fgm", "o_fga", "o_fg3m", "o_fg3a", "o_ftm", "o_fta", "o_oreb", "o_dreb", "o_tov",
        "perf", "opp_elo", "adj", "adj_n", "close", "close_win", "blowout_loss"]
IX = {c: i for i, c in enumerate(COLS)}
BOX = ["fgm", "fga", "fg3m", "fg3a", "ftm", "fta", "oreb", "dreb", "tov"]
REGRESS_ELO = 0.25
ELO_MEAN = 1505.0


def _day(d: str) -> int:
    return dt.date.fromisoformat(d[:10]).toordinal()


def poss_estimate(own: dict, opp: dict) -> float | None:
    """Possessions: average of both teams' FGA + 0.44·FTA − OREB + TOV."""
    try:
        a = own["fga"] + 0.44 * own["fta"] - own["oreb"] + own["tov"]
        b = opp["fga"] + 0.44 * opp["fta"] - opp["oreb"] + opp["tov"]
    except (TypeError, KeyError):
        return None
    if a is None or b is None:
        return None
    return (a + b) / 2


@dataclass
class TeamSeries:
    dates: list = field(default_factory=list)
    days: list = field(default_factory=list)
    seasons: list = field(default_factory=list)
    game_ids: list = field(default_factory=list)
    opp: list = field(default_factory=list)
    home: list = field(default_factory=list)        # 1 home, 0 away, None neutral
    loc: list = field(default_factory=list)          # venue (lat, lon), elevation, utc offset
    elo_pre: list = field(default_factory=list)
    elo_post: list = field(default_factory=list)
    season_type: list = field(default_factory=list)
    rows: list = field(default_factory=list)
    V: np.ndarray | None = None
    C: np.ndarray | None = None                       # within-season running sums (inclusive)
    season_start: list = field(default_factory=list)  # index of the first game of that row's season
    decayed: dict = field(default_factory=dict)       # half-life -> running decayed sums


@dataclass
class HistoryStore:
    teams: dict = field(default_factory=dict)                         # id -> {name, abbr, nba_id}
    series: dict = field(default_factory=lambda: defaultdict(TeamSeries))
    games: dict = field(default_factory=dict)                         # game_id -> meta dict
    results: dict = field(default_factory=dict)
    league: dict = field(default_factory=dict)                        # season -> (days, cumulative sums)
    elo_k: float = 20.0
    elo_home: float = 100.0

    # ------------------------------------------------------------------ loading
    @classmethod
    def load(cls, conn, elo_k: float = 20.0, elo_home: float = 100.0) -> "HistoryStore":
        h = cls(elo_k=elo_k, elo_home=elo_home)
        for r in conn.execute("SELECT id, name, abbr, external_id FROM teams"):
            h.teams[r["id"]] = {"name": r["name"], "abbr": r["abbr"], "nba_id": T.nba_id(r["external_id"])}
        for r in conn.execute(
                """SELECT g.id, g.event_id, e.date, g.home_team_id, g.away_team_id, g.season, g.season_type,
                          g.neutral_site, g.venue_city, g.tip_time_utc, g.status, g.home_out, g.away_out, g.game_order
                   FROM games g JOIN events e ON e.id=g.event_id ORDER BY e.date, g.id"""):
            m = dict(r)
            m["season"] = m["season"] or T.season_of(m["date"])
            h.games[r["id"]] = m
        for r in conn.execute(
                """SELECT r.* FROM game_results r JOIN (SELECT game_id, MAX(revision) rv FROM game_results
                   GROUP BY game_id) m ON m.game_id=r.game_id AND m.rv=r.revision"""):
            h.results[r["game_id"]] = dict(r)
        stats = defaultdict(dict)
        for s in conn.execute("SELECT * FROM team_game_stats"):
            stats[s["game_id"]][s["team_id"]] = dict(s)
        h._build(stats)
        return h

    def venue(self, m: dict):
        return T.venue({**m, "home_team_id_nba": self.teams.get(m["home_team_id"], {}).get("nba_id")})

    def _build(self, stats: dict) -> None:
        elo: dict = {}
        last_season: dict = {}
        run = defaultdict(lambda: [0.0, 0.0])            # team -> [margin·100 sum over season, poss]
        run_season: dict = {}
        league_rows = defaultdict(list)
        for gid, m in self.games.items():
            res = self.results.get(gid)
            if m["status"] != "completed" or res is None or res["outcome"] != "win":
                continue
            home, away, season = m["home_team_id"], m["away_team_id"], m["season"]
            for t in (home, away):
                if t not in elo:
                    elo[t] = ELO_MEAN
                elif last_season.get(t) != season:
                    elo[t] = (1 - REGRESS_ELO) * elo[t] + REGRESS_ELO * ELO_MEAN
                if run_season.get(t) != season:
                    run[t] = [0.0, 0.0]
                    run_season[t] = season
                last_season[t] = season
            hca = 0.0 if m["neutral_site"] else self.elo_home
            eh, ea = elo[home], elo[away]
            exp_h = 1 / (1 + 10 ** (-(eh + hca - ea) / 400))
            hs, as_ = res["home_score"], res["away_score"]
            mov = hs - as_
            win_h = 1.0 if mov > 0 else 0.0
            diff_w = (eh + hca - ea) if mov > 0 else (ea - eh - hca)
            mult = ((abs(mov) + 3) ** 0.8) / (7.5 + 0.006 * diff_w)
            delta = self.elo_k * mult * (win_h - exp_h)
            st = stats.get(gid, {})
            sh, sa = st.get(home), st.get(away)
            poss = poss_estimate(sh, sa) if sh and sa else None
            length = ((sh or {}).get("minutes") or (240 + 25 * max(0, (res["periods"] or 4) - 4))) / 240.0
            loc = self.venue(m)
            net_pre = {t: (100 * run[t][0] / (run[t][1] + 1000.0)) for t in (home, away)}
            for me, opp, s, my_pts, op_pts, e_me, e_opp, exp, is_home, d in (
                    (home, away, win_h, hs, as_, eh, ea, exp_h, None if m["neutral_site"] else 1, delta),
                    (away, home, 1 - win_h, as_, hs, ea, eh, 1 - exp_h, None if m["neutral_site"] else 0, -delta)):
                own, oth = st.get(me), st.get(opp)
                v = np.zeros(len(COLS))
                mg = my_pts - op_pts
                v[IX["n"]], v[IX["win"]], v[IX["margin"]], v[IX["margin_sq"]] = 1, s, mg, mg * mg
                v[IX["pts"]], v[IX["opp_pts"]] = my_pts, op_pts
                if poss and own and oth and all(own.get(k) is not None and oth.get(k) is not None for k in BOX):
                    v[IX["has"]], v[IX["pts_s"]], v[IX["opp_pts_s"]], v[IX["poss"]] = 1, my_pts, op_pts, poss
                    v[IX["len"]] = length
                    for k in BOX:
                        v[IX[k]], v[IX["o_" + k]] = own[k], oth[k]
                    v[IX["adj"]] = 100 * mg / poss + net_pre[opp]
                    v[IX["adj_n"]] = 1
                v[IX["perf"]], v[IX["opp_elo"]] = s - exp, e_opp
                v[IX["close"]] = float(abs(mg) <= 5)
                v[IX["close_win"]] = float(abs(mg) <= 5 and mg > 0)
                v[IX["blowout_loss"]] = float(mg <= -15)
                ser = self.series[me]
                ser.dates.append(m["date"])
                ser.days.append(_day(m["date"]))
                ser.seasons.append(season)
                ser.game_ids.append(gid)
                ser.opp.append(opp)
                ser.home.append(is_home)
                ser.loc.append(loc)
                ser.elo_pre.append(e_me)
                ser.elo_post.append(e_me + d)
                ser.season_type.append(m["season_type"])
                ser.rows.append(v)
                league_rows[season].append((_day(m["date"]), v))
            for t, sign in ((home, 1), (away, -1)):
                if poss:
                    run[t][0] += sign * mov
                    run[t][1] += poss
            elo[home], elo[away] = eh + delta, ea - delta
        for t, ser in self.series.items():
            ser.V = np.array(ser.rows, dtype=float).reshape(len(ser.rows), len(COLS))
            ser.rows = []
            C = np.zeros_like(ser.V)
            start = 0
            for i in range(len(ser.dates)):
                if i == 0 or ser.seasons[i] != ser.seasons[i - 1]:
                    start = i
                    C[i] = ser.V[i]
                else:
                    C[i] = C[i - 1] + ser.V[i]
                ser.season_start.append(start)
            ser.C = C
        for season, rows in league_rows.items():
            rows.sort(key=lambda x: x[0])
            days = [d for d, _ in rows]
            cum = np.cumsum(np.array([v for _, v in rows]), axis=0)
            self.league[season] = (days, cum)
        self._seasons = sorted(self.league)

    # ------------------------------------------------------------------ queries
    def index_before(self, team: int, date: str) -> int:
        ser = self.series.get(team)
        return 0 if ser is None else bisect.bisect_left(ser.dates, date)

    def n_games_before(self, team: int, date: str) -> int:
        return self.index_before(team, date)

    def decayed(self, team: int, half_life: float) -> np.ndarray:
        ser = self.series[team]
        D = ser.decayed.get(half_life)
        if D is None:
            lam = math.log(2) / max(half_life, 1.0)
            D = np.zeros_like(ser.V)
            for i in range(len(ser.days)):
                D[i] = ser.V[i] if i == 0 else D[i - 1] * math.exp(-lam * (ser.days[i] - ser.days[i - 1])) + ser.V[i]
            ser.decayed[half_life] = D
        return D

    def league_sums(self, season: str, limit: str) -> np.ndarray:
        """League totals (all team-games) for `season` strictly before `limit`, topped up with the previous
        season when the current one is young (fewer than 200 team-games)."""
        cur = np.zeros(len(COLS))
        if season in self.league:
            days, cum = self.league[season]
            i = bisect.bisect_left(days, _day(limit))
            if i:
                cur = cum[i - 1].copy()
        if cur[IX["n"]] >= 200:
            return cur
        prev = self.prev_season(season)
        if prev and prev in self.league:
            days, cum = self.league[prev]
            i = bisect.bisect_left(days, _day(limit))
            if i:
                p = cum[i - 1]
                if p[IX["n"]] > 0:
                    need = 200 - cur[IX["n"]]
                    cur = cur + p * (need / p[IX["n"]])
        return cur

    def prev_season(self, season: str) -> str | None:
        ss = getattr(self, "_seasons", [])
        i = bisect.bisect_left(ss, season)
        return ss[i - 1] if i > 0 else None

    def elo_before(self, team: int, date: str, season: str | None = None) -> float:
        k = self.index_before(team, date)
        if k == 0:
            return ELO_MEAN
        ser = self.series[team]
        e = ser.elo_post[k - 1]
        if season and ser.seasons[k - 1] != season:
            e = (1 - REGRESS_ELO) * e + REGRESS_ELO * ELO_MEAN
        return e


# ---------------------------------------------------------------------- derived rates
def rates(s: np.ndarray) -> dict:
    """Team ratings from summed values. Missing denominators give None (unknown, not zero)."""
    g = lambda k: s[IX[k]]
    out = {}
    n, has, poss = g("n"), g("has"), g("poss")
    out["games"] = n
    out["games_box"] = has
    out["win_pct"] = g("win") / n if n else None
    out["margin_pg"] = g("margin") / n if n else None
    out["margin_sd"] = math.sqrt(max(g("margin_sq") / n - (g("margin") / n) ** 2, 0)) if n >= 2 else None
    out["ppg"] = g("pts") / n if n else None
    out["opp_ppg"] = g("opp_pts") / n if n else None
    if poss > 0:
        out["ortg"] = 100 * g("pts_s") / poss
        out["drtg"] = 100 * g("opp_pts_s") / poss
        out["net"] = out["ortg"] - out["drtg"]
        out["pace"] = poss / g("len") if g("len") else poss / has
    else:
        out["ortg"] = out["drtg"] = out["net"] = out["pace"] = None

    def div(a, b):
        return a / b if b > 0 else None
    out["efg"] = div(g("fgm") + 0.5 * g("fg3m"), g("fga"))
    out["opp_efg"] = div(g("o_fgm") + 0.5 * g("o_fg3m"), g("o_fga"))
    out["tov_pct"] = div(g("tov"), g("fga") + 0.44 * g("fta") + g("tov"))
    out["opp_tov_pct"] = div(g("o_tov"), g("o_fga") + 0.44 * g("o_fta") + g("o_tov"))
    out["oreb_pct"] = div(g("oreb"), g("oreb") + g("o_dreb"))
    out["dreb_pct"] = div(g("dreb"), g("dreb") + g("o_oreb"))
    out["ftr"] = div(g("ftm"), g("fga"))
    out["opp_ftr"] = div(g("o_ftm"), g("o_fga"))
    out["fg3a_rate"] = div(g("fg3a"), g("fga"))
    out["opp_fg3a_rate"] = div(g("o_fg3a"), g("o_fga"))
    out["fg3_pct"] = div(g("fg3m"), g("fg3a"))
    out["opp_fg3_pct"] = div(g("o_fg3m"), g("o_fg3a"))
    out["adj_net"] = div(g("adj"), g("adj_n"))
    out["close_games"] = g("close")
    out["close_win"] = div(g("close_win"), g("close"))
    out["blowout_loss"] = g("blowout_loss") / n if n else None
    return out


RATE_KEYS = ["ortg", "drtg", "net", "pace", "efg", "opp_efg", "tov_pct", "opp_tov_pct", "oreb_pct", "dreb_pct", "ftr",
             "opp_ftr", "fg3a_rate", "opp_fg3a_rate", "fg3_pct", "opp_fg3_pct", "adj_net"]
LEAGUE_DEFAULT = {"ortg": 110.0, "drtg": 110.0, "net": 0.0, "pace": 98.0, "efg": 0.52, "opp_efg": 0.52,
                  "tov_pct": 0.13, "opp_tov_pct": 0.13, "oreb_pct": 0.25, "dreb_pct": 0.75, "ftr": 0.20,
                  "opp_ftr": 0.20, "fg3a_rate": 0.35, "opp_fg3a_rate": 0.35, "fg3_pct": 0.36, "opp_fg3_pct": 0.36,
                  "adj_net": 0.0, "ppg": 108.0, "win_pct": 0.5, "margin_sd": 13.0, "blowout_loss": 0.12,
                  "close_win": 0.5}


def league_rates(h: HistoryStore, season: str, limit: str) -> dict:
    s = h.league_sums(season, limit)
    r = rates(s)
    out = {}
    for k, v in LEAGUE_DEFAULT.items():
        out[k] = v if r.get(k) is None or s[IX["n"]] < 50 else r[k]
    out["net"], out["adj_net"], out["win_pct"], out["close_win"] = 0.0, 0.0, 0.5, 0.5   # zero-sum by construction
    out["drtg"] = out["ortg"]
    out["opp_efg"], out["opp_tov_pct"], out["opp_ftr"] = out["efg"], out["tov_pct"], out["ftr"]
    out["opp_fg3a_rate"], out["opp_fg3_pct"] = out["fg3a_rate"], out["fg3_pct"]
    out["dreb_pct"] = 1 - out["oreb_pct"]
    out["total"] = 2 * out["ppg"]
    out["team_games"] = s[IX["n"]]
    out["margin_sd"] = 13.0 if s[IX["n"]] < 50 else math.sqrt(max(s[IX["margin_sq"]] / s[IX["n"]], 1.0))
    return out


def _shrink(raw, n, prior, k):
    if raw is None:
        return prior
    return (n * raw + k * prior) / (n + k)


def team_state(h: HistoryStore, team: int, at_date: str, cutoff: str | None = None, *, season: str | None = None,
               half_life_days: float = 30.0, prior_games: float = 12.0, carryover: float = 0.67,
               game: dict | None = None) -> dict:
    """Everything known about a team strictly before min(at_date, cutoff)."""
    limit = min(at_date, cutoff) if cutoff else at_date
    season = season or T.season_of(at_date)
    info = h.teams.get(team, {})
    st: dict = {"team_id": team, "as_of": limit, "name": info.get("name"), "abbr": info.get("abbr"), "season": season}
    ser = h.series.get(team)
    k = h.index_before(team, limit)
    lg = league_rates(h, season, limit)
    st["league"] = {x: round(v, 4) for x, v in lg.items()}
    zero = np.zeros(len(COLS))
    cur = prev = zero
    prev_label = None
    cur_start = k
    if k:
        last = k - 1
        if ser.seasons[last] == season:
            cur = ser.C[last]
            cur_start = ser.season_start[last]
            p = cur_start - 1
        else:
            p = last
        if p >= 0:
            prev = ser.C[p]
            prev_label = ser.seasons[p]
    rc, rp = rates(cur), rates(prev)
    lgp = league_rates(h, prev_label, "9999-12-31") if prev_label else lg
    n_cur, n_box = rc["games"], rc["games_box"]
    st["n_games"] = k
    st["season_games"] = int(n_cur)
    st["season_box_games"] = int(n_box)
    st["prev_season"] = prev_label
    st["prev_season_games"] = int(rp["games"])
    st["wins"] = int(cur[IX["win"]])
    st["losses"] = int(n_cur - cur[IX["win"]])
    st["debut"] = k == 0
    priors = {}
    for key in RATE_KEYS + ["win_pct", "margin_sd", "blowout_loss", "close_win"]:
        pv = rp.get(key)
        base = lg[key]
        if pv is not None and rp["games"] >= 10:
            prior = base + carryover * (pv - lgp[key]) if key not in ("margin_sd",) else base + 0.5 * (pv - lgp[key])
        else:
            prior = base
        priors[key] = prior
        n = n_box if key in RATE_KEYS else n_cur
        kk = prior_games if key != "close_win" else 6.0
        if key == "close_win":
            raw, n = rc["close_win"], rc["close_games"]
        else:
            raw = rc.get(key)
        st[key] = _shrink(raw, n, prior, kk)
        st["raw_" + key] = raw
    st["priors"] = {x: round(v, 4) for x, v in priors.items()}
    # --- Elo
    st["elo"] = h.elo_before(team, limit, season)
    # --- recent form (time-decayed across seasons; the off-season gap decays itself)
    if k:
        D = h.decayed(team, half_life_days)
        lam = math.log(2) / max(half_life_days, 1.0)
        d = D[k - 1] * math.exp(-lam * (dt.date.fromisoformat(limit).toordinal() - ser.days[k - 1]))
    else:
        d = zero
    rd = rates(d)
    W, Wb = d[IX["n"]], d[IX["has"]]
    kf = 4.0
    st["d_net"] = _shrink(rd["net"], Wb, priors["net"], kf)
    st["d_ortg"] = _shrink(rd["ortg"], Wb, priors["ortg"], kf)
    st["d_drtg"] = _shrink(rd["drtg"], Wb, priors["drtg"], kf)
    st["d_win"] = (d[IX["win"]] + 2 * 0.5) / (W + 2)
    st["d_perf"] = d[IX["perf"]] / (W + 2)
    st["d_opp_elo"] = (d[IX["opp_elo"]] + ELO_MEAN * 2) / (W + 2)
    st["effective_games"] = W
    # --- streak and last ten (this season only)
    seq = [ser.V[i, IX["win"]] for i in range(cur_start, k)] if k else []
    streak = 0
    for x in reversed(seq):
        if x == 1 and streak >= 0:
            streak += 1
        elif x == 0 and streak <= 0:
            streak -= 1
        else:
            break
    st["streak"] = max(min(streak, 8), -8)
    last10 = seq[-10:]
    st["last10"] = f"{int(sum(last10))}-{len(last10) - int(sum(last10))}" if last10 else None
    st["last10_win"] = (sum(last10) + 1) / (len(last10) + 2)
    st["last5"] = [{"date": ser.dates[i], "game_id": ser.game_ids[i], "opp_id": ser.opp[i],
                    "result": float(ser.V[i, IX["win"]]), "margin": int(ser.V[i, IX["margin"]]),
                    "home": ser.home[i], "opp_elo": round(ser.V[i, IX["opp_elo"]], 1)}
                   for i in range(max(0, k - 5), k)] if k else []
    st["last_game_date"] = ser.dates[k - 1] if k else None
    # --- schedule context
    day = dt.date.fromisoformat(at_date).toordinal()
    if k:
        gap = day - ser.days[k - 1]
        st["days_rest"] = gap - 1 if gap <= 30 else None        # season opener: rest is not meaningful
        st["games_last_4"] = sum(1 for i in range(max(0, k - 4), k) if day - ser.days[i] <= 3)
        st["games_last_7"] = sum(1 for i in range(max(0, k - 6), k) if day - ser.days[i] <= 6)
    else:
        st["days_rest"], st["games_last_4"], st["games_last_7"] = None, 0, 0
    st["b2b"] = None if st["days_rest"] is None else float(st["days_rest"] == 0)
    st["three_in_four"] = float(st["games_last_4"] >= 2)
    loc_now = h.venue(game) if game else None
    prev_loc = ser.loc[k - 1] if k else None
    st["travel_km"] = (T.km(prev_loc[0], loc_now[0]) if (prev_loc and loc_now and st["days_rest"] is not None)
                       else None)
    st["tz_shift"] = (abs(loc_now[2] - prev_loc[2]) if (prev_loc and loc_now and st["days_rest"] is not None)
                      else None)
    st["venue_elevation"] = loc_now[1] if loc_now else None
    is_home_now = None
    if game:
        is_home_now = None if game.get("neutral_site") else int(game["home_team_id"] == team)
    st["is_home"] = is_home_now
    trip = 0
    if is_home_now == 0:
        trip = 1
        for i in range(k - 1, cur_start - 1, -1):
            if ser.home[i] == 0:
                trip += 1
            else:
                break
    st["road_trip"] = trip
    st["early_season"] = float(n_cur < 10)
    st["missing"] = [x for x in ("ortg", "efg", "tov_pct") if st["raw_" + x] is None and n_cur > 0]
    st["box_coverage"] = n_box / n_cur if n_cur else None
    return st
