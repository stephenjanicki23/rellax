-- NBA Prediction Engine — initial schema.
--
-- Design rules enforced here, not only in Python:
--   * predictions, prediction_locks, audit_log, promotion_decisions and bet history are append-only
--     (UPDATE and DELETE abort via triggers). A changed prediction is a new row.
--   * official results are revisioned: a correction is a new revision, never an edit.
--   * migrations are additive. No migration may DROP a table holding history.
--
-- Vocabulary: an "event" is one NBA game night (every game on one date). Predictions lock per game
-- night before its first tip-off, exactly like a fight card locks before its first bout.

CREATE TABLE IF NOT EXISTS data_sources (
    id            INTEGER PRIMARY KEY,
    provider      TEXT NOT NULL,
    resource      TEXT NOT NULL,
    url           TEXT,
    license       TEXT,
    retrieved_at  TEXT NOT NULL,
    sha256        TEXT,
    status        TEXT NOT NULL,              -- ok | error | stale | cached
    http_status   INTEGER,
    error         TEXT,
    cache_path    TEXT,
    rows          INTEGER
);
CREATE INDEX IF NOT EXISTS ix_data_sources_provider ON data_sources(provider, resource, retrieved_at);

CREATE TABLE IF NOT EXISTS teams (
    id            INTEGER PRIMARY KEY,
    external_id   TEXT UNIQUE,                 -- nba:<NBA team id>, or manual-team:<key>
    abbr          TEXT,
    name          TEXT NOT NULL,
    conference    TEXT,
    division      TEXT,
    source_id     INTEGER REFERENCES data_sources(id),
    origin        TEXT NOT NULL DEFAULT 'provider',   -- provider | manual
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_teams_name ON teams(name);

CREATE TABLE IF NOT EXISTS events (
    id            INTEGER PRIMARY KEY,
    external_id   TEXT UNIQUE,                 -- night:YYYY-MM-DD
    name          TEXT NOT NULL,
    date          TEXT NOT NULL,               -- ISO date (US local date of the games)
    start_time_utc TEXT,                       -- earliest tip-off when known; otherwise lock uses the date
    venue         TEXT,
    location      TEXT,
    status        TEXT NOT NULL DEFAULT 'scheduled', -- scheduled|locked|completed|evaluated|canceled|missed_lock
    origin        TEXT NOT NULL DEFAULT 'provider',
    source_id     INTEGER REFERENCES data_sources(id),
    source_url    TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_events_date ON events(date);

CREATE TABLE IF NOT EXISTS games (
    id            INTEGER PRIMARY KEY,
    external_id   TEXT UNIQUE,                 -- nba:<game id> | espn:<event id> | manual:<hash>
    event_id      INTEGER NOT NULL REFERENCES events(id),
    home_team_id  INTEGER NOT NULL REFERENCES teams(id),
    away_team_id  INTEGER NOT NULL REFERENCES teams(id),
    season        TEXT,                        -- e.g. 2026-27
    season_type   TEXT NOT NULL DEFAULT 'regular',  -- regular | playin | playoffs | cup_final | preseason
    neutral_site  INTEGER NOT NULL DEFAULT 0,
    venue_city    TEXT,                        -- when the game is not in the home team's arena
    tip_time_utc  TEXT,
    game_order    INTEGER,                     -- order of tip-off within the night
    status        TEXT NOT NULL DEFAULT 'scheduled', -- scheduled|completed|postponed|canceled|replaced
    replaced_by_game_id INTEGER REFERENCES games(id),
    home_out      INTEGER,                     -- rotation players ruled out: NULL = unknown, 0..n = documented
    away_out      INTEGER,
    origin        TEXT NOT NULL DEFAULT 'provider',
    source_id     INTEGER REFERENCES data_sources(id),
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    CHECK (home_team_id <> away_team_id)
);
CREATE INDEX IF NOT EXISTS ix_games_event ON games(event_id);
CREATE INDEX IF NOT EXISTS ix_games_home ON games(home_team_id);
CREATE INDEX IF NOT EXISTS ix_games_away ON games(away_team_id);

-- Official results, revisioned. The latest revision is authoritative; older ones are kept.
CREATE TABLE IF NOT EXISTS game_results (
    id            INTEGER PRIMARY KEY,
    game_id       INTEGER NOT NULL REFERENCES games(id),
    revision      INTEGER NOT NULL,
    outcome       TEXT NOT NULL,              -- win | nc (abandoned / forfeited: never graded)
    winner_team_id INTEGER REFERENCES teams(id),
    home_score    INTEGER,
    away_score    INTEGER,
    periods       INTEGER,                    -- 4 = regulation, 5+ = overtime
    details       TEXT,
    reason        TEXT,
    origin        TEXT NOT NULL DEFAULT 'provider',
    source_id     INTEGER REFERENCES data_sources(id),
    source_url    TEXT,
    recorded_at   TEXT NOT NULL,
    UNIQUE (game_id, revision)
);
CREATE INDEX IF NOT EXISTS ix_results_game ON game_results(game_id, revision);

-- Team box score per game (totals). NULL = not available from the source (never zero).
CREATE TABLE IF NOT EXISTS team_game_stats (
    game_id       INTEGER NOT NULL REFERENCES games(id),
    team_id       INTEGER NOT NULL REFERENCES teams(id),
    minutes       REAL,
    pts INTEGER, fgm INTEGER, fga INTEGER, fg3m INTEGER, fg3a INTEGER, ftm INTEGER, fta INTEGER,
    oreb INTEGER, dreb INTEGER, ast INTEGER, stl INTEGER, blk INTEGER, tov INTEGER, pf INTEGER,
    PRIMARY KEY (game_id, team_id)
);

-- Point-in-time team snapshots: exactly what the engine knew about a team before a game.
CREATE TABLE IF NOT EXISTS team_snapshots (
    id            INTEGER PRIMARY KEY,
    team_id       INTEGER NOT NULL REFERENCES teams(id),
    game_id       INTEGER REFERENCES games(id),
    as_of         TEXT NOT NULL,
    state_json    TEXT NOT NULL,
    sha256        TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    UNIQUE (team_id, game_id, sha256)
);

-- Market lines: moneyline (decimal), spread (home points + prices) and total. Any part may be missing.
CREATE TABLE IF NOT EXISTS odds (
    id            INTEGER PRIMARY KEY,
    game_id       INTEGER NOT NULL REFERENCES games(id),
    provider      TEXT NOT NULL,
    bookmaker     TEXT,
    home_decimal  REAL,
    away_decimal  REAL,
    spread_home   REAL,                       -- e.g. -5.5 = home favoured by 5.5
    spread_home_decimal REAL,
    spread_away_decimal REAL,
    total         REAL,
    over_decimal  REAL,
    under_decimal REAL,
    captured_at   TEXT NOT NULL,
    source_url    TEXT,
    created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_odds_game ON odds(game_id, captured_at);

CREATE TABLE IF NOT EXISTS model_versions (
    id            INTEGER PRIMARY KEY,
    label         TEXT NOT NULL UNIQUE,
    parent_id     INTEGER REFERENCES model_versions(id),
    status        TEXT NOT NULL,              -- candidate | active | retired | rejected
    config_json   TEXT NOT NULL,
    params_json   TEXT NOT NULL,
    params_sha256 TEXT NOT NULL,
    training_cutoff TEXT NOT NULL,            -- only games strictly before this date were used
    n_train       INTEGER NOT NULL,
    training_run_id INTEGER,
    notes         TEXT,
    created_at    TEXT NOT NULL,
    activated_at  TEXT
);

CREATE TABLE IF NOT EXISTS training_runs (
    id            INTEGER PRIMARY KEY,
    started_at    TEXT NOT NULL,
    finished_at   TEXT,
    cutoff        TEXT NOT NULL,
    n_train       INTEGER,
    config_json   TEXT NOT NULL,
    diagnostics_json TEXT,
    seed          INTEGER,
    status        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backtest_runs (
    id            INTEGER PRIMARY KEY,
    label         TEXT NOT NULL,
    config_json   TEXT NOT NULL,
    config_sha256 TEXT NOT NULL,
    start_date    TEXT,
    end_date      TEXT,
    n_folds       INTEGER,
    n_games       INTEGER,
    metrics_json  TEXT,
    folds_json    TEXT,
    leakage_audit_json TEXT,
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backtest_predictions (
    backtest_run_id INTEGER NOT NULL REFERENCES backtest_runs(id),
    game_id       INTEGER NOT NULL REFERENCES games(id),
    event_id      INTEGER NOT NULL,
    fold          INTEGER NOT NULL,
    train_cutoff  TEXT NOT NULL,
    p_home        REAL NOT NULL,
    home_won      INTEGER NOT NULL,
    pred_margin   REAL,
    pred_total    REAL,
    actual_margin INTEGER,
    actual_total  INTEGER,
    PRIMARY KEY (backtest_run_id, game_id)
);

-- The prediction ledger. Append-only (see triggers below).
CREATE TABLE IF NOT EXISTS predictions (
    id            INTEGER PRIMARY KEY,
    game_id       INTEGER NOT NULL REFERENCES games(id),
    event_id      INTEGER NOT NULL REFERENCES events(id),
    version       INTEGER NOT NULL,
    supersedes_id INTEGER REFERENCES predictions(id),
    reason        TEXT NOT NULL,
    mode          TEXT NOT NULL,              -- live | replay
    created_at    TEXT NOT NULL,
    as_of         TEXT NOT NULL,              -- decision time: data on/after this date is invisible
    data_cutoff   TEXT NOT NULL,
    model_version_id INTEGER NOT NULL REFERENCES model_versions(id),
    home_team_id  INTEGER NOT NULL,
    away_team_id  INTEGER NOT NULL,
    home_snapshot_id INTEGER REFERENCES team_snapshots(id),
    away_snapshot_id INTEGER REFERENCES team_snapshots(id),
    p_home        REAL NOT NULL,
    p_away        REAL NOT NULL,
    predicted_winner_id INTEGER NOT NULL,
    predicted_margin REAL NOT NULL,           -- home points minus away points (expected)
    predicted_total REAL,
    predicted_bucket TEXT NOT NULL,           -- winning-margin band for the predicted winner: CLOSE | SOLID | BLOWOUT
    confidence    TEXT NOT NULL,
    is_post_lock  INTEGER NOT NULL DEFAULT 0,
    payload_json  TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    prev_sha256   TEXT,
    UNIQUE (game_id, version, mode)
);
CREATE INDEX IF NOT EXISTS ix_predictions_event ON predictions(event_id, mode);
CREATE INDEX IF NOT EXISTS ix_predictions_game ON predictions(game_id, mode, version);

CREATE TRIGGER IF NOT EXISTS trg_predictions_no_update BEFORE UPDATE ON predictions
BEGIN SELECT RAISE(ABORT, 'prediction ledger is append-only: predictions cannot be updated'); END;
CREATE TRIGGER IF NOT EXISTS trg_predictions_no_delete BEFORE DELETE ON predictions
BEGIN SELECT RAISE(ABORT, 'prediction ledger is append-only: predictions cannot be deleted'); END;

CREATE TABLE IF NOT EXISTS prediction_locks (
    id            INTEGER PRIMARY KEY,
    event_id      INTEGER NOT NULL REFERENCES events(id),
    mode          TEXT NOT NULL,
    locked_at     TEXT NOT NULL,
    as_of         TEXT NOT NULL,
    reason        TEXT NOT NULL,
    prediction_ids_json TEXT NOT NULL,
    UNIQUE (event_id, mode)
);
CREATE TRIGGER IF NOT EXISTS trg_locks_no_update BEFORE UPDATE ON prediction_locks
BEGIN SELECT RAISE(ABORT, 'prediction locks are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_locks_no_delete BEFORE DELETE ON prediction_locks
BEGIN SELECT RAISE(ABORT, 'prediction locks are append-only'); END;

CREATE TABLE IF NOT EXISTS prediction_lock_members (
    lock_id       INTEGER NOT NULL REFERENCES prediction_locks(id),
    prediction_id INTEGER NOT NULL REFERENCES predictions(id),
    PRIMARY KEY (lock_id, prediction_id)
);
CREATE INDEX IF NOT EXISTS ix_lock_members_prediction ON prediction_lock_members(prediction_id);
CREATE TRIGGER IF NOT EXISTS trg_lock_members_no_update BEFORE UPDATE ON prediction_lock_members
BEGIN SELECT RAISE(ABORT, 'prediction locks are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_lock_members_no_delete BEFORE DELETE ON prediction_lock_members
BEGIN SELECT RAISE(ABORT, 'prediction locks are append-only'); END;

CREATE TABLE IF NOT EXISTS prediction_evaluations (
    id            INTEGER PRIMARY KEY,
    prediction_id INTEGER NOT NULL REFERENCES predictions(id),
    result_id     INTEGER NOT NULL REFERENCES game_results(id),
    evaluated_at  TEXT NOT NULL,
    scored        INTEGER NOT NULL,           -- 0 for abandoned/forfeited games (excluded from metrics)
    correct_winner INTEGER,
    p_actual      REAL,
    brier         REAL,
    log_loss      REAL,
    margin_error  REAL,                       -- actual − predicted home margin
    total_error   REAL,                       -- actual − predicted total points
    bucket_correct INTEGER,                   -- winner and winning-margin band both right
    bucket_log_loss REAL,                     -- −log P(actual winner × band)
    ats_correct   INTEGER,                    -- engine's side against the market spread covered (NULL: no line)
    total_pick_correct INTEGER,               -- engine's over/under against the market total was right (NULL: no line)
    calibration_note TEXT,
    details_json  TEXT NOT NULL,
    UNIQUE (prediction_id, result_id)
);

CREATE TABLE IF NOT EXISTS error_diagnostics (
    id            INTEGER PRIMARY KEY,
    evaluation_id INTEGER NOT NULL REFERENCES prediction_evaluations(id),
    prediction_id INTEGER NOT NULL REFERENCES predictions(id),
    category      TEXT NOT NULL,              -- ordinary_uncertainty | data_quality | model_weakness
    report_json   TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    UNIQUE (evaluation_id)
);

CREATE TABLE IF NOT EXISTS learning_runs (
    id            INTEGER PRIMARY KEY,
    trigger_event_id INTEGER REFERENCES events(id),
    mode          TEXT NOT NULL,
    as_of         TEXT NOT NULL,
    started_at    TEXT NOT NULL,
    finished_at   TEXT,
    status        TEXT NOT NULL,
    summary_json  TEXT
);

CREATE TABLE IF NOT EXISTS weakness_hypotheses (
    id            INTEGER PRIMARY KEY,
    key           TEXT NOT NULL,
    learning_run_id INTEGER REFERENCES learning_runs(id),
    description   TEXT NOT NULL,
    n             INTEGER NOT NULL,
    effect        REAL,
    ci_low        REAL,
    ci_high       REAL,
    p_value       REAL,
    q_value       REAL,
    status        TEXT NOT NULL,              -- insufficient_data | not_supported | supported
    evidence_json TEXT,
    created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_hyp_key ON weakness_hypotheses(key, created_at);

CREATE TABLE IF NOT EXISTS candidate_changes (
    id            INTEGER PRIMARY KEY,
    learning_run_id INTEGER NOT NULL REFERENCES learning_runs(id),
    hypothesis_key TEXT,
    kind          TEXT NOT NULL,
    description   TEXT NOT NULL,
    config_json   TEXT NOT NULL,
    status        TEXT NOT NULL,              -- proposed | tested | promoted | rejected | pending_approval
    candidate_backtest_id INTEGER REFERENCES backtest_runs(id),
    incumbent_backtest_id INTEGER REFERENCES backtest_runs(id),
    result_json   TEXT,
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS promotion_decisions (
    id            INTEGER PRIMARY KEY,
    candidate_change_id INTEGER REFERENCES candidate_changes(id),
    incumbent_version_id INTEGER REFERENCES model_versions(id),
    candidate_version_id INTEGER REFERENCES model_versions(id),
    decision      TEXT NOT NULL,              -- promote | reject | retain | refit | rollback | initial | pending_approval | approve
    criteria_json TEXT NOT NULL,
    reason        TEXT NOT NULL,
    decided_by    TEXT NOT NULL,              -- auto | manual
    decided_at    TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS trg_decisions_no_update BEFORE UPDATE ON promotion_decisions
BEGIN SELECT RAISE(ABORT, 'promotion decisions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_decisions_no_delete BEFORE DELETE ON promotion_decisions
BEGIN SELECT RAISE(ABORT, 'promotion decisions are append-only'); END;

CREATE TABLE IF NOT EXISTS evaluation_metrics (
    id            INTEGER PRIMARY KEY,
    learning_run_id INTEGER REFERENCES learning_runs(id),
    scope         TEXT NOT NULL,
    scope_key     TEXT,
    metric        TEXT NOT NULL,
    value         REAL,
    n             INTEGER,
    ci_low        REAL,
    ci_high       REAL,
    computed_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analyst_reports (
    id            INTEGER PRIMARY KEY,
    learning_run_id INTEGER REFERENCES learning_runs(id),
    event_id      INTEGER REFERENCES events(id),
    provider      TEXT NOT NULL,
    structured_json TEXT NOT NULL,
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS data_quality_issues (
    id            INTEGER PRIMARY KEY,
    entity        TEXT NOT NULL,
    entity_id     TEXT,
    severity      TEXT NOT NULL,              -- info | warning | error
    kind          TEXT NOT NULL,
    message       TEXT NOT NULL,
    detected_at   TEXT NOT NULL,
    resolved_at   TEXT,
    UNIQUE (entity, entity_id, kind)
);

CREATE TABLE IF NOT EXISTS audit_log (
    id            INTEGER PRIMARY KEY,
    ts            TEXT NOT NULL,
    actor         TEXT NOT NULL,
    action        TEXT NOT NULL,
    entity        TEXT,
    entity_id     TEXT,
    details_json  TEXT
);
CREATE TRIGGER IF NOT EXISTS trg_audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;

CREATE TABLE IF NOT EXISTS settings (
    key           TEXT PRIMARY KEY,
    value_json    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_runs (
    id            INTEGER PRIMARY KEY,
    job           TEXT NOT NULL,
    started_at    TEXT NOT NULL,
    finished_at   TEXT,
    status        TEXT NOT NULL,
    message       TEXT
);

-- Simulated betting tracker (moneyline). Comparison/evaluation only: nothing here is read by the engine.
CREATE TABLE IF NOT EXISTS sim_bets (
    id                INTEGER PRIMARY KEY,
    strategy          TEXT NOT NULL DEFAULT 'confidence_flat',
    event_id          INTEGER NOT NULL REFERENCES events(id),
    game_id           INTEGER NOT NULL REFERENCES games(id),
    prediction_id     INTEGER NOT NULL REFERENCES predictions(id),
    prediction_version INTEGER,
    event_name        TEXT,
    event_date        TEXT,
    season_type       TEXT,
    tier              TEXT NOT NULL,       -- High | Medium | Low
    confidence_score  REAL,
    pick_team_id      INTEGER REFERENCES teams(id),
    pick_name         TEXT,
    opponent_team_id  INTEGER REFERENCES teams(id),
    opponent_name     TEXT,
    pick_is_home      INTEGER,
    p_pick            REAL,
    stake_cents       INTEGER NOT NULL,
    odds_decimal      REAL,
    odds_american     INTEGER,
    odds_source       TEXT,                -- feed | import | manual
    odds_bookmaker    TEXT,
    odds_captured_at  TEXT,
    odds_id           INTEGER REFERENCES odds(id),
    closing_decimal   REAL,
    closing_captured_at TEXT,
    status            TEXT NOT NULL,       -- pending | win | loss | push | void | no_bet
    net_cents         INTEGER,
    result_id         INTEGER REFERENCES game_results(id),
    settle_note       TEXT,
    settled_at        TEXT,
    locked_at         TEXT,
    manual_override   INTEGER NOT NULL DEFAULT 0,
    rationale_json    TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    UNIQUE (game_id, strategy)
);
CREATE INDEX IF NOT EXISTS ix_sim_bets_event ON sim_bets(event_id);
CREATE INDEX IF NOT EXISTS ix_sim_bets_status ON sim_bets(status);

CREATE TABLE IF NOT EXISTS sim_bet_events (
    id            INTEGER PRIMARY KEY,
    bet_id        INTEGER NOT NULL REFERENCES sim_bets(id),
    ts            TEXT NOT NULL,
    actor         TEXT NOT NULL,
    action        TEXT NOT NULL,
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
