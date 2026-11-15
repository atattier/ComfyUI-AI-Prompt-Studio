from __future__ import annotations

import json
import unittest

from prompt_studio.lora_node import (
    AIPromptStudioLoraNode,
    get_lora_preset_names,
    safe_load_single_lora,
)


class DummyModel:
    pass


class DummyClip:
    pass


class LoraNodeTests(unittest.TestCase):
    def test_get_lora_preset_names(self):
        names = get_lora_preset_names()
        self.assertIsInstance(names, list)
        self.assertGreater(len(names), 0)

    def test_node_execute_with_preset_name(self):
        node = AIPromptStudioLoraNode()
        names = get_lora_preset_names()
        first_name = names[0]

        outputs = node.execute(
            preset_name=first_name,
            model_strength_scale=1.0,
            clip_strength_scale=1.0,
            extra_trigger_words="extra detail",
        )
        self.assertEqual(len(outputs), 5)
        model_out, clip_out, lora_stack, trigger_words, lora_syntax = outputs

        self.assertIsNone(model_out)
        self.assertIsNone(clip_out)
        self.assertIsInstance(lora_stack, list)
        self.assertGreater(len(lora_stack), 0)
        self.assertIn("extra detail", trigger_words)
        self.assertIn("<lora:", lora_syntax)

    def test_node_execute_with_custom_stack_json(self):
        node = AIPromptStudioLoraNode()
        custom = {
            "loras": [
                {"name": "custom_style.safetensors", "strength_model": 0.8, "strength_clip": 0.8, "enabled": True},
                {"name": "disabled_lora.safetensors", "strength_model": 0.5, "strength_clip": 0.5, "enabled": False},
            ],
            "trigger_words": "custom style trigger",
        }
        outputs = node.execute(
            preset_name="some_dummy",
            custom_stack_json=json.dumps(custom),
            model_strength_scale=1.5,
            clip_strength_scale=1.5,
        )
        _, _, lora_stack, trigger_words, lora_syntax = outputs
        self.assertEqual(len(lora_stack), 1)
        name, m_w, c_w = lora_stack[0]
        self.assertEqual(name, "custom_style.safetensors")
        self.assertAlmostEqual(m_w, 1.2, places=2)
        self.assertAlmostEqual(c_w, 1.2, places=2)
        self.assertEqual(trigger_words, "custom style trigger")
        self.assertEqual(lora_syntax, "<lora:custom_style.safetensors:1.2>")

    def test_safe_load_single_lora_handles_missing_file_gracefully(self):
        m = DummyModel()
        c = DummyClip()
        # Non-existent lora should log warning and return original models without throwing
        res_m, res_c = safe_load_single_lora(m, c, "non_existent_lora_xyz.safetensors", 1.0, 1.0)
        self.assertIs(res_m, m)
        self.assertIs(res_c, c)

    def test_upstream_stack_concatenation(self):
        node = AIPromptStudioLoraNode()
        upstream = [("upstream_lora.safetensors", 0.6, 0.6)]
        custom = [
            {"name": "downstream_lora.safetensors", "strength_model": 0.9, "strength_clip": 0.9, "enabled": True}
        ]
        _, _, lora_stack, _, _ = node.execute(
            preset_name="none",
            lora_stack=upstream,
            custom_stack_json=json.dumps(custom),
        )
        self.assertEqual(len(lora_stack), 2)
        self.assertEqual(lora_stack[0][0], "upstream_lora.safetensors")
        self.assertEqual(lora_stack[1][0], "downstream_lora.safetensors")


if __name__ == "__main__":
    unittest.main()
