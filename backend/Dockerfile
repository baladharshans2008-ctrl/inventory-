FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# PostgreSQL (psycopg) + Redis drivers are optional extras, installed here so the
# container uses the real backends instead of the SQLite / in-process fallback.
COPY requirements.txt requirements-optional.txt ./
RUN pip install -r requirements.txt -r requirements-optional.txt

COPY app ./app

EXPOSE 8000

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
