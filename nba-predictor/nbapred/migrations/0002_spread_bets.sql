-- Point-spread bets alongside moneylines: sim_bets.strategy is now the market (moneyline | spread).
ALTER TABLE sim_bets ADD COLUMN line REAL;            -- spread points from the pick's side (e.g. -5.5)
ALTER TABLE sim_bets ADD COLUMN closing_line REAL;    -- last line before the result, same side
UPDATE sim_bets SET strategy='moneyline' WHERE strategy='confidence_flat';
