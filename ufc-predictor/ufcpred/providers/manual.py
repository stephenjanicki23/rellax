"""Manual import provider: validated JSON/CSV templates for cards, results, odds, corrections.

Templates live in `templates/import/`. Every row is validated; a file with any invalid
row is rejected as a whole with a list of errors, so a half-imported card cannot occur.
"""
from __future__ import annotations

import csv
import io
import json

from ..util import sha256, utcnow
from . import parse as P
from .base import Bundle, PEvent, PFight, SourceMeta

VALID_SEGMENTS = {"main", "prelim", "early_prelim", "unknown"}
VALID_METHODS = {"KO_TKO", "SUB", "DEC", "DQ", "OTHER"}
METHOD_ALIASES = {"KO": "KO_TKO", "TKO": "KO_TKO", "KO/TKO": "KO_TKO", "SUBMISSION": "SUB", "DECISION": "DEC",
                  "U-DEC": "DEC", "S-DEC": "DEC", "M-DEC": "DEC"}


class ValidationError(Exception):
    def __init__(self, errors: list[str]):
        super().__init__("; ".join(errors))
        self.errors = errors


def _bool(v):
    if v is None or v == "":
        return None
    if isinstance(v, bool):
        return v
    s = str(v).strip().lower()
    if s in ("1", "true", "yes", "y"):
        return True
    if s in ("0", "false", "no", "n"):
        return False
    raise ValueError(f"not a boolean: {v!r}")


def manual_event_id(name: str, date: str) -> str:
    return "manual:" + sha256(f"{P.name_key(name)}|{date}")[:16]


def manual_fight_id(event_external_id: str, a: str, b: str) -> str:
    pair = "|".join(sorted([P.name_key(a), P.name_key(b)]))
    return "manual:" + sha256(f"{event_external_id}|{pair}")[:16]


def _rows(text: str, fmt: str) -> list[dict]:
    if fmt == "json":
        data = json.loads(text)
        return data if isinstance(data, list) else [data]
    return list(csv.DictReader(io.StringIO(text)))


def parse_card(text: str, fmt: str = "json", filename: str = "upload") -> Bundle:
    """Parse an event card. JSON: {"event": {...}, "fights": [...]}; CSV: one row per bout."""
    errors: list[str] = []
    if fmt == "json":
        data = json.loads(text)
        ev_raw, fights_raw = data.get("event") or {}, data.get("fights") or []
    else:
        rows = _rows(text, "csv")
        if not rows:
            raise ValidationError(["CSV has no rows"])
        first = rows[0]
        ev_raw = {"name": first.get("event_name"), "date": first.get("event_date"), "venue": first.get("venue"),
                  "location": first.get("location"), "source_url": first.get("source_url"),
                  "start_time_utc": first.get("start_time_utc")}
        fights_raw = rows
        for i, r in enumerate(rows):
            if (r.get("event_name"), r.get("event_date")) != (ev_raw["name"], ev_raw["date"]):
                errors.append(f"row {i + 2}: all rows must belong to one event")

    name = P.norm_name(ev_raw.get("name") or "")
    date = P.parse_long_date(ev_raw.get("date") or "")
    if not name:
        errors.append("event.name is required")
    if not date:
        errors.append("event.date is required (YYYY-MM-DD)")
    if not (ev_raw.get("source_url") or "").strip():
        errors.append("event.source_url is required: record where the card was verified")
    if not fights_raw:
        errors.append("card has no fights")
    if errors and not (name and date):
        raise ValidationError(errors)

    eid = manual_event_id(name, date or "")
    ev = PEvent(eid, name, date or "", location=(ev_raw.get("location") or None), venue=(ev_raw.get("venue") or None),
                start_time_utc=(ev_raw.get("start_time_utc") or None), source_url=ev_raw.get("source_url"))
    fights, seen = [], set()
    for i, f in enumerate(fights_raw):
        tag = f"fight {i + 1}"
        red, blue = P.norm_name(f.get("red") or ""), P.norm_name(f.get("blue") or "")
        if not red or not blue:
            errors.append(f"{tag}: red and blue fighter names are required")
            continue
        if P.name_key(red) == P.name_key(blue):
            errors.append(f"{tag}: a fighter cannot fight themself ({red})")
            continue
        for nm in (red, blue):
            if P.name_key(nm) in seen:
                errors.append(f"{tag}: {nm} appears in more than one bout on this card")
        seen.update({P.name_key(red), P.name_key(blue)})
        wc, title_from_text, is_women = P.parse_weight_class(f.get("weight_class"))
        if f.get("weight_class") and wc is None and "catch" not in str(f.get("weight_class")).lower():
            errors.append(f"{tag}: unknown weight class {f.get('weight_class')!r}")
        try:
            rounds = int(f.get("scheduled_rounds") or 0)
        except ValueError:
            rounds = 0
        if rounds not in (3, 5):
            errors.append(f"{tag}: scheduled_rounds must be 3 or 5")
        seg = (f.get("card_segment") or "unknown").strip()
        if seg not in VALID_SEGMENTS:
            errors.append(f"{tag}: card_segment must be one of {sorted(VALID_SEGMENTS)}")
        try:
            flags = {k: _bool(f.get(k)) for k in ("title_fight", "short_notice_red", "short_notice_blue",
                                                  "weight_miss_red", "weight_miss_blue", "canceled")}
        except ValueError as e:
            errors.append(f"{tag}: {e}")
            continue
        order = f.get("bout_order")
        fights.append(PFight(manual_fight_id(eid, red, blue), eid, red, blue, f.get("red_external_id") or None,
                             f.get("blue_external_id") or None, wc,
                             bool(flags["title_fight"]) or title_from_text, is_women, rounds or None,
                             f"{rounds} Rnd" if rounds else None, seg, int(order) if order not in (None, "") else i + 1,
                             flags["short_notice_red"], flags["short_notice_blue"], flags["weight_miss_red"],
                             flags["weight_miss_blue"], bool(flags["canceled"])))
    if errors:
        raise ValidationError(errors)
    b = Bundle(provider="manual", events=[ev], fights=fights)
    b.sources.append(SourceMeta("manual", f"card:{filename}", ev.source_url, utcnow(), sha256(text), "ok",
                                rows=len(fights)))
    return b


def parse_results(text: str, fmt: str = "json") -> list[dict]:
    """Validate a results file. Rows identify a fight by event date + both fighter names."""
    rows, errors, out = _rows(text, fmt), [], []
    for i, r in enumerate(rows):
        tag = f"result {i + 1}"
        outcome = (r.get("outcome") or "").strip().lower()
        if outcome not in ("win", "draw", "nc"):
            errors.append(f"{tag}: outcome must be win, draw or nc")
            continue
        red, blue = P.norm_name(r.get("red") or ""), P.norm_name(r.get("blue") or "")
        date = P.parse_long_date(r.get("event_date") or "")
        if not (red and blue and date):
            errors.append(f"{tag}: event_date, red and blue are required")
            continue
        winner = P.norm_name(r.get("winner") or "")
        method = (r.get("method") or "").strip().upper()
        method = METHOD_ALIASES.get(method, method)
        if outcome == "win":
            if P.name_key(winner) not in (P.name_key(red), P.name_key(blue)):
                errors.append(f"{tag}: winner must be the red or blue fighter")
            if method not in VALID_METHODS:
                errors.append(f"{tag}: method must be one of {sorted(VALID_METHODS)}")
        rnd = P.parse_int(r.get("round"))
        t = P.parse_clock(r.get("time"))
        if rnd is not None and not 1 <= rnd <= 5:
            errors.append(f"{tag}: round must be 1-5")
        if t is not None and t > 300:
            errors.append(f"{tag}: time must be within a 5:00 round")
        if outcome == "win" and method in ("KO_TKO", "SUB") and (rnd is None or t is None):
            errors.append(f"{tag}: finishes need round and time")
        if not (r.get("source_url") or "").strip():
            errors.append(f"{tag}: source_url is required for an official result")
        out.append({"event_date": date, "red": red, "blue": blue, "outcome": outcome,
                    "winner": winner or None, "method": method if outcome == "win" else outcome.upper(),
                    "method_detail": r.get("method_detail") or None, "end_round": rnd, "end_time_sec": t,
                    "details": r.get("details") or None, "source_url": (r.get("source_url") or "").strip(),
                    "reason": r.get("reason") or None})
    if errors:
        raise ValidationError(errors)
    return out


def parse_odds(text: str, fmt: str = "csv") -> list[dict]:
    rows, errors, out = _rows(text, fmt), [], []
    for i, r in enumerate(rows):
        tag = f"odds {i + 1}"
        try:
            kind = (r.get("format") or "american").strip().lower()
            ro, bo = float(r["red_odds"]), float(r["blue_odds"])
            if kind == "american":
                ro, bo = P.american_to_decimal(ro), P.american_to_decimal(bo)
            if ro <= 1 or bo <= 1:
                raise ValueError("decimal odds must exceed 1.0")
        except (KeyError, ValueError, TypeError) as e:
            errors.append(f"{tag}: {e}")
            continue
        date = P.parse_long_date(r.get("event_date") or "")
        if not date:
            errors.append(f"{tag}: event_date required")
            continue
        out.append({"event_date": date, "red": P.norm_name(r.get("red", "")), "blue": P.norm_name(r.get("blue", "")),
                    "red_decimal": ro, "blue_decimal": bo, "bookmaker": r.get("bookmaker") or None,
                    "captured_at": r.get("captured_at") or utcnow(), "source_url": r.get("source_url") or None})
    if errors:
        raise ValidationError(errors)
    return out


CORRECTABLE = {"dob", "height_in", "reach_in", "stance"}


def parse_corrections(text: str, fmt: str = "csv") -> list[dict]:
    rows, errors, out = _rows(text, fmt), [], []
    for i, r in enumerate(rows):
        field = (r.get("field") or "").strip()
        if field not in CORRECTABLE:
            errors.append(f"correction {i + 1}: field must be one of {sorted(CORRECTABLE)}")
            continue
        if not (r.get("source_url") or "").strip():
            errors.append(f"correction {i + 1}: source_url is required")
            continue
        out.append({"name": P.norm_name(r.get("name", "")), "field": field, "value": r.get("value"),
                    "source_url": r["source_url"].strip(), "note": r.get("note")})
    if errors:
        raise ValidationError(errors)
    return out
