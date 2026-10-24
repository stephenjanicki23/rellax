-- Which predictions each event lock froze, as rows (indexable and portable across backends).
-- prediction_locks.prediction_ids_json stays as written; this table mirrors it.
CREATE TABLE IF NOT EXISTS prediction_lock_members (
    lock_id       INTEGER NOT NULL REFERENCES prediction_locks(id),
    prediction_id INTEGER NOT NULL REFERENCES predictions(id),
    PRIMARY KEY (lock_id, prediction_id)
);
CREATE INDEX IF NOT EXISTS ix_lock_members_prediction ON prediction_lock_members(prediction_id);
INSERT OR IGNORE INTO prediction_lock_members(lock_id, prediction_id)
    SELECT l.id, j.value FROM prediction_locks l, json_each(l.prediction_ids_json) j;
CREATE TRIGGER IF NOT EXISTS trg_lock_members_no_update BEFORE UPDATE ON prediction_lock_members
BEGIN SELECT RAISE(ABORT, 'prediction locks are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_lock_members_no_delete BEFORE DELETE ON prediction_lock_members
BEGIN SELECT RAISE(ABORT, 'prediction locks are append-only'); END;
