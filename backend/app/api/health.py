"""Health and readiness endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..config import settings
from ..db import DB_BACKEND, db_health, get_db
from ..services.cache import cache
from ..services.metrics import service_health
from ..services.workers import workers
from ..utils import utcnow

router = APIRouter(tags=["health"])


@router.get("/health")
def health(db: Session = Depends(get_db)) -> dict:
    db_info = db_health()
    ok = db_info["status"] == "operational"
    return {
        "status": "ok" if ok else "degraded",
        "app": settings.app_name,
        "version": settings.app_version,
        "time": utcnow().isoformat(),
        "demo_mode": settings.demo_mode,
        "components": {
            "database": db_info,
            "cache": cache.info(),
            "workers": {
                "running": bool(workers._threads),
                "loops": workers.state,
                "simulated": False,
            },
            "simulation_engine": {"status": "available", "simulated": True},
        },
        "checks": service_health(db),
    }


@router.get("/health/live")
def liveness() -> dict:
    return {"status": "alive", "backend": DB_BACKEND}
