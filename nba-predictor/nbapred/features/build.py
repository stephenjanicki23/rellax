"""Turn point-in-time team states into model matrices."""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from ..config import ModelConfig
from ..providers.odds import devig
from .catalog import TOTAL_FEATURES, features_for, value
from .history import HistoryStore, team_state

BUCKETS = ["CLOSE", "SOLID", "BLOWOUT"]          # winning margin 1–5, 6–12, 13+
BUCKET_EDGES = [0.0, 5.5, 12.5, float("inf")]


def bucket_of(margin_abs: int | float | None) -> str | None:
    if margin_abs is None:
        return None
    for name, lo, hi in zip(BUCKETS, BUCKET_EDGES[:-1], BUCKET_EDGES[1:]):
        if lo < margin_abs <= hi:
            return name
    return None


def game_context(meta: dict) -> dict:
    return {"playoffs": int(meta.get("season_type") in ("playoffs", "playin")), "neutral": int(bool(meta.get("neutral_site"))),
            "season_type": meta.get("season_type")}


class StateCache:
    def __init__(self, h: HistoryStore):
        self.h = h
        self.cache: dict = {}

    def get(self, team, meta, cutoff, cfg: ModelConfig):
        key = (team, meta["id"], meta["date"], cutoff, cfg.half_life_days, cfg.prior_games, cfg.carryover)
        st = self.cache.get(key)
        if st is None:
            st = team_state(self.h, team, meta["date"], cutoff, season=meta.get("season"),
                            half_life_days=cfg.half_life_days, prior_games=cfg.prior_games, carryover=cfg.carryover,
                            game=meta)
            self.cache[key] = st
        return st


def pair_states(cache: StateCache, meta: dict, cfg: ModelConfig, cutoff: str | None = None,
                odds: dict | None = None) -> tuple[dict, dict, dict]:
    a = dict(cache.get(meta["home_team_id"], meta, cutoff, cfg))
    b = dict(cache.get(meta["away_team_id"], meta, cutoff, cfg))
    a["out"], b["out"] = meta.get("home_out"), meta.get("away_out")
    a["market_p"] = b["market_p"] = None
    if odds and odds.get("home_decimal") and odds.get("away_decimal"):
        ph, pa, _ = devig(odds["home_decimal"], odds["away_decimal"])
        a["market_p"], b["market_p"] = ph, pa
    return a, b, game_context(meta)


@dataclass
class Dataset:
    game_ids: list = field(default_factory=list)
    event_ids: list = field(default_factory=list)
    dates: list = field(default_factory=list)
    y: np.ndarray | None = None                 # 1 if the home team won
    pairs: list = field(default_factory=list)   # (state_home, state_away, ctx)
    X: dict = field(default_factory=dict)       # group -> (n, d) with NaN for unknown
    names: dict = field(default_factory=dict)
    XT: np.ndarray | None = None                # total-points features
    margin: np.ndarray | None = None            # home − away (actual)
    total: np.ndarray | None = None
    league_total: np.ndarray | None = None
    periods: list = field(default_factory=list)

    def __len__(self):
        return len(self.game_ids)


def groups_for(cfg: ModelConfig) -> list[str]:
    return list(cfg.submodels) + (["F_market"] if cfg.use_market else [])


def build_rows(cache: StateCache, metas: list[dict], cfg: ModelConfig, cutoff_fn=None, odds_by_game=None,
               labels: dict | None = None) -> Dataset:
    """Feature rows for the given games. cutoff_fn(meta) -> cutoff date (exclusive) or None (= game date)."""
    ds = Dataset()
    groups = groups_for(cfg)
    feats = {g: features_for(g, cfg.style_v2, cfg.opp_adjusted) for g in groups}
    cols = {g: [] for g in groups}
    for g in groups:
        ds.names[g] = [f.name for f in feats[g]]
    tcols, ys, margins, totals, lgt = [], [], [], [], []
    for m in metas:
        cutoff = cutoff_fn(m) if cutoff_fn else None
        a, b, ctx = pair_states(cache, m, cfg, cutoff, (odds_by_game or {}).get(m["id"]))
        ds.game_ids.append(m["id"])
        ds.event_ids.append(m["event_id"])
        ds.dates.append(m["date"])
        ds.pairs.append((a, b, ctx))
        for g in groups:
            cols[g].append([np.nan if (v := value(f, a, b, ctx)) is None else v for f in feats[g]])
        tcols.append([np.nan if (v := fn(a, b, ctx)) is None else v for _, fn, _ in TOTAL_FEATURES])
        lgt.append(a["league"]["total"])
        if labels is not None:
            lab = labels.get(m["id"], {})
            ys.append(lab.get("home_won", np.nan))
            margins.append(lab.get("margin", np.nan))
            totals.append(lab.get("total", np.nan))
            ds.periods.append(lab.get("periods"))
    n = len(metas)
    for g in groups:
        ds.X[g] = np.array(cols[g], dtype=float).reshape(n, len(ds.names[g]))
    ds.XT = np.array(tcols, dtype=float).reshape(n, len(TOTAL_FEATURES))
    ds.league_total = np.array(lgt, dtype=float)
    if labels is not None:
        ds.y, ds.margin, ds.total = (np.array(x, dtype=float) for x in (ys, margins, totals))
    return ds


def training_metas(h: HistoryStore, cfg: ModelConfig, cutoff: str, start: str | None = None) -> tuple[list, dict]:
    """Completed, decided games with date in [start, cutoff). Default start: the training window."""
    if start is None:
        import datetime as dt
        win = (dt.date.fromisoformat(cutoff) - dt.timedelta(days=cfg.train_window_days)).isoformat()
        start = max(cfg.train_start, win)
    metas, labels = [], {}
    for gid, m in h.games.items():
        if not (start <= m["date"] < cutoff) or m["status"] != "completed":
            continue
        if m.get("season_type") not in ("regular", "playoffs", "playin", "cup_final"):
            continue
        res = h.results.get(gid)
        if not res or res["outcome"] != "win":
            continue
        metas.append(m)
        mg = res["home_score"] - res["away_score"]
        labels[gid] = {"home_won": float(mg > 0), "margin": float(mg), "total": float(res["home_score"] + res["away_score"]),
                       "periods": res["periods"]}
    metas.sort(key=lambda m: (m["date"], m["id"]))
    return metas, labels


__all__ = ["Dataset", "StateCache", "build_rows", "training_metas", "pair_states", "groups_for", "game_context",
           "BUCKETS", "bucket_of"]
