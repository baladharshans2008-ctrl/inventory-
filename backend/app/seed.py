"""Fictional seed data + schedule provisioning helpers.

All trains, numbers and fares are invented for the demo. RailFlow AI has no
connection to IRCTC or any real railway system and never books a real ticket.
"""

from __future__ import annotations

from datetime import date, time, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .models import Schedule, Seat, SeatInventory, Station, Train
from .utils import utcnow

STATIONS = [
    ("MAS", "Chennai Central", "Chennai", "Tamil Nadu", "SR"),
    ("MS", "Chennai Egmore", "Chennai", "Tamil Nadu", "SR"),
    ("SBC", "KSR Bengaluru City", "Bengaluru", "Karnataka", "SWR"),
    ("CBE", "Coimbatore Junction", "Coimbatore", "Tamil Nadu", "SR"),
    ("HYB", "Hyderabad Deccan", "Hyderabad", "Telangana", "SCR"),
    ("SC", "Secunderabad Junction", "Hyderabad", "Telangana", "SCR"),
    ("MDU", "Madurai Junction", "Madurai", "Tamil Nadu", "SR"),
    ("TVC", "Thiruvananthapuram Central", "Thiruvananthapuram", "Kerala", "SR"),
    ("BZA", "Vijayawada Junction", "Vijayawada", "Andhra Pradesh", "SCR"),
    ("ERS", "Ernakulam Junction", "Kochi", "Kerala", "SR"),
    ("PUNE", "Pune Junction", "Pune", "Maharashtra", "CR"),
]

# (number, name, type, from, to, departure, arrival, duration_min, km, classes)
ROUTES: list[tuple] = [
    ("90011", "Bay Coast Superfast", "Superfast", "MAS", "SBC", time(6, 30), time(12, 15), 345, 362, ["SL", "3A", "2A", "CC"]),
    ("90012", "Deccan Plateau Express", "Express", "MAS", "SBC", time(22, 10), time(5, 5), 415, 362, ["SL", "3A", "2A"]),
    ("90021", "Kovai Intercity", "Intercity", "MAS", "CBE", time(7, 15), time(15, 40), 505, 495, ["SL", "3A", "CC"]),
    ("90022", "Nilgiri Link Express", "Express", "MAS", "CBE", time(20, 45), time(6, 10), 565, 495, ["SL", "3A", "2A"]),
    ("90031", "Charminar Night Express", "Superfast", "SBC", "HYB", time(21, 50), time(6, 25), 515, 610, ["SL", "3A", "2A", "1A"]),
    ("90032", "Golconda Day Express", "Express", "SBC", "HYB", time(8, 5), time(18, 30), 625, 610, ["SL", "3A", "CC"]),
    ("90041", "Vaigai Delta Express", "Express", "MS", "MDU", time(19, 30), time(5, 45), 615, 495, ["SL", "3A", "2A"]),
    ("90051", "Malabar Coastal Express", "Superfast", "CBE", "ERS", time(5, 45), time(11, 20), 335, 245, ["SL", "CC", "2A"]),
    ("90061", "Krishna Valley Express", "Express", "BZA", "SC", time(16, 20), time(22, 35), 375, 275, ["SL", "3A", "CC"]),
    ("90071", "Deccan Queen Link", "Superfast", "HYB", "PUNE", time(14, 0), time(3, 30), 810, 660, ["SL", "3A", "2A", "1A"]),
]

CLASS_CAPACITY = {"1A": 24, "2A": 46, "3A": 64, "SL": 72, "CC": 78, "EC": 56}
CLASS_FARE_PER_KM = {"1A": 4.6, "2A": 2.9, "3A": 2.05, "SL": 0.95, "CC": 1.75, "EC": 3.4}
BERTH_CYCLE = ["LOWER", "MIDDLE", "UPPER", "SIDE LOWER", "SIDE UPPER", "MIDDLE"]

SEED_DAYS = 3  # today + the next two days


def seed_stations(db: Session) -> None:
    for code, name, city, state, zone in STATIONS:
        if db.get(Station, code) is None:
            db.add(Station(code=code, name=name, city=city, state=state, zone=zone))
    db.commit()


def seed_trains(db: Session) -> None:
    for number, name, train_type, *_ in ROUTES:
        if db.scalar(select(Train).where(Train.number == number)) is None:
            db.add(Train(number=number, name=name, train_type=train_type))
    db.commit()


def provision_schedule(
    db: Session,
    *,
    train: Train,
    travel_date: date,
    from_code: str,
    to_code: str,
    departure: time,
    arrival: time,
    duration_minutes: int,
    distance_km: int,
    classes: list[str],
    capacity_override: dict[str, int] | None = None,
    is_simulation: bool = False,
) -> Schedule:
    """Create a schedule with its full seat inventory."""
    schedule = Schedule(
        train_id=train.id,
        travel_date=travel_date,
        from_code=from_code,
        to_code=to_code,
        departure_time=departure,
        arrival_time=arrival,
        duration_minutes=duration_minutes,
        distance_km=distance_km,
        is_simulation=is_simulation,
        created_at=utcnow(),
    )
    db.add(schedule)
    db.flush()

    seat_rows = []
    for travel_class in classes:
        total = (capacity_override or {}).get(travel_class, CLASS_CAPACITY[travel_class])
        base_fare = round(max(120.0, distance_km * CLASS_FARE_PER_KM[travel_class]), 2)
        db.add(
            SeatInventory(
                schedule_id=schedule.id,
                travel_class=travel_class,
                total_seats=total,
                available_count=total,
                held_count=0,
                confirmed_count=0,
                base_fare=base_fare,
                rac_limit=max(1, total // 10),
            )
        )
        for index in range(1, total + 1):
            seat_rows.append(
                {
                    "schedule_id": schedule.id,
                    "travel_class": travel_class,
                    "seat_number": f"{travel_class}{index:03d}",
                    "seat_type": BERTH_CYCLE[(index - 1) % len(BERTH_CYCLE)],
                    "status": "AVAILABLE",
                    "version": 0,
                }
            )
    if seat_rows:
        # bulk insert: one statement instead of thousands of round trips
        db.bulk_insert_mappings(Seat, seat_rows)
    db.commit()
    db.refresh(schedule)
    return schedule


def seed_demo_data(db: Session) -> dict:
    """Idempotent seeding - safe to run on every startup."""
    seed_stations(db)
    seed_trains(db)

    created = 0
    today = date.today()
    for day_offset in range(SEED_DAYS):
        travel_date = today + timedelta(days=day_offset)
        for number, _name, _type, from_code, to_code, dep, arr, duration, km, classes in ROUTES:
            train = db.scalar(select(Train).where(Train.number == number))
            exists = db.scalar(
                select(Schedule.id).where(
                    Schedule.train_id == train.id,
                    Schedule.travel_date == travel_date,
                    Schedule.from_code == from_code,
                    Schedule.to_code == to_code,
                )
            )
            if exists:
                continue
            provision_schedule(
                db,
                train=train,
                travel_date=travel_date,
                from_code=from_code,
                to_code=to_code,
                departure=dep,
                arrival=arr,
                duration_minutes=duration,
                distance_km=km,
                classes=list(classes),
            )
            created += 1

    total_schedules = int(db.scalar(select(func.count(Schedule.id))) or 0)
    total_seats = int(db.scalar(select(func.count(Seat.id))) or 0)
    return {
        "stations": len(STATIONS),
        "trains": len(ROUTES),
        "schedules_created": created,
        "schedules_total": total_schedules,
        "seats_total": total_seats,
    }


def cleanup_simulation_schedules(db: Session, *, older_than_minutes: int = 60) -> int:
    """Housekeeping for simulation runs (bounded resource usage)."""
    cutoff = utcnow() - timedelta(minutes=older_than_minutes)
    schedules = db.scalars(
        select(Schedule).where(Schedule.is_simulation.is_(True), Schedule.created_at < cutoff)
    ).all()
    for schedule in schedules:
        db.delete(schedule)
    if schedules:
        db.commit()
    return len(schedules)
