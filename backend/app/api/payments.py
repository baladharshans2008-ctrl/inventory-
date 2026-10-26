"""Simulated payment endpoints (no real money is ever processed)."""

from __future__ import annotations

import time

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from ..db import get_db
from ..errors import NotFound
from ..models import PaymentTransaction
from ..schemas import PaymentRequest, payment_dict
from ..services import payment_service
from ..services.events import counters, log_event
from ..utils import utcnow
from .deps import current_request_id, enforce_rate_limit

router = APIRouter(tags=["payments"])


@router.post("/payments/simulate", status_code=201)
def simulate_payment(
    payload: PaymentRequest,
    db: Session = Depends(get_db),
    _rate: None = Depends(enforce_rate_limit),
    rid: str | None = Depends(current_request_id),
) -> dict:
    """Submit a payment to the simulated gateway.

    Outcomes: success, failure, pending (timeout), delayed success and duplicate
    requests are all handled. A repeated ``idempotency_key`` returns the original
    transaction instead of creating another logical payment.
    """
    started = time.perf_counter()
    txn, created = payment_service.initiate_payment(
        db,
        reservation_id=payload.reservation_id,
        idempotency_key=payload.idempotency_key,
        scenario=payload.scenario,
        delay_ms=payload.delay_ms,
    )
    latency = (time.perf_counter() - started) * 1000
    counters().bump("payment.latency_ms", latency)
    log_event(
        db,
        "payment.polled",
        f"Payment {txn.reference} state={txn.status}",
        payload={"payment_id": txn.id, "created": created},
        request_id=rid,
        commit=False,
    )
    db.commit()
    return {
        "created": created,
        "duplicate": not created,
        "message": (
            "Payment request accepted by the simulated gateway."
            if created
            else "Duplicate payment request - returning the existing transaction (no second charge)."
        ),
        "payment": payment_dict(txn),
        "latency_ms": round(latency, 1),
    }


@router.get("/payments")
def list_payments(
    reservation_id: str | None = Query(default=None, max_length=32),
    status: str | None = Query(default=None, max_length=16),
    include_simulations: bool = Query(default=False),
    limit: int = Query(default=25, ge=1, le=100),
    db: Session = Depends(get_db),
) -> dict:
    stmt = select(PaymentTransaction).options(joinedload(PaymentTransaction.reservation))
    if reservation_id:
        stmt = stmt.where(PaymentTransaction.reservation_id == reservation_id)
    if status:
        stmt = stmt.where(PaymentTransaction.status == status.upper())
    if not include_simulations:
        stmt = stmt.where(PaymentTransaction.is_simulation.is_(False))
    rows = db.scalars(stmt.order_by(PaymentTransaction.created_at.desc()).limit(limit)).unique().all()
    return {"count": len(rows), "payments": [payment_dict(p) for p in rows]}


@router.get("/payments/{payment_id}")
def get_payment(payment_id: str, db: Session = Depends(get_db)) -> dict:
    txn = db.scalar(
        select(PaymentTransaction)
        .options(joinedload(PaymentTransaction.reservation))
        .where(PaymentTransaction.id == payment_id)
    )
    if txn is None:
        raise NotFound("Payment not found", details={"payment_id": payment_id})

    # A PENDING transaction whose resolution time has passed is reconciled on
    # read: the authoritative ledger is always consulted before the client is
    # told whether it may retry.
    if txn.status == "PENDING" and txn.resolve_at and txn.resolve_at <= utcnow():
        payment_service.reconcile_payment(db, txn)
        db.refresh(txn)
    return {"payment": payment_dict(txn)}


@router.post("/payments/{payment_id}/reconcile")
def reconcile(payment_id: str, force: bool = Query(default=False), db: Session = Depends(get_db)) -> dict:
    txn = db.scalar(
        select(PaymentTransaction)
        .options(joinedload(PaymentTransaction.reservation))
        .where(PaymentTransaction.id == payment_id)
    )
    if txn is None:
        raise NotFound("Payment not found", details={"payment_id": payment_id})
    before = txn.status
    txn = payment_service.reconcile_payment(db, txn, force=force)
    db.refresh(txn)
    return {
        "previous_status": before,
        "resolved": txn.status in ("SUCCESS", "FAILED"),
        "summary": (
            "Reconciliation completed against the authoritative gateway ledger."
            if txn.status in ("SUCCESS", "FAILED")
            else "Still unresolved - the gateway has not published a final result yet."
        ),
        "payment": payment_dict(txn),
    }
