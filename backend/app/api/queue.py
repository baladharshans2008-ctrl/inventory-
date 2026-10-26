"""Virtual waiting queue endpoints (server-authoritative)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from ..db import get_db
from ..errors import NotFound
from ..models import QueueEntry
from ..schemas import QueueJoinRequest, QueueSurgeRequest
from ..services import queue_service
from ..services.events import log_event
from .deps import client_id, current_request_id, enforce_rate_limit, require_admin

router = APIRouter(tags=["queue"])


@router.post("/queue/join", status_code=201)
def join_queue(
    payload: QueueJoinRequest,
    db: Session = Depends(get_db),
    _rate: None = Depends(enforce_rate_limit),
    cid: str = Depends(client_id),
    rid: str | None = Depends(current_request_id),
) -> dict:
    """Join the waiting queue. Idempotent on ``request_key``.

    Refreshing the page (or retrying) with the same ``request_key`` returns the
    existing entry - it never creates a second queue slot for one request.
    """
    entry, created = queue_service.join_queue(
        db,
        request_key=payload.request_key,
        client_id=cid,
        schedule_id=payload.schedule_id,
        travel_class=payload.travel_class,
        passenger_count=payload.passenger_count,
    )
    state = queue_service.describe_queue_entry(db, entry)
    log_event(
        db,
        "queue.polled" if not created else "queue.joined",
        f"Queue {entry.token} state={entry.status} position={state['position']}",
        payload={"token": entry.token, "created": created},
        request_id=rid,
    )
    return {"created": created, "queue": state}


@router.get("/queue/status")
def queue_status(db: Session = Depends(get_db)) -> dict:
    """Aggregate queue load - used by the landing page live indicators."""
    return {"queue": queue_service.queue_depth(db), "saturated": queue_service.is_saturated(db)}


@router.get("/queue/{token}")
def queue_entry(
    token: str,
    db: Session = Depends(get_db),
    _rate: None = Depends(enforce_rate_limit),
) -> dict:
    entry = db.query(QueueEntry).filter(QueueEntry.token == token).one_or_none()
    if entry is None:
        raise NotFound("Queue token not found", details={"token": token})
    return {"queue": queue_service.describe_queue_entry(db, entry)}


@router.post("/queue/demo-surge", dependencies=[Depends(require_admin)])
def demo_surge(payload: QueueSurgeRequest, db: Session = Depends(get_db)) -> dict:
    """Demo control: inject synthetic waiting traffic so the queue visibly drains."""
    count = queue_service.inject_surge(
        db, count=payload.count, schedule_id=payload.schedule_id, travel_class=payload.travel_class.upper()
    )
    return {"injected": count, "queue": queue_service.queue_depth(db), "simulated": True}


@router.post("/queue/demo-clear", dependencies=[Depends(require_admin)])
def demo_clear(db: Session = Depends(get_db)) -> dict:
    cleared = queue_service.clear_demo_queue(db)
    return {"cleared": cleared, "queue": queue_service.queue_depth(db), "simulated": True}


@router.post("/queue/promote", dependencies=[Depends(require_admin)])
def force_promote(
    limit: int = Query(default=10, ge=1, le=100),
    db: Session = Depends(get_db),
) -> dict:
    """Demo control: admit waiting requests immediately (uses the real processor)."""
    promoted = queue_service.promote_entries(db, limit=limit)
    return {"promoted": promoted, "queue": queue_service.queue_depth(db)}
