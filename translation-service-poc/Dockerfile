# 基础镜像固定到生产已验证的补丁版本与 Debian 发行版，升级时显式修改。
ARG PYTHON_IMAGE=python:3.12.14-slim-trixie
FROM ${PYTHON_IMAGE}

ARG DEBIAN_MIRROR_HOST=deb.debian.org
ARG PYPI_INDEX_URL=https://pypi.org/simple

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    TRANSLATION_CACHE_DIR=/app/cache

RUN sed -i "s|deb.debian.org|${DEBIAN_MIRROR_HOST}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends libglib2.0-0 libgl1 libgomp1 fonts-wqy-zenhei \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# requirements.txt 声明直接依赖范围，constraints.txt 锁定含传递依赖的实际版本。
COPY requirements.txt constraints.txt ./
RUN pip install --no-cache-dir --index-url "${PYPI_INDEX_URL}" -r requirements.txt -c constraints.txt

COPY pipeline.py service.py ./
RUN useradd --create-home --uid 10001 appuser \
    && mkdir -p /app/cache \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 8091
# Keep one uvicorn process: the in-process queue/cache is intentionally single
# owner.  Scale by running another service instance with a shared object store
# only after adding a distributed job backend.  --limit-concurrency 为应用层
# 闸门（上传准入 + max_inflight）之外的总连接护栏；keep-alive 超时回收空闲连接。
CMD ["uvicorn", "service:app", "--host", "0.0.0.0", "--port", "8091", "--workers", "1", "--limit-concurrency", "64", "--timeout-keep-alive", "30"]
