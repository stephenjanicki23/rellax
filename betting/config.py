import os
from dotenv import load_dotenv

load_dotenv()

ODDS_API_KEY = os.getenv("ODDS_API_KEY", "")
ODDS_API_BASE = "https://api.the-odds-api.com/v4"

# Sports to scan
SPORTS = {
    "nfl": "americanfootball_nfl",
    "mlb": "baseball_mlb",
    "world_cup": "soccer_fifa_world_cup",
    "tennis_atp": "tennis_atp",
    "tennis_wta": "tennis_wta",
}

# Minimum edge (model prob - implied prob) to report
MIN_EDGE = 0.03

# Minimum positive EV (as fraction of stake) to report
MIN_EV = 0.02

# Bookmakers considered sharp (used to anchor the no-vig line)
SHARP_BOOKS = {"pinnacle", "betfair", "betfair_ex_us"}

# Regions to pull odds from
REGIONS = "us"

# Markets to analyze
MARKETS = "h2h"
