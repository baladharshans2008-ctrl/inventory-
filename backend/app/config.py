"""Application configuration.

All values can be overridden through environment variables / backend/.env.
No secret is hardcoded: the defaults below are development-only values that
are loudly documented in the README.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)

    app_name: str = "RailFlow AI"
    app_version: str = "1.0.0"
    demo_mode: bool = True

    # --- data stores ----------------------------------------------------
    # Authoritative seat inventory lives in PostgreSQL in production; the
    # local fallback is SQLite (same code path, same transactional guarantees
    # within a single writer). See README -> "Fallbacks".
    database_url: str = "sqlite:///./railflow.db"
    redis_url: str | None = None

    # --- virtual queue --------------------------------------------------
    queue_capacity: int = 40
    queue_admission_rate: int = 12
    queue_entry_ttl_seconds: int = 900

    # --- reservations ---------------------------------------------------
    hold_minutes: int = 10
    idempotency_ttl_minutes: int = 1440

    # --- rate limiting --------------------------------------------------
    rate_limit_per_minute: int = 600

    # --- background workers --------------------------------------------
    expiry_interval_seconds: int = 2
    reconciliation_interval_seconds: int = 3
    reconciliation_stale_seconds: int = 12
    run_workers: bool = True

    # --- security -------------------------------------------------------
    admin_api_key: str = "railflow-demo-admin-key"
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173"

    # --- simulation -----------------------------------------------------
    random_seed: int = 20260214
    sim_max_concurrent_requests: int = 300
    sim_max_seats: int = 300

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def is_sqlite(self) -> bool:
        return self.database_url.startswith("sqlite")


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
