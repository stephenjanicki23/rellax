-- Closing line for each simulated bet (last price before the fight), for closing-line-value tracking.
ALTER TABLE sim_bets ADD COLUMN IF NOT EXISTS closing_decimal DOUBLE PRECISION;
ALTER TABLE sim_bets ADD COLUMN IF NOT EXISTS closing_captured_at TEXT;
