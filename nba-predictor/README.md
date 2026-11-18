# NBA Game Prediction Engine

The NBA counterpart of [`ufc-predictor/`](../ufc-predictor/): the same self-evaluating, self-correcting
design, rebuilt for basketball. It predicts every game on an NBA night (win probability, expected margin,
winning-margin bands, total points and overtime, each with calibrated confidence and an explanation built
from the model's own inputs), freezes those predictions in an immutable ledger before tip-off, grades them
against the final scores, looks for *recurring* errors, and changes its methodology only when a
chronological out-of-sample test says the change helps.

> **Repository note.** This app lives in `nba-predictor/`, next to `ufc-predictor/`, `fantasy-football/`,
> `hockey-gm/` and the unrelated `rellax` library. Nothing outside this folder was modified except two CI
> workflows (`.github/workflows/nba-predictor-ci.yml`, `nba-predictor-jobs.yml`).

## 1. What carries over from the UFC engine, and what changed

| UFC engine | NBA engine |
| --- | --- |
| Fight card (event) locks before the first bout | **Game night** (every game on one date) locks 30 min before the first tip-off |
| Fighters, red/blue corner | Teams, **home/away**; home court is a *learned* feature (neutral sites, e.g. the 2020 bubble or Mexico City, get none) |
| Sub-models A–F on antisymmetric features | Same: A season strength, B recent form, C style matchup, D volatility & close games, E situation, F market |
| Method of victory & round | **Margin distribution** (expected margin, winning-margin bands 1–5 / 6–12 / 13+, engine point spread), **total points**, **overtime** |
| Fight-week form (short notice, missed weight) | **Game-day form / injury import**: rotation players ruled out |
| Betting Edge on moneylines | Same simulated moneyline tracker, plus **spread and total comparisons** and an against-the-spread record |
| UFCStats mirror + ufcstats.com | NBA.com box scores (GitHub mirror) + **ESPN** for recent seasons, schedules, results and lines |

Everything else is the same machinery: Bayesian logistic sub-models with Laplace uncertainty, a stacked
ensemble, temperature/isotonic calibration, point-in-time feature store with a leakage audit on every
batch, hash-chained append-only ledger, revisioned results, segment tests with Benjamini–Hochberg FDR
control, gated promotion, refit/rollback/manual approval, deterministic + optional Claude analyst,
SQLite locally / Postgres on Vercel, GitHub Actions jobs, backups.

## 2. Data sources

| Need | Provider | Status |
| --- | --- | --- |
| History 2010-11 → 2023-24 (team box scores, regular season + playoffs) | `nba_mirror` — [NocturneBear/NBA-Data-2010-2024](https://github.com/NocturneBear/NBA-Data-2010-2024) (NBA.com data) | Working. 17,828 games. Downloaded at runtime into `data/cache/`, never committed. |
| Seasons after 2023-24, upcoming nights, results, lines | `espn` — ESPN public scoreboard (`/scoreboard?dates=`) and game summaries (`/summary?event=`) | Implemented and **fixture-tested only**: ESPN is not reachable from the build sandbox. It runs in GitHub Actions and on Vercel. |
| Odds | ESPN scoreboard lines (default), The Odds API (`ODDS_API_KEY`, `basketball_nba`, h2h/spreads/totals) or a CSV import | Comparison only; the engine never reads them unless a market-model candidate is validated. |
| Injuries | Game-day form on each game page, or `availability_template.csv` | No historical source, so absences are *unknown* for past games: the feature is inactive until data accumulates; today it lowers confidence. |
| Rest, back-to-backs, travel, time zones, altitude | Computed from the schedule and approximate arena coordinates (`nbapred/teams.py`) | Working. |

Known caveats (surfaced in the UI, not hidden): play-in games and the NBA Cup final are not in the mirror;
ESPN scoreboards lack offensive rebounds/turnovers, so full box scores are fetched per game (up to
`providers.espn.max_box_fetch` per run) and, until then, possession-based stats are imputed and flagged;
ratings are team-level, so trades show up only as games are played.

## 3. Architecture

```
nbapred/
  providers/     ALL external I/O: nba_mirror, espn, manual (validated templates), odds (The Odds API, de-vig)
  teams.py       30 franchises: ids, old names and ESPN codes, arena locations, elevation, time zones
  ingest.py      validation, team resolution, manual↔provider game merging, result revisions, night reconciliation
  features/      point-in-time HistoryStore → team_state(team, date, cutoff); antisymmetric feature catalog
  models/        Bayesian logistic sub-models A–F, stacked ensemble, calibration, margin σ, total-points model,
                 model registry (versions, activation, rollback)
  predict.py     explained predictions → ledger
  ledger.py      append-only, hash-chained prediction ledger; night locks
  review.py      grading (winner, margin, band, total, vs spread/total), box-score factor checks, diagnostics
  evaluation/    metrics (accuracy/CI, Brier, log loss, ECE, calibration, bootstrap), rolling-origin backtests
  learning/      NBA segment hypotheses + FDR, candidates, promotion gates, the learning loop
  betting.py     simulated moneyline tracker (read-only with respect to the engine)
  lifecycle.py   schedule → predict → lock → results → evaluate → learn; tick() + scheduler
  replay.py      historical replay of the whole loop
  web/           FastAPI app, Jinja templates, inline-SVG charts
```

### The models
All win-probability sub-models are Bayesian logistic regressions (MAP, Gaussian prior, Laplace covariance)
on **antisymmetric** features (`f(A,B) = side(A,B) − side(B,A)`, no intercept), so
`P(home) = 1 − P(away)` exactly and swapping teams at a neutral site flips the probability.

| Model | Inputs |
| --- | --- |
| A season strength | Elo (margin-aware, home-court term, ¼ regression between seasons), net/offensive/defensive rating per 100 possessions, win %, Four Factors for and against — season-to-date, shrunk toward last season's value regressed to the league mean |
| B recent form | time-decayed net/offensive/defensive rating (half-life chosen by backtest), recent win rate, results vs Elo expectation, opponent strength, streak, last ten |
| C style matchup | shooting vs opponent's shooting defence, turnovers forced vs ball security, offensive vs defensive rebounding, free throws vs fouling, tempo vs defence (+ optional three-point terms) |
| D volatility | margin volatility, close-game record (shrunk), blowout-loss rate, net rating relative to volatility |
| E situation | home court, rest, back-to-back, three-in-four, travel distance, time zones crossed, home altitude, road-trip length, early-season rating, playoff rating, rotation players out |
| F market (optional) | de-vigged moneyline — only if odds exist for training games |

* **Ensemble / calibration**: stacking over out-of-fold sub-model logits from chronological inner folds;
  temperature scaling (or symmetrised isotonic) on the most recent held-out slice; optional early-season gating.
* **Margin**: `home margin ~ Normal(μ, σ²)` with `μ = σ·Φ⁻¹(P(home))`, σ fitted by maximum likelihood on
  out-of-fold rows. Spread probabilities and margin bands therefore reconcile exactly with the win probability.
* **Total points**: Bayesian linear regression on symmetric pace × efficiency features, relative to the
  point-in-time league-average total (so the scoring rise since 2010 is handled), with a held-out residual sd.
* **Overtime**: base rate scaled by how close the game is expected to be.
* **Confidence** is separate from win probability: logit uncertainty, sub-model disagreement, season sample
  size, unknown injury report, and historical calibration of the same probability band.

### Integrity guarantees
* **No leakage.** Every feature goes through `team_state(…, cutoff)`, which reads only games with
  `date < min(game date, decision time)`. Elo is sequential. Training rows are strictly before the model
  cutoff. Every prediction batch runs a leakage audit; failure blocks the write. Backtests freeze the model at
  the fold start while team states update night by night — exactly what a live night sees.
* **Immutable ledger.** Triggers abort UPDATE/DELETE on predictions, locks, decisions, bet history and the
  audit log (SQLite and Postgres). Rows are SHA-256 hash-chained (`nbapred verify`). After a night locks a
  new version needs an explicit reason, is marked post-lock, and is never graded in place of the locked one.
* **Promotion gates** (all required, configurable): no leakage; ≥400 games and ≥30 nights; event-clustered
  paired bootstrap P(candidate better) ≥ 0.90; Brier not worse by >0.002; ECE not worse by >0.02; no
  probability band loses >5 pts of calibration; beats coin flip and the home-team baseline; gain survives
  dropping any single night and no night contributes >40% of it. Otherwise the validated configuration is
  re-estimated on the new data (`refit`). Manual approval mode and rollback are supported.

## 4. Running it

```bash
cd nba-predictor
pip install -r requirements-dev.txt
python -m nbapred refresh                     # mirror history + ESPN seasons since 2024-10 (+ box scores)
python -m nbapred refresh --mirror-only       # just the 2010–2024 mirror (what works without ESPN access)
python -m nbapred replay --start 2023-10-24 --end 2024-06-30   # historical replay of the full loop
python -m nbapred refresh-upcoming            # tonight's games and lines from ESPN
python -m nbapred serve                       # http://127.0.0.1:8000
python -m pytest                              # 59 tests (synthetic, offline; SQLite)
NBAPRED_TEST_DATABASE_URL=postgresql://… python -m pytest   # same suite on Postgres (wipes that database)
```

| Command | What it does |
| --- | --- |
| `refresh [--local-dir DIR] [--mirror-only]` · `refresh-upcoming` · `refresh-boxes [--limit N]` | data |
| `import-night/import-results/import-odds/import-availability FILE` | validated manual imports (`templates/import/`) |
| `train --as-of DATE` | initial deployment (half-life chosen by backtest) |
| `predict EVENT_ID [--reason R --post-lock]` · `lock EVENT_ID` · `evaluate EVENT_ID` | lifecycle steps |
| `learn [--mode live --force]` · `rollback VERSION_ID` | learning loop / manual rollback |
| `tick` | every due lifecycle step once (cron: `17 */3 * * * cd nba-predictor && python -m nbapred tick`) |
| `backup` · `export FILE` · `restore FILE` · `verify` · `status` · `report` | operations |

Configuration mirrors the UFC app with an `NBAPRED_` prefix: `DATABASE_URL` (or `NBAPRED_DATABASE_URL`)
for Postgres, `NBAPRED_DB` for the SQLite path, `NBAPRED_ADMIN_TOKEN`, `NBAPRED_PRIVATE=1`,
`ANTHROPIC_API_KEY` (+ Settings `analyst.provider = anthropic`), `ODDS_API_KEY`. Everything else lives on
the Settings screen, every change audited.

### Live workflow
1. The tick loads the next days of games and lines from ESPN (or import a night) and records preliminary
   predictions — once per day per game, plus a new version when an injury report is entered or the model changes.
2. 30 minutes before the night's first tip-off (unknown ⇒ noon Eastern) the night locks. A night with no
   predictions by then becomes `missed_lock`; nothing is backfilled.
3. After the games, the tick ingests final scores and box scores, grades the locked predictions and runs the
   learning loop once at least `learning.min_new_games_for_retrain` (150) new games have accumulated.

## 5. Deploying to Vercel (with Neon Postgres)

Use a **separate** Vercel project and database from the UFC app:

1. Vercel → Add New → Project → import `stephenjanicki23/rellax`; **Root Directory = `nba-predictor`**,
   Framework Preset = Other.
2. Storage → Create/Connect → **Neon** → connect it to this project (injects `DATABASE_URL`).
3. Environment variables: `NBAPRED_ADMIN_TOKEN` (long random string); optional `NBAPRED_PRIVATE=1`,
   `ANTHROPIC_API_KEY`, `ODDS_API_KEY`. Deploy.
4. GitHub → Settings → Secrets and variables → Actions → **`NBAPRED_DATABASE_URL`** = Neon's *unpooled*
   connection string (optional: `ANTHROPIC_API_KEY`, `ODDS_API_KEY`).
5. Actions → **NBA Predictor jobs** → Run workflow → `bootstrap` (downloads history, backfills 2024-25 →
   today from ESPN with box scores, replays from `replay_start`, loads upcoming games; allow a few hours).
6. The workflow then runs `tick` every 3 hours and a weekly `backup`. Scheduled workflows run from the
   default branch, so they start once this is merged.

## 6. Historical replay results

See [`REPLAY_REPORT.md`](REPLAY_REPORT.md): two full real seasons (2022-23 and 2023-24, playoffs included),
predicted one night at a time with every number generated by the pipeline.

## 7. Limitations (honest list)
* ESPN (recent seasons, schedules, lines) could not be reached from the build environment; that provider is
  fixture-tested against recorded payload shapes and runs only where ESPN is reachable.
* No historical injury data: absences are learned only as reports are entered.
* Team-level model: no player ratings, so trades and returns from injury are seen only through results.
* No historical odds, so the market model and against-the-spread record start empty.
