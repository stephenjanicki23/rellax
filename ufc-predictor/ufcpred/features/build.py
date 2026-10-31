"""Turn point-in-time fighter states into model matrices."""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from ..config import ModelConfig
from ..providers.odds import devig
from .catalog import METHOD_CLASSES, METHOD_FEATURES, features_for, value
from .history import HistoryStore, class_index, fighter_state


def fight_context(meta: dict) -> dict:
    return {"five_round": int(meta.get("scheduled_rounds") == 5), "women": int(bool(meta.get("is_women"))),
            "class_idx": class_index(meta.get("weight_class")), "title": int(bool(meta.get("is_title"))),
            "scheduled_rounds": meta.get("scheduled_rounds") or 3}


class StateCache:
    def __init__(self, h: HistoryStore):
        self.h = h
        self.cache: dict = {}

    def get(self, fighter_id, at_date, cutoff, cfg: ModelConfig, wc):
        key = (fighter_id, at_date, cutoff, cfg.half_life_days, cfg.prior_minutes, wc)
        st = self.cache.get(key)
        if st is None:
            st = fighter_state(self.h, fighter_id, at_date, cutoff, half_life_days=cfg.half_life_days,
                               prior_minutes=cfg.prior_minutes, bout_weight_class=wc)
            self.cache[key] = st
        return st


def pair_states(cache: StateCache, meta: dict, cfg: ModelConfig, cutoff: str | None = None,
                odds: dict | None = None) -> tuple[dict, dict, dict]:
    date = meta["date"]
    a = dict(cache.get(meta["red_fighter_id"], date, cutoff, cfg, meta.get("weight_class")))
    b = dict(cache.get(meta["blue_fighter_id"], date, cutoff, cfg, meta.get("weight_class")))
    for st, side in ((a, "red"), (b, "blue")):
        sn, wm = meta.get(f"short_notice_{side}"), meta.get(f"weight_miss_{side}")
        st["short_notice"] = None if sn is None else float(sn)
        st["weight_miss"] = None if wm is None else float(wm)
        st["market_p"] = None
    if odds:
        pr, pb, _ = devig(odds["red_decimal"], odds["blue_decimal"])
        a["market_p"], b["market_p"] = pr, pb
    return a, b, fight_context(meta)


@dataclass
class Dataset:
    fight_ids: list = field(default_factory=list)
    event_ids: list = field(default_factory=list)
    dates: list = field(default_factory=list)
    y: np.ndarray | None = None              # 1 if red won
    pairs: list = field(default_factory=list)  # (state_red, state_blue, ctx)
    X: dict = field(default_factory=dict)    # group -> (n, d) array with NaN for unknown
    names: dict = field(default_factory=dict)
    method: list = field(default_factory=list)   # actual method class or None
    end_round: list = field(default_factory=list)

    def subset(self, idx) -> "Dataset":
        idx = list(idx)
        d = Dataset([self.fight_ids[i] for i in idx], [self.event_ids[i] for i in idx], [self.dates[i] for i in idx],
                    None if self.y is None else self.y[idx], [self.pairs[i] for i in idx],
                    {g: m[idx] for g, m in self.X.items()}, self.names,
                    [self.method[i] for i in idx], [self.end_round[i] for i in idx])
        return d

    def __len__(self):
        return len(self.fight_ids)


def method_class(m: str | None) -> str | None:
    if m in ("KO_TKO", "SUB", "DEC"):
        return m
    if m in ("DQ", "OTHER"):
        return "DQ_OTHER"
    return None


def groups_for(cfg: ModelConfig) -> list[str]:
    return list(cfg.submodels) + (["F_market"] if cfg.use_market else [])


def build_rows(cache: StateCache, metas: list[dict], cfg: ModelConfig, cutoff_fn=None, odds_by_fight=None,
               labels: dict | None = None) -> Dataset:
    """Feature rows for the given fights. cutoff_fn(meta) -> cutoff date (exclusive) or None (= fight date)."""
    ds = Dataset()
    groups = groups_for(cfg)
    cols = {g: [] for g in groups}
    for g in groups:
        ds.names[g] = [f.name for f in features_for(g, cfg.style_v2, cfg.strike_location)]
    ys, methods, rounds = [], [], []
    for m in metas:
        cutoff = cutoff_fn(m) if cutoff_fn else None
        a, b, ctx = pair_states(cache, m, cfg, cutoff, (odds_by_fight or {}).get(m["id"]))
        ds.fight_ids.append(m["id"])
        ds.event_ids.append(m["event_id"])
        ds.dates.append(m["date"])
        ds.pairs.append((a, b, ctx))
        for g in groups:
            cols[g].append([np.nan if (v := value(f, a, b, ctx)) is None else v for f in features_for(g, cfg.style_v2, cfg.strike_location)])
        if labels is not None:
            lab = labels.get(m["id"], {})
            ys.append(lab.get("red_won", np.nan))
            methods.append(method_class(lab.get("method")))
            rounds.append(lab.get("end_round"))
        else:
            methods.append(None)
            rounds.append(None)
    for g in groups:
        ds.X[g] = np.array(cols[g], dtype=float).reshape(len(metas), len(ds.names[g]))
    ds.y = np.array(ys, dtype=float) if labels is not None else None
    ds.method, ds.end_round = methods, rounds
    return ds


def training_metas(h: HistoryStore, cfg: ModelConfig, cutoff: str, start: str | None = None) -> tuple[list, dict]:
    """Completed decisive standard-format fights with date in [train_start, cutoff)."""
    start = start or cfg.train_start
    metas, labels = [], {}
    for fid, m in h.fights.items():
        if not (start <= m["date"] < cutoff):
            continue
        if m["status"] != "completed" or m.get("scheduled_rounds") not in (3, 5):
            continue
        res = h.results.get(fid)
        if not res or res["outcome"] != "win":
            continue
        metas.append(m)
        labels[fid] = {"red_won": float(res["winner_fighter_id"] == m["red_fighter_id"]), "method": res["method"],
                       "end_round": res["end_round"]}
    metas.sort(key=lambda m: (m["date"], m["id"]))
    return metas, labels


def method_matrix(pairs: list, winners_red: list[bool]) -> np.ndarray:
    rows = []
    for (a, b, ctx), red in zip(pairs, winners_red):
        w, l = (a, b) if red else (b, a)
        rows.append([fn(w, l, ctx) for _, fn in METHOD_FEATURES])
    return np.array(rows, dtype=float).reshape(len(pairs), len(METHOD_FEATURES))


__all__ = ["Dataset", "StateCache", "build_rows", "training_metas", "pair_states", "method_matrix", "METHOD_CLASSES",
           "method_class", "groups_for", "fight_context"]
