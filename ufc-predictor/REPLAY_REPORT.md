# Historical replay report

_Generated 2026-10-24T16:27:32+00:00 by `python -m ufcpred report --mode replay` from the database; every number below is computed by the pipeline._

## Protocol

* 88 real UFC events from 2024-10-05 to 2026-10-17, processed one at a time in date order.
* For each event: predict with the active model using only fights strictly before the event date → lock in the ledger → grade against the official result → run the learning loop with data up to the day after.
* 1098 predictions locked; 1086 graded on winner; 12 draws/no-contests recorded but not scored.
* Ledger verification: intact (1098 rows, hash chain checked).
* Data: UFCStats CSV mirror (github.com/Greco1899/scrape_ufc_stats, GPL-3.0). No betting odds were available, so there is no market baseline.

## Winner prediction and probability quality

| Metric | Value | 95% interval |
| --- | --- | --- |
| Accuracy (n=1086) | 64.3% | 61.4%–67.1% (Wilson) |
| Log loss | 0.6338 | 0.6109–0.6559 (event bootstrap) |
| Brier | 0.2212 | 0.2113–0.2308 |
| ECE (5 bins) | 1.4% | |

### Baselines on the same fights

| Model | Log loss | Brier | Accuracy |
| --- | --- | --- | --- |
| **This engine** | **0.6338** | 0.2212 | 64.3% |
| Coin flip (50/50) | 0.6931 | 0.2500 | 50.0% |
| Historical base rate (more-experienced fighter) | 0.6962 | 0.2515 | 45.2% |
| Elo only | 0.6839 | 0.2454 | 55.0% |

### Calibration (probability given to the predicted winner)

| Band | n | Mean stated | Observed | 95% CI |
| --- | --- | --- | --- | --- |
| 0.5–0.6 | 413 | 54.7% | 55.0% | 50%–60% |
| 0.6–0.7 | 332 | 64.6% | 65.4% | 60%–70% |
| 0.7–0.8 | 227 | 74.5% | 71.4% | 65%–77% |
| 0.8–0.9 | 102 | 84.2% | 80.4% | 72%–87% |
| 0.9–1.0 | 12 | 91.7% | 83.3% | 55%–95% |

### Rolling windows

| Window | Accuracy | Log loss |
| --- | --- | --- |
| last 5 | 60.0% | 0.809 |
| last 10 | 70.0% | 0.801 |
| last 25 | 60.0% | 0.818 |
| last 50 | 64.0% | 0.688 |
| last 100 | 58.0% | 0.704 |

## Method and round

| Method | Actual | Predicted | Recall | Precision |
| --- | --- | --- | --- | --- |
| KO/TKO | 390 | 285 | 39.0% | 53.3% |
| Submission | 191 | 40 | 6.3% | 30.0% |
| Decision | 504 | 761 | 78.4% | 51.9% |

8-way (corner × method) log loss 1.579 (uniform guess 2.079); round/decision accuracy 48.4%.

## By confidence label

| Label | n | Accuracy | Log loss |
| --- | --- | --- | --- |
| High | 418 | 66.5% | 0.629 |
| Low | 311 | 63.0% | 0.635 |
| Medium | 357 | 62.7% | 0.638 |

## Learning loop decisions

| Date (as of) | Decision | Detail |
| --- | --- | --- |
| 2024-10-05 | initial | first deployment: no incumbent. Half-life chosen by out-of-sample log loss; validated against baselines |
| 2024-11-03 | reject | Routine re-validation of the form half-life (540 → 270 days): Δwinner_log_loss=-0.0027 (P(better)=0.07, n=459); failed: improves_winner_log_loss, not_one_card |
| 2024-11-03 | reject | Routine re-validation of the form half-life (540 → 1080 days): Δwinner_log_loss=-0.0010 (P(better)=0.28, n=459); failed: improves_winner_log_loss, not_one_card |
| 2024-11-03 | reject | Routine experiment: experience-gated ensemble weights: Δwinner_log_loss=+0.0013 (P(better)=0.78, n=459); failed: improves_winner_log_loss, not_one_card |
| 2024-11-03 | refit | No candidate met the promotion criteria; the validated configuration was re-estimated on 61 additional fights. Methodology unchanged. |
| 2024-12-15 | reject | Routine re-validation of the form half-life (540 → 270 days): Δwinner_log_loss=-0.0031 (P(better)=0.05, n=459); failed: improves_winner_log_loss, not_one_card |
| 2024-12-15 | reject | Routine re-validation of the form half-life (540 → 1080 days): Δwinner_log_loss=+0.0000 (P(better)=0.51, n=459); failed: improves_winner_log_loss, not_one_card |
| 2024-12-15 | reject | Routine experiment: experience-gated ensemble weights: Δwinner_log_loss=+0.0019 (P(better)=0.86, n=459); failed: improves_winner_log_loss |
| 2024-12-15 | refit | No candidate met the promotion criteria; the validated configuration was re-estimated on 60 additional fights. Methodology unchanged. |
| 2025-02-16 | reject | Routine re-validation of the form half-life (540 → 270 days): Δwinner_log_loss=-0.0000 (P(better)=0.51, n=459); failed: improves_winner_log_loss, not_one_card |
| 2025-02-16 | reject | Routine re-validation of the form half-life (540 → 1080 days): Δwinner_log_loss=-0.0022 (P(better)=0.12, n=459); failed: improves_winner_log_loss, not_one_card |
| 2025-02-16 | promote | Routine experiment: experience-gated ensemble weights: Δwinner_log_loss=+0.0040 (P(better)=0.97, n=459); all criteria passed |
| 2025-03-30 | reject | Routine re-validation of the form half-life (540 → 270 days): Δwinner_log_loss=+0.0004 (P(better)=0.55, n=452); failed: improves_winner_log_loss, not_one_card |
| 2025-03-30 | reject | Routine re-validation of the form half-life (540 → 1080 days): Δwinner_log_loss=-0.0023 (P(better)=0.09, n=452); failed: improves_winner_log_loss, not_one_card |
| 2025-03-30 | reject | Routine experiment: experience-gated ensemble weights: Δwinner_log_loss=-0.0044 (P(better)=0.02, n=452); failed: improves_winner_log_loss, not_one_card |
| 2025-03-30 | refit | No candidate met the promotion criteria; the validated configuration was re-estimated on 70 additional fights. Methodology unchanged. |
| 2025-05-11 | reject | Routine re-validation of the form half-life (540 → 270 days): Δwinner_log_loss=+0.0001 (P(better)=0.49, n=454); failed: improves_winner_log_loss, not_one_card |
| 2025-05-11 | reject | Routine re-validation of the form half-life (540 → 1080 days): Δwinner_log_loss=-0.0020 (P(better)=0.10, n=454); failed: improves_winner_log_loss, not_one_card |
| 2025-05-11 | reject | Routine experiment: experience-gated ensemble weights: Δwinner_log_loss=-0.0063 (P(better)=0.00, n=454); failed: improves_winner_log_loss, brier_not_worse, not_one_card |
| 2025-05-11 | refit | No candidate met the promotion criteria; the validated configuration was re-estimated on 63 additional fights. Methodology unchanged. |
| 2025-06-29 | reject | Routine re-validation of the form half-life (540 → 270 days): Δwinner_log_loss=-0.0002 (P(better)=0.46, n=462); failed: improves_winner_log_loss, not_one_card |
| 2025-06-29 | reject | Routine re-validation of the form half-life (540 → 1080 days): Δwinner_log_loss=-0.0025 (P(better)=0.04, n=462); failed: improves_winner_log_loss, not_one_card |
| 2025-06-29 | reject | Routine experiment: experience-gated ensemble weights: Δwinner_log_loss=-0.0044 (P(better)=0.02, n=462); failed: improves_winner_log_loss, not_one_card |
| 2025-06-29 | refit | No candidate met the promotion criteria; the validated configuration was re-estimated on 67 additional fights. Methodology unchanged. |
| 2025-08-10 | reject | Routine re-validation of the form half-life (540 → 270 days): Δwinner_log_loss=+0.0006 (P(better)=0.62, n=458); failed: improves_winner_log_loss, calibration_by_range, not_one_card |
| 2025-08-10 | reject | Routine re-validation of the form half-life (540 → 1080 days): Δwinner_log_loss=-0.0034 (P(better)=0.01, n=458); failed: improves_winner_log_loss, not_one_card |
| 2025-08-10 | reject | Routine experiment: experience-gated ensemble weights: Δwinner_log_loss=-0.0074 (P(better)=0.00, n=458); failed: improves_winner_log_loss, brier_not_worse, not_one_card |
| 2025-08-10 | refit | No candidate met the promotion criteria; the validated configuration was re-estimated on 62 additional fights. Methodology unchanged. |
| 2025-09-28 | reject | Routine re-validation of the form half-life (540 → 270 days): Δwinner_log_loss=+0.0012 (P(better)=0.77, n=456); failed: improves_winner_log_loss, not_one_card |
| 2025-09-28 | reject | Routine re-validation of the form half-life (540 → 1080 days): Δwinner_log_loss=-0.0036 (P(better)=0.01, n=456); failed: improves_winner_log_loss, not_one_card |
| 2025-09-28 | reject | Routine experiment: experience-gated ensemble weights: Δwinner_log_loss=-0.0064 (P(better)=0.00, n=456); failed: improves_winner_log_loss, brier_not_worse, not_one_card |
| 2025-09-28 | refit | No candidate met the promotion criteria; the validated configuration was re-estimated on 60 additional fights. Methodology unchanged. |
| 2025-11-02 | reject | Routine re-validation of the form half-life (540 → 270 days): Δwinner_log_loss=+0.0015 (P(better)=0.82, n=460); failed: improves_winner_log_loss, not_one_card |
| 2025-11-02 | reject | Routine re-validation of the form half-life (540 → 1080 days): Δwinner_log_loss=-0.0033 (P(better)=0.02, n=460); failed: improves_winner_log_loss, not_one_card |
| 2025-11-02 | reject | Routine experiment: experience-gated ensemble weights: Δwinner_log_loss=-0.0060 (P(better)=0.01, n=460); failed: improves_winner_log_loss, brier_not_worse, not_one_card |
| 2025-11-02 | refit | No candidate met the promotion criteria; the validated configuration was re-estimated on 64 additional fights. Methodology unchanged. |
| 2025-12-14 | reject | Routine re-validation of the form half-life (540 → 270 days): Δwinner_log_loss=-0.0004 (P(better)=0.43, n=450); failed: improves_winner_log_loss, not_one_card |
| 2025-12-14 | reject | Routine re-validation of the form half-life (540 → 1080 days): Δwinner_log_loss=-0.0012 (P(better)=0.20, n=450); failed: improves_winner_log_loss, not_one_card |
| 2025-12-14 | reject | Routine experiment: experience-gated ensemble weights: Δwinner_log_loss=-0.0042 (P(better)=0.02, n=450); failed: improves_winner_log_loss, not_one_card |
| 2025-12-14 | refit | No candidate met the promotion criteria; the validated configuration was re-estimated on 64 additional fights. Methodology unchanged. |
| 2026-03-01 | reject | Routine re-validation of the form half-life (540 → 270 days): Δwinner_log_loss=-0.0011 (P(better)=0.17, n=453); failed: improves_winner_log_loss, not_one_card |
| 2026-03-01 | reject | Routine re-validation of the form half-life (540 → 1080 days): Δwinner_log_loss=-0.0004 (P(better)=0.38, n=453); failed: improves_winner_log_loss, not_one_card |
| 2026-03-01 | reject | Routine experiment: experience-gated ensemble weights: Δwinner_log_loss=-0.0035 (P(better)=0.04, n=453); failed: improves_winner_log_loss, not_one_card |
| 2026-03-01 | refit | No candidate met the promotion criteria; the validated configuration was re-estimated on 61 additional fights. Methodology unchanged. |
| 2026-04-05 | reject | Routine re-validation of the form half-life (540 → 270 days): Δwinner_log_loss=-0.0015 (P(better)=0.13, n=454); failed: improves_winner_log_loss, not_one_card |
| 2026-04-05 | reject | Routine re-validation of the form half-life (540 → 1080 days): Δwinner_log_loss=-0.0000 (P(better)=0.49, n=454); failed: improves_winner_log_loss, not_one_card |
| 2026-04-05 | reject | Routine experiment: experience-gated ensemble weights: Δwinner_log_loss=-0.0016 (P(better)=0.21, n=454); failed: improves_winner_log_loss, not_one_card |
| 2026-04-05 | refit | No candidate met the promotion criteria; the validated configuration was re-estimated on 64 additional fights. Methodology unchanged. |
| 2026-05-10 | reject | Routine re-validation of the form half-life (540 → 270 days): Δwinner_log_loss=+0.0000 (P(better)=0.50, n=459); failed: improves_winner_log_loss, not_one_card |
| 2026-05-10 | reject | Routine re-validation of the form half-life (540 → 1080 days): Δwinner_log_loss=-0.0007 (P(better)=0.32, n=459); failed: improves_winner_log_loss, not_one_card |
| 2026-05-10 | reject | Routine experiment: experience-gated ensemble weights: Δwinner_log_loss=-0.0024 (P(better)=0.11, n=459); failed: improves_winner_log_loss, not_one_card |
| 2026-05-10 | refit | No candidate met the promotion criteria; the validated configuration was re-estimated on 61 additional fights. Methodology unchanged. |
| 2026-06-28 | reject | Routine re-validation of the form half-life (540 → 270 days): Δwinner_log_loss=+0.0000 (P(better)=0.49, n=455); failed: improves_winner_log_loss, not_one_card |
| 2026-06-28 | reject | Routine re-validation of the form half-life (540 → 1080 days): Δwinner_log_loss=-0.0001 (P(better)=0.51, n=455); failed: improves_winner_log_loss, not_one_card |
| 2026-06-28 | reject | Routine experiment: experience-gated ensemble weights: Δwinner_log_loss=-0.0013 (P(better)=0.25, n=455); failed: improves_winner_log_loss, not_one_card |
| 2026-06-28 | refit | No candidate met the promotion criteria; the validated configuration was re-estimated on 69 additional fights. Methodology unchanged. |
| 2026-08-09 | reject | Routine re-validation of the form half-life (540 → 270 days): Δwinner_log_loss=+0.0003 (P(better)=0.58, n=459); failed: improves_winner_log_loss, not_one_card |
| 2026-08-09 | reject | Routine re-validation of the form half-life (540 → 1080 days): Δwinner_log_loss=-0.0005 (P(better)=0.38, n=459); failed: improves_winner_log_loss, not_one_card |
| 2026-08-09 | reject | Routine experiment: experience-gated ensemble weights: Δwinner_log_loss=+0.0000 (P(better)=0.52, n=459); failed: improves_winner_log_loss, not_one_card |
| 2026-08-09 | refit | No candidate met the promotion criteria; the validated configuration was re-estimated on 64 additional fights. Methodology unchanged. |
| 2026-09-13 | reject | Routine re-validation of the form half-life (540 → 270 days): Δwinner_log_loss=+0.0003 (P(better)=0.55, n=460); failed: improves_winner_log_loss, not_one_card |
| 2026-09-13 | reject | Routine re-validation of the form half-life (540 → 1080 days): Δwinner_log_loss=+0.0001 (P(better)=0.54, n=460); failed: improves_winner_log_loss, not_one_card |
| 2026-09-13 | reject | Routine experiment: experience-gated ensemble weights: Δwinner_log_loss=+0.0010 (P(better)=0.73, n=460); failed: improves_winner_log_loss, not_one_card |
| 2026-09-13 | refit | No candidate met the promotion criteria; the validated configuration was re-estimated on 64 additional fights. Methodology unchanged. |
| 2026-10-18 | reject | The probability of a decision is biased: stronger regularisation of the method model: Δmethod_log_loss=-0.0000 (P(better)=0.49, n=454); failed: improves_method_log_loss, not_one_card |
| 2026-10-18 | reject | The probability of a decision is biased: weaker regularisation of the method model: Δmethod_log_loss=-0.0000 (P(better)=0.51, n=454); failed: improves_method_log_loss, not_one_card |
| 2026-10-18 | reject | Routine re-validation of the form half-life (540 → 270 days): Δwinner_log_loss=+0.0003 (P(better)=0.59, n=454); failed: improves_winner_log_loss, not_one_card |
| 2026-10-18 | refit | No candidate met the promotion criteria; the validated configuration was re-estimated on 60 additional fights. Methodology unchanged. |

Decision counts: initial 1, promote 1, refit 16, reject 50

## Weakness hypotheses that reached statistical support

| Hypothesis | n | Bias | q |
| --- | --- | --- | --- |
| The probability of a decision is biased | 1086 | -3.9 pts | 0.088 |

## Active model at the end of the replay

`v18-7caf62b4c762-2026-10-18` — trained on fights before 2026-10-18; half-life 540 days, calibration temperature, evidence gating True, style v2 False.

## Reading these numbers

* A ~60–65% winner accuracy without odds is typical for UFC models; closing betting lines usually do better, and this report cannot compare against them because no odds were available.
* The 'more-experienced fighter' base rate is estimated from fights before each model's cutoff (≈51% from 2005 on); if it falls below a coin flip here, the experience edge reversed in this period. It is reported as measured.
* Intervals are wide: a few points of accuracy is within noise at this sample size.
* A `refit` re-estimates the validated configuration on new data; it is not a claim of improvement. Only a `promote` reflects a methodology change that beat the incumbent out of sample.
