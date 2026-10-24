"""Vercel serverless entry point: the FastAPI app (see vercel.json for routing)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ufcpred.web.app import app  # noqa: E402,F401
