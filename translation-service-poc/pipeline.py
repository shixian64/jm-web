"""Fast, conservative manga page translation pipeline.

This module intentionally implements the *fast* backend only:

* RapidOCR detects text on the already-decoded page supplied by ``jm-web``.
* OpenCC converts Traditional Chinese to Simplified Chinese.
* Only changed glyphs in a neutral, almost-white panel are redrawn.

The last rule is important.  A quick service must prefer returning the
original glyph over painting a visible rectangle over a gradient, screenshot,
or sound-effect.  A future quality backend can consume the same API without
changing the reader contract.
"""

from __future__ import annotations

import io
import logging
import math
import os
import threading
import time
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from opencc import OpenCC
from PIL import Image, ImageDraw, ImageFont

try:  # The POC uses the small CPU package; Docker installs this dependency.
    from rapidocr_onnxruntime import RapidOCR
except Exception as exc:  # pragma: no cover - exercised only on bad installs  # noqa: BLE001
    RapidOCR = None  # type: ignore[assignment,misc]
    _RAPIDOCR_IMPORT_ERROR = exc
else:
    _RAPIDOCR_IMPORT_ERROR = None


LOG = logging.getLogger("translation-service.pipeline")
PIPELINE_VERSION = "fast-t2s-glyph-v1"

# OCR output can contain a few recurring visual confusions.  Keep the repair
# table deliberately small; broad fuzzy replacement would silently alter text.
OCR_REPAIRS = {
    "什魔": "什麼",
    "怎魔": "怎麼",
    "那魔": "那麼",
    "這魔": "這麼",
    "什磨": "什麼",
    "怎磨": "怎麼",
    "那磨": "那麼",
    "這磨": "這麼",
    "老檬子": "老樣子",
    "檬": "樣",
    "舆": "與",
    "遺有": "還有",
    "遗有": "還有",
    "遺是": "還是",
    "遗是": "還是",
    "遺真": "還真",
    "遗真": "還真",
    "遺我": "還我",
    "遗我": "還我",
    "遺你": "還你",
    "遗你": "還你",
    "遺整": "還整",
    "遗整": "還整",
    "以俊": "以後",
    "然俊": "然後",
    "俊將": "後將",
    "剪動": "勞動",
    "重性": "複性",
    "瓣": "辦",
}


def _is_cjk(ch: str) -> bool:
    return "\u3400" <= ch <= "\u9fff"


def _normalise_ocr_text(text: str) -> str:
    for source, target in OCR_REPAIRS.items():
        text = text.replace(source, target)
    return text


def _font_candidates() -> list[Path]:
    configured = os.getenv("TRANSLATION_FONT", "").strip()
    candidates: list[Path] = []
    if configured:
        candidates.append(Path(configured))
    # Windows is the development target; the latter paths are used by Docker
    # and make the service portable to a Linux host.
    candidates.extend(
        [
            Path(r"C:\Windows\Fonts\msyh.ttc"),
            Path(r"C:\Windows\Fonts\simhei.ttf"),
            Path(r"C:\Windows\Fonts\msjh.ttc"),
            Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
            Path("/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf"),
            Path("/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc"),
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
        ]
    )
    return candidates


def resolve_font() -> Path:
    for path in _font_candidates():
        if path.is_file():
            return path
    raise RuntimeError(
        "找不到中文字体，请设置 TRANSLATION_FONT；已尝试: "
        + ", ".join(str(p) for p in _font_candidates())
    )


@dataclass
class PipelineStats:
    pipeline_version: str = PIPELINE_VERSION
    width: int = 0
    height: int = 0
    detections: int = 0
    eligible_detections: int = 0
    candidate_chars: int = 0
    edits: int = 0
    skipped_chars: int = 0
    decode_ms: float = 0.0
    ocr_ms: float = 0.0
    render_ms: float = 0.0
    encode_ms: float = 0.0
    total_ms: float = 0.0
    output_bytes: int = 0
    output_format: str = "webp"
    conservative: bool = True

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class Detection:
    polygon: tuple[tuple[float, float], ...]
    text: str
    score: float


def _coerce_polygon(value: Any) -> tuple[tuple[float, float], ...] | None:
    try:
        points = tuple((float(p[0]), float(p[1])) for p in value)
    except (TypeError, ValueError, IndexError):
        return None
    if len(points) < 4 or not all(math.isfinite(v) for p in points for v in p):
        return None
    return points[:4]


def _coerce_detections(result: Any) -> list[Detection]:
    """Normalise the two result shapes used by RapidOCR releases."""

    if result is None:
        return []
    # Newer rapidocr returns an object with boxes/txts/scores.
    boxes = getattr(result, "boxes", None)
    texts = getattr(result, "txts", None)
    scores = getattr(result, "scores", None)
    if boxes is not None and texts is not None:
        out: list[Detection] = []
        for index, box in enumerate(boxes):
            polygon = _coerce_polygon(box)
            if polygon is None:
                continue
            try:
                text = str(texts[index])
                score = float(scores[index]) if scores is not None else 1.0
            except (IndexError, TypeError, ValueError):
                continue
            if not math.isfinite(score):
                continue
            out.append(Detection(polygon, text, score))
        return out
    # rapidocr_onnxruntime currently returns (list, elapsed) where each row is
    # [quadrilateral, text, confidence].
    if isinstance(result, tuple) and result and isinstance(result[0], (list, tuple)):
        result = result[0]
    if not isinstance(result, Iterable):
        return []
    out = []
    for row in result:
        if isinstance(row, dict):
            polygon = _coerce_polygon(row.get("box") or row.get("polygon"))
            text = row.get("text", "")
            score = row.get("score", 0.0)
        else:
            try:
                polygon, text, score = row[0], row[1], row[2]
            except (TypeError, IndexError):
                continue
        polygon = _coerce_polygon(polygon)
        if polygon is None:
            continue
        try:
            text = str(text or "")
            score = float(score)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(score):
            continue
        out.append(Detection(polygon, text, score))
    return out


def _weighted_breaks(text: str) -> list[float]:
    weights = [1.0 if ord(ch) >= 0x3000 else 0.60 for ch in text]
    total = float(sum(weights)) or 1.0
    breaks = [0.0]
    running = 0.0
    for weight in weights:
        running += weight
        breaks.append(running / total)
    return breaks


def _cell_box(
    polygon: tuple[tuple[float, float], ...],
    text: str,
    index: int,
    orientation: str,
    width: int,
    height: int,
) -> tuple[int, int, int, int] | None:
    """Return a bounding box for one glyph in a horizontal/vertical quad."""

    if not text or index < 0 or index >= len(text):
        return None
    p = np.asarray(polygon, dtype=float)
    breaks = _weighted_breaks(text)
    a, b = breaks[index], breaks[index + 1]
    if orientation == "vertical":
        # p0->p3 is the left edge and p1->p2 the right edge.
        left0 = p[0] * (1 - a) + p[3] * a
        left1 = p[0] * (1 - b) + p[3] * b
        right0 = p[1] * (1 - a) + p[2] * a
        right1 = p[1] * (1 - b) + p[2] * b
        points = np.asarray([left0, right0, right1, left1])
    else:
        top0 = p[0] * (1 - a) + p[1] * a
        top1 = p[0] * (1 - b) + p[1] * b
        bottom0 = p[3] * (1 - a) + p[2] * a
        bottom1 = p[3] * (1 - b) + p[2] * b
        points = np.asarray([top0, top1, bottom1, bottom0])
    x0 = max(0, math.floor(float(points[:, 0].min())) + 1)
    y0 = max(0, math.floor(float(points[:, 1].min())) + 1)
    x1 = min(width, math.ceil(float(points[:, 0].max())) - 1)
    y1 = min(height, math.ceil(float(points[:, 1].max())) - 1)
    if x1 <= x0 or y1 <= y0:
        return None
    return x0, y0, x1, y1


def _orientation(polygon: tuple[tuple[float, float], ...]) -> str | None:
    p = np.asarray(polygon, dtype=float)
    top = float(np.linalg.norm(p[1] - p[0]))
    side = float(np.linalg.norm(p[3] - p[0]))
    if top < 1 or side < 1:
        return None
    # Reject heavily skewed/diagonal text in the fast path.  A quality worker
    # can handle arbitrary perspective later.
    if top >= side:
        angle = abs(math.degrees(math.atan2(*(p[1] - p[0])[::-1])))
        if angle > 90:
            angle = 180 - angle
        return "horizontal" if angle <= 12 else None
    angle = abs(math.degrees(math.atan2(*(p[3] - p[0])[::-1])))
    if angle > 90:
        angle = 180 - angle
    return "vertical" if abs(angle - 90) <= 12 else None


def _panel_colour(arr: np.ndarray, box: tuple[int, int, int, int]) -> np.ndarray | None:
    h, w = arr.shape[:2]
    x0, y0, x1, y1 = box
    xa, ya = max(0, x0 - 8), max(0, y0 - 8)
    xb, yb = min(w, x1 + 8), min(h, y1 + 8)
    context = arr[ya:yb, xa:xb]
    if context.size == 0 or context.shape[0] < 4 or context.shape[1] < 4:
        return None
    gray = cv2.cvtColor(context, cv2.COLOR_RGB2GRAY)
    hsv = cv2.cvtColor(context, cv2.COLOR_RGB2HSV)
    border_width = min(5, max(1, context.shape[0] // 8), max(1, context.shape[1] // 8))
    border = np.concatenate(
        [
            context[:border_width].reshape(-1, 3),
            context[-border_width:].reshape(-1, 3),
            context[:, :border_width].reshape(-1, 3),
            context[:, -border_width:].reshape(-1, 3),
        ]
    )
    background = np.median(border, axis=0)
    # Flat white/off-white balloons and captions only.  This prevents dark
    # blocks on coloured panels and phone screenshots.
    if float(background.max() - background.min()) > 8 or float(np.mean(background)) < 218:
        return None
    light = (gray > 195) & (hsv[:, :, 1] < 85)
    if float(light.mean()) < 0.45:
        return None
    return background.astype(np.uint8)


def _draw_glyph(
    image: Image.Image,
    arr: np.ndarray,
    box: tuple[int, int, int, int],
    glyph: str,
    line_height: float,
    background: np.ndarray,
    font_path: Path,
) -> bool:
    x0, y0, x1, y1 = box
    if x1 - x0 < 7 or y1 - y0 < 9 or not glyph:
        return False
    crop = arr[y0:y1, x0:x1].copy()
    if crop.size == 0:
        return False
    gray = cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY)
    hsv = cv2.cvtColor(crop, cv2.COLOR_RGB2HSV)
    saturation = hsv[:, :, 1]
    ink = (((gray < 195) & (saturation < 95)) | ((gray < 232) & (saturation < 48))).astype(np.uint8) * 255
    if cv2.countNonZero(ink) < 4:
        return False
    ink = cv2.dilate(ink, np.ones((2, 2), np.uint8), iterations=1)
    clean = crop.copy()
    clean[ink > 0] = background
    image.paste(Image.fromarray(clean, "RGB"), (x0, y0))
    arr[y0:y1, x0:x1] = clean

    draw = ImageDraw.Draw(image)
    # A square-ish size works for both horizontal and vertical CJK cells.
    size = max(10, round(min(max(line_height, 10), max(y1 - y0, 10)) * 0.96))
    while size > 8:
        font = ImageFont.truetype(str(font_path), size=size)
        bbox = draw.textbbox((0, 0), glyph, font=font)
        if bbox[2] - bbox[0] <= (x1 - x0) * 0.84 and bbox[3] - bbox[1] <= (y1 - y0) * 0.90:
            break
        size -= 1
    font = ImageFont.truetype(str(font_path), size=max(8, size))
    bbox = draw.textbbox((0, 0), glyph, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text(
        (x0 + ((x1 - x0) - tw) / 2 - bbox[0], y0 + ((y1 - y0) - th) / 2 - bbox[1]),
        glyph,
        font=font,
        fill=(28, 28, 28),
    )
    # Keep OCR context in sync for a later overlapping detection.
    arr[y0:y1, x0:x1] = np.asarray(image.crop((x0, y0, x1, y1)), dtype=np.uint8)
    return True


class TranslationPipeline:
    """Thread-safe fast pipeline.

    OCR inference is serialized by default because the CPU ONNX session is
    more predictable that way.  Rendering/encoding and queue scheduling remain
    asynchronous.  ``TRANSLATION_OCR_SERIAL=0`` can be used after a local
    benchmark if the installed runtime is known to be safe concurrently.
    """

    def __init__(
        self,
        *,
        target_lang: str = "zh-CN",
        max_pixels: int = 20_000_000,
        webp_quality: int = 92,
        webp_method: int | None = None,
        ocr_score_threshold: float = 0.56,
    ) -> None:
        self.target_lang = target_lang
        self.max_pixels = max_pixels
        if webp_quality == 92:
            try:
                webp_quality = int(os.getenv("TRANSLATION_WEBP_QUALITY", "92"))
            except ValueError:
                webp_quality = 92
        self.webp_quality = max(70, min(100, int(webp_quality)))
        if webp_method is None:
            try:
                webp_method = int(os.getenv("TRANSLATION_WEBP_METHOD", "2"))
            except ValueError:
                webp_method = 2
        self.webp_method = max(0, min(6, int(webp_method)))
        self.ocr_score_threshold = float(ocr_score_threshold)
        self.font_path = resolve_font()
        self._ocr: Any = None
        self._ocr_init_lock = threading.Lock()
        self._ocr_call_lock = threading.Lock()
        self._ocr_serial = os.getenv("TRANSLATION_OCR_SERIAL", "1").lower() not in {"0", "false", "no"}
        self._converter = OpenCC("t2s") if target_lang == "zh-CN" else None

    @property
    def version(self) -> str:
        return PIPELINE_VERSION

    def _get_ocr(self) -> Any:
        if self._ocr is not None:
            return self._ocr
        if RapidOCR is None:
            raise RuntimeError(f"RapidOCR 不可用: {_RAPIDOCR_IMPORT_ERROR}")
        with self._ocr_init_lock:
            if self._ocr is None:
                LOG.info("loading RapidOCR model")
                use_cuda = os.getenv("TRANSLATION_USE_CUDA", "0").lower() in {"1", "true", "yes"}
                if use_cuda:
                    # rapidocr_onnxruntime 1.2.x requires explicit empty model
                    # paths when overriding detector/recognizer providers.
                    # If CUDAExecutionProvider is unavailable, ONNX Runtime
                    # safely falls back to CPU and emits its own warning.
                    self._ocr = RapidOCR(
                        det_model_path="",
                        cls_model_path="",
                        rec_model_path="",
                        det_use_cuda=True,
                        cls_use_cuda=True,
                        rec_use_cuda=True,
                    )
                else:
                    self._ocr = RapidOCR()
        return self._ocr

    def _detect(self, arr: np.ndarray) -> list[Detection]:
        ocr = self._get_ocr()
        if self._ocr_serial:
            with self._ocr_call_lock:
                result = ocr(arr)
        else:
            result = ocr(arr)
        # Both supported APIs return (detections, timing); the object API may
        # return an object directly.
        if isinstance(result, tuple) and len(result) >= 1:
            return _coerce_detections(result[0])
        return _coerce_detections(result)

    def _translate(self, text: str) -> str:
        text = _normalise_ocr_text(text)
        if self._converter is None:
            return text
        return self._converter.convert(text)

    def process(self, source: bytes) -> tuple[bytes, PipelineStats]:
        """Decode, translate and encode one page.

        The input is never written to disk.  The returned bytes are a same-size
        WebP delivery image and can be atomically placed in the service cache.
        """

        started = time.perf_counter()
        stats = PipelineStats()
        decode_start = time.perf_counter()
        source_format = ""
        try:
            with Image.open(io.BytesIO(source)) as decoded:
                width, height = decoded.size
                if width <= 0 or height <= 0 or width * height > self.max_pixels:
                    raise ValueError("图片尺寸超过服务限制")
                # Check the header dimensions before materialising pixel data;
                # otherwise a deliberately huge image could allocate memory
                # before the service limit is applied.
                decoded.load()
                source_format = str(decoded.format or "").upper()
                image = decoded.convert("RGB")
        except Image.DecompressionBombError as exc:
            raise ValueError("图片像素数超过服务限制") from exc
        except (OSError, ValueError) as exc:
            raise ValueError(f"无法解码图片: {exc}") from exc
        stats.width, stats.height = image.size
        stats.decode_ms = (time.perf_counter() - decode_start) * 1000

        arr = np.asarray(image, dtype=np.uint8).copy()
        ocr_start = time.perf_counter()
        detections = self._detect(arr)
        stats.ocr_ms = (time.perf_counter() - ocr_start) * 1000
        stats.detections = len(detections)

        render_start = time.perf_counter()
        ordered = sorted(detections, key=lambda d: min(point[1] for point in d.polygon))
        for detection in ordered:
            raw = detection.text.strip()
            if not raw or detection.score < self.ocr_score_threshold:
                continue
            if any(ch in raw for ch in ("\ufffd", "�", "\x00")):
                continue
            if len(raw) > 64 or sum(_is_cjk(ch) for ch in raw) < 2:
                continue
            orientation = _orientation(detection.polygon)
            if orientation is None:
                continue
            p = np.asarray(detection.polygon, dtype=float)
            if orientation == "horizontal":
                line_height = (np.linalg.norm(p[3] - p[0]) + np.linalg.norm(p[2] - p[1])) / 2
            else:
                line_height = (np.linalg.norm(p[1] - p[0]) + np.linalg.norm(p[2] - p[3])) / 2
            if line_height < 10 or line_height > 90:
                continue
            source_text = _normalise_ocr_text(raw)
            target_text = self._translate(raw)
            if len(source_text) != len(target_text):
                continue
            stats.eligible_detections += 1
            for index, (source_char, target_char) in enumerate(zip(source_text, target_text)):
                if source_char == target_char or not (_is_cjk(source_char) and _is_cjk(target_char)):
                    continue
                stats.candidate_chars += 1
                box = _cell_box(detection.polygon, raw, index, orientation, stats.width, stats.height)
                if box is None:
                    stats.skipped_chars += 1
                    continue
                background = _panel_colour(arr, box)
                if background is None or not _draw_glyph(
                    image, arr, box, target_char, line_height, background, self.font_path
                ):
                    stats.skipped_chars += 1
                    continue
                stats.edits += 1
        stats.render_ms = (time.perf_counter() - render_start) * 1000

        encode_start = time.perf_counter()
        if stats.edits == 0 and source_format == "WEBP":
            # Do not introduce a second lossy generation when the conservative
            # path found nothing safe to redraw (common for colourful panels).
            # This also makes the fallback visually identical to the source.
            result = source
            stats.encode_ms = 0.0
        else:
            output = io.BytesIO()
            # quality=92 keeps text edges clear while being much smaller than
            # the previous lossless WebP cache.
            image.save(output, format="WEBP", quality=self.webp_quality, method=self.webp_method)
            result = output.getvalue()
            stats.encode_ms = (time.perf_counter() - encode_start) * 1000
        stats.output_bytes = len(result)
        stats.total_ms = (time.perf_counter() - started) * 1000
        return result, stats


__all__ = [
    "PIPELINE_VERSION",
    "PipelineStats",
    "TranslationPipeline",
    "resolve_font",
]
