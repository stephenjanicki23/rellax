"""Persistence: SQLite (local default) or Postgres (when DATABASE_URL is set, e.g. Neon on Vercel).

Both backends expose the same small interface the rest of the code uses — `execute`,
`executemany`, `commit`, `rollback`, rows readable by name or index, `lastrowid` — and both
run additive migrations from their own directory. History-holding tables are append-only
on both (enforced by triggers).
"""
from __future__ import annotations

import gzip
import json
import os
import re
import shutil
import sqlite3
from pathlib import Path

from .util import dumps, utcnow

MIGRATIONS_DIR = Path(__file__).parent / "migrations"
PG_MIGRATIONS_DIR = Path(__file__).parent / "migrations_pg"

# Insert order for logical export/import (parents before children).
TABLES = ["data_sources", "fighters", "fighter_corrections", "events", "fights", "fight_results", "fight_stats",
          "fighter_snapshots", "odds", "training_runs", "model_versions", "backtest_runs", "backtest_predictions",
          "predictions", "prediction_locks", "prediction_lock_members", "prediction_evaluations", "error_diagnostics",
          "learning_runs", "weakness_hypotheses", "candidate_changes", "promotion_decisions", "evaluation_metrics",
          "analyst_reports", "data_quality_issues", "audit_log", "settings", "job_runs"]
NO_ID_TABLES = {"fight_stats", "backtest_predictions", "settings", "schema_migrations", "prediction_lock_members"}

try:  # optional: only needed for Postgres
    import psycopg
    IntegrityError: tuple = (sqlite3.IntegrityError, psycopg.Error)
except ImportError:  # pragma: no cover
    psycopg = None
    IntegrityError = (sqlite3.IntegrityError,)


def on_vercel() -> bool:
    return bool(os.environ.get("VERCEL"))


def database_url() -> str | None:
    """Postgres URL if configured. Vercel's Neon integration injects DATABASE_URL / POSTGRES_URL."""
    for k in ("UFCPRED_DATABASE_URL", "DATABASE_URL", "POSTGRES_URL"):
        v = os.environ.get(k)
        if v and v.startswith(("postgres://", "postgresql://")):
            return v
    return None


def default_db_path() -> str:
    if os.environ.get("UFCPRED_DB"):
        return os.environ["UFCPRED_DB"]
    if on_vercel():
        return "/tmp/ufcpred.sqlite3"   # ephemeral; Vercel deployments should set DATABASE_URL
    return str(Path(__file__).resolve().parent.parent / "data" / "ufcpred.sqlite3")


def data_dir() -> Path:
    if on_vercel() or database_url():
        p = Path(os.environ.get("UFCPRED_DATA_DIR", "/tmp/ufcpred"))
    else:
        p = Path(default_db_path()).parent
    p.mkdir(parents=True, exist_ok=True)
    return p


def backend(conn) -> str:
    return "postgres" if isinstance(conn, PgConnection) else "sqlite"


def describe() -> str:
    url = database_url()
    if url:
        return "postgres://" + re.sub(r"^[a-z]+://([^@]*@)?", "", url).split("/")[0] + "/…"
    return default_db_path()


# ---------------------------------------------------------------------- Postgres adapter
class Row:
    """sqlite3.Row look-alike: access by column name or index; iterates over values."""
    __slots__ = ("_names", "_values", "_index")

    def __init__(self, names, values, index):
        self._names, self._values, self._index = names, values, index

    def __getitem__(self, k):
        return self._values[k] if isinstance(k, int) else self._values[self._index[k]]

    def keys(self):
        return list(self._names)

    def __iter__(self):
        return iter(self._values)

    def __len__(self):
        return len(self._values)

    def __repr__(self):
        return f"Row({dict(zip(self._names, self._values))})"


def _row_factory(cursor):
    names = [d.name for d in cursor.description] if cursor.description else []
    index = {n: i for i, n in enumerate(names)}
    return lambda values: Row(names, values, index)


_INSERT_TABLE = re.compile(r"^\s*INSERT\s+INTO\s+([a-z_]+)", re.I)


def _translate(sql: str) -> str:
    sql = sql.replace("%", "%%").replace("?", "%s")
    m = _INSERT_TABLE.match(sql)
    if m and m.group(1).lower() not in NO_ID_TABLES and "RETURNING" not in sql.upper():
        sql = sql.rstrip().rstrip(";") + " RETURNING id"
    return sql


class PgCursor:
    def __init__(self, cur):
        self._cur = cur
        self.lastrowid = None

    def execute(self, sql, params=()):
        q = _translate(sql)
        self._cur.execute(q, tuple(params) if params else None)
        if q.endswith(" RETURNING id"):
            r = self._cur.fetchone()
            self.lastrowid = r[0] if r else None
        return self

    def fetchone(self):
        return self._cur.fetchone() if self._cur.description else None

    def fetchall(self):
        return self._cur.fetchall() if self._cur.description else []

    def __iter__(self):
        return iter(self.fetchall())

    @property
    def rowcount(self):
        return self._cur.rowcount


class PgConnection:
    def __init__(self, url: str):
        if psycopg is None:
            raise RuntimeError("DATABASE_URL points at Postgres but psycopg is not installed (pip install 'psycopg[binary]')")
        self._c = psycopg.connect(url, autocommit=False, row_factory=_row_factory, prepare_threshold=None)
        self.url = url

    def execute(self, sql, params=()):
        return PgCursor(self._c.cursor()).execute(sql, params)

    def executemany(self, sql, seq):
        q = _translate(sql)
        if q.endswith(" RETURNING id"):
            q = q[: -len(" RETURNING id")]
        with self._c.cursor() as cur:
            cur.executemany(q, [tuple(x) for x in seq])

    def executescript(self, sql):
        self._c.execute(sql)

    def commit(self):
        self._c.commit()

    def rollback(self):
        self._c.rollback()

    def close(self):
        self._c.close()


# ---------------------------------------------------------------------- connect & migrate
def connect(path: str | None = None):
    target = path or database_url() or default_db_path()
    if target.startswith(("postgres://", "postgresql://")):
        conn = PgConnection(target)
        migrate(conn)
        return conn
    if target != ":memory:":
        Path(target).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(target, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    if target != ":memory:":
        conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    migrate(conn)
    return conn


def migrate(conn) -> list[str]:
    """Apply any migration files not yet recorded. Migrations are additive only."""
    pg = backend(conn) == "postgres"
    if pg:   # serialise concurrent cold starts (web functions + scheduled jobs)
        conn.execute("SELECT pg_advisory_xact_lock(7316002)")
    conn.execute("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)")
    done = {r[0] for r in conn.execute("SELECT name FROM schema_migrations")}
    applied = []
    for f in sorted((PG_MIGRATIONS_DIR if pg else MIGRATIONS_DIR).glob("*.sql")):
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


def audit(conn, action: str, entity: str | None = None, entity_id=None, details: dict | None = None,
          actor: str = "system") -> None:
    conn.execute(
        "INSERT INTO audit_log(ts, actor, action, entity, entity_id, details_json) VALUES (?,?,?,?,?,?)",
        (utcnow(), actor, action, entity, None if entity_id is None else str(entity_id), dumps(details or {})),
    )


def flag_issue(conn, entity: str, entity_id, kind: str, message: str, severity: str = "warning") -> None:
    conn.execute(
        """INSERT INTO data_quality_issues(entity, entity_id, severity, kind, message, detected_at)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(entity, entity_id, kind) DO UPDATE SET message=excluded.message,
             severity=excluded.severity, resolved_at=NULL""",
        (entity, "" if entity_id is None else str(entity_id), severity, kind, message, utcnow()),
    )


# ---------------------------------------------------------------------- backups
def _stamp() -> str:
    return utcnow().replace(":", "").replace("-", "").replace("+0000", "Z")


def backups_dir() -> Path:
    p = data_dir() / "backups"
    p.mkdir(parents=True, exist_ok=True)
    return p


def backup(conn, dest_dir: str | None = None) -> str:
    """SQLite: consistent file copy (backup API). Postgres: logical export (gzipped JSON lines)."""
    d = Path(dest_dir) if dest_dir else backups_dir()
    d.mkdir(parents=True, exist_ok=True)
    if backend(conn) == "postgres":
        dest = export_json(conn, str(d / f"ufcpred-{_stamp()}.jsonl.gz"))
    else:
        dest = str(d / f"ufcpred-{_stamp()}.sqlite3")
        target = sqlite3.connect(dest)
        with target:
            conn.backup(target)
        target.close()
    audit(conn, "backup.created", "backup", dest)
    conn.commit()
    return dest


def list_backups(dest_dir: str | None = None) -> list[str]:
    d = Path(dest_dir) if dest_dir else backups_dir()
    return sorted((str(p) for p in d.glob("ufcpred-*")), reverse=True)


def export_json(conn, dest: str) -> str:
    """Portable logical export of every table (works on both backends)."""
    with gzip.open(dest, "wt", encoding="utf-8") as fh:
        for t in TABLES + ["schema_migrations"]:
            cur = conn.execute(f"SELECT * FROM {t}")
            rows = cur.fetchall()
            cols = list(rows[0].keys()) if rows else []
            fh.write(json.dumps({"table": t, "columns": cols, "rows": [list(r) for r in rows]}) + "\n")
    return dest


def import_json(conn, src: str) -> dict:
    """Load an export into an EMPTY database (refuses to merge into existing history)."""
    if conn.execute("SELECT COUNT(*) FROM predictions").fetchone()[0] or \
            conn.execute("SELECT COUNT(*) FROM fights").fetchone()[0]:
        raise RuntimeError("import_json only restores into an empty database")
    counts = {}
    pg = backend(conn) == "postgres"
    if not pg:
        conn.execute("PRAGMA foreign_keys = OFF")
    with gzip.open(src, "rt", encoding="utf-8") as fh:
        blocks = [json.loads(line) for line in fh]
    for b in blocks:
        t, cols, rows = b["table"], b["columns"], b["rows"]
        if t == "schema_migrations" or not rows:
            continue
        conn.executemany(f"INSERT INTO {t}({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})", rows)
        counts[t] = len(rows)
        if pg and t not in NO_ID_TABLES:
            conn.execute(f"SELECT setval(pg_get_serial_sequence('{t}', 'id'), COALESCE((SELECT MAX(id) FROM {t}), 1))")
    if not pg:
        conn.execute("PRAGMA foreign_keys = ON")
    conn.commit()
    return counts


def verify_backup(path: str) -> dict:
    if path.endswith(".jsonl.gz"):
        with gzip.open(path, "rt", encoding="utf-8") as fh:
            n = {json.loads(line)["table"]: None for line in fh}
        with gzip.open(path, "rt", encoding="utf-8") as fh:
            tables = {b["table"]: len(b["rows"]) for b in map(json.loads, fh)}
        return {"integrity": "ok" if "predictions" in n else "missing tables",
                "predictions": tables.get("predictions", 0), "model_versions": tables.get("model_versions", 0)}
    c = sqlite3.connect(path)
    try:
        ok = c.execute("PRAGMA integrity_check").fetchone()[0]
        n_pred = c.execute("SELECT COUNT(*) FROM predictions").fetchone()[0]
        n_models = c.execute("SELECT COUNT(*) FROM model_versions").fetchone()[0]
    finally:
        c.close()
    return {"integrity": ok, "predictions": n_pred, "model_versions": n_models}


def restore(backup_path: str, db_path: str | None = None) -> str:
    """SQLite file backup: swap the file in (current one kept aside).
    JSON export: load into the configured database, which must be empty."""
    check = verify_backup(backup_path)
    if check["integrity"] != "ok":
        raise RuntimeError(f"backup failed integrity check: {check}")
    if backup_path.endswith(".jsonl.gz"):
        conn = connect(db_path)
        try:
            import_json(conn, backup_path)
        finally:
            conn.close()
        return db_path or describe()
    db_path = db_path or default_db_path()
    if Path(db_path).exists():
        aside = db_path + f".pre-restore-{utcnow().replace(':', '')}"
        shutil.copy2(db_path, aside)
    for suffix in ("-wal", "-shm"):
        p = Path(db_path + suffix)
        if p.exists():
            p.unlink()
    shutil.copy2(backup_path, db_path)
    return db_path


def get_setting(conn, key: str, default=None):
    row = conn.execute("SELECT value_json FROM settings WHERE key=?", (key,)).fetchone()
    if row is None:
        return default
    return json.loads(row[0])


def set_setting(conn, key: str, value, actor: str = "user") -> None:
    conn.execute(
        "INSERT INTO settings(key, value_json, updated_at) VALUES (?,?,?) "
        "ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
        (key, dumps(value), utcnow()),
    )
    audit(conn, "settings.changed", "setting", key, {"value": value}, actor=actor)
    conn.commit()
