"""Tests for the three-mode caption graph node and its HTTP route."""

from __future__ import annotations

import json
import math
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from aiohttp.test_utils import TestClient, TestServer

from prompt_studio.aiohttp_api import StudioBackend, create_app
from prompt_studio import credentials as credentials_module
from prompt_studio.caption_node import (
    AIPromptStudioCaptionNode,
    _image_source_part,
    _tensor_to_png,
    image_dimensions,
)
from prompt_studio.client import data_url
from prompt_studio.config import Settings
from prompt_studio.layout import layout_instruction, match_canvas_size
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
        if tag == "IHDR" or tag == b"IHDR":
            width, height = struct.unpack(">II", data[:8])
        elif tag == "IDAT" or tag == b"IDAT":
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
        prompt, w, h, _ = self.node.caption(mode="caption", payload=json.dumps(state))
        self.assertEqual(prompt, "A hand-edited caption.")  # manual edits are NOT overwritten
        self.assertEqual((w, h), (1248, 832))

    def test_layout_mode_outputs_draft_json(self):
        prompt, w, h, _ = self.node.caption(mode="layout", payload=json.dumps(_payload("layout")))
        draft = json.loads(prompt)
        self.assertEqual(draft["bbox_format"], "xyxy")
        self.assertEqual(len(draft["items"]), 2)
        self.assertEqual((w, h), (1024, 1024))

    def test_hybrid_mode_outputs_draft_with_full_caption(self):
        state = _payload("hybrid")
        state["draft"]["summary"]["caption"] = "A long complete description with lighting."
        prompt, _, _, _ = self.node.caption(mode="hybrid", payload=json.dumps(state))
        self.assertIn("long complete description", json.loads(prompt)["summary"]["caption"])

    def test_empty_payload_rejected(self):
        with self.assertRaises(ValueError):
            self.node.caption(mode="caption", payload="{}")
        with self.assertRaises(ValueError):
            self.node.caption(mode="caption", payload="not json")

    def test_invalid_json_payload_rejected_with_actionable_message(self):
        with self.assertRaisesRegex(ValueError, "payload is not valid JSON"):
            self.node.caption(mode="caption", payload="not json")

    def test_layout_mode_requires_draft(self):
        state = _payload("caption")
        with self.assertRaises(ValueError):
            self.node.caption(mode="layout", payload=json.dumps(state))

    def test_unknown_mode_rejected(self):
        with self.assertRaises(ValueError):
            self.node.caption(mode="yaml", payload=json.dumps(_payload("caption")))

    def test_input_types_expose_mode_and_five_outputs(self):
        types = AIPromptStudioCaptionNode.INPUT_TYPES()
        self.assertIn("mode", types["required"])
        self.assertIn("payload", types["required"])
        self.assertIn("image", types["optional"])
        self.assertIn("enable_caption", types["optional"])
        self.assertIn("enable_layout", types["optional"])
        self.assertIn("enable_hybrid", types["optional"])
        self.assertEqual(
            AIPromptStudioCaptionNode.RETURN_TYPES,
            ("STRING", "STRING", "STRING", "INT", "INT", "STRING"),
        )
        self.assertEqual(
            AIPromptStudioCaptionNode.RETURN_NAMES,
            ("caption_prompt", "layout_prompt", "danbooru_prompt", "width", "height", "negative_prompt"),
        )
        self.assertEqual(AIPromptStudioCaptionNode.FUNCTION, "execute")

    def test_is_changed_caches_generated_payload_and_invalidates_missing_layout(self):
        cached = json.dumps(_payload("caption"))
        self.assertEqual(
            AIPromptStudioCaptionNode.IS_CHANGED(mode="caption", payload=cached),
            f"caption:caption:{cached}",
        )
        self.assertNotEqual(AIPromptStudioCaptionNode.IS_CHANGED(payload="{}"), "{}")
        # Switching mode to layout when payload only has caption invalidates cache
        self.assertTrue(math.isnan(AIPromptStudioCaptionNode.IS_CHANGED(mode="layout", payload=cached)))

    def test_registration(self):
        mappings: dict = {}
        display: dict = {}
        from prompt_studio.caption_node import register
        register(mappings, display)
        self.assertIs(mappings["AIPromptStudioCaption"], AIPromptStudioCaptionNode)


class ExecutionFallbackTests(unittest.TestCase):
    """An empty or incomplete payload must caption the graph's IMAGE instead of failing."""

    def setUp(self):
        self.node = AIPromptStudioCaptionNode()
        self.image = _fake_tensor(make_split_probe_png(8))

    def test_caption_mode_generates_payload_from_image(self):
        prompt, w, h, new_payload = self.node.caption(
            mode="caption", payload="{}", image=self.image, model="vision-pro",
            call_model=self._model_reply,
        )
        self.assertEqual(prompt, "A red and blue poster.")
        self.assertEqual((w, h), match_canvas_size(8, 8))
        state = json.loads(new_payload)
        self.assertEqual(state["caption"], "A red and blue poster.")
        self.assertEqual(state["width"], w)

    def test_layout_mode_generates_draft_from_image(self):
        prompt, w, h, new_payload = self.node.caption(
            mode="layout", payload="{}", image=self.image, model="vision-pro",
            call_model=self._model_reply,
        )
        draft = json.loads(prompt)
        self.assertEqual(draft["items"][0]["bbox"], [0, 0, w // 2, h])
        self.assertEqual(json.loads(new_payload)["draft"], draft)

    def test_hybrid_mode_generates_complete_caption_and_draft(self):
        prompt, _, _, new_payload = self.node.caption(
            mode="hybrid", payload="{}", image=self.image, model="vision-pro",
            call_model=self._model_reply,
        )
        draft = json.loads(prompt)
        self.assertEqual(draft["summary"]["caption"], "A complete description of the whole image.")
        self.assertIn("draft", json.loads(new_payload))

    def test_switching_from_caption_to_layout_with_image_generates_draft_automatically(self):
        """Regression test: if payload only has caption (from a previous caption run)
        and the user switches mode to layout/hybrid with an image connected, it must
        automatically generate the missing draft instead of raising ValueError."""
        caption_only_payload = json.dumps(_payload("caption"))
        prompt, w, h, new_payload = self.node.caption(
            mode="layout", payload=caption_only_payload, image=self.image,
            model="vision-pro", call_model=self._model_reply,
        )
        self.assertIsNotNone(new_payload)
        draft = json.loads(prompt)
        self.assertEqual(draft["items"][0]["bbox"], [0, 0, w // 2, h])
        updated_state = json.loads(new_payload)
        self.assertIn("draft", updated_state)

    def test_execute_in_layout_mode_without_image_synthesizes_fallback_draft(self):
        """Even if no image is connected and payload only has caption text, ComfyUI
        graph execution (execute()) synthesizes a valid fallback draft instead of crashing."""
        caption_only_payload = json.dumps(_payload("caption"))
        cap_p, lay_p, hyb_p, w, h, neg_p = self.node.execute(
            mode="layout", payload=caption_only_payload
        )
        self.assertEqual(cap_p, "A red and blue poster.")
        lay_draft = json.loads(lay_p)
        hyb_draft = json.loads(hyb_p)
        self.assertEqual(lay_draft["bbox_format"], "xyxy")
        self.assertEqual(len(lay_draft["items"]), 1)
        self.assertEqual(hyb_draft["summary"]["caption"], "A red and blue poster.")
        self.assertEqual((w, h), (1024, 1024))

    def test_multi_mode_simultaneous_generation_and_three_prompt_outputs(self):
        result = self.node.execute(
            mode="hybrid",
            payload="{}",
            enable_caption=True,
            enable_layout=True,
            enable_hybrid=True,
            image=self.image,
            model="vision-pro",
            call_model=self._model_reply,
        )
        cap_p, lay_p, hyb_p, w, h, neg_p = result["result"]
        self.assertTrue(neg_p)
        self.assertEqual(cap_p, "A red and blue poster.")
        lay_draft = json.loads(lay_p)
        hyb_draft = json.loads(hyb_p)
        self.assertEqual(lay_draft["items"][0]["bbox"], [0, 0, w // 2, h])
        self.assertEqual(hyb_draft["summary"]["caption"], "A red and blue poster.")
        self.assertEqual((w, h), match_canvas_size(8, 8))

    def test_cached_payload_does_not_call_model(self):
        def forbidden(*_args, **_kwargs):
            raise AssertionError("a cached payload must not call the model")

        prompt, w, h, new_payload = self.node.caption(
            mode="caption", payload=json.dumps(_payload("caption")),
            image=self.image, call_model=forbidden,
        )
        self.assertEqual(prompt, "A red and blue poster.")
        self.assertEqual((w, h), (1024, 1024))
        self.assertIsNone(new_payload)

    def test_manual_caption_payload_does_not_call_model(self):
        state = _payload("caption")
        state["caption"] = "A hand-edited caption."
        state.pop("request_id", None)
        prompt, _, _, new_payload = self.node.caption(
            mode="caption", payload=json.dumps(state), image=self.image,
            call_model=self._model_reply,
        )
        self.assertEqual(prompt, "A hand-edited caption.")
        self.assertIsNone(new_payload)

    def test_execute_returns_five_outputs_and_ui_payload(self):
        result = self.node.execute(
            mode="caption", payload="{}", image=self.image,
            model="vision-pro", call_model=self._model_reply,
        )
        cap_p, lay_p, hyb_p, w, h, neg_p = result["result"]
        self.assertTrue(neg_p)
        self.assertEqual(cap_p, "A red and blue poster.")
        self.assertEqual(json.loads(lay_p)["bbox_format"], "xyxy")
        self.assertEqual(json.loads(hyb_p)["bbox_format"], "xyxy")
        self.assertEqual((w, h), match_canvas_size(8, 8))
        self.assertEqual(len(result["ui"]["aps_payload"]), 1)

    def test_execute_cached_payload_has_no_ui_update(self):
        result = self.node.execute(mode="caption", payload=json.dumps(_payload("caption")))
        self.assertIsInstance(result, tuple)
        self.assertEqual(len(result), 6)

    def test_empty_payload_without_image_reports_configuration_help(self):
        with self.assertRaisesRegex(ValueError, "反推|配置"):
            self.node.caption(mode="caption", payload="{}", call_model=self._model_reply)

    def test_timeout_error_is_actionable_and_no_key_leaks(self):
        def timed_out(**_kwargs):
            from prompt_studio.errors import UpstreamTimeoutError
            raise UpstreamTimeoutError(
                "Upstream did not respond within 60s.",
                detail="raw " + VALID_KEY,
            )

        with self.assertRaisesRegex(ValueError, "Magpie|重试|反推"):
            self.node.caption(
                mode="caption", payload="{}", image=self.image,
                model="vision-pro", call_model=timed_out,
            )

    @staticmethod
    def _model_reply(*, instruction: str, image_part: dict, model: str, max_tokens: int) -> str:
        assert "image_url" in image_part
        assert "Describe the image" in instruction or ("AT MOST " in instruction and "regions" in instruction)
        assert model == "vision-pro"
        assert max_tokens in (500, 3000)
        if "summary.caption" in instruction:
            caption = ("A complete description of the whole image."
                       if "COMPLETE natural-language" in instruction
                       else "A short description.")
            bbox = [0, 0, 500, 1000]
            return json.dumps({"summary": {"caption": caption}, "items": [
                {"label": "object", "caption": "left half", "bbox": bbox},
            ]})
        return "A red and blue poster."


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
        self.assertIn("outputs", body)
        self.assertEqual(body["outputs"]["caption_prompt"], "red blue")
        # payload alone can drive graph execution
        prompt, ow, oh, _ = AIPromptStudioCaptionNode().caption(
            mode="caption", payload=json.dumps(body["payload"])
        )
        self.assertEqual((prompt, ow, oh), ("red blue", w, h))

    async def test_route_multi_modes_returns_all_three_outputs(self):
        image = {"data_url": data_url(make_split_probe_png(32))}
        response = await self.client.post(
            "/ai_prompt_studio/caption_node",
            json={
                "mode": "hybrid",
                "modes": ["caption", "layout", "hybrid"],
                "image": image,
                "model": "demo-model",
            },
        )
        self.assertEqual(response.status, 200)
        body = await response.json()
        self.assertEqual(body["modes"], ["caption", "layout", "hybrid"])
        self.assertIsInstance(body["draft"], dict)
        outputs = body["outputs"]
        self.assertTrue(outputs["caption_prompt"])
        self.assertEqual(json.loads(outputs["layout_prompt"])["bbox_format"], "xyxy")
        self.assertEqual(json.loads(outputs["hybrid_prompt"])["bbox_format"], "xyxy")

    async def test_config_route_updates_settings_without_exposing_new_key(self):
        saved = []
        original = credentials_module.save_credentials
        credentials_module.save_credentials = lambda *args, **kwargs: saved.append((args, kwargs))
        self.addCleanup(setattr, credentials_module, "save_credentials", original)
        response = await self.client.post("/ai_prompt_studio/config", json={
            "base_url": "http://127.0.0.1:3425/v1",
            "model": "auto/glm-5.3-flash",
            "api_key": "browser-new-key-123456",
            "timeout_s": 90,
            "max_retries": 0,
        })
        self.assertEqual(response.status, 200)
        body = await response.json()
        self.assertEqual(body["config"]["model"], "auto/glm-5.3-flash")
        self.assertNotIn(VALID_KEY, json.dumps(body))
        self.assertNotIn("browser-new-key-123456", json.dumps(body))
        self.assertEqual(saved[0][0][:3], (
            "http://127.0.0.1:3425/v1", "browser-new-key-123456", "auto/glm-5.3-flash",
        ))
        self.assertEqual(self.backend.settings.model, "auto/glm-5.3-flash")
        self.assertEqual(self.backend.settings.api_key, "browser-new-key-123456")
        self.assertEqual(self.backend.settings.timeout_s, 90.0)
        self.assertEqual(self.backend.settings.max_retries, 0)

    async def test_config_route_keeps_existing_key_when_field_is_blank(self):
        saved = []
        original = credentials_module.save_credentials
        credentials_module.save_credentials = lambda *args, **kwargs: saved.append((args, kwargs))
        self.addCleanup(setattr, credentials_module, "save_credentials", original)
        response = await self.client.post("/ai_prompt_studio/config", json={
            "base_url": "http://127.0.0.1:3425/v1",
            "model": "auto/glm-5.3-flash",
            "api_key": "",
        })
        self.assertEqual(response.status, 200)
        self.assertEqual(saved[0][0][1], VALID_KEY)

    async def test_config_route_validates_timeout_and_retries(self):
        response = await self.client.post("/ai_prompt_studio/config", json={
            "base_url": "http://127.0.0.1:3425/v1",
            "model": "auto/glm-5.3-flash",
            "timeout_s": 1,
        })
        self.assertEqual(response.status, 400)

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

    async def test_route_cleans_legacy_shifted_widget_values(self):
        response = await self.client.post(
            "/ai_prompt_studio/caption_node",
            json={
                "mode": "caption",
                "modes": ["caption", "layout"],
                "image": {"data_url": data_url(make_split_probe_png(32))},
                "image_path": "4037085137",
                "extra_instruction": "randomize",
                "model": "null",
            },
        )
        self.assertEqual(response.status, 400)  # vision-pro returns "red blue" which is not layout JSON
        response_cap = await self.client.post(
            "/ai_prompt_studio/caption_node",
            json={
                "mode": "caption",
                "modes": ["caption"],
                "image": {"data_url": data_url(make_split_probe_png(32))},
                "image_path": "4037085137",
                "extra_instruction": "randomize",
                "model": "null",
            },
        )
        self.assertEqual(response_cap.status, 200)
        body = await response_cap.json()
        self.assertEqual(body["caption"], "red blue")


if __name__ == "__main__":
    unittest.main()
