"""Domain errors mapped to safe HTTP responses."""

from __future__ import annotations


class DomainError(Exception):
    status_code = 400
    code = "domain_error"

    def __init__(self, message: str, *, details: dict | None = None):
        super().__init__(message)
        self.message = message
        self.details = details or {}

    def payload(self) -> dict:
        return {
            "error": {
                "code": self.code,
                "message": self.message,
                "details": self.details,
            }
        }


class ValidationFailure(DomainError):
    status_code = 422
    code = "validation_failed"


class NotFound(DomainError):
    status_code = 404
    code = "not_found"


class SeatUnavailable(DomainError):
    """The requested seats are already held/confirmed by someone else."""

    status_code = 409
    code = "seat_unavailable"


class QueueRequired(DomainError):
    """Booking service is saturated - the request must join the queue first."""

    status_code = 429
    code = "queue_admission_required"


class QueueNotReady(DomainError):
    status_code = 409
    code = "queue_not_ready"


class IdempotencyConflict(DomainError):
    status_code = 409
    code = "idempotency_conflict"


class RateLimited(DomainError):
    status_code = 429
    code = "rate_limited"


class Unauthorized(DomainError):
    status_code = 401
    code = "unauthorized"
