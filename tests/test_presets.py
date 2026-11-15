from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from prompt_studio.presets import PresetStore, BUILTIN_PRESETS


class PresetStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "test_presets.sqlite3"
        self.store = PresetStore(self.db_path)

    def tearDown(self) -> None:
        self.store.close()
        self.temp_dir.cleanup()

    def test_initializes_with_builtins(self) -> None:
        presets = self.store.list()
        self.assertGreaterEqual(len(presets), len(BUILTIN_PRESETS))
        first = presets[0]
        self.assertTrue(first["is_builtin"])
        self.assertIn("prompts", first)
        self.assertIn("draft", first)

    def test_save_and_retrieve_custom_preset(self) -> None:
        saved = self.store.save({
            "name": "测试自定义构图",
            "category": "测试分类",
            "tags": ["特写", "电影感"],
            "width": 1280,
            "height": 720,
            "prompts": {
                "caption": "test caption",
                "danbooru": "test danbooru",
            },
            "draft": {
                "items": [{"label": "主体", "box_2d": [100, 100, 900, 900]}],
                "width": 1280,
                "height": 720,
            },
        })
        self.assertTrue(saved["id"].startswith("preset_"))
        self.assertEqual(saved["name"], "测试自定义构图")
        self.assertFalse(saved["is_builtin"])

        # Fetch
        got = self.store.get(saved["id"])
        self.assertIsNotNone(got)
        self.assertEqual(got["category"], "测试分类")
        self.assertEqual(got["width"], 1280)
        self.assertEqual(got["prompts"]["caption"], "test caption")

    def test_filter_by_category_and_search(self) -> None:
        self.store.save({
            "name": "赛博朋克霓虹街景",
            "category": "科幻场景",
            "tags": ["赛博朋克", "夜景"],
            "width": 1024,
            "height": 1024,
            "prompts": {"caption": "cyberpunk city"},
        })
        # Filter by category
        res = self.store.list(category="科幻场景")
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0]["name"], "赛博朋克霓虹街景")

        # Search keyword
        search_res = self.store.list(search="霓虹")
        self.assertEqual(len(search_res), 1)
        self.assertEqual(search_res[0]["name"], "赛博朋克霓虹街景")

    def test_builtin_can_be_deleted_and_restored(self) -> None:
        builtins = [p for p in self.store.list() if p["is_builtin"]]
        self.assertTrue(len(builtins) > 0)
        target_id = builtins[0]["id"]
        # Deletion succeeds
        self.assertTrue(self.store.delete(target_id))
        self.assertIsNone(self.store.get(target_id))

        # Re-calling _ensure_builtins does NOT resurrect it because deleted_builtins tracks it
        self.store._ensure_builtins()
        self.assertIsNone(self.store.get(target_id))

        # reset_builtins restores it
        self.store.reset_builtins()
        self.assertIsNotNone(self.store.get(target_id))

    def test_delete_custom_preset(self) -> None:
        saved = self.store.save({"name": "临时预设", "category": "测试"})
        self.assertTrue(self.store.delete(saved["id"]))
        self.assertIsNone(self.store.get(saved["id"]))

    def test_import_and_export(self) -> None:
        all_presets = self.store.export_all()
        self.assertGreater(len(all_presets), 0)

    def test_summarize_preset_title(self) -> None:
        from prompt_studio.presets import heuristic_title_from_prompt, summarize_title_from_prompt

        title1 = heuristic_title_from_prompt("A low-angle shot of Suzuran from Arknights in a kimono")
        self.assertIn("铃兰", title1)

        title2 = heuristic_title_from_prompt("A cinematic shot of 2girls facing each other")
        self.assertIn("双人", title2)

        # summarize_preset_title on saved preset
        saved = self.store.save({
            "name": "20261111132944",
            "category": "通用",
            "prompts": {"caption": "A portrait of 1girl wearing a kimono with detailed face and soft lighting"},
        })
        updated = self.store.summarize_preset_title(saved["id"])
        self.assertNotEqual(updated["name"], "20261111132944")
        self.assertTrue(len(updated["name"]) >= 2)

        imported_count = self.store.import_presets([
            {
                "name": "外部导入预设",
                "category": "分享",
                "tags": ["分享"],
                "width": 768,
                "height": 1024,
                "prompts": {"caption": "imported"},
            }
        ])
        self.assertEqual(imported_count, 1)
        search = self.store.list(search="外部导入")
        self.assertEqual(len(search), 1)

    # -- user-created categories ------------------------------------------------
    def test_user_can_create_and_delete_empty_category(self) -> None:
        cats = self.store.add_category("我的角色库")
        self.assertIn("我的角色库", cats)
        self.assertIn("我的角色库", self.store.custom_categories())
        # idempotent
        self.assertEqual(self.store.add_category("  我的角色库 ").count("我的角色库"), 1)

        result = self.store.delete_category("我的角色库")
        self.assertEqual(result["moved_presets"], 0)
        self.assertNotIn("我的角色库", self.store.categories())

    def test_category_validation_and_protection(self) -> None:
        with self.assertRaises(ValueError):
            self.store.add_category("   ")
        with self.assertRaises(ValueError):
            self.store.add_category("全部")
        with self.assertRaises(ValueError):
            self.store.add_category("x" * 200)
        with self.assertRaises(ValueError):
            self.store.delete_category("通用")
        with self.assertRaises(KeyError):
            self.store.delete_category("不存在的目录")

    def test_hierarchical_subcategories_and_renaming(self) -> None:
        # Create subcategories
        cats = self.store.add_category("人物/单人特写")
        self.assertIn("人物", cats)
        self.assertIn("人物/单人特写", cats)

        # Save presets into parent and child
        p1 = self.store.save({"name": "全身像", "category": "人物"})
        p2 = self.store.save({"name": "眼神特写", "category": "人物/单人特写"})

        # Filtering parent returns both parent and subcategory items
        parent_items = self.store.list(category="人物")
        self.assertEqual(len(parent_items), 2)

        # Filtering subcategory returns only subcategory items
        sub_items = self.store.list(category="人物/单人特写")
        self.assertEqual(len(sub_items), 1)
        self.assertEqual(sub_items[0]["name"], "眼神特写")

        # Renaming parent renames parent and all subcategories
        renamed_info = self.store.rename_category("人物", "角色")
        self.assertEqual(renamed_info["renamed"], 1)
        self.assertEqual(self.store.get(p1["id"])["category"], "角色")
        self.assertEqual(self.store.get(p2["id"])["category"], "角色/单人特写")
        self.assertIn("角色/单人特写", self.store.categories())
        self.assertNotIn("人物/单人特写", self.store.categories())

        # Deleting parent moves all nested presets to fallback (通用)
        del_info = self.store.delete_category("角色")
        self.assertEqual(del_info["moved_presets"], 2)
        self.assertEqual(self.store.get(p1["id"])["category"], "通用")
        self.assertEqual(self.store.get(p2["id"])["category"], "通用")

    def test_deleting_category_moves_presets_to_default(self) -> None:
        self.store.add_category("临时目录")
        saved = self.store.save({"name": "待迁移", "category": "临时目录"})
        result = self.store.delete_category("临时目录")
        self.assertEqual(result["moved_presets"], 1)
        self.assertEqual(self.store.get(saved["id"])["category"], "通用")

    # -- attached original image (keeps ComfyUI metadata bytes intact) ---------
    def test_preset_image_is_stored_verbatim_and_removed_with_preset(self) -> None:
        import base64

        png = b"\x89PNG\r\n\x1a\n" + b"tEXtworkflow\x00{\"nodes\":[]}" + b"\x00" * 32
        data_url = "data:image/png;base64," + base64.b64encode(png).decode()
        saved = self.store.save({"name": "带图预设", "category": "通用", "image_data": data_url})
        self.assertTrue(saved["has_image"])
        raw, mime, filename = self.store.get_image(saved["id"])
        self.assertEqual(raw, png)  # byte-identical so embedded metadata survives
        self.assertEqual(mime, "image/png")

        # Re-saving without image_data keeps the attachment
        again = self.store.save({"id": saved["id"], "name": "改名后", "category": "通用"})
        self.assertTrue(again["has_image"])

        path = self.store.images_dir / filename
        self.assertTrue(path.exists())
        self.store.delete(saved["id"])
        self.assertFalse(path.exists())

    def test_preset_image_rejects_non_images(self) -> None:
        import base64

        bad = "data:image/png;base64," + base64.b64encode(b"<html>not an image</html>").decode()
        with self.assertRaises(ValueError):
            self.store.save({"name": "坏图", "image_data": bad})
        with self.assertRaises(ValueError):
            self.store.save({"name": "坏图2", "image_data": "###"})
        self.assertEqual(self.store.list(search="坏图"), [])

    def test_import_ignores_image_payloads(self) -> None:
        import base64

        png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
        self.store.import_presets(
            [{"name": "导入带图", "category": "分享目录", "image_data": base64.b64encode(png).decode()}]
        )
        found = self.store.list(search="导入带图")[0]
        self.assertFalse(found["has_image"])
        self.assertIn("分享目录", self.store.categories())


    def test_import_from_image_with_comfy_metadata(self) -> None:
        import io
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo

        # Create a test PNG with embedded ComfyUI metadata
        im = Image.new("RGB", (800, 600), color=(30, 60, 90))
        png_info = PngInfo()
        studio_workflow = {
            "nodes": [
                {
                    "type": "AIPromptStudioCaption",
                    "widgets_values": [
                        json.dumps({
                            "caption_text": "A futuristic city in the clouds",
                            "layout_prompt": "City buildings in lower half, clouds on top",
                            "danbooru_prompt": "1scenery, floating city, clouds",
                            "draft": {
                                "width": 800,
                                "height": 600,
                                "items": [{"label": "云上城市", "box_2d": [200, 100, 800, 500]}],
                            },
                        })
                    ],
                }
            ]
        }
        png_info.add_text("workflow", json.dumps(studio_workflow))
        buf = io.BytesIO()
        im.save(buf, format="PNG", pnginfo=png_info)
        raw_bytes = buf.getvalue()

        saved = self.store.import_from_image(raw_bytes, filename="CloudCity_001.png", category="场景/科幻")
        self.assertTrue(saved["has_image"])
        self.assertEqual(saved["name"], "CloudCity_001")
        self.assertEqual(saved["category"], "场景/科幻")
        self.assertEqual(saved["width"], 800)
        self.assertEqual(saved["height"], 600)
        self.assertEqual(saved["prompts"]["caption"], "A futuristic city in the clouds")
        self.assertEqual(len(saved["draft"]["items"]), 1)
        self.assertIn("AI画框", saved["tags"])

    def test_rename_category_no_collision_and_slash_normalization(self) -> None:
        self.store.add_category("旧大类/子类")
        self.store.add_category("目标大类")
        saved = self.store.save({"name": "斜杠预设", "category": "旧大类\\子类"})
        self.assertEqual(saved["category"], "旧大类/子类")

        res = self.store.rename_category("旧大类", "目标大类")
        self.assertEqual(res["renamed"], 1)
        self.assertEqual(self.store.get(saved["id"])["category"], "目标大类/子类")
        self.assertIn("目标大类/子类", self.store.categories())
        self.assertNotIn("旧大类", self.store.categories())

    def test_backtrace_dag_ignores_orphan_studio_node(self) -> None:
        """Verify that when an orphan AIPromptStudioCaption exists on canvas, the DAG backtrace

        accurately extracts the prompt from the active KSampler pipeline instead of the orphan.
        """
        import io
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo

        im = Image.new("RGB", (1296, 1920), color=(100, 150, 200))
        png_info = PngInfo()

        # Construct DAG:
        # Node 1: orphan AIPromptStudioCaption (stale Suzuran)
        # Node 10: PrimitiveStringMultiline (active real prompt: 2girls, horns)
        # Node 20: ShowText (input linked to Node 10)
        # Node 30: CLIPTextEncode (input linked to Node 20)
        # Node 40: KSampler (positive linked to Node 30)
        # Node 50: VAEDecode (samples linked to Node 40)
        # Node 60: SaveImage (images linked to Node 50)
        active_dag_prompt = {
            "1": {
                "class_type": "AIPromptStudioCaption",
                "inputs": {
                    "payload": json.dumps({"caption_text": "STALE ORPHAN SUZURAN", "draft": {"items": []}})
                },
            },
            "10": {
                "class_type": "PrimitiveStringMultiline",
                "inputs": {
                    "value": '2girls, horns, wuthering waves {"summary":{"caption":"Real anime girls with horns"},"items":[{"label":"character","bbox":[-500,-500,500,500]}],"bbox_coord_space":"abs_centralized","bbox_format":"yxyx"}'
                },
            },
            "20": {
                "class_type": "ShowText|pysssss",
                "inputs": {
                    "text": ["10", 0],
                    "text_0": "STALE CACHED WIDGET VALUE",
                },
            },
            "30": {
                "class_type": "CLIPTextEncode",
                "inputs": {
                    "text": ["20", 0],
                },
            },
            "40": {
                "class_type": "KSampler",
                "inputs": {
                    "positive": ["30", 0],
                },
            },
            "50": {
                "class_type": "VAEDecode",
                "inputs": {
                    "samples": ["40", 0],
                },
            },
            "60": {
                "class_type": "SaveImage",
                "inputs": {
                    "images": ["50", 0],
                },
            },
        }

        png_info.add_text("prompt", json.dumps(active_dag_prompt))
        buf = io.BytesIO()
        im.save(buf, format="PNG", pnginfo=png_info)
        raw_bytes = buf.getvalue()

        saved = self.store.import_from_image(raw_bytes, filename="20261111132944.png", category="通用")
        self.assertNotIn("STALE", saved["prompts"]["caption"])
        self.assertNotIn("STALE", saved["prompts"]["danbooru"])
        self.assertEqual(saved["prompts"]["caption"], "Real anime girls with horns")
        self.assertIn("2girls", saved["prompts"]["danbooru"])
        self.assertIn("horns", saved["prompts"]["danbooru"])
        self.assertEqual(len(saved["draft"]["items"]), 1)
        self.assertIn("双人", saved["name"])
        self.assertIn("角娘", saved["name"])

        # Test reload_preset_metadata
        reloaded = self.store.reload_preset_metadata(saved["id"])
        self.assertEqual(reloaded["id"], saved["id"])
        self.assertEqual(reloaded["prompts"]["caption"], "Real anime girls with horns")
        self.assertEqual(len(reloaded["draft"]["items"]), 1)

    def test_extract_multistage_3_stage_pipeline(self) -> None:
        """Verify 1-stage, 2-stage, and 3-stage pipelines preserve all distinct prompt stages in order."""
        import io
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo

        # Build a 3-stage workflow: Stage 1 (Concat Danbooru) -> Stage 2 (Prose) -> Stage 3 (FaceDetailer)
        dag = {
            "10": {"class_type": "PrimitiveStringMultiline", "inputs": {"value": "@nyalia,"}},
            "11": {"class_type": "PrimitiveStringMultiline", "inputs": {"value": "1girl, solo, kimono, fox ears"}},
            "12": {
                "class_type": "StringConcatenate",
                "inputs": {"string_a": ["10", 0], "string_b": ["11", 0], "delimiter": ", "},
            },
            "13": {
                "class_type": "CLIPTextEncode",
                "_meta": {"title": "一采正向词"},
                "inputs": {"text": ["12", 0]},
            },
            "14": {"class_type": "KSampler", "inputs": {"positive": ["13", 0]}},
            "15": {"class_type": "VAEDecode", "inputs": {"samples": ["14", 0]}},

            # Stage 2: Second sampler refiner with prose description
            "20": {"class_type": "VAEEncode", "inputs": {"pixels": ["15", 0]}},
            "21": {
                "class_type": "CLIPTextEncode",
                "_meta": {"title": "二采自然语言"},
                "inputs": {"text": "A sunlit wooden corridor portrait of a fox-eared maiden."},
            },
            "22": {
                "class_type": "KSampler",
                "inputs": {"positive": ["21", 0], "latent_image": ["20", 0]},
            },
            "23": {"class_type": "VAEDecode", "inputs": {"samples": ["22", 0]}},

            # Stage 3: FaceDetailer with dedicated 3rd prompt
            "30": {
                "class_type": "CLIPTextEncode",
                "_meta": {"title": "三采面部精修"},
                "inputs": {"text": "intricate golden iris, crisp eyelashes, glossy lips"},
            },
            "31": {
                "class_type": "FaceDetailer",
                "inputs": {"image": ["23", 0], "positive": ["30", 0]},
            },
            "40": {"class_type": "SaveImage", "inputs": {"images": ["31", 0]}},
        }

        im = Image.new("RGB", (512, 512), color=(40, 80, 120))
        png_info = PngInfo()
        png_info.add_text("prompt", json.dumps(dag))
        buf = io.BytesIO()
        im.save(buf, format="PNG", pnginfo=png_info)

        saved = self.store.import_from_image(buf.getvalue(), filename="three_stage.png")
        prompts = saved["prompts"]
        stages = prompts.get("stages", [])

        self.assertEqual(len(stages), 3)
        self.assertEqual(stages[0]["title"], "一采正向词")
        self.assertEqual(stages[0]["danbooru"], "@nyalia, 1girl, solo, kimono, fox ears")
        self.assertNotIn(",,", stages[0]["danbooru"])

        self.assertEqual(stages[1]["title"], "二采自然语言")
        self.assertEqual(stages[1]["caption"], "A sunlit wooden corridor portrait of a fox-eared maiden.")

        self.assertEqual(stages[2]["title"], "三采面部精修")
        self.assertIn("intricate golden iris", stages[2]["raw_text"])

        self.assertIn("3段工作流", saved["tags"])
        self.assertEqual(prompts["danbooru"], "@nyalia, 1girl, solo, kimono, fox ears")
        self.assertEqual(prompts["caption"], "A sunlit wooden corridor portrait of a fox-eared maiden.")


if __name__ == "__main__":
    unittest.main()
