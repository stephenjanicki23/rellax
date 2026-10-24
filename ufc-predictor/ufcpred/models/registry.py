"""Model version registry: save, activate, roll back. Versions are never deleted."""
from __future__ import annotations

from ..config import ModelConfig
from ..db import audit
from ..util import dumps, loads, sha256, utcnow


def save_version(conn, params: dict, cfg: ModelConfig, *, status: str = "candidate", parent_id: int | None = None,
                 notes: str = "", label: str | None = None, training_run_id: int | None = None) -> int:
    n = conn.execute("SELECT COUNT(*) FROM model_versions").fetchone()[0]
    label = label or f"v{n + 1}-{cfg.fingerprint()}-{params['cutoff']}"
    pj = dumps(params)
    cur = conn.execute(
        """INSERT INTO model_versions(label, parent_id, status, config_json, params_json, params_sha256,
           training_cutoff, n_train, training_run_id, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (label, parent_id, status, dumps(cfg.to_dict()), pj, sha256(pj), params["cutoff"],
         params["diagnostics"]["n_train"], training_run_id, notes, utcnow()))
    audit(conn, "model.saved", "model_version", cur.lastrowid, {"label": label, "status": status})
    conn.commit()
    return cur.lastrowid


def record_training_run(conn, cfg: ModelConfig, cutoff: str, params: dict | None, started: str,
                        status: str = "ok", seed: int = 0) -> int:
    cur = conn.execute(
        "INSERT INTO training_runs(started_at, finished_at, cutoff, n_train, config_json, diagnostics_json, seed, status) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (started, utcnow(), cutoff, params["diagnostics"]["n_train"] if params else None, dumps(cfg.to_dict()),
         dumps(params["diagnostics"] if params else {}), seed, status))
    return cur.lastrowid


def active_version(conn):
    return conn.execute("SELECT * FROM model_versions WHERE status='active' ORDER BY activated_at DESC LIMIT 1").fetchone()


def load_params(conn, version_id: int) -> dict:
    row = conn.execute("SELECT params_json, params_sha256 FROM model_versions WHERE id=?", (version_id,)).fetchone()
    if row is None:
        raise KeyError(f"model version {version_id} not found")
    if sha256(row["params_json"]) != row["params_sha256"]:
        raise RuntimeError(f"model version {version_id} parameters failed their integrity hash")
    return loads(row["params_json"])


def activate(conn, version_id: int, *, actor: str = "system", reason: str = "") -> None:
    """Make one version active; the previous active version is retired (kept, restorable)."""
    now = utcnow()
    prev = active_version(conn)
    if prev is not None and prev["id"] != version_id:
        conn.execute("UPDATE model_versions SET status='retired' WHERE id=?", (prev["id"],))
    conn.execute("UPDATE model_versions SET status='active', activated_at=? WHERE id=?", (now, version_id))
    audit(conn, "model.activated", "model_version", version_id,
          {"previous": prev["id"] if prev else None, "reason": reason}, actor=actor)
    conn.commit()


def rollback(conn, to_version_id: int, *, actor: str = "user", reason: str = "manual rollback") -> dict:
    row = conn.execute("SELECT id, status FROM model_versions WHERE id=?", (to_version_id,)).fetchone()
    if row is None:
        raise KeyError(f"model version {to_version_id} not found")
    if row["status"] == "rejected":
        raise ValueError("a rejected candidate was never deployed and cannot be a rollback target")
    load_params(conn, to_version_id)   # integrity check before switching
    prev = active_version(conn)
    activate(conn, to_version_id, actor=actor, reason=reason)
    conn.execute(
        """INSERT INTO promotion_decisions(incumbent_version_id, candidate_version_id, decision, criteria_json, reason,
           decided_by, decided_at) VALUES (?,?,?,?,?,?,?)""",
        (prev["id"] if prev else None, to_version_id, "rollback", "{}", reason,
         "manual" if actor != "system" else "auto", utcnow()))
    conn.commit()
    return {"from": prev["id"] if prev else None, "to": to_version_id}
