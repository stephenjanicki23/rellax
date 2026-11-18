import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).parent))

from nbapred import db  # noqa: E402
from nbapred.ingest import ingest_bundle  # noqa: E402
from synthetic import make_bundle  # noqa: E402

FAST_SETTINGS = {
    "learning.eval_window_games": 300, "learning.backtest_fold_events": 10, "learning.min_new_games_for_retrain": 40,
    "learning.max_candidates": 2, "promotion.min_eval_games": 100, "promotion.min_eval_events": 8,
    "promotion.bootstrap_samples": 200, "learning.min_segment_n": 30,
}


# Set NBAPRED_TEST_DATABASE_URL=postgresql://… to run the whole suite against Postgres instead of SQLite.
PG_URL = os.environ.get("NBAPRED_TEST_DATABASE_URL")


def reset_pg():
    import psycopg
    with psycopg.connect(PG_URL, autocommit=True) as c:
        c.execute("DROP SCHEMA public CASCADE")
        c.execute("CREATE SCHEMA public")


def _new_db(tmp_path, name):
    if PG_URL:
        reset_pg()
        return db.connect(PG_URL)
    return db.connect(str(tmp_path / name))


def db_target(conn) -> str:
    """What db.connect() needs to reopen this database."""
    return conn.url if db.backend(conn) == "postgres" else conn.execute("PRAGMA database_list").fetchone()[2]


@pytest.fixture
def tmp_db(tmp_path, monkeypatch):
    monkeypatch.setenv("NBAPRED_DATA_DIR", str(tmp_path / "data"))
    if PG_URL:
        monkeypatch.setenv("DATABASE_URL", PG_URL)
        monkeypatch.delenv("NBAPRED_DB", raising=False)
    else:
        monkeypatch.setenv("NBAPRED_DB", str(tmp_path / "test.sqlite3"))
        monkeypatch.delenv("DATABASE_URL", raising=False)
    conn = _new_db(tmp_path, "test.sqlite3")
    for k, v in FAST_SETTINGS.items():
        db.set_setting(conn, k, v, actor="test")
    yield conn
    try:
        conn.close()
    except Exception:
        pass


@pytest.fixture
def fresh_db(tmp_path):
    """Factory for a second, empty database. On Postgres it replaces the test database, so the
    caller's old connection is closed first."""
    def make(old_conn=None):
        if old_conn is not None and PG_URL:
            old_conn.close()
        return _new_db(tmp_path, "fresh.sqlite3")
    return make


@pytest.fixture
def synth(tmp_db):
    bundle, truth = make_bundle(seed=3)
    ingest_bundle(tmp_db, bundle)
    return tmp_db, truth


_TRAINED = {}
CUTOFF_NIGHT = 150      # well into the second synthetic season


@pytest.fixture
def trained(synth):
    """Synthetic DB with an initial model fitted on data before game night CUTOFF_NIGHT."""
    from nbapred.config import ModelConfig
    from nbapred.features.build import StateCache
    from nbapred.features.history import HistoryStore
    from nbapred.learning.loop import initial_deployment
    conn, truth = synth
    h = HistoryStore.load(conn)
    cache = StateCache(h)
    cutoff = truth["dates"][CUTOFF_NIGHT]
    vid = initial_deployment(conn, h, cutoff, cache, ModelConfig(train_start="2000-01-01"), select_half_life=False)
    return conn, truth, h, cache, vid, cutoff
