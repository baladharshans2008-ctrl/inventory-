"""Automated correctness suite (Tests A-G from the specification).

These functions call the *same* service layer used by the booking API, so the
numbers they report are produced by the real system. They are exposed through
``POST /api/simulations/correctness`` for the simulation lab and are also
executed by ``backend/tests/test_reliability.py`` under pytest.
"""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from datetime import time as dt_time

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import SessionLocal, session_scope
from ..errors import DomainError, SeatUnavailable
from ..models import (
    PAYMENT_FAILED,
    PAYMENT_PENDING,
    PAYMENT_SUCCESS,
    RESERVATION_CONFIRMED,
    RESERVATION_HELD,
    PaymentTransaction,
    Reservation,
    Seat,
    SeatInventory,
    Train,
)
from ..seed import provision_schedule
from ..utils import new_id, utcnow
from . import inventory, payment_service


def _passenger(index: int = 0) -> dict:
    return {"name": f"Test Passenger {index}", "age": 30, "gender": "Other"}


def _provision(seats: int, *, classes: list[str] | None = None) -> int:
    """Create an isolated schedule for one test."""
    with session_scope() as db:
        train = Train(number=f"TST{new_id()[:6].upper()}", name="Correctness Test Train", train_type="Test")
        db.add(train)
        db.flush()
        schedule = provision_schedule(
            db,
            train=train,
            travel_date=date.today() + timedelta(days=2),
            from_code="MAS",
            to_code="SBC",
            departure=dt_time(6, 0),
            arrival=dt_time(12, 0),
            duration_minutes=360,
            distance_km=362,
            classes=classes or ["SL"],
            capacity_override={"SL": seats, "3A": seats, "2A": seats},
            is_simulation=True,
        )
        return schedule.id


def _run_concurrent(worker, request_count: int, *, max_workers: int = 32) -> list:
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        return [f.result() for f in [pool.submit(worker, i) for i in range(request_count)]]


def _hold_worker(schedule_id: int, prefix: str):
    def worker(index: int) -> str:
        db = SessionLocal()
        try:
            inventory.hold_seats(
                db,
                schedule_id=schedule_id,
                travel_class="SL",
                passengers=[_passenger(index)],
                idempotency_key=f"{prefix}:{index}",
                hold_seconds=600,
                is_simulation=True,
            )
            return "held"
        except SeatUnavailable:
            return "conflict"
        except DomainError:
            return "error"
        finally:
            db.close()

    return worker


def _result(test_id: str, name: str, goal: str, passed: bool, expected: str, actual: str, **extra) -> dict:
    return {
        "id": test_id,
        "name": name,
        "goal": goal,
        "passed": passed,
        "expected": expected,
        "actual": actual,
        "duration_ms": round(extra.pop("duration_ms", 0.0), 1),
        **extra,
    }


# --------------------------------------------------------------------------
# Test A - overselling under concurrent load
# --------------------------------------------------------------------------
def test_a_overselling(seats: int = 10, requests: int = 100) -> dict:
    t0 = time.perf_counter()
    schedule_id = _provision(seats)
    prefix = f"testA:{new_id()[:6]}"
    outcomes = _run_concurrent(_hold_worker(schedule_id, prefix), requests)

    with session_scope() as db:
        held = int(
            db.scalar(
                select(func.count(Reservation.id)).where(
                    Reservation.idempotency_key.like(f"{prefix}:%"),
                    Reservation.status == RESERVATION_HELD,
                )
            )
            or 0
        )
        inv = db.scalar(
            select(SeatInventory).where(SeatInventory.schedule_id == schedule_id, SeatInventory.travel_class == "SL")
        )
        consistency = inventory.consistency_check(db, schedule_id)
        available = inv.available_count
        held_rows = inv.held_count

    passed = held <= seats and held_rows == held and available == seats - held and available >= 0 and consistency["ok"]
    return _result(
        "A",
        "Overselling prevention",
        f"{requests} concurrent requests compete for {seats} seats",
        passed,
        f"at most {seats} seats reserved, counters consistent",
        f"{held} reservation(s) held, {available} remaining, {outcomes.count('conflict')} conflict(s) returned",
        duration_ms=(time.perf_counter() - t0) * 1000,
        schedule_id=schedule_id,
        outcomes={"held": outcomes.count("held"), "conflict": outcomes.count("conflict"), "error": outcomes.count("error")},
        consistency=consistency,
    )


# --------------------------------------------------------------------------
# Test B - single seat race
# --------------------------------------------------------------------------
def test_b_single_seat_race(requests: int = 100) -> dict:
    t0 = time.perf_counter()
    schedule_id = _provision(1)
    prefix = f"testB:{new_id()[:6]}"
    outcomes = _run_concurrent(_hold_worker(schedule_id, prefix), requests)

    with session_scope() as db:
        held = int(
            db.scalar(
                select(func.count(Reservation.id)).where(
                    Reservation.idempotency_key.like(f"{prefix}:%"),
                    Reservation.status == RESERVATION_HELD,
                )
            )
            or 0
        )
        seat_owners = db.execute(
            select(Seat.reservation_id).where(Seat.schedule_id == schedule_id, Seat.travel_class == "SL")
        ).all()
        owners = {row[0] for row in seat_owners if row[0]}
        consistency = inventory.consistency_check(db, schedule_id)

    passed = held == 1 and len(owners) == 1 and consistency["ok"] and outcomes.count("held") == 1
    return _result(
        "B",
        "Single-seat race",
        f"{requests} concurrent requests compete for the same single seat",
        passed,
        "exactly 1 successful hold, 1 seat owner",
        f"{outcomes.count('held')} successful hold(s), {len(owners)} seat owner(s), "
        f"{outcomes.count('conflict')} conflict(s)",
        duration_ms=(time.perf_counter() - t0) * 1000,
        schedule_id=schedule_id,
        consistency=consistency,
    )


# --------------------------------------------------------------------------
# Test C - duplicate booking requests
# --------------------------------------------------------------------------
def test_c_duplicate_booking(attempts: int = 20) -> dict:
    t0 = time.perf_counter()
    schedule_id = _provision(10)
    key = f"testC:{new_id()[:6]}"
    reservation_ids: list[str] = []
    lock = threading.Lock()

    def worker(index: int) -> str:
        db = SessionLocal()
        try:
            reservation, created = inventory.hold_seats(
                db,
                schedule_id=schedule_id,
                travel_class="SL",
                passengers=[_passenger(index)],
                idempotency_key=key,
                hold_seconds=600,
                is_simulation=True,
            )
            with lock:
                reservation_ids.append(reservation.id)
            return "created" if created else "replayed"
        except DomainError as exc:
            return f"error:{exc}"
        finally:
            db.close()

    outcomes = _run_concurrent(worker, attempts)

    with session_scope() as db:
        rows = int(
            db.scalar(select(func.count(Reservation.id)).where(Reservation.idempotency_key == key)) or 0
        )
        passengers = db.scalar(
            select(func.count(func.distinct(Reservation.id))).where(Reservation.idempotency_key == key)
        )
        inventory_row = db.scalar(
            select(SeatInventory).where(SeatInventory.schedule_id == schedule_id, SeatInventory.travel_class == "SL")
        )
        consistency = inventory.consistency_check(db, schedule_id)

    passed = (
        rows == 1
        and passengers == 1
        and len(set(reservation_ids)) == 1
        and outcomes.count("created") == 1
        and inventory_row.held_count == 1
        and consistency["ok"]
    )
    return _result(
        "C",
        "Duplicate booking prevention",
        f"{attempts} identical requests submitted with the same idempotency key",
        passed,
        "exactly 1 logical booking, 1 seat held",
        f"{rows} reservation row(s), {outcomes.count('created')} created / "
        f"{outcomes.count('replayed')} replayed, {inventory_row.held_count} seat(s) held",
        duration_ms=(time.perf_counter() - t0) * 1000,
        schedule_id=schedule_id,
        consistency=consistency,
    )


# --------------------------------------------------------------------------
# Test D - payment timeout must be reconciled, never guessed
# --------------------------------------------------------------------------
def test_d_payment_timeout() -> dict:
    t0 = time.perf_counter()
    schedule_id = _provision(5)
    booking_key = f"testD:{new_id()[:6]}"
    payment_key = f"{booking_key}:pay"

    with session_scope() as db:
        reservation, _ = inventory.hold_seats(
            db,
            schedule_id=schedule_id,
            travel_class="SL",
            passengers=[_passenger()],
            idempotency_key=booking_key,
            hold_seconds=600,
            is_simulation=True,
        )
        reservation_id = reservation.id
        txn, _ = payment_service.initiate_payment(
            db,
            reservation_id=reservation_id,
            idempotency_key=payment_key,
            scenario="timeout",
            delay_ms=1500,
            timeout_pct=100,
            failure_pct=0,
            is_simulation=True,
        )
        txn_id = txn.id
        pending_status = txn.status

    # The client sees a timeout. It must NOT be treated as a failure.
    with session_scope() as db:
        retried, created = payment_service.initiate_payment(
            db,
            reservation_id=reservation_id,
            idempotency_key=payment_key,
            scenario="timeout",
            delay_ms=0,
            is_simulation=True,
        )
        duplicate_created = created
        payment_rows = int(
            db.scalar(select(func.count(PaymentTransaction.id)).where(PaymentTransaction.idempotency_key == payment_key))
            or 0
        )
        reservation_after_retry = db.get(Reservation, reservation_id)
        retry_status = reservation_after_retry.status
        same_id = retried.id == txn_id

        # Reconcile too early: must stay unresolved, booking unchanged.
        early = payment_service.reconcile_payment(db, retried)
        early_status = early.status
        early_booking = db.get(Reservation, reservation_id).status

    # Wait for the gateway's published resolution time, then reconcile.
    time.sleep(1.8)
    with session_scope() as db:
        txn = db.get(PaymentTransaction, txn_id)
        settled = txn.settled_outcome
        resolved = payment_service.reconcile_payment(db, txn)
        final_payment = resolved.status
        final_booking = db.get(Reservation, reservation_id).status

    expected_booking = RESERVATION_CONFIRMED if settled == PAYMENT_SUCCESS else "EXPIRED"
    passed = (
        pending_status == PAYMENT_PENDING
        and not duplicate_created
        and same_id
        and payment_rows == 1
        and retry_status == RESERVATION_HELD
        and early_status in (PAYMENT_PENDING, "RECONCILING")
        and early_booking == RESERVATION_HELD
        and final_payment == settled
        and final_booking == expected_booking
    )
    return _result(
        "D",
        "Payment timeout reconciliation",
        "Client-side timeout with an initially unknown gateway result",
        passed,
        "PENDING until reconciled; booking follows the authoritative outcome",
        f"pending={pending_status}, duplicate payment rows={payment_rows}, "
        f"early reconcile kept booking {early_booking}, final {final_payment} -> booking {final_booking}",
        duration_ms=(time.perf_counter() - t0) * 1000,
        schedule_id=schedule_id,
        settled_outcome=settled,
    )


# --------------------------------------------------------------------------
# Test E - reservation expiry releases the seat exactly once
# --------------------------------------------------------------------------
def test_e_reservation_expiry() -> dict:
    t0 = time.perf_counter()
    schedule_id = _provision(6)
    prefix = f"testE:{new_id()[:6]}"

    with session_scope() as db:
        expiring, _ = inventory.hold_seats(
            db,
            schedule_id=schedule_id,
            travel_class="SL",
            passengers=[_passenger(1), _passenger(2)],
            idempotency_key=f"{prefix}:expiring",
            hold_seconds=0,  # already expired
            is_simulation=True,
        )
        confirmed, _ = inventory.hold_seats(
            db,
            schedule_id=schedule_id,
            travel_class="SL",
            passengers=[_passenger(3)],
            idempotency_key=f"{prefix}:confirmed",
            hold_seconds=600,
            is_simulation=True,
        )
        inventory.confirm_reservation(db, confirmed, reason="payment_success")
        expiring_id, confirmed_id = expiring.id, confirmed.id

    with session_scope() as db:
        first_sweep = inventory.expire_reservations(db, limit=50)
        available_after_first = db.scalar(
            select(SeatInventory.available_count).where(
                SeatInventory.schedule_id == schedule_id, SeatInventory.travel_class == "SL"
            )
        )
        second_sweep = inventory.expire_reservations(db, limit=50)
        confirmations_untouched = db.get(Reservation, confirmed_id).status
        released_again = db.get(Reservation, expiring_id).status
        confirmed_seats = int(
            db.scalar(
                select(func.count(Seat.id)).where(
                    Seat.schedule_id == schedule_id, Seat.status == "CONFIRMED"
                )
            )
            or 0
        )
        consistency = inventory.consistency_check(db, schedule_id)

    passed = (
        expiring_id in first_sweep
        and len(second_sweep) == 0
        and available_after_first == 5  # 6 seats - 1 confirmed seat still held
        and confirmations_untouched == RESERVATION_CONFIRMED
        and confirmed_seats == 1
        and released_again == "EXPIRED"
        and consistency["ok"]
    )
    return _result(
        "E",
        "Reservation expiry & inventory recovery",
        "An expired hold releases exactly once; confirmed seats are never released",
        passed,
        "2 seats released once, confirmed seat untouched",
        f"first sweep released {len(first_sweep)} hold(s), second sweep released {len(second_sweep)}; "
        f"available={available_after_first}; confirmed booking still {confirmations_untouched}; "
        f"confirmed seat rows={confirmed_seats}",
        duration_ms=(time.perf_counter() - t0) * 1000,
        schedule_id=schedule_id,
        consistency=consistency,
    )


# --------------------------------------------------------------------------
# Test F - inventory consistency
# --------------------------------------------------------------------------
def test_f_inventory_consistency() -> dict:
    t0 = time.perf_counter()
    schedule_id = _provision(20)
    prefix = f"testF:{new_id()[:6]}"

    with session_scope() as db:
        for index in range(5):
            inventory.hold_seats(
                db,
                schedule_id=schedule_id,
                travel_class="SL",
                passengers=[_passenger(index)],
                idempotency_key=f"{prefix}:hold:{index}",
                hold_seconds=600,
                is_simulation=True,
            )
        to_confirm, _ = inventory.hold_seats(
            db,
            schedule_id=schedule_id,
            travel_class="SL",
            passengers=[_passenger(9)],
            idempotency_key=f"{prefix}:confirm",
            hold_seconds=600,
            is_simulation=True,
        )
        inventory.confirm_reservation(db, to_confirm, reason="payment_success")
        to_release, _ = inventory.hold_seats(
            db,
            schedule_id=schedule_id,
            travel_class="SL",
            passengers=[_passenger(10)],
            idempotency_key=f"{prefix}:release",
            hold_seconds=600,
            is_simulation=True,
        )
        inventory.release_reservation(db, to_release, reason="payment_failed")

    with session_scope() as db:
        inv = db.scalar(
            select(SeatInventory).where(SeatInventory.schedule_id == schedule_id, SeatInventory.travel_class == "SL")
        )
        by_status = dict(
            db.execute(
                select(Seat.status, func.count(Seat.id))
                .where(Seat.schedule_id == schedule_id, Seat.travel_class == "SL")
                .group_by(Seat.status)
            ).all()
        )
        consistency = inventory.consistency_check(db, schedule_id)
        total = inv.total_seats
        sum_counters = inv.available_count + inv.held_count + inv.confirmed_count
        available, held, confirmed = inv.available_count, inv.held_count, inv.confirmed_count

    passed = consistency["ok"] and sum_counters == total and held == by_status.get("HELD", 0) and confirmed == 1
    return _result(
        "F",
        "Inventory consistency",
        "available + held + confirmed must reconcile with total inventory and seat rows",
        passed,
        "counters equal seat rows; sum equals total seats",
        f"total={total}, available={available}, held={held}, confirmed={confirmed}, sum={sum_counters}",
        duration_ms=(time.perf_counter() - t0) * 1000,
        schedule_id=schedule_id,
        consistency=consistency,
    )


# --------------------------------------------------------------------------
# Test G - failure recovery
# --------------------------------------------------------------------------
def test_g_failure_recovery() -> dict:
    t0 = time.perf_counter()
    schedule_id = _provision(4)
    booking_key = f"testG:{new_id()[:6]}"

    # 1. A booking is held, then the request pipeline dies before payment
    #    (session closed abruptly - the equivalent of a service interruption).
    db = SessionLocal()
    reservation, _ = inventory.hold_seats(
        db,
        schedule_id=schedule_id,
        travel_class="SL",
        passengers=[_passenger(1), _passenger(2)],
        idempotency_key=booking_key,
        hold_seconds=0,  # hold already lapsed -> simulates the stalled request
        is_simulation=True,
    )
    reservation_id = reservation.id
    db.close()  # simulated interruption: no payment, no confirmation

    # 2. The client retries the very same request.
    with session_scope() as db:
        retried, created = inventory.hold_seats(
            db,
            schedule_id=schedule_id,
            travel_class="SL",
            passengers=[_passenger(1), _passenger(2)],
            idempotency_key=booking_key,
            hold_seconds=600,
            is_simulation=True,
        )
        duplicate_rows = int(
            db.scalar(select(func.count(Reservation.id)).where(Reservation.idempotency_key == booking_key)) or 0
        )
        same_reservation = retried.id == reservation_id

        # 3. Recovery worker returns the abandoned hold to inventory.
        released = inventory.expire_reservations(db, limit=50)
        after_recovery = db.scalar(
            select(SeatInventory.available_count).where(
                SeatInventory.schedule_id == schedule_id, SeatInventory.travel_class == "SL"
            )
        )
        consistency = inventory.consistency_check(db, schedule_id)

        # 4. The recovered inventory is genuinely usable again.
        fresh, _ = inventory.hold_seats(
            db,
            schedule_id=schedule_id,
            travel_class="SL",
            passengers=[_passenger(7)],
            idempotency_key=f"{booking_key}:after",
            hold_seconds=600,
            is_simulation=True,
        )
        fresh_ok = fresh.status == RESERVATION_HELD

    passed = (
        duplicate_rows == 1
        and same_reservation
        and len(released) >= 1
        and after_recovery == 4
        and consistency["ok"]
        and fresh_ok
    )
    return _result(
        "G",
        "Failure recovery",
        "An interrupted booking request must not duplicate bookings or corrupt inventory",
        passed,
        "1 logical booking, inventory fully recovered and reusable",
        f"reservation rows={duplicate_rows}, same reservation on retry={same_reservation}, "
        f"released={len(released)}, available after recovery={after_recovery}, "
        f"consistency={'ok' if consistency['ok'] else 'failed'}",
        duration_ms=(time.perf_counter() - t0) * 1000,
        schedule_id=schedule_id,
        consistency=consistency,
    )


SUITE = [
    ("A", test_a_overselling),
    ("B", test_b_single_seat_race),
    ("C", test_c_duplicate_booking),
    ("D", test_d_payment_timeout),
    ("E", test_e_reservation_expiry),
    ("F", test_f_inventory_consistency),
    ("G", test_g_failure_recovery),
]


def run_suite(*, test_ids: list[str] | None = None) -> dict:
    started = utcnow()
    t0 = time.perf_counter()
    selected = [fn for tid, fn in SUITE if not test_ids or tid in test_ids]
    results = []
    for fn in selected:
        try:
            results.append(fn())
        except Exception as exc:  # a failing test must not break the suite
            results.append(
                _result(
                    fn.__name__,
                    fn.__name__,
                    "test execution",
                    False,
                    "test completes",
                    f"raised {type(exc).__name__}: {exc}",
                )
            )
    passed = sum(1 for r in results if r["passed"])
    return {
        "suite": "railflow-reliability-suite",
        "started_at": started.isoformat(),
        "finished_at": utcnow().isoformat(),
        "duration_seconds": round(time.perf_counter() - t0, 2),
        "total": len(results),
        "passed": passed,
        "failed": len(results) - passed,
        "results": results,
    }
