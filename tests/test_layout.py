"""Canvas size matching and layout draft tests."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

from prompt_studio.layout import (
    MAX_PIXELS,
    MAX_SIDE,
    MAX_ITEMS,
    MIN_SIDE,
    MULTIPLE,
    draft_json,
    infer_canvas_size_from_layout,
    layout_instruction,
    match_canvas_size,
    parse_any_layout,
    parse_model_layout,
    recover_partial_layout,
)

PROMPTBOARD = Path(
    "E:/AI/02_AI视频与视觉创作/ComfyUI插件/ComfyUI-MOSS-PromptBoard"
)


class CanvasSizeTests(unittest.TestCase):
    def assert_official(self, w: int, h: int) -> None:
        for side in (w, h):
            self.assertGreaterEqual(side, MIN_SIDE)
            self.assertLessEqual(side, MAX_SIDE)
            self.assertEqual(side % MULTIPLE, 0)
        self.assertLessEqual(w * h, MAX_PIXELS)

    def test_3_2(self):
        w, h = match_canvas_size(1500, 1000)
        self.assert_official(w, h)
        self.assertAlmostEqual(w / h, 1.5, places=6)
        self.assertEqual((w, h), (1248, 832))  # computed, not hardcoded from a whitelist

    def test_16_9(self):
        w, h = match_canvas_size(1920, 1080)
        self.assert_official(w, h)
        self.assertAlmostEqual(w / h, 16 / 9, places=6)
        self.assertEqual((w, h), (1280, 720))

    def test_1_1(self):
        w, h = match_canvas_size(1024, 1024)
        self.assert_official(w, h)
        self.assertEqual((w, h), (1024, 1024))

    def test_9_16(self):
        w, h = match_canvas_size(1080, 1920)
        self.assert_official(w, h)
        self.assertAlmostEqual(w / h, 9 / 16, places=6)
        self.assertEqual((w, h), (720, 1280))

    def test_aspect_error_is_primary(self):
        # 7:5 has no exact 16-multiple pair near 1M; the winner must still have
        # the smallest relative aspect error even if its area is not closest.
        w, h = match_canvas_size(1400, 1000)
        self.assert_official(w, h)
        self.assertAlmostEqual(w / h, 1.4, places=6)

    def test_extreme_ratio_clamps_to_bounds(self):
        w, h = match_canvas_size(4000, 100)
        self.assert_official(w, h)
        self.assertEqual((w, h), (2048, 256))

    def test_invalid_dimensions(self):
        for pair in ((0, 100), (-1, 50), (100, 0)):
            with self.subTest(pair=pair), self.assertRaises(ValueError):
                match_canvas_size(*pair)


class ModelLayoutTests(unittest.TestCase):
    def test_normalized_boxes_become_pixels(self):
        raw = json.dumps({
            "summary": {"caption": "A poster split in two."},
            "items": [
                {"label": "character", "caption": "A figure on the left", "bbox": [0, 0, 500, 1000]},
                {"label": "object", "caption": "Blue field", "bbox": [500, 0, 1000, 1000]},
            ],
        })
        draft = parse_model_layout(raw, 1024, 1024)
        self.assertEqual(draft["bbox_coord_space"], "abs")
        self.assertEqual(draft["bbox_format"], "xyxy")
        self.assertEqual(draft["items"][0]["bbox"], [0, 0, 512, 1024])
        self.assertEqual(draft["items"][1]["bbox"], [512, 0, 1024, 1024])

    def test_fractional_and_fenced_and_prose(self):
        raw = "Here is the layout:\n```json\n" + json.dumps({
            "summary": {"caption": "Two halves."},
            "items": [{"label": "text", "caption": "A sign", "bbox": [0.1, 0.2, 0.6, 0.5], "text": "SALE"}],
        }) + "\n```\nThanks!"
        draft = parse_model_layout(raw, 1000, 800)
        item = draft["items"][0]
        self.assertEqual(item["label"], "text")
        self.assertEqual(item["text"], "SALE")
        self.assertEqual(item["bbox"], [100, 160, 600, 400])

    def test_bad_inputs(self):
        for raw in ("", "not json", "[]", '{"summary":{"caption":"x"},"items":[]}',
                    '{"summary":{"caption":""},"items":[]}'):
            with self.subTest(raw=raw[:20]), self.assertRaises(ValueError):
                parse_model_layout(raw, 1024, 1024)

    def test_boxes_are_clamped_and_valid(self):
        draft = parse_model_layout(json.dumps({
            "summary": {"caption": "Clamped boxes."},
            "items": [{"label": "object", "caption": "whole", "bbox": [-500, -500, 9000, 9000]}],
        }), 1024, 768)
        bbox = draft["items"][0]["bbox"]
        self.assertEqual(bbox, [0, 0, 1024, 768])
        self.assertLess(bbox[0], bbox[2])
        self.assertLess(bbox[1], bbox[3])

    def test_over_segmentation_is_capped(self):
        raw = json.dumps({
            "summary": {"caption": "A busy screenshot."},
            "items": [
                {"label": "text", "caption": f"label {i}", "text": f"T{i}",
                 "bbox": [i * 40, 0, i * 40 + 30, 20]}
                for i in range(22)
            ] + [{"label": "character", "caption": "Main subject",
                  "bbox": [0, 0, 1000, 1000]}],
        })
        draft = parse_model_layout(raw, 1024, 1024)
        self.assertLessEqual(len(draft["items"]), MAX_ITEMS)
        self.assertIn("Main subject", [it["caption"] for it in draft["items"]])

    def test_instruction_limits_regions(self):
        self.assertIn("3–6 个框", layout_instruction("layout", 1024, 1024))

    def test_instruction(self):
        text = layout_instruction("hybrid", 1248, 832, "强调构图")
        # 坐标一律走 0–1000 归一化：提示词里不再出现画布像素尺寸，模型不用做换算
        self.assertNotIn("1248×832", text)
        self.assertIn("强调构图", text)
        self.assertIn("0–1000", text)

    def test_draft_json_is_compact(self):
        self.assertIn('"bbox_format":"xyxy"', draft_json({"bbox_format": "xyxy"}))

    def test_recover_partial_layout_salvages_completed_items(self):
        truncated = (
            '{"summary":{"caption":"Calm studio scene with {props}.","canvas":"single","meta":["portrait"]},'
            '"items":['
            '{"label":"object","name":"背景墙","caption":"Textured stone wall.","box_2d":[0,0,1000,1000]},'
            '{"label":"character","name":"女孩","caption":"Young woman standing on left.","box_2d":[100,200,900,650]},'
            '{"label":"object","name":"背包","caption":"Leather crossbody bag cut off mid-str'
        )
        draft = recover_partial_layout(truncated, 1024, 1024)
        self.assertIsNotNone(draft)
        assert draft is not None
        self.assertEqual(draft["summary"]["caption"], "Calm studio scene with {props}.")
        self.assertEqual(len(draft["items"]), 2)
        self.assertEqual(draft["items"][1]["label"], "character")

    def test_recover_partial_layout_returns_none_when_aborted_in_summary(self):
        self.assertIsNone(recover_partial_layout('{"summary":{"caption":"', 1024, 1024))
        self.assertIsNone(recover_partial_layout('{"summary":{"caption":"cut mid-sentence', 1024, 1024))


class LayoutSchemaValidationTests(unittest.TestCase):
    """A reply that ignores the items/coordinate contract must be reported, not silently guessed at."""

    def test_schema_mismatch_error_names_what_the_model_sent(self):
        # The exact shape deepseek-v4.1-flash returned for a real photo (2026-11-13 10:57).
        raw = json.dumps({
            "task": "layout_draft",
            "canvas": {"orientation": "landscape", "aspect_ratio": "4:3"},
            "elements": [
                {"id": "subject", "label": "cosplayer", "bbox": [0.28, 0.18, 0.62, 0.92]},
            ],
        })
        with self.assertRaises(ValueError) as ctx:
            parse_model_layout(raw, 832, 1216)
        message = str(ctx.exception)
        self.assertIn("items", message)
        self.assertIn("elements", message)

    def test_item_without_coordinates_is_dropped_and_reported(self):
        raw = json.dumps({
            "summary": {"caption": "Two regions."},
            "items": [
                {"label": "object", "name": "顶棚", "caption": "Ceiling.", "box_1000": [0, 0, 1000, 260]},
                {"label": "object", "name": "无坐标区域", "caption": "No coordinates at all."},
            ],
        })
        draft = parse_model_layout(raw, 832, 1216)
        self.assertEqual([it["name"] for it in draft["items"]], ["顶棚"])
        self.assertIn("无坐标区域", " ".join(draft.get("warnings") or []))

    def test_mixed_coordinate_conventions_are_reported(self):
        raw = json.dumps({
            "summary": {"caption": "Mixed conventions."},
            "items": [
                {"label": "object", "name": "百分制", "caption": "0-1000 box.", "box_1000": [0, 0, 1000, 260]},
                {"label": "character", "name": "小数制", "caption": "0-1 box.", "bbox": [0.28, 0.18, 0.62, 0.92]},
            ],
        })
        draft = parse_model_layout(raw, 832, 1216)
        self.assertEqual(len(draft["items"]), 2)
        self.assertIn("混用", " ".join(draft.get("warnings") or []))

    def test_moss_centralized_draft_is_not_reported_as_mixed(self):
        # abs_centralized drafts are pixels by definition; a wide box on a 2048 canvas must not look "mixed".
        raw = json.dumps({
            "summary": {"caption": "Centered pixels."},
            "bbox_coord_space": "abs_centralized",
            "bbox_format": "yxyx",
            "items": [
                {"label": "object", "name": "满幅", "caption": "Full width box.", "bbox": [-1024, -1024, 1024, 1024]},
                {"label": "object", "name": "小框", "caption": "Small box.", "bbox": [100, 200, 300, 400]},
            ],
        })
        draft = parse_model_layout(raw, 2048, 2048)
        self.assertEqual(len(draft["items"]), 2)
        self.assertFalse(draft.get("warnings"), draft.get("warnings"))

    def test_conforming_reply_reports_no_warnings(self):
        raw = json.dumps({
            "summary": {"caption": "Clean reply."},
            "items": [
                {"label": "character", "name": "女孩", "caption": "A girl.", "box_1000": [100, 200, 900, 950]},
                {"label": "object", "name": "地面", "caption": "The floor.", "box_1000": [0, 800, 1000, 1000]},
            ],
        })
        draft = parse_model_layout(raw, 832, 1216)
        self.assertEqual(len(draft["items"]), 2)
        self.assertFalse(draft.get("warnings"))


@unittest.skipUnless(PROMPTBOARD.is_dir(), "PromptBoard repo not available")
class PromptBoardCompatibilityTests(unittest.TestCase):
    """Use the real PromptBoard code, not a copy of its validator."""

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(PROMPTBOARD))
        cls.draft_mod = __import__("moss_prompt_board.draft", fromlist=["*"])
        cls.compiler = __import__("moss_prompt_board.vendor.compile_prompt", fromlist=["*"])

    def test_layout_draft_passes_real_compiler(self):
        w, h = match_canvas_size(1500, 1000)
        raw = json.dumps({
            "summary": {"caption": "A red and blue poster."},
            "items": [
                {"label": "object", "caption": "Red left half", "bbox": [0, 0, 480, 1000]},
                {"label": "character", "caption": "A figure", "bbox": [400, 200, 700, 900]},
                {"label": "text", "caption": "A sign", "bbox": [700, 0, 1000, 200], "text": "SALE"},
            ],
        })
        draft = parse_model_layout(raw, w, h)
        text = draft_json(draft)
        parsed, err = self.draft_mod.parse_draft_json(text)
        self.assertIsNone(err)
        clean = self.draft_mod.sanitize_layout_draft(parsed)
        compiled = self.compiler.compile_prompt(clean)
        self.assertIn("abs_centralized", compiled)
        self.assertIn("Red left half", compiled)

    def test_caption_mode_output_compiles_as_caption(self):
        # caption mode outputs plain text; PromptBoard's caption node takes it
        # via a caption draft, so verify that path too.
        clean = self.draft_mod.sanitize_caption_draft({"caption": "A red and blue poster."})
        self.assertEqual(self.compiler.compile_prompt(clean), "A red and blue poster.")


class AnyLayoutParsingAndSizeInferenceTests(unittest.TestCase):
    def test_infer_canvas_size_for_portrait_and_landscape_centralized_layouts(self):
        portrait = {
            "summary": {"caption": "Studio portrait"},
            "items": [
                {"label": "object", "caption": "bg", "bbox": [-608, -416, 608, 416]},
                {"label": "character", "caption": "girl", "bbox": [-400, -180, 520, 260]},
            ],
            "bbox_coord_space": "abs_centralized",
            "bbox_format": "yxyx",
        }
        self.assertEqual(infer_canvas_size_from_layout(portrait, 1024, 1024), (832, 1216))

        landscape = {
            "summary": {"caption": "Wide cinema still"},
            "items": [
                {"label": "object", "caption": "horizon", "bbox": [-416, -608, 416, 608]},
            ],
            "bbox_coord_space": "abs_centralized",
            "bbox_format": "yxyx",
        }
        self.assertEqual(infer_canvas_size_from_layout(landscape, 1024, 1024), (1216, 832))

        explicit = {"width": 1500, "height": 1000, "items": [{"label": "object", "caption": "x", "bbox": [0, 0, 100, 100]}]}
        self.assertEqual(infer_canvas_size_from_layout(explicit, 1024, 1024), (1248, 832))

    def test_parse_any_layout_centralized_yxyx_and_strips_cn_en_depth_tails(self):
        raw = "Here is the layout:\n```json\n" + json.dumps({
            "summary": {"caption": "A bright street poster.", "canvas": "single"},
            "items": [
                {
                    "label": "object",
                    "name": "背景墙",
                    "caption": "Brick wall backdrop. Behind the character.",
                    "bbox": [-608, -416, 608, 416],
                },
                {
                    "label": "character",
                    "name": "红发少女",
                    "caption": "红发少女站在街角。在「背景墙」前方，部分遮挡它。",
                    "bbox": [-408, -216, 508, 84],
                },
                {
                    "label": "text",
                    "name": "招牌文字",
                    "caption": "Glowing cafe sign",
                    "text": "OPEN",
                    "bbox": [-508, 84, -308, 384],
                },
            ],
            "bbox_coord_space": "abs_centralized",
            "bbox_format": "yxyx",
        }, ensure_ascii=False) + "\n```"

        draft, w, h = parse_any_layout(raw, width=1024, height=1024)
        self.assertEqual((w, h), (832, 1216))
        self.assertEqual(draft["width"], 832)
        self.assertEqual(draft["height"], 1216)
        self.assertEqual(draft["bbox_coord_space"], "abs")
        self.assertEqual(draft["bbox_format"], "xyxy")
        self.assertEqual(draft["items"][0]["bbox"], [0, 0, 832, 1216])
        self.assertEqual(draft["items"][1]["bbox"], [200, 200, 500, 1116])
        self.assertEqual(draft["items"][0]["caption"], "Brick wall backdrop.")
        self.assertEqual(draft["items"][1]["caption"], "红发少女站在街角。")
        self.assertEqual(draft["items"][2]["text"], "OPEN")

    def test_parse_any_layout_box_2d_box_1000_force_size_and_empty_summary(self):
        raw_box2d = json.dumps({
            "summary": {"caption": ""},
            "items": [
                {"label": "character", "caption": "Left hero", "box_2d": [100, 50, 900, 450]},
                {"label": "object", "caption": "Right tower", "box_1000": [600, 100, 950, 900]},
            ],
        })
        draft, w, h = parse_any_layout(raw_box2d, width=1280, height=720, force_size=True)
        self.assertEqual((w, h), (1280, 720))
        self.assertTrue(draft["summary"]["caption"].strip())
        self.assertEqual(draft["items"][0]["bbox"], [64, 72, 576, 648])
        self.assertEqual(draft["items"][1]["bbox"], [768, 72, 1216, 648])


if __name__ == "__main__":
    unittest.main()
