-- Model Lab: one row per graded official prediction with each alternative model's chance for the red corner.
-- Tracking only: rebuilt from predictions/results/odds; nothing in the prediction engine reads it.
CREATE TABLE IF NOT EXISTS model_lab (
    id               INTEGER PRIMARY KEY,
    prediction_id    INTEGER NOT NULL UNIQUE REFERENCES predictions(id),
    fight_id         INTEGER NOT NULL REFERENCES fights(id),
    event_id         INTEGER NOT NULL REFERENCES events(id),
    mode             TEXT NOT NULL,
    event_date       TEXT,
    weight_class     TEXT,
    is_women         INTEGER,
    card_segment     TEXT,
    scheduled_rounds INTEGER,
    result_id        INTEGER,
    red_won          INTEGER NOT NULL,
    p_engine         REAL,
    p_ratings        REAL,
    p_form           REAL,
    p_style          REAL,
    p_durability     REAL,
    p_elo            REAL,
    market_red       REAL,
    red_decimal      REAL,
    blue_decimal     REAL,
    created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_model_lab_mode ON model_lab(mode);
