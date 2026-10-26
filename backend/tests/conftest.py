"""Test configuration: every test run uses a throwaway SQLite database and
disables the background workers so timings stay deterministic.
"""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

TMP_DIR = Path(tempfile.mkdtemp(prefix="railflow-tests-"))

os.environ["DATABASE_URL"] = f"sqlite:///{(TMP_DIR / 'test.db').as_posix()}"
os.environ["RUN_WORKERS"] = "false"
os.environ["ADMIN_API_KEY"] = "test-admin-key"
os.environ["QUEUE_CAPACITY"] = "1000"  # keep the queue out of the way unless tested
os.environ["HOLD_MINUTES"] = "10"


def pytest_sessionfinish(session, exitstatus):  # noqa: ARG001
    shutil.rmtree(TMP_DIR, ignore_errors=True)
