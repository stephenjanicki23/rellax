"""Parsing helpers for UFCStats-formatted values. Unknown values become None, never 0."""
from __future__ import annotations

import datetime as dt
import re
from typing import Optional

WEIGHT_LIMITS = {
    "Strawweight": 115, "Flyweight": 125, "Bantamweight": 135, "Featherweight": 145,
    "Lightweight": 155, "Welterweight": 170, "Middleweight": 185, "Light Heavyweight": 205,
    "Heavyweight": 265,
}
CLASS_ORDER = list(WEIGHT_LIMITS)


def norm_name(name: str) -> str:
    return re.sub(r"\s+", " ", (name or "").strip())


def name_key(name: str) -> str:
    import unicodedata
    s = unicodedata.normalize("NFKD", norm_name(name)).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9 ]", "", s.lower()).strip()


def parse_weight_class(raw: str | None) -> tuple[Optional[str], bool, bool]:
    """Return (canonical class, is_title, is_women). Class is None for catch/open weight."""
    if not raw:
        return None, False, False
    s = raw.strip()
    is_title = "Title" in s
    is_women = s.startswith("Women") or "Women's" in s
    for cls in sorted(WEIGHT_LIMITS, key=len, reverse=True):
        if cls in s:
            return (("Women's " if is_women else "") + cls), is_title, is_women
    return None, is_title, is_women


def class_limit(weight_class: str | None) -> Optional[int]:
    if not weight_class:
        return None
    return WEIGHT_LIMITS.get(weight_class.replace("Women's ", ""))


def parse_time_format(raw: str | None) -> Optional[int]:
    """Scheduled rounds for standard formats; None for non-standard/legacy formats."""
    if not raw:
        return None
    m = re.match(r"^\s*(\d) Rnd \((5-)*5\)\s*$", raw)
    if m:
        return int(m.group(1))
    return None


def parse_clock(raw: str | None) -> Optional[int]:
    if raw is None:
        return None
    s = str(raw).strip()
    m = re.match(r"^(\d+):(\d{2})$", s)
    if not m:
        return None
    return int(m.group(1)) * 60 + int(m.group(2))


def parse_of(raw: str | None) -> tuple[Optional[int], Optional[int]]:
    if raw is None:
        return None, None
    m = re.match(r"^\s*(\d+)\s+of\s+(\d+)\s*$", str(raw))
    if not m:
        return None, None
    return int(m.group(1)), int(m.group(2))


def parse_int(raw) -> Optional[int]:
    if raw is None:
        return None
    s = str(raw).strip()
    if s in ("", "--", "---", "nan"):
        return None
    try:
        return int(float(s))
    except ValueError:
        return None


def parse_height(raw: str | None) -> Optional[float]:
    if not raw:
        return None
    m = re.match(r"^\s*(\d+)'\s*(\d+)\"?\s*$", raw.strip())
    if not m:
        return None
    return int(m.group(1)) * 12 + int(m.group(2))


def parse_reach(raw: str | None) -> Optional[float]:
    if not raw:
        return None
    m = re.match(r"^\s*(\d+(?:\.\d+)?)\"?\s*$", raw.strip())
    return float(m.group(1)) if m else None


def parse_lbs(raw: str | None) -> Optional[float]:
    if not raw:
        return None
    m = re.match(r"^\s*(\d+(?:\.\d+)?)\s*lbs", raw.strip())
    return float(m.group(1)) if m else None


def parse_long_date(raw: str | None) -> Optional[str]:
    if not raw:
        return None
    s = raw.strip()
    for fmt in ("%B %d, %Y", "%b %d, %Y", "%Y-%m-%d"):
        try:
            return dt.datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def parse_method(raw: str | None, outcome: str) -> tuple[Optional[str], Optional[str]]:
    """Map a UFCStats method string to (method class, detail)."""
    s = (raw or "").strip()
    if outcome == "nc":
        return "NC", s or None
    if outcome == "draw":
        return "DRAW", s or None
    if s.startswith("KO/TKO") or s.startswith("TKO"):
        return "KO_TKO", s
    if s.startswith("Submission"):
        return "SUB", s
    if s.startswith("Decision"):
        return "DEC", s
    if s == "DQ":
        return "DQ", s
    return "OTHER", s or None


def ufcstats_id(url: str | None) -> Optional[str]:
    if not url:
        return None
    m = re.search(r"/(event|fight|fighter)-details/([0-9a-f]+)", url)
    return f"ufcstats:{m.group(2)}" if m else None


def american_to_decimal(american: float) -> float:
    a = float(american)
    if a >= 100:
        return 1 + a / 100
    if a <= -100:
        return 1 + 100 / abs(a)
    raise ValueError(f"invalid American odds {american}")
