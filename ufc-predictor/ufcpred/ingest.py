"""Validate normalised provider records and write them to the database.

Responsibilities: source attribution, identity resolution, duplicate detection,
statistic validation, result revisioning, and card reconciliation (cancellations and
replacements). Prediction logic never reads provider output directly.
"""
from __future__ import annotations

from .db import audit, flag_issue
from .providers import parse as P
from .providers.base import Bundle, PFight
from .util import utcnow

STAT_KEYS = ["kd", "sig_l", "sig_a", "tot_l", "tot_a", "td_l", "td_a", "sub_att", "rev", "ctrl_sec",
             "head_l", "head_a", "body_l", "body_a", "leg_l", "leg_a", "dist_l", "dist_a", "clinch_l", "clinch_a",
             "ground_l", "ground_a"]


def _record_sources(conn, bundle: Bundle) -> int | None:
    last = None
    for s in bundle.sources:
        cur = conn.execute(
            """INSERT INTO data_sources(provider, resource, url, license, retrieved_at, sha256, status, http_status,
               error, cache_path, rows) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (s.provider, s.resource, s.url, s.license, s.retrieved_at, s.sha256, s.status, s.http_status, s.error,
             s.cache_path, s.rows))
        last = cur.lastrowid
        if s.status == "stale":
            flag_issue(conn, "source", f"{s.provider}:{s.resource}", "stale_source",
                       f"{s.provider} unreachable; using cached copy ({s.error})", "warning")
    return last


def resolve_fighter_by_name(conn, name: str, weight_class: str | None = None) -> tuple[int | None, str]:
    """Return (fighter_id, how). how ∈ unique | weight_match | ambiguous | none."""
    key = P.name_key(name)
    rows = _fighters_by_key(conn).get(key, [])
    if len(rows) == 1:
        return rows[0]["id"], "unique"
    if not rows:
        return None, "none"
    limit = P.class_limit(weight_class)
    if limit is not None:
        rows = sorted(rows, key=lambda r: abs((r["listed_weight_lbs"] or 1e9) - limit))
        if abs((rows[1]["listed_weight_lbs"] or 1e9) - limit) - abs((rows[0]["listed_weight_lbs"] or 1e9) - limit) >= 10:
            return rows[0]["id"], "weight_match"
    return rows[0]["id"], "ambiguous"


_key_cache: dict = {}


def _fighters_by_key(conn) -> dict:
    n = conn.execute("SELECT COUNT(*), MAX(id) FROM fighters").fetchone()
    sig = (id(conn), n[0], n[1])
    if _key_cache.get("sig") != sig:
        idx: dict = {}
        for r in conn.execute("SELECT id, name, listed_weight_lbs FROM fighters"):
            idx.setdefault(P.name_key(r["name"]), []).append(r)
        _key_cache.clear()
        _key_cache.update(sig=sig, idx=idx)
    return _key_cache["idx"]


def _validate_stats(st: dict) -> list[str]:
    problems = []
    for k in STAT_KEYS:
        v = st.get(k)
        if v is not None and v < 0:
            problems.append(f"{k} negative")
            st[k] = None
    for base in ("sig", "tot", "td", "head", "body", "leg", "dist", "clinch", "ground"):
        l, a = st.get(f"{base}_l"), st.get(f"{base}_a")
        if l is not None and a is not None and l > a:
            problems.append(f"{base} landed {l} > attempted {a}")
            st[f"{base}_l"] = st[f"{base}_a"] = None
    if st.get("ctrl_sec") is not None and st["ctrl_sec"] > 330:
        problems.append(f"control time {st['ctrl_sec']}s exceeds a round")
        st["ctrl_sec"] = None
    return problems


def ingest_bundle(conn, bundle: Bundle, *, reconcile_cards: bool = False,
                  actor: str = "system") -> dict:
    now = utcnow()
    summary = {"provider": bundle.provider, "events_new": 0, "fights_new": 0, "fighters_new": 0,
               "results_new": 0, "results_revised": 0, "stats_rows": 0, "issues": 0, "canceled": 0,
               "replaced": 0, "duplicates_skipped": 0}
    src_id = _record_sources(conn, bundle)

    origin = "manual" if bundle.provider == "manual" else "provider"

    # Fighters — only new or changed rows are written (re-ingesting a full history is cheap over a network DB)
    FCOLS = ("name", "nickname", "dob", "height_in", "reach_in", "stance", "listed_weight_lbs")
    existing = {r["external_id"]: r for r in conn.execute(f"SELECT id, external_id, {', '.join(FCOLS)} FROM fighters")}
    ins, upd, queued = [], [], set()
    # fighters created from a hand-imported card (debutants, unmatched names) are adopted by the provider's profile
    placeholders: dict[str, list] = {}
    if origin != "manual":
        for ext, r in existing.items():
            if ext and ext.startswith("manual-fighter:"):
                placeholders.setdefault(P.name_key(r["name"]), []).append(r)
    adopt = []
    for f in bundle.fighters:
        new_vals = (f.name, f.nickname, f.dob, f.height_in, f.reach_in, f.stance, f.listed_weight_lbs)
        old = existing.get(f.external_id)
        if old is None and len(placeholders.get(P.name_key(f.name), [])) == 1 and f.external_id not in queued:
            ph = placeholders.pop(P.name_key(f.name))[0]
            adopt.append((f.external_id, *new_vals, origin, now, ph["id"]))
            existing[f.external_id] = ph
            queued.add(f.external_id)
            continue
        if old is None:
            if f.external_id not in queued:
                ins.append((f.external_id, *new_vals, src_id, origin, now, now))
                queued.add(f.external_id)
        else:
            merged = tuple(new_vals[i] if (i < 2 or new_vals[i] is not None) else old[c]
                           for i, c in enumerate(FCOLS))
            if merged != tuple(old[c] for c in FCOLS):
                upd.append((*merged, now, old["id"]))
    if ins:
        conn.executemany("INSERT INTO fighters(external_id, name, nickname, dob, height_in, reach_in, stance, "
                         "listed_weight_lbs, source_id, origin, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                         ins)
        summary["fighters_new"] += len(ins)
    if upd:
        conn.executemany("UPDATE fighters SET name=?, nickname=?, dob=?, height_in=?, reach_in=?, stance=?, "
                         "listed_weight_lbs=?, updated_at=? WHERE id=?", upd)
    if adopt:
        conn.executemany("UPDATE fighters SET external_id=?, name=?, nickname=?, dob=?, height_in=?, reach_in=?, "
                         "stance=?, listed_weight_lbs=?, origin=?, updated_at=? WHERE id=?", adopt)
        for a_ in adopt:
            flag_issue(conn, "fighter", a_[-1], "no_history", "matched to provider profile " + a_[0], "info")
            conn.execute("UPDATE data_quality_issues SET resolved_at=? WHERE entity='fighter' AND entity_id=? "
                         "AND kind='no_history'", (now, str(a_[-1])))
    fighter_ids = {r["external_id"]: r["id"] for r in conn.execute("SELECT id, external_id FROM fighters")}

    # Events
    ECOLS = ("name", "date", "location", "venue", "start_time_utc", "source_url")
    ev_rows = {r["external_id"]: r for r in conn.execute(
        f"SELECT id, external_id, origin, {', '.join(ECOLS)} FROM events")}
    by_date: dict[str, list] = {}
    for r in ev_rows.values():
        by_date.setdefault(r["date"], []).append(r)
    ins, upd = [], []
    event_alias: dict[str, int] = {}   # a card imported by hand and the provider's copy are one event
    for e in bundle.events:
        old = ev_rows.get(e.external_id)
        if old is None and e.external_id in ev_rows:     # repeated within this import
            continue
        vals = (e.name, e.date, e.location, e.venue, e.start_time_utc, e.source_url)
        if old is not None:
            merged = tuple(vals[i] if (i < 2 or vals[i] is not None) else old[c] for i, c in enumerate(ECOLS))
            if merged != tuple(old[c] for c in ECOLS):
                upd.append((*merged, now, old["id"]))
            continue
        same_day = [d for d in by_date.get(e.date, []) if d["external_id"] != e.external_id]
        other_origin = [d for d in same_day if isinstance(d["id"], int) and d["origin"] != origin]
        if len(other_origin) == 1:
            d = other_origin[0]
            event_alias[e.external_id] = d["id"]
            flag_issue(conn, "event", d["id"], "merged_event",
                       f"'{e.name}' from {bundle.provider} matched to existing {d['origin']} event #{d['id']} "
                       f"'{d['name']}' on {e.date}; their fights and results are merged", "info")
            continue
        for d in same_day:
            flag_issue(conn, "event", e.external_id, "possible_duplicate_event",
                       f"'{e.name}' on {e.date} may duplicate existing event #{d['id']} '{d['name']}'", "warning")
        ins.append((e.external_id, e.name, e.date, e.start_time_utc, e.venue, e.location, "scheduled", origin, src_id,
                    e.source_url, now, now))
        by_date.setdefault(e.date, []).append({"id": "(same import)", "name": e.name, "external_id": e.external_id})
        ev_rows[e.external_id] = None
    if ins:
        conn.executemany("INSERT INTO events(external_id, name, date, start_time_utc, venue, location, status, origin, "
                         "source_id, source_url, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", ins)
        summary["events_new"] += len(ins)
    if upd:
        conn.executemany("UPDATE events SET name=?, date=?, location=?, venue=?, start_time_utc=?, source_url=?, "
                         "updated_at=? WHERE id=?", upd)
    event_ids = {r["external_id"]: r["id"] for r in conn.execute("SELECT id, external_id FROM events")}
    event_ids.update(event_alias)

    # Fights
    FUPD = ("weight_class", "is_title", "scheduled_rounds", "card_segment", "bout_order", "short_notice_red",
            "short_notice_blue", "weight_miss_red", "weight_miss_blue")
    fight_rows = {r["external_id"]: r for r in conn.execute(
        f"SELECT id, external_id, event_id, red_fighter_id, blue_fighter_id, status, origin, {', '.join(FUPD)} "
        f"FROM fights")}
    fights_by_id = {r["id"]: r for r in fight_rows.values()}
    fight_alias: dict[str, tuple[int, bool]] = {}   # provider fight -> (stored fight id, corners swapped)
    pairs = {(r["event_id"], frozenset((r["red_fighter_id"], r["blue_fighter_id"]))): r["id"]
             for r in fight_rows.values()}
    card_by_event: dict[int, list] = {}
    ins, upd, cancel = [], [], []

    def fighter_for(name: str, ext: str | None, wc: str | None, fight_ext: str) -> int:
        if ext and ext in fighter_ids:
            return fighter_ids[ext]
        fid, how = resolve_fighter_by_name(conn, name, wc)
        if how == "ambiguous":
            flag_issue(conn, "fight", fight_ext, "ambiguous_identity",
                       f"'{name}' matches several fighters; picked #{fid} — verify", "error")
        if fid is None:
            key = ext or f"manual-fighter:{P.name_key(name)}"
            cur = conn.execute("INSERT INTO fighters(external_id, name, origin, created_at, updated_at) VALUES (?,?,?,?,?)",
                               (key, name, "manual", now, now))
            fid = cur.lastrowid
            fighter_ids[key] = fid
            summary["fighters_new"] += 1
            flag_issue(conn, "fighter", fid, "no_history",
                       f"'{name}' is not in the historical database: no UFC statistics (debut or unmatched name)",
                       "info")
        return fid

    for f in bundle.fights:
        ev_id = event_ids.get(f.event_external_id)
        if ev_id is None:
            flag_issue(conn, "fight", f.external_id, "orphan_fight", "fight references unknown event", "error")
            continue
        red = fighter_for(f.red_name, f.red_external_id, f.weight_class, f.external_id)
        blue = fighter_for(f.blue_name, f.blue_external_id, f.weight_class, f.external_id)
        if red == blue:
            flag_issue(conn, "fight", f.external_id, "self_fight", "both corners resolve to one fighter", "error")
            continue
        old = fight_rows.get(f.external_id)
        if old is not None:
            vals = (f.weight_class, int(f.is_title), f.scheduled_rounds, f.card_segment, f.bout_order,
                    _b(f.short_notice_red), _b(f.short_notice_blue), _b(f.weight_miss_red), _b(f.weight_miss_blue))
            merged = tuple(
                vals[i] if (c == "is_title" or (c == "card_segment" and vals[i] != "unknown")
                            or (c not in ("is_title", "card_segment") and vals[i] is not None)) else old[c]
                for i, c in enumerate(FUPD))
            if merged != tuple(old[c] for c in FUPD):
                upd.append((*merged, now, old["id"]))
            if f.canceled and old["status"] == "scheduled":
                cancel.append((now, old["id"]))
            card_by_event.setdefault(ev_id, []).append(old["id"])
            continue
        key = (ev_id, frozenset((red, blue)))
        if key in pairs:
            dup = pairs[key]
            stored = fights_by_id.get(dup) if dup is not None else None
            if stored is not None and stored["origin"] != origin:
                # the same bout, imported by hand before the provider published it: attach, don't duplicate
                fight_alias[f.external_id] = (dup, stored["red_fighter_id"] != red)
                card_by_event.setdefault(ev_id, []).append(dup)
                continue
            flag_issue(conn, "fight", f.external_id, "duplicate_fight",
                       f"same pairing already stored{'' if dup is None else f' as fight #{dup}'}; skipped", "warning")
            summary["duplicates_skipped"] += 1
            if dup is not None:
                card_by_event.setdefault(ev_id, []).append(dup)
            continue
        pairs[key] = None
        ins.append((f.external_id, ev_id, red, blue, f.weight_class, int(f.is_title), int(f.is_women), f.scheduled_rounds,
                    f.time_format, f.card_segment, f.bout_order, "canceled" if f.canceled else "scheduled",
                    _b(f.short_notice_red), _b(f.short_notice_blue), _b(f.weight_miss_red), _b(f.weight_miss_blue),
                    origin, src_id, now, now))
        card_by_event.setdefault(ev_id, []).append(f.external_id)
    if ins:
        conn.executemany(
            """INSERT INTO fights(external_id, event_id, red_fighter_id, blue_fighter_id, weight_class, is_title,
               is_women, scheduled_rounds, time_format, card_segment, bout_order, status, short_notice_red,
               short_notice_blue, weight_miss_red, weight_miss_blue, origin, source_id, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", ins)
        summary["fights_new"] += len(ins)
    if upd:
        conn.executemany(f"UPDATE fights SET {', '.join(c + '=?' for c in FUPD)}, updated_at=? WHERE id=?", upd)
    if cancel:
        conn.executemany("UPDATE fights SET status='canceled', updated_at=? WHERE id=?", cancel)
    fights = {r["external_id"]: r for r in conn.execute(
        "SELECT id, external_id, red_fighter_id, blue_fighter_id, scheduled_rounds FROM fights")}
    by_id = {r["id"]: r for r in fights.values()}
    swapped = {}
    for ext, (fid_, sw) in fight_alias.items():
        fights[ext] = by_id[fid_]
        swapped[ext] = sw
    fight_ids = {k: r["id"] for k, r in fights.items()}
    for ev_id in card_by_event:
        card_by_event[ev_id] = [fight_ids[x] if isinstance(x, str) else x for x in card_by_event[ev_id]]

    if reconcile_cards:
        for ev_id, current in card_by_event.items():
            summary_c = reconcile_card(conn, ev_id, set(current))
            summary["canceled"] += summary_c["canceled"]
            summary["replaced"] += summary_c["replaced"]

    # Results — new results in one batch; a changed result becomes a new revision via record_result
    latest = {r["fight_id"]: r for r in conn.execute(
        """SELECT r.fight_id, r.outcome, r.winner_fighter_id, r.method, r.end_round, r.end_time_sec FROM fight_results r
           JOIN (SELECT fight_id, MAX(revision) rv FROM fight_results GROUP BY fight_id) m
           ON m.fight_id=r.fight_id AND m.rv=r.revision""")}
    ins, done = [], []
    for r in bundle.results:
        fight = fights.get(r.fight_external_id)
        if fight is None:
            continue
        fid = fight["id"]
        corner = r.winner_corner
        if swapped.get(r.fight_external_id) and corner in ("red", "blue"):
            corner = "blue" if corner == "red" else "red"
        winner = fight["red_fighter_id"] if corner == "red" else \
            fight["blue_fighter_id"] if corner == "blue" else None
        if r.outcome != "win":
            winner = None
        prev = latest.get(fid)
        if prev is None:
            sched = fight["scheduled_rounds"]
            if r.end_round is not None and sched and r.end_round > sched:
                flag_issue(conn, "fight", fid, "invalid_result", f"end round {r.end_round} > scheduled {sched}", "error")
                continue
            total = (r.end_round - 1) * 300 + r.end_time_sec \
                if (r.end_round is not None and r.end_time_sec is not None and sched) else None
            ins.append((fid, 1, r.outcome, winner, r.method, r.method_detail, r.end_round, r.end_time_sec, total,
                        r.referee, r.details, r.reason or "initial official result", origin, src_id, r.source_url, now))
            done.append((now, fid))
            continue
        if (prev["outcome"], prev["winner_fighter_id"], prev["method"], prev["end_round"], prev["end_time_sec"]) == \
                (r.outcome, winner, r.method, r.end_round, r.end_time_sec):
            continue
        res = record_result(conn, fid, r.outcome, winner, r.method, r.method_detail, r.end_round, r.end_time_sec,
                            referee=r.referee, details=r.details, source_url=r.source_url, source_id=src_id,
                            origin=origin, reason=r.reason)
        if res == "revised":
            summary["results_revised"] += 1
    if ins:
        conn.executemany(
            """INSERT INTO fight_results(fight_id, revision, outcome, winner_fighter_id, method, method_detail, end_round,
               end_time_sec, total_time_sec, referee, details, reason, origin, source_id, source_url, recorded_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", ins)
        conn.executemany("UPDATE fights SET status='completed', updated_at=? WHERE id=? "
                         "AND status IN ('scheduled','completed')", done)
        summary["results_new"] += len(ins)

    # Stats — written for fights that have none yet (per-round stats are not revised at source)
    have = {r[0] for r in conn.execute("SELECT DISTINCT fight_id FROM fight_stats")}
    rows = []
    for s in bundle.stats:
        fight = fights.get(s.fight_external_id)
        if fight is None or fight["id"] in have:
            continue
        fid = fight["id"]
        red_side = (s.corner == "red") != bool(swapped.get(s.fight_external_id))
        fighter = fight["red_fighter_id"] if red_side else fight["blue_fighter_id"]
        st = dict(s.stats)
        problems = _validate_stats(st)
        if problems:
            flag_issue(conn, "fight_stats", f"{fid}:{fighter}:{s.round}", "invalid_stats",
                       "; ".join(problems) + " — values discarded", "warning")
        rows.append((fid, fighter, s.round, *[st.get(k) for k in STAT_KEYS]))
    if rows:
        conn.executemany(
            f"INSERT INTO fight_stats(fight_id, fighter_id, round, {', '.join(STAT_KEYS)}) "
            f"VALUES ({', '.join('?' * (3 + len(STAT_KEYS)))}) ON CONFLICT(fight_id, fighter_id, round) DO UPDATE SET "
            + ", ".join(f"{k}=excluded.{k}" for k in STAT_KEYS), rows)
        summary["stats_rows"] = len(rows)

    for ent, ent_id, kind, msg, sev in bundle.issues:
        flag_issue(conn, ent, ent_id, kind, msg, sev)
    summary["issues"] = len(bundle.issues)

    # Past events with results are completed (lifecycle moves them on to evaluated).
    conn.execute("""UPDATE events SET status='completed', updated_at=? WHERE status IN ('scheduled','locked')
                    AND id IN (SELECT f.event_id FROM fights f JOIN fight_results r ON r.fight_id=f.id)
                    AND NOT EXISTS (SELECT 1 FROM fights f2 WHERE f2.event_id=events.id AND f2.status='scheduled')""",
                 (now,))
    audit(conn, "ingest", "provider", bundle.provider, summary, actor=actor)
    conn.commit()
    return summary


def _b(v):
    return None if v is None else int(bool(v))


def reconcile_card(conn, event_id: int, current_fight_ids: set[int]) -> dict:
    """Fights no longer on a refreshed card become canceled, or replaced when one corner re-appears."""
    out = {"canceled": 0, "replaced": 0}
    now = utcnow()
    current = conn.execute(f"SELECT id, red_fighter_id, blue_fighter_id FROM fights WHERE id IN "
                           f"({','.join('?' * len(current_fight_ids)) or 'NULL'})", tuple(current_fight_ids)).fetchall()
    stale = conn.execute("SELECT id, red_fighter_id, blue_fighter_id FROM fights WHERE event_id=? AND status='scheduled'",
                         (event_id,)).fetchall()
    for s in stale:
        if s["id"] in current_fight_ids:
            continue
        repl = next((c for c in current if {s["red_fighter_id"], s["blue_fighter_id"]} &
                     {c["red_fighter_id"], c["blue_fighter_id"]}), None)
        if repl:
            conn.execute("UPDATE fights SET status='replaced', replaced_by_fight_id=?, updated_at=? WHERE id=?",
                         (repl["id"], now, s["id"]))
            conn.execute("UPDATE fights SET short_notice_red=COALESCE(short_notice_red, ?), "
                         "short_notice_blue=COALESCE(short_notice_blue, ?) WHERE id=?",
                         (int(repl["red_fighter_id"] not in (s["red_fighter_id"], s["blue_fighter_id"])),
                          int(repl["blue_fighter_id"] not in (s["red_fighter_id"], s["blue_fighter_id"])), repl["id"]))
            audit(conn, "fight.replaced", "fight", s["id"], {"replaced_by": repl["id"]})
            out["replaced"] += 1
        else:
            conn.execute("UPDATE fights SET status='canceled', updated_at=? WHERE id=?", (now, s["id"]))
            audit(conn, "fight.canceled", "fight", s["id"], {})
            out["canceled"] += 1
    return out


def latest_result(conn, fight_id: int):
    return conn.execute("SELECT * FROM fight_results WHERE fight_id=? ORDER BY revision DESC LIMIT 1",
                        (fight_id,)).fetchone()


def record_result(conn, fight_id: int, outcome: str, winner_id: int | None, method: str | None,
                  method_detail: str | None, end_round: int | None, end_time_sec: int | None, *, referee=None,
                  details=None, source_url=None, source_id=None, origin="provider", reason=None) -> str:
    """Store an official result. Returns 'new', 'revised' or 'unchanged'. Never edits a revision."""
    fight = conn.execute("SELECT * FROM fights WHERE id=?", (fight_id,)).fetchone()
    if outcome not in ("win", "draw", "nc"):
        raise ValueError(f"invalid outcome {outcome}")
    if outcome == "win" and winner_id not in (fight["red_fighter_id"], fight["blue_fighter_id"]):
        raise ValueError("winner must be one of the two fighters")
    if outcome != "win":
        winner_id = None
    sched = fight["scheduled_rounds"]
    if end_round is not None and sched and end_round > sched:
        raise ValueError(f"end round {end_round} exceeds scheduled {sched} rounds")
    total = None
    if end_round is not None and end_time_sec is not None and sched:
        total = (end_round - 1) * 300 + end_time_sec
    prev = latest_result(conn, fight_id)
    key = (outcome, winner_id, method, end_round, end_time_sec)
    if prev is not None and (prev["outcome"], prev["winner_fighter_id"], prev["method"], prev["end_round"],
                             prev["end_time_sec"]) == key:
        return "unchanged"
    rev = 1 if prev is None else prev["revision"] + 1
    if prev is not None and not reason:
        reason = "result changed at source (correction or overturned decision)"
    conn.execute(
        """INSERT INTO fight_results(fight_id, revision, outcome, winner_fighter_id, method, method_detail, end_round,
           end_time_sec, total_time_sec, referee, details, reason, origin, source_id, source_url, recorded_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (fight_id, rev, outcome, winner_id, method, method_detail, end_round, end_time_sec, total, referee, details,
         reason or "initial official result", origin, source_id, source_url, utcnow()))
    conn.execute("UPDATE fights SET status='completed', updated_at=? WHERE id=? AND status IN ('scheduled','completed')",
                 (utcnow(), fight_id))
    if prev is not None:
        flag_issue(conn, "fight", fight_id, "result_revised",
                   f"result revision {rev}: {prev['outcome']}/{prev['method']} → {outcome}/{method} ({reason})", "info")
        audit(conn, "result.revised", "fight", fight_id, {"revision": rev, "reason": reason})
    return "new" if prev is None else "revised"


def ingest_manual_results(conn, rows: list[dict], actor: str = "user") -> dict:
    """Attach validated manual result rows to stored fights (matched by date and fighter names)."""
    out = {"new": 0, "revised": 0, "unchanged": 0, "unmatched": []}
    for r in rows:
        cands = conn.execute(
            """SELECT f.*, fr.name AS red_name, fb.name AS blue_name FROM fights f JOIN events e ON e.id=f.event_id
               JOIN fighters fr ON fr.id=f.red_fighter_id JOIN fighters fb ON fb.id=f.blue_fighter_id
               WHERE e.date=?""", (r["event_date"],)).fetchall()
        want = {P.name_key(r["red"]), P.name_key(r["blue"])}
        match = [c for c in cands if {P.name_key(c["red_name"]), P.name_key(c["blue_name"])} == want]
        if len(match) != 1:
            out["unmatched"].append(f"{r['red']} vs {r['blue']} on {r['event_date']}")
            continue
        f = match[0]
        winner = None
        if r["outcome"] == "win":
            winner = f["red_fighter_id"] if P.name_key(r["winner"]) == P.name_key(f["red_name"]) else f["blue_fighter_id"]
        res = record_result(conn, f["id"], r["outcome"], winner, r["method"], r.get("method_detail"), r["end_round"],
                            r["end_time_sec"], details=r.get("details"), source_url=r["source_url"], origin="manual",
                            reason=r.get("reason"))
        out[res] += 1
    audit(conn, "results.manual_import", "results", None, out, actor=actor)
    conn.execute("""UPDATE events SET status='completed', updated_at=? WHERE status IN ('scheduled','locked')
                    AND NOT EXISTS (SELECT 1 FROM fights f WHERE f.event_id=events.id AND f.status='scheduled')
                    AND EXISTS (SELECT 1 FROM fights f WHERE f.event_id=events.id AND f.status='completed')""",
                 (utcnow(),))
    conn.commit()
    return out


def ingest_manual_odds(conn, rows: list[dict], actor: str = "user") -> dict:
    out = {"stored": 0, "unmatched": []}
    for r in rows:
        cands = conn.execute(
            """SELECT f.id, f.red_fighter_id, fr.name AS red_name, fb.name AS blue_name FROM fights f
               JOIN events e ON e.id=f.event_id JOIN fighters fr ON fr.id=f.red_fighter_id
               JOIN fighters fb ON fb.id=f.blue_fighter_id WHERE e.date=?""", (r["event_date"],)).fetchall()
        hit = None
        for c in cands:
            if (P.name_key(c["red_name"]), P.name_key(c["blue_name"])) == (P.name_key(r["red"]), P.name_key(r["blue"])):
                hit, rd, bd = c, r["red_decimal"], r["blue_decimal"]
            elif (P.name_key(c["red_name"]), P.name_key(c["blue_name"])) == (P.name_key(r["blue"]), P.name_key(r["red"])):
                hit, rd, bd = c, r["blue_decimal"], r["red_decimal"]
        if not hit:
            out["unmatched"].append(f"{r['red']} vs {r['blue']}")
            continue
        conn.execute("INSERT INTO odds(fight_id, provider, bookmaker, red_decimal, blue_decimal, captured_at, source_url, "
                     "created_at) VALUES (?,?,?,?,?,?,?,?)",
                     (hit["id"], "manual", r["bookmaker"], rd, bd, r["captured_at"], r["source_url"], utcnow()))
        out["stored"] += 1
    audit(conn, "odds.manual_import", "odds", None, out, actor=actor)
    conn.commit()
    return out


def ingest_corrections(conn, rows: list[dict], actor: str = "user") -> dict:
    out = {"stored": 0, "unmatched": []}
    for r in rows:
        fid, how = resolve_fighter_by_name(conn, r["name"])
        if fid is None or how == "ambiguous":
            out["unmatched"].append(r["name"])
            continue
        conn.execute("INSERT INTO fighter_corrections(fighter_id, field, value, source_url, note, created_at) "
                     "VALUES (?,?,?,?,?,?)", (fid, r["field"], r["value"], r["source_url"], r.get("note"), utcnow()))
        out["stored"] += 1
    audit(conn, "fighters.corrections", "fighter", None, out, actor=actor)
    conn.commit()
    return out
