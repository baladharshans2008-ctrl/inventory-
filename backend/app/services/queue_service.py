"""Virtual waiting queue.

The queue is *server-authoritative*: the browser never gets to decide that it
has been admitted. Every entry has a token, a server-computed position and an
expiry. Re-submitting the same ``request_key`` (page refresh, retry, double
click) returns the same entry instead of creating a second one.

It is intentionally **not** the authority for seat ownership: even an admitted
request must still win the transactional seat allocation in
``services.inventory``.
"""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from ..config import settings
from ..errors import NotFound, QueueNotReady, ValidationFailure
from ..models import (
    QUEUE_CONSUMED,
    QUEUE_EXPIRED,
    QUEUE_PROCESSING,
    QUEUE_READY,
    QUEUE_WAITING,
    QueueEntry,
)
from ..utils import queue_token as make_token
from ..utils import utcnow
from .events import log_event


def _active_admissions(db: Session) -> int:
    """Entries currently occupying booking-service capacity."""
    return int(
        db.scalar(
            select(func.count(QueueEntry.id)).where(
                QueueEntry.status.in_((QUEUE_READY, QUEUE_PROCESSING)),
                QueueEntry.expires_at.is_not(None),
                QueueEntry.expires_at > utcnow(),
            )
        )
        or 0
    )


def queue_depth(db: Session) -> dict:
    now = utcnow()
    waiting = int(
        db.scalar(
            select(func.count(QueueEntry.id)).where(
                QueueEntry.status == QUEUE_WAITING,
                (QueueEntry.expires_at.is_(None)) | (QueueEntry.expires_at > now),
            )
        )
        or 0
    )
    admitted = _active_admissions(db)
    return {
        "waiting": waiting,
        "admitted": admitted,
        "capacity": settings.queue_capacity,
        "admission_rate_per_second": settings.queue_admission_rate,
        "occupancy_pct": round(min(100.0, (admitted / settings.queue_capacity) * 100), 1)
        if settings.queue_capacity
        else 0.0,
    }


def is_saturated(db: Session) -> bool:
    return _active_admissions(db) >= settings.queue_capacity


def join_queue(
    db: Session,
    *,
    request_key: str,
    client_id: str,
    schedule_id: int,
    travel_class: str,
    passenger_count: int,
) -> tuple[QueueEntry, bool]:
    """Join (or re-fetch) a queue entry. Idempotent on ``request_key``."""
    if passenger_count < 1 or passenger_count > 6:
        raise ValidationFailure("passenger_count must be between 1 and 6")

    existing = db.scalar(select(QueueEntry).where(QueueEntry.request_key == request_key))
    if existing is not None:
        if existing.status == QUEUE_EXPIRED:
            # An expired entry may be renewed by the same client (not a new row).
            existing.status = QUEUE_WAITING
            existing.joined_at = utcnow()
            existing.expires_at = utcnow() + timedelta(seconds=settings.queue_entry_ttl_seconds)
            existing.note = "Token renewed after expiry (same request key)."
            db.commit()
            db.refresh(existing)
            log_event(
                db,
                "queue.renewed",
                f"Queue token {existing.token} renewed for the same request key",
                severity="warning",
                payload={"token": existing.token},
            )
            return existing, False
        return existing, False

    now = utcnow()
    waiting_ahead = int(
        db.scalar(
            select(func.count(QueueEntry.id)).where(
                QueueEntry.status == QUEUE_WAITING,
                (QueueEntry.expires_at.is_(None)) | (QueueEntry.expires_at > now),
            )
        )
        or 0
    )

    entry = QueueEntry(
        token=make_token(),
        request_key=request_key,
        client_id=client_id,
        schedule_id=schedule_id,
        travel_class=travel_class,
        passenger_count=passenger_count,
        joined_at=now,
        expires_at=now + timedelta(seconds=settings.queue_entry_ttl_seconds),
    )

    if not is_saturated(db):
        entry.status = QUEUE_READY
        entry.admitted_at = now
        entry.position_at_join = 0
        entry.note = "Admitted immediately - booking service capacity available."
    else:
        entry.status = QUEUE_WAITING
        entry.position_at_join = waiting_ahead + 1
        entry.note = "Queued - the booking service is at capacity."

    db.add(entry)
    db.commit()
    db.refresh(entry)
    log_event(
        db,
        "queue.joined",
        f"Queue token {entry.token} -> {entry.status} (position {entry.position_at_join})",
        payload={"token": entry.token, "status": entry.status, "schedule_id": schedule_id},
    )
    return entry, True


def queue_position(db: Session, entry: QueueEntry) -> int:
    """Server-side position. Always recomputed, never trusted from the client."""
    if entry.status != QUEUE_WAITING:
        return 0
    ahead = int(
        db.scalar(
            select(func.count(QueueEntry.id)).where(
                QueueEntry.status == QUEUE_WAITING,
                QueueEntry.id < entry.id,
            )
        )
        or 0
    )
    return ahead + 1


def describe_queue_entry(db: Session, entry: QueueEntry) -> dict:
    position = queue_position(db, entry)
    depth = queue_depth(db)
    rate = max(1, settings.queue_admission_rate)
    estimate = round(position / rate, 1) if position else 0.0
    return {
        "token": entry.token,
        "request_key": entry.request_key,
        "status": entry.status,
        "position": position,
        "position_at_join": entry.position_at_join,
        "requests_ahead": max(0, position - 1),
        "estimated_wait_seconds": estimate,
        "estimate_is_approximate": True,
        "queue_depth": depth,
        "capacity": settings.queue_capacity,
        "admission_rate_per_second": rate,
        "joined_at": entry.joined_at.isoformat(),
        "admitted_at": entry.admitted_at.isoformat() if entry.admitted_at else None,
        "expires_at": entry.expires_at.isoformat() if entry.expires_at else None,
        "schedule_id": entry.schedule_id,
        "travel_class": entry.travel_class,
        "passenger_count": entry.passenger_count,
        "note": entry.note,
        "expired": bool(entry.expires_at and entry.expires_at <= utcnow()),
    }


def promote_entries(db: Session, *, limit: int | None = None) -> int:
    """Admission worker: move WAITING -> READY at the configured rate."""
    budget = settings.queue_admission_rate if limit is None else limit
    now = utcnow()
    promoted = 0
    free = settings.queue_capacity - _active_admissions(db)
    budget = min(budget, max(0, free))
    if budget <= 0:
        return 0

    candidates = db.scalars(
        select(QueueEntry)
        .where(QueueEntry.status == QUEUE_WAITING, QueueEntry.expires_at > now)
        .order_by(QueueEntry.id)
        .limit(budget)
    ).all()
    for entry in candidates:
        entry.status = QUEUE_READY
        entry.admitted_at = now
        entry.note = "Admitted by the queue processor."
        promoted += 1
    if promoted:
        db.commit()
        log_event(
            db,
            "queue.admitted",
            f"{promoted} queued request(s) admitted to the booking service",
            payload={"promoted": promoted, "depth": queue_depth(db)},
        )
    return promoted


def expire_entries(db: Session, *, limit: int = 200) -> int:
    now = utcnow()
    result = db.execute(
        update(QueueEntry)
        .where(
            QueueEntry.status.in_((QUEUE_WAITING, QUEUE_READY)),
            QueueEntry.expires_at.is_not(None),
            QueueEntry.expires_at <= now,
        )
        .values(status=QUEUE_EXPIRED, note="Queue token expired before admission.")
    )
    if result.rowcount:
        db.commit()
        log_event(
            db,
            "queue.expired",
            f"{result.rowcount} queue token(s) expired",
            severity="warning",
            payload={"count": int(result.rowcount)},
        )
    return int(result.rowcount or 0)


def consume_token(db: Session, token: str, *, schedule_id: int, travel_class: str) -> QueueEntry:
    """Validate + burn an admission token as part of a booking request."""
    entry = db.scalar(select(QueueEntry).where(QueueEntry.token == token))
    if entry is None:
        raise NotFound("Queue token not found", details={"token": token})
    if entry.schedule_id != schedule_id or entry.travel_class != travel_class:
        raise QueueNotReady("Queue token does not match this booking request")
    if entry.expires_at and entry.expires_at <= utcnow():
        raise QueueNotReady("Queue token expired - please join the queue again")
    if entry.status in (QUEUE_WAITING, QUEUE_EXPIRED, QUEUE_CONSUMED):
        raise QueueNotReady(
            f"Queue token is not admitted yet (status {entry.status})",
            details={"status": entry.status, "position": queue_position(db, entry)},
        )

    entry.status = QUEUE_CONSUMED
    entry.consumed_at = utcnow()
    db.commit()
    log_event(
        db,
        "queue.consumed",
        f"Queue token {entry.token} consumed by a booking request",
        payload={"token": entry.token},
    )
    return entry


def inject_surge(db: Session, *, count: int, schedule_id: int, travel_class: str = "SL") -> int:
    """Demo helper: pre-fill the queue so judges can watch it drain."""
    count = max(1, min(count, 400))
    now = utcnow()
    for _ in range(count):
        db.add(
            QueueEntry(
                token=make_token(),
                request_key="surge_" + make_token(),
                client_id="demo-surge",
                schedule_id=schedule_id,
                travel_class=travel_class,
                passenger_count=1,
                status=QUEUE_WAITING,
                joined_at=now,
                expires_at=now + timedelta(seconds=settings.queue_entry_ttl_seconds),
                note="Synthetic traffic surge (demo mode).",
                is_synthetic=True,
            )
        )
    db.commit()
    log_event(
        db,
        "queue.surge_injected",
        f"Demo traffic surge injected: {count} waiting requests",
        severity="warning",
        payload={"count": count},
    )
    return count


def clear_demo_queue(db: Session) -> int:
    result = db.execute(
        update(QueueEntry)
        .where(QueueEntry.status.in_((QUEUE_WAITING, QUEUE_READY)), QueueEntry.is_synthetic.is_(True))
        .values(status=QUEUE_EXPIRED, note="Cleared by demo control.")
    )
    db.commit()
    return int(result.rowcount or 0)
