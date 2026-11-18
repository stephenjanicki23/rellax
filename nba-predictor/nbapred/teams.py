"""Static reference data for the 30 NBA franchises: identities, name aliases and arena locations.

Identity is the NBA's own team id (stable across relocations and renames, e.g. New Jersey → Brooklyn
Nets, Charlotte Bobcats → Hornets, New Orleans Hornets → Pelicans). Aliases cover the abbreviations
and names used by NBA.com data and by ESPN.

Arena coordinates and elevations are approximate (city level is enough for travel distance and
altitude). Time-zone offsets are standard time (no daylight saving), used only for "time zones
crossed".
"""
from __future__ import annotations

import math
import re
import unicodedata

# nba id: (abbr, name, conference, division, aliases, (lat, lon), elevation m, utc offset)
TEAMS: dict[int, tuple] = {
    1610612737: ("ATL", "Atlanta Hawks", "East", "Southeast", ["ATL", "Atlanta", "Hawks"], (33.757, -84.396), 300, -5),
    1610612738: ("BOS", "Boston Celtics", "East", "Atlantic", ["BOS", "Boston", "Celtics"], (42.366, -71.062), 5, -5),
    1610612751: ("BKN", "Brooklyn Nets", "East", "Atlantic", ["BKN", "BRK", "NJN", "NJ", "New Jersey Nets", "Brooklyn",
                                                             "Nets"], (40.683, -73.976), 10, -5),
    1610612766: ("CHA", "Charlotte Hornets", "East", "Southeast", ["CHA", "CHO", "Charlotte Bobcats", "Charlotte",
                                                                  "Bobcats"], (35.225, -80.839), 230, -5),
    1610612741: ("CHI", "Chicago Bulls", "East", "Central", ["CHI", "Chicago", "Bulls"], (41.881, -87.674), 180, -6),
    1610612739: ("CLE", "Cleveland Cavaliers", "East", "Central", ["CLE", "Cleveland", "Cavaliers", "Cavs"],
                 (41.497, -81.688), 200, -5),
    1610612742: ("DAL", "Dallas Mavericks", "West", "Southwest", ["DAL", "Dallas", "Mavericks", "Mavs"],
                 (32.790, -96.810), 140, -6),
    1610612743: ("DEN", "Denver Nuggets", "West", "Northwest", ["DEN", "Denver", "Nuggets"], (39.749, -105.008), 1609, -7),
    1610612765: ("DET", "Detroit Pistons", "East", "Central", ["DET", "Detroit", "Pistons"], (42.341, -83.055), 190, -5),
    1610612744: ("GSW", "Golden State Warriors", "West", "Pacific", ["GSW", "GS", "Golden State", "Warriors"],
                 (37.768, -122.388), 5, -8),
    1610612745: ("HOU", "Houston Rockets", "West", "Southwest", ["HOU", "Houston", "Rockets"], (29.751, -95.362), 15, -6),
    1610612754: ("IND", "Indiana Pacers", "East", "Central", ["IND", "Indiana", "Pacers"], (39.764, -86.155), 220, -5),
    1610612746: ("LAC", "LA Clippers", "West", "Pacific", ["LAC", "Los Angeles Clippers", "LA Clippers", "Clippers"],
                 (33.945, -118.343), 30, -8),
    1610612747: ("LAL", "Los Angeles Lakers", "West", "Pacific", ["LAL", "LA Lakers", "Lakers"], (34.043, -118.267), 90, -8),
    1610612763: ("MEM", "Memphis Grizzlies", "West", "Southwest", ["MEM", "Memphis", "Grizzlies"], (35.138, -90.051), 80, -6),
    1610612748: ("MIA", "Miami Heat", "East", "Southeast", ["MIA", "Miami", "Heat"], (25.781, -80.188), 2, -5),
    1610612749: ("MIL", "Milwaukee Bucks", "East", "Central", ["MIL", "Milwaukee", "Bucks"], (43.045, -87.917), 190, -6),
    1610612750: ("MIN", "Minnesota Timberwolves", "West", "Northwest", ["MIN", "Minnesota", "Timberwolves", "Wolves"],
                 (44.979, -93.276), 260, -6),
    1610612740: ("NOP", "New Orleans Pelicans", "West", "Southwest", ["NOP", "NO", "NOH", "New Orleans Hornets",
                                                                     "New Orleans", "Pelicans"], (29.949, -90.082), 1, -6),
    1610612752: ("NYK", "New York Knicks", "East", "Atlantic", ["NYK", "NY", "New York", "Knicks"], (40.751, -73.993), 10, -5),
    1610612760: ("OKC", "Oklahoma City Thunder", "West", "Northwest", ["OKC", "Oklahoma City", "Thunder"],
                 (35.463, -97.515), 365, -6),
    1610612753: ("ORL", "Orlando Magic", "East", "Southeast", ["ORL", "Orlando", "Magic"], (28.539, -81.384), 30, -5),
    1610612755: ("PHI", "Philadelphia 76ers", "East", "Atlantic", ["PHI", "Philadelphia", "76ers", "Sixers"],
                 (39.901, -75.172), 10, -5),
    1610612756: ("PHX", "Phoenix Suns", "West", "Pacific", ["PHX", "PHO", "Phoenix", "Suns"], (33.446, -112.071), 330, -7),
    1610612757: ("POR", "Portland Trail Blazers", "West", "Northwest", ["POR", "Portland", "Trail Blazers", "Blazers"],
                 (45.532, -122.667), 15, -8),
    1610612758: ("SAC", "Sacramento Kings", "West", "Pacific", ["SAC", "Sacramento", "Kings"], (38.580, -121.500), 10, -8),
    1610612759: ("SAS", "San Antonio Spurs", "West", "Southwest", ["SAS", "SA", "San Antonio", "Spurs"],
                 (29.427, -98.438), 200, -6),
    1610612761: ("TOR", "Toronto Raptors", "East", "Atlantic", ["TOR", "Toronto", "Raptors"], (43.643, -79.379), 80, -5),
    1610612762: ("UTA", "Utah Jazz", "West", "Northwest", ["UTA", "UTAH", "Utah", "Jazz"], (40.768, -111.901), 1288, -7),
    1610612764: ("WAS", "Washington Wizards", "East", "Southeast", ["WAS", "WSH", "Washington", "Wizards"],
                 (38.898, -77.021), 20, -5),
}

# Venues that are not a home arena (neutral-site games), keyed by city name as stored on a game.
NEUTRAL_VENUES = {
    "Orlando bubble": ((28.337, -81.556), 30, -5),     # 2020 restart, Walt Disney World (2020-07-30 – 2020-10-11)
    "Las Vegas": ((36.103, -115.178), 610, -8),       # NBA Cup final
    "Mexico City": ((19.404, -99.096), 2240, -6),
    "Paris": ((48.839, 2.379), 40, 1),
    "London": ((51.508, -0.020), 10, 0),
}
BUBBLE = ("2020-07-30", "2020-10-11")

_ALIASES: dict[str, int] = {}


def _key(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", s.lower())


for _tid, (_abbr, _name, *_rest) in TEAMS.items():
    for _a in [_abbr, _name] + _rest[2]:
        _ALIASES.setdefault(_key(_a), _tid)


def team_key(s: str) -> str:
    return _key(s)


def lookup(name_or_abbr: str) -> int | None:
    """NBA team id for any known abbreviation or name (current or former), else None."""
    k = _key(name_or_abbr)
    if k in _ALIASES:
        return _ALIASES[k]
    for tid, (abbr, name, *_r) in TEAMS.items():   # "Boston Celtics (BOS)", "Celtics, Boston" …
        if _key(name) and _key(name) in k:
            return tid
    return None


def abbr(tid: int | None) -> str | None:
    return TEAMS[tid][0] if tid in TEAMS else None


def external_id(tid: int) -> str:
    return f"nba:{tid}"


def nba_id(external: str | None) -> int | None:
    if external and external.startswith("nba:"):
        try:
            return int(external[4:])
        except ValueError:
            return None
    return None


def arena(tid: int | None, date: str | None = None, abbr_at_time: str | None = None):
    """(lat, lon), elevation m, utc offset for a team's home arena (era-specific where it matters)."""
    if tid not in TEAMS:
        return None
    t = TEAMS[tid]
    loc = t[5]
    if tid == 1610612751 and ((abbr_at_time == "NJN") or (date and date < "2012-07-01")):
        loc = (40.734, -74.171)                      # Prudential Center, Newark
    if tid == 1610612744 and date and date < "2019-07-01":
        loc = (37.750, -122.203)                     # Oracle Arena, Oakland
    if tid == 1610612765 and date and date < "2017-07-01":
        loc = (42.697, -83.245)                      # The Palace of Auburn Hills
    if tid == 1610612746 and date and date < "2024-07-01":
        loc = (34.043, -118.267)                     # shared downtown arena
    return loc, t[6], t[7]


def venue(game: dict):
    """Location of a game: the neutral venue if known, else the home arena."""
    city = game.get("venue_city")
    if city in NEUTRAL_VENUES:
        return NEUTRAL_VENUES[city]
    if game.get("neutral_site") and not city:
        return None                                   # neutral site with no stored city: unknown
    return arena(game.get("home_team_id_nba"), game.get("date"))


def km(a, b) -> float | None:
    if not a or not b:
        return None
    (la1, lo1), (la2, lo2) = a, b
    p1, p2 = math.radians(la1), math.radians(la2)
    dp, dl = p2 - p1, math.radians(lo2 - lo1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6371.0 * 2 * math.asin(math.sqrt(min(1.0, h)))


def season_of(date: str) -> str:
    """Season label for a date when the source does not state it (seasons start in October)."""
    y, m = int(date[:4]), int(date[5:7])
    start = y if m >= 10 else y - 1
    return f"{start}-{(start + 1) % 100:02d}"
