FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    TRANSLATION_CACHE_DIR=/app/cache

RUN apt-get update \
    && apt-get install -y --no-install-recommends libglib2.0-0 libgl1 libgomp1 fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY pipeline.py service.py ./
RUN useradd --create-home --uid 10001 appuser \
    && mkdir -p /app/cache \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 8091
# Keep one uvicorn process: the in-process queue/cache is intentionally single
# owner.  Scale by running another service instance with a shared object store
# only after adding a distributed job backend.
CMD ["uvicorn", "service:app", "--host", "0.0.0.0", "--port", "8091", "--workers", "1"]
