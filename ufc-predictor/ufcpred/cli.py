"""Command line: `python -m ufcpred <command>`."""
from __future__ import annotations

import argparse
import json
import sys

from . import db, ledger, lifecycle, predict, review
from .util import utcnow


def main(argv=None):
    ap = argparse.ArgumentParser(prog="ufcpred", description="UFC fight card prediction engine")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init", help="create/migrate the database")
    r = sub.add_parser("refresh", help="download historical data (UFCStats mirror) and ingest it")
    r.add_argument("--local-dir", help="read the mirror CSVs from a directory instead of the network")
    sub.add_parser("refresh-upcoming", help="fetch upcoming cards from the configured provider")
    for name in ("import-card", "import-results", "import-odds", "import-corrections"):
        p = sub.add_parser(name)
        p.add_argument("file")
    t = sub.add_parser("train", help="initial deployment: select half-life by backtest and fit on data before --as-of")
    t.add_argument("--as-of", default=utcnow()[:10])
    t.add_argument("--no-select", action="store_true")
    rp = sub.add_parser("replay", help="historical replay of the full predict→lock→grade→learn loop")
    rp.add_argument("--start", required=True)
    rp.add_argument("--end", default=utcnow()[:10])
    rp.add_argument("--no-learn", action="store_true")
    rp.add_argument("--no-select", action="store_true")
    pr = sub.add_parser("predict", help="record live predictions for an event")
    pr.add_argument("event_id", type=int)
    pr.add_argument("--reason", default="preliminary (manual)")
    pr.add_argument("--post-lock", action="store_true", help="allowed only with a reason, e.g. late replacement")
    lk = sub.add_parser("lock")
    lk.add_argument("event_id", type=int)
    ev = sub.add_parser("evaluate")
    ev.add_argument("event_id", type=int)
    ln = sub.add_parser("learn")
    ln.add_argument("--mode", default="live")
    ln.add_argument("--force", action="store_true")
    rb = sub.add_parser("rollback")
    rb.add_argument("version_id", type=int)
    rb.add_argument("--reason", default="manual rollback (CLI)")
    sub.add_parser("tick", help="run every due lifecycle step once (cron-friendly)")
    sub.add_parser("backup")
    rs = sub.add_parser("restore")
    rs.add_argument("file")
    sub.add_parser("verify", help="verify ledger hash chain")
    sub.add_parser("status")
    rpt = sub.add_parser("report", help="write a Markdown performance/learning report from the database")
    rpt.add_argument("--mode", default="replay")
    rpt.add_argument("--out")
    sv = sub.add_parser("serve")
    sv.add_argument("--host", default="127.0.0.1")
    sv.add_argument("--port", type=int, default=8000)
    a = ap.parse_args(argv)

    if a.cmd == "restore":
        print(db.restore(a.file))
        return
    if a.cmd == "serve":
        import uvicorn
        conn = db.connect()
        from .config import setting
        if setting(conn, "lifecycle.scheduler_enabled"):
            lifecycle.Scheduler().start()
        conn.close()
        uvicorn.run("ufcpred.web.app:app", host=a.host, port=a.port)
        return
    conn = db.connect()
    out = None
    if a.cmd == "init":
        out = {"database": db.default_db_path(), "migrations": "applied"}
    elif a.cmd == "refresh":
        if a.local_dir:
            from .ingest import ingest_bundle
            from .providers.ufcstats_mirror import UFCStatsMirrorProvider
            out = ingest_bundle(conn, UFCStatsMirrorProvider(local_dir=a.local_dir).fetch_history())
        else:
            out = lifecycle.refresh_history(conn)
    elif a.cmd == "refresh-upcoming":
        out = lifecycle.refresh_upcoming(conn)
    elif a.cmd.startswith("import-"):
        from . import ingest
        from .providers import manual
        text = open(a.file, encoding="utf-8").read()
        fmt = "json" if a.file.endswith(".json") else "csv"
        try:
            if a.cmd == "import-card":
                out = ingest.ingest_bundle(conn, manual.parse_card(text, fmt, a.file), reconcile_cards=True, actor="cli")
            elif a.cmd == "import-results":
                out = ingest.ingest_manual_results(conn, manual.parse_results(text, fmt), actor="cli")
            elif a.cmd == "import-odds":
                out = ingest.ingest_manual_odds(conn, manual.parse_odds(text, fmt), actor="cli")
            else:
                out = ingest.ingest_corrections(conn, manual.parse_corrections(text, fmt), actor="cli")
        except manual.ValidationError as e:
            print("REJECTED:\n  " + "\n  ".join(e.errors), file=sys.stderr)
            sys.exit(2)
    elif a.cmd == "train":
        from .features.history import HistoryStore
        from .learning.loop import initial_deployment
        out = {"model_version": initial_deployment(conn, HistoryStore.load(conn), a.as_of, select_half_life=not a.no_select)}
    elif a.cmd == "replay":
        from .replay import replay
        out = replay(conn, a.start, a.end, learn=not a.no_learn, select_half_life=not a.no_select)
    elif a.cmd == "predict":
        out = {"prediction_ids": predict.predict_event(conn, a.event_id, mode="live", reason=a.reason,
                                                       allow_post_lock=a.post_lock)}
    elif a.cmd == "lock":
        out = ledger.lock_event(conn, a.event_id, "live", utcnow()[:10], "manual lock (CLI)")
    elif a.cmd == "evaluate":
        out = review.evaluate_event(conn, a.event_id, "live")
    elif a.cmd == "learn":
        from .learning.loop import run_learning
        out = run_learning(conn, utcnow()[:10], a.mode, None, force=a.force)
    elif a.cmd == "rollback":
        from .models.registry import rollback
        out = rollback(conn, a.version_id, actor="cli", reason=a.reason)
    elif a.cmd == "tick":
        out = lifecycle.tick(conn)
    elif a.cmd == "backup":
        out = {"backup": db.backup(conn)}
    elif a.cmd == "verify":
        out = ledger.verify(conn)
    elif a.cmd == "report":
        from .report import build
        text = build(conn, a.mode)
        if a.out:
            open(a.out, "w", encoding="utf-8").write(text)
            out = {"written": a.out}
        else:
            print(text)
            return
    elif a.cmd == "status":
        from . import services
        out = services.counts(conn)
        out["last_history_source"] = dict(out["last_history_source"]) if out["last_history_source"] else None
        ms = services.model_status(conn)
        out["active_model"] = ms["active"]["label"] if ms["active"] else None
    print(json.dumps(out, indent=2, default=str))


if __name__ == "__main__":
    main()
