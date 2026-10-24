-- Which predictions each event lock froze, as rows. Mirrors prediction_locks.prediction_ids_json.
CREATE TABLE IF NOT EXISTS prediction_lock_members (
    lock_id       BIGINT NOT NULL REFERENCES prediction_locks(id),
    prediction_id BIGINT NOT NULL REFERENCES predictions(id),
    PRIMARY KEY (lock_id, prediction_id)
);
CREATE INDEX IF NOT EXISTS ix_lock_members_prediction ON prediction_lock_members(prediction_id);
DROP TRIGGER IF EXISTS trg_prediction_lock_members_append_only ON prediction_lock_members;
CREATE TRIGGER trg_prediction_lock_members_append_only BEFORE UPDATE OR DELETE ON prediction_lock_members
    FOR EACH ROW EXECUTE FUNCTION ufcpred_append_only();
