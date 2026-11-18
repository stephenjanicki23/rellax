"""Rolling-origin (expanding window) backtesting.

For each fold, the configuration is fitted from scratch on games strictly before the fold's first
night — standardisation, imputation, stacking, calibration, margin and total models included — and
then predicts the fold. Team states inside a fold use every game before the night being predicted
(exactly what a live night would see); the *model* is frozen at the fold start.
"""
from __future__ import annotations

import numpy as np

from ..config import ModelConfig
from ..features.build import StateCache, bucket_of, training_metas
from ..models import engine
from ..util import dumps, sha256, utcnow
from . import metrics as M


def event_folds(h, start: str, end: str, events_per_fold: int) -> list[tuple[str, str, list]]:
    """Group completed game nights in [start, end) into chronological folds."""
    ev_dates = {}
    for gid, m in h.games.items():
        if start <= m["date"] < end and m["status"] == "completed":
            ev_dates.setdefault(m["event_id"], m["date"])
    evs = sorted(ev_dates.items(), key=lambda kv: (kv[1], kv[0]))
    folds = []
    for i in range(0, len(evs), events_per_fold):
        chunk = evs[i:i + events_per_fold]
        folds.append((chunk[0][1], chunk[-1][1], [e for e, _ in chunk]))
    return folds


def _next_day(d: str) -> str:
    import datetime as dt
    return (dt.date.fromisoformat(d) + dt.timedelta(days=1)).isoformat()


def run_backtest(h, cfg: ModelConfig, start: str, end: str, events_per_fold: int = 25,
                 cache: StateCache | None = None, conn=None, label: str = "backtest") -> dict:
    cache = cache or StateCache(h)
    folds = event_folds(h, start, end, events_per_fold)
    rows, fold_meta, audits = [], [], []
    for k, (f_start, f_end, ev_ids) in enumerate(folds):
        params = engine.fit(h, cfg, f_start, cache)
        evset = set(ev_ids)
        metas, labels = training_metas(h, cfg, cutoff=_next_day(f_end), start=f_start)
        metas = [m for m in metas if m["event_id"] in evset]
        if not metas:
            continue
        preds, ds = engine.predict_metas(params, h, metas, "9999-12-31", cache)
        aud = engine.leakage_audit(params, ds, "9999-12-31")      # states: strictly before each game's date
        if params["cutoff"] > f_start or params["max_train_date"] >= f_start:   # model: strictly before the fold
            aud = {**aud, "passed": False, "problems": aud["problems"] + [f"fold {k} model saw data after {f_start}"]}
        audits.append(aud)
        home_rate = params["diagnostics"]["calibration_slice"]["home_win_rate"]
        hca = cfg.elo_home
        for m, p, (a, b, ctx) in zip(metas, preds, ds.pairs):
            lab = labels[m["id"]]
            side = "home" if lab["home_won"] else "away"
            band = bucket_of(abs(lab["margin"]))
            rows.append({"game_id": m["id"], "event_id": m["event_id"], "date": m["date"], "fold": k,
                         "train_cutoff": f_start, "p_home": p["p_home"], "home_won": int(lab["home_won"]),
                         "pred_margin": p["margin"]["mu"], "sigma": p["margin"]["sigma"], "pred_total": p["total"]["mu"],
                         "total_sd": p["total"]["sd"], "actual_margin": int(lab["margin"]),
                         "actual_total": int(lab["total"]), "p_band_joint": p["margin"]["bands"][side].get(band),
                         "p_elo": 1 / (1 + 10 ** (-(a["elo"] + (0 if ctx["neutral"] else hca) - b["elo"]) / 400)),
                         "p_base": 0.5 if ctx["neutral"] else home_rate})
        fold_meta.append({"fold": k, "cutoff": f_start, "end": f_end, "events": len(ev_ids), "games": len(metas),
                          "n_train": params["diagnostics"]["n_train"]})
    summary = {"n": 0}
    if rows:
        arr = bt_arrays({"rows": rows})
        y, p = arr["y"], arr["p"]
        summary = M.summarize(p, y, arr["event"])
        summary["baselines"] = M.baselines(y, arr["p_base"])
        summary["baselines"]["elo_only"] = {"log_loss": float(M.log_loss(arr["p_elo"], y).mean()),
                                            "brier": float(M.brier(arr["p_elo"], y).mean()),
                                            "accuracy": float(np.mean((arr["p_elo"] >= .5) == (y == 1)))}
        pj = arr["p_joint"][~np.isnan(arr["p_joint"])]
        summary["bucket_log_loss"] = float(-np.mean(np.log(np.clip(pj, 1e-12, 1)))) if len(pj) else None
        summary["margin_mae"] = float(np.mean(np.abs(arr["margin"] - arr["pred_margin"])))
        summary["total_mae"] = float(np.mean(np.abs(arr["total"] - arr["pred_total"])))
        summary["total_bias"] = float(np.mean(arr["total"] - arr["pred_total"]))
    audit = {"passed": all(a["passed"] for a in audits), "folds": len(audits),
             "problems": [x for a in audits for x in a["problems"]][:20]}
    result = {"label": label, "config": cfg.to_dict(), "start": start, "end": end, "folds": fold_meta,
              "rows": rows, "metrics": summary, "leakage_audit": audit}
    if conn is not None:
        result["id"] = store_backtest(conn, result)
    return result


def bt_arrays(bt: dict) -> dict:
    r = bt["rows"]
    f = lambda k: np.array([x[k] for x in r], dtype=float)
    return {"game_id": np.array([x["game_id"] for x in r]), "event": np.array([x["event_id"] for x in r]),
            "p": f("p_home"), "y": f("home_won"), "p_elo": f("p_elo"), "p_base": f("p_base"),
            "p_joint": np.array([np.nan if x["p_band_joint"] is None else x["p_band_joint"] for x in r]),
            "pred_margin": f("pred_margin"), "margin": f("actual_margin"), "pred_total": f("pred_total"),
            "total": f("actual_total")}


def store_backtest(conn, bt: dict) -> int:
    cur = conn.execute(
        """INSERT INTO backtest_runs(label, config_json, config_sha256, start_date, end_date, n_folds, n_games,
           metrics_json, folds_json, leakage_audit_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (bt["label"], dumps(bt["config"]), sha256(dumps(bt["config"])), bt["start"], bt["end"], len(bt["folds"]),
         len(bt["rows"]), dumps(bt["metrics"]), dumps(bt["folds"]), dumps(bt["leakage_audit"]), utcnow()))
    bid = cur.lastrowid
    conn.executemany(
        """INSERT INTO backtest_predictions(backtest_run_id, game_id, event_id, fold, train_cutoff, p_home, home_won,
           pred_margin, pred_total, actual_margin, actual_total) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        [(bid, r["game_id"], r["event_id"], r["fold"], r["train_cutoff"], r["p_home"], r["home_won"], r["pred_margin"],
          r["pred_total"], r["actual_margin"], r["actual_total"]) for r in bt["rows"]])
    conn.commit()
    return bid
