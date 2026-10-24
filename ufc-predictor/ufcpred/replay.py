"""Historical replay: run the full live loop over past events, one event at a time.

For each event, in date order:
  1. predict with the active model, decision time = event date (the engine cannot see
     any fight on or after that date, including this card's results);
  2. lock the predictions in the ledger (mode='replay');
  3. reconcile the official results already in the database;
  4. grade the locked predictions;
  5. run the learning loop with as_of = the day after the event.

Replay predictions are labelled `mode='replay'` everywhere in the UI and are never mixed
with live predictions.
"""
from __future__ import annotations

import datetime as dt
import time

from . import ledger, predict, review
from .config import ModelConfig
from .db import audit
from .features.build import StateCache
from .features.history import HistoryStore
from .learning import loop
from .models import registry


def replay(conn, start: str, end: str, *, learn: bool = True, select_half_life: bool = True,
           progress=print, max_events: int | None = None) -> dict:
    h = HistoryStore.load(conn, elo_k=ModelConfig().elo_k)
    cache = StateCache(h)
    events = conn.execute(
        """SELECT DISTINCT e.* FROM events e JOIN fights f ON f.event_id=e.id
           WHERE e.date>=? AND e.date<? AND f.status='completed' ORDER BY e.date, e.id""", (start, end)).fetchall()
    if max_events:
        events = events[:max_events]
    if not events:
        return {"events": 0, "note": "no completed events in range"}
    if registry.active_version(conn) is None:
        progress(f"initial deployment with data before {events[0]['date']}")
        loop.initial_deployment(conn, h, events[0]["date"], cache, select_half_life=select_half_life)
    out = {"events": 0, "predictions": 0, "graded": 0, "correct": 0, "learning_runs": 0, "decisions": []}
    t0 = time.time()
    for ev in events:
        if ledger.is_locked(conn, ev["id"], "replay"):
            continue
        ids = predict.predict_event(conn, ev["id"], mode="replay", as_of=ev["date"], reason="replay: pre-event",
                                    h=h, cache=cache)
        ledger.lock_event(conn, ev["id"], "replay", ev["date"], "replay pre-event lock")
        res = review.evaluate_event(conn, ev["id"], "replay")
        out["events"] += 1
        out["predictions"] += len(ids)
        out["graded"] += res.get("graded", 0)
        out["correct"] += res.get("correct", 0)
        if learn:
            nxt = (dt.date.fromisoformat(ev["date"]) + dt.timedelta(days=1)).isoformat()
            lr = loop.run_learning(conn, nxt, "replay", ev["id"], h, cache)
            if "skipped" not in lr.get("action", ""):
                out["learning_runs"] += 1
                out["decisions"].append({"event": ev["name"], "date": ev["date"], "decision": lr.get("decision"),
                                         "candidates": [(c["description"], c["status"]) for c in lr["candidates"]]})
                progress(f"{ev['date']} {ev['name']}: learning → {lr.get('decision')} "
                         f"({len(lr['candidates'])} candidates)")
        acc = out["correct"] / out["graded"] if out["graded"] else 0
        progress(f"{ev['date']} {ev['name']}: {res.get('correct', 0)}/{res.get('graded', 0)} "
                 f"(running {acc:.1%}, {time.time() - t0:.0f}s)")
    audit(conn, "replay.completed", "replay", None, {k: v for k, v in out.items() if k != "decisions"})
    conn.commit()
    return out
