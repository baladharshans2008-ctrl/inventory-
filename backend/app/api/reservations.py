"""Booking / reservation endpoints - the transaction-critical path."""

from __future__ import annotations

import time

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from ..config import settings
from ..db import get_db
from ..errors import NotFound, QueueRequired, SeatUnavailable, ValidationFailure
from ..models import RESERVATION_HELD, Reservation
from ..schemas import ReservationRequest, reservation_dict
from ..services import inventory, queue_service
from ..services.events import counters, log_event
from .deps import client_id, current_request_id, enforce_rate_limit

router = APIRouter(tags=["bookings"])


@router.post("/reservations", status_code=201)
def create_reservation(
    payload: ReservationRequest,
    request: Request,
    db: Session = Depends(get_db),
    _rate: None = Depends(enforce_rate_limit),
    rid: str | None = Depends(current_request_id),
    cid: str = Depends(client_id),
) -> dict:
    """Atomically hold seats for a booking request.

    Admission rule (enforced here, not in the browser):
      * a valid, admitted ``queue_token`` is consumed when one is supplied, or
      * the request is admitted immediately only while the booking service has
        free capacity. Under saturation a 429 tells the client to join the queue.
    """
    if not payload.queue_token and queue_service.is_saturated(db):
        state = queue_service.queue_depth(db)
        log_event(
            db,
            "booking.queue_required",
            "Booking request rejected - booking service at capacity, queue admission required",
            severity="warning",
            payload={"queue": state},
            request_id=rid,
        )
        raise QueueRequired(
            "The booking service is at capacity. Join the virtual queue and retry once admitted.",
            details={"queue": state},
        )

    started = time.perf_counter()
    log_event(
        db,
        "booking.attempt",
        f"Booking attempt: schedule {payload.schedule_id} {payload.travel_class} "
        f"x{len(payload.passengers)} passenger(s)",
        payload={
            "schedule_id": payload.schedule_id,
            "travel_class": payload.travel_class,
            "passengers": len(payload.passengers),
            "idempotency_key": payload.idempotency_key,
            "queue_token": payload.queue_token,
            "client_id": cid,
        },
        request_id=rid,
    )

    if payload.queue_token:
        queue_service.consume_token(
            db, payload.queue_token, schedule_id=payload.schedule_id, travel_class=payload.travel_class
        )

    try:
        reservation, created = inventory.hold_seats(
            db,
            schedule_id=payload.schedule_id,
            travel_class=payload.travel_class,
            passengers=[p.model_dump() for p in payload.passengers],
            idempotency_key=payload.idempotency_key,
            queue_token=payload.queue_token,
            hold_seconds=payload.hold_seconds,
            contact_email=payload.contact_email,
            contact_phone=payload.contact_phone,
        )
    except SeatUnavailable as exc:
        log_event(
            db,
            "booking.conflict",
            f"Seat conflict - {exc.message}",
            severity="warning",
            payload={"schedule_id": payload.schedule_id, "details": exc.details},
            request_id=rid,
        )
        counters().bump("booking.latency_ms", (time.perf_counter() - started) * 1000)
        raise

    latency = (time.perf_counter() - started) * 1000
    counters().bump("booking.latency_ms", latency)

    return {
        "created": created,
        "message": (
            "Seats held. Complete the simulated payment before the hold expires."
            if created
            else "This request was already processed - returning the original reservation."
        ),
        "hold_minutes": settings.hold_minutes,
        "reservation": reservation_dict(reservation),
        "latency_ms": round(latency, 1),
    }


@router.get("/reservations")
def list_reservations(
    pnr: str | None = Query(default=None, max_length=16),
    idempotency_key: str | None = Query(default=None, max_length=80),
    contact_email: str | None = Query(default=None, max_length=160),
    include_simulations: bool = Query(default=False),
    limit: int = Query(default=25, ge=1, le=100),
    db: Session = Depends(get_db),
) -> dict:
    """Booking history / lookup."""
    stmt = select(Reservation).options(joinedload(Reservation.schedule), joinedload(Reservation.passengers))
    if pnr:
        stmt = stmt.where(Reservation.pnr == pnr.upper())
    if idempotency_key:
        stmt = stmt.where(Reservation.idempotency_key == idempotency_key)
    if contact_email:
        stmt = stmt.where(Reservation.contact_email == contact_email)
    if not include_simulations:
        stmt = stmt.where(Reservation.is_simulation.is_(False))
    rows = db.scalars(stmt.order_by(Reservation.created_at.desc()).limit(limit)).unique().all()
    return {"count": len(rows), "reservations": [reservation_dict(r) for r in rows]}


@router.get("/reservations/{reservation_id}")
def get_reservation(reservation_id: str, db: Session = Depends(get_db)) -> dict:
    reservation = db.scalar(
        select(Reservation)
        .options(joinedload(Reservation.schedule), joinedload(Reservation.passengers))
        .where(Reservation.id == reservation_id)
    )
    if reservation is None:
        raise NotFound("Reservation not found", details={"reservation_id": reservation_id})
    return {"reservation": reservation_dict(reservation)}


@router.post("/reservations/{reservation_id}/cancel")
def cancel_reservation(reservation_id: str, db: Session = Depends(get_db)) -> dict:
    """Cancel a held booking and return its seats to inventory (idempotent)."""
    reservation = db.get(Reservation, reservation_id)
    if reservation is None:
        raise NotFound("Reservation not found", details={"reservation_id": reservation_id})
    if reservation.status != RESERVATION_HELD:
        raise ValidationFailure(
            f"Only held bookings can be cancelled (current status: {reservation.status})",
            details={"status": reservation.status},
        )
    released = inventory.release_reservation(db, reservation, reason="user_cancelled")
    db.refresh(reservation)
    return {"released": released, "reservation": reservation_dict(reservation)}
