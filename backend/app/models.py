"""SQLAlchemy models - the authoritative schema for RailFlow AI.

Inventory model
---------------
`seat_inventory` holds denormalised counters (fast reads for search results)
while `seats` holds one row per physical seat. The `seats` rows are the
authority for *who owns which seat*; the counters are verified against them by
the inventory consistency check (Test F).
"""

from __future__ import annotations

from datetime import date, datetime, time

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    Time,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base
from .utils import utcnow

# Reservation lifecycle: AVAILABLE -> HELD -> CONFIRMED, HELD -> EXPIRED/RELEASED
RESERVATION_HELD = "HELD"
RESERVATION_CONFIRMED = "CONFIRMED"
RESERVATION_EXPIRED = "EXPIRED"
RESERVATION_RELEASED = "RELEASED"
RESERVATION_FAILED = "FAILED"

SEAT_AVAILABLE = "AVAILABLE"
SEAT_HELD = "HELD"
SEAT_CONFIRMED = "CONFIRMED"

PAYMENT_INITIATED = "INITIATED"
PAYMENT_PENDING = "PENDING"
PAYMENT_RECONCILING = "RECONCILING"
PAYMENT_SUCCESS = "SUCCESS"
PAYMENT_FAILED = "FAILED"

QUEUE_WAITING = "WAITING"
QUEUE_PROCESSING = "PROCESSING"
QUEUE_READY = "READY"
QUEUE_CONSUMED = "CONSUMED"
QUEUE_EXPIRED = "EXPIRED"


class Station(Base):
    __tablename__ = "stations"

    code: Mapped[str] = mapped_column(String(8), primary_key=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    city: Mapped[str] = mapped_column(String(80), nullable=False)
    state: Mapped[str] = mapped_column(String(80), nullable=False)
    zone: Mapped[str] = mapped_column(String(20), nullable=False)


class Train(Base):
    __tablename__ = "trains"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    number: Mapped[str] = mapped_column(String(10), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    train_type: Mapped[str] = mapped_column(String(40), default="Express")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Schedule(Base):
    __tablename__ = "train_schedules"
    __table_args__ = (
        UniqueConstraint("train_id", "travel_date", "from_code", "to_code", name="uq_schedule_leg"),
        Index("ix_schedule_route_date", "from_code", "to_code", "travel_date"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    train_id: Mapped[int] = mapped_column(ForeignKey("trains.id", ondelete="CASCADE"), nullable=False)
    travel_date: Mapped[date] = mapped_column(Date, nullable=False)
    from_code: Mapped[str] = mapped_column(ForeignKey("stations.code"), nullable=False)
    to_code: Mapped[str] = mapped_column(ForeignKey("stations.code"), nullable=False)
    departure_time: Mapped[time] = mapped_column(Time, nullable=False)
    arrival_time: Mapped[time] = mapped_column(Time, nullable=False)
    duration_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    distance_km: Mapped[int] = mapped_column(Integer, default=0)
    runs_on: Mapped[str] = mapped_column(String(40), default="Daily")
    is_simulation: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    train: Mapped[Train] = relationship(lazy="joined")
    inventory: Mapped[list["SeatInventory"]] = relationship(
        back_populates="schedule", cascade="all, delete-orphan", lazy="selectin"
    )


class SeatInventory(Base):
    """Denormalised per class counters for one schedule."""

    __tablename__ = "seat_inventory"
    __table_args__ = (UniqueConstraint("schedule_id", "travel_class", name="uq_inventory_class"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    schedule_id: Mapped[int] = mapped_column(ForeignKey("train_schedules.id", ondelete="CASCADE"), nullable=False)
    travel_class: Mapped[str] = mapped_column(String(8), nullable=False)
    total_seats: Mapped[int] = mapped_column(Integer, nullable=False)
    available_count: Mapped[int] = mapped_column(Integer, nullable=False)
    held_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    confirmed_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    base_fare: Mapped[float] = mapped_column(Float, nullable=False)
    rac_limit: Mapped[int] = mapped_column(Integer, default=0)

    schedule: Mapped[Schedule] = relationship(back_populates="inventory")


class Seat(Base):
    """One row per physical seat. This is the authority for seat ownership."""

    __tablename__ = "seats"
    __table_args__ = (
        UniqueConstraint("schedule_id", "travel_class", "seat_number", name="uq_seat_identity"),
        Index("ix_seat_lookup", "schedule_id", "travel_class", "status"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    schedule_id: Mapped[int] = mapped_column(ForeignKey("train_schedules.id", ondelete="CASCADE"), nullable=False)
    travel_class: Mapped[str] = mapped_column(String(8), nullable=False)
    seat_number: Mapped[str] = mapped_column(String(12), nullable=False)
    seat_type: Mapped[str] = mapped_column(String(16), default="LOWER")
    status: Mapped[str] = mapped_column(String(12), default=SEAT_AVAILABLE, nullable=False)
    reservation_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    held_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)

    # Optimistic-concurrency guard: counts increments prove the write really
    # moved the row out of AVAILABLE (never let inventory go negative).
    version: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class Reservation(Base):
    __tablename__ = "reservations"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    pnr: Mapped[str] = mapped_column(String(16), unique=True, nullable=False)
    schedule_id: Mapped[int] = mapped_column(ForeignKey("train_schedules.id"), nullable=False)
    travel_class: Mapped[str] = mapped_column(String(8), nullable=False)
    passenger_count: Mapped[int] = mapped_column(Integer, nullable=False)
    total_fare: Mapped[float] = mapped_column(Float, nullable=False)
    status: Mapped[str] = mapped_column(String(12), default=RESERVATION_HELD, nullable=False)
    seat_numbers: Mapped[list] = mapped_column(JSON, default=list)
    hold_expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    idempotency_key: Mapped[str] = mapped_column(String(80), unique=True, nullable=False)
    queue_token: Mapped[str | None] = mapped_column(String(32), nullable=True)
    contact_email: Mapped[str | None] = mapped_column(String(160), nullable=True)
    contact_phone: Mapped[str | None] = mapped_column(String(20), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    released_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    release_reason: Mapped[str | None] = mapped_column(String(60), nullable=True)
    is_simulation: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    schedule: Mapped[Schedule] = relationship(lazy="joined")
    passengers: Mapped[list["Passenger"]] = relationship(
        back_populates="reservation", cascade="all, delete-orphan", lazy="selectin"
    )


class Passenger(Base):
    __tablename__ = "passengers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    reservation_id: Mapped[str] = mapped_column(ForeignKey("reservations.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    age: Mapped[int] = mapped_column(Integer, nullable=False)
    gender: Mapped[str] = mapped_column(String(10), nullable=False)
    berth_preference: Mapped[str] = mapped_column(String(16), default="No Preference")
    seat_number: Mapped[str | None] = mapped_column(String(12), nullable=True)

    reservation: Mapped[Reservation] = relationship(back_populates="passengers")


class PaymentTransaction(Base):
    """Simulated payment gateway transaction (state machine)."""

    __tablename__ = "payment_transactions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    reference: Mapped[str] = mapped_column(String(24), unique=True, nullable=False)
    reservation_id: Mapped[str] = mapped_column(ForeignKey("reservations.id"), nullable=False)
    amount: Mapped[float] = mapped_column(Float, nullable=False)
    status: Mapped[str] = mapped_column(String(16), default=PAYMENT_INITIATED, nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(80), unique=True, nullable=False)
    gateway_ref: Mapped[str | None] = mapped_column(String(40), nullable=True)
    scenario: Mapped[str] = mapped_column(String(30), default="auto")
    attempt_count: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    # Never exposed through the API before reconciliation completes: the client
    # must not learn the "true" outcome while the payment is still unresolved.
    settled_outcome: Mapped[str | None] = mapped_column(String(16), nullable=True)
    resolve_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    reconciled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    reconciliation_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    failure_reason: Mapped[str | None] = mapped_column(String(120), nullable=True)
    message: Mapped[str | None] = mapped_column(String(200), nullable=True)
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    is_simulation: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    reservation: Mapped[Reservation] = relationship(lazy="joined")


class IdempotencyRecord(Base):
    """Generic idempotency ledger for POST endpoints."""

    __tablename__ = "idempotency_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    key: Mapped[str] = mapped_column(String(80), unique=True, nullable=False)
    scope: Mapped[str] = mapped_column(String(40), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    status_code: Mapped[int] = mapped_column(Integer, nullable=False)
    response_json: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class QueueEntry(Base):
    __tablename__ = "queue_entries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    token: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    request_key: Mapped[str] = mapped_column(String(80), unique=True, nullable=False)
    client_id: Mapped[str] = mapped_column(String(64), nullable=False)
    schedule_id: Mapped[int] = mapped_column(ForeignKey("train_schedules.id"), nullable=False)
    travel_class: Mapped[str] = mapped_column(String(8), nullable=False)
    passenger_count: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(12), default=QUEUE_WAITING, nullable=False)
    position_at_join: Mapped[int] = mapped_column(Integer, default=0)
    admitted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    note: Mapped[str | None] = mapped_column(String(160), nullable=True)
    is_synthetic: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    joined_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class SimulationRun(Base):
    __tablename__ = "simulation_runs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    scenario: Mapped[str] = mapped_column(String(40), nullable=False)
    mode: Mapped[str] = mapped_column(String(16), default="protected", nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="RUNNING", nullable=False)
    config: Mapped[dict] = mapped_column(JSON, default=dict)
    summary: Mapped[dict] = mapped_column(JSON, default=dict)
    schedule_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    progress: Mapped[int] = mapped_column(Integer, default=0)
    total_requests: Mapped[int] = mapped_column(Integer, default=0)
    seed: Mapped[int | None] = mapped_column(Integer, nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class SimulationEvent(Base):
    __tablename__ = "simulation_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("simulation_runs.id", ondelete="CASCADE"), nullable=False)
    seq: Mapped[int] = mapped_column(Integer, default=0)
    event_type: Mapped[str] = mapped_column(String(40), nullable=False)
    message: Mapped[str] = mapped_column(String(240), nullable=False)
    severity: Mapped[str] = mapped_column(String(12), default="info")
    latency_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)

    __table_args__ = (Index("ix_sim_event_run", "run_id", "id"),)


class AppEvent(Base):
    """Global event log powering the operations dashboard feed."""

    __tablename__ = "app_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    event_type: Mapped[str] = mapped_column(String(40), nullable=False)
    message: Mapped[str] = mapped_column(String(240), nullable=False)
    severity: Mapped[str] = mapped_column(String(12), default="info")
    request_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)

    __table_args__ = (Index("ix_app_event_time", "id", "created_at"),)


class SystemHealthEvent(Base):
    __tablename__ = "system_health_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    component: Mapped[str] = mapped_column(String(40), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    detail: Mapped[str | None] = mapped_column(String(240), nullable=True)
    simulated: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class MetricsSample(Base):
    """Periodic snapshot used for the dashboard time-series charts."""

    __tablename__ = "metrics_samples"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    bucket: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    requests: Mapped[int] = mapped_column(Integer, default=0)
    successful: Mapped[int] = mapped_column(Integer, default=0)
    failed: Mapped[int] = mapped_column(Integer, default=0)
    conflicts: Mapped[int] = mapped_column(Integer, default=0)
    duplicates_blocked: Mapped[int] = mapped_column(Integer, default=0)
    queue_depth: Mapped[int] = mapped_column(Integer, default=0)
    queue_admitted: Mapped[int] = mapped_column(Integer, default=0)
    rps: Mapped[float] = mapped_column(Float, default=0.0)
    avg_latency_ms: Mapped[float] = mapped_column(Float, default=0.0)
    p95_latency_ms: Mapped[float] = mapped_column(Float, default=0.0)
    payment_success: Mapped[int] = mapped_column(Integer, default=0)
    payment_failed: Mapped[int] = mapped_column(Integer, default=0)
    payment_pending: Mapped[int] = mapped_column(Integer, default=0)
    pending_reconciliations: Mapped[int] = mapped_column(Integer, default=0)
    seats_available: Mapped[int] = mapped_column(Integer, default=0)
    bookings_confirmed: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)

    __table_args__ = (Index("ix_metrics_bucket", "bucket"),)
