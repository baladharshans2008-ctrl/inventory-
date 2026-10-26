"""RailFlow AI - FastAPI application entrypoint.

RailFlow AI is an independent hackathon prototype for crash-resistant railway
booking. It is not affiliated with IRCTC or Indian Railways: all train data is
fictional and payments are simulated.
"""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .api import admin, catalog, health, payments, queue, reservations, simulations
from .config import settings
from .db import DB_BACKEND, init_db, session_scope
from .errors import DomainError
from .models import SystemHealthEvent
from .seed import seed_demo_data
from .services.events import log_event
from .services.workers import workers
from .utils import request_id as new_request_id
from .utils import utcnow

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s :: %(message)s",
)
logger = logging.getLogger("railflow")


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    with session_scope() as db:
        summary = seed_demo_data(db)
        db.add(
            SystemHealthEvent(
                component="api",
                status="operational",
                detail=f"startup complete; database={DB_BACKEND}",
                created_at=utcnow(),
            )
        )
        db.commit()
        log_event(
            db,
            "system.startup",
            f"RailFlow AI started - database {DB_BACKEND}, "
            f"{summary['schedules_total']} schedules, {summary['seats_total']} seats seeded",
            payload=summary,
        )
    logger.info("seed summary: %s", summary)
    workers.start()
    try:
        yield
    finally:
        workers.stop()
        logger.info("shutdown complete")


app = FastAPI(
    title="RailFlow AI",
    version=settings.app_version,
    description=(
        "Smart, crash-resistant railway booking prototype: virtual waiting queue, "
        "transaction-safe seat allocation, idempotent payments and a live reliability "
        "dashboard. Fictional data, simulated payments."
    ),
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Request-ID", "X-Process-Time-Ms"],
)


@app.middleware("http")
async def observability_middleware(request: Request, call_next):
    rid = request.headers.get("X-Request-ID") or new_request_id()
    request.state.request_id = rid
    request.state.client_id = request.headers.get("X-Client-ID") or (
        request.client.host if request.client else "anonymous"
    )
    started = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:  # pragma: no cover - safety net, handlers below cover known cases
        logger.exception("unhandled error on %s %s", request.method, request.url.path)
        raise
    elapsed_ms = (time.perf_counter() - started) * 1000
    response.headers["X-Request-ID"] = rid
    response.headers["X-Process-Time-Ms"] = f"{elapsed_ms:.1f}"
    if request.url.path.startswith("/api") and request.url.path not in ("/api/health", "/api/health/live"):
        logger.info(
            "%s %s -> %s (%.0f ms) rid=%s",
            request.method,
            request.url.path,
            response.status_code,
            elapsed_ms,
            rid,
        )
    return response


@app.exception_handler(DomainError)
async def domain_error_handler(request: Request, exc: DomainError) -> JSONResponse:
    if exc.status_code >= 500:
        logger.error("domain error on %s: %s", request.url.path, exc.message)
    return JSONResponse(status_code=exc.status_code, content=exc.payload())


@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    return JSONResponse(
        status_code=422,
        content={
            "error": {
                "code": "validation_failed",
                "message": "The request payload is invalid.",
                "details": {"errors": exc.errors()},
            }
        },
    )


@app.exception_handler(Exception)
async def unhandled_error_handler(request: Request, exc: Exception) -> JSONResponse:  # pragma: no cover
    logger.exception("unhandled exception on %s", request.url.path)
    return JSONResponse(
        status_code=500,
        content={
            "error": {
                "code": "internal_error",
                "message": "An unexpected error occurred. The request was not applied.",
                "details": {},
            }
        },
    )


api_routers = (health.router, catalog.router, queue.router, reservations.router, payments.router, admin.router, simulations.router)
for api_router in api_routers:
    app.include_router(api_router, prefix="/api")


@app.get("/", include_in_schema=False)
def root() -> dict:
    return {
        "name": settings.app_name,
        "version": settings.app_version,
        "docs": "/docs",
        "api_base": "/api",
        "demo_mode": settings.demo_mode,
        "disclaimer": "Independent hackathon prototype - fictional data, simulated payments.",
    }
