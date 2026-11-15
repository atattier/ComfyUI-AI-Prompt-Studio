from __future__ import annotations

import unittest

from prompt_studio.caption_node import AIPromptStudioPresetNode, get_preset_names


class PresetNodeTests(unittest.TestCase):
    def test_get_preset_names(self):
        names = get_preset_names()
        self.assertIsInstance(names, list)
        self.assertGreater(len(names), 0)

    def test_preset_node_execute(self):
        node = AIPromptStudioPresetNode()
        names = get_preset_names()
        first_name = names[0]

        outputs = node.execute(preset_name=first_name, extra_prompt="high quality")
        self.assertEqual(len(outputs), 6)
        caption, layout_prompt, danbooru, layout_json, width, height = outputs

        self.assertIsInstance(caption, str)
        self.assertIn("high quality", caption)
        self.assertIsInstance(layout_json, str)
        self.assertIn("items", layout_json)
        self.assertIsInstance(width, int)
        self.assertIsInstance(height, int)
        self.assertGreater(width, 0)
        self.assertGreater(height, 0)


if __name__ == "__main__":
    unittest.main()
