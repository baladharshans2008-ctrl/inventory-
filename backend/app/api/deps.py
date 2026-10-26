"""FastAPI dependencies: request identity, rate limiting, admin authorization."""

from __future__ import annotations

from fastapi import Header, HTTPException, Query, Request

from ..config import settings
from ..errors import Unauthorized
from ..services.cache import rate_limiter
from ..utils import request_id as new_request_id


def request_context(request: Request) -> dict:
    rid = request.headers.get("X-Request-ID") or new_request_id()
    request.state.request_id = rid
    client = request.headers.get("X-Client-ID") or (request.client.host if request.client else "anonymous")
    request.state.client_id = client
    return {"request_id": rid, "client_id": client}


def client_id(request: Request) -> str:
    return getattr(request.state, "client_id", None) or (
        request.client.host if request.client else "anonymous"
    )


def current_request_id(request: Request) -> str | None:
    return getattr(request.state, "request_id", None)


def enforce_rate_limit(request: Request) -> None:
    allowed, remaining = rate_limiter.check(client_id(request))
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail={
                "error": {
                    "code": "rate_limited",
                    "message": "Too many requests from this client. Please slow down.",
                    "details": {"limit_per_minute": settings.rate_limit_per_minute},
                }
            },
            headers={"Retry-After": "30"},
        )


def require_admin(
    request: Request,
    x_admin_key: str | None = Header(default=None, alias="X-Admin-Key"),
    key: str | None = Query(default=None, description="Admin key (used by SSE clients that cannot set headers)"),
) -> None:
    """Administrative endpoints require the configured demo admin key."""
    supplied = x_admin_key or key
    if not supplied or supplied != settings.admin_api_key:
        raise Unauthorized(
            "A valid admin key is required for this operation",
            details={"header": "X-Admin-Key"},
        )
