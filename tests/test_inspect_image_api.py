from __future__ import annotations

import base64
import io
import json
import tempfile
import unittest
from pathlib import Path

from aiohttp.test_utils import AioHTTPTestCase
from PIL import Image
from PIL.PngImagePlugin import PngInfo

from prompt_studio.aiohttp_api import StudioBackend, create_app
from prompt_studio.config import Settings


def _png_with_studio_metadata() -> bytes:
    im = Image.new("RGB", (800, 600), color=(30, 60, 90))
    info = PngInfo()
    workflow = {
        "nodes": [{
            "type": "AIPromptStudioCaption",
            "widgets_values": [json.dumps({
                "caption_text": "A futuristic city in the clouds",
                "layout_prompt": "City in lower half, clouds on top",
                "danbooru_prompt": "1scenery, floating city",
                "draft": {
                    "width": 800,
                    "height": 600,
                    "items": [{"label": "云上城市", "box_2d": [200, 100, 800, 500]}],
                },
            })],
        }],
    }
    info.add_text("workflow", json.dumps(workflow))
    buf = io.BytesIO()
    im.save(buf, format="PNG", pnginfo=info)
    return buf.getvalue()


class InspectImageApiTests(AioHTTPTestCase):
    async def get_application(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        home = Path(self.temp_dir.name)
        settings = Settings(
            base_url="http://127.0.0.1:3425/v1",
            api_key="sk-test-inspect",
            model="test-model",
            home=home,
            db_path=home / "sessions.sqlite3",
            audit_path=home / "audit.jsonl",
            media_dir=home / "media",
        )
        self.backend = StudioBackend(settings)
        return create_app(self.backend)

    def tearDown(self) -> None:
        super().tearDown()
        self.backend.close()
        self.temp_dir.cleanup()

    async def test_inspect_returns_prompts_and_draft_without_thumbnail(self):
        raw = _png_with_studio_metadata()
        resp = await self.client.post(
            "/ai_prompt_studio/inspect_image",
            json={
                "image_data": "data:image/png;base64," + base64.b64encode(raw).decode(),
                "filename": "CloudCity_001.png",
            },
        )
        self.assertEqual(resp.status, 200)
        data = await resp.json()
        self.assertTrue(data["found"])
        self.assertEqual(data["width"], 800)
        self.assertEqual(data["height"], 600)
        self.assertEqual(data["prompts"]["caption"], "A futuristic city in the clouds")
        self.assertEqual(len(data["draft"]["items"]), 1)
        self.assertNotIn("thumbnail", data)
        self.assertNotIn("tags", data)

    async def test_inspect_plain_png_reports_not_found(self):
        buf = io.BytesIO()
        Image.new("RGB", (64, 64), color=(10, 10, 10)).save(buf, format="PNG")
        resp = await self.client.post(
            "/ai_prompt_studio/inspect_image",
            json={"image_data": "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()},
        )
        self.assertEqual(resp.status, 200)
        data = await resp.json()
        self.assertFalse(data["found"])
        self.assertEqual(data["draft"]["items"], [])

    async def test_inspect_rejects_non_image(self):
        resp = await self.client.post(
            "/ai_prompt_studio/inspect_image",
            json={"image_data": base64.b64encode(b"not an image").decode()},
        )
        self.assertEqual(resp.status, 400)


if __name__ == "__main__":
    unittest.main()