"""Tests for the three-mode caption graph node and its HTTP route."""

from __future__ import annotations

import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from aiohttp.test_utils import TestClient, TestServer

from prompt_studio.aiohttp_api import StudioBackend, create_app
from prompt_studio.caption_node import (
    AIPromptStudioCaptionNode,
    _image_source_part,
    _tensor_to_png,
    image_dimensions,
)
from prompt_studio.client import data_url
from prompt_studio.config import Settings
from prompt_studio.layout import match_canvas_size
from prompt_studio.png import make_split_probe_png

from tests.mock_upstream import VALID_KEY, MockUpstream


def _fake_tensor(png_bytes: bytes):
    """Build a stand-in for ComfyUI's IMAGE tensor without requiring torch."""
    import struct
    import zlib

    import numpy as np

    pos = 8
    width = height = 0
    idat = b""
    while pos < len(png_bytes):
        (length,), tag = struct.unpack(">I", png_bytes[pos:pos + 4]), png_bytes[pos + 4:pos + 8]
        data = png_bytes[pos + 8:pos + 8 + length]
        if tag == b"IHDR":
            width, height = struct.unpack(">II", data[:8])
        elif tag == b"IDAT":
            idat += data
        pos += 12 + length
    raw = zlib.decompress(idat)
    pixels = []
    for y in range(height):
        row = raw[y * (1 + width * 3) + 1:(y + 1) * (1 + width * 3)]
        for x in range(width):
            pixels.append(tuple(row[x * 3:x * 3 + 3]))
    array = np.array(pixels, dtype="uint8").reshape(height, width, 3).astype("float32") / 255.0
    return array.reshape(1, height, width, 3)


def _sample_draft(width: int = 1024, height: int = 1024) -> dict:
    return {
        "width": width,
        "height": height,
        "bbox_coord_space": "abs",
        "bbox_format": "xyxy",
        "summary": {"caption": "A red and blue poster.", "canvas": "single"},
        "items": [
            {"label": "object", "caption": "Red left half", "bbox": [0, 0, 512, 1024]},
            {"label": "character", "caption": "A figure", "bbox": [384, 256, 768, 900]},
        ],
    }


def _payload(mode: str, *, width: int = 1024, height: int = 1024) -> dict:
    state = {
        "mode": mode,
        "width": width,
        "height": height,
        "source_width": 1500,
        "source_height": 1000,
        "caption": "A red and blue poster.",
        "request_id": "req-test",
    }
    if mode != "caption":
        state["draft"] = _sample_draft(width, height)
    return state


class TensorAndHeaderTests(unittest.TestCase):
    def test_tensor_to_png_roundtrip(self):
        tensor = _fake_tensor(make_split_probe_png(8))
        out = _tensor_to_png(tensor)
        self.assertTrue(out.startswith(b"\x89PNG"))

    def test_tensor_to_png_rejects_non_image_shapes(self):
        import numpy as np

        self.assertIsNone(_tensor_to_png(None))
        self.assertIsNone(_tensor_to_png(np.zeros((3, 3), dtype="float32")))
        self.assertIsNone(_tensor_to_png(np.zeros((1, 4, 4, 5), dtype="float32")))

    def test_image_dimensions_png(self):
        self.assertEqual(image_dimensions(make_split_probe_png(32)), (32, 32))

    def test_image_dimensions_rejects_garbage(self):
        with self.assertRaises(ValueError):
            image_dimensions(b"not an image")
        with self.assertRaises(ValueError):
            image_dimensions(b"")


class NodeExecutionTests(unittest.TestCase):
    def setUp(self):
        self.node = AIPromptStudioCaptionNode()

    def test_caption_mode_outputs_text_and_size(self):
        state = _payload("caption", width=1248, height=832)
        state["caption"] = "A hand-edited caption."
        prompt, w, h = self.node.caption(mode="caption", payload=json.dumps(state))
        self.assertEqual(prompt, "A hand-edited caption.")  # manual edits are NOT overwritten
        self.assertEqual((w, h), (1248, 832))

    def test_layout_mode_outputs_draft_json(self):
        prompt, w, h = self.node.caption(mode="layout", payload=json.dumps(_payload("layout")))
        draft = json.loads(prompt)
        self.assertEqual(draft["bbox_format"], "xyxy")
        self.assertEqual(len(draft["items"]), 2)
        self.assertEqual((w, h), (1024, 1024))

    def test_hybrid_mode_outputs_draft_with_full_caption(self):
        state = _payload("hybrid")
        state["draft"]["summary"]["caption"] = "A long complete description with lighting."
        prompt, _, _ = self.node.caption(mode="hybrid", payload=json.dumps(state))
        self.assertIn("long complete description", json.loads(prompt)["summary"]["caption"])

    def test_empty_payload_rejected(self):
        with self.assertRaises(ValueError):
            self.node.caption(mode="caption", payload="{}")
        with self.assertRaises(ValueError):
            self.node.caption(mode="caption", payload="not json")

    def test_layout_mode_requires_draft(self):
        state = _payload("caption")
        with self.assertRaises(ValueError):
            self.node.caption(mode="layout", payload=json.dumps(state))

    def test_unknown_mode_rejected(self):
        with self.assertRaises(ValueError):
            self.node.caption(mode="yaml", payload=json.dumps(_payload("caption")))

    def test_input_types_expose_mode_and_three_outputs(self):
        types = AIPromptStudioCaptionNode.INPUT_TYPES()
        self.assertIn("mode", types["required"])
        self.assertIn("payload", types["required"])
        self.assertIn("image", types["optional"])
        self.assertEqual(AIPromptStudioCaptionNode.RETURN_TYPES, ("STRING", "INT", "INT"))

    def test_registration(self):
        mappings: dict = {}
        display: dict = {}
        from prompt_studio.caption_node import register
        register(mappings, display)
        self.assertIs(mappings["AIPromptStudioCaption"], AIPromptStudioCaptionNode)


class CaptionNodeRouteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.mock = MockUpstream()
        self.mock.__enter__()
        self.addCleanup(self.mock.__exit__, None, None, None)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.settings = Settings(
            base_url=self.mock.base_url, model="vision-pro", api_key=VALID_KEY,
            home=Path(self.tmp.name), timeout_s=10.0, max_retries=0, backoff_s=0.01,
        )
        self.backend = StudioBackend(self.settings)
        self.addCleanup(self.backend.close)
        self.client = TestClient(TestServer(create_app(self.backend)))
        await self.client.start_server()
        self.addCleanup(self.client.close)

    async def test_route_requires_mode_and_image(self):
        response = await self.client.post(
            "/ai_prompt_studio/caption_node", json={"mode": "caption"}
        )
        self.assertEqual(response.status, 400)
        body = await response.json()
        self.assertEqual(body["error"]["code"], "invalid_request")

    async def test_route_rejects_unknown_mode(self):
        response = await self.client.post(
            "/ai_prompt_studio/caption_node",
            json={"mode": "yaml", "image": {"data_url": data_url(make_split_probe_png(8))}},
        )
        self.assertEqual(response.status, 400)

    async def test_route_rejects_invalid_image_data(self):
        response = await self.client.post(
            "/ai_prompt_studio/caption_node",
            json={"mode": "caption", "image": {"data_url": data_url(b"garbage")}},
        )
        self.assertEqual(response.status, 400)

    async def test_route_caption_returns_size_and_payload(self):
        image = {"data_url": data_url(make_split_probe_png(32))}
        response = await self.client.post(
            "/ai_prompt_studio/caption_node",
            json={"mode": "caption", "image": image, "model": "vision-pro"},
        )
        self.assertEqual(response.status, 200)
        body = await response.json()
        w, h = body["width"], body["height"]
        self.assertEqual((w, h), match_canvas_size(32, 32))
        self.assertEqual((body["source_width"], body["source_height"]), (32, 32))
        self.assertEqual(body["caption"], "red blue")
        self.assertEqual(body["payload"]["mode"], "caption")
        self.assertIsNone(body["draft"])
        # payload alone can drive graph execution
        prompt, ow, oh = AIPromptStudioCaptionNode().caption(
            mode="caption", payload=json.dumps(body["payload"])
        )
        self.assertEqual((prompt, ow, oh), ("red blue", w, h))

    async def test_route_image_path_priority(self):
        path = Path(self.tmp.name) / "probe.png"
        path.write_bytes(make_split_probe_png(16))
        response = await self.client.post(
            "/ai_prompt_studio/caption_node",
            json={"mode": "caption", "image_path": str(path), "model": "vision-pro"},
        )
        self.assertEqual(response.status, 200)
        body = await response.json()
        self.assertEqual((body["source_width"], body["source_height"]), (16, 16))
        # image (data URL) wins when both are supplied
        response = await self.client.post(
            "/ai_prompt_studio/caption_node",
            json={"mode": "caption", "image_path": str(path),
                  "image": {"data_url": data_url(make_split_probe_png(32))},
                  "model": "vision-pro"},
        )
        body = await response.json()
        self.assertEqual((body["source_width"], body["source_height"]), (32, 32))


if __name__ == "__main__":
    unittest.main()
