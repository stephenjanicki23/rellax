"""The learning loop: evidence → hypotheses → candidates → backtests → gated promotion.

Run after an event has been evaluated. Every step is recorded: the learning run, the
hypotheses tested, each candidate with its backtest, and an append-only decision.
"""
from __future__ import annotations

from .. import analyst
from ..config import DEFAULT_SETTINGS, ModelConfig, setting
from ..db import audit
from ..evaluation.backtest import run_backtest
from ..features.build import StateCache, training_metas
from ..models import engine, registry
from ..util import dumps, loads, utcnow
from . import candidates as C
from . import patterns, promotion


def settings_dict(conn) -> dict:
    return {k: setting(conn, k) for k in DEFAULT_SETTINGS}


def _decide(conn, decision: str, criteria, reason: str, incumbent_id=None, candidate_id=None, change_id=None,
            by: str = "auto") -> int:
    cur = conn.execute(
        """INSERT INTO promotion_decisions(candidate_change_id, incumbent_version_id, candidate_version_id, decision,
           criteria_json, reason, decided_by, decided_at) VALUES (?,?,?,?,?,?,?,?)""",
        (change_id, incumbent_id, candidate_id, decision, dumps(criteria), reason, by, utcnow()))
    conn.commit()
    return cur.lastrowid


def _fit_and_save(conn, h, cfg: ModelConfig, as_of: str, cache, *, parent_id=None, notes="", status="candidate"):
    started = utcnow()
    params = engine.fit(h, cfg, as_of, cache)
    tr = registry.record_training_run(conn, cfg, as_of, params, started)
    vid = registry.save_version(conn, params, cfg, status=status, parent_id=parent_id, notes=notes, training_run_id=tr)
    return vid, params


def window_start(h, cfg: ModelConfig, as_of: str, n_fights: int) -> str:
    metas, _ = training_metas(h, cfg, as_of)
    if not metas:
        return as_of
    return metas[max(0, len(metas) - n_fights)]["date"]


def initial_deployment(conn, h, as_of: str, cache: StateCache | None = None, cfg: ModelConfig | None = None,
                       select_half_life: bool = True) -> int:
    """First model: optionally choose the decay half-life by backtest, then fit on all data before as_of."""
    cache = cache or StateCache(h)
    cfg = cfg or ModelConfig()
    s = settings_dict(conn)
    chosen, trials = cfg, []
    start = window_start(h, cfg, as_of, int(s["learning.eval_window_fights"]))
    if select_half_life:
        best = None
        for hl in C.HALF_LIVES:
            c = cfg.with_changes(half_life_days=hl)
            bt = run_backtest(h, c, start, as_of, int(s["learning.backtest_fold_events"]), cache, conn,
                              label=f"initial half-life {hl:.0f}d")
            ll = bt["metrics"]["log_loss"]
            trials.append({"half_life_days": hl, "log_loss": ll, "backtest_id": bt["id"], "n": bt["metrics"]["n"]})
            if best is None or ll < best[0]:
                best = (ll, c, bt)
        chosen, bt = best[1], best[2]
    else:
        bt = run_backtest(h, cfg, start, as_of, int(s["learning.backtest_fold_events"]), cache, conn,
                          label="initial validation")
    gate = promotion.refit_gate(bt)
    vid, _ = _fit_and_save(conn, h, chosen, as_of, cache, notes="initial deployment")
    registry.activate(conn, vid, reason="initial deployment")
    _decide(conn, "initial", {"gate": gate, "half_life_trials": trials, "backtest_id": bt["id"],
                              "metrics": {k: bt["metrics"].get(k) for k in ("n", "accuracy", "log_loss", "brier", "ece")},
                              "baselines": bt["metrics"].get("baselines")},
            "first deployment: no incumbent. Half-life chosen by out-of-sample log loss; "
            + ("validated against baselines" if gate["passed"] else "WARNING: did not beat baselines"),
            candidate_id=vid)
    return vid


def run_learning(conn, as_of: str, mode: str, trigger_event_id: int | None = None, h=None,
                 cache: StateCache | None = None, force: bool = False) -> dict:
    from ..features.history import HistoryStore
    s = settings_dict(conn)
    inc = registry.active_version(conn)
    if inc is None:
        raise RuntimeError("no active model to learn from")
    inc_params = registry.load_params(conn, inc["id"])
    inc_cfg = ModelConfig.from_dict(loads(inc["config_json"]))
    h = h or HistoryStore.load(conn, elo_k=inc_cfg.elo_k)
    cache = cache or StateCache(h)
    cur = conn.execute("INSERT INTO learning_runs(trigger_event_id, mode, as_of, started_at, status) VALUES (?,?,?,?,?)",
                       (trigger_event_id, mode, as_of, utcnow(), "running"))
    lr = cur.lastrowid
    conn.commit()
    summary = {"incumbent": inc["label"], "as_of": as_of}

    hyps = patterns.analyze(conn, mode, int(s["learning.min_segment_n"]), float(s["learning.fdr_q"]), lr, before=as_of)
    summary["hypotheses_supported"] = [x["key"] for x in hyps if x["status"] == "supported"]
    new_metas, _ = training_metas(h, inc_cfg, as_of, start=inc_params["cutoff"])
    summary["new_fights_since_training"] = len(new_metas)
    cand_records = []

    if len(new_metas) < int(s["learning.min_new_fights_for_retrain"]) and not force:
        summary["action"] = "skipped retraining: insufficient new evidence"
        summary["decision"] = "retain"
    else:
        start = window_start(h, inc_cfg, as_of, int(s["learning.eval_window_fights"]))
        fold_events = int(s["learning.backtest_fold_events"])
        inc_bt = run_backtest(h, inc_cfg, start, as_of, fold_events, cache, conn, label=f"incumbent {inc['label']}")
        summary["incumbent_backtest"] = {k: inc_bt["metrics"].get(k) for k in ("n", "accuracy", "log_loss", "brier", "ece")}
        recent = conn.execute(
            """SELECT c.config_json FROM candidate_changes c WHERE c.learning_run_id IN
               (SELECT id FROM learning_runs WHERE id < ? ORDER BY id DESC LIMIT 3)""", (lr,)).fetchall()
        tried = {ModelConfig.from_dict(loads(r["config_json"])).fingerprint() for r in recent}
        cands = C.generate(inc_cfg, hyps, int(s["learning.max_candidates"]), tried)
        passing = []
        for cand in cands:
            bt = run_backtest(h, cand.config, start, as_of, fold_events, cache, conn, label=f"candidate: {cand.kind}")
            cmp = promotion.compare(inc_bt, bt, s, cand.primary_metric)
            failed = [c["criterion"] for c in cmp["criteria"] if not c["passed"]]
            status = "tested" if cmp["passed"] else "rejected"
            res_summary = (f"Δ{cand.primary_metric}={cmp['paired']['mean_delta']:+.4f} "
                           f"(P(better)={cmp['paired']['p_candidate_better']:.2f}, n={cmp['paired']['n']}); "
                           + ("all criteria passed" if cmp["passed"] else "failed: " + ", ".join(failed)))
            cc = conn.execute(
                """INSERT INTO candidate_changes(learning_run_id, hypothesis_key, kind, description, config_json, status,
                   candidate_backtest_id, incumbent_backtest_id, result_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (lr, cand.hypothesis_key, cand.kind, cand.description, dumps(cand.config.to_dict()), status, bt["id"],
                 inc_bt["id"], dumps(cmp), utcnow())).lastrowid
            rec = {"id": cc, "description": cand.description, "hypothesis_key": cand.hypothesis_key,
                   "status": status, "result_summary": res_summary}
            cand_records.append(rec)
            if cmp["passed"]:
                passing.append((cmp["paired"]["mean_delta"], cand, cc, cmp, rec))
            else:
                _decide(conn, "reject", cmp["criteria"], f"{cand.description}: {res_summary}", inc["id"], None, cc)
        if passing:
            passing.sort(key=lambda t: -t[0])
            _, cand, cc, cmp, rec = passing[0]
            for _, other, occ, ocmp, orec in passing[1:]:
                _decide(conn, "reject", ocmp["criteria"], f"{other.description}: passed but a better candidate won",
                        inc["id"], None, occ)
                conn.execute("UPDATE candidate_changes SET status='rejected' WHERE id=?", (occ,))
                orec["status"] = "rejected"
            vid, _ = _fit_and_save(conn, h, cand.config, as_of, cache, parent_id=inc["id"], notes=cand.description)
            if s["promotion.mode"] == "auto":
                registry.activate(conn, vid, reason=f"promoted: {cand.description}")
                _decide(conn, "promote", cmp["criteria"], f"{cand.description}: {rec['result_summary']}",
                        inc["id"], vid, cc)
                conn.execute("UPDATE candidate_changes SET status='promoted' WHERE id=?", (cc,))
                rec["status"] = "promoted"
                summary["decision"] = "promote"
            else:
                _decide(conn, "pending_approval", cmp["criteria"], f"{cand.description}: awaiting manual approval",
                        inc["id"], vid, cc)
                conn.execute("UPDATE candidate_changes SET status='pending_approval' WHERE id=?", (cc,))
                rec["status"] = "pending_approval"
                summary["decision"] = "pending_approval"
            summary["new_version"] = vid
        else:
            gate = promotion.refit_gate(inc_bt)
            if gate["passed"]:
                vid, _ = _fit_and_save(conn, h, inc_cfg, as_of, cache, parent_id=inc["id"],
                                       notes="scheduled re-estimation of the validated configuration on new data")
                registry.activate(conn, vid, reason="refit on new data (configuration unchanged)")
                _decide(conn, "refit", gate["criteria"],
                        f"No candidate met the promotion criteria; the validated configuration was re-estimated on "
                        f"{len(new_metas)} additional fights. Methodology unchanged.", inc["id"], vid)
                summary["decision"] = "refit"
                summary["new_version"] = vid
            else:
                _decide(conn, "retain", gate["criteria"], "incumbent backtest failed the refit gate; retained as-is",
                        inc["id"])
                summary["decision"] = "retain"
        conn.commit()

    rep = analyst.write_report(conn, lr, trigger_event_id, summary, hyps, cand_records, s["analyst.provider"])
    summary["candidates"] = cand_records
    conn.execute("UPDATE learning_runs SET finished_at=?, status='ok', summary_json=? WHERE id=?",
                 (utcnow(), dumps(summary), lr))
    audit(conn, "learning.run", "learning_run", lr, {"decision": summary.get("decision")})
    conn.commit()
    summary["learning_run_id"] = lr
    summary["analyst_findings"] = len(rep["findings"])
    return summary


def approve_candidate(conn, candidate_change_id: int, actor: str = "user") -> int:
    row = conn.execute("""SELECT d.candidate_version_id, d.incumbent_version_id FROM promotion_decisions d
                          WHERE d.candidate_change_id=? AND d.decision='pending_approval'
                          ORDER BY d.id DESC LIMIT 1""", (candidate_change_id,)).fetchone()
    if row is None or row["candidate_version_id"] is None:
        raise ValueError("no pending candidate with that id")
    registry.activate(conn, row["candidate_version_id"], actor=actor, reason="manual approval")
    _decide(conn, "approve", [], "manually approved after passing all automatic criteria", row["incumbent_version_id"],
            row["candidate_version_id"], candidate_change_id, by="manual")
    conn.execute("UPDATE candidate_changes SET status='promoted' WHERE id=?", (candidate_change_id,))
    conn.commit()
    return row["candidate_version_id"]
