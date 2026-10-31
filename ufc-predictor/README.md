# UFC Fight Card Prediction Engine

A self-evaluating, self-correcting prediction system for UFC cards. It predicts every bout
on a card (winner, method and round probabilities, with calibrated confidence and an
explanation built from the model's own inputs), freezes those predictions in an
immutable ledger before the event, grades them against official results, looks for
*recurring* errors, and changes its methodology only when a chronological
out-of-sample test says the change helps.

> **Repository note.** This app lives in `ufc-predictor/`, next to the unrelated
> [`rellax`](https://github.com/dixonandmoe/rellax) library and the `fantasy-football/`
> and `hockey-gm/` apps. Nothing outside this folder was modified except a CI workflow
> (`.github/workflows/ufc-predictor-ci.yml`).

---

## 1. Repository audit (before any code was written)

| Question | Finding |
| --- | --- |
| Existing app for this? | No. The repo holds `rellax` (vanilla-JS parallax library, root `package.json`), `fantasy-football/` (Next.js + Prisma) and `hockey-gm/` (Vite + React). |
| Reusable components | Architectural pattern only (pure domain layer, providers isolated, raw/derived/AI kept separate — see `../ARCHITECTURE.md`). No shared code: those apps are TypeScript; nothing models fights. |
| Conflict risk | Root `package.json` is the published `rellax` manifest, so the app is a self-contained folder like its siblings. |
| Stack chosen | **Python 3.11+, numpy, FastAPI + Jinja2 (server-rendered), SQLite locally / Postgres when deployed.** The core of this project is statistical modelling, which is far more natural and testable in numpy than in TS; SQLite (WAL) is enough at this scale (~9k fights) and needs no server, and the schema is portable. |
| Data sources reachable from here | The UFCStats CSV mirror on GitHub: **yes** (results through 2026-10-17). `ufcstats.com` and `ufc.com`: **no** (DNS blocked in this build environment). No odds feed configured. |

## 2. Data sources and what is (not) available

| Need | Provider | Status |
| --- | --- | --- |
| Historical events, results, per-round stats, fighter tale-of-the-tape | `ufcstats_mirror` — [Greco1899/scrape_ufc_stats](https://github.com/Greco1899/scrape_ufc_stats) (daily scrape of ufcstats.com, **GPL-3.0**) | Working. Downloaded at runtime into `data/cache/`, never committed. Every fetch is recorded in `data_sources` with timestamp and SHA-256. |
| Upcoming cards | `ufcstats_live` (ufcstats.com upcoming pages; honours robots.txt, 2 s rate limit, cache) **or** manual import | `ufcstats_live` is implemented and fixture-tested, but **could not be exercised live** here (host unreachable). Default is `manual`. |
| Official results for a new event | The mirror (refreshes daily) **or** manual results import | Working. |
| Odds (Model F, market baseline) | `the_odds_api` (`ODDS_API_KEY`) or manual odds CSV | Not configured. The UI shows the market baseline as *unavailable*; nothing is substituted. |
| Coaching/camp, injuries, travel/altitude | — | **No reliable structured source.** Deliberately not used as model inputs. Shown as unavailable on fighter profiles. |
| Short-notice / weight misses | Manual card fields; card reconciliation marks replacements | Unknown for history, so treated as *unknown* (imputed + flagged), never as "no". |

**No upcoming card is invented.** At build time (2026-10-24) no verified source for the next
card was reachable, so the dashboard says so and shows the most recent *replayed* card,
clearly labelled. To predict the next real card, either run on a host that can reach
ufcstats.com with `providers.upcoming = ufcstats_live`, or fill
`templates/import/card_template.json` from ufc.com and import it (source URL required).

### Known source caveats (surfaced in the UI, not hidden)
* UFCStats does not label corners; the first-listed fighter goes in the red slot. The model is
  antisymmetric (no corner term), so this cannot bias predictions.
* Records are **UFC-only**; pre-UFC records are not in the source.
* Height/reach/stance/DOB are the fighter's *current* profile and treated as time-invariant.
* 9 names are shared by 18 distinct fighters; bouts are resolved by listed weight and every
  case is flagged on the Data Quality screen (unresolvable ones are flagged as errors).
* Result revisions: the mirror only carries the latest result, so for history the engine
  cannot know a result that was later overturned. New corrections become new revisions.

## 3. Architecture

```
ufcpred/
  providers/     ALL external I/O: ufcstats_mirror, ufcstats_live, manual (validated templates), odds
  ingest.py      validation, identity resolution, duplicate detection, result revisions, card reconciliation
  features/      point-in-time HistoryStore → fighter_state(fighter, date, cutoff); antisymmetric feature catalog
  models/        Bayesian logistic (Laplace) sub-models A–F, stacked ensemble, calibration, method & round models,
                 model registry (versions, activation, rollback)
  predict.py     explained predictions → ledger
  ledger.py      append-only, hash-chained prediction ledger; event locks
  review.py      grading, factor support, failure diagnostics
  evaluation/    metrics (accuracy/CI, Brier, log loss, ECE, calibration, bootstrap), rolling-origin backtests
  learning/      patterns (segment tests + FDR), candidates, promotion gates, the learning loop
  analyst.py     structured post-event report (deterministic; optional Claude narrative)
  lifecycle.py   upcoming → predict → lock → results → evaluate → learn; tick() + scheduler
  replay.py      historical replay of the whole loop
  web/           FastAPI app, Jinja templates, inline-SVG charts
```

### The models
All sub-models are Bayesian logistic regressions (MAP with a Gaussian prior + Laplace
covariance) on **antisymmetric** features (`f(A,B) = side(A,B) − side(B,A)`, no intercept),
so `P(A beats B) = 1 − P(B beats A)` exactly.

| Model | Inputs |
| --- | --- |
| A statistical baseline | point-in-time Elo (opponent-adjusted), shrunk career rates (SLpM, SApM, accuracy, defense, TD/15, TD acc/def, sub/15, KD/15, control share), experience, age, height, reach |
| B recent form | the same rates with exponential time decay (half-life chosen by backtest), results vs Elo expectation, recent opponent strength, streak |
| C style matchup | interactions: striking output × opponent defense, takedown offense × opponent TD defense, sub threat × opponent sub losses, reach × distance share, southpaw/orthodox, pace × defense, control × TD defense (+ optional v2 grappling terms) |
| D durability & finish risk | KO/sub loss rates (shrunk), knockdowns absorbed, head strikes absorbed, finish rate, age × KO losses |
| E context | layoff, long layoff, distance from peak age, weight-class change, low experience, five-round × cardio/age, short notice, weight miss |
| F market (optional) | de-vigged odds — only if odds exist for training fights; performance is always reported with and without it |

* **Ensemble**: stacking regression over the sub-models' *out-of-fold* logits from chronological
  inner folds (prior centred on equal weights). Optional experience gating.
* **Calibration**: temperature scaling (or symmetrised isotonic) on the most recent held-out slice.
* **Method**: multinomial logistic for P(method | winner), so `Σ P(A by m) = P(A)` exactly.
* **Round**: Dirichlet-smoothed finish-round distribution by method and format; P(decision) separate.
* **Draw/NC**: base rate, shown separately (winner/method probabilities are conditional on a decisive result).
* **Missing data**: imputed with the training-fold mean *and* flagged in the prediction; small samples
  are shrunk toward the point-in-time population rate. Missing is never zero.
* **Confidence** is separate from win probability: Laplace logit uncertainty, sub-model disagreement,
  data sufficiency, and historical calibration of the same probability band.

### Integrity guarantees
* **No leakage.** Every feature goes through `fighter_state(…, cutoff)` which reads only fights with
  `date < min(fight date, decision time)`. Elo is sequential. Training rows are strictly before the
  model cutoff. Every prediction batch runs a leakage audit; failure blocks the write.
* **Immutable ledger.** SQLite triggers abort UPDATE/DELETE on predictions, locks, decisions and the
  audit log. Rows are SHA-256 hash-chained (`ufcpred verify`). After an event lock a new version needs
  an explicit reason, is marked post-lock, and is never graded in place of the locked one.
* **Promotion gates** (all required, configurable in Settings): no leakage; ≥200 fights and ≥15 events;
  event-clustered paired bootstrap P(candidate better) ≥ 0.90; Brier not worse by >0.002; ECE not
  worse by >0.02; no probability band loses >5 pts of calibration; beats coin flip and base rate;
  gain survives dropping any single event and no event contributes >40% of it.
  If evidence is inconclusive the methodology is retained; the validated configuration is simply
  re-estimated on the new data (decision `refit`). Manual approval mode and rollback are supported.

## 4. Running it

```bash
cd ufc-predictor
pip install -r requirements-dev.txt         # runtime + test dependencies
python -m ufcpred refresh                  # download + ingest UFCStats mirror
python -m ufcpred replay --start 2024-10-01  # historical replay of the full loop (≈20–40 min)
python -m ufcpred serve                    # http://127.0.0.1:8000
python -m pytest                           # test suite (synthetic, offline; SQLite)
UFCPRED_TEST_DATABASE_URL=postgresql://… python -m pytest   # same suite on Postgres (wipes that database)
```

| Command | What it does |
| --- | --- |
| `refresh [--local-dir DIR]` | historical data from the mirror (or local CSVs) |
| `refresh-upcoming` | upcoming card via the configured provider |
| `import-card/import-results/import-odds/import-corrections FILE` | validated manual imports (`templates/import/`) |
| `train --as-of DATE` | initial deployment (half-life chosen by backtest) |
| `predict EVENT_ID [--reason R --post-lock]` · `lock EVENT_ID` · `evaluate EVENT_ID` | lifecycle steps |
| `learn [--mode live --force]` · `rollback VERSION_ID` | learning loop / manual rollback |
| `tick` | every due lifecycle step once (cron: `17 * * * * cd ufc-predictor && python -m ufcpred tick`) |
| `backup` · `export FILE` · `restore FILE` · `verify` · `status` · `report` | operations |

### Configuration
* `DATABASE_URL` (or `POSTGRES_URL` / `UFCPRED_DATABASE_URL`) — a `postgresql://` URL switches the app to
  Postgres. Without it the app uses SQLite at `UFCPRED_DB` (default `data/ufcpred.sqlite3`).
* `UFCPRED_ADMIN_TOKEN` — when set, every write (imports, predict, lock, settings, approvals, rollback)
  needs a log-in with this token; reads stay public unless `UFCPRED_PRIVATE=1`. On Vercel, writes are
  refused until a token is set.
* `ANTHROPIC_API_KEY` + Settings `analyst.provider = anthropic` — Claude writes the narrative fields of
  post-event reports (`pip install anthropic`). It can never change a number or decision.
* `ODDS_API_KEY` + Settings `providers.odds = the_odds_api` — current odds (historical odds via CSV).
* Everything else (thresholds, schedules, providers) lives in the Settings screen / `settings` table,
  every change audited.

### Live event workflow
1. `refresh-upcoming` (or import the card) → `tick` records preliminary predictions.
2. At `start − lifecycle.lock_hours_before` (start unknown ⇒ 00:00 UTC on the event date) the event
   locks. An event with no predictions by then becomes `missed_lock`: nothing is backfilled.
3. After the event, `refresh` (mirror) or `import-results` → `tick` grades the locked predictions and
   runs the learning loop. An event is shown as evaluated only after this has actually happened.

### Betting Edge: simulated bet tracker
Tracking only — `ufcpred/betting.py` reads predictions, odds and results and is never read by the engine
or the learning loop.

**Recording bets**
- Every live pick is recorded once per fight in `sim_bets`, enforced by a `UNIQUE(fight_id, strategy)`
  constraint. The stake depends on the engine's own confidence label:
  - High confidence (score ≥ 0.8): `betting.stake_high`, default $100.
  - Medium confidence (score ≥ 0.5): `betting.stake_medium`, default $50.
  - Low confidence: tracked with no stake.
- Changing a stake setting affects only bets recorded afterwards.
- Before the card locks, a bet follows the newest prediction, and each change is logged. At the card lock
  (which happens before the first fight), the selection and stake are frozen to the official prediction.

**Odds**
- Odds come from imported or feed odds captured before the fight's first result. Once set, they are
  frozen at the lock. Odds are never invented.
- A decided bet with no odds shows as "needs odds" and stays out of P/L until an admin enters them.

**Settlement and corrections**
- Win: + profit. Loss: − stake. Draw: push ($0). No contest: void ($0). Canceled or replaced bout: void.
- A bet that was never locked before its fight is voided and not graded.
- If the official result is revised, the bet is re-settled once, with a log entry.
- Admin corrections (odds, stake, status) require a reason. They are written to the append-only
  `sim_bet_events` table, and a corrected settlement is pinned until reset to "auto".

**Updates and pages**
- The tracker updates on every `tick` and after predict, lock, odds and result actions.
- Pages:
  - `/edge` — dashboard;
  - `/edge/event/<id>` — one card's bets;
  - `/edge/bets` — filterable ledger, with `.csv` export;
  - `/edge/bet/<id>` — one bet, its history and the correction form.

## 5. Deploying to Vercel (with Neon Postgres)

Vercel serves the web app as one Python function (`api/index.py`, `vercel.json`). Serverless functions
can't keep a SQLite file and stop after 60 s, so the data lives in **Neon Postgres** and the long jobs
(data refresh, replay, backtests, learning) run in the **UFC Predictor jobs** GitHub Actions workflow
against the same database.

1. **Create the project.** Vercel → Add New → Project → import `stephenjanicki23/rellax`. Set **Root
   Directory = `ufc-predictor`**, Framework Preset = **Other**; leave build settings empty.
2. **Add the database.** In the project: Storage → Create/Connect → **Neon** (free tier) → connect it to
   the project. This injects `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED`. Preview deployments
   share that database unless you enable Neon's per-preview branching.
3. **Set environment variables** (Settings → Environment Variables): `UFCPRED_ADMIN_TOKEN` = a long random
   string (e.g. `python -c "import secrets; print(secrets.token_urlsafe(32))"`). Optional:
   `UFCPRED_PRIVATE=1`, `ANTHROPIC_API_KEY`, `ODDS_API_KEY`. Then deploy (or redeploy).
4. **Give the jobs workflow the database.** GitHub → repo Settings → Secrets and variables → Actions →
   new secret **`UFCPRED_DATABASE_URL`** = Neon's *unpooled* connection string. Optional secrets:
   `ANTHROPIC_API_KEY`, `ODDS_API_KEY`.
5. **Load data**, either:
   * Actions → **UFC Predictor jobs** → Run workflow → `bootstrap` (downloads the history, replays from
     `replay_start`; about 30–60 min), or
   * copy an existing local database:
     `python -m ufcpred export replay.jsonl.gz` then
     `DATABASE_URL=<neon unpooled url> python -m ufcpred restore replay.jsonl.gz` (target must be empty).
6. **Operate.** The workflow runs `tick` every 6 hours (refresh → predict → lock → grade → learn) and a
   weekly `backup`. Import cards and results on the site's Settings screen after logging in at `/login`.
   Scheduled workflows only run from the default branch, so they start once this is merged.

On Vercel the Settings buttons for refresh, tick, learning and backup point to the workflow instead of
running in the request.

## 6. Backups and recovery
* SQLite: `python -m ufcpred backup` (or Settings → Create backup) writes a consistent copy with the
  SQLite backup API to `data/backups/`. `python -m ufcpred restore FILE` runs an integrity check, keeps
  the current DB aside as `*.pre-restore-<time>`, then swaps the file. Stop the server first.
* Postgres: Neon's point-in-time restore is the first line of recovery. `backup` writes a gzipped JSON
  export of every table (the jobs workflow keeps a weekly one as a 90-day artifact);
  `restore FILE` loads it into an empty database and resets the id sequences.
* Migrations are additive only (a migration containing `DROP TABLE` is refused), so code updates
  never reset history. Model versions are never deleted; any non-rejected version can be reactivated.

## 7. Historical replay results

See [`REPLAY_REPORT.md`](REPLAY_REPORT.md) for the replay over real UFC events, with every
number generated by the pipeline.

## 8. Limitations (honest list)
* No live upcoming-card feed was reachable from the build environment; `ufcstats_live` is
  fixture-tested only.
* No odds history, so Model F and the market baseline are inactive until odds are imported.
* Records are UFC-only; contextual factors without a reliable source (camp, injuries, altitude)
  are not modelled.
* Gradient-boosted trees were not added: the brief says to add complexity only when it beats
  the simple model out of sample, and the learning loop's candidate set is where such a model
  would be tested.
