"""Dashboard metrics.

Every number here is derived from recorded application events, database rows,
or measured in-process latencies. Nothing is hardcoded as a "live" value; when
a value is estimated or belongs to a simulation it is labelled as such.
"""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import db_health
from ..models import (
    PAYMENT_FAILED,
    PAYMENT_PENDING,
    PAYMENT_SUCCESS,
    RESERVATION_CONFIRMED,
    RESERVATION_HELD,
    AppEvent,
    MetricsSample,
    PaymentTransaction,
    QueueEntry,
    Reservation,
    SeatInventory,
    SimulationRun,
)
from ..utils import utcnow
from . import queue_service
from .cache import cache, rate_limiter
from .events import counters

REQUEST_EVENTS = ("booking.attempt",)
SUCCESS_EVENTS = ("booking.confirmed",)
CONFLICT_EVENTS = ("booking.conflict",)
DUPLICATE_EVENTS = ("booking.duplicate_blocked", "payment.duplicate_requested")
FAILED_EVENTS = ("booking.conflict", "payment.failed", "booking.failed")

# Upper bound on chart points returned per dashboard payload, so the SSE
# frames stay small even for long windows (e.g. 180 minutes).
MAX_SERIES_POINTS = 120


def _count_events(db: Session, types: tuple[str, ...], start, end) -> int:
    return int(
        db.scalar(
            select(func.count(AppEvent.id)).where(
                AppEvent.event_type.in_(types),
                AppEvent.created_at >= start,
                AppEvent.created_at < end,
            )
        )
        or 0
    )


def gauges(db: Session) -> dict:
    now = utcnow()
    depth = queue_service.queue_depth(db)
    seats_available = int(db.scalar(select(func.coalesce(func.sum(SeatInventory.available_count), 0))) or 0)
    return {
        "queue_depth": depth["waiting"],
        "queue_admitted": depth["admitted"],
        "queue_capacity": depth["capacity"],
        "queue_occupancy_pct": depth["occupancy_pct"],
        "seats_available": seats_available,
        "active_holds": int(
            db.scalar(select(func.count(Reservation.id)).where(Reservation.status == RESERVATION_HELD)) or 0
        ),
        "bookings_confirmed": int(
            db.scalar(select(func.count(Reservation.id)).where(Reservation.status == RESERVATION_CONFIRMED)) or 0
        ),
        "pending_reconciliations": int(
            db.scalar(
                select(func.count(PaymentTransaction.id)).where(PaymentTransaction.status == PAYMENT_PENDING)
            )
            or 0
        ),
        "expired_queue_tokens": int(
            db.scalar(select(func.count(QueueEntry.id)).where(QueueEntry.status == "EXPIRED")) or 0
        ),
        "sampled_at": now.isoformat(),
    }


def totals(db: Session) -> dict:
    """Lifetime totals for the dashboard headline cards."""
    event_counts = dict(
        db.execute(select(AppEvent.event_type, func.count(AppEvent.id)).group_by(AppEvent.event_type)).all()
    )
    payment_counts = dict(
        db.execute(
            select(PaymentTransaction.status, func.count(PaymentTransaction.id)).group_by(
                PaymentTransaction.status
            )
        ).all()
    )
    return {
        "booking_requests": int(sum(v for k, v in event_counts.items() if k in REQUEST_EVENTS)),
        "successful_bookings": int(
            db.scalar(select(func.count(Reservation.id)).where(Reservation.status == RESERVATION_CONFIRMED)) or 0
        ),
        "failed_bookings": int(sum(v for k, v in event_counts.items() if k in CONFLICT_EVENTS)),
        "conflicts_prevented": int(sum(v for k, v in event_counts.items() if k in CONFLICT_EVENTS)),
        "duplicates_blocked": int(sum(v for k, v in event_counts.items() if k in DUPLICATE_EVENTS)),
        "seats_released": int(sum(v for k, v in event_counts.items() if k == "booking.released")),
        "payment_success": int(payment_counts.get(PAYMENT_SUCCESS, 0)),
        "payment_failed": int(payment_counts.get(PAYMENT_FAILED, 0)),
        "payment_pending": int(payment_counts.get(PAYMENT_PENDING, 0)),
        "queue_admissions": int(sum(v for k, v in event_counts.items() if k == "queue.admitted")),
        "queue_joins": int(sum(v for k, v in event_counts.items() if k == "queue.joined")),
        "rate_limit_blocks": rate_limiter.blocked_total,
        "events_recorded": int(sum(event_counts.values())),
    }


def series(db: Session, *, window_minutes: int = 15, limit: int | None = None) -> list[dict]:
    start = utcnow() - timedelta(minutes=window_minutes)
    stmt = (
        select(MetricsSample)
        .where(MetricsSample.bucket >= start)
        .order_by(MetricsSample.bucket.desc())
    )
    if limit:
        stmt = stmt.limit(limit)
    rows = db.scalars(stmt).all()[::-1]  # back to chronological order
    return [
        {
            "bucket": r.bucket.isoformat(),
            "requests": r.requests,
            "successful": r.successful,
            "failed": r.failed,
            "conflicts": r.conflicts,
            "duplicates_blocked": r.duplicates_blocked,
            "queue_depth": r.queue_depth,
            "queue_admitted": r.queue_admitted,
            "rps": r.rps,
            "avg_latency_ms": r.avg_latency_ms,
            "p95_latency_ms": r.p95_latency_ms,
            "payment_success": r.payment_success,
            "payment_failed": r.payment_failed,
            "payment_pending": r.payment_pending,
            "pending_reconciliations": r.pending_reconciliations,
            "seats_available": r.seats_available,
            "bookings_confirmed": r.bookings_confirmed,
        }
        for r in rows
    ]


_last_sample_at = None
_last_confirmed = 0


def collect_sample(db: Session, *, interval_seconds: float = 3.0) -> MetricsSample:
    """Called by the metrics worker; records the last interval as one sample."""
    global _last_sample_at
    now = utcnow()
    start = _last_sample_at or (now - timedelta(seconds=interval_seconds))
    _last_sample_at = now

    latency = counters().snapshot()
    g = gauges(db)
    sample = MetricsSample(
        bucket=now,
        requests=_count_events(db, REQUEST_EVENTS, start, now),
        successful=_count_events(db, SUCCESS_EVENTS, start, now),
        failed=_count_events(db, FAILED_EVENTS, start, now),
        conflicts=_count_events(db, CONFLICT_EVENTS, start, now),
        duplicates_blocked=_count_events(db, DUPLICATE_EVENTS, start, now),
        queue_depth=g["queue_depth"],
        queue_admitted=g["queue_admitted"],
        rps=round(_count_events(db, REQUEST_EVENTS, start, now) / max(0.001, (now - start).total_seconds()), 2),
        avg_latency_ms=latency["avg_latency_ms"],
        p95_latency_ms=latency["p95_latency_ms"],
        payment_success=_count_events(db, ("payment.success",), start, now),
        payment_failed=_count_events(db, ("payment.failed",), start, now),
        payment_pending=_count_events(db, ("payment.pending",), start, now),
        pending_reconciliations=g["pending_reconciliations"],
        seats_available=g["seats_available"],
        bookings_confirmed=g["bookings_confirmed"],
        created_at=now,
    )
    db.add(sample)
    db.commit()
    return sample


def service_health(db: Session) -> list[dict]:
    """Status panels. ``simulated`` marks components that are simulated."""
    db_info = db_health()
    redis_info = cache.info()
    recent_events = int(
        db.scalar(
            select(func.count(AppEvent.id)).where(AppEvent.created_at >= utcnow() - timedelta(minutes=5))
        )
        or 0
    )
    worker = "operational" if settings.run_workers else "disabled"
    queue_state = queue_service.queue_depth(db)
    return [
        {
            "component": "API service",
            "status": "operational",
            "detail": f"{settings.app_name} v{settings.app_version} (FastAPI)",
            "simulated": False,
        },
        {
            "component": "Database",
            "status": db_info["status"],
            "detail": f"{db_info.get('backend')} - authoritative seat inventory",
            "simulated": False,
        },
        {
            "component": "Cache / rate limiter",
            "status": "operational" if redis_info.get("connected") else "degraded",
            "detail": redis_info.get("backend", "unknown"),
            "simulated": redis_info.get("mode") == "fallback",
        },
        {
            "component": "Queue processor",
            "status": worker,
            "detail": f"{queue_state['waiting']} waiting / {queue_state['admitted']} admitted of {queue_state['capacity']}",
            "simulated": False,
        },
        {
            "component": "Payment gateway",
            "status": "simulated",
            "detail": "Simulated gateway - no real money is processed",
            "simulated": True,
        },
        {
            "component": "Reconciliation worker",
            "status": worker,
            "detail": f"{gauges(db)['pending_reconciliations']} transaction(s) awaiting reconciliation",
            "simulated": False,
        },
        {
            "component": "Event pipeline",
            "status": "operational",
            "detail": f"{recent_events} event(s) recorded in the last 5 minutes",
            "simulated": False,
        },
    ]


def active_simulation(db: Session) -> dict | None:
    run = db.scalar(
        select(SimulationRun).where(SimulationRun.status == "RUNNING").order_by(SimulationRun.started_at.desc())
    )
    if run is None:
        return None
    total = max(1, run.total_requests)
    return {
        "run_id": run.id,
        "scenario": run.scenario,
        "mode": run.mode,
        "progress": run.progress,
        "total_requests": run.total_requests,
        "progress_pct": round(min(100.0, (run.progress / total) * 100), 1),
    }


def dashboard(db: Session, *, window_minutes: int = 15) -> dict:
    latency = counters().snapshot()
    return {
        "generated_at": utcnow().isoformat(),
        "window_minutes": window_minutes,
        "demo_mode": settings.demo_mode,
        "live": gauges(db),
        "totals": totals(db),
        "latency": {
            "avg_latency_ms": latency["avg_latency_ms"],
            "p50_latency_ms": latency["p50_latency_ms"],
            "p95_latency_ms": latency["p95_latency_ms"],
            "p99_latency_ms": latency["p99_latency_ms"],
            "samples": latency["latency_samples"],
            "source": "measured in-process request timings" if latency["latency_samples"] else "no samples yet",
        },
        "event_type_counts": latency["by_type"],
        "series": series(db, window_minutes=window_minutes, limit=MAX_SERIES_POINTS),
        "services": service_health(db),
        "active_simulation": active_simulation(db),
        "notes": [
            "Latency figures are measured from real backend request handling.",
            "Payment gateway and traffic generator are explicitly simulated.",
        ],
    }
