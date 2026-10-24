"""Odds providers and bookmaker-margin removal.

No odds source is configured by default. `TheOddsAPIProvider` needs `ODDS_API_KEY`
(https://the-odds-api.com, sport key `mma_mixed_martial_arts`); its free tier serves current
odds only, so historical training of the market model needs imported odds.
"""
from __future__ import annotations

import json
import os

from ..util import utcnow
from . import parse as P
from .base import Bundle, OddsProvider, POdds, ProviderError, ProviderUnavailable
from .http import fetch


def devig(red_decimal: float, blue_decimal: float, method: str = "proportional") -> tuple[float, float, float]:
    """Implied probabilities with the overround removed. Returns (p_red, p_blue, overround)."""
    ir, ib = 1 / red_decimal, 1 / blue_decimal
    over = ir + ib
    if method == "power":
        # find k with ir**k + ib**k == 1 (bisection); treats longshot bias better than proportional
        lo, hi = 0.5, 3.0
        for _ in range(60):
            k = (lo + hi) / 2
            s = ir ** k + ib ** k
            lo, hi = (k, hi) if s > 1 else (lo, k)
        k = (lo + hi) / 2
        return ir ** k, ib ** k, over - 1
    return ir / over, ib / over, over - 1


class TheOddsAPIProvider(OddsProvider):
    name = "the_odds_api"
    URL = "https://api.the-odds-api.com/v4/sports/mma_mixed_martial_arts/odds"

    def __init__(self, api_key: str | None = None):
        self.api_key = api_key or os.environ.get("ODDS_API_KEY")

    def fetch_odds(self, fights: list[dict]) -> Bundle:
        if not self.api_key:
            raise ProviderUnavailable("The Odds API key is not configured", "set ODDS_API_KEY")
        url = f"{self.URL}?regions=us&markets=h2h&oddsFormat=decimal&apiKey={self.api_key}"
        text, meta = fetch(url, self.name, "mma_odds.json", min_interval_s=5, max_age_s=900, check_robots=False)
        meta.url = self.URL  # never store the key
        try:
            games = json.loads(text)
        except ValueError as e:
            raise ProviderError(f"odds payload not JSON: {e}") from e
        b = Bundle(provider=self.name, sources=[meta])
        index = {}
        for f in fights:
            index[frozenset((P.name_key(f["red_name"]), P.name_key(f["blue_name"])))] = f
        for g in games:
            key = frozenset((P.name_key(g.get("home_team", "")), P.name_key(g.get("away_team", ""))))
            f = index.get(key)
            if not f:
                continue
            for bm in g.get("bookmakers", []):
                for mk in bm.get("markets", []):
                    if mk.get("key") != "h2h":
                        continue
                    prices = {P.name_key(o["name"]): o["price"] for o in mk.get("outcomes", [])}
                    r, bl = prices.get(P.name_key(f["red_name"])), prices.get(P.name_key(f["blue_name"]))
                    if r and bl:
                        b.odds.append(POdds(f["external_id"], float(r), float(bl), bm.get("last_update") or utcnow(),
                                            bm.get("key"), self.URL))
        return b
