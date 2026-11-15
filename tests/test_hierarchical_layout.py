import unittest
import json
from prompt_studio.layout import (
    parse_model_layout,
    layout_instruction,
    _infer_name,
    _item_importance_score,
    MAX_ITEMS,
)

class HierarchicalLayoutTests(unittest.TestCase):
    def test_parse_with_name_and_parent(self):
        raw = json.dumps({
            "summary": {"caption": "A girl with halo and crystal wings in a cafe."},
            "items": [
                {
                    "name": "咖啡厅内景",
                    "label": "object",
                    "bbox": [0, 0, 1000, 1000],
                    "caption": "Warm ambient cafe interior with glass doors.",
                },
                {
                    "name": "红发少女",
                    "label": "character",
                    "bbox": [400, 200, 900, 850],
                    "caption": "Girl with red hair and tactical windbreaker.",
                },
                {
                    "name": "光环",
                    "label": "character",
                    "parent": "红发少女",
                    "bbox": [650, 150, 850, 300],
                    "caption": "Luminous glowing concentric halo floating above head.",
                },
                {
                    "name": "光之碎片翼",
                    "label": "character",
                    "parent": "红发少女",
                    "bbox": [750, 400, 950, 700],
                    "caption": "Wings made of sharp crystalline light shards.",
                },
                {
                    "name": "海报标题",
                    "label": "text",
                    "parent": "门上宣传海报",
                    "text": "THE YAVHERT",
                    "bbox": [280, 80, 440, 200],
                    "caption": "Bold English typography reading THE YAVHERT.",
                },
            ],
        })

        res = parse_model_layout(raw, 1024, 1024, max_items=16)
        self.assertEqual(len(res["items"]), 5)
        names = [it["name"] for it in res["items"]]
        self.assertIn("咖啡厅内景", names)
        self.assertIn("红发少女", names)
        self.assertIn("光环", names)
        self.assertIn("光之碎片翼", names)
        self.assertIn("海报标题", names)

        halo_item = next(it for it in res["items"] if it["name"] == "光环")
        self.assertEqual(halo_item["parent"], "红发少女")

        text_item = next(it for it in res["items"] if it["name"] == "海报标题")
        self.assertEqual(text_item["text"], "THE YAVHERT")

    def test_infer_name_when_omitted(self):
        it_halo = {"caption": "A floating halo with soft glow", "bbox": [0, 0, 100, 100]}
        self.assertEqual(_infer_name(it_halo, "character", 0), "光环")

        it_wing = {"caption": "Wings made of light shards", "bbox": [0, 0, 100, 100]}
        self.assertEqual(_infer_name(it_wing, "character", 1), "光之碎片翼")

        it_door = {"caption": "Glass door leading to cafe", "bbox": [0, 0, 100, 100]}
        self.assertEqual(_infer_name(it_door, "object", 2), "玻璃门")

        it_poster = {"caption": "Promo poster pasted on door", "bbox": [0, 0, 100, 100]}
        self.assertEqual(_infer_name(it_poster, "object", 3), "宣传海报")

        it_text = {"caption": "Title text NOVPRO", "text": "NOVPRO", "bbox": [0, 0, 100, 100]}
        self.assertIn("NOVPRO", _infer_name(it_text, "text", 4))

    def test_diverse_importance_scoring_preserves_halo_and_text(self):
        # Even if background is 1000x1000, small halo and text must have high priority
        items = [
            {"name": "超大无用背景", "label": "object", "bbox": [0, 0, 1000, 1000], "caption": "Background wall"},
            {"name": "地板", "label": "object", "bbox": [0, 800, 1000, 1000], "caption": "Floor texture"},
            {"name": "光环", "label": "character", "bbox": [600, 100, 750, 250], "caption": "Floating halo"},
            {"name": "海报标题", "label": "text", "text": "SALE", "bbox": [200, 100, 300, 150], "caption": "Text title"},
        ]
        scores = [_item_importance_score(it) for it in items]
        self.assertGreater(scores[2], scores[0])  # Halo score > big empty background
        self.assertGreater(scores[3], scores[1])  # Text score > floor

    def test_layout_instruction_graph_directives(self):
        instr = layout_instruction("hybrid", 1024, 1024, max_regions=12)
        self.assertIn("3–12 个框", instr)
        self.assertIn("从远到近", instr)
        self.assertIn("0–1000", instr)

    def test_moss_prompt_studio_compilation_and_depth_phrases(self):
        from prompt_studio.layout import compile_layout_dict, compile_layout_prompt, layout_instruction
        raw = json.dumps({
            "summary": {
                "caption": "A waist-up portrait of an ethereal fair-skinned young woman with long ash-blonde hair in an urban setting.",
                "canvas": "single",
                "meta": ["outdoors", "portrait", "fashion"],
                "palette": ["sage green", "cream white", "charcoal black", "dark brown", "ash blonde"],
            },
            "items": [
                {
                    "name": "背景建筑",
                    "label": "object",
                    "caption": "Blurred classical stone arches and columns enveloped in cool, diffused overcast lighting.",
                    "box_2d": [0, 0, 1000, 1000],
                },
                {
                    "name": "年轻女子",
                    "label": "character",
                    "caption": "A fair-skinned young woman with delicate features, light hazel eyes, and ash-blonde half-up hair.",
                    "box_2d": [0, 50, 1000, 950],
                },
                {
                    "name": "鼠尾草绿大衣",
                    "label": "object",
                    "caption": "An oversized sage-green wool overcoat with broad lapels.",
                    "box_2d": [230, 50, 1000, 940],
                },
                {
                    "name": "斜挎包",
                    "label": "object",
                    "caption": "A dark brown crossbody duffle bag slung over her left shoulder.",
                    "box_2d": [260, 530, 910, 1000],
                },
            ],
        })
        draft = parse_model_layout(raw, 968, 1464, max_items=16)
        compiled = compile_layout_dict(draft)
        self.assertEqual(compiled["bbox_coord_space"], "abs_centralized")
        self.assertEqual(compiled["bbox_format"], "yxyx")
        self.assertEqual(compiled["summary"]["meta"], ["outdoors", "portrait", "fashion"])
        self.assertEqual(compiled["summary"]["palette"], ["sage green", "cream white", "charcoal black", "dark brown", "ash blonde"])
        self.assertIn("Behind 「年轻女子」, partly hidden by it", compiled["items"][0]["caption"])
        self.assertIn("In front of 「背景建筑」, partially occluding it", compiled["items"][1]["caption"])
        self.assertIn("behind 「鼠尾草绿大衣」, partly hidden by it", compiled["items"][1]["caption"])
        # Verify Gemini box_2d instruction selection
        gemini_instr = layout_instruction("hybrid", 968, 1464, model="gemini-3-flash-preview", caption_hint="A waist-up portrait.")
        self.assertIn('"box_2d": [ymin, xmin, ymax, xmax]', gemini_instr)
        self.assertIn("散文参考", gemini_instr)

if __name__ == "__main__":
    unittest.main()
