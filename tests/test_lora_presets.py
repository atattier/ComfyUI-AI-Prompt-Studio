from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from prompt_studio.lora_presets import (
    BUILTIN_LORA_PRESETS,
    DEFAULT_LORA_CATEGORY,
    LoraPresetStore,
    clean_category_name,
    scan_available_loras,
)


class LoraPresetStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "lora_presets.sqlite3"
        self.store = LoraPresetStore(self.db_path)

    def tearDown(self):
        self.store.close()
        self.tmpdir.cleanup()

    def test_init_ensures_builtins(self):
        presets = self.store.list()
        self.assertGreaterEqual(len(presets), len(BUILTIN_LORA_PRESETS))
        first = presets[0]
        self.assertTrue(first["is_builtin"])
        self.assertIn("loras", first)
        self.assertIsInstance(first["loras"], list)
        self.assertGreater(len(first["loras"]), 0)

    def test_save_and_get_custom_preset(self):
        data = {
            "name": "测试 LoRA 堆叠",
            "category": "画风风格",
            "tags": ["测试", "二次元"],
            "loras": [
                {"name": "test_lora_a.safetensors", "strength_model": 0.8, "strength_clip": 0.9, "enabled": True},
                {"name": "test_lora_b.safetensors", "strength_model": 0.5, "strength_clip": 0.5, "enabled": False},
            ],
            "trigger_words": "masterpiece, test style, vibrant",
            "notes": "这只是一个单元测试预设",
        }
        saved = self.store.save(data)
        self.assertIsNotNone(saved["id"])
        self.assertEqual(saved["name"], "测试 LoRA 堆叠")
        self.assertEqual(len(saved["loras"]), 2)
        self.assertEqual(saved["loras"][0]["strength_model"], 0.8)

        fetched = self.store.get(saved["id"])
        self.assertIsNotNone(fetched)
        self.assertEqual(fetched["name"], "测试 LoRA 堆叠")
        self.assertEqual(fetched["trigger_words"], "masterpiece, test style, vibrant")

    def test_list_with_category_and_search(self):
        self.store.save({
            "name": "赛博机甲风",
            "category": "人物角色",
            "tags": ["机甲", "科幻"],
            "loras": [{"name": "mecha.safetensors", "strength_model": 1.0, "strength_clip": 1.0, "enabled": True}],
            "trigger_words": "mecha suit, glowing eyes",
        })
        self.store.save({
            "name": "唯美水彩风",
            "category": "画风风格",
            "tags": ["水彩", "清新"],
            "loras": [{"name": "watercolor.safetensors", "strength_model": 0.7, "strength_clip": 0.7, "enabled": True}],
            "trigger_words": "watercolor painting, soft tones",
        })

        all_presets = self.store.list()
        self.assertTrue(any(p["name"] == "赛博机甲风" for p in all_presets))
        self.assertTrue(any(p["name"] == "唯美水彩风" for p in all_presets))

        mecha_results = self.store.list(search="机甲")
        self.assertEqual(len(mecha_results), 1)
        self.assertEqual(mecha_results[0]["name"], "赛博机甲风")

        char_results = self.store.list(category="人物角色")
        self.assertTrue(all(p["category"] == "人物角色" for p in char_results))

    def test_delete_preset_and_builtin_masking(self):
        saved = self.store.save({"name": "临时预设", "loras": []})
        self.assertTrue(self.store.delete(saved["id"]))
        self.assertIsNone(self.store.get(saved["id"]))

        # Delete builtin
        builtin_id = BUILTIN_LORA_PRESETS[0]["id"]
        self.assertIsNotNone(self.store.get(builtin_id))
        self.assertTrue(self.store.delete(builtin_id))
        self.assertIsNone(self.store.get(builtin_id))

        # Reset builtins recovers it
        recovered_count = self.store.reset_builtins()
        self.assertGreaterEqual(recovered_count, len(BUILTIN_LORA_PRESETS))
        self.assertIsNotNone(self.store.get(builtin_id))

    def test_categories_management(self):
        cats = self.store.categories()
        self.assertIn("全部", cats)
        self.assertIn("画风风格", cats)

        # Add category
        added = self.store.add_category("新概念/武器")
        self.assertEqual(added, "新概念/武器")
        self.assertIn("新概念/武器", self.store.categories())
        self.assertIn("新概念/武器", self.store.custom_categories())

        # Rename category
        renamed = self.store.rename_category("新概念/武器", "新概念/科幻装备")
        self.assertEqual(renamed["new_name"], "新概念/科幻装备")
        self.assertIn("新概念/科幻装备", self.store.categories())

        # Delete category
        del_res = self.store.delete_category("新概念/科幻装备")
        self.assertEqual(del_res["deleted"], "新概念/科幻装备")
        self.assertNotIn("新概念/科幻装备", self.store.categories())

    def test_export_and_import(self):
        data = self.store.export_presets()
        self.assertIsInstance(data, list)
        self.assertGreater(len(data), 0)

        # Clean DB and reimport
        new_store = LoraPresetStore(Path(self.tmpdir.name) / "reimported.sqlite3")
        res = new_store.import_presets(data)
        self.assertEqual(res["imported"], len(data))
        new_store.close()

    def test_scan_available_loras_runs_without_crash(self):
        loras = scan_available_loras()
        self.assertIsInstance(loras, list)

    def test_save_with_image_data_and_get_image(self):
        # 1x1 transparent PNG base64
        tiny_png = (
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
        )
        saved = self.store.save({
            "name": "带效果图预设",
            "category": "通用",
            "loras": [{"name": "test.safetensors", "strength_model": 1.0}],
            "image_data": tiny_png,
        })
        self.assertTrue(saved.get("has_image"))
        self.assertTrue(saved.get("thumbnail"))

        # Verify get_image returns binary bytes
        img_res = self.store.get_image(saved["id"])
        self.assertIsNotNone(img_res)
        raw, mime, fn = img_res
        self.assertEqual(mime, "image/png")
        self.assertGreater(len(raw), 10)


if __name__ == "__main__":
    unittest.main()
