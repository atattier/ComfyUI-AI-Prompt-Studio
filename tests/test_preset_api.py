from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aiohttp.test_utils import AioHTTPTestCase

from prompt_studio.aiohttp_api import StudioBackend, create_app
from prompt_studio.config import Settings


class PresetApiTests(AioHTTPTestCase):
    async def get_application(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        home = Path(self.temp_dir.name)
        settings = Settings(
            base_url="http://127.0.0.1:3425/v1",
            api_key="sk-mock-test-key",
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

    async def test_list_and_save_preset_api(self):
        # 1. List presets (built-ins exist)
        resp = await self.client.get("/ai_prompt_studio/presets")
        self.assertEqual(resp.status, 200)
        data = await resp.json()
        self.assertIn("presets", data)
        self.assertGreater(len(data["presets"]), 0)

        # 2. Save a custom preset
        new_preset = {
            "name": "API测试构图",
            "category": "微距",
            "tags": ["微距", "细节"],
            "width": 1024,
            "height": 1024,
            "prompts": {"caption": "macro close up shot"},
            "draft": {"items": []},
        }
        resp = await self.client.post("/ai_prompt_studio/presets", json=new_preset)
        self.assertEqual(resp.status, 200)
        saved = await resp.json()
        preset_id = saved["id"]
        self.assertEqual(saved["name"], "API测试构图")

        # 3. Get single preset
        resp = await self.client.get(f"/ai_prompt_studio/presets/{preset_id}")
        self.assertEqual(resp.status, 200)
        single = await resp.json()
        self.assertEqual(single["id"], preset_id)

        # 4. Filter by category
        resp = await self.client.get("/ai_prompt_studio/presets?category=微距")
        self.assertEqual(resp.status, 200)
        cat_data = await resp.json()
        self.assertEqual(len(cat_data["presets"]), 1)
        self.assertEqual(cat_data["presets"][0]["id"], preset_id)

        # 5. Delete preset
        resp = await self.client.delete(f"/ai_prompt_studio/presets/{preset_id}")
        self.assertEqual(resp.status, 200)
        del_res = await resp.json()
        self.assertEqual(del_res["status"], "ok")

        # 6. Delete again -> 404
        resp = await self.client.delete(f"/ai_prompt_studio/presets/{preset_id}")
        self.assertEqual(resp.status, 404)

    async def test_user_categories_over_http(self):
        resp = await self.client.post("/ai_prompt_studio/presets/categories", json={"name": "我的目录"})
        self.assertEqual(resp.status, 200)
        info = await resp.json()
        self.assertIn("我的目录", info["categories"])
        self.assertIn("我的目录", info["custom"])

        resp = await self.client.post("/ai_prompt_studio/presets/categories", json={"name": "  "})
        self.assertEqual(resp.status, 400)

        resp = await self.client.get("/ai_prompt_studio/presets/categories")
        self.assertIn("我的目录", (await resp.json())["categories"])

        # percent-encoded Chinese name in the path
        resp = await self.client.delete("/ai_prompt_studio/presets/categories/%E6%88%91%E7%9A%84%E7%9B%AE%E5%BD%95")
        self.assertEqual(resp.status, 200)
        self.assertNotIn("我的目录", (await resp.json())["categories"])

        resp = await self.client.delete("/ai_prompt_studio/presets/categories/%E9%80%9A%E7%94%A8")
        self.assertEqual(resp.status, 400)
        resp = await self.client.delete("/ai_prompt_studio/presets/categories/nope")
        self.assertEqual(resp.status, 404)

    async def test_preset_image_roundtrip_over_http(self):
        import base64

        png = b"\x89PNG\r\n\x1a\n" + b"tEXtprompt\x00{}" + b"\x01" * 24
        resp = await self.client.post(
            "/ai_prompt_studio/presets",
            json={
                "name": "带原图",
                "category": "通用",
                "image_data": "data:image/png;base64," + base64.b64encode(png).decode(),
                "thumbnail": "data:image/jpeg;base64,AAAA",
            },
        )
        self.assertEqual(resp.status, 200)
        saved = await resp.json()
        self.assertTrue(saved["has_image"])

        resp = await self.client.get(f"/ai_prompt_studio/presets/{saved['id']}/image")
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.headers["Content-Type"], "image/png")
        self.assertEqual(await resp.read(), png)

        resp = await self.client.post(
            "/ai_prompt_studio/presets", json={"name": "坏图", "image_data": "data:image/png;base64,AAAA"}
        )
        self.assertEqual(resp.status, 400)

        resp = await self.client.get("/ai_prompt_studio/presets/builtin_dual_cinematic_widescreen/image")
        self.assertEqual(resp.status, 404)

    async def test_category_rename_and_image_import_over_http(self):
        import base64
        import io
        from PIL import Image

        # 1. Rename category
        await self.client.post("/ai_prompt_studio/presets/categories", json={"name": "旧目录/子目录"})
        resp = await self.client.put(
            "/ai_prompt_studio/presets/categories/%E6%97%A7%E7%9B%AE%E5%BD%95",
            json={"new_name": "新目录"},
        )
        self.assertEqual(resp.status, 200)
        renamed_data = await resp.json()
        self.assertIn("新目录/子目录", renamed_data["categories"])
        self.assertNotIn("旧目录/子目录", renamed_data["categories"])

        # 2. Import preset directly from image
        im = Image.new("RGB", (640, 480), color=(10, 20, 30))
        buf = io.BytesIO()
        im.save(buf, format="PNG")
        png_bytes = buf.getvalue()
        b64_png = "data:image/png;base64," + base64.b64encode(png_bytes).decode()

        resp = await self.client.post(
            "/ai_prompt_studio/presets/import_image",
            json={"image_data": b64_png, "filename": "test_import.png", "category": "测试/导入"},
        )
        self.assertEqual(resp.status, 201)
        imported = await resp.json()
        self.assertTrue(imported["has_image"])
        self.assertEqual(imported["width"], 640)
        self.assertEqual(imported["height"], 480)
        self.assertEqual(imported["category"], "测试/导入")


if __name__ == "__main__":
    unittest.main()
