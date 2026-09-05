from __future__ import annotations

import io
import sys
import time
from pathlib import Path

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
