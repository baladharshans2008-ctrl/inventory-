"""Background workers: reservation expiry, queue admission, payment
reconciliation and metric sampling.

These are ordinary Python threads so the demo runs with a single command.
In production they would be moved to Celery/APScheduler workers backed by
Redis; the logic lives in the service layer and is unchanged.
"""

from __future__ import annotations

import logging
import threading
import time

from ..config import settings
from ..db import session_scope
from ..models import SystemHealthEvent
from ..utils import utcnow
from . import inventory, metrics, payment_service, queue_service

logger = logging.getLogger("railflow.workers")


class WorkerManager:
    def __init__(self) -> None:
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self.state: dict[str, dict] = {}

    # -- loops ---------------------------------------------------------
    def _expiry_loop(self) -> None:
        while not self._stop.is_set():
            try:
                with session_scope() as db:
                    expired = inventory.expire_reservations(db, limit=100)
                    self.state["expiry"] = {"last_run": utcnow().isoformat(), "released": len(expired)}
            except Exception as exc:  # pragma: no cover
                logger.warning("expiry worker error: %s", exc)
            self._stop.wait(settings.expiry_interval_seconds)

    def _queue_loop(self) -> None:
        while not self._stop.is_set():
            try:
                with session_scope() as db:
                    promoted = queue_service.promote_entries(db)
                    expired = queue_service.expire_entries(db)
                    self.state["queue"] = {
                        "last_run": utcnow().isoformat(),
                        "promoted": promoted,
                        "expired": expired,
                    }
            except Exception as exc:  # pragma: no cover
                logger.warning("queue worker error: %s", exc)
            self._stop.wait(max(1, settings.queue_admission_rate and 1))

    def _reconcile_loop(self) -> None:
        while not self._stop.is_set():
            try:
                with session_scope() as db:
                    pending = payment_service.pending_reconciliations(db)
                    resolved = 0
                    for txn in pending:
                        payment_service.reconcile_payment(db, txn)
                        resolved += 1
                    self.state["reconciliation"] = {
                        "last_run": utcnow().isoformat(),
                        "resolved": resolved,
                    }
            except Exception as exc:  # pragma: no cover
                logger.warning("reconciliation worker error: %s", exc)
            self._stop.wait(settings.reconciliation_interval_seconds)

    def _metrics_loop(self) -> None:
        while not self._stop.is_set():
            try:
                with session_scope() as db:
                    metrics.collect_sample(db, interval_seconds=2.5)
                    db.add(
                        SystemHealthEvent(
                            component="worker",
                            status="operational",
                            detail="sampled metrics",
                            created_at=utcnow(),
                        )
                    )
                    self.state["metrics"] = {"last_run": utcnow().isoformat()}
            except Exception as exc:  # pragma: no cover
                logger.warning("metrics worker error: %s", exc)
            self._stop.wait(2.5)

    # -- lifecycle -----------------------------------------------------
    def start(self) -> None:
        if not settings.run_workers or self._threads:
            return
        loops = (
            ("expiry", self._expiry_loop),
            ("queue", self._queue_loop),
            ("reconciliation", self._reconcile_loop),
            ("metrics", self._metrics_loop),
        )
        for name, target in loops:
            thread = threading.Thread(target=target, name=f"railflow-{name}", daemon=True)
            thread.start()
            self._threads.append(thread)
        logger.info("started %d background workers", len(self._threads))

    def stop(self) -> None:
        self._stop.set()
        for thread in self._threads:
            thread.join(timeout=2)
        self._threads.clear()


workers = WorkerManager()
