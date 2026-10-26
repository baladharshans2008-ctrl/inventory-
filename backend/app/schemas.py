"""Request bodies and JSON serialisers (single place, so the frontend contract
is easy to read)."""

from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field, field_validator

from .models import Reservation, SeatInventory, Schedule, Station, Train
from .utils import utcnow


# --------------------------------------------------------------------------
# request bodies
# --------------------------------------------------------------------------
class PassengerIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    age: int = Field(ge=1, le=120)
    gender: str = Field(default="Other", max_length=10)
    berth_preference: str = Field(default="No Preference", max_length=16)


class QueueJoinRequest(BaseModel):
    schedule_id: int = Field(gt=0)
    travel_class: str = Field(min_length=1, max_length=8)
    passenger_count: int = Field(default=1, ge=1, le=6)
    request_key: str = Field(min_length=6, max_length=80)

    @field_validator("travel_class")
    @classmethod
    def upper(cls, value: str) -> str:
        return value.upper()


class QueueSurgeRequest(BaseModel):
    count: int = Field(default=150, ge=1, le=400)
    schedule_id: int = Field(gt=0)
    travel_class: str = "SL"


class ReservationRequest(BaseModel):
    schedule_id: int = Field(gt=0)
    travel_class: str = Field(min_length=1, max_length=8)
    passengers: list[PassengerIn] = Field(min_length=1, max_length=6)
    idempotency_key: str = Field(min_length=6, max_length=80)
    queue_token: str | None = None
    contact_email: str | None = Field(default=None, max_length=160)
    contact_phone: str | None = Field(default=None, max_length=20)
    hold_seconds: int | None = Field(default=None, ge=0, le=3600)

    @field_validator("travel_class")
    @classmethod
    def upper(cls, value: str) -> str:
        return value.upper()


class PaymentRequest(BaseModel):
    reservation_id: str = Field(min_length=6, max_length=32)
    idempotency_key: str = Field(min_length=6, max_length=80)
    scenario: str = "auto"
    delay_ms: int = Field(default=0, ge=0, le=5000)


class SimulationRequest(BaseModel):
    scenario: str = "normal_traffic"
    mode: str = "protected"
    concurrent_requests: int | None = None
    available_seats: int | None = None
    seats_per_request: int | None = None
    arrival_rate_per_second: int | None = None
    payment_failure_pct: int | None = None
    payment_delay_ms: int | None = None
    network_timeout_pct: int | None = None
    hold_seconds: int | None = None
    duplicate_retry_pct: int | None = None
    seed: int | None = None


# --------------------------------------------------------------------------
# serialisers
# --------------------------------------------------------------------------
def station_dict(station: Station) -> dict:
    return {
        "code": station.code,
        "name": station.name,
        "city": station.city,
        "state": station.state,
        "zone": station.zone,
    }


def train_dict(train: Train) -> dict:
    return {"id": train.id, "number": train.number, "name": train.name, "type": train.train_type}


def _availability_label(available: int, total: int) -> str:
    if available <= 0:
        return "NOT_AVAILABLE"
    if available <= max(2, int(total * 0.05)):
        return "RAC_ONLY"
    if available <= max(6, int(total * 0.2)):
        return "LIMITED"
    return "AVAILABLE"


def inventory_dict(inv: SeatInventory) -> dict:
    return {
        "travel_class": inv.travel_class,
        "total_seats": inv.total_seats,
        "available_count": inv.available_count,
        "held_count": inv.held_count,
        "confirmed_count": inv.confirmed_count,
        "fare": inv.base_fare,
        "availability_status": _availability_label(inv.available_count, inv.total_seats),
    }


def schedule_dict(schedule: Schedule, *, travel_class: str | None = None) -> dict:
    classes = [inventory_dict(inv) for inv in sorted(schedule.inventory, key=lambda i: i.travel_class)]
    selected = None
    if travel_class:
        selected = next((c for c in classes if c["travel_class"] == travel_class), None)

    depart = schedule.departure_time.strftime("%H:%M")
    arrive = schedule.arrival_time.strftime("%H:%M")
    return {
        "schedule_id": schedule.id,
        "travel_date": schedule.travel_date.isoformat(),
        "train": train_dict(schedule.train),
        "from": {"code": schedule.from_code},
        "to": {"code": schedule.to_code},
        "departure_time": depart,
        "arrival_time": arrive,
        "duration_minutes": schedule.duration_minutes,
        "duration_label": f"{schedule.duration_minutes // 60}h {schedule.duration_minutes % 60:02d}m",
        "distance_km": schedule.distance_km,
        "overnight": schedule.arrival_time < schedule.departure_time,
        "classes": classes,
        "selected_class": selected,
        "is_simulation": schedule.is_simulation,
    }


def reservation_dict(reservation: Reservation, *, schedule: Schedule | None = None) -> dict:
    schedule = schedule or reservation.schedule
    now = utcnow()
    seconds_left = (
        max(0, int((reservation.hold_expires_at - now).total_seconds()))
        if reservation.hold_expires_at
        else 0
    )
    return {
        "reservation_id": reservation.id,
        "pnr": reservation.pnr,
        "status": reservation.status,
        "schedule": schedule_dict(schedule, travel_class=reservation.travel_class),
        "travel_class": reservation.travel_class,
        "passenger_count": reservation.passenger_count,
        "total_fare": reservation.total_fare,
        "seat_numbers": reservation.seat_numbers,
        "hold_expires_at": reservation.hold_expires_at.isoformat() if reservation.hold_expires_at else None,
        "hold_seconds_remaining": seconds_left,
        "idempotency_key": reservation.idempotency_key,
        "queue_token": reservation.queue_token,
        "contact_email": reservation.contact_email,
        "contact_phone": reservation.contact_phone,
        "created_at": reservation.created_at.isoformat(),
        "confirmed_at": reservation.confirmed_at.isoformat() if reservation.confirmed_at else None,
        "released_at": reservation.released_at.isoformat() if reservation.released_at else None,
        "release_reason": reservation.release_reason,
        "is_simulation": reservation.is_simulation,
        "passengers": [
            {
                "name": p.name,
                "age": p.age,
                "gender": p.gender,
                "berth_preference": p.berth_preference,
                "seat_number": p.seat_number,
            }
            for p in reservation.passengers
        ],
    }


def payment_dict(txn) -> dict:
    from .models import PAYMENT_PENDING, PAYMENT_SUCCESS

    timeline = [
        {"state": "INITIATED", "at": txn.created_at.isoformat(), "done": True},
        {
            "state": txn.status,
            "at": (txn.resolved_at or txn.updated_at).isoformat(),
            "done": txn.status in (PAYMENT_SUCCESS, "FAILED"),
        },
    ]
    next_action = "none"
    if txn.status == PAYMENT_PENDING:
        next_action = "wait_for_reconciliation"
    elif txn.status == "RECONCILING":
        next_action = "reconciliation_in_progress"
    return {
        "payment_id": txn.id,
        "reference": txn.reference,
        "reservation_id": txn.reservation_id,
        "pnr": txn.reservation.pnr if txn.reservation else None,
        "amount": txn.amount,
        "status": txn.status,
        "scenario": txn.scenario,
        "gateway_ref": txn.gateway_ref,
        "simulated": True,
        "attempts": txn.attempt_count,
        "reconciled": txn.reconciled,
        "reconciliation_notes": txn.reconciliation_notes,
        "failure_reason": txn.failure_reason,
        "message": txn.message,
        "latency_ms": txn.latency_ms,
        "resolve_at": txn.resolve_at.isoformat() if txn.resolve_at else None,
        "created_at": txn.created_at.isoformat(),
        "updated_at": txn.updated_at.isoformat(),
        "resolved_at": txn.resolved_at.isoformat() if txn.resolved_at else None,
        "next_action": next_action,
        "do_not_retry": txn.status == PAYMENT_PENDING,
        "timeline": timeline,
        "idempotency_key": txn.idempotency_key,
    }


def event_dict(event) -> dict:
    return {
        "id": event.id,
        "event_type": event.event_type,
        "message": event.message,
        "severity": event.severity,
        "request_id": event.request_id,
        "payload": event.payload,
        "created_at": event.created_at.isoformat(),
    }


def parse_date(value: str | date) -> date:
    if isinstance(value, date):
        return value
    return date.fromisoformat(value)
