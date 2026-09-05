from __future__ import annotations

import io
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

from pipeline import Detection, TranslationPipeline


def png_with_text(background=(255, 255, 255)) -> bytes:
    image = Image.new("RGB", (160, 80), background)
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(str(TranslationPipeline().font_path), 30)
    draw.text((30, 20), "什麼", font=font, fill=(28, 28, 28))
    stream = io.BytesIO()
    image.save(stream, format="PNG")
    return stream.getvalue()


class StubOCRPipeline(TranslationPipeline):
    def __init__(self, detection):
        super().__init__()
        self.detection = detection

    def _detect(self, _arr):
        return [self.detection]


def test_safe_glyph_is_redrawn():
    source = png_with_text()
    detection = Detection(((30.0, 20.0), (120.0, 20.0), (120.0, 52.0), (30.0, 52.0)), "什麼", 0.99)
    pipeline = StubOCRPipeline(detection)
    output, stats = pipeline.process(source)
    assert stats.candidate_chars == 1
    assert stats.edits == 1
    assert output != source
    with Image.open(io.BytesIO(output)) as image:
        assert image.size == (160, 80)


def test_coloured_panel_is_left_untouched_except_for_encoding():
    source = png_with_text((245, 210, 220))
    detection = Detection(((30.0, 20.0), (120.0, 20.0), (120.0, 52.0), (30.0, 52.0)), "什麼", 0.99)
    pipeline = StubOCRPipeline(detection)
    _, stats = pipeline.process(source)
    assert stats.candidate_chars == 1
    assert stats.edits == 0
    assert stats.skipped_chars == 1


def test_unchanged_webp_is_returned_byte_for_byte():
    image = Image.new("RGB", (32, 32), (255, 255, 255))
    stream = io.BytesIO()
    image.save(stream, format="WEBP", quality=92)
    source = stream.getvalue()
    detection = Detection(((2.0, 4.0), (28.0, 4.0), (28.0, 20.0), (2.0, 20.0)), "今天", 0.99)
    pipeline = StubOCRPipeline(detection)
    output, stats = pipeline.process(source)
    assert stats.edits == 0
    assert stats.encode_ms == 0
    assert output == source
