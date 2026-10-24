"""SQLite persistence: connection, additive migrations, audit log, backup and restore."""
from __future__ import annotations

import os
import shutil
import sqlite3
from pathlib import Path

from .util import dumps, utcnow

MIGRATIONS_DIR = Path(__file__).parent / "migrations"


def default_db_path() -> str:
    return os.environ.get("UFCPRED_DB", str(Path(__file__).resolve().parent.parent / "data" / "ufcpred.sqlite3"))


def connect(path: str | None = None) -> sqlite3.Connection:
    path = path or default_db_path()
    if path != ":memory:":
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    if path != ":memory:":
        conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    migrate(conn)
    return conn


def migrate(conn: sqlite3.Connection) -> list[str]:
    """Apply any migration files not yet recorded. Migrations are additive only."""
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
    )
    done = {r[0] for r in conn.execute("SELECT name FROM schema_migrations")}
    applied = []
    for f in sorted(MIGRATIONS_DIR.glob("*.sql")):
        if f.name in done:
            continue
        sql = f.read_text()
        if "DROP TABLE" in sql.upper():
            raise RuntimeError(f"migration {f.name} drops a table; history-holding tables are never dropped")
        conn.executescript(sql)
        conn.execute("INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?)", (f.name, utcnow()))
        applied.append(f.name)
    conn.commit()
    return applied


def audit(conn: sqlite3.Connection, action: str, entity: str | None = None, entity_id=None,
          details: dict | None = None, actor: str = "system") -> None:
    conn.execute(
        "INSERT INTO audit_log(ts, actor, action, entity, entity_id, details_json) VALUES (?,?,?,?,?,?)",
        (utcnow(), actor, action, entity, None if entity_id is None else str(entity_id), dumps(details or {})),
    )


def flag_issue(conn: sqlite3.Connection, entity: str, entity_id, kind: str, message: str,
               severity: str = "warning") -> None:
    conn.execute(
        """INSERT INTO data_quality_issues(entity, entity_id, severity, kind, message, detected_at)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(entity, entity_id, kind) DO UPDATE SET message=excluded.message,
             severity=excluded.severity, resolved_at=NULL""",
        (entity, None if entity_id is None else str(entity_id), severity, kind, message, utcnow()),
    )


def backup(conn: sqlite3.Connection, dest_dir: str | None = None) -> str:
    """Online, consistent copy via the SQLite backup API."""
    dest_dir = dest_dir or str(Path(default_db_path()).parent / "backups")
    Path(dest_dir).mkdir(parents=True, exist_ok=True)
    stamp = utcnow().replace(":", "").replace("-", "").replace("+0000", "Z")
    dest = str(Path(dest_dir) / f"ufcpred-{stamp}.sqlite3")
    target = sqlite3.connect(dest)
    with target:
        conn.backup(target)
    target.close()
    audit(conn, "backup.created", "backup", dest)
    conn.commit()
    return dest


def list_backups(dest_dir: str | None = None) -> list[str]:
    dest_dir = dest_dir or str(Path(default_db_path()).parent / "backups")
    if not Path(dest_dir).exists():
        return []
    return sorted((str(p) for p in Path(dest_dir).glob("ufcpred-*.sqlite3")), reverse=True)


def verify_backup(path: str) -> dict:
    c = sqlite3.connect(path)
    try:
        ok = c.execute("PRAGMA integrity_check").fetchone()[0]
        n_pred = c.execute("SELECT COUNT(*) FROM predictions").fetchone()[0]
        n_models = c.execute("SELECT COUNT(*) FROM model_versions").fetchone()[0]
    finally:
        c.close()
    return {"integrity": ok, "predictions": n_pred, "model_versions": n_models}


def restore(backup_path: str, db_path: str | None = None) -> str:
    """Replace the live database with a verified backup. The current file is kept aside."""
    db_path = db_path or default_db_path()
    check = verify_backup(backup_path)
    if check["integrity"] != "ok":
        raise RuntimeError(f"backup failed integrity check: {check}")
    if Path(db_path).exists():
        aside = db_path + f".pre-restore-{utcnow().replace(':', '')}"
        shutil.copy2(db_path, aside)
    for suffix in ("-wal", "-shm"):
        p = Path(db_path + suffix)
        if p.exists():
            p.unlink()
    shutil.copy2(backup_path, db_path)
    return db_path


def get_setting(conn: sqlite3.Connection, key: str, default=None):
    row = conn.execute("SELECT value_json FROM settings WHERE key=?", (key,)).fetchone()
    if row is None:
        return default
    import json
    return json.loads(row[0])


def set_setting(conn: sqlite3.Connection, key: str, value, actor: str = "user") -> None:
    conn.execute(
        "INSERT INTO settings(key, value_json, updated_at) VALUES (?,?,?) "
        "ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
        (key, dumps(value), utcnow()),
    )
    audit(conn, "settings.changed", "setting", key, {"value": value}, actor=actor)
    conn.commit()
