"""Manual import provider: validated JSON/CSV templates for game nights, results, odds and availability.

Templates live in `templates/import/`. Every row is validated; a file with any invalid row is
rejected as a whole with a list of errors, so a half-imported night cannot occur.
"""
from __future__ import annotations

import csv
import io
import json

from .. import teams as T
from ..util import sha256, utcnow
from .base import Bundle, PGame, PTeam, SourceMeta

VALID_TYPES = {"regular", "playin", "playoffs", "cup_final", "preseason"}


class ValidationError(Exception):
    def __init__(self, errors: list[str]):
        super().__init__("; ".join(errors))
        self.errors = errors


def _rows(text: str, fmt: str) -> list[dict]:
    if fmt == "json":
        data = json.loads(text)
        return data if isinstance(data, list) else [data]
    return list(csv.DictReader(io.StringIO(text)))


def _date(v) -> str | None:
    import datetime as dt
    s = str(v or "").strip()[:10]
    try:
        return dt.date.fromisoformat(s).isoformat()
    except ValueError:
        return None


def _int_or_none(v, tag, field, errors, lo=0, hi=15):
    if v in (None, "", "unknown"):
        return None
    try:
        n = int(v)
    except (TypeError, ValueError):
        errors.append(f"{tag}: {field} must be a whole number or blank")
        return None
    if not lo <= n <= hi:
        errors.append(f"{tag}: {field} must be between {lo} and {hi}")
        return None
    return n


def _bool(v):
    if v in (None, ""):
        return False
    if isinstance(v, bool):
        return v
    return str(v).strip().lower() in ("1", "true", "yes", "y")


def _team(name: str, tag: str, errors: list[str]) -> tuple[str | None, str | None]:
    tid = T.lookup(name or "")
    if tid is None:
        errors.append(f"{tag}: unknown team {name!r} (use the team name or abbreviation, e.g. 'BOS')")
        return None, None
    return T.external_id(tid), T.TEAMS[tid][1]


def manual_game_id(date: str, home_ext: str, away_ext: str) -> str:
    return "manual:" + sha256(f"{date}|{home_ext}|{away_ext}")[:16]


def parse_card(text: str, fmt: str = "json", filename: str = "upload") -> Bundle:
    """A game night. JSON: {"night": {"date", "source_url"}, "games": [...]}; CSV: one row per game."""
    errors: list[str] = []
    if fmt == "json":
        data = json.loads(text)
        ev, games_raw = data.get("night") or data.get("event") or {}, data.get("games") or []
    else:
        rows = _rows(text, "csv")
        if not rows:
            raise ValidationError(["CSV has no rows"])
        ev = {"date": rows[0].get("date"), "source_url": rows[0].get("source_url")}
        games_raw = rows
        for i, r in enumerate(rows):
            if r.get("date") != ev["date"]:
                errors.append(f"row {i + 2}: all rows must belong to one night (same date)")
    date = _date(ev.get("date"))
    if not date:
        errors.append("night.date is required (YYYY-MM-DD, US local date)")
    if not (ev.get("source_url") or "").strip():
        errors.append("night.source_url is required: record where the schedule was verified")
    if not games_raw:
        errors.append("the night has no games")
    if errors and not date:
        raise ValidationError(errors)
    b = Bundle(provider="manual")
    seen_team: set[str] = set()
    for i, g in enumerate(games_raw):
        tag = f"game {i + 1}"
        hx, hn = _team(g.get("home"), tag, errors)
        ax, an = _team(g.get("away"), tag, errors)
        if not hx or not ax:
            continue
        if hx == ax:
            errors.append(f"{tag}: a team cannot play itself ({hn})")
            continue
        for x, n in ((hx, hn), (ax, an)):
            if x in seen_team:
                errors.append(f"{tag}: {n} appears in more than one game on this night")
            seen_team.add(x)
        stype = (g.get("season_type") or "regular").strip()
        if stype not in VALID_TYPES:
            errors.append(f"{tag}: season_type must be one of {sorted(VALID_TYPES)}")
        tip = (g.get("tip_time_utc") or "").strip() or None
        if tip and not (len(tip) >= 16 and tip[4] == "-" and "T" in tip):
            errors.append(f"{tag}: tip_time_utc must look like 2026-11-18T00:30:00Z")
        city = (g.get("venue_city") or "").strip() or None
        neutral = _bool(g.get("neutral_site"))
        if city and city not in T.NEUTRAL_VENUES:
            errors.append(f"{tag}: venue_city must be one of {sorted(T.NEUTRAL_VENUES)} or blank")
        h_out = _int_or_none(g.get("home_out"), tag, "home_out", errors)
        a_out = _int_or_none(g.get("away_out"), tag, "away_out", errors)
        for x, n in ((hx, hn), (ax, an)):
            tid = T.nba_id(x)
            ref = T.TEAMS[tid]
            if not any(t.external_id == x for t in b.teams):
                b.teams.append(PTeam(x, n, ref[0], ref[2], ref[3]))
        b.games.append(PGame(manual_game_id(date or "", hx, ax), date or "", hn, an, hx, ax, T.season_of(date or "2000-01-01"),
                             stype, neutral or bool(city), city, tip, h_out, a_out,
                             "canceled" if _bool(g.get("canceled")) else "scheduled", ev.get("source_url")))
    if errors:
        raise ValidationError(errors)
    b.sources.append(SourceMeta("manual", f"card:{filename}", ev.get("source_url"), utcnow(), sha256(text), "ok",
                                rows=len(b.games)))
    return b


def _match_fields(r: dict, tag: str, errors: list[str]) -> tuple[str | None, int | None, int | None]:
    date = _date(r.get("date"))
    if not date:
        errors.append(f"{tag}: date is required (YYYY-MM-DD)")
    hid, aid = T.lookup(r.get("home") or ""), T.lookup(r.get("away") or "")
    if hid is None or aid is None:
        errors.append(f"{tag}: home and away must be known teams")
    return date, hid, aid


def parse_results(text: str, fmt: str = "csv") -> list[dict]:
    """Final scores. Rows identify a game by date + home + away."""
    rows, errors, out = _rows(text, fmt), [], []
    for i, r in enumerate(rows):
        tag = f"result {i + 1}"
        date, hid, aid = _match_fields(r, tag, errors)
        outcome = (r.get("outcome") or "win").strip().lower()
        if outcome not in ("win", "nc"):
            errors.append(f"{tag}: outcome must be win (a final score) or nc (abandoned/forfeit)")
        hs = _int_or_none(r.get("home_score"), tag, "home_score", errors, 0, 250)
        as_ = _int_or_none(r.get("away_score"), tag, "away_score", errors, 0, 250)
        periods = _int_or_none(r.get("periods") or 4, tag, "periods", errors, 4, 10)
        if outcome == "win" and (hs is None or as_ is None):
            errors.append(f"{tag}: a final needs home_score and away_score")
        elif outcome == "win" and hs == as_:
            errors.append(f"{tag}: NBA games cannot end tied")
        if not (r.get("source_url") or "").strip():
            errors.append(f"{tag}: source_url is required for an official result")
        out.append({"date": date, "home_id": hid, "away_id": aid, "outcome": outcome, "home_score": hs,
                    "away_score": as_, "periods": periods or 4, "source_url": (r.get("source_url") or "").strip(),
                    "reason": r.get("reason") or None})
    if errors:
        raise ValidationError(errors)
    return out


def american_to_decimal(a: float) -> float:
    a = float(a)
    if a >= 100:
        return 1 + a / 100
    if a <= -100:
        return 1 + 100 / abs(a)
    raise ValueError(f"invalid American odds {a}")


def parse_odds(text: str, fmt: str = "csv") -> list[dict]:
    """Lines: moneyline (home/away), spread (home points and prices) and total. Any part may be blank."""
    rows, errors, out = _rows(text, fmt), [], []
    for i, r in enumerate(rows):
        tag = f"odds {i + 1}"
        date, hid, aid = _match_fields(r, tag, errors)
        kind = (r.get("format") or "american").strip().lower()

        def price(k):
            v = r.get(k)
            if v in (None, ""):
                return None
            try:
                d = american_to_decimal(float(v)) if kind == "american" else float(v)
            except ValueError as e:
                errors.append(f"{tag}: {k}: {e}")
                return None
            if d <= 1:
                errors.append(f"{tag}: {k}: decimal odds must exceed 1.0")
                return None
            return d

        def num(k):
            v = r.get(k)
            if v in (None, ""):
                return None
            try:
                return float(v)
            except ValueError:
                errors.append(f"{tag}: {k} must be a number")
                return None
        row = {"date": date, "home_id": hid, "away_id": aid, "home_decimal": price("home_ml"),
               "away_decimal": price("away_ml"), "spread_home": num("spread_home"),
               "spread_home_decimal": price("spread_home_price"), "spread_away_decimal": price("spread_away_price"),
               "total": num("total"), "over_decimal": price("over_price"), "under_decimal": price("under_price"),
               "bookmaker": r.get("bookmaker") or None, "captured_at": r.get("captured_at") or utcnow(),
               "source_url": r.get("source_url") or None}
        if (row["home_decimal"] is None) != (row["away_decimal"] is None):
            errors.append(f"{tag}: give both moneylines or neither")
        if all(row[k] is None for k in ("home_decimal", "spread_home", "total")):
            errors.append(f"{tag}: no moneyline, spread or total given")
        out.append(row)
    if errors:
        raise ValidationError(errors)
    return out


def parse_availability(text: str, fmt: str = "csv") -> list[dict]:
    """Injury-report counts: how many rotation players each team has ruled out for a game."""
    rows, errors, out = _rows(text, fmt), [], []
    for i, r in enumerate(rows):
        tag = f"availability {i + 1}"
        date, hid, aid = _match_fields(r, tag, errors)
        h = _int_or_none(r.get("home_out"), tag, "home_out", errors)
        a = _int_or_none(r.get("away_out"), tag, "away_out", errors)
        if not (r.get("source_url") or "").strip():
            errors.append(f"{tag}: source_url is required (e.g. the official injury report)")
        out.append({"date": date, "home_id": hid, "away_id": aid, "home_out": h, "away_out": a,
                    "source_url": (r.get("source_url") or "").strip(), "note": r.get("note")})
    if errors:
        raise ValidationError(errors)
    return out
