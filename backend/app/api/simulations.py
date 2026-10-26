"""Hackathon Simulation Lab endpoints (admin access)."""

from __future__ import annotations

import threading

from fastapi import APIRouter, BackgroundTasks, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..errors import NotFound
from ..models import SimulationRun
from ..schemas import SimulationRequest
from ..services import correctness, simulation
from .deps import require_admin

router = APIRouter(prefix="/simulations", tags=["simulations"], dependencies=[Depends(require_admin)])

# Only one heavy run at a time: bounded resource usage.
_run_lock = threading.Lock()


@router.get("/presets")
def presets() -> dict:
    return {
        "presets": simulation.PRESETS,
        "bounds": {k: {"min": v[0], "max": v[1]} for k, v in simulation.BOUNDS.items()},
        "modes": [
            {
                "id": "protected",
                "label": "Protected",
                "description": "Transactional seat allocation, idempotent bookings, payment reconciliation.",
            },
            {
                "id": "baseline",
                "label": "Baseline (unprotected)",
                "description": "Same workflow with locking and idempotent dedupe disabled - demonstrates overselling.",
            },
        ],
        "notes": [
            "Every run provisions its own disposable seat inventory.",
            "Results are computed from the events the run actually produced.",
        ],
    }


@router.post("/run", status_code=202)
def start_run(
    payload: SimulationRequest,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
) -> dict:
    if not _run_lock.acquire(blocking=False):
        from ..errors import ValidationFailure

        raise ValidationFailure("Another simulation is already running - wait for it to finish")
    try:
        config = simulation.validate_config(payload.model_dump(exclude_none=True))
        run = simulation.create_run(db, config)
    except Exception:
        _run_lock.release()
        raise

    def job() -> None:
        try:
            simulation.execute_run(run.id, config)
        finally:
            _run_lock.release()

    background.add_task(job)
    return {
        "run_id": run.id,
        "status": run.status,
        "config": config,
        "message": "Simulation started. Poll /api/simulations/{run_id} for live progress.",
    }


@router.get("/runs")
def recent_runs(limit: int = Query(default=10, ge=1, le=50), db: Session = Depends(get_db)) -> dict:
    return {"runs": simulation.recent_runs(db, limit=limit)}


@router.get("/correctness")
def correctness_info() -> dict:
    return {
        "suite": "railflow-reliability-suite",
        "tests": [
            {"id": "A", "name": "Overselling prevention", "detail": "100 concurrent requests for 10 seats"},
            {"id": "B", "name": "Single-seat race", "detail": "100 concurrent requests for 1 seat"},
            {"id": "C", "name": "Duplicate booking prevention", "detail": "Same idempotency key submitted repeatedly"},
            {"id": "D", "name": "Payment timeout reconciliation", "detail": "Unknown gateway result must be resolved first"},
            {"id": "E", "name": "Reservation expiry", "detail": "Expired holds release exactly once"},
            {"id": "F", "name": "Inventory consistency", "detail": "Counters reconcile with seat rows"},
            {"id": "G", "name": "Failure recovery", "detail": "Interrupted request must not duplicate bookings"},
        ],
        "run_with": "POST /api/simulations/correctness",
    }


@router.post("/correctness")
def run_correctness(
    tests: str | None = Query(default=None, description="Comma separated test ids, e.g. A,B,C"),
) -> dict:
    """Execute the automated correctness suite against the live database."""
    selected = [t.strip().upper() for t in tests.split(",")] if tests else None
    return correctness.run_suite(test_ids=selected)


@router.get("/{run_id}")
def get_run(run_id: str, db: Session = Depends(get_db)) -> dict:
    run = simulation.get_run(db, run_id)
    if run is None:
        raise NotFound("Simulation run not found", details={"run_id": run_id})
    total = max(1, run.total_requests)
    return {
        "run": simulation.serialize_run(run),
        "progress_pct": round(min(100.0, (run.progress / total) * 100), 1),
    }


@router.get("/{run_id}/events")
def get_run_events(
    run_id: str,
    after_seq: int = Query(default=0, ge=0),
    limit: int = Query(default=200, ge=1, le=500),
    db: Session = Depends(get_db),
) -> dict:
    if simulation.get_run(db, run_id) is None:
        raise NotFound("Simulation run not found", details={"run_id": run_id})
    events = simulation.run_events(db, run_id, after_seq=after_seq, limit=limit)
    return {
        "count": len(events),
        "events": events,
        "last_seq": events[-1]["seq"] if events else after_seq,
    }


@router.get("/{run_id}/results")
def get_run_results(run_id: str, db: Session = Depends(get_db)) -> dict:
    run = simulation.get_run(db, run_id)
    if run is None:
        raise NotFound("Simulation run not found", details={"run_id": run_id})
    if run.status != "COMPLETED":
        return {
            "run_id": run.id,
            "status": run.status,
            "progress": run.progress,
            "total_requests": run.total_requests,
            "results_ready": False,
            "message": "Results become available when the run completes.",
        }
    return {"run_id": run.id, "status": run.status, "results_ready": True, "results": run.summary}
