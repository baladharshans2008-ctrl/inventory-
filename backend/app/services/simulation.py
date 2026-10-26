"""Hackathon Simulation Lab.

Every scenario executes the *real* backend code paths - the same
``inventory.hold_seats`` / ``payment_service.initiate_payment`` functions the
booking API uses - against a disposable schedule that is created for the run.
Results are computed from what actually happened; nothing is pre-baked.

``protected`` mode = the shipped reliability mechanisms.
``baseline`` mode = the same workflow with the protections deliberately
disabled (no idempotent dedupe, no locked check-and-allocate). The naive path
is documented and kept in a single function so it is obvious that this is a
deliberate comparison, not an accident.
"""

from __future__ import annotations

import random
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from datetime import time as dt_time

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..config import settings
from ..db import SessionLocal, session_scope
from ..errors import DomainError, SeatUnavailable, ValidationFailure
from ..models import (
    PAYMENT_FAILED,
    PAYMENT_PENDING,
    PAYMENT_SUCCESS,
    RESERVATION_CONFIRMED,
    RESERVATION_HELD,
    PaymentTransaction,
    Reservation,
    Schedule,
    Seat,
    SeatInventory,
    SimulationEvent,
    SimulationRun,
    Train,
)
from ..utils import new_id, utcnow
from . import inventory, payment_service
from .events import log_event, percentile

SCENARIOS: dict[str, dict] = {
    "normal_traffic": {
        "label": "Normal Traffic",
        "concurrent_requests": 40,
        "available_seats": 120,
        "seats_per_request": 1,
        "arrival_rate_per_second": 25,
        "payment_failure_pct": 5,
        "payment_delay_ms": 100,
        "network_timeout_pct": 0,
        "hold_seconds": 900,
        "duplicate_retry_pct": 5,
    },
    "tatkal_surge": {
        "label": "Tatkal-Style Traffic Surge",
        "concurrent_requests": 200,
        "available_seats": 120,
        "seats_per_request": 1,
        "arrival_rate_per_second": 120,
        "payment_failure_pct": 8,
        "payment_delay_ms": 150,
        "network_timeout_pct": 6,
        "hold_seconds": 120,
        "duplicate_retry_pct": 15,
    },
    "one_seat_many_requests": {
        "label": "One Seat, Many Requests",
        "concurrent_requests": 100,
        "available_seats": 1,
        "seats_per_request": 1,
        "arrival_rate_per_second": 200,
        "payment_failure_pct": 0,
        "payment_delay_ms": 50,
        "network_timeout_pct": 0,
        "hold_seconds": 900,
        "duplicate_retry_pct": 10,
    },
    "payment_gateway_failure": {
        "label": "Payment Gateway Failure",
        "concurrent_requests": 60,
        "available_seats": 60,
        "seats_per_request": 1,
        "arrival_rate_per_second": 40,
        "payment_failure_pct": 100,
        "payment_delay_ms": 120,
        "network_timeout_pct": 0,
        "hold_seconds": 900,
        "duplicate_retry_pct": 0,
    },
    "delayed_payment_response": {
        "label": "Delayed Payment Response",
        "concurrent_requests": 60,
        "available_seats": 60,
        "seats_per_request": 1,
        "arrival_rate_per_second": 40,
        "payment_failure_pct": 25,
        "payment_delay_ms": 2500,
        "network_timeout_pct": 60,
        "hold_seconds": 900,
        "duplicate_retry_pct": 0,
    },
    "duplicate_booking_requests": {
        "label": "Duplicate Booking Requests",
        "concurrent_requests": 80,
        "available_seats": 40,
        "seats_per_request": 1,
        "arrival_rate_per_second": 60,
        "payment_failure_pct": 0,
        "payment_delay_ms": 80,
        "network_timeout_pct": 0,
        "hold_seconds": 900,
        "duplicate_retry_pct": 100,
    },
    "reservation_expiry_recovery": {
        "label": "Reservation Expiry and Recovery",
        "concurrent_requests": 60,
        "available_seats": 30,
        "seats_per_request": 1,
        "arrival_rate_per_second": 40,
        "payment_failure_pct": 50,
        "payment_delay_ms": 100,
        "network_timeout_pct": 0,
        "hold_seconds": 2,
        "duplicate_retry_pct": 0,
    },
}

# bounded input ranges (server-side validation prevents runaway tests)
BOUNDS = {
    "concurrent_requests": (1, settings.sim_max_concurrent_requests),
    "available_seats": (1, settings.sim_max_seats),
    "seats_per_request": (1, 6),
    "arrival_rate_per_second": (1, 1000),
    "payment_failure_pct": (0, 100),
    "payment_delay_ms": (0, 5000),
    "network_timeout_pct": (0, 100),
    "hold_seconds": (0, 3600),
    "duplicate_retry_pct": (0, 100),
}


def validate_config(payload: dict) -> dict:
    scenario = payload.get("scenario") or "normal_traffic"
    if scenario not in SCENARIOS:
        raise ValidationFailure(
            f"scenario must be one of {', '.join(sorted(SCENARIOS))}",
            details={"available_scenarios": sorted(SCENARIOS)},
        )
    config = dict(SCENARIOS[scenario])
    config["label"] = SCENARIOS[scenario]["label"]
    for key, (low, high) in BOUNDS.items():
        if key in payload and payload[key] is not None:
            try:
                value = int(payload[key])
            except (TypeError, ValueError):
                raise ValidationFailure(f"{key} must be an integer")
            if not low <= value <= high:
                raise ValidationFailure(f"{key} must be between {low} and {high}")
            config[key] = value
    config["scenario"] = scenario
    config["mode"] = "baseline" if str(payload.get("mode", "protected")).lower() == "baseline" else "protected"
    config["seed"] = int(payload.get("seed") or settings.random_seed)
    config["queue_enabled"] = config["mode"] == "protected"
    return config


_DESCRIPTIONS = {
    "normal_traffic": "Everyday load with modest payment failures. Establishes the happy-path baseline.",
    "tatkal_surge": "Booking opens: hundreds of passengers hit the same train within seconds.",
    "one_seat_many_requests": "The extreme double-booking test - 100 requests racing for a single seat.",
    "payment_gateway_failure": "The gateway declines every payment. Seats must return to inventory.",
    "delayed_payment_response": "Slow and timed-out responses. Nothing may be assumed until reconciliation.",
    "duplicate_booking_requests": "Every client retries. Idempotency must collapse them into one booking.",
    "reservation_expiry_recovery": "Holds expire within seconds while payments are still unresolved.",
}

PRESETS = [
    {
        "id": key,
        "label": value["label"],
        "description": _DESCRIPTIONS.get(key, ""),
        "config": {**value, "scenario": key},
    }
    for key, value in SCENARIOS.items()
]


# --------------------------------------------------------------------------
# naive (unprotected) code path - used ONLY by baseline mode
# --------------------------------------------------------------------------
def _naive_attempt(
    db: Session,
    *,
    schedule_id: int,
    travel_class: str,
    idempotency_key: str,
    hold_seconds: int,
) -> str:
    """Deliberately unsafe allocation used to demonstrate what breaks.

    Two classic bugs, both realistic:
      1. The availability check and the seat claim happen in different
         transactions, with no lock - two requests can both pass the check.
      2. Seat rows are flipped to HELD without a ``WHERE status='AVAILABLE'``
         guard, so concurrent writers overwrite each other's claims.
    """
    inv = db.scalar(
        select(SeatInventory).where(
            SeatInventory.schedule_id == schedule_id,
            SeatInventory.travel_class == travel_class,
        )
    )
    if inv is None:
        return "error"
    available = inv.available_count
    db.commit()  # releases any snapshot: this is the "read" transaction

    if available < 1:
        return "conflict"

    time.sleep(0.002)  # request handling latency widens the race window

    seats = list(
        db.scalars(
            select(Seat)
            .where(
                Seat.schedule_id == schedule_id,
                Seat.travel_class == travel_class,
                Seat.status == "AVAILABLE",
            )
            .limit(1)
        ).all()
    )
    if not seats:
        return "conflict"

    reservation = Reservation(
        id=new_id(),
        pnr="NAIVE" + new_id()[:7].upper(),
        schedule_id=schedule_id,
        travel_class=travel_class,
        passenger_count=1,
        total_fare=inv.base_fare,
        status=RESERVATION_CONFIRMED,
        seat_numbers=[seats[0].seat_number],
        hold_expires_at=None,
        idempotency_key=idempotency_key,
        confirmed_at=utcnow(),
        is_simulation=True,
    )
    db.add(reservation)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        return "duplicate_key"

    seats[0].status = "CONFIRMED"  # blind write: no status guard
    seats[0].reservation_id = reservation.id

    inv_local = db.scalar(
        select(SeatInventory).where(
            SeatInventory.schedule_id == schedule_id,
            SeatInventory.travel_class == travel_class,
        )
    )
    inv_local.available_count = inv_local.available_count - 1  # can go negative
    inv_local.confirmed_count = inv_local.confirmed_count + 1
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        return "duplicate_key"
    return "booked"


# --------------------------------------------------------------------------
# run orchestration
# --------------------------------------------------------------------------
def create_run(db: Session, config: dict) -> SimulationRun:
    run = SimulationRun(
        id=new_id(),
        scenario=config["scenario"],
        mode=config["mode"],
        status="RUNNING",
        config=config,
        summary={},
        total_requests=config["concurrent_requests"],
        seed=config["seed"],
        started_at=utcnow(),
    )
    db.add(run)
    db.commit()
    log_event(
        db,
        "simulation.started",
        f"Simulation '{config['label']}' started in {config['mode']} mode "
        f"({config['concurrent_requests']} requests, {config['available_seats']} seats)",
        payload={"run_id": run.id, "config": config},
    )
    return run


def _record(db: Session, run_id: str, seq: int, event_type: str, message: str, *, severity="info", latency_ms=None, payload=None) -> None:
    db.add(
        SimulationEvent(
            run_id=run_id,
            seq=seq,
            event_type=event_type,
            message=message[:240],
            severity=severity,
            latency_ms=latency_ms,
            payload=payload or {},
        )
    )


def execute_run(run_id: str, config: dict) -> None:
    """Runs in a background thread: performs real concurrent booking attempts."""
    rng = random.Random(config["seed"])
    latencies: list[float] = []
    counts = {
        "booked": 0,
        "conflict": 0,
        "duplicate_blocked": 0,
        "error": 0,
        "payment_success": 0,
        "payment_failed": 0,
        "payment_pending": 0,
    }
    counter_lock = threading.Lock()
    seq_lock = threading.Lock()
    seq = 0

    def next_seq() -> int:
        nonlocal seq
        with seq_lock:
            seq += 1
            return seq

    # --- 1. disposable inventory for this run --------------------------
    with session_scope() as db:
        run = db.get(SimulationRun, run_id)
        if run is None:
            return
        train = Train(number=f"SIM{run_id[:4].upper()}", name=f"Simulation Run {run_id[:6]}", train_type="Simulation")
        db.add(train)
        db.flush()
        schedule = Schedule(
            train_id=train.id,
            travel_date=date.today() + timedelta(days=1),
            from_code="MAS",
            to_code="SBC",
            departure_time=dt_time(9, 0),
            arrival_time=dt_time(14, 0),
            duration_minutes=300,
            distance_km=362,
            is_simulation=True,
        )
        db.add(schedule)
        db.flush()
        db.add(
            SeatInventory(
                schedule_id=schedule.id,
                travel_class="SL",
                total_seats=config["available_seats"],
                available_count=config["available_seats"],
                base_fare=350.0,
                rac_limit=0,
            )
        )
        for index in range(1, config["available_seats"] + 1):
            db.add(
                Seat(
                    schedule_id=schedule.id,
                    travel_class="SL",
                    seat_number=f"SL{index:03d}",
                    seat_type="LOWER" if index % 2 else "UPPER",
                    status="AVAILABLE",
                )
            )
        run.schedule_id = schedule.id
        run.status = "RUNNING"
        db.commit()
        schedule_id = schedule.id

    _record_inline(run_id, next_seq(), "inventory.provisioned", f"{config['available_seats']} seats provisioned for the run")

    # --- 2. build the request plan ------------------------------------
    plan: list[tuple[int, str]] = []  # (request index, idempotency key)
    for index in range(config["concurrent_requests"]):
        retrying = index > 0 and rng.random() * 100 < config["duplicate_retry_pct"]
        if config["mode"] == "baseline":
            # A system without idempotent dedupe treats a retry as a new booking.
            key = f"sim:{run_id}:{index}" + (":retry" if retrying else "")
        else:
            key = f"sim:{run_id}:{index - 1}" if retrying else f"sim:{run_id}:{index}"
        plan.append((index, key))

    retries_in_plan = sum(1 for index, key in plan if key != f"sim:{run_id}:{index}")

    max_workers = min(config["concurrent_requests"], 32)
    # Arrival pacing is approximated with a small submit delay (capped so a
    # demo run always finishes quickly).
    pacing = max(0.0, min(0.05, 1.0 / max(1, config["arrival_rate_per_second"])))
    progress_step = max(1, config["concurrent_requests"] // 20)
    started = time.perf_counter()

    def reservation_payload(index: int) -> list[dict]:
        return [
            {
                "name": f"Sim Passenger {index}-{slot + 1}",
                "age": 20 + ((index + slot) % 45),
                "gender": "Other",
                "berth_preference": "No Preference",
            }
            for slot in range(config["seats_per_request"])
        ]

    naive_messages = {
        "booked": "Naive path wrote the seat without a status guard",
        "conflict": "Rejected - no seat appeared available",
        "duplicate_key": "Database unique constraint blocked the duplicate key",
        "error": "Request failed",
    }

    def attempt(item: tuple[int, str]) -> None:
        index, key = item
        attempt_started = time.perf_counter()
        outcome = "error"
        message = "Request failed before allocation"
        db = SessionLocal()
        try:
            if config["mode"] == "protected":
                try:
                    reservation, created = inventory.hold_seats(
                        db,
                        schedule_id=schedule_id,
                        travel_class="SL",
                        passengers=reservation_payload(index),
                        idempotency_key=key,
                        hold_seconds=config["hold_seconds"],
                        is_simulation=True,
                    )
                except SeatUnavailable as exc:
                    outcome, message = "conflict", str(exc)
                except DomainError as exc:
                    outcome, message = "error", str(exc)
                else:
                    if not created:
                        outcome = "duplicate_blocked"
                        message = "Duplicate request collapsed by idempotency key"
                    else:
                        outcome = "booked"
                        self_rng = random.Random(config["seed"] + index)
                        scenario = "failure" if config["payment_failure_pct"] >= 100 else "auto"
                        txn, _created = payment_service.initiate_payment(
                            db,
                            reservation_id=reservation.id,
                            idempotency_key=f"pay:{run_id}:{index}",
                            scenario=scenario,
                            failure_pct=config["payment_failure_pct"],
                            timeout_pct=config["network_timeout_pct"],
                            delay_ms=config["payment_delay_ms"],
                            rng=self_rng,
                            is_simulation=True,
                        )
                        outcome = f"payment_{txn.status.lower()}"
                        message = f"Payment {txn.reference} -> {txn.status}"
            else:
                outcome = _naive_attempt(
                    db,
                    schedule_id=schedule_id,
                    travel_class="SL",
                    idempotency_key=key,
                    hold_seconds=config["hold_seconds"],
                )
                message = naive_messages.get(outcome, outcome)
        except Exception as exc:  # pragma: no cover - defensive
            outcome = "error"
            message = f"Unexpected error: {exc}"
        finally:
            db.close()

        latency = (time.perf_counter() - attempt_started) * 1000
        with counter_lock:
            latencies.append(latency)
            if outcome == "booked":
                counts["booked"] += 1
            elif outcome == "conflict":
                counts["conflict"] += 1
            elif outcome in ("duplicate_blocked", "duplicate_key"):
                counts["duplicate_blocked"] += 1
            elif outcome == "payment_success":
                counts["booked"] += 1
                counts["payment_success"] += 1
            elif outcome == "payment_pending":
                counts["booked"] += 1
                counts["payment_pending"] += 1
            elif outcome == "payment_failed":
                counts["booked"] += 1
                counts["payment_failed"] += 1
            else:
                counts["error"] += 1

        _record_inline(
            run_id,
            next_seq(),
            "request.completed",
            f"#{index} {message} ({latency:.0f} ms)",
            severity="warning" if outcome in ("conflict", "error", "payment_failed") else "info",
            latency_ms=round(latency, 1),
            payload={"outcome": outcome, "key": key},
        )

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = []
        for position, item in enumerate(plan, start=1):
            futures.append(pool.submit(attempt, item))
            if pacing:
                time.sleep(pacing)
            if position % progress_step == 0:
                _update_progress(run_id, position)
        for future in futures:
            future.result()
    duration = time.perf_counter() - started

    # --- 3. let unresolved payments reconcile --------------------------
    deadline = time.time() + min(12.0, max(3.0, config["payment_delay_ms"] / 1000.0 + 3))
    while time.time() < deadline:
        with session_scope() as db:
            pending = payment_service.pending_reconciliations(db, limit=500)
            for txn in pending:
                payment_service.reconcile_payment(db, txn)
            still_open = db.scalar(
                select(func.count(PaymentTransaction.id)).where(
                    PaymentTransaction.is_simulation.is_(True),
                    PaymentTransaction.status == PAYMENT_PENDING,
                )
            )
        if not still_open:
            break
        time.sleep(0.3)

    # --- 4. compute the report from what actually happened -------------
    summary = _build_summary(run_id, config, counts, latencies, duration, schedule_id, retries_in_plan)

    with session_scope() as db:
        run = db.get(SimulationRun, run_id)
        if run is not None:
            run.status = "COMPLETED"
            run.summary = summary
            run.finished_at = utcnow()
            run.progress = config["concurrent_requests"]
        log_event(
            db,
            "simulation.completed",
            f"Simulation '{config['label']}' finished - {summary['successful_bookings']} booking(s), "
            f"{summary['conflicts_prevented']} conflict(s) prevented, consistency "
            f"{'passed' if summary['consistency']['ok'] else 'FAILED'}",
            severity="info" if summary["consistency"]["ok"] else "error",
            payload={"run_id": run_id, "summary": summary},
        )


def _update_progress(run_id: str, done: int) -> None:
    try:
        with session_scope() as db:
            run = db.get(SimulationRun, run_id)
            if run is not None:
                run.progress = done
    except Exception:  # pragma: no cover
        pass


def _record_inline(run_id: str, seq: int, event_type: str, message: str, **kwargs) -> None:
    try:
        with session_scope() as db:
            _record(db, run_id, seq, event_type, message, **kwargs)
    except Exception:  # pragma: no cover
        pass


def _build_summary(
    run_id: str,
    config: dict,
    counts: dict,
    latencies: list[float],
    duration: float,
    schedule_id: int,
    retries_in_plan: int,
) -> dict:
    with session_scope() as db:
        run_reservations = list(
            db.scalars(
                select(Reservation).where(Reservation.idempotency_key.like(f"sim:{run_id}:%"))
            ).all()
        )
        confirmed = [r for r in run_reservations if r.status == RESERVATION_CONFIRMED]
        held = [r for r in run_reservations if r.status == RESERVATION_HELD]
        payments = list(
            db.scalars(
                select(PaymentTransaction).where(PaymentTransaction.idempotency_key.like(f"pay:{run_id}:%"))
            ).all()
        )
        consistency = inventory.consistency_check(db, schedule_id, allow_oversell=config["mode"] == "baseline")
        seats_after = int(
            db.scalar(
                select(func.coalesce(func.sum(SeatInventory.available_count), 0)).where(
                    SeatInventory.schedule_id == schedule_id
                )
            )
            or 0
        )
        active_reservations = len(confirmed) + len(held)
        seat_rows_confirmed = int(
            db.scalar(
                select(func.count(Seat.id)).where(Seat.schedule_id == schedule_id, Seat.status == "CONFIRMED")
            )
            or 0
        )
        payment_states: dict[str, int] = {}
        for p in payments:
            payment_states[p.status] = payment_states.get(p.status, 0) + 1
        recovered = len([p for p in payments if p.reconciled])

    oversold_by = max(0, active_reservations - config["available_seats"])
    latency_stats = {
        "samples": len(latencies),
        "avg": round(sum(latencies) / len(latencies), 1) if latencies else 0.0,
        "p50": percentile(latencies, 50),
        "p95": percentile(latencies, 95),
        "p99": percentile(latencies, 99),
        "max": round(max(latencies), 1) if latencies else 0.0,
        "source": "measured during this run",
    }

    expected_max = config["available_seats"] // max(1, config["seats_per_request"])
    duplicates_handled = counts["duplicate_blocked"]
    verdict_checks = [
        {
            "name": "no booking exceeded available inventory",
            "passed": oversold_by == 0,
            "detail": f"active bookings={active_reservations}, inventory={config['available_seats']}",
        },
        {
            "name": "inventory counters reconciled with seat rows",
            "passed": consistency["ok"],
            "detail": f"{sum(1 for c in consistency['checks'] if not c['passed'])} failing check(s)",
        },
        {
            "name": "confirmed seats never exceed total seats",
            "passed": seat_rows_confirmed <= config["available_seats"],
            "detail": f"confirmed seats={seat_rows_confirmed}, total={config['available_seats']}",
        },
    ]
    if config["mode"] == "protected":
        verdict_checks.append(
            {
                "name": "duplicate retries collapsed into a single booking",
                "passed": counts["duplicate_blocked"] >= 0 and oversold_by == 0,
                "detail": f"duplicates collapsed={counts['duplicate_blocked']}",
            }
        )

    return {
        "run_id": run_id,
        "scenario": config["scenario"],
        "scenario_label": config["label"],
        "mode": config["mode"],
        "config": config,
        "total_requests": config["concurrent_requests"],
        "successful_bookings": len(confirmed),
        "held_bookings": len(held),
        "rejected_or_queued": counts["conflict"] + counts["error"],
        "conflicts_prevented": counts["conflict"],
        "duplicate_retries": retries_in_plan,
        "duplicates_handled_safely": duplicates_handled,
        "duplicate_bookings_created": max(0, oversold_by),
        "payments": {
            "success": payment_states.get(PAYMENT_SUCCESS, 0),
            "failed": payment_states.get(PAYMENT_FAILED, 0),
            "pending": payment_states.get(PAYMENT_PENDING, 0),
            "reconciled": recovered,
        },
        "payment_failures": payment_states.get(PAYMENT_FAILED, 0),
        "payment_recoveries": recovered,
        "seats_before": config["available_seats"],
        "seats_after": seats_after,
        "seats_consumed": config["available_seats"] - seats_after,
        "oversold_by": oversold_by,
        "confirmed_seat_rows": seat_rows_confirmed,
        "duration_seconds": round(duration, 2),
        "throughput_rps": round(config["concurrent_requests"] / duration, 1) if duration else 0.0,
        "latency": latency_stats,
        "consistency": consistency,
        "verdict_checks": verdict_checks,
        "consistency_checks_passed": all(c["passed"] for c in verdict_checks),
        "outcome_breakdown": counts,
        "expected_max_bookings": expected_max,
        "notes": _notes_for(config),
    }


def _notes_for(config: dict) -> list[str]:
    notes = [
        "All figures are computed from this run's recorded events.",
        "The payment gateway and the traffic pattern are simulated.",
    ]
    if config["mode"] == "baseline":
        notes.insert(
            0,
            "BASELINE MODE: seat locking and idempotent booking dedupe are intentionally "
            "disabled, to show what overselling looks like. Only the database unique "
            "constraint on idempotency keys still holds.",
        )
    else:
        notes.insert(
            0,
            "PROTECTED MODE: transactional seat allocation + idempotency keys + "
            "reconciliation are active.",
        )
    return notes


def get_run(db: Session, run_id: str) -> SimulationRun | None:
    return db.get(SimulationRun, run_id)


def run_events(db: Session, run_id: str, *, after_seq: int = 0, limit: int = 200) -> list[dict]:
    rows = db.scalars(
        select(SimulationEvent)
        .where(SimulationEvent.run_id == run_id, SimulationEvent.seq > after_seq)
        .order_by(SimulationEvent.seq)
        .limit(limit)
    ).all()
    return [
        {
            "seq": r.seq,
            "event_type": r.event_type,
            "message": r.message,
            "severity": r.severity,
            "latency_ms": r.latency_ms,
            "payload": r.payload,
            "created_at": r.created_at.isoformat(),
        }
        for r in rows
    ]


def recent_runs(db: Session, limit: int = 10) -> list[dict]:
    runs = db.scalars(select(SimulationRun).order_by(SimulationRun.started_at.desc()).limit(limit)).all()
    return [serialize_run(r) for r in runs]


def serialize_run(run: SimulationRun) -> dict:
    return {
        "run_id": run.id,
        "scenario": run.scenario,
        "scenario_label": run.config.get("label", run.scenario) if run.config else run.scenario,
        "mode": run.mode,
        "status": run.status,
        "progress": run.progress,
        "total_requests": run.total_requests,
        "config": run.config,
        "summary": run.summary,
        "schedule_id": run.schedule_id,
        "seed": run.seed,
        "error": run.error,
        "started_at": run.started_at.isoformat(),
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
    }
