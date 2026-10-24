"""Rolling-origin (expanding window) backtesting.

For each fold, the configuration is fitted from scratch on fights strictly before the
fold's first event date — standardisation, imputation, stacking, calibration and
method/round models included — and then predicts the fold. No preprocessing is shared
across the fold boundary.
"""
from __future__ import annotations

import numpy as np

from ..config import ModelConfig
from ..features.build import StateCache, method_class, training_metas
from ..models import engine
from ..util import dumps, sha256, utcnow
from . import metrics as M


def event_folds(h, start: str, end: str, events_per_fold: int) -> list[tuple[str, str, list]]:
    """Group completed events in [start, end) into chronological folds."""
    ev_dates = {}
    for fid, m in h.fights.items():
        if start <= m["date"] < end and m["status"] == "completed":
            ev_dates.setdefault(m["event_id"], m["date"])
    evs = sorted(ev_dates.items(), key=lambda kv: (kv[1], kv[0]))
    folds = []
    for i in range(0, len(evs), events_per_fold):
        chunk = evs[i:i + events_per_fold]
        folds.append((chunk[0][1], chunk[-1][1], [e for e, _ in chunk]))
    return folds


def run_backtest(h, cfg: ModelConfig, start: str, end: str, events_per_fold: int = 8,
                 cache: StateCache | None = None, conn=None, label: str = "backtest") -> dict:
    cache = cache or StateCache(h)
    folds = event_folds(h, start, end, events_per_fold)
    rows = []
    fold_meta = []
    audits = []
    for k, (f_start, f_end, ev_ids) in enumerate(folds):
        params = engine.fit(h, cfg, f_start, cache)
        evset = set(ev_ids)
        metas, labels = training_metas(h, cfg, cutoff=_next_day(f_end), start=f_start)
        metas = [m for m in metas if m["event_id"] in evset]
        if not metas:
            continue
        preds, ds = engine.predict_metas(params, h, metas, f_start, cache)
        audits.append(engine.leakage_audit(params, ds, f_start))
        exp_rate = experience_base_rate(h, cfg, f_start)
        for m, p, (a, b, _) in zip(metas, preds, ds.pairs):
            lab = labels[m["id"]]
            side = "red" if lab["red_won"] else "blue"
            mc = method_class(lab["method"])
            p_exp = 0.5 if a["n_fights"] == b["n_fights"] else (exp_rate if a["n_fights"] > b["n_fights"] else 1 - exp_rate)
            rows.append({"fight_id": m["id"], "event_id": m["event_id"], "date": m["date"], "fold": k,
                         "train_cutoff": f_start, "p_red": p["p_red"], "red_won": int(lab["red_won"]),
                         "methods": p["methods"], "actual_method": lab["method"],
                         "p_actual_joint": p["methods"][side].get(mc) if mc else None,
                         "p_elo": 1 / (1 + 10 ** ((b["elo"] - a["elo"]) / 400)), "p_exp": p_exp})
        fold_meta.append({"fold": k, "cutoff": f_start, "end": f_end, "events": len(ev_ids), "fights": len(metas),
                          "n_train": params["diagnostics"]["n_train"]})
    p = np.array([r["p_red"] for r in rows])
    y = np.array([r["red_won"] for r in rows], dtype=float)
    ev = np.array([r["event_id"] for r in rows])
    summary = M.summarize(p, y, ev) if rows else {"n": 0}
    if rows:
        arr = bt_arrays({"rows": rows})
        summary["baselines"] = M.baselines(y, arr["p_exp"])
        summary["baselines"]["elo_only"] = {"log_loss": float(M.log_loss(arr["p_elo"], y).mean()),
                                            "brier": float(M.brier(arr["p_elo"], y).mean()),
                                            "accuracy": float(np.mean((arr["p_elo"] >= .5) == (y == 1)))}
        pj = arr["p_joint"][~np.isnan(arr["p_joint"])]
        summary["method_log_loss"] = float(-np.mean(np.log(np.clip(pj, 1e-12, 1)))) if len(pj) else None
    audit = {"passed": all(a["passed"] for a in audits), "folds": len(audits),
             "problems": [x for a in audits for x in a["problems"]][:20]}
    result = {"label": label, "config": cfg.to_dict(), "start": start, "end": end, "folds": fold_meta,
              "rows": rows, "metrics": summary, "leakage_audit": audit}
    if conn is not None:
        result["id"] = store_backtest(conn, result)
    return result


def experience_base_rate(h, cfg: ModelConfig, cutoff: str) -> float:
    """Historical base rate: how often the more UFC-experienced fighter won before `cutoff`."""
    metas, labels = training_metas(h, cfg, cutoff)
    won = tot = 0
    for m in metas:
        na = len(h.records_before(m["red_fighter_id"], m["date"]))
        nb = len(h.records_before(m["blue_fighter_id"], m["date"]))
        if na == nb:
            continue
        tot += 1
        won += int((na > nb) == bool(labels[m["id"]]["red_won"]))
    return (won + 1) / (tot + 2)


def bt_arrays(bt: dict) -> dict:
    r = bt["rows"]
    return {"fight_id": np.array([x["fight_id"] for x in r]), "event": np.array([x["event_id"] for x in r]),
            "p": np.array([x["p_red"] for x in r]), "y": np.array([x["red_won"] for x in r], dtype=float),
            "p_elo": np.array([x["p_elo"] for x in r]), "p_exp": np.array([x["p_exp"] for x in r]),
            "p_joint": np.array([np.nan if x["p_actual_joint"] is None else x["p_actual_joint"] for x in r])}


def _next_day(d: str) -> str:
    import datetime as dt
    return (dt.date.fromisoformat(d) + dt.timedelta(days=1)).isoformat()


def store_backtest(conn, bt: dict) -> int:
    cur = conn.execute(
        """INSERT INTO backtest_runs(label, config_json, config_sha256, start_date, end_date, n_folds, n_fights,
           metrics_json, folds_json, leakage_audit_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (bt["label"], dumps(bt["config"]), sha256(dumps(bt["config"])), bt["start"], bt["end"], len(bt["folds"]),
         len(bt["rows"]), dumps(bt["metrics"]), dumps(bt["folds"]), dumps(bt["leakage_audit"]), utcnow()))
    bid = cur.lastrowid
    conn.executemany(
        """INSERT INTO backtest_predictions(backtest_run_id, fight_id, event_id, fold, train_cutoff, p_red, red_won,
           method_probs_json, actual_method) VALUES (?,?,?,?,?,?,?,?,?)""",
        [(bid, r["fight_id"], r["event_id"], r["fold"], r["train_cutoff"], r["p_red"], r["red_won"],
          dumps(r["methods"]), r["actual_method"]) for r in bt["rows"]])
    conn.commit()
    return bid
