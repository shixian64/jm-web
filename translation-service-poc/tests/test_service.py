from __future__ import annotations

import asyncio
import io
import sys
import time
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from PIL import Image

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

from pipeline import PipelineStats
from service import ServiceConfig, TranslationJobManager, create_app


def image_bytes(color=(255, 255, 255)) -> bytes:
    image = Image.new("RGB", (32, 32), color)
    stream = io.BytesIO()
    image.save(stream, format="PNG")
    return stream.getvalue()


class FakePipeline:
    version = "fake-v1"

    def __init__(self, delay: float = 0.0):
        self.delay = delay

    def process(self, source: bytes):
        if self.delay:
            time.sleep(self.delay)
        # Return a valid WebP so the result route can be tested end-to-end.
        result = io.BytesIO()
        Image.open(io.BytesIO(source)).save(result, format="WEBP", quality=90)
        stats = PipelineStats(width=32, height=32, output_bytes=len(result.getvalue()), total_ms=1.0)
        return result.getvalue(), stats


def make_client(tmp_path, *, delay=0.0, token="secret", inline_wait_ms=1000, max_inflight=2):
    config = ServiceConfig(
        cache_dir=tmp_path,
        workers=1,
        max_inflight=max_inflight,
        inline_wait_ms=inline_wait_ms,
        service_token=token,
    )
    manager = TranslationJobManager(config, pipeline=FakePipeline(delay))
    app = create_app(config=config, manager=manager)
    return TestClient(app)


def test_health_is_public_but_translation_requires_token(tmp_path):
    with make_client(tmp_path) as client:
        response = client.get("/healthz")
        assert response.status_code == 200
        assert response.json()["ok"] is True
        denied = client.post("/v1/translate/page", content=image_bytes(), headers={"Content-Type": "image/png"})
        assert denied.status_code == 401


def test_ready_result_cache_and_etag(tmp_path):
    with make_client(tmp_path) as client:
        headers = {"Authorization": "Bearer secret", "Content-Type": "image/png"}
        first = client.post(
            "/v1/translate/page?aid=1&photoId=2&pageIndex=3&waitMs=1000",
            content=image_bytes(),
            headers=headers,
        )
        assert first.status_code == 200
        payload = first.json()
        assert payload["status"] == "ready"
        assert payload["imageUrl"].startswith("/v1/results/")
        cache_key = payload["cacheKey"]

        result = client.get(payload["imageUrl"], headers={"Authorization": "Bearer secret"})
        assert result.status_code == 200
        assert result.headers["content-type"].startswith("image/webp")
        assert result.headers["etag"] == f'"{cache_key}"'

        second = client.post(
            "/v1/translate/page?waitMs=0",
            content=image_bytes(),
            headers=headers,
        )
        assert second.status_code == 200
        assert second.json()["cacheHit"] is True
        assert second.json()["cacheKey"] == cache_key


def test_queued_job_can_be_polled(tmp_path):
    # First request occupies the sole worker; the second one is admitted but
    # returns 202 immediately and can be observed through the job endpoint.
    with make_client(tmp_path, delay=0.25, inline_wait_ms=0, max_inflight=2) as client:
        headers = {"Authorization": "Bearer secret", "Content-Type": "image/png"}
        first = client.post("/v1/translate/page?waitMs=0", content=image_bytes((1, 2, 3)), headers=headers)
        second = client.post("/v1/translate/page?waitMs=0", content=image_bytes((4, 5, 6)), headers=headers)
        third = client.post("/v1/translate/page?waitMs=0", content=image_bytes((7, 8, 9)), headers=headers)
        assert first.status_code == 202
        assert second.status_code == 202
        assert third.status_code == 429
        job_id = second.json()["jobId"]
        deadline = time.time() + 3
        status = None
        while time.time() < deadline:
            status = client.get(f"/v1/jobs/{job_id}", headers={"Authorization": "Bearer secret"}).json()
            if status["status"] == "ready":
                break
            time.sleep(0.03)
        assert status is not None and status["status"] == "ready"


def test_duplicate_inflight_uploads_share_one_job(tmp_path):
    with make_client(tmp_path, delay=0.2, inline_wait_ms=0) as client:
        headers = {"Authorization": "Bearer secret", "Content-Type": "image/png"}
        body = image_bytes((12, 34, 56))
        first = client.post("/v1/translate/page?waitMs=0", content=body, headers=headers).json()
        second = client.post("/v1/translate/page?waitMs=0", content=body, headers=headers).json()
        assert first["jobId"] == second["jobId"]


def test_limits_and_sha_validation(tmp_path):
    with make_client(tmp_path) as client:
        headers = {"Authorization": "Bearer secret", "Content-Type": "text/plain"}
        assert client.post("/v1/translate/page", content=b"x", headers=headers).status_code == 415
        headers["Content-Type"] = "image/png"
        headers["X-Source-SHA256"] = "0" * 64
        assert client.post("/v1/translate/page", content=image_bytes(), headers=headers).status_code == 400


def test_empty_upload_is_rejected_before_submission(tmp_path):
    with make_client(tmp_path) as client:
        response = client.post(
            "/v1/translate/page?waitMs=0", content=b"",
            headers={"Authorization": "Bearer secret", "Content-Type": "image/png"},
        )
        assert response.status_code == 400
        assert not client.app.state.translation_manager._jobs


def test_non_ascii_bearer_is_unauthorised_not_server_error(tmp_path):
    with make_client(tmp_path) as client:
        denied = client.get("/v1/jobs/" + "a" * 32, headers={b"Authorization": b"Bearer \xc3\xa9"})
        assert denied.status_code == 401


class _SlowStreamRequest:
    """最小 Request 替身：headers + 逐块慢速异步流，用于直接测上传期限。"""

    def __init__(self, chunks, delay, headers=None):
        self.headers = headers or {}
        self._chunks = chunks
        self._delay = delay

    def stream(self):
        async def iterator():
            for chunk in self._chunks:
                await asyncio.sleep(self._delay)
                yield chunk

        return iterator()


def test_read_limited_enforces_upload_deadline():
    from service import _read_limited

    request = _SlowStreamRequest([b"a" * 1024] * 50, delay=0.05)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(_read_limited(request, limit=1024 * 1024, timeout_seconds=0.1))
    assert exc.value.status_code == 408


def test_empty_token_disables_translation_but_keeps_liveness(tmp_path):
    config = ServiceConfig(cache_dir=tmp_path, workers=1, service_token="")
    manager = TranslationJobManager(config, pipeline=FakePipeline())
    app = create_app(config=config, manager=manager)
    with TestClient(app) as client:
        health = client.get("/healthz")
        assert health.status_code == 200
        assert health.json()["auth"] == "disabled"
        ready = client.get("/readyz")
        assert ready.status_code == 200, "空 token 属部署选择，不得阻断整站启动"
        disabled = client.post(
            "/v1/translate/page", content=image_bytes(), headers={"Content-Type": "image/png"}
        )
        assert disabled.status_code == 503
        assert disabled.json()["detail"].startswith("翻译服务未配置访问令牌")


def test_strict_mode_refuses_to_start_without_token(tmp_path, monkeypatch):
    config = ServiceConfig(cache_dir=tmp_path, workers=1, service_token="")
    manager = TranslationJobManager(config, pipeline=FakePipeline())
    monkeypatch.setenv("TRANSLATION_REQUIRE_TOKEN", "1")
    app = create_app(config=config, manager=manager)
    with pytest.raises(RuntimeError, match="TRANSLATION_REQUIRE_TOKEN"):
        with TestClient(app):
            pass


def test_readyz_fails_and_translate_rejects_after_warmup_error(tmp_path):
    config = ServiceConfig(cache_dir=tmp_path, workers=1, service_token="secret")
    manager = TranslationJobManager(config, pipeline=FakePipeline())

    def broken_loader():
        raise RuntimeError("ocr model missing")

    manager.pipeline._get_ocr = broken_loader
    app = create_app(config=config, manager=manager)
    with TestClient(app) as client:
        # lifespan 已触发 warmup 并记录失败：liveness 仍 200，readiness 503。
        assert client.get("/healthz").status_code == 200
        ready = client.get("/readyz")
        assert ready.status_code == 503
        assert ready.json()["ready"] is False
        assert ready.json()["reason"] == "RuntimeError"
        rejected = client.post(
            "/v1/translate/page",
            content=image_bytes(),
            headers={"Authorization": "Bearer secret", "Content-Type": "image/png"},
        )
        assert rejected.status_code == 503
        assert "未就绪" in rejected.json()["detail"]


def test_upload_gate_returns_busy_when_exhausted(tmp_path):
    import httpx

    config = ServiceConfig(
        cache_dir=tmp_path, workers=1, service_token="secret",
        max_upload_connections=1, upload_wait_seconds=0.05,
    )
    manager = TranslationJobManager(config, pipeline=FakePipeline())
    app = create_app(config=config, manager=manager)

    async def scenario():
        # 与应用共享同一事件循环：真实占用闸门，验证 429 与释放后的恢复。
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            gate = app.state.translation_upload_gate
            assert gate is not None
            await gate.acquire()
            try:
                busy = await client.post(
                    "/v1/translate/page?waitMs=0",
                    content=image_bytes(),
                    headers={"Authorization": "Bearer secret", "Content-Type": "image/png"},
                )
                assert busy.status_code == 429
                assert busy.json()["error"] == "upload_queue_full"
            finally:
                gate.release()
            ok = await client.post(
                "/v1/translate/page?waitMs=0",
                content=image_bytes(),
                headers={"Authorization": "Bearer secret", "Content-Type": "image/png"},
            )
            assert ok.status_code in {200, 202}

    asyncio.run(scenario())


def test_zero_upload_wait_rejects_immediately_instead_of_waiting_forever(tmp_path):
    import httpx

    config = ServiceConfig(
        cache_dir=tmp_path, workers=1, service_token="secret",
        max_upload_connections=1, upload_wait_seconds=0,
    )
    manager = TranslationJobManager(config, pipeline=FakePipeline())
    app = create_app(config=config, manager=manager)

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            gate = app.state.translation_upload_gate
            await gate.acquire()
            try:
                response = await asyncio.wait_for(client.post(
                    "/v1/translate/page?waitMs=0", content=image_bytes(),
                    headers={"Authorization": "Bearer secret", "Content-Type": "image/png"},
                ), timeout=0.2)
                assert response.status_code == 429
            finally:
                gate.release()

    try:
        asyncio.run(scenario())
    finally:
        manager.shutdown()


def test_upload_waiter_count_is_bounded_and_cancelled_waiters_are_removed(tmp_path):
    import httpx

    config = ServiceConfig(
        cache_dir=tmp_path, workers=1, service_token="secret",
        max_upload_connections=1, max_upload_waiters=1, upload_wait_seconds=5,
    )
    manager = TranslationJobManager(config, pipeline=FakePipeline())
    app = create_app(config=config, manager=manager)

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            gate = app.state.translation_upload_gate
            headers = {"Authorization": "Bearer secret", "Content-Type": "image/png"}
            await gate.acquire()
            waiting = asyncio.create_task(client.post(
                "/v1/translate/page?waitMs=0", content=image_bytes(), headers=headers,
            ))
            try:
                for _ in range(100):
                    if gate.waiting:
                        break
                    await asyncio.sleep(0.001)
                assert gate.waiting == 1
                busy = await asyncio.wait_for(client.post(
                    "/v1/translate/page?waitMs=0", content=image_bytes(), headers=headers,
                ), timeout=0.2)
                assert busy.status_code == 429
                assert busy.json()["error"] == "upload_queue_full"
                assert gate.waiting == 1
            finally:
                waiting.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await waiting
                gate.release()
            assert gate.waiting == 0
            ok = await client.post("/v1/translate/page?waitMs=0", content=image_bytes(), headers=headers)
            assert ok.status_code in {200, 202}

    try:
        asyncio.run(scenario())
    finally:
        manager.shutdown()


def test_inline_waiter_releases_its_duplicate_upload(tmp_path, monkeypatch):
    import httpx
    import weakref
    import service

    config = ServiceConfig(cache_dir=tmp_path, workers=1, service_token="secret")
    manager = TranslationJobManager(config, pipeline=FakePipeline())
    app = create_app(config=config, manager=manager)
    references = []

    class UploadBytes(bytearray):
        pass

    async def read_upload(*_args):
        source = UploadBytes(b"duplicate image upload")
        references.append(weakref.ref(source))
        return source

    monkeypatch.setattr(service, "_read_limited", read_upload)
    monkeypatch.setattr(manager, "submit", lambda *_args: {"status": "processing", "jobId": "a" * 32})
    monkeypatch.setattr(manager, "get", lambda _job_id: {"status": "ready"})

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            request = asyncio.create_task(client.post(
                "/v1/translate/page?waitMs=1000", content=b"image",
                headers={"Authorization": "Bearer secret", "Content-Type": "image/png"},
            ))
            try:
                for _ in range(100):
                    if references:
                        break
                    await asyncio.sleep(0.001)
                assert references and not request.done(), "check while inline waiter is still sleeping"
                assert references[0]() is None, "duplicate request must release uploaded bytes before waiting"
                assert (await request).status_code == 200
            finally:
                if not request.done():
                    request.cancel()
                    with pytest.raises(asyncio.CancelledError):
                        await request

    try:
        asyncio.run(scenario())
    finally:
        manager.shutdown()


def test_stalled_upload_is_interrupted_and_gate_released(tmp_path):
    """停传连接必须在期限处被取消并归还上传闸门（issue #1）。"""
    import httpx

    config = ServiceConfig(
        cache_dir=tmp_path, workers=1, service_token="secret",
        max_upload_connections=1, upload_wait_seconds=0.05, upload_timeout_seconds=0.2,
    )
    manager = TranslationJobManager(config, pipeline=FakePipeline())
    app = create_app(config=config, manager=manager)

    async def scenario():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            gate = app.state.translation_upload_gate

            async def stalled_body():
                yield b"x" * 1024
                await asyncio.sleep(30)  # 模拟客户端停传
                yield b"y" * 1024

            response = await client.post(
                "/v1/translate/page?waitMs=0",
                content=stalled_body(),
                headers={"Authorization": "Bearer secret", "Content-Type": "image/png"},
            )
            assert response.status_code == 408, "停传连接必须被上传期限中断"
            ok = await client.post(
                "/v1/translate/page?waitMs=0",
                content=image_bytes(),
                headers={"Authorization": "Bearer secret", "Content-Type": "image/png"},
            )
            assert ok.status_code in {200, 202}, "取消后上传闸门必须已归还"

    asyncio.run(scenario())


def test_empty_token_skips_warmup_so_readyz_stays_ok(tmp_path, monkeypatch):
    """空 token 禁用翻译时跳过 warmup：OCR 失败不得经 readyz 阻断整站（issue #2）。"""
    config = ServiceConfig(cache_dir=tmp_path, workers=1, service_token="")
    manager = TranslationJobManager(config, pipeline=FakePipeline())

    def broken_loader():
        raise RuntimeError("ocr model missing")

    manager.pipeline._get_ocr = broken_loader
    monkeypatch.setenv("TRANSLATION_WARMUP", "1")
    monkeypatch.setenv("TRANSLATION_REQUIRE_TOKEN", "0")
    app = create_app(config=config, manager=manager)
    with TestClient(app) as client:
        assert client.get("/healthz").json()["auth"] == "disabled"
        ready = client.get("/readyz")
        assert ready.status_code == 200, "空 token 禁用模式下 warmup 失败不得让 readiness 失败"
        assert ready.json()["ready"] is True


def test_probe_access_log_filter_drops_health_checks_only():
    import logging

    from service import ProbeAccessFilter

    probe_filter = ProbeAccessFilter()

    def access(path: str) -> logging.LogRecord:
        return logging.LogRecord(
            "uvicorn.access", logging.INFO, __file__, 1,
            '%s - "%s %s HTTP/%s" %d', ("127.0.0.1:1", "GET", path, "1.1", 200), None,
        )

    assert probe_filter.filter(access("/readyz")) is False
    assert probe_filter.filter(access("/healthz?probe=1")) is False
    assert probe_filter.filter(access("/v1/translate/page")) is True
    assert probe_filter.filter(logging.LogRecord("x", logging.INFO, __file__, 1, "plain", None, None)) is True
    assert any(isinstance(f, ProbeAccessFilter) for f in logging.getLogger("uvicorn.access").filters)
