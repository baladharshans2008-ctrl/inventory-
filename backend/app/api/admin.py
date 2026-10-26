"""Reliability operations dashboard endpoints (admin access)."""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db, read_session_scope
from ..models import AppEvent, MetricsSample, Reservation, SeatInventory
from ..schemas import event_dict
from ..services import inventory, metrics
from ..utils import utcnow
from .deps import require_admin

router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(require_admin)])

WINDOWS = {"5m": 5, "15m": 15, "60m": 60, "180m": 180}


@router.get("/metrics")
def get_metrics(
    window: str = Query(default="15m", pattern="^(5m|15m|60m|180m)$"),
    db: Session = Depends(get_db),
) -> dict:
    """Live dashboard payload. Values come from recorded events + DB gauges."""
    return metrics.dashboard(db, window_minutes=WINDOWS[window])


@router.get("/events")
def get_events(
    limit: int = Query(default=60, ge=1, le=300),
    event_type: str | None = Query(default=None, max_length=60),
    severity: str | None = Query(default=None, max_length=12),
    db: Session = Depends(get_db),
) -> dict:
    stmt = select(AppEvent)
    if event_type:
        stmt = stmt.where(AppEvent.event_type.like(f"{event_type}%"))
    if severity:
        stmt = stmt.where(AppEvent.severity == severity)
    rows = db.scalars(stmt.order_by(AppEvent.id.desc()).limit(limit)).all()
    return {"count": len(rows), "events": [event_dict(e) for e in rows]}


@router.get("/event-types")
def event_types(db: Session = Depends(get_db)) -> dict:
    rows = db.execute(
        select(AppEvent.event_type, func.count(AppEvent.id)).group_by(AppEvent.event_type).order_by(func.count(AppEvent.id).desc())
    ).all()
    return {"types": [{"event_type": t, "count": int(c)} for t, c in rows]}


@router.get("/inventory")
def inventory_overview(db: Session = Depends(get_db)) -> dict:
    rows = db.execute(
        select(
            SeatInventory.schedule_id,
            SeatInventory.travel_class,
            SeatInventory.total_seats,
            SeatInventory.available_count,
            SeatInventory.held_count,
            SeatInventory.confirmed_count,
        )
        .join(Reservation.__table__, Reservation.schedule_id == SeatInventory.schedule_id, isouter=True)
        .group_by(SeatInventory.id)
        .limit(50)
    ).all()
    return {
        "count": len(rows),
        "inventory": [
            {
                "schedule_id": schedule_id,
                "travel_class": travel_class,
                "total_seats": total,
                "available": available,
                "held": held,
                "confirmed": confirmed,
            }
            for schedule_id, travel_class, total, available, held, confirmed in rows
        ],
    }


@router.get("/inventory/{schedule_id}/consistency")
def consistency(schedule_id: int, db: Session = Depends(get_db)) -> dict:
    """Test F, on demand: counters must reconcile with the physical seat rows."""
    return inventory.consistency_check(db, schedule_id)


@router.get("/metrics/raw")
def raw_samples(
    limit: int = Query(default=200, ge=1, le=1000),
    db: Session = Depends(get_db),
) -> dict:
    rows = db.scalars(select(MetricsSample).order_by(MetricsSample.id.desc()).limit(limit)).all()
    return {
        "count": len(rows),
        "samples": [
            {
                "bucket": r.bucket.isoformat(),
                "requests": r.requests,
                "successful": r.successful,
                "failed": r.failed,
                "conflicts": r.conflicts,
                "rps": r.rps,
                "avg_latency_ms": r.avg_latency_ms,
                "p95_latency_ms": r.p95_latency_ms,
                "queue_depth": r.queue_depth,
                "pending_reconciliations": r.pending_reconciliations,
            }
            for r in rows
        ],
    }


@router.get("/stream")
async def stream(
    interval: float = Query(default=2.0, ge=0.5, le=10.0),
    window: str = Query(default="15m", pattern="^(5m|15m|60m|180m)$"),
    max_seconds: int = Query(default=900, ge=10, le=3600),
):
    """Server-Sent Events feed for the live dashboard (real backend data)."""

    async def event_source():
        last_event_id = 0
        started = utcnow()
        # First frame immediately, so the browser/EventSource connects fast.
        while (utcnow() - started).total_seconds() < max_seconds:
            # Read-only session: never opens a write transaction, so the
            # stream cannot contend with the workers for SQLite's writer lock.
            with read_session_scope() as db:
                payload = metrics.dashboard(db, window_minutes=WINDOWS[window])
                new_events = db.scalars(
                    select(AppEvent).where(AppEvent.id > last_event_id).order_by(AppEvent.id).limit(50)
                ).all()
                last_event_id = max([e.id for e in new_events], default=last_event_id)
                payload["new_events"] = [event_dict(e) for e in new_events]
            yield f"event: metrics\ndata: {json.dumps(payload, default=str)}\n\n"
            await asyncio.sleep(interval)

    return StreamingResponse(
        event_source(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )
