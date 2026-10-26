# RailFlow AI — Smart, Crash-Resistant Railway Booking System

A full-stack prototype of a railway booking platform whose primary goal is **not**
pretty screens — it is that the booking engine never oversells a seat, never
creates a duplicate booking, and never guesses what happened to a payment.

> **Independent prototype.** RailFlow AI is **not** affiliated with IRCTC or
> Indian Railways. All train data is fictional and seeded locally, and every
> payment is simulated. No real ticket is ever issued and no money moves.

---

## 1. What is being demonstrated

A booking system fails in predictable ways under load:

| Failure mode | RailFlow AI's answer |
|---|---|
| Two users buy the same seat | Seats move `AVAILABLE → HELD → CONFIRMED` through an atomic conditional `UPDATE`; the loser gets a `409`, never a second seat |
| The same request is sent twice | Idempotency keys with `UNIQUE` constraints; the replay returns the original booking |
| A payment gateway times out | The outcome stays **server-authoritative**: the transaction is `PENDING`, must be reconciled, and is never assumed to have failed |
| A user abandons checkout | An expiry worker releases the hold exactly once and returns the seat to inventory |
| A surge of traffic arrives | A server-authoritative virtual waiting queue admits a bounded number of users at a time |
| A process crashes mid-booking | Holds are leased, not owned: unconfirmed holds are reclaimed by the expiry sweep |

Every one of those claims is exercised by runnable tests (§7) and by the
Simulation Lab, which drives the **real** backend code — not a mock.

---

## 2. Quick start

Requirements: **Python 3.11+** and **Node 20+**. No database setup is needed —
the app falls back to SQLite automatically (see §8).

### Backend

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

On startup you should see the seed summary and the workers:

```
seed summary: {'stations': 11, 'trains': 10, 'schedules_created': 30, 'schedules_total': 30, 'seats_total': 6168}
started 4 background workers
Uvicorn running on http://127.0.0.1:8000
```

### Frontend

```powershell
cd frontend
npm install
npm run dev
```

### URLs

| What | URL |
|---|---|
| Application | http://localhost:5173 |
| API | http://127.0.0.1:8000/api |
| Interactive API docs | http://127.0.0.1:8000/docs |
| Operations dashboard | http://localhost:5173/ops |
| Simulation Lab | http://localhost:5173/lab |

The Vite dev server proxies `/api` to `http://127.0.0.1:8000`, so the browser
only ever talks to a single origin. Override the backend with
`VITE_BACKEND_URL` if you run it elsewhere.

Administrative endpoints (metrics, events, simulation runs) require the demo
admin key. The frontend asks for it once and stores it in `localStorage`; the
default value is in `backend/.env.example`:

```
X-Admin-Key: railflow-demo-admin-key
```

---

## 3. Running with Docker (PostgreSQL + Redis)

```bash
docker compose up --build
```

This starts four services: `db` (PostgreSQL 16), `redis` (7), `backend`
(FastAPI on :8000, wired to both) and `frontend` (Vite on :5173). The backend
container installs `requirements-optional.txt`, so it uses the real PostgreSQL
and Redis rather than the local fallbacks.

> Not verified in this environment — Docker is not installed on the machine this
> was built on. The Compose file parses cleanly and mirrors the documented
> local commands.

---

## 4. Architecture

```
React (Vite + TS + Tailwind + shadcn/ui)
        │  REST + SSE, single origin via the Vite proxy
        ▼
FastAPI  ── api/       health · catalog · queue · reservations · payments · admin · simulations
         ── services/  inventory · payment_service · queue_service · simulation · correctness
         │             metrics · events · workers · cache
         ▼
SQLAlchemy 2.0  ── authoritative seat inventory
         ▼
PostgreSQL (production)  /  SQLite + BEGIN IMMEDIATE (local fallback)
Redis (production)       /  in-process cache + rate limiter (local fallback)
```

**The database is the source of truth.** Redis (when present) only accelerates
rate limiting and queue caching; it can be wiped at any time without losing a
booking or corrupting inventory.

### Background workers

Four daemon threads started in the FastAPI lifespan:

| Worker | Interval | Responsibility |
|---|---|---|
| queue | 1 s | Promote waiting users into the admitted window; expire stale tokens |
| expiry | 2 s | Release `HELD` seats whose hold lapsed |
| reconciliation | 3 s | Resolve payments whose gateway deadline has passed |
| metrics | 2.5 s | Sample gauges and event counters into `metrics_samples` |

### Data model (core tables)

`stations`, `trains`, `schedules`, `seat_inventory`, `seats`, `reservations`,
`passengers`, `payment_transactions`, `queue_entries`, `app_events`,
`metrics_samples`, `simulation_runs`, `simulation_events`, `system_health_events`.

---

## 5. How the reliability guarantees are implemented

### 5.1 Seats cannot be double-sold

Seat allocation is a single conditional statement, not a read-then-write:

```sql
UPDATE seats
   SET status = 'HELD', reservation_id = :rid, hold_expires_at = :exp
 WHERE schedule_id = :sid AND travel_class = :cls AND seat_number = :seat
   AND status = 'AVAILABLE';
```

If `rowcount == 0` the seat was taken between reading and writing, and the
allocator retries with the next candidate. Confirmation uses the same pattern
(`WHERE status = 'HELD'`), so a seat can be confirmed at most once. Each row
carries an optimistic `version` counter.

On SQLite the same guarantee is provided by opening **every** write transaction
as `BEGIN IMMEDIATE`, which takes the single writer lock up front. That makes
the check-and-allocate sequence atomic in exactly the way
`SELECT ... FOR UPDATE` does on PostgreSQL — see `backend/app/db.py`.

### 5.2 Booking requests are idempotent

`reservations.idempotency_key` and `payment_transactions.idempotency_key` are
`UNIQUE`. A retry with the same key returns the original record with
`created: false` instead of creating a second booking. This is what makes a
client-side retry safe after a timeout.

### 5.3 The payment outcome is server-authoritative

```
INITIATED ──► PENDING ──► RECONCILING ──► SUCCESS
                  │                   └─► FAILED
                  └─► (client timeout: the API refuses to guess)
```

When the simulated gateway times out, the truthful result is written to
`settled_outcome` **server-side only** and `resolve_at` is set to the moment the
gateway will publish it. Until then the API returns `PENDING`/`RECONCILING` and
refuses to treat the timeout as a failure. Only reconciliation — or the
reconciliation worker once `resolve_at` has passed — moves the transaction to a
terminal state, and only then does the booking follow. Reconciling *before*
`resolve_at` deliberately leaves the transaction unresolved.

### 5.4 Holds expire and seats come back

Reservations are leased, not owned. A hold that is not paid within
`HOLD_MINUTES` is released by the expiry worker with a conditional `UPDATE`, so
a seat is released **exactly once** even if several sweeps overlap. The same
sweep recovers inventory after a crash: any `HELD` seat whose lease lapsed is
returned to `AVAILABLE`.

The failure path is covered too: a declined payment releases the seats and moves
the reservation to `RELEASED` with `release_reason = payment_failed`.

### 5.5 Counters always reconcile

`seat_inventory.available_count / held_count / confirmed_count` are maintained
alongside the physical `seats` rows, and `consistency_check()` verifies that the
counters equal the rows and that they sum to `total_seats`. It is exposed at
`GET /api/admin/inventory/{schedule_id}/consistency` and asserted by tests E, F
and G.

### 5.6 The virtual queue is server-side

Admission is decided by the backend (`queue_capacity` = 40 by default, admission
rate 12/s) and stored in the database. Clients poll; they cannot admit
themselves. Joining is idempotent per `request_key`.

### 5.7 Operational hygiene

- Every request gets an `X-Request-ID` and an `X-Process-Time-Ms` response header.
- All booking, payment, queue and simulation transitions are written to
  `app_events` with a severity, and the dashboard reads **those** rows.
- Dashboard metrics are derived from recorded events, database gauges and
  in-process latency samples. Nothing is hardcoded; simulated components are
  labelled `simulated: true`.
- Domain errors return structured, safe payloads (`{"error": {"code", "message",
  "details"}}`); unexpected exceptions return a generic `500 internal_error`
  without leaking internals. Validation failures return `422 validation_failed`.
- Administrative routes require `X-Admin-Key` (or `?key=` for SSE clients, which
  cannot set headers on `EventSource`).
- Rate limiting is applied per client id (default 600 requests/minute).

---

## 6. Pages

| # | Route | Page |
|---|---|---|
| 1 | `/` | Home / landing |
| 2 | `/search` | Search trains |
| 3 | `/trains` | Results and per-class seat availability |
| 4 | `/book/:scheduleId` | Passenger details and booking |
| 5 | `/queue` | Virtual queue |
| 6 | `/bookings`, `/bookings/:reservationId` | Booking confirmation and history |
| 7 | `/payments`, `/payments/:paymentId` | Payment and transaction status |
| 8 | `/ops` | Reliability operations dashboard (live SSE) |
| 9 | `/lab` | Hackathon simulation lab |
| 10 | `/architecture` | System architecture and about |

---

## 7. Tests

### 7.1 Backend test suite (pytest)

```powershell
cd backend
.\.venv\Scripts\python.exe -m pytest -q
```

**Result: 16 passed.**

Seven of them are the A–G reliability scenario, run against the application's
own service layer:

| ID | Test |
|---|---|
| A | Overselling prevention |
| B | Single-seat race |
| C | Duplicate booking prevention |
| D | Payment timeout reconciliation |
| E | Reservation expiry and inventory recovery |
| F | Inventory consistency |
| G | Failure recovery |

The remaining nine cover health reporting, seeded search, the idempotent booking
flow, sold-out conflicts, payment idempotency, queue idempotency, admin
authentication, metric provenance and simulation execution.

### 7.2 Correctness suite (live database, via the API)

```powershell
$H = @{'X-Admin-Key'='railflow-demo-admin-key'}
Invoke-RestMethod 'http://127.0.0.1:8000/api/simulations/correctness' -Method Post -Headers $H
```

**Result: 7/7 passed** (10 consecutive runs, 4.8–6.9 s per full suite).
Example output from a real run:

```
A Overselling prevention             PASS  at most 10 seats reserved, counters consistent
                                           "10 reservation(s) held, 0 remaining, 90 conflict(s) returned"
B Single-seat race                   PASS  "1 successful hold(s), 1 seat owner(s), 99 conflict(s)"
C Duplicate booking prevention       PASS  "1 reservation row(s), 1 created / 19 replayed, 1 seat(s) held"
D Payment timeout reconciliation     PASS  "early reconcile kept booking HELD, final SUCCESS -> booking CONFIRMED"
E Reservation expiry                 PASS  "first sweep released 1 hold(s), second sweep released 0; confirmed seat untouched"
F Inventory consistency              PASS  "total=20, available=14, held=5, confirmed=1, sum=20"
G Failure recovery                   PASS  "reservation rows=1, same reservation on retry=True, released=1, consistency=ok"
```

These numbers are produced by the tests at runtime — nothing in this README is
hand-written output.

### 7.3 Simulation Lab

`/lab` runs the same scenarios the way a demo needs them: **protected mode**
against **baseline (unprotected) mode**, over seven presets — normal traffic,
Tatkal-style surge, one seat many requests, payment gateway failure, delayed
payment response, duplicate booking requests, and reservation expiry and
recovery. A run returns a verdict panel comparing oversold seats, duplicate
bookings, conflicts prevented, throughput and p95 latency.

```powershell
$H = @{'X-Admin-Key'='railflow-demo-admin-key'}
Invoke-RestMethod 'http://127.0.0.1:8000/api/simulations/run' -Method Post -Headers $H `
  -ContentType 'application/json' `
  -Body '{"scenario":"one_seat_many_requests","mode":"protected","concurrent_requests":40,"available_seats":1,"seats_per_request":1}'
```

A 40-request race for a single seat returns: `successful=1`, `conflicts=39`,
`oversold_by=0`, `duplicate_bookings_created=0`, with all four verdict checks
passing. The lab also comments the code path it exercised and how to verify it.

---

## 8. Fallbacks (and why they are safe)

| Component | Production | Local default | Consequence |
|---|---|---|---|
| Database | PostgreSQL (`SELECT ... FOR UPDATE`) | SQLite with `BEGIN IMMEDIATE` + WAL | Same write-serialisation guarantee for check-and-allocate |
| Cache / rate limit / queue cache | Redis | In-process dictionary with a lock | Limits are per process; queue state still lives in the database |

`GET /api/meta` reports which backends are active, and the health endpoint lists
each component with a `simulated` flag, so a fallback is never presented as a
production service.

Set `DATABASE_URL` and `REDIS_URL` (see `backend/.env.example`) to switch. The
backend attempts PostgreSQL first and logs a warning before falling back.

---

## 9. Demo script

1. **Landing page** — note the disclaimer and the live component health.
2. **Search** (`/search`) — MAS → CBE, a date, class `3A`. Results are read from
   the seeded database, not a fixture in the frontend.
3. **Availability** (`/trains`) — point out the per-class counters and the seat
   map. Every seat rendered comes from real inventory rows.
4. **Book** (`/book/:scheduleId`) — submit, then submit the *same* form again
   (or replay the request): the second call returns the original PNR with
   `created: false`. No duplicate booking.
5. **Queue** (`/queue`) — join, then join again with the same request key. Note
   that admission is decided by the server.
6. **Payment** (`/payments/:paymentId`) — run the `failure` scenario: the seat is
   released and the reservation is `RELEASED (payment_failed)`. Run `timeout`:
   the transaction stays `PENDING` and the page refuses to claim success until
   reconciliation resolves it.
7. **Operations dashboard** (`/ops`) — leave it open. It streams over SSE:
   queue depth, seat inventory, p50/p95/p99 latency, conflicts prevented,
   oversold seats (`0`), and a live event feed. Trigger a booking in another tab
   and watch the feed and the charts move.
8. **Simulation Lab** (`/lab`) — run *One seat, many requests* in protected mode,
   then in baseline mode. Compare oversold seats, duplicate bookings and
   conflicts. Then run the **A–G correctness suite** and show it going green.
9. **Architecture** (`/architecture`) — the state machines, the mechanisms, and
   how to verify each one.

---

## 10. Project layout

```
backend/
  app/
    api/         health · catalog · queue · reservations · payments · admin · simulations
    services/    inventory · payment_service · queue_service · simulation · correctness
                 metrics · events · workers · cache
    db.py        engine, read-only pool, BEGIN IMMEDIATE, session helpers
    models.py    SQLAlchemy models
    schemas.py   Pydantic request/response contracts
    seed.py      fictional stations, trains, schedules and seats
    main.py      app, middleware, exception handlers, lifespan
  tests/         pytest suite (A–G + API tests)
frontend/
  src/
    pages/       10 application pages
    components/  layout, ui primitives, seat map, status pills, states
    lib/         api client, types, hooks, formatting
docker-compose.yml   PostgreSQL + Redis + backend + frontend
```

---

## 11. API reference (abridged)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/meta` | Active backends, queue capacity, disclaimer |
| GET | `/api/health` | Per-component health |
| GET | `/api/stations`, `/api/routes` | Seeded catalog |
| GET | `/api/trains` | Search by `from`, `to`, `date`, `travel_class`, `passengers` |
| GET | `/api/trains/{schedule_id}/availability` | Per-class counters + optional seat preview |
| POST | `/api/queue/join` | Join the virtual queue (idempotent) |
| GET | `/api/queue/status` | Queue depth and admission window |
| POST | `/api/reservations` | Hold seats (idempotent) |
| GET | `/api/reservations/{id}` | Reservation detail |
| POST | `/api/payments/simulate` | Start a simulated payment (idempotent) |
| GET | `/api/payments/{id}` | Payment state machine + timeline |
| POST | `/api/payments/{id}/reconcile` | Force/attempt reconciliation |
| GET | `/api/admin/metrics` | Dashboard payload (admin) |
| GET | `/api/admin/events` | Event feed (admin) |
| GET | `/api/admin/stream` | **SSE** live dashboard feed (admin) |
| GET | `/api/admin/inventory/{schedule_id}/consistency` | Counter reconciliation (admin) |
| GET | `/api/simulations/presets` | Scenarios, bounds and defaults |
| POST | `/api/simulations/run` | Start a stress run (admin) |
| GET | `/api/simulations/{run_id}/results` | Run results and verdicts (admin) |
| POST | `/api/simulations/correctness` | Execute the A–G suite (admin) |

---

## 12. Known limitations

- Payments, the gateway and the traffic generator are simulated by design.
- Background workers are in-process threads; a multi-replica deployment would
  move them to Celery/APScheduler with a Redis broker. The service-layer logic
  is unchanged.
- The frontend is a single 813 kB bundle (227 kB gzipped) without route-level
  code splitting.
- Docker Compose is provided but was not executed in the build environment
  (Docker unavailable), so it is documented rather than verified.
