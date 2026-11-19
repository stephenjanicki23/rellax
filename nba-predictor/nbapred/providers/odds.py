"""Odds providers and bookmaker-margin removal.

`TheOddsAPIProvider` needs `ODDS_API_KEY` (https://the-odds-api.com, sport key `basketball_nba`,
markets h2h / spreads / totals). ESPN's scoreboard lines are read by `providers/espn.py`. Odds are
comparison data: the engine only uses them as Model F when a candidate with odds history is adopted.
"""
from __future__ import annotations

import json
import os

from .. import teams as T
from ..util import utcnow
from .base import Bundle, OddsProvider, POdds, ProviderError, ProviderUnavailable
from .http import fetch


def devig(home_decimal: float, away_decimal: float, method: str = "proportional") -> tuple[float, float, float]:
    """Implied probabilities with the overround removed. Returns (p_home, p_away, overround)."""
    ih, ia = 1 / home_decimal, 1 / away_decimal
    over = ih + ia
    if method == "power":
        lo, hi = 0.5, 3.0
        for _ in range(60):
            k = (lo + hi) / 2
            s = ih ** k + ia ** k
            lo, hi = (k, hi) if s > 1 else (lo, k)
        k = (lo + hi) / 2
        return ih ** k, ia ** k, over - 1
    return ih / over, ia / over, over - 1


class TheOddsAPIProvider(OddsProvider):
    name = "the_odds_api"
    URL = "https://api.the-odds-api.com/v4/sports/basketball_nba/odds"

    def __init__(self, api_key: str | None = None, bookmakers: list[str] | None = None,
                 markets: str = "h2h,spreads"):
        self.api_key = api_key or os.environ.get("ODDS_API_KEY")
        self.markets = ",".join(m.strip() for m in markets.split(",") if m.strip()) or "h2h"
        self.bookmakers = [b for b in (bookmakers or []) if b]
        self.seen_bookmakers: dict[str, str] = {}

    def fetch_odds(self, games: list[dict]) -> Bundle:
        """games: [{"external_id", "home_name", "away_name"}] for unplayed games."""
        if not self.api_key:
            raise ProviderUnavailable("The Odds API key is not configured", "set ODDS_API_KEY")
        scope = f"bookmakers={','.join(self.bookmakers)}" if self.bookmakers else "regions=us"
        url = f"{self.URL}?{scope}&markets={self.markets}&oddsFormat=decimal&apiKey={self.api_key}"
        resource = "nba_odds_" + ("_".join(self.bookmakers) or "us") + ".json"
        text, meta = fetch(url, self.name, resource, min_interval_s=5, max_age_s=900, check_robots=False)
        meta.url = self.URL  # never store the key
        try:
            data = json.loads(text)
        except ValueError as e:
            raise ProviderError(f"odds payload not JSON: {e}") from e
        if not isinstance(data, list):
            raise ProviderError(f"unexpected odds payload: {str(data)[:200]}")
        return parse_the_odds_api(data, games, self.bookmakers, self.seen_bookmakers, meta)


def parse_the_odds_api(data: list, games: list[dict], bookmakers=None, seen=None, meta=None) -> Bundle:
    b = Bundle(provider="the_odds_api", sources=[meta] if meta else [])
    index = {(T.lookup(g["home_name"]), T.lookup(g["away_name"])): g for g in games}
    for ev in data:
        hid, aid = T.lookup(ev.get("home_team", "")), T.lookup(ev.get("away_team", ""))
        g = index.get((hid, aid))
        if not g:
            continue
        for bm in ev.get("bookmakers", []):
            if seen is not None:
                seen[bm.get("key", "")] = bm.get("title") or bm.get("key", "")
            if bookmakers and bm.get("key") not in bookmakers:
                continue
            o = POdds(g["external_id"], bm.get("last_update") or utcnow(), bookmaker=bm.get("title") or bm.get("key"),
                      source_url=TheOddsAPIProvider.URL)
            for mk in bm.get("markets", []):
                outs = mk.get("outcomes", [])
                if mk.get("key") == "h2h":
                    for x in outs:
                        if T.lookup(x.get("name", "")) == hid:
                            o.home_decimal = float(x["price"])
                        elif T.lookup(x.get("name", "")) == aid:
                            o.away_decimal = float(x["price"])
                elif mk.get("key") == "spreads":
                    for x in outs:
                        if T.lookup(x.get("name", "")) == hid:
                            o.spread_home, o.spread_home_decimal = float(x["point"]), float(x["price"])
                        elif T.lookup(x.get("name", "")) == aid:
                            o.spread_away_decimal = float(x["price"])
                elif mk.get("key") == "totals":
                    for x in outs:
                        if x.get("name") == "Over":
                            o.total, o.over_decimal = float(x["point"]), float(x["price"])
                        elif x.get("name") == "Under":
                            o.under_decimal = float(x["price"])
            if (o.home_decimal is None) != (o.away_decimal is None):
                o.home_decimal = o.away_decimal = None
            if any(v is not None for v in (o.home_decimal, o.spread_home, o.total)):
                b.odds.append(o)
    return b
