---
title: Sports Betting Edge Finder
emoji: 🏈
colorFrom: green
colorTo: blue
sdk: gradio
sdk_version: 5.0.0
app_file: app.py
pinned: false
---

# Sports Betting Edge Finder

Scans live moneyline odds across NFL, NCAAF, MLB, and MLS. Strips the bookmaker
vig to estimate true win probability, then flags bets where the best available
price implies a higher return than the market consensus justifies (positive EV).

## How to deploy to Hugging Face Spaces

1. Create a new Space at https://huggingface.co/new-space
   - SDK: **Gradio**
   - Visibility: Public or Private
2. Upload the contents of this `betting/` folder to the Space repo root
3. Go to **Settings → Variables and Secrets** and add:
   - Name: `ODDS_API_KEY`
   - Value: your key from https://the-odds-api.com (free tier = 500 req/month)
4. The Space builds automatically — you'll get a live link in ~60 seconds.

## Local usage

```bash
pip install -r requirements.txt
export ODDS_API_KEY=your_key
python app.py          # Gradio UI on http://localhost:7860
python main.py         # CLI version
```

## Edge detection logic

1. Fetch all bookmaker lines for each game from The Odds API
2. Strip each book's vig → fair probability per outcome
3. Average across books (prefer Pinnacle/Betfair when available) → consensus fair prob
4. If `best_available_odds > 1 / fair_prob` → positive EV → value bet
5. Rank by EV; show 25% Kelly as a conservative stake size

> Gambling involves risk. This tool is for informational and research purposes only.
