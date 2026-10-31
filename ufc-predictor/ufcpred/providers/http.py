"""Polite HTTP fetching: robots.txt, rate limiting, on-disk cache, source records.

This is the only module that performs outbound HTTP for data providers.
"""
from __future__ import annotations

import re
import time
import urllib.robotparser
from pathlib import Path
from urllib.parse import urlparse

from ..util import sha256, utcnow
from .base import ProviderError, ProviderUnavailable, SourceMeta

USER_AGENT = "ufcpred/0.1 (research; respects robots.txt; contact: repository owner)"
_last_request: dict[str, float] = {}
_robots: dict[str, urllib.robotparser.RobotFileParser | None] = {}


def cache_dir() -> Path:
    from ..db import data_dir
    p = data_dir() / "cache"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _get(url: str, timeout: float) -> tuple[int, str]:
    """GET with the standard library (honours HTTPS_PROXY and the system CA store)."""
    import urllib.error
    import urllib.request
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, ""


def robots_allows(url: str, check_robots: bool = True) -> bool:
    if not check_robots:
        return True
    parsed = urlparse(url)
    base = f"{parsed.scheme}://{parsed.netloc}"
    if base not in _robots:
        rp = urllib.robotparser.RobotFileParser()
        try:
            code, body = _get(base + "/robots.txt", 15)
            if code == 200:
                rp.parse(body.splitlines())
                _robots[base] = rp
            else:
                _robots[base] = None     # no robots file: no stated restriction
        except Exception:
            _robots[base] = None
    rp = _robots[base]
    return True if rp is None else rp.can_fetch(USER_AGENT, url)


_SECRET_PARAMS = re.compile(r"((?:api_?key|apikey|key|token|secret|password)=)[^&#]*", re.I)


def redact(url: str) -> str:
    """The URL with credential-looking query values masked, for messages and stored metadata."""
    return _SECRET_PARAMS.sub(r"\1***", url or "")


def fetch(url: str, provider: str, resource: str, *, min_interval_s: float = 2.0,
          max_age_s: float | None = None, check_robots: bool = True, timeout: float = 60,
          license: str | None = None) -> tuple[str, SourceMeta]:
    """Fetch text with caching. On network failure a cached copy is returned and marked stale."""
    cache = cache_dir() / provider / (resource.replace("/", "_"))
    if max_age_s is not None and cache.exists() and time.time() - cache.stat().st_mtime < max_age_s:
        text = cache.read_text()
        return text, SourceMeta(provider, resource, redact(url), utcnow(), sha256(text), "cached", None, None, str(cache),
                                license=license)
    if not robots_allows(url, check_robots):
        raise ProviderError(f"robots.txt disallows {redact(url)}")
    host = urlparse(url).netloc
    wait = min_interval_s - (time.time() - _last_request.get(host, 0))
    if wait > 0:
        time.sleep(wait)
    try:
        _last_request[host] = time.time()
        code, text = _get(url, timeout)
        if code != 200:
            raise ProviderError(f"HTTP {code} for {redact(url)}")
    except ProviderError:
        raise
    except Exception as e:  # network failure
        if cache.exists():
            text = cache.read_text()
            return text, SourceMeta(provider, resource, redact(url), utcnow(), sha256(text), "stale", None,
                                    f"network failure, served cache: {redact(str(e))}", str(cache), license=license)
        raise ProviderUnavailable(f"cannot reach {redact(url)}: {redact(str(e))}",
                                  "network access to the provider host (see Settings → Data providers)") from e
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(text)
    return text, SourceMeta(provider, resource, redact(url), utcnow(), sha256(text), "ok", 200, None, str(cache),
                            license=license)
