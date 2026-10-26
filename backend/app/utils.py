"""Small shared helpers (ids, clocks, JSON encoding)."""

from __future__ import annotations

import json
import random
import string
import uuid
from datetime import datetime, timezone


def utcnow() -> datetime:
    """Naive UTC timestamp with microsecond precision.

    Stored naive on purpose: SQLite drops tzinfo and mixing aware/naive
    datetimes is a classic source of bugs. Everything in RailFlow is UTC.

    Precision matters: hold windows, payment reconciliation deadlines and
    expiry sweeps compare timestamps directly, so flooring to the second would
    add up to a second of error to every deadline.
    """
    return datetime.now(timezone.utc).replace(tzinfo=None)


def new_id() -> str:
    return uuid.uuid4().hex


def request_id() -> str:
    return "req_" + uuid.uuid4().hex[:16]


def pnr() -> str:
    return "RF" + "".join(random.choices(string.digits, k=8))


def queue_token() -> str:
    return "q_" + uuid.uuid4().hex[:14]


def dumps(value) -> str:
    return json.dumps(value, default=str, separators=(",", ":"))
