"""Small shared helpers: time, canonical JSON and hashing."""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
from typing import Any


def utcnow() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def parse_date(value: str) -> dt.date:
    return dt.date.fromisoformat(value[:10])


def days_between(a: str, b: str) -> int:
    return (parse_date(b) - parse_date(a)).days


def _default(o: Any):
    if isinstance(o, float) and (math.isnan(o) or math.isinf(o)):
        return None
    if hasattr(o, "tolist"):
        return o.tolist()
    if hasattr(o, "item"):
        return o.item()
    if isinstance(o, (dt.date, dt.datetime)):
        return o.isoformat()
    raise TypeError(f"not JSON serializable: {type(o)}")


def _clean(o: Any):
    """Replace NaN/inf with None so canonical JSON is valid and stable."""
    if isinstance(o, float):
        return None if (math.isnan(o) or math.isinf(o)) else o
    if isinstance(o, dict):
        return {str(k): _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if hasattr(o, "tolist"):
        return _clean(o.tolist())
    return o


def dumps(o: Any) -> str:
    return json.dumps(_clean(o), sort_keys=True, separators=(",", ":"), default=_default)


def loads(s: str | None, default: Any = None) -> Any:
    if s is None:
        return default
    return json.loads(s)


def sha256(text: str | bytes) -> str:
    if isinstance(text, str):
        text = text.encode()
    return hashlib.sha256(text).hexdigest()


def sigmoid(z: float) -> float:
    if z >= 0:
        return 1.0 / (1.0 + math.exp(-z))
    e = math.exp(z)
    return e / (1.0 + e)


def logit(p: float, eps: float = 1e-6) -> float:
    p = min(max(p, eps), 1 - eps)
    return math.log(p / (1 - p))
