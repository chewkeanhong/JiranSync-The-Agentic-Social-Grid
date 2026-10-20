# JiranSync — one command to a running township.
#
#     docker compose up      →  http://localhost:8000
#
# No database server or broker to stand up: the township is baked into GeoJSON, and
# community state (residents, tasks, the credit ledger) lives in one SQLite file seeded
# on first start. Set ANTHROPIC_API_KEY to let Claude do task understanding; without
# it the rule-based engine answers and the app works offline.

FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so editing source does not re-resolve the wheel set.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY jiransync/ jiransync/
COPY data/ data/
COPY web/ web/

ENV PYTHONUNBUFFERED=1 \
    JIRANSYNC_DATA=/app/data

EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/api/world > /dev/null || exit 1

CMD ["python", "-m", "uvicorn", "jiransync.server:app", \
     "--host", "0.0.0.0", "--port", "8000"]
