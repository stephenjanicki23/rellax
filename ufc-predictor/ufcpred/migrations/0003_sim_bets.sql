-- Simulated betting tracker. Comparison/evaluation only: nothing here is read by the prediction engine.
-- One row per fight per strategy; every change to a row is recorded in sim_bet_events (append-only).
CREATE TABLE IF NOT EXISTS sim_bets (
    id                INTEGER PRIMARY KEY,
    strategy          TEXT NOT NULL DEFAULT 'confidence_flat',
    event_id          INTEGER NOT NULL REFERENCES events(id),
    fight_id          INTEGER NOT NULL REFERENCES fights(id),
    prediction_id     INTEGER NOT NULL REFERENCES predictions(id),  -- the prediction the bet follows
    prediction_version INTEGER,
    event_name        TEXT,                -- snapshots, so the ledger reads the same if names are corrected later
    event_date        TEXT,
    weight_class      TEXT,
    tier              TEXT NOT NULL,       -- High | Medium | Low (the engine's confidence label)
    confidence_score  REAL,
    pick_fighter_id   INTEGER REFERENCES fighters(id),
    pick_name         TEXT,
    opponent_fighter_id INTEGER REFERENCES fighters(id),
    opponent_name     TEXT,
    p_pick            REAL,                -- engine's win probability for the pick
    stake_cents       INTEGER NOT NULL,    -- 0 for Low (tracked, no bet)
    odds_decimal      REAL,                -- NULL until odds are available; never invented
    odds_american     INTEGER,
    odds_source       TEXT,                -- feed | import | manual
    odds_bookmaker    TEXT,
    odds_captured_at  TEXT,
    odds_id           INTEGER REFERENCES odds(id),
    status            TEXT NOT NULL,       -- pending | win | loss | push | void | no_bet
    net_cents         INTEGER,             -- realised P/L; NULL while pending or when odds are missing
    result_id         INTEGER REFERENCES fight_results(id),
    settle_note       TEXT,
    settled_at        TEXT,
    locked_at         TEXT,                -- selection, stake and (once set) odds are frozen from here on
    manual_override   INTEGER NOT NULL DEFAULT 0,  -- an admin correction pins the settlement
    rationale_json    TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    UNIQUE (fight_id, strategy)
);
CREATE INDEX IF NOT EXISTS ix_sim_bets_event ON sim_bets(event_id);
CREATE INDEX IF NOT EXISTS ix_sim_bets_status ON sim_bets(status);

CREATE TABLE IF NOT EXISTS sim_bet_events (
    id            INTEGER PRIMARY KEY,
    bet_id        INTEGER NOT NULL REFERENCES sim_bets(id),
    ts            TEXT NOT NULL,
    actor         TEXT NOT NULL,
    action        TEXT NOT NULL,           -- created | prediction_changed | odds_set | locked | settled | resettled | corrected
    before_json   TEXT,
    after_json    TEXT,
    reason        TEXT
);
CREATE INDEX IF NOT EXISTS ix_sim_bet_events_bet ON sim_bet_events(bet_id);
CREATE TRIGGER IF NOT EXISTS trg_sim_bet_events_no_update BEFORE UPDATE ON sim_bet_events
BEGIN SELECT RAISE(ABORT, 'bet history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_sim_bet_events_no_delete BEFORE DELETE ON sim_bet_events
BEGIN SELECT RAISE(ABORT, 'bet history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_sim_bets_no_delete BEFORE DELETE ON sim_bets
BEGIN SELECT RAISE(ABORT, 'bets are never deleted; void them instead'); END;
