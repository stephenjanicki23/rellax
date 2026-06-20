"""Thin wrapper around The Odds API v4."""

import time
import requests
from config import ODDS_API_KEY, ODDS_API_BASE, REGIONS, MARKETS


class OddsAPIError(Exception):
    pass


class OddsClient:
    def __init__(self, api_key: str = ODDS_API_KEY):
        if not api_key:
            raise OddsAPIError(
                "ODDS_API_KEY is not set. Get a free key at https://the-odds-api.com"
            )
        self.api_key = api_key
        self.session = requests.Session()
        self.session.params = {"apiKey": api_key}  # type: ignore[assignment]

    def _get(self, path: str, params: dict | None = None) -> dict | list:
        url = f"{ODDS_API_BASE}{path}"
        resp = self.session.get(url, params=params or {}, timeout=15)
        remaining = resp.headers.get("x-requests-remaining", "?")
        used = resp.headers.get("x-requests-used", "?")
        if resp.status_code == 401:
            raise OddsAPIError("Invalid API key.")
        if resp.status_code == 404:
            raise OddsAPIError(f"Sport not found — key may be unavailable or off-season.")
        if resp.status_code == 422:
            raise OddsAPIError(f"Sport key not supported by your subscription.")
        if resp.status_code == 429:
            raise OddsAPIError(f"Rate limit hit. Remaining quota: {remaining}")
        if not resp.ok:
            raise OddsAPIError(f"API error {resp.status_code}: {resp.text[:200]}")
        print(f"  [API] {path} — quota used: {used}, remaining: {remaining}")
        return resp.json()

    def get_odds(self, sport_key: str) -> list[dict]:
        """Return current odds for all games in a sport."""
        data = self._get(
            f"/sports/{sport_key}/odds",
            {
                "regions": REGIONS,
                "markets": MARKETS,
                "oddsFormat": "decimal",
            },
        )
        return data  # type: ignore[return-value]

    def get_sports(self) -> list[dict]:
        """List all available sports (useful for discovery)."""
        return self._get("/sports")  # type: ignore[return-value]
