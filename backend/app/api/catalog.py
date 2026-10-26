"""Station / train catalogue and availability endpoints."""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session, joinedload

from ..config import settings
from ..db import get_db
from ..errors import NotFound, ValidationFailure
from ..models import Schedule, Seat, SeatInventory, Station, Train
from ..schemas import inventory_dict, schedule_dict, station_dict
from ..seed import CLASS_CAPACITY
from ..services.cache import cache
from ..services.inventory import CLASSES, inventory_snapshot
from .deps import enforce_rate_limit

router = APIRouter(tags=["catalog"])


@router.get("/stations")
def list_stations(db: Session = Depends(get_db)) -> dict:
    stations = db.scalars(select(Station).order_by(Station.name)).all()
    return {"count": len(stations), "stations": [station_dict(s) for s in stations]}


@router.get("/routes")
def popular_routes(db: Session = Depends(get_db)) -> dict:
    """Distinct origin/destination pairs that actually have schedules."""
    rows = db.execute(
        select(Schedule.from_code, Schedule.to_code, func.count(Schedule.id))
        .where(Schedule.is_simulation.is_(False))
        .group_by(Schedule.from_code, Schedule.to_code)
        .order_by(func.count(Schedule.id).desc())
    ).all()
    stations = {s.code: s for s in db.scalars(select(Station)).all()}
    return {
        "routes": [
            {
                "from": station_dict(stations[from_code]) if from_code in stations else {"code": from_code},
                "to": station_dict(stations[to_code]) if to_code in stations else {"code": to_code},
                "schedules": int(count),
            }
            for from_code, to_code, count in rows
        ]
    }


@router.get("/trains")
def search_trains(
    from_code: str = Query(alias="from", min_length=2, max_length=8),
    to_code: str = Query(alias="to", min_length=2, max_length=8),
    travel_date: date = Query(default=None, alias="date"),
    travel_class: str | None = Query(default=None, max_length=8),
    passengers: int = Query(default=1, ge=1, le=6),
    available_only: bool = Query(default=False),
    limit: int = Query(default=40, ge=1, le=100),
    db: Session = Depends(get_db),
    _rate: None = Depends(enforce_rate_limit),
) -> dict:
    """Search fictional trains on a route for a date.

    Seat counts always come from the database inventory - the result is a
    snapshot taken at request time, never a cached guess about availability.
    """
    from_code = from_code.upper()
    to_code = to_code.upper()
    travel_date = travel_date or date.today()
    travel_class = travel_class.upper() if travel_class else None
    if travel_class and travel_class not in CLASSES:
        raise ValidationFailure(f"travel_class must be one of {', '.join(CLASSES)}")
    if from_code == to_code:
        raise ValidationFailure("Origin and destination must be different stations")

    stmt = (
        select(Schedule)
        .options(joinedload(Schedule.train), joinedload(Schedule.inventory))
        .where(
            Schedule.from_code == from_code,
            Schedule.to_code == to_code,
            Schedule.travel_date == travel_date,
            Schedule.is_simulation.is_(False),
        )
        .order_by(Schedule.departure_time)
        .limit(limit)
    )
    schedules = db.scalars(stmt).unique().all()

    results = []
    for schedule in schedules:
        payload = schedule_dict(schedule, travel_class=travel_class)
        if travel_class:
            selected = payload["selected_class"]
            if selected is None:
                continue
            if available_only and selected["available_count"] < passengers:
                continue
        results.append(payload)

    return {
        "query": {
            "from": from_code,
            "to": to_code,
            "date": travel_date.isoformat(),
            "travel_class": travel_class,
            "passengers": passengers,
        },
        "count": len(results),
        "searched_schedules": len(schedules),
        "results": results,
        "data_source": "seeded fictional inventory (backend database)",
    }


@router.get("/trains/{schedule_id}/availability")
def train_availability(
    schedule_id: int,
    seat_preview: int = Query(default=96, ge=0, le=400),
    db: Session = Depends(get_db),
) -> dict:
    """Class-wise availability plus a physical seat preview for one schedule."""
    schedule = db.scalar(
        select(Schedule)
        .options(joinedload(Schedule.train), joinedload(Schedule.inventory))
        .where(Schedule.id == schedule_id)
    )
    if schedule is None:
        raise NotFound("Schedule not found", details={"schedule_id": schedule_id})

    payload = schedule_dict(schedule)
    seats_by_class: dict[str, list[dict]] = {}
    for inv in schedule.inventory:
        rows = db.scalars(
            select(Seat)
            .where(Seat.schedule_id == schedule_id, Seat.travel_class == inv.travel_class)
            .order_by(Seat.id)
            .limit(seat_preview)
        ).all()
        seats_by_class[inv.travel_class] = [
            {
                "seat_number": seat.seat_number,
                "seat_type": seat.seat_type,
                "status": seat.status,
                "held_until": seat.held_until.isoformat() if seat.held_until else None,
            }
            for seat in rows
        ]

    return {
        "schedule": payload,
        "seat_preview_limit": seat_preview,
        "seats": seats_by_class,
        "snapshot": inventory_snapshot(db, schedule_id),
    }


@router.get("/meta")
def meta(db: Session = Depends(get_db)) -> dict:
    """Configuration + provenance information surfaced in the UI footer."""
    from ..db import DB_BACKEND

    total_seats = int(db.scalar(select(func.count(Seat.id))) or 0)
    return {
        "app_name": settings.app_name,
        "app_version": settings.app_version,
        "demo_mode": settings.demo_mode,
        "database_backend": DB_BACKEND,
        "cache_backend": cache.info().get("backend"),
        "queue_capacity": settings.queue_capacity,
        "queue_admission_rate": settings.queue_admission_rate,
        "hold_minutes": settings.hold_minutes,
        "class_capacity": CLASS_CAPACITY,
        "seeded_seats": total_seats,
        "disclaimer": (
            "RailFlow AI is an independent hackathon prototype. It is not affiliated with "
            "IRCTC or Indian Railways, uses fictional train data and a simulated payment "
            "gateway, and never books a real ticket."
        ),
    }
