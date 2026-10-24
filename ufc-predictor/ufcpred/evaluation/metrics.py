"""Evaluation metrics with sample sizes and uncertainty intervals.

Calibration binning (documented, used everywhere): predictions are expressed as the
probability assigned to the *predicted winner* (0.5–1.0) and grouped into five equal-width
bins [0.5,0.6), [0.6,0.7), [0.7,0.8), [0.8,0.9), [0.9,1.0]. ECE is the sample-weighted
mean |accuracy − mean confidence| across non-empty bins. A full-range ten-bin reliability
table over P(red) is also provided.
"""
from __future__ import annotations

import math

import numpy as np

BINS = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0000001]


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (float("nan"), float("nan"))
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (c - m, c + m)


def log_loss(p: np.ndarray, y: np.ndarray) -> np.ndarray:
    p = np.clip(p, 1e-12, 1 - 1e-12)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def brier(p: np.ndarray, y: np.ndarray) -> np.ndarray:
    return (p - y) ** 2


def calibration_table(p: np.ndarray, y: np.ndarray) -> list[dict]:
    conf = np.maximum(p, 1 - p)
    correct = ((p >= 0.5) == (y == 1)).astype(float)
    out = []
    for lo, hi in zip(BINS[:-1], BINS[1:]):
        m = (conf >= lo) & (conf < hi)
        n = int(m.sum())
        k = int(correct[m].sum())
        lo_ci, hi_ci = wilson(k, n)
        out.append({"bin": f"{lo:.1f}–{min(hi, 1):.1f}", "lo": lo, "hi": min(hi, 1.0), "n": n,
                    "mean_conf": float(conf[m].mean()) if n else None, "accuracy": k / n if n else None,
                    "ci_low": lo_ci if n else None, "ci_high": hi_ci if n else None})
    return out


def ece(p: np.ndarray, y: np.ndarray) -> float:
    tab = calibration_table(p, y)
    n = sum(t["n"] for t in tab)
    if n == 0:
        return float("nan")
    return float(sum(t["n"] * abs(t["accuracy"] - t["mean_conf"]) for t in tab if t["n"]) / n)


def reliability_full(p: np.ndarray, y: np.ndarray, bins: int = 10) -> list[dict]:
    out = []
    edges = np.linspace(0, 1, bins + 1)
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (p >= lo) & (p < hi if hi < 1 else p <= hi)
        n = int(m.sum())
        out.append({"lo": float(lo), "hi": float(hi), "n": n, "mean_p": float(p[m].mean()) if n else None,
                    "freq": float(y[m].mean()) if n else None})
    return out


def bootstrap_ci(values: np.ndarray, clusters: np.ndarray | None = None, B: int = 1000, seed: int = 7,
                 stat=np.mean, alpha: float = 0.05) -> tuple[float, float]:
    """Percentile bootstrap, resampling whole events when clusters are given."""
    if len(values) == 0:
        return (float("nan"), float("nan"))
    rng = np.random.default_rng(seed)
    if clusters is None:
        idx = rng.integers(0, len(values), size=(B, len(values)))
        stats = np.array([stat(values[i]) for i in idx])
    else:
        uniq = np.unique(clusters)
        groups = [np.where(clusters == u)[0] for u in uniq]
        stats = np.empty(B)
        for bi in range(B):
            pick = rng.integers(0, len(groups), size=len(groups))
            stats[bi] = stat(values[np.concatenate([groups[j] for j in pick])])
    return (float(np.quantile(stats, alpha / 2)), float(np.quantile(stats, 1 - alpha / 2)))


def summarize(p: np.ndarray, y: np.ndarray, clusters: np.ndarray | None = None, B: int = 500) -> dict:
    p, y = np.asarray(p, float), np.asarray(y, float)
    n = len(p)
    if n == 0:
        return {"n": 0}
    correct = ((p >= 0.5) == (y == 1)).astype(float)
    k = int(correct.sum())
    ll = log_loss(p, y)
    br = brier(p, y)
    return {
        "n": n, "accuracy": k / n, "accuracy_ci": wilson(k, n),
        "log_loss": float(ll.mean()), "log_loss_ci": bootstrap_ci(ll, clusters, B),
        "brier": float(br.mean()), "brier_ci": bootstrap_ci(br, clusters, B),
        "ece": ece(p, y), "calibration": calibration_table(p, y),
    }


def baselines(y: np.ndarray, base_rate_p: np.ndarray | None = None) -> dict:
    """50/50 and historical base-rate baselines on the same outcomes."""
    y = np.asarray(y, float)
    out = {"coin_flip": {"log_loss": math.log(2), "brier": 0.25, "accuracy": 0.5}}
    if base_rate_p is not None and len(base_rate_p):
        out["base_rate"] = {"log_loss": float(log_loss(base_rate_p, y).mean()),
                            "brier": float(brier(base_rate_p, y).mean()),
                            "accuracy": float(np.mean((base_rate_p >= 0.5) == (y == 1)))}
    return out


def paired_comparison(ll_inc: np.ndarray, ll_cand: np.ndarray, clusters: np.ndarray, B: int = 1000,
                      seed: int = 11) -> dict:
    """Δ = incumbent log loss − candidate log loss (positive favours the candidate), event-clustered."""
    d = np.asarray(ll_inc) - np.asarray(ll_cand)
    rng = np.random.default_rng(seed)
    uniq = np.unique(clusters)
    groups = [np.where(clusters == u)[0] for u in uniq]
    sums = np.array([d[g].sum() for g in groups])
    sizes = np.array([len(g) for g in groups])
    boots = np.empty(B)
    for bi in range(B):
        pick = rng.integers(0, len(groups), size=len(groups))
        boots[bi] = sums[pick].sum() / sizes[pick].sum()
    total = d.sum()
    share = float(sums.max() / total) if total > 0 else float("nan")
    loo = [(total - s) / (d.size - sz) for s, sz in zip(sums, sizes)] if len(groups) > 1 else [float("nan")]
    return {"mean_delta": float(d.mean()), "p_candidate_better": float(np.mean(boots > 0)),
            "ci": (float(np.quantile(boots, 0.05)), float(np.quantile(boots, 0.95))),
            "n": int(d.size), "n_events": int(len(groups)), "max_single_event_share": share,
            "min_leave_one_event_out_delta": float(min(loo))}


def multiclass_log_loss(P: np.ndarray, y_idx: np.ndarray) -> float:
    P = np.clip(P, 1e-12, 1)
    return float(-np.mean(np.log(P[np.arange(len(y_idx)), y_idx])))


def multiclass_brier(P: np.ndarray, y_idx: np.ndarray) -> float:
    Y = np.zeros_like(P)
    Y[np.arange(len(y_idx)), y_idx] = 1
    return float(np.mean(np.sum((P - Y) ** 2, axis=1)))
