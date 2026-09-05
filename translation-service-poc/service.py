"""HTTP API and bounded asynchronous job manager for the translation POC."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import re
import tempfile
import threading
import time
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse

try:  # Works both as ``uvicorn service:app`` and as a package import in tests.
    from .pipeline import PIPELINE_VERSION, PipelineStats, TranslationPipeline
except ImportError:  # pragma: no cover - direct script/module execution path
    from pipeline import PIPELINE_VERSION, PipelineStats, TranslationPipeline

LOG = logging.getLogger("translation-service")
KEY_RE = re.compile(r"^[0-9a-f]{64}$")
SAFE_META_RE = re.compile(r"^[\w.:-]{1,128}$", re.UNICODE)
RASTER_MIMES = frozenset(
    {
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/webp",
        "image/gif",
        "image/bmp",
        "image/tiff",
        "image/avif",
    }
)


class QueueFullError(RuntimeError):
    """Raised when the bounded service queue cannot accept another page."""


@dataclass(frozen=True)
class ServiceConfig:
    cache_dir: Path
    workers: int = 2
    max_inflight: int = 8
    max_upload_bytes: int = 25 * 1024 * 1024
    max_pixels: int = 20_000_000
    inline_wait_ms: int = 1800
    job_ttl_seconds: int = 3600
    result_max_age_seconds: int = 86400
    service_token: str = ""

    @classmethod
    def from_env(cls, cache_dir: str | Path | None = None) -> ServiceConfig:
        def integer(name: str, default: int, minimum: int, maximum: int) -> int:
            try:
                value = int(os.getenv(name, str(default)))
            except (TypeError, ValueError):
                value = default
            return max(minimum, min(maximum, value))

        root = Path(cache_dir or os.getenv("TRANSLATION_CACHE_DIR", "./cache")).expanduser()
        workers = integer("TRANSLATION_WORKERS", 2, 1, 8)
        # max_inflight includes running and executor-queued jobs.  It is a
        # hard admission limit; ThreadPoolExecutor itself has an unbounded
        # internal queue, so we must enforce this before submit().
        max_inflight = integer("TRANSLATION_MAX_INFLIGHT", workers + 6, workers, 64)
        return cls(
            cache_dir=root,
            workers=workers,
            max_inflight=max_inflight,
            max_upload_bytes=integer("TRANSLATION_MAX_UPLOAD_BYTES", 25 * 1024 * 1024, 64 * 1024, 100 * 1024 * 1024),
            max_pixels=integer("TRANSLATION_MAX_PIXELS", 20_000_000, 100_000, 100_000_000),
            inline_wait_ms=integer("TRANSLATION_INLINE_WAIT_MS", 1800, 0, 5000),
            job_ttl_seconds=integer("TRANSLATION_JOB_TTL_SECONDS", 3600, 60, 7 * 24 * 3600),
            result_max_age_seconds=integer("TRANSLATION_RESULT_MAX_AGE_SECONDS", 86400, 60, 30 * 24 * 3600),
            service_token=os.getenv("TRANSLATION_SERVICE_TOKEN", ""),
        )


@dataclass
class JobRecord:
    job_id: str
    cache_key: str
    source_sha256: str
    metadata: dict[str, str]
    source: bytes
    status: str = "queued"
    created_at: float = 0.0
    updated_at: float = 0.0
    stats: dict[str, Any] | None = None
    error: str | None = None
    future: Future[Any] | None = None


class TranslationJobManager:
    """Deduplicating, bounded, in-process job manager.

    The POC deliberately keeps the queue in one process.  It is enough for a
    single translation worker and makes the first deployment easy to operate.
    Redis/Celery can replace this class later while preserving the HTTP shape.
    """

    def __init__(self, config: ServiceConfig, pipeline: TranslationPipeline | Any | None = None) -> None:
        self.config = config
        self.config.cache_dir.mkdir(parents=True, exist_ok=True)
        self.results_dir = self.config.cache_dir / "results"
        self.manifests_dir = self.config.cache_dir / "manifests"
        self.results_dir.mkdir(parents=True, exist_ok=True)
        self.manifests_dir.mkdir(parents=True, exist_ok=True)
        self.pipeline = pipeline or TranslationPipeline(max_pixels=config.max_pixels)
        self.executor = ThreadPoolExecutor(max_workers=config.workers, thread_name_prefix="translation")
        self._lock = threading.RLock()
        self._jobs: dict[str, JobRecord] = {}
        self._inflight: dict[str, JobRecord] = {}
        self._closed = False
        self._warmup_error: str | None = None

    @property
    def pipeline_version(self) -> str:
        return str(getattr(self.pipeline, "version", PIPELINE_VERSION))

    def result_path(self, cache_key: str) -> Path:
        if not KEY_RE.fullmatch(cache_key):
            raise ValueError("invalid cache key")
        return self.results_dir / f"{cache_key}.webp"

    def manifest_path(self, cache_key: str) -> Path:
        if not KEY_RE.fullmatch(cache_key):
            raise ValueError("invalid cache key")
        return self.manifests_dir / f"{cache_key}.json"

    def _cache_key(self, source: bytes, target_lang: str) -> tuple[str, str]:
        source_sha = hashlib.sha256(source).hexdigest()
        identity = {
            "sourceSha256": source_sha,
            "targetLang": target_lang,
            "pipelineVersion": self.pipeline_version,
        }
        encoded = json.dumps(identity, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest(), source_sha

    def _read_cached(self, cache_key: str, source_sha: str, metadata: dict[str, str]) -> dict[str, Any] | None:
        output_path = self.result_path(cache_key)
        manifest_path = self.manifest_path(cache_key)
        try:
            if not output_path.is_file() or output_path.stat().st_size <= 0 or not manifest_path.is_file():
                return None
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            if (
                manifest.get("status") != "ready"
                or manifest.get("sourceSha256") != source_sha
                or manifest.get("pipelineVersion") != self.pipeline_version
            ):
                return None
            stats = manifest.get("stats") if isinstance(manifest.get("stats"), dict) else None
        except (OSError, ValueError, TypeError):
            return None
        return {
            "status": "ready",
            "cacheKey": cache_key,
            "sourceSha256": source_sha,
            "imageUrl": f"/v1/results/{cache_key}.webp",
            "cacheHit": True,
            "stats": stats,
            "metadata": metadata,
        }

    def submit(self, source: bytes, metadata: dict[str, str]) -> dict[str, Any]:
        target_lang = metadata.get("targetLang", "zh-CN")
        cache_key, source_sha = self._cache_key(source, target_lang)
        with self._lock:
            cached = self._read_cached(cache_key, source_sha, metadata)
            if cached is not None:
                return cached
            existing = self._inflight.get(cache_key)
            if existing is not None:
                return self.snapshot(existing)
            if self._closed or len(self._inflight) >= self.config.max_inflight:
                raise QueueFullError("translation queue is full")
            now = time.time()
            job = JobRecord(
                job_id=uuid.uuid4().hex,
                cache_key=cache_key,
                source_sha256=source_sha,
                metadata=dict(metadata),
                source=source,
                created_at=now,
                updated_at=now,
            )
            self._jobs[job.job_id] = job
            self._inflight[cache_key] = job
            try:
                job.future = self.executor.submit(self._run, job)
            except Exception:
                self._jobs.pop(job.job_id, None)
                self._inflight.pop(cache_key, None)
                raise
            self._prune_jobs_locked()
            return self.snapshot(job)

    def _run(self, job: JobRecord) -> None:
        with self._lock:
            if self._closed:
                job.status = "error"
                job.error = "service_shutting_down"
                job.updated_at = time.time()
                job.source = b""
                self._inflight.pop(job.cache_key, None)
                return
            job.status = "processing"
            job.updated_at = time.time()
        try:
            output, stats = self.pipeline.process(job.source)
            self._write_cache(job, output, stats)
            stats_dict = stats.as_dict() if isinstance(stats, PipelineStats) else dict(stats or {})
            with self._lock:
                job.stats = stats_dict
                job.status = "ready"
                job.updated_at = time.time()
                job.source = b""  # release the queued upload as soon as it is cached
        except Exception:  # never expose traceback or source bytes to clients
            LOG.exception("translation job failed id=%s key=%s", job.job_id, job.cache_key)
            with self._lock:
                job.status = "error"
                job.error = "translation_failed"
                job.updated_at = time.time()
                job.source = b""
        finally:
            with self._lock:
                self._inflight.pop(job.cache_key, None)

    def _write_cache(self, job: JobRecord, output: bytes, stats: PipelineStats | dict[str, Any]) -> None:
        output_path = self.result_path(job.cache_key)
        manifest_path = self.manifest_path(job.cache_key)
        stats_dict = stats.as_dict() if isinstance(stats, PipelineStats) else dict(stats or {})
        manifest = {
            "status": "ready",
            "cacheKey": job.cache_key,
            "sourceSha256": job.source_sha256,
            "pipelineVersion": self.pipeline_version,
            "targetLang": job.metadata.get("targetLang", "zh-CN"),
            "metadata": job.metadata,
            "stats": stats_dict,
            "completedAt": time.time(),
        }
        # os.replace is atomic on the same filesystem.  Separate temporary
        # names prevent a client from ever seeing a partial WebP or JSON file.
        output_tmp: str | None = None
        manifest_tmp: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="wb", prefix=f".{job.cache_key}.", suffix=".tmp", dir=self.results_dir, delete=False
            ) as handle:
                output_tmp = handle.name
                handle.write(output)
                handle.flush()
                os.fsync(handle.fileno())
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", prefix=f".{job.cache_key}.", suffix=".tmp", dir=self.manifests_dir, delete=False
            ) as handle:
                manifest_tmp = handle.name
                json.dump(manifest, handle, ensure_ascii=False, separators=(",", ":"))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(output_tmp, output_path)
            output_tmp = None
            os.replace(manifest_tmp, manifest_path)
            manifest_tmp = None
        finally:
            for temporary in (output_tmp, manifest_tmp):
                if temporary:
                    try:
                        os.unlink(temporary)
                    except OSError:
                        pass

    def snapshot(self, job: JobRecord) -> dict[str, Any]:
        with self._lock:
            result: dict[str, Any] = {
                "status": job.status,
                "jobId": job.job_id,
                "cacheKey": job.cache_key,
                "sourceSha256": job.source_sha256,
                "metadata": dict(job.metadata),
                "createdAt": job.created_at,
                "updatedAt": job.updated_at,
            }
            if job.status == "ready":
                result["imageUrl"] = f"/v1/results/{job.cache_key}.webp"
                result["cacheHit"] = False
                if job.stats is not None:
                    result["stats"] = job.stats
            elif job.status in {"queued", "processing"}:
                result["pollAfterMs"] = 250
            elif job.status == "error":
                result["error"] = job.error or "translation_failed"
            return result

    def get(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            return self.snapshot(job)

    def health(self) -> dict[str, Any]:
        with self._lock:
            queued = sum(1 for job in self._inflight.values() if job.status == "queued")
            processing = sum(1 for job in self._inflight.values() if job.status == "processing")
            return {
                "ok": not self._closed,
                "ready": not self._closed and self._warmup_error is None,
                "pipelineVersion": self.pipeline_version,
                "workers": self.config.workers,
                "inflight": len(self._inflight),
                "queued": queued,
                "processing": processing,
                "capacity": self.config.max_inflight,
                "ocrLoaded": bool(getattr(self.pipeline, "_ocr", None)),
                "warmupError": self._warmup_error,
            }

    def warmup(self) -> None:
        """Load the OCR model once during service startup when supported."""
        loader = getattr(self.pipeline, "_get_ocr", None)
        if callable(loader):
            try:
                loader()
                with self._lock:
                    self._warmup_error = None
            except Exception as exc:
                with self._lock:
                    self._warmup_error = type(exc).__name__
                raise

    def _prune_jobs_locked(self) -> None:
        now = time.time()
        ttl = self.config.job_ttl_seconds
        expired = [
            key
            for key, job in self._jobs.items()
            if job.cache_key not in self._inflight
            and now - job.updated_at > ttl
        ]
        for key in expired:
            self._jobs.pop(key, None)
        # Keep memory bounded even if a busy process completes many unique
        # pages inside the TTL window.
        if len(self._jobs) > 4096:
            completed = [job for job in self._jobs.values() if job.cache_key not in self._inflight]
            completed.sort(key=lambda item: item.updated_at)
            for job in completed[: max(0, len(self._jobs) - 4096)]:
                self._jobs.pop(job.job_id, None)

    def shutdown(self) -> None:
        with self._lock:
            self._closed = True
        self.executor.shutdown(wait=True, cancel_futures=False)


def _authorised(request: Request, token: str) -> bool:
    if not token:
        return True
    supplied = request.headers.get("authorization", "")
    if supplied.lower().startswith("bearer "):
        supplied = supplied[7:].strip()
    else:
        supplied = request.headers.get("x-translation-token", "")
    return bool(supplied) and hmac.compare_digest(supplied, token)


async def _read_limited(request: Request, limit: int) -> bytes:
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            length = int(content_length)
            if length < 0:
                raise ValueError
            if length > limit:
                raise HTTPException(status_code=413, detail="图片文件超过大小限制")
        except ValueError:
            raise HTTPException(status_code=400, detail="Content-Length 无效")
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            raise HTTPException(status_code=413, detail="图片文件超过大小限制")
        chunks.append(chunk)
    if not chunks:
        raise HTTPException(status_code=400, detail="请求体为空")
    return b"".join(chunks)


def _metadata(request: Request) -> dict[str, str]:
    query = request.query_params

    def value(name: str, header: str | None = None) -> str:
        raw = query.get(name)
        if raw is None and header:
            raw = request.headers.get(header)
        return str(raw or "").strip()

    target_lang = value("targetLang", "x-target-language") or "zh-CN"
    if target_lang != "zh-CN":
        raise HTTPException(status_code=400, detail="当前快速服务仅支持 targetLang=zh-CN")
    metadata = {
        "targetLang": target_lang,
        "aid": value("aid", "x-aid"),
        "photoId": value("photoId", "x-photo-id"),
        "pageIndex": value("pageIndex", "x-page-index"),
        "pipeline": value("pipeline", "x-pipeline") or "fast",
    }
    for key in ("aid", "photoId", "pageIndex", "pipeline"):
        if metadata[key] and not SAFE_META_RE.fullmatch(metadata[key]):
            raise HTTPException(status_code=400, detail=f"{key} 参数格式无效")
    if metadata["pipeline"] != "fast":
        raise HTTPException(status_code=400, detail="当前仅支持 pipeline=fast")
    expected_sha = value("sourceSha256", "x-source-sha256")
    if expected_sha:
        if not re.fullmatch(r"[0-9a-fA-F]{64}", expected_sha):
            raise HTTPException(status_code=400, detail="sourceSha256 参数格式无效")
        metadata["sourceSha256"] = expected_sha.lower()
    return metadata


def create_app(
    *, config: ServiceConfig | None = None, manager: TranslationJobManager | None = None
) -> FastAPI:
    service_config = config or (manager.config if manager is not None else ServiceConfig.from_env())
    service_manager = manager or TranslationJobManager(service_config)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        if os.getenv("TRANSLATION_WARMUP", "1").lower() not in {"0", "false", "no"}:
            try:
                await asyncio.to_thread(service_manager.warmup)
            except Exception:
                # Keep /healthz available even if an optional OCR model is
                # unavailable; the first request will return a generic job
                # error and operators can inspect the server log.
                LOG.exception("OCR warmup failed")
        yield
        service_manager.shutdown()

    app = FastAPI(title="JM Translation Service", version=PIPELINE_VERSION, lifespan=lifespan)
    app.state.translation_manager = service_manager

    def guard(request: Request) -> None:
        if not _authorised(request, service_config.service_token):
            raise HTTPException(status_code=401, detail="未授权")

    @app.get("/healthz")
    async def healthz() -> dict[str, Any]:
        return service_manager.health()

    @app.post("/v1/translate/page")
    async def translate_page(request: Request) -> JSONResponse:
        guard(request)
        content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if not (content_type in RASTER_MIMES or content_type == "application/octet-stream"):
            raise HTTPException(status_code=415, detail="请以 image/* 二进制上传图片")
        metadata = _metadata(request)
        source = await _read_limited(request, service_config.max_upload_bytes)
        supplied_sha = metadata.get("sourceSha256")
        if supplied_sha and supplied_sha != hashlib.sha256(source).hexdigest():
            raise HTTPException(status_code=400, detail="sourceSha256 与请求体不一致")
        wait_ms_raw = request.query_params.get("waitMs")
        try:
            wait_ms = service_config.inline_wait_ms if wait_ms_raw is None else max(0, min(5000, int(wait_ms_raw)))
        except ValueError:
            raise HTTPException(status_code=400, detail="waitMs 参数无效")
        try:
            submission = service_manager.submit(source, metadata)
        except QueueFullError:
            return JSONResponse(
                status_code=429,
                content={"status": "busy", "error": "translation_queue_full", "retryAfterMs": 2000},
                headers={"Retry-After": "2"},
            )
        job_id = submission.get("jobId")
        if job_id and submission.get("status") in {"queued", "processing"} and wait_ms:
            deadline = time.monotonic() + wait_ms / 1000
            while time.monotonic() < deadline:
                await asyncio.sleep(0.05)
                current = service_manager.get(job_id)
                if current is None:
                    break
                submission = current
                if current.get("status") in {"ready", "error"}:
                    break
        status_code = 200 if submission.get("status") == "ready" else 202
        headers = {"Retry-After": "1"} if status_code == 202 else {}
        return JSONResponse(status_code=status_code, content=submission, headers=headers)

    @app.get("/v1/jobs/{job_id}")
    async def get_job(job_id: str, request: Request) -> dict[str, Any]:
        guard(request)
        if not re.fullmatch(r"[0-9a-f]{32}", job_id):
            raise HTTPException(status_code=404, detail="任务不存在")
        snapshot = service_manager.get(job_id)
        if snapshot is None:
            raise HTTPException(status_code=404, detail="任务不存在")
        return snapshot

    @app.get("/v1/results/{cache_key}.webp")
    async def get_result(cache_key: str, request: Request) -> FileResponse:
        guard(request)
        if not KEY_RE.fullmatch(cache_key):
            raise HTTPException(status_code=404, detail="结果不存在")
        path = service_manager.result_path(cache_key)
        if not path.is_file():
            raise HTTPException(status_code=404, detail="结果不存在")
        return FileResponse(
            path,
            media_type="image/webp",
            headers={
                "Cache-Control": f"private, max-age={service_config.result_max_age_seconds}, immutable",
                "ETag": f'"{cache_key}"',
                "X-Translation-Pipeline": service_manager.pipeline_version,
            },
        )

    return app


app = create_app()


__all__ = ["ServiceConfig", "TranslationJobManager", "app", "create_app"]
