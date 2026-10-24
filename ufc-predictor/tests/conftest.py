import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).parent))

from ufcpred import db  # noqa: E402
from ufcpred.ingest import ingest_bundle  # noqa: E402
from synthetic import make_bundle  # noqa: E402

FAST_SETTINGS = {
    "learning.eval_window_fights": 200, "learning.backtest_fold_events": 6, "learning.min_new_fights_for_retrain": 20,
    "learning.max_candidates": 2, "promotion.min_eval_fights": 100, "promotion.min_eval_events": 8,
    "promotion.bootstrap_samples": 200, "learning.min_segment_n": 30,
}


@pytest.fixture
def tmp_db(tmp_path, monkeypatch):
    path = str(tmp_path / "test.sqlite3")
    monkeypatch.setenv("UFCPRED_DB", path)
    conn = db.connect(path)
    for k, v in FAST_SETTINGS.items():
        db.set_setting(conn, k, v, actor="test")
    yield conn
    conn.close()


@pytest.fixture
def synth(tmp_db):
    bundle, truth = make_bundle(seed=3)
    ingest_bundle(tmp_db, bundle)
    return tmp_db, truth


_TRAINED = {}


@pytest.fixture
def trained(synth):
    """Synthetic DB with an initial model fitted on data before the 80th event."""
    from ufcpred.config import ModelConfig
    from ufcpred.features.build import StateCache
    from ufcpred.features.history import HistoryStore
    from ufcpred.learning.loop import initial_deployment
    conn, truth = synth
    h = HistoryStore.load(conn)
    cache = StateCache(h)
    cutoff = truth["dates"][80]
    vid = initial_deployment(conn, h, cutoff, cache, ModelConfig(train_start="2000-01-01"), select_half_life=False)
    return conn, truth, h, cache, vid, cutoff
