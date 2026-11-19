-- Point-spread bets alongside moneylines: sim_bets.strategy is now the market (moneyline | spread).
ALTER TABLE sim_bets ADD COLUMN IF NOT EXISTS line DOUBLE PRECISION;
ALTER TABLE sim_bets ADD COLUMN IF NOT EXISTS closing_line DOUBLE PRECISION;
ALTER TABLE sim_bets ALTER COLUMN strategy SET DEFAULT 'moneyline';
UPDATE sim_bets SET strategy='moneyline' WHERE strategy='confidence_flat';
