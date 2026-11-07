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
        self.assertIn("AT MOST 12 regions", instr)
        self.assertIn("DECOUPLE DISTINCTIVE FEATURES", instr)
        self.assertIn("光环", instr)
        self.assertIn("光之碎片翼", instr)
        self.assertIn("海报标题", instr)
        self.assertIn("0-1000", instr)

if __name__ == "__main__":
    unittest.main()
