from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aiohttp.test_utils import AioHTTPTestCase

from prompt_studio.aiohttp_api import StudioBackend, create_app
from prompt_studio.config import Settings


class LoraPresetApiTests(AioHTTPTestCase):
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

    async def test_list_and_save_lora_preset_api(self):
        # 1. List presets (built-ins exist)
        resp = await self.client.get("/ai_prompt_studio/lora_presets")
        self.assertEqual(resp.status, 200)
        data = await resp.json()
        self.assertIn("presets", data)
        self.assertGreater(len(data["presets"]), 0)

        # 2. Save a custom lora preset
        new_preset = {
            "name": "API测试LoRA组合",
            "category": "画风风格",
            "tags": ["测试", "赛博"],
            "loras": [
                {"name": "cyber_test.safetensors", "strength_model": 0.8, "strength_clip": 0.8, "enabled": True}
            ],
            "trigger_words": "cyber city, neon lights",
            "notes": "API测试用",
        }
        resp = await self.client.post("/ai_prompt_studio/lora_presets", json=new_preset)
        self.assertEqual(resp.status, 200)
        saved = await resp.json()
        preset_id = saved["id"]
        self.assertEqual(saved["name"], "API测试LoRA组合")

        # 3. Get single preset
        resp = await self.client.get(f"/ai_prompt_studio/lora_presets/{preset_id}")
        self.assertEqual(resp.status, 200)
        single = await resp.json()
        self.assertEqual(single["id"], preset_id)

        # 4. Search and filter
        resp = await self.client.get("/ai_prompt_studio/lora_presets?search=API测试")
        self.assertEqual(resp.status, 200)
        search_res = await resp.json()
        self.assertEqual(len(search_res["presets"]), 1)
        self.assertEqual(search_res["presets"][0]["id"], preset_id)

        # 5. Delete preset
        resp = await self.client.delete(f"/ai_prompt_studio/lora_presets/{preset_id}")
        self.assertEqual(resp.status, 200)
        del_res = await resp.json()
        self.assertEqual(del_res["status"], "ok")

        # 6. Delete again -> 404
        resp = await self.client.delete(f"/ai_prompt_studio/lora_presets/{preset_id}")
        self.assertEqual(resp.status, 404)

    async def test_lora_categories_and_available_loras_api(self):
        # 1. Categories
        resp = await self.client.get("/ai_prompt_studio/lora_presets/categories")
        self.assertEqual(resp.status, 200)
        data = await resp.json()
        self.assertIn("categories", data)
        self.assertIn("custom", data)

        # 2. Add Category
        resp = await self.client.post("/ai_prompt_studio/lora_presets/categories", json={"name": "新测试分类"})
        self.assertEqual(resp.status, 201)
        cat_info = await resp.json()
        self.assertIn("新测试分类", cat_info["categories"])

        # 3. Rename Category
        resp = await self.client.put("/ai_prompt_studio/lora_presets/categories/新测试分类", json={"new_name": "更名测试分类"})
        self.assertEqual(resp.status, 200)
        cat_info2 = await resp.json()
        self.assertIn("更名测试分类", cat_info2["categories"])

        # 4. Delete Category
        resp = await self.client.delete("/ai_prompt_studio/lora_presets/categories/更名测试分类")
        self.assertEqual(resp.status, 200)

        # 5. Available loras route
        resp = await self.client.get("/ai_prompt_studio/lora_presets/available_loras")
        self.assertEqual(resp.status, 200)
        loras_data = await resp.json()
        self.assertIn("loras", loras_data)
        self.assertIsInstance(loras_data["loras"], list)

    async def test_inspect_image_loras_api(self):
        import io, base64, json
        from PIL import Image, PngImagePlugin

        # Create an in-memory PNG with ComfyUI prompt chunk
        im = Image.new("RGB", (64, 64), color="blue")
        pnginfo = PngImagePlugin.PngInfo()
        mock_prompt = {
            "3": {
                "class_type": "LoraLoader",
                "inputs": {
                    "lora_name": "cyber_girl_v2.safetensors",
                    "strength_model": 0.85,
                    "strength_clip": 0.75,
                },
            }
        }
        pnginfo.add_text("prompt", json.dumps(mock_prompt))
        buf = io.BytesIO()
        im.save(buf, format="PNG", pnginfo=pnginfo)
        b64_str = f"data:image/png;base64,{base64.b64encode(buf.getvalue()).decode('ascii')}"

        resp = await self.client.post(
            "/ai_prompt_studio/lora_presets/inspect_image_loras",
            json={"image_data": b64_str, "filename": "cyber_render_001.png"},
        )
        self.assertEqual(resp.status, 200)
        result = await resp.json()
        self.assertIn("loras", result)
        self.assertEqual(len(result["loras"]), 1)
        self.assertEqual(result["loras"][0]["name"], "cyber_girl_v2.safetensors")
        self.assertEqual(result["loras"][0]["strength_model"], 0.85)
        self.assertEqual(result["loras"][0]["strength_clip"], 0.75)
        self.assertIn("cyber render", result["suggested_name"].lower())

    async def test_reset_builtins_api(self):
        resp = await self.client.post("/ai_prompt_studio/lora_presets/reset_builtins")
        self.assertEqual(resp.status, 200)
        data = await resp.json()
        self.assertEqual(data["status"], "ok")
        self.assertGreater(data["recovered_count"], 0)


if __name__ == "__main__":
    unittest.main()
