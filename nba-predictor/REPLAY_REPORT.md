# Historical replay report

_Generated 2026-11-18T04:08:57+00:00 by `python -m nbapred report --mode replay` from the database; every number below is computed by the pipeline._

## Protocol

* 413 real NBA game nights from 2022-10-18 to 2024-06-17, processed one night at a time in date order.
* For each night: predict with the active model using only games strictly before that date → lock in the ledger → grade against the official final score → run the learning loop with data up to the next day (retraining is considered once enough new games have accumulated).
* 2626 predictions locked; 2626 graded.
* Ledger verification: intact (2626 rows, hash chain checked).
* Data: NBA.com team box scores via the NocturneBear/NBA-Data-2010-2024 GitHub mirror. No betting lines were stored for these seasons, so there is no market baseline or against-the-spread record here.

## Winner prediction and probability quality

| Metric | Value | 95% interval |
| --- | --- | --- |
| Accuracy (n=2626) | 64.0% | 62.1%–65.8% (Wilson) |
| Log loss | 0.6292 | 0.6159–0.6430 (night bootstrap) |
| Brier | 0.2196 | 0.2136–0.2256 |
| ECE (5 bins) | 1.1% | |

### Baselines on the same games

| Model | Log loss | Brier | Accuracy |
| --- | --- | --- | --- |
| **This engine** | **0.6292** | 0.2196 | 64.0% |
| Coin flip (50/50) | 0.6931 | 0.2500 | 50.0% |
| Home team always wins | 0.6850 | 0.2459 | 56.4% |
| Better record wins | 0.6637 | 0.2354 | 62.3% |
| Elo only | 0.6403 | 0.2244 | 63.7% |

### Calibration (probability given to the predicted winner)

| Band | n | Mean stated | Observed | 95% CI |
| --- | --- | --- | --- | --- |
| 0.5–0.6 | 1119 | 54.7% | 54.2% | 51%–57% |
| 0.6–0.7 | 774 | 64.8% | 65.2% | 62%–69% |
| 0.7–0.8 | 495 | 74.5% | 76.4% | 72%–80% |
| 0.8–0.9 | 212 | 83.8% | 79.2% | 73%–84% |
| 0.9–1.0 | 26 | 92.0% | 88.5% | 71%–96% |

### Rolling windows

| Window | Accuracy | Log loss |
| --- | --- | --- |
| last 10 | 70.0% | 0.567 |
| last 50 | 54.0% | 0.690 |
| last 100 | 62.0% | 0.656 |
| last 250 | 64.8% | 0.640 |
| last 500 | 63.8% | 0.615 |

## Margin, winning-margin bands and totals

* Margin: mean absolute error 10.68 points (bias +1.05); 68.8% of results fell within one stated standard deviation (a well-specified Normal would give 68.3%).
* Total points: mean absolute error 14.68 (bias -1.04, actual − projected).
* Overtime: 5.5% of games, 5.6% stated.
* Winner and band both right: 20.4%; 6-way (winner × band) log loss 1.708 (uniform guess 1.792).

| Winning margin | Games | Share actual | Share stated |
| --- | --- | --- | --- |
| by 1–5 | 668 | 25.4% | 28.7% |
| by 6–12 | 984 | 37.5% | 31.0% |
| by 13+ | 974 | 37.1% | 40.3% |

## By confidence label

| Label | n | Accuracy | Log loss |
| --- | --- | --- | --- |
| High | 1368 | 60.6% | 0.657 |
| Low | 72 | 62.5% | 0.637 |
| Medium | 1186 | 68.0% | 0.596 |

## By month

| Month | n | Accuracy | Log loss |
| --- | --- | --- | --- |
| 2022-10 | 102 | 66.7% | 0.656 |
| 2022-11 | 222 | 64.0% | 0.646 |
| 2022-12 | 222 | 61.3% | 0.680 |
| 2023-01 | 222 | 59.9% | 0.643 |
| 2023-02 | 163 | 63.2% | 0.622 |
| 2023-03 | 229 | 64.6% | 0.633 |
| 2023-04 | 115 | 56.5% | 0.666 |
| 2023-05 | 34 | 64.7% | 0.699 |
| 2023-06 | 5 | 80.0% | 0.598 |
| 2023-10 | 54 | 57.4% | 0.660 |
| 2023-11 | 219 | 65.3% | 0.616 |
| 2023-12 | 207 | 72.0% | 0.570 |
| 2024-01 | 231 | 66.2% | 0.612 |
| 2024-02 | 174 | 62.6% | 0.604 |
| 2024-03 | 230 | 62.6% | 0.607 |
| 2024-04 | 151 | 68.9% | 0.612 |
| 2024-05 | 41 | 53.7% | 0.701 |
| 2024-06 | 5 | 80.0% | 0.524 |

## Learning loop decisions

| Date (as of) | Decision | Detail |
| --- | --- | --- |
| 2022-10-18 | initial | first deployment: no incumbent. Half-life chosen by out-of-sample log loss; validated against baselines |
| 2022-11-08 | reject | The probability of a 13+ point game is biased: isotonic calibration (reshapes the margin spread): Δbucket_log_loss=-0.0037 (P(better)=0.14, n=1209); failed: improves_bucket_log_loss, not_one_night |
| 2022-11-08 | reject | Routine experiment: add a schedule-adjusted net rating (margins relative to how good each opponent was at the time): Δwinner_log_loss=-0.0002 (P(better)=0.15, n=1209); failed: improves_winner_log_loss, not_one_night |
| 2022-11-08 | reject | Routine experiment: add three-point matchup terms (volume vs. opponent's three-point defence, accuracy vs. threes conceded): Δwinner_log_loss=-0.0005 (P(better)=0.02, n=1209); failed: improves_winner_log_loss, not_one_ni |
| 2022-11-08 | refit | No candidate met the promotion criteria; the validated configuration was re-estimated on 158 additional games. Methodology unchanged. |
| 2022-11-29 | reject | Home court is mis-weighted (home teams win at a different rate than stated): loosen Model E (situation) prior: Δwinner_log_loss=-0.0000 (P(better)=0.50, n=1210); failed: improves_winner_log_loss, not_one_night |
| 2022-11-29 | reject | Home court is mis-weighted (home teams win at a different rate than stated): tighten Model E (situation) prior: Δwinner_log_loss=+0.0000 (P(better)=0.57, n=1210); failed: improves_winner_log_loss, not_one_night |
| 2022-11-29 | reject | The probability of a 13+ point game is biased: isotonic calibration (reshapes the margin spread): Δbucket_log_loss=-0.0044 (P(better)=0.12, n=1210); failed: improves_bucket_log_loss, not_one_night |
| 2022-11-29 | refit | No candidate met the promotion criteria; the validated configuration was re-estimated on 150 additional games. Methodology unchanged. |
| 2022-12-20 | reject | Home court is mis-weighted (home teams win at a different rate than stated): loosen Model E (situation) prior: Δwinner_log_loss=-0.0000 (P(better)=0.28, n=1207); failed: improves_winner_log_loss, not_one_night |
| 2022-12-20 | reject | Home court is mis-weighted (home teams win at a different rate than stated): tighten Model E (situation) prior: Δwinner_log_loss=+0.0000 (P(better)=0.72, n=1207); failed: improves_winner_log_loss, not_one_night |
| 2022-12-20 | reject | The probability of a 13+ point game is biased: isotonic calibration (reshapes the margin spread): Δbucket_log_loss=-0.0047 (P(better)=0.11, n=1207); failed: improves_bucket_log_loss, not_one_night |
| 2022-12-20 | refit | No candidate met the promotion criteria; the validated configuration was re-estimated on 152 additional games. Methodology unchanged. |
| 2023-01-10 | reject | Home court is mis-weighted (home teams win at a different rate than stated): loosen Model E (situation) prior: Δwinner_log_loss=-0.0000 (P(better)=0.26, n=1202); failed: improves_winner_log_loss, not_one_night |
| 2023-01-10 | reject | Home court is mis-weighted (home teams win at a different rate than stated): tighten Model E (situation) prior: Δwinner_log_loss=-0.0001 (P(better)=0.12, n=1202); failed: improves_winner_log_loss, not_one_night |
| 2023-01-10 | reject | The probability of a 13+ point game is biased: isotonic calibration (reshapes the margin spread): Δbucket_log_loss=-0.0048 (P(better)=0.09, n=1202); failed: improves_bucket_log_loss, not_one_night |
| 2023-01-10 | refit | No candidate met the promotion criteria; the validated configuration was re-estimated on 150 additional games. Methodology unchanged. |
| 2023-01-31 | reject | Home court is mis-weighted (home teams win at a different rate than stated): loosen Model E (situation) prior: Δwinner_log_loss=-0.0000 (P(better)=0.18, n=1202); failed: improves_winner_log_loss, not_one_night |
| 2023-01-31 | reject | Home court is mis-weighted (home teams win at a different rate than stated): tighten Model E (situation) prior: Δwinner_log_loss=+0.0000 (P(better)=0.83, n=1202); failed: improves_winner_log_loss |
| 2023-01-31 | reject | The probability of a 13+ point game is biased: isotonic calibration (reshapes the margin spread): Δbucket_log_loss=-0.0078 (P(better)=0.01, n=1202); failed: improves_bucket_log_loss, not_one_night |
| 2023-01-31 | refit | No candidate met the promotion criteria; the validated configuration was re-estimated on 153 additional games. Methodology unchanged. |
| 2023-02-27 | reject | Home court is mis-weighted (home teams win at a different rate than stated): loosen Model E (situation) prior: Δwinner_log_loss=-0.0000 (P(better)=0.14, n=1203); failed: improves_winner_log_loss, not_one_night |
| 2023-02-27 | reject | Home court is mis-weighted (home teams win at a different rate than stated): tighten Model E (situation) prior: Δwinner_log_loss=+0.0000 (P(better)=0.87, n=1203); failed: improves_winner_log_loss |
| 2023-02-27 | reject | The probability of a 13+ point game is biased: isotonic calibration (reshapes the margin spread): Δbucket_log_loss=-0.0073 (P(better)=0.01, n=1203); failed: improves_bucket_log_loss, not_one_night |
| 2023-02-27 | refit | No candidate met the promotion criteria; the validated configuration was re-estimated on 154 additional games. Methodology unchanged. |
| 2023-03-20 | reject | The probability of a 13+ point game is biased: isotonic calibration (reshapes the margin spread): Δbucket_log_loss=-0.0051 (P(better)=0.04, n=1210); failed: improves_bucket_log_loss, not_one_night |
| 2023-03-20 | reject | Home court is mis-weighted (home teams win at a different rate than stated): loosen Model E (situation) prior: Δwinner_log_loss=-0.0000 (P(better)=0.14, n=1210); failed: improves_winner_log_loss, not_one_night |
| 2023-03-20 | reject | Home court is mis-weighted (home teams win at a different rate than stated): tighten Model E (situation) prior: Δwinner_log_loss=+0.0000 (P(better)=0.87, n=1210); failed: improves_winner_log_loss |
| 2023-03-20 | refit | No candidate met the promotion criteria; the validated configuration was re-estimated on 153 additional games. Methodology unchanged. |
| 2023-04-10 | reject | The probability of a 13+ point game is biased: isotonic calibration (reshapes the margin spread): Δbucket_log_loss=-0.0067 (P(better)=0.02, n=1203); failed: improves_bucket_log_loss, not_one_night |
| 2023-04-10 | reject | Home court is mis-weighted (home teams win at a different rate than stated): loosen Model E (situation) prior: Δwinner_log_loss=-0.0000 (P(better)=0.08, n=1203); failed: improves_winner_log_loss, not_one_night |
| 2023-04-10 | promote | Home court is mis-weighted (home teams win at a different rate than stated): tighten Model E (situation) prior: Δwinner_log_loss=+0.0000 (P(better)=0.92, n=1203); all criteria passed |
| 2023-11-02 | reject | Home court is mis-weighted (home teams win at a different rate than stated): loosen Model E (situation) prior: Δwinner_log_loss=-0.0000 (P(better)=0.02, n=1206); failed: improves_winner_log_loss, not_one_night |
| 2023-11-02 | reject | Home court is mis-weighted (home teams win at a different rate than stated): tighten Model E (situation) prior: Δwinner_log_loss=+0.0000 (P(better)=0.59, n=1206); failed: improves_winner_log_loss, not_one_night |
| 2023-11-02 | reject | The probability of a 13+ point game is biased: isotonic calibration (reshapes the margin spread): Δbucket_log_loss=-0.0028 (P(better)=0.10, n=1206); failed: improves_bucket_log_loss, not_one_night |
| 2023-11-02 | refit | No candidate met the promotion criteria; the validated configuration was re-estimated on 151 additional games. Methodology unchanged. |
| 2023-11-23 | reject | The probability of a 13+ point game is biased: isotonic calibration (reshapes the margin spread): Δbucket_log_loss=-0.0044 (P(better)=0.04, n=1209); failed: improves_bucket_log_loss, not_one_night |
| 2023-11-23 | reject | Home court is mis-weighted (home teams win at a different rate than stated): loosen Model E (situation) prior: Δwinner_log_loss=-0.0000 (P(better)=0.07, n=1209); failed: improves_winner_log_loss, not_one_night |
| 2023-11-23 | promote | Home court is mis-weighted (home teams win at a different rate than stated): tighten Model E (situation) prior: Δwinner_log_loss=+0.0000 (P(better)=0.93, n=1209); all criteria passed |
| 2023-12-17 | reject | Home court is mis-weighted (home teams win at a different rate than stated): loosen Model E (situation) prior: Δwinner_log_loss=-0.0001 (P(better)=0.03, n=1209); failed: improves_winner_log_loss, not_one_night |
| 2023-12-17 | reject | The probability of a 13+ point game is biased: isotonic calibration (reshapes the margin spread): Δbucket_log_loss=-0.0048 (P(better)=0.05, n=1209); failed: improves_bucket_log_loss, not_one_night |
| 2023-12-17 | promote | Home court is mis-weighted (home teams win at a different rate than stated): tighten Model E (situation) prior: Δwinner_log_loss=+0.0001 (P(better)=0.98, n=1209); all criteria passed |
| 2024-01-07 | reject | Home court is mis-weighted (home teams win at a different rate than stated): loosen Model E (situation) prior: Δwinner_log_loss=-0.0001 (P(better)=0.02, n=1200); failed: improves_winner_log_loss, not_one_night |
| 2024-01-07 | reject | The probability of a 13+ point game is biased: isotonic calibration (reshapes the margin spread): Δbucket_log_loss=-0.0062 (P(better)=0.03, n=1200); failed: improves_bucket_log_loss, not_one_night |
| 2024-01-07 | promote | Home court is mis-weighted (home teams win at a different rate than stated): tighten Model E (situation) prior: Δwinner_log_loss=+0.0002 (P(better)=0.99, n=1200); all criteria passed |
| 2024-01-28 | reject | Home court is mis-weighted (home teams win at a different rate than stated): loosen Model E (situation) prior: Δwinner_log_loss=-0.0002 (P(better)=0.01, n=1202); failed: improves_winner_log_loss, not_one_night |
| 2024-01-28 | reject | Home court is mis-weighted (home teams win at a different rate than stated): tighten Model E (situation) prior: Δwinner_log_loss=+0.0001 (P(better)=0.81, n=1202); failed: improves_winner_log_loss |
| 2024-01-28 | reject | The probability of a 13+ point game is biased: isotonic calibration (reshapes the margin spread): Δbucket_log_loss=-0.0067 (P(better)=0.03, n=1202); failed: improves_bucket_log_loss, not_one_night |
| 2024-01-28 | refit | No candidate met the promotion criteria; the validated configuration was re-estimated on 153 additional games. Methodology unchanged. |
| 2024-02-23 | reject | Home court is mis-weighted (home teams win at a different rate than stated): loosen Model E (situation) prior: Δwinner_log_loss=-0.0002 (P(better)=0.07, n=1202); failed: improves_winner_log_loss, not_one_night |
| 2024-02-23 | reject | The probability of a 13+ point game is biased: isotonic calibration (reshapes the margin spread): Δbucket_log_loss=-0.0130 (P(better)=0.00, n=1202); failed: improves_bucket_log_loss, not_one_night |
| 2024-02-23 | promote | Home court is mis-weighted (home teams win at a different rate than stated): tighten Model E (situation) prior: Δwinner_log_loss=+0.0003 (P(better)=0.93, n=1202); all criteria passed |
| 2024-03-14 | reject | The probability of a 13+ point game is biased: isotonic calibration (reshapes the margin spread): Δbucket_log_loss=-0.0130 (P(better)=0.00, n=1201); failed: improves_bucket_log_loss, not_one_night |
| 2024-03-14 | reject | Home court is mis-weighted (home teams win at a different rate than stated): loosen Model E (situation) prior: Δwinner_log_loss=-0.0002 (P(better)=0.12, n=1201); failed: improves_winner_log_loss, not_one_night |
| 2024-03-14 | reject | Home court is mis-weighted (home teams win at a different rate than stated): tighten Model E (situation) prior: Δwinner_log_loss=+0.0003 (P(better)=0.82, n=1201); failed: improves_winner_log_loss |
| 2024-03-14 | refit | No candidate met the promotion criteria; the validated configuration was re-estimated on 151 additional games. Methodology unchanged. |
| 2024-04-04 | reject | The probability of a game decided by 5 or fewer is biased: isotonic calibration (reshapes the margin spread): Δbucket_log_loss=-0.0088 (P(better)=0.01, n=1201); failed: improves_bucket_log_loss, not_one_night |
| 2024-04-04 | reject | Home court is mis-weighted (home teams win at a different rate than stated): loosen Model E (situation) prior: Δwinner_log_loss=-0.0002 (P(better)=0.17, n=1201); failed: improves_winner_log_loss, not_one_night |
| 2024-04-04 | reject | Home court is mis-weighted (home teams win at a different rate than stated): tighten Model E (situation) prior: Δwinner_log_loss=+0.0003 (P(better)=0.81, n=1201); failed: improves_winner_log_loss |
| 2024-04-04 | refit | No candidate met the promotion criteria; the validated configuration was re-estimated on 156 additional games. Methodology unchanged. |
| 2024-05-14 | reject | The probability of a game decided by 5 or fewer is biased: isotonic calibration (reshapes the margin spread): Δbucket_log_loss=-0.0112 (P(better)=0.01, n=1203); failed: improves_bucket_log_loss, not_one_night |
| 2024-05-14 | reject | Home court is mis-weighted (home teams win at a different rate than stated): loosen Model E (situation) prior: Δwinner_log_loss=-0.0001 (P(better)=0.27, n=1203); failed: improves_winner_log_loss, not_one_night |
| 2024-05-14 | reject | Home court is mis-weighted (home teams win at a different rate than stated): tighten Model E (situation) prior: Δwinner_log_loss=+0.0002 (P(better)=0.79, n=1203); failed: improves_winner_log_loss |
| 2024-05-14 | refit | No candidate met the promotion criteria; the validated configuration was re-estimated on 150 additional games. Methodology unchanged. |

Decision counts: initial 1, promote 5, refit 12, reject 46

## Weakness hypotheses that reached statistical support

| Hypothesis | n | Bias | q |
| --- | --- | --- | --- |
| The probability of a 13+ point game is biased | 158 | -0.092 | 0.087 |
| Home court is mis-weighted (home teams win at a different rate than stated) | 308 | +0.080 | 0.011 |
| Road favourites are mis-rated | 130 | -0.101 | 0.055 |
| Teams with two or more extra days of rest are mis-rated | 132 | +0.109 | 0.034 |
| Teams on the second night of a back-to-back are mis-rated | 344 | -0.056 | 0.096 |
| The probability of a game decided by 5 or fewer is biased | 1840 | -0.025 | 0.047 |
| Visitors at altitude (Denver, Utah) are mis-rated | 136 | -0.088 | 0.054 |
| Total points are biased overall | 2453 | -0.048 | 0.045 |
| Totals are biased when both teams play faster than the league | 230 | -0.148 | 0.069 |

## Active model at the end of the replay

`v18-b9ca0f7bc6b8-2024-05-14` — trained on games before 2024-05-14; form half-life 15 days, season prior 12 games, calibration temperature, early-season gating False, three-point terms False, schedule-adjusted rating False.

## Reading these numbers

* NBA favourites win often, so accuracy around two-thirds is typical for good public models; closing betting lines are the real benchmark and are not available for this replay.
* Log loss and Brier matter more than accuracy: they reward honest probabilities.
* A `refit` re-estimates the validated configuration on new data; it is not a claim of improvement. Only a `promote` reflects a methodology change that beat the incumbent out of sample.
