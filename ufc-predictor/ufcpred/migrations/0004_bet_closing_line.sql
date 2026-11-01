-- Closing line for each simulated bet (last price before the fight), for closing-line-value tracking.
ALTER TABLE sim_bets ADD COLUMN closing_decimal REAL;
ALTER TABLE sim_bets ADD COLUMN closing_captured_at TEXT;
