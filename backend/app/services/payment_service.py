"""Simulated payment gateway with an explicit state machine.

INITIATED -> PENDING -> SUCCESS / FAILED   (RECONCILING while unresolved)

Rules enforced here
-------------------
* ``idempotency_key`` is UNIQUE: a repeated payment request returns the
  original transaction and never creates a second logical payment.
* A client-side timeout is never interpreted as a failure. The transaction
  stays PENDING, the real outcome is stored server-side and resolved by the
  reconciliation worker (or by an explicit reconcile call).
* Booking confirmation follows the *authoritative* transaction state, never
  what the browser reports.
"""

from __future__ import annotations

import random
import time
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..errors import NotFound, ValidationFailure
from ..models import (
    PAYMENT_FAILED,
    PAYMENT_INITIATED,
    PAYMENT_PENDING,
    PAYMENT_RECONCILING,
    PAYMENT_SUCCESS,
    RESERVATION_HELD,
    PaymentTransaction,
    Reservation,
)
from ..utils import new_id, utcnow
from . import inventory
from .events import log_event

SCENARIOS = (
    "auto",
    "success",
    "failure",
    "timeout",
    "delayed_success",
    "pending",
    "duplicate",
)


def reference_for(txn_id: str) -> str:
    return "TXN" + txn_id[:10].upper()


def _get_reservation(db: Session, reservation_id: str) -> Reservation:
    res = db.get(Reservation, reservation_id)
    if res is None:
        raise NotFound("Reservation not found", details={"reservation_id": reservation_id})
    return res


def initiate_payment(
    db: Session,
    *,
    reservation_id: str,
    idempotency_key: str,
    scenario: str = "auto",
    failure_pct: float | None = None,
    timeout_pct: float | None = None,
    delay_ms: int = 0,
    rng: random.Random | None = None,
    is_simulation: bool = False,
) -> tuple[PaymentTransaction, bool]:
    """Create (or return the existing) payment transaction for a reservation."""
    if scenario not in SCENARIOS:
        raise ValidationFailure(f"scenario must be one of {', '.join(SCENARIOS)}")

    existing = db.scalar(
        select(PaymentTransaction).where(PaymentTransaction.idempotency_key == idempotency_key)
    )
    if existing is not None:
        log_event(
            db,
            "payment.duplicate_requested",
            f"Duplicate payment request ignored - returning transaction {existing.reference}",
            severity="warning",
            payload={"payment_id": existing.id, "status": existing.status},
        )
        return existing, False

    reservation = _get_reservation(db, reservation_id)
    rng = rng or random.Random()
    now = utcnow()
    txn = PaymentTransaction(
        id=new_id(),
        reference="",
        reservation_id=reservation.id,
        amount=reservation.total_fare,
        status=PAYMENT_INITIATED,
        idempotency_key=idempotency_key,
        scenario=scenario,
        is_simulation=is_simulation,
        created_at=now,
    )
    txn.reference = reference_for(txn.id)
    db.add(txn)
    db.flush()
    log_event(
        db,
        "payment.initiated",
        f"Payment {txn.reference} initiated for PNR {reservation.pnr} (INR {reservation.total_fare:.2f})",
        payload={"payment_id": txn.id, "reservation_id": reservation.id, "scenario": scenario},
        commit=False,
        )
    db.commit()

    outcome, delay_seconds, is_pending = _decide_outcome(
        rng, scenario, failure_pct=failure_pct, timeout_pct=timeout_pct, delay_ms=delay_ms
    )

    started = time.perf_counter()
    if is_pending:
        # Authoritative answer is not known yet. The *simulated gateway* knows
        # the result internally; the API deliberately does not expose it.
        txn.status = PAYMENT_PENDING
        txn.settled_outcome = outcome
        txn.resolve_at = utcnow() + timedelta(seconds=delay_seconds)
        txn.message = (
            "Gateway response timed out. The transaction is unresolved - it must be "
            "reconciled before any retry."
        )
        txn.gateway_ref = "GW-" + new_id()[:10].upper()
        txn.latency_ms = int(delay_ms)
        db.commit()
        log_event(
            db,
            "payment.pending",
            f"Payment {txn.reference} is PENDING (gateway timeout) - reconciliation scheduled",
            severity="warning",
            payload={"payment_id": txn.id, "resolve_at": txn.resolve_at.isoformat()},
        )
    else:
        txn.gateway_ref = "GW-" + new_id()[:10].upper()
        txn.latency_ms = int(delay_ms)
        db.commit()
        apply_outcome(db, txn, outcome, source="gateway_response")

    db.refresh(txn)
    return txn, True


def _decide_outcome(
    rng: random.Random,
    scenario: str,
    *,
    failure_pct: float | None,
    timeout_pct: float | None,
    delay_ms: int,
) -> tuple[str, float, bool]:
    """Return (outcome, delay_seconds, is_pending)."""
    fail_pct = 5.0 if failure_pct is None else failure_pct
    tmo_pct = 0.0 if timeout_pct is None else timeout_pct
    delay_seconds = max(1.0, delay_ms / 1000.0)

    if scenario == "success":
        return PAYMENT_SUCCESS, 0.0, False
    if scenario == "failure":
        return PAYMENT_FAILED, 0.0, False
    if scenario == "timeout":
        # The request times out; the true outcome stays server-side.
        truth = PAYMENT_FAILED if rng.random() * 100 < fail_pct else PAYMENT_SUCCESS
        return truth, delay_seconds, True
    if scenario == "delayed_success":
        return PAYMENT_SUCCESS, delay_seconds, True
    if scenario == "pending":
        truth = PAYMENT_FAILED if rng.random() * 100 < fail_pct else PAYMENT_SUCCESS
        return truth, delay_seconds or 4.0, True
    if scenario == "duplicate":
        return PAYMENT_SUCCESS, 0.0, False

    roll = rng.random() * 100
    if roll < tmo_pct:
        truth = PAYMENT_FAILED if rng.random() * 100 < fail_pct else PAYMENT_SUCCESS
        return truth, delay_seconds or 4.0, True
    if roll < tmo_pct + fail_pct:
        return PAYMENT_FAILED, 0.0, False
    return PAYMENT_SUCCESS, 0.0, False


def apply_outcome(db: Session, txn: PaymentTransaction, outcome: str, *, source: str) -> PaymentTransaction:
    """Move a transaction to its terminal state and align the booking."""
    if txn.status in (PAYMENT_SUCCESS, PAYMENT_FAILED):
        return txn

    reservation = db.get(Reservation, txn.reservation_id)
    now = utcnow()

    if outcome == PAYMENT_SUCCESS:
        txn.status = PAYMENT_SUCCESS
        txn.resolved_at = now
        txn.message = "Payment captured by the simulated gateway."
        db.commit()
        if reservation is not None:
            confirmed = inventory.confirm_reservation(db, reservation, reason="payment_success")
            if not confirmed:
                # Money captured but the hold had already lapsed: the seat was
                # returned to inventory. This is a real reconciliation case, not
                # a silent double booking.
                txn.reconciliation_notes = (
                    "Payment succeeded after the seat hold expired. Refund/alternate "
                    "inventory review required - booking was NOT auto-confirmed."
                )
                txn.failure_reason = "hold_expired_before_capture"
                db.commit()
                log_event(
                    db,
                    "payment.reconciliation_required",
                    f"Payment {txn.reference} succeeded after hold expiry - flagged for manual review",
                    severity="error",
                    payload={"payment_id": txn.id, "reservation_id": txn.reservation_id},
                )
                return txn
        log_event(
            db,
            "payment.success",
            f"Payment {txn.reference} SUCCESS ({source}) - booking confirmed",
            payload={"payment_id": txn.id, "reservation_id": txn.reservation_id},
        )
    else:
        txn.status = PAYMENT_FAILED
        txn.resolved_at = now
        txn.failure_reason = "simulated_gateway_decline"
        txn.message = "Payment declined by the simulated gateway. Seats released."
        db.commit()
        if reservation is not None:
            inventory.release_reservation(db, reservation, reason="payment_failed")
        log_event(
            db,
            "payment.failed",
            f"Payment {txn.reference} FAILED ({source}) - seats returned to inventory",
            severity="warning",
            payload={"payment_id": txn.id, "reservation_id": txn.reservation_id},
        )
    db.refresh(txn)
    return txn


def reconcile_payment(db: Session, txn: PaymentTransaction, *, force: bool = False) -> PaymentTransaction:
    """Authoritative check of an unresolved transaction before any retry."""
    if txn.status in (PAYMENT_SUCCESS, PAYMENT_FAILED):
        return txn

    now = utcnow()
    due = txn.resolve_at is not None and txn.resolve_at <= now

    if not due and not force:
        txn.status = PAYMENT_RECONCILING
        txn.message = (
            "Gateway has not published a final result yet. Retrying now would risk a "
            "duplicate charge - wait for reconciliation."
        )
        db.commit()
        db.refresh(txn)
        return txn

    outcome = txn.settled_outcome or PAYMENT_SUCCESS
    txn.status = PAYMENT_RECONCILING
    txn.reconciled = True
    txn.reconciliation_notes = "Resolved from the authoritative gateway ledger."
    db.commit()
    log_event(
        db,
        "payment.reconciled",
        f"Payment {txn.reference} reconciled -> {outcome}",
        payload={"payment_id": txn.id, "outcome": outcome},
    )
    return apply_outcome(db, txn, outcome, source="reconciliation")


def pending_reconciliations(db: Session, *, limit: int = 200) -> list[PaymentTransaction]:
    return list(
        db.scalars(
            select(PaymentTransaction)
            .where(
                PaymentTransaction.status.in_((PAYMENT_INITIATED, PAYMENT_PENDING, PAYMENT_RECONCILING)),
                PaymentTransaction.resolve_at.is_not(None),
                PaymentTransaction.resolve_at <= utcnow(),
            )
            .order_by(PaymentTransaction.resolve_at)
            .limit(limit)
        ).all()
    )


def default_hold_seconds() -> int:
    return settings.hold_minutes * 60


def reservation_is_open(db: Session, reservation_id: str) -> bool:
    res = db.get(Reservation, reservation_id)
    return res is not None and res.status == RESERVATION_HELD
