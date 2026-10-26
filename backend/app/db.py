"""Database engine, session factory and transactional helpers.

The database is the *source of truth* for seat ownership and booking status.
Redis (when configured) only accelerates rate limiting and queue caching.
"""

from __future__ import annotations

import logging
from contextlib import contextmanager
from typing import Iterator

from fastapi import Request
from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import settings

logger = logging.getLogger("railflow.db")


class Base(DeclarativeBase):
    pass


def _sqlite_connect_args() -> dict:
    return {"check_same_thread": False, "isolation_level": None, "timeout": 30}


def _configure_sqlite(engine: Engine, *, write_lock: bool = True) -> Engine:
    @event.listens_for(engine, "connect")
    def _set_pragmas(dbapi_conn, _record):  # pragma: no cover - driver level
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA busy_timeout=30000")
        cur.close()

    if not write_lock:
        # Read-only pool: leave the default *deferred* transaction alone so
        # readers never take SQLite's single writer lock. WAL mode lets these
        # reads run concurrently with the writers (workers / bookings).
        return engine

    # pysqlite normally starts a *deferred* transaction, which means two
    # concurrent "read available_seats -> write" sequences can interleave.
    # We run in autocommit mode and open every transaction as BEGIN IMMEDIATE,
    # which takes SQLite's single writer lock up-front. That makes the
    # check-and-allocate sequence atomic, the same guarantee PostgreSQL row
    # locks (SELECT ... FOR UPDATE) give us in production.
    @event.listens_for(engine, "begin")
    def _begin_immediate(conn):  # pragma: no cover - driver level
        conn.exec_driver_sql("BEGIN IMMEDIATE")

    return engine


def build_engine(url: str | None = None) -> tuple[Engine, str]:
    """Create the engine, falling back to SQLite if the driver is missing."""
    url = url or settings.database_url
    if url.startswith("sqlite"):
        engine = create_engine(
            url,
            future=True,
            connect_args=_sqlite_connect_args(),
            pool_size=20,
            max_overflow=60,
            pool_pre_ping=True,
        )
        return _configure_sqlite(engine), "sqlite"

    try:
        engine = create_engine(url, future=True, pool_pre_ping=True, pool_size=20, max_overflow=60)
        with engine.connect():
            pass
        return engine, "postgresql"
    except Exception as exc:  # driver missing / server unreachable
        logger.warning(
            "Database %s is unavailable (%s). Falling back to SQLite. "
            "This is a documented local fallback - see README.",
            url,
            exc,
        )
        engine = create_engine(
            "sqlite:///./railflow.db",
            future=True,
            connect_args=_sqlite_connect_args(),
            pool_size=20,
            max_overflow=60,
        )
        return _configure_sqlite(engine), "sqlite (fallback)"


engine, DB_BACKEND = build_engine()
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False, future=True)

IS_POSTGRES = engine.dialect.name == "postgresql"


def build_read_engine() -> Engine:
    """A read-only pool for pure-read paths (the dashboard SSE stream).

    On SQLite these connections use the default deferred transaction, so they
    never issue ``BEGIN IMMEDIATE`` and therefore never compete with the
    background workers for SQLite's single writer lock. PostgreSQL already
    gives us MVCC reads, so we simply reuse the main engine there.
    """
    if not DB_BACKEND.startswith("sqlite"):
        return engine
    url = settings.database_url if settings.database_url.startswith("sqlite") else "sqlite:///./railflow.db"
    read_engine = create_engine(
        url,
        future=True,
        connect_args=_sqlite_connect_args(),
        pool_size=10,
        max_overflow=30,
        pool_pre_ping=True,
    )
    return _configure_sqlite(read_engine, write_lock=False)


read_engine = build_read_engine()
ReadSessionLocal = sessionmaker(bind=read_engine, expire_on_commit=False, future=True)


def init_db() -> None:
    from . import models  # noqa: F401  (register mappers)

    Base.metadata.create_all(bind=engine)


def get_db(request: Request) -> Iterator[Session]:
    """FastAPI dependency - one session per request."""
    session = SessionLocal()
    try:
        request.state.db = session
        yield session
    finally:
        session.close()


@contextmanager
def session_scope() -> Iterator[Session]:
    """Standalone session for background workers / simulations."""
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


@contextmanager
def read_session_scope() -> Iterator[Session]:
    """Read-only session: no write transaction (no ``BEGIN IMMEDIATE``)."""
    session = ReadSessionLocal()
    try:
        yield session
    finally:
        session.close()


def db_health() -> dict:
    try:
        with read_engine.connect() as conn:
            conn.exec_driver_sql("SELECT 1")
        return {"status": "operational", "backend": DB_BACKEND, "simulated": False}
    except Exception as exc:  # pragma: no cover
        return {"status": "down", "backend": DB_BACKEND, "error": str(exc), "simulated": False}
