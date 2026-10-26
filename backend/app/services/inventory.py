"""Seat allocation - the reliability core of RailFlow AI.

Guarantees implemented here
---------------------------
1. Availability is checked and seats are claimed inside ONE database
   transaction. On PostgreSQL the inventory row and candidate seats are
   locked with ``SELECT ... FOR UPDATE (SKIP LOCKED)``; on the SQLite fallback
   every transaction opens with ``BEGIN IMMEDIATE`` so writers are serialised.
2. Each seat claim is a *conditional* UPDATE
   (``WHERE status = 'AVAILABLE'``) and the affected row count is verified.
   If another request won the race the transaction is rolled back and a
   ``409 seat_unavailable`` conflict is returned - never a silent double
   booking.
3. Counters can never go negative: they are only decremented together with a
   successful seat-row transition.
4. ``idempotency_key`` is UNIQUE on reservations, so a retried request returns
   the original reservation instead of creating a second logical booking.
"""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from ..config import settings
from ..db import IS_POSTGRES
from ..errors import NotFound, SeatUnavailable, ValidationFailure
from ..models import (
    PAYMENT_SUCCESS,
    RESERVATION_CONFIRMED,
    RESERVATION_EXPIRED,
    RESERVATION_HELD,
    RESERVATION_RELEASED,
    SEAT_AVAILABLE,
    SEAT_CONFIRMED,
    SEAT_HELD,
    Passenger,
    PaymentTransaction,
    Reservation,
    Schedule,
    Seat,
    SeatInventory,
)
from ..utils import new_id, pnr, utcnow
from .events import log_event

CLASSES = ("1A", "2A", "3A", "SL", "CC", "EC")

MAX_SEATS_PER_BOOKING = 6


# --------------------------------------------------------------------------
# lookups
# --------------------------------------------------------------------------
def get_schedule(db: Session, schedule_id: int) -> Schedule:
    schedule = db.get(Schedule, schedule_id)
    if schedule is None:
        raise NotFound("Train schedule not found", details={"schedule_id": schedule_id})
    return schedule


def get_inventory(db: Session, schedule_id: int, travel_class: str) -> SeatInventory:
    inv = db.scalar(
        select(SeatInventory).where(
            SeatInventory.schedule_id == schedule_id,
            SeatInventory.travel_class == travel_class,
        )
    )
    if inv is None:
        raise NotFound(
            f"Class {travel_class} is not offered on this train",
            details={"schedule_id": schedule_id, "travel_class": travel_class},
        )
    return inv


def _lock_inventory(db: Session, schedule_id: int, travel_class: str) -> SeatInventory:
    """Row-level lock on the class counter (no-op on SQLite, which serialises writers)."""
    inv = get_inventory(db, schedule_id, travel_class)
    if IS_POSTGRES:
        inv = db.scalar(
            select(SeatInventory)
            .where(SeatInventory.id == inv.id)
            .with_for_update()
        )
    return inv


# --------------------------------------------------------------------------
# hold / confirm / release
# --------------------------------------------------------------------------
def hold_seats(
    db: Session,
    *,
    schedule_id: int,
    travel_class: str,
    passengers: list[dict],
    idempotency_key: str,
    queue_token: str | None = None,
    hold_seconds: int | None = None,
    contact_email: str | None = None,
    contact_phone: str | None = None,
    is_simulation: bool = False,
) -> tuple[Reservation, bool]:
    """Atomically HELD-ify seats for one booking request.

    Returns ``(reservation, created)`` where ``created`` is False when the
    request is an idempotent replay of an earlier one.
    """
    count = len(passengers)
    if count < 1 or count > MAX_SEATS_PER_BOOKING:
        raise ValidationFailure(f"passenger_count must be between 1 and {MAX_SEATS_PER_BOOKING}")
    if travel_class not in CLASSES:
        raise ValidationFailure(f"travel_class must be one of {', '.join(CLASSES)}")

    # Idempotency: a replayed request returns the first reservation untouched.
    existing = db.scalar(select(Reservation).where(Reservation.idempotency_key == idempotency_key))
    if existing is not None:
        log_event(
            db,
            "booking.duplicate_blocked",
            f"Duplicate booking request blocked (idempotency key {idempotency_key[:12]}...)",
            severity="warning",
            payload={"reservation_id": existing.id, "pnr": existing.pnr},
            commit=False,
        )
        db.commit()
        return existing, False

    schedule = get_schedule(db, schedule_id)
    inv = _lock_inventory(db, schedule_id, travel_class)

    if inv.available_count < count:
        db.rollback()
        raise SeatUnavailable(
            "Not enough seats available in this class",
            details={"available": inv.available_count, "requested": count},
        )

    candidate_stmt = (
        select(Seat)
        .where(
            Seat.schedule_id == schedule_id,
            Seat.travel_class == travel_class,
            Seat.status == SEAT_AVAILABLE,
        )
        .order_by(Seat.id)
        .limit(count)
    )
    if IS_POSTGRES:
        candidate_stmt = candidate_stmt.with_for_update(skip_locked=True)
    seats = list(db.scalars(candidate_stmt).all())

    if len(seats) < count:
        db.rollback()
        raise SeatUnavailable(
            "Requested seats were taken by a concurrent booking",
            details={"available": len(seats), "requested": count},
        )

    now = utcnow()
    effective_hold = hold_seconds if hold_seconds is not None else settings.hold_minutes * 60
    hold_until = now + timedelta(seconds=effective_hold)
    reservation = Reservation(
        id=new_id(),
        pnr=pnr(),
        schedule_id=schedule_id,
        travel_class=travel_class,
        passenger_count=count,
        total_fare=round(inv.base_fare * count, 2),
        status=RESERVATION_HELD,
        seat_numbers=[],
        hold_expires_at=hold_until,
        idempotency_key=idempotency_key,
        queue_token=queue_token,
        contact_email=contact_email,
        contact_phone=contact_phone,
        is_simulation=is_simulation,
        created_at=now,
    )
    db.add(reservation)
    db.flush()

    claimed: list[str] = []
    for seat, passenger in zip(seats, passengers):
        result = db.execute(
            update(Seat)
            .where(Seat.id == seat.id, Seat.status == SEAT_AVAILABLE)
            .values(
                status=SEAT_HELD,
                reservation_id=reservation.id,
                held_until=hold_until,
                updated_at=now,
                version=Seat.version + 1,
            )
        )
        if result.rowcount != 1:
            # Lost the race on this specific seat: roll everything back so we
            # never leave a half-allocated booking behind.
            db.rollback()
            raise SeatUnavailable(
                "Seat was claimed by another request during allocation",
                details={"seat_number": seat.seat_number},
            )
        claimed.append(seat.seat_number)
        db.add(
            Passenger(
                reservation_id=reservation.id,
                name=passenger.get("name", "Passenger"),
                age=int(passenger.get("age", 30)),
                gender=passenger.get("gender", "Other"),
                berth_preference=passenger.get("berth_preference", "No Preference"),
                seat_number=seat.seat_number,
            )
        )

    reservation.seat_numbers = claimed
    inv.available_count -= count
    inv.held_count += count

    log_event(
        db,
        "booking.seats_held",
        f"Held {count} seat(s) on {schedule.train.number} ({travel_class}) - PNR {reservation.pnr}",
        payload={
            "reservation_id": reservation.id,
            "seats": claimed,
            "hold_expires_at": hold_until.isoformat(),
        },
        commit=False,
    )
    db.commit()
    db.refresh(reservation)
    return reservation, True


def confirm_reservation(db: Session, reservation: Reservation, *, reason: str = "payment_success") -> bool:
    """HELD -> CONFIRMED. Returns False when the transition was not allowed."""
    now = utcnow()
    result = db.execute(
        update(Reservation)
        .where(Reservation.id == reservation.id, Reservation.status == RESERVATION_HELD)
        .values(status=RESERVATION_CONFIRMED, confirmed_at=now, hold_expires_at=None, updated_at=now)
    )
    if result.rowcount != 1:
        db.rollback()
        return False

    seat_rows = db.execute(
        update(Seat)
        .where(Seat.reservation_id == reservation.id, Seat.status == SEAT_HELD)
        .values(status=SEAT_CONFIRMED, held_until=None, updated_at=now, version=Seat.version + 1)
    ).rowcount

    inv = get_inventory(db, reservation.schedule_id, reservation.travel_class)
    inv.held_count = max(0, inv.held_count - seat_rows)
    inv.confirmed_count += seat_rows
    db.commit()
    log_event(
        db,
        "booking.confirmed",
        f"Booking confirmed - PNR {reservation.pnr} ({reason})",
        payload={"reservation_id": reservation.id, "seats": seat_rows},
    )
    return True


def release_reservation(db: Session, reservation: Reservation, *, reason: str) -> bool:
    """HELD -> EXPIRED/RELEASED + seats back to AVAILABLE, exactly once.

    Confirmed seats are never released: the guarded status transition below
    only matches reservations still in HELD state.
    """
    now = utcnow()
    final_status = RESERVATION_EXPIRED if reason == "hold_expired" else RESERVATION_RELEASED
    result = db.execute(
        update(Reservation)
        .where(Reservation.id == reservation.id, Reservation.status == RESERVATION_HELD)
        .values(
            status=final_status,
            released_at=now,
            release_reason=reason,
            hold_expires_at=None,
            updated_at=now,
        )
    )
    if result.rowcount != 1:
        db.rollback()
        return False

    released = db.execute(
        update(Seat)
        .where(Seat.reservation_id == reservation.id, Seat.status == SEAT_HELD)
        .values(
            status=SEAT_AVAILABLE,
            reservation_id=None,
            held_until=None,
            updated_at=now,
            version=Seat.version + 1,
        )
    ).rowcount

    inv = get_inventory(db, reservation.schedule_id, reservation.travel_class)
    inv.held_count = max(0, inv.held_count - released)
    inv.available_count = min(inv.total_seats, inv.available_count + released)
    db.commit()
    log_event(
        db,
        "booking.released",
        f"{released} seat(s) released back to inventory - PNR {reservation.pnr} ({reason})",
        severity="warning",
        payload={"reservation_id": reservation.id, "reason": reason},
    )
    return True


def expire_reservations(db: Session, *, limit: int = 100, is_simulation: bool | None = None) -> list[str]:
    """Background sweep: release holds whose timer elapsed."""
    now = utcnow()
    stmt = (
        select(Reservation)
        .where(
            Reservation.status == RESERVATION_HELD,
            Reservation.hold_expires_at.is_not(None),
            Reservation.hold_expires_at <= now,
        )
        .order_by(Reservation.hold_expires_at)
        .limit(limit)
    )
    if is_simulation is not None:
        stmt = stmt.where(Reservation.is_simulation == is_simulation)

    expired_ids: list[str] = []
    for reservation in db.scalars(stmt).all():
        if release_reservation(db, reservation, reason="hold_expired"):
            expired_ids.append(reservation.id)
    return expired_ids


# --------------------------------------------------------------------------
# introspection / consistency
# --------------------------------------------------------------------------
def inventory_snapshot(db: Session, schedule_id: int) -> dict:
    rows = db.execute(
        select(Seat.travel_class, Seat.status, func.count(Seat.id))
        .where(Seat.schedule_id == schedule_id)
        .group_by(Seat.travel_class, Seat.status)
    ).all()
    counts: dict[str, dict[str, int]] = {}
    for travel_class, status, total in rows:
        counts.setdefault(travel_class, {})[status] = int(total)

    classes = []
    for inv in db.scalars(
        select(SeatInventory).where(SeatInventory.schedule_id == schedule_id).order_by(SeatInventory.travel_class)
    ).all():
        by_status = counts.get(inv.travel_class, {})
        classes.append(
            {
                "travel_class": inv.travel_class,
                "total_seats": inv.total_seats,
                "available_count": inv.available_count,
                "held_count": inv.held_count,
                "confirmed_count": inv.confirmed_count,
                "base_fare": inv.base_fare,
                "seats_by_status": by_status,
            }
        )
    return {"schedule_id": schedule_id, "classes": classes}


def consistency_check(db: Session, schedule_id: int, *, allow_oversell: bool = False) -> dict:
    """Test F - counters and seat rows must reconcile with total inventory."""
    checks: list[dict] = []
    for inv in db.scalars(
        select(SeatInventory).where(SeatInventory.schedule_id == schedule_id)
    ).all():
        by_status = dict(
            db.execute(
                select(Seat.status, func.count(Seat.id))
                .where(Seat.schedule_id == schedule_id, Seat.travel_class == inv.travel_class)
                .group_by(Seat.status)
            ).all()
        )
        available = int(by_status.get(SEAT_AVAILABLE, 0))
        held = int(by_status.get(SEAT_HELD, 0))
        confirmed = int(by_status.get(SEAT_CONFIRMED, 0))
        seat_rows = available + held + confirmed

        checks.append(
            {
                "name": f"{inv.travel_class}: seat rows match total inventory",
                "passed": seat_rows == inv.total_seats,
                "detail": f"seat rows={seat_rows}, total_seats={inv.total_seats}",
            }
        )
        checks.append(
            {
                "name": f"{inv.travel_class}: AVAILABLE counter matches seat rows",
                "passed": available == inv.available_count,
                "detail": f"rows={available}, counter={inv.available_count}",
            }
        )
        checks.append(
            {
                "name": f"{inv.travel_class}: HELD counter matches seat rows",
                "passed": held == inv.held_count,
                "detail": f"rows={held}, counter={inv.held_count}",
            }
        )
        checks.append(
            {
                "name": f"{inv.travel_class}: CONFIRMED counter matches seat rows",
                "passed": confirmed == inv.confirmed_count,
                "detail": f"rows={confirmed}, counter={inv.confirmed_count}",
            }
        )
        if not allow_oversell:
            checks.append(
                {
                    "name": f"{inv.travel_class}: inventory never negative",
                    "passed": inv.available_count >= 0 and held >= 0 and confirmed >= 0,
                    "detail": f"available={inv.available_count}, held={held}, confirmed={confirmed}",
                }
            )

    # Seats owned twice in the same (schedule, class) are structurally
    # impossible: ownership lives on a single unique seat row.
    double_booked = db.execute(
        select(Seat.travel_class, Seat.seat_number, func.count(func.distinct(Seat.reservation_id)))
        .where(Seat.schedule_id == schedule_id)
        .group_by(Seat.travel_class, Seat.seat_number)
        .having(func.count(func.distinct(Seat.reservation_id)) > 1)
    ).all()
    checks.append(
        {
            "name": "no physical seat claimed by two reservations",
            "passed": len(double_booked) == 0,
            "detail": f"double_booked_seats={len(double_booked)}",
        }
    )

    # A seat can only be owned by one reservation (enforced by the single row).
    duplicates = db.execute(
        select(Seat.reservation_id, func.count(Seat.id))
        .where(Seat.schedule_id == schedule_id, Seat.reservation_id.is_not(None))
        .group_by(Seat.reservation_id, Seat.travel_class)
        .having(func.count(Seat.id) > MAX_SEATS_PER_BOOKING)
    ).all()
    checks.append(
        {
            "name": "no reservation owns more seats than the per-booking limit",
            "passed": len(duplicates) == 0,
            "detail": f"violations={len(duplicates)}",
        }
    )

    stale_holds = db.scalar(
        select(func.count(Reservation.id)).where(
            Reservation.schedule_id == schedule_id,
            Reservation.status == RESERVATION_HELD,
            Reservation.hold_expires_at.is_not(None),
            Reservation.hold_expires_at <= utcnow(),
        )
    )
    checks.append(
        {
            "name": "no expired holds still occupying inventory",
            "passed": int(stale_holds or 0) == 0,
            "detail": f"stale_holds={int(stale_holds or 0)}",
        }
    )

    return {
        "schedule_id": schedule_id,
        "ok": all(c["passed"] for c in checks),
        "checks": checks,
    }


def count_unresolved_payments(db: Session) -> int:
    from ..models import PAYMENT_PENDING

    return int(
        db.scalar(
            select(func.count(PaymentTransaction.id)).where(PaymentTransaction.status == PAYMENT_PENDING)
        )
        or 0
    )


def payment_success_count(db: Session) -> int:
    return int(
        db.scalar(
            select(func.count(PaymentTransaction.id)).where(PaymentTransaction.status == PAYMENT_SUCCESS)
        )
        or 0
    )
