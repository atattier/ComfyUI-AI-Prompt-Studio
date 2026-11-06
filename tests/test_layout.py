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
    layout_instruction,
    match_canvas_size,
    parse_model_layout,
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
        self.assertIn("AT MOST 6", layout_instruction("layout", 1024, 1024))

    def test_instruction(self):
        text = layout_instruction("hybrid", 1248, 832, "强调构图")
        self.assertIn("COMPLETE", text)
        self.assertIn("1248x832", text)
        self.assertIn("强调构图", text)
        self.assertIn("0-1000", text)

    def test_draft_json_is_compact(self):
        self.assertIn('"bbox_format":"xyxy"', draft_json({"bbox_format": "xyxy"}))


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


if __name__ == "__main__":
    unittest.main()
