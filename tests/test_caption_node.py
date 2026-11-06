"""Tests for the AIPromptStudioCaption graph node."""

from __future__ import annotations

import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from prompt_studio.aiohttp_api import StudioBackend
from prompt_studio.caption_node import (
    AIPromptStudioCaptionNode,
    _image_source_part,
    _tensor_to_png,
)
from prompt_studio.client import data_url
from prompt_studio.config import Settings
from prompt_studio.png import make_rgb_png, make_split_probe_png

from tests.mock_upstream import VALID_KEY, MockUpstream


def _fake_tensor(png_bytes: bytes):
    """Build a stand-in for ComfyUI's IMAGE tensor without requiring torch.

    The node only needs ``.shape`` (NHWC) and 0-d indexing; a numpy array of
    the decoded PNG satisfies both, same as a real (1, H, W, 3) float tensor.
    """
    import numpy as np

    # Decode our own minimal PNG (8-bit RGB, filter none) — small helper, no deps.
    import struct
    import zlib

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


class TensorEncodingTests(unittest.TestCase):
    def test_tensor_to_png_roundtrip_colors(self):
        png = make_split_probe_png(8)
        tensor = _fake_tensor(png)
        out = _tensor_to_png(tensor)
        self.assertIsNotNone(out)
        self.assertTrue(out.startswith(b"\x89PNG"))

    def test_tensor_to_png_rejects_non_image_shapes(self):
        import numpy as np

        self.assertIsNone(_tensor_to_png(None))
        self.assertIsNone(_tensor_to_png(np.zeros((3, 3), dtype="float32")))
        self.assertIsNone(_tensor_to_png(np.zeros((1, 4, 4, 5), dtype="float32")))
        # 2-frame batch: still encodes frame 0 rather than failing
        batch = np.zeros((2, 4, 4, 3), dtype="float32")
        self.assertIsNotNone(_tensor_to_png(batch))


class NodeExecutionTests(unittest.TestCase):
    def setUp(self):
        self.mock = MockUpstream()
        self.mock.__enter__()
        self.addCleanup(self.mock.__exit__, None, None, None)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.settings = Settings(
            base_url=self.mock.base_url,
            model="vision-pro",
            api_key=VALID_KEY,
            home=Path(self.tmp.name),
            timeout_s=10.0,
            max_retries=0,
            backoff_s=0.01,
        )
        self.backend = StudioBackend(self.settings)
        self.addCleanup(self.backend.close)
        # Stand in for the lazy get_backend() used inside the node.
        import comfyui_plugin
        self._saved = comfyui_plugin.get_backend
        comfyui_plugin.get_backend = lambda: self.backend
        self.addCleanup(setattr, comfyui_plugin, "get_backend", self._saved)
        self.node = AIPromptStudioCaptionNode()

    def test_exec_with_tensor_outputs_mock_caption(self):
        tensor = _fake_tensor(make_split_probe_png(8))
        result = self.node.caption(format="prose", image=tensor)
        self.assertEqual(result["result"][0], "red blue")
        self.assertEqual(result["ui"]["format"], "prose")

    def test_exec_with_tags_format(self):
        tensor = _fake_tensor(make_split_probe_png(8))
        result = self.node.caption(format="tags", image=tensor, model="caption-model")
        self.assertEqual(result["result"][0], "quality, red, blue")

    def test_exec_with_image_path(self):
        path = Path(self.tmp.name) / "probe.png"
        path.write_bytes(make_split_probe_png(8))
        result = self.node.caption(format="prose", image_path=str(path))
        self.assertEqual(result["result"][0], "red blue")

    def test_missing_both_inputs_raises(self):
        with self.assertRaises(ValueError):
            self.node.caption(format="prose")

    def test_bad_path_raises(self):
        with self.assertRaises(ValueError):
            self.node.caption(format="prose", image_path=str(Path(self.tmp.name) / "nope.png"))

    def test_unknown_format_raises(self):
        tensor = _fake_tensor(make_split_probe_png(8))
        with self.assertRaises(ValueError):
            self.node.caption(format="yaml", image=tensor)

    def test_registration(self):
        mappings: dict = {}
        display: dict = {}
        from prompt_studio.caption_node import register
        register(mappings, display)
        self.assertIn("AIPromptStudioCaption", mappings)
        self.assertIs(mappings["AIPromptStudioCaption"], AIPromptStudioCaptionNode)
        self.assertEqual(display["AIPromptStudioCaption"], "AI 图像反推提示词")


if __name__ == "__main__":
    unittest.main()
