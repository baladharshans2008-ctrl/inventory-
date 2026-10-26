"""Event log + in-process metric counters.

Every reliability-relevant transition is written to `app_events` so the
operations dashboard shows *real* activity, never fabricated numbers.
"""

from __future__ import annotations

import threading
from collections import deque
from statistics import mean

from sqlalchemy.orm import Session

from ..models import AppEvent
from ..utils import utcnow


def log_event(
    db: Session | None,
    event_type: str,
    message: str,
    *,
    severity: str = "info",
    payload: dict | None = None,
    request_id: str | None = None,
    commit: bool = True,
) -> None:
    """Persist an operational event. Never raises: logging must not break a flow."""
    _COUNTERS.bump(event_type)
    if db is None:
        return
    try:
        db.add(
            AppEvent(
                event_type=event_type,
                message=message[:240],
                severity=severity,
                request_id=request_id,
                payload=payload or {},
                created_at=utcnow(),
            )
        )
        if commit:
            db.commit()
    except Exception:  # pragma: no cover - defensive
        try:
            db.rollback()
        except Exception:
            pass


class _Counters:
    """Rolling in-process counters for the dashboard (single process demo)."""

    def __init__(self, window: int = 2000) -> None:
        self._lock = threading.Lock()
        self._by_type: dict[str, int] = {}
        self._latencies: deque[float] = deque(maxlen=window)

    def bump(self, event_type: str, latency_ms: float | None = None) -> None:
        with self._lock:
            self._by_type[event_type] = self._by_type.get(event_type, 0) + 1
            if latency_ms is not None:
                self._latencies.append(float(latency_ms))

    def snapshot(self) -> dict:
        with self._lock:
            by_type = dict(self._by_type)
            lat = sorted(self._latencies)
        p50 = _percentile(lat, 50)
        p95 = _percentile(lat, 95)
        p99 = _percentile(lat, 99)
        return {
            "by_type": by_type,
            "latency_samples": len(lat),
            "avg_latency_ms": round(mean(lat), 1) if lat else 0.0,
            "p50_latency_ms": p50,
            "p95_latency_ms": p95,
            "p99_latency_ms": p99,
        }

    def reset(self) -> None:
        with self._lock:
            self._by_type.clear()
            self._latencies.clear()


def _percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    k = max(0, min(len(values) - 1, int(round((pct / 100) * (len(values) - 1)))))
    return round(values[k], 1)


_COUNTERS = _Counters()


def counters() -> _Counters:
    return _COUNTERS


def percentile(values: list[float], pct: float) -> float:
    return _percentile(sorted(values), pct)
