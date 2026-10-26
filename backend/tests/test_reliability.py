"""Automated correctness tests for RailFlow AI.

Run with:  cd backend && .venv/Scripts/python -m pytest
The same scenarios are exposed in the Simulation Lab UI via
``POST /api/simulations/correctness``.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.db import init_db
from app.main import app
from app.seed import seed_demo_data
from app.services import correctness


@pytest.fixture(scope="session", autouse=True)
def prepared_database():
    init_db()
    from app.db import session_scope

    with session_scope() as db:
        seed_demo_data(db)
    yield


@pytest.fixture(scope="session")
def client() -> TestClient:
    with TestClient(app) as test_client:
        yield test_client


# --------------------------------------------------------------------------
# Test A - overselling
# --------------------------------------------------------------------------
def test_a_overselling_is_impossible():
    result = correctness.test_a_overselling(seats=10, requests=100)
    assert result["passed"], result


# --------------------------------------------------------------------------
# Test B - single seat race
# --------------------------------------------------------------------------
def test_b_single_seat_race_has_exactly_one_winner():
    result = correctness.test_b_single_seat_race(requests=100)
    assert result["passed"], result


# --------------------------------------------------------------------------
# Test C - duplicate booking requests
# --------------------------------------------------------------------------
def test_c_duplicate_requests_create_one_booking():
    result = correctness.test_c_duplicate_booking(attempts=20)
    assert result["passed"], result


# --------------------------------------------------------------------------
# Test D - payment timeout
# --------------------------------------------------------------------------
def test_d_payment_timeout_is_reconciled_not_guessed():
    result = correctness.test_d_payment_timeout()
    assert result["passed"], result


# --------------------------------------------------------------------------
# Test E - reservation expiry
# --------------------------------------------------------------------------
def test_e_expired_hold_releases_exactly_once():
    result = correctness.test_e_reservation_expiry()
    assert result["passed"], result


# --------------------------------------------------------------------------
# Test F - inventory consistency
# --------------------------------------------------------------------------
def test_f_inventory_counters_reconcile():
    result = correctness.test_f_inventory_consistency()
    assert result["passed"], result


# --------------------------------------------------------------------------
# Test G - failure recovery
# --------------------------------------------------------------------------
def test_g_interrupted_request_recovers_safely():
    result = correctness.test_g_failure_recovery()
    assert result["passed"], result


# --------------------------------------------------------------------------
# API level behaviour
# --------------------------------------------------------------------------
def test_health_endpoint_reports_components(client: TestClient):
    response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["components"]["database"]["status"] == "operational"
    assert body["demo_mode"] is True


def test_train_search_uses_seeded_inventory(client: TestClient):
    response = client.get("/api/trains", params={"from": "MAS", "to": "SBC"})
    assert response.status_code == 200
    body = response.json()
    assert body["count"] >= 1
    first = body["results"][0]
    assert first["train"]["number"]
    assert first["classes"], "class-wise inventory must be returned"
    assert first["classes"][0]["available_count"] >= 0


def test_booking_flow_holds_seats_and_is_idempotent(client: TestClient):
    search = client.get("/api/trains", params={"from": "MAS", "to": "CBE", "travel_class": "SL"}).json()
    schedule_id = search["results"][0]["schedule_id"]
    payload = {
        "schedule_id": schedule_id,
        "travel_class": "SL",
        "passengers": [{"name": "API Tester", "age": 33, "gender": "Other"}],
        "idempotency_key": "api-test-flow-key-1",
        "contact_email": "tester@example.com",
    }
    first = client.post("/api/reservations", json=payload)
    assert first.status_code == 201, first.text
    reservation = first.json()["reservation"]
    assert reservation["status"] == "HELD"
    assert len(reservation["seat_numbers"]) == 1

    # Replaying the exact same request must not create a second booking.
    replay = client.post("/api/reservations", json=payload)
    assert replay.status_code == 201
    assert replay.json()["created"] is False
    assert replay.json()["reservation"]["reservation_id"] == reservation["reservation_id"]


def test_sold_out_class_returns_conflict(client: TestClient):
    """A class with no inventory left must answer 409, never a phantom booking."""
    search = client.get("/api/trains", params={"from": "SBC", "to": "HYB", "travel_class": "1A"}).json()
    schedule_id = search["results"][0]["schedule_id"]
    capacity = next(c for c in search["results"][0]["classes"] if c["travel_class"] == "1A")["total_seats"]

    booked = 0
    for index in range(capacity):
        response = client.post(
            "/api/reservations",
            json={
                "schedule_id": schedule_id,
                "travel_class": "1A",
                "passengers": [{"name": f"Filler {index}", "age": 30, "gender": "Other"}],
                "idempotency_key": f"soldout-test-{schedule_id}-{index}",
            },
        )
        if response.status_code == 201:
            booked += 1
    assert booked == capacity, f"expected to fill {capacity} seats, filled {booked}"

    overflow = client.post(
        "/api/reservations",
        json={
            "schedule_id": schedule_id,
            "travel_class": "1A",
            "passengers": [{"name": "Late Passenger", "age": 30, "gender": "Other"}],
            "idempotency_key": f"soldout-overflow-{schedule_id}",
        },
    )
    assert overflow.status_code == 409
    assert overflow.json()["error"]["code"] == "seat_unavailable"


def test_payment_simulation_is_idempotent(client: TestClient):
    search = client.get("/api/trains", params={"from": "CBE", "to": "ERS", "travel_class": "SL"}).json()
    schedule_id = search["results"][0]["schedule_id"]
    booking = client.post(
        "/api/reservations",
        json={
            "schedule_id": schedule_id,
            "travel_class": "SL",
            "passengers": [{"name": "Payment Tester", "age": 41, "gender": "Other"}],
            "idempotency_key": "api-test-payment-booking",
        },
    ).json()["reservation"]

    payment_payload = {
        "reservation_id": booking["reservation_id"],
        "idempotency_key": "api-test-payment-key",
        "scenario": "success",
    }
    first = client.post("/api/payments/simulate", json=payment_payload)
    assert first.status_code == 201, first.text
    assert first.json()["payment"]["status"] == "SUCCESS"

    duplicate = client.post("/api/payments/simulate", json=payment_payload)
    assert duplicate.status_code == 201
    assert duplicate.json()["duplicate"] is True
    assert duplicate.json()["payment"]["payment_id"] == first.json()["payment"]["payment_id"]

    listing = client.get("/api/payments", params={"reservation_id": booking["reservation_id"]}).json()
    assert listing["count"] == 1, "a duplicate payment request must not add a transaction"

    confirmed = client.get(f"/api/reservations/{booking['reservation_id']}").json()["reservation"]
    assert confirmed["status"] == "CONFIRMED"


def test_queue_entry_is_idempotent_per_request_key(client: TestClient):
    search = client.get("/api/trains", params={"from": "MAS", "to": "SBC", "travel_class": "3A"}).json()
    schedule_id = search["results"][0]["schedule_id"]
    body = {
        "schedule_id": schedule_id,
        "travel_class": "3A",
        "passenger_count": 2,
        "request_key": "queue-test-key-abc",
    }
    first = client.post("/api/queue/join", json=body)
    assert first.status_code == 201
    token = first.json()["queue"]["token"]

    second = client.post("/api/queue/join", json=body)
    assert second.status_code == 201
    assert second.json()["created"] is False
    assert second.json()["queue"]["token"] == token

    status = client.get(f"/api/queue/{token}")
    assert status.status_code == 200
    assert status.json()["queue"]["status"] in ("READY", "WAITING")


def test_admin_endpoints_require_key(client: TestClient):
    assert client.get("/api/admin/metrics").status_code == 401
    authorised = client.get("/api/admin/metrics", headers={"X-Admin-Key": "test-admin-key"})
    assert authorised.status_code == 200
    body = authorised.json()
    assert "totals" in body and "services" in body and "series" in body


def test_admin_metrics_are_derived_not_hardcoded(client: TestClient):
    body = client.get("/api/admin/metrics", headers={"X-Admin-Key": "test-admin-key"}).json()
    assert body["totals"]["booking_requests"] >= 1  # earlier tests booked seats
    assert body["latency"]["source"]
    assert body["demo_mode"] is True


def test_simulation_run_executes_real_backend_logic(client: TestClient):
    response = client.post(
        "/api/simulations/run",
        headers={"X-Admin-Key": "test-admin-key"},
        json={"scenario": "one_seat_many_requests", "mode": "protected", "concurrent_requests": 40, "available_seats": 1},
    )
    assert response.status_code == 202, response.text
    run_id = response.json()["run_id"]

    import time

    for _ in range(60):
        status = client.get(f"/api/simulations/{run_id}", headers={"X-Admin-Key": "test-admin-key"}).json()
        if status["run"]["status"] == "COMPLETED":
            break
        time.sleep(0.5)
    else:
        pytest.fail("simulation did not complete in time")

    results = client.get(f"/api/simulations/{run_id}/results", headers={"X-Admin-Key": "test-admin-key"}).json()
    assert results["results_ready"] is True
    summary = results["results"]
    assert summary["successful_bookings"] <= 1
    assert summary["oversold_by"] == 0
    assert summary["consistency"]["ok"] is True
    assert summary["latency"]["samples"] > 0
