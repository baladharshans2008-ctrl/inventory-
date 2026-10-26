"""Optional Redis-backed cache.

Redis is used for rate limiting and queue caching only. When it is not
configured (or unreachable) an in-process, thread-safe fallback is used and
reported as such in the dashboard - the app never pretends Redis is present.
"""

from __future__ import annotations

import threading
import time
from collections import defaultdict

from ..config import settings


class _MemoryBackend:
    name = "in-process memory (fallback)"

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._hits: dict[str, tuple[int, float]] = {}
        self._values: dict[str, tuple[object, float | None]] = {}

    def incr(self, key: str, window_seconds: float) -> int:
        now = time.time()
        with self._lock:
            count, expires = self._hits.get(key, (0, now + window_seconds))
            if now >= expires:
                count, expires = 0, now + window_seconds
            count += 1
            self._hits[key] = (count, expires)
            if len(self._hits) > 20000:  # keep memory bounded
                self._hits = {k: v for k, v in self._hits.items() if v[1] > now}
            return count

    def set(self, key: str, value: object, ttl: float | None = None) -> None:
        with self._lock:
            self._values[key] = (value, time.time() + ttl if ttl else None)

    def get(self, key: str):
        with self._lock:
            item = self._values.get(key)
            if item is None:
                return None
            value, expires = item
            if expires and time.time() > expires:
                self._values.pop(key, None)
                return None
            return value

    def info(self) -> dict:
        return {"backend": self.name, "simulated": False, "connected": True, "mode": "fallback"}


class _RedisBackend:
    name = "redis"

    def __init__(self, client) -> None:
        self._client = client
        self._local = _MemoryBackend()

    def incr(self, key: str, window_seconds: float) -> int:
        try:
            pipe = self._client.pipeline()
            pipe.incr(key)
            pipe.expire(key, int(window_seconds))
            return int(pipe.execute()[0])
        except Exception:
            return self._local.incr(key, window_seconds)

    def set(self, key: str, value: object, ttl: float | None = None) -> None:
        try:
            self._client.set(key, str(value), ex=int(ttl) if ttl else None)
        except Exception:
            self._local.set(key, value, ttl)

    def get(self, key: str):
        try:
            return self._client.get(key)
        except Exception:
            return self._local.get(key)

    def info(self) -> dict:
        try:
            self._client.ping()
            return {"backend": self.name, "connected": True, "simulated": False, "mode": "redis"}
        except Exception as exc:
            return {"backend": self.name, "connected": False, "error": str(exc), "mode": "redis"}


class Cache:
    def __init__(self) -> None:
        self._backend = _MemoryBackend()
        if settings.redis_url:
            try:  # pragma: no cover - depends on a live Redis
                import redis  # type: ignore

                client = redis.Redis.from_url(settings.redis_url, socket_connect_timeout=1.5, decode_responses=True)
                client.ping()
                self._backend = _RedisBackend(client)
            except Exception:
                self._backend = _MemoryBackend()

    @property
    def backend(self):
        return self._backend

    def incr(self, key: str, window_seconds: float) -> int:
        return self._backend.incr(key, window_seconds)

    def set(self, key: str, value: object, ttl: float | None = None) -> None:
        self._backend.set(key, value, ttl)

    def get(self, key: str):
        return self._backend.get(key)

    def info(self) -> dict:
        return self._backend.info()


cache = Cache()


class RateLimiter:
    """Fixed-window limiter. Redis when available, memory otherwise."""

    def __init__(self, limit_per_minute: int) -> None:
        self.limit = limit_per_minute
        self._blocked: dict[str, int] = defaultdict(int)

    def check(self, client_id: str) -> tuple[bool, int]:
        window = 60.0
        bucket = int(time.time() // window)
        key = f"ratelimit:{client_id}:{bucket}"
        count = cache.incr(key, window)
        allowed = count <= self.limit
        remaining = max(0, self.limit - count)
        if not allowed:
            self._blocked[client_id] += 1
        return allowed, remaining

    @property
    def blocked_total(self) -> int:
        return sum(self._blocked.values())


rate_limiter = RateLimiter(settings.rate_limit_per_minute)
