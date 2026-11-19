"""Regression tests: the node must never silently run a stale stack.

Background: `custom_stack_json` is a graph-widget that survives reloads. An
older build let it win over `preset_name` unconditionally, so after switching
presets the node kept rendering the previous preset's LoRAs while the dropdown
showed the new name — the image "just changed" with no visible cause.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from prompt_studio import lora_presets as lp
from prompt_studio import lora_node as ln


def _make_store(tmpdir: str) -> lp.LoraPresetStore:
    return lp.LoraPresetStore(Path(tmpdir) / "presets.sqlite3")


class StaleStackJsonTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()

        self.store = _make_store(self.tmpdir.name)
        self.preset_a = self.store.save({
            "name": "预设 A",
            "loras": [{"name": "a_one.safetensors", "strength_model": 0.4, "strength_clip": 0.4}],
        })
        self.preset_b = self.store.save({
            "name": "预设 B",
            "loras": [{"name": "b_one.safetensors", "strength_model": 0.9, "strength_clip": 0.9}],
        })
        self.store.close()

        # Point the node at the temp DB and neutralise filesystem lookups.
        self.patches = [
            mock.patch.object(ln, "LoraPresetStore", lambda: _make_store(self.tmpdir.name)),
            mock.patch.object(ln, "resolve_lora_rel_path", lambda n: n),
            mock.patch.object(ln, "get_lora_trigger_words", lambda n: ""),
            mock.patch.object(ln, "_lora_file_exists", lambda n: True),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmpdir.cleanup()

    def _run(self, preset_name: str, custom_json: str) -> list[str]:
        node = ln.AIPromptStudioLoraNode()
        out = node.execute(
            preset_name=preset_name,
            model=None,
            clip=None,
            lora_stack=None,
            model_strength_scale=1.0,
            clip_strength_scale=1.0,
            extra_trigger_words="",
            custom_stack_json=custom_json,
        )
        stack = out[2]  # lora_stack
        return [name for name, _, _ in stack]

    def test_matching_json_is_honoured(self):
        payload = {
            "preset_name": "预设 B",
            "loras": [{"name": "b_one.safetensors", "strength_model": 0.9, "strength_clip": 0.9}],
        }
        self.assertEqual(self._run("预设 B", json.dumps(payload)), ["b_one.safetensors"])

    def test_stale_json_from_another_preset_is_ignored(self):
        # Dropdown says B, widget still holds A's stack.
        stale = {
            "preset_name": "预设 A",
            "loras": [{"name": "a_one.safetensors", "strength_model": 0.4, "strength_clip": 0.4}],
        }
        self.assertEqual(
            self._run("预设 B", json.dumps(stale)),
            ["b_one.safetensors"],
            "stale JSON overrode the selected preset — the image would silently differ",
        )

    def test_legacy_json_without_preset_tag_still_works(self):
        # Payloads saved before preset_name tagging must keep working.
        legacy = {"loras": [{"name": "legacy.safetensors", "strength_model": 0.5, "strength_clip": 0.5}]}
        self.assertEqual(self._run("预设 B", json.dumps(legacy)), ["legacy.safetensors"])

    def test_empty_json_falls_back_to_preset(self):
        self.assertEqual(self._run("预设 A", ""), ["a_one.safetensors"])

    def test_bare_list_json_still_supported(self):
        bare = [{"name": "bare.safetensors", "strength_model": 1.0, "strength_clip": 1.0}]
        self.assertEqual(self._run("预设 A", json.dumps(bare)), ["bare.safetensors"])

    def test_malformed_json_does_not_crash(self):
        self.assertEqual(self._run("预设 A", "{not json"), ["a_one.safetensors"])


class DuplicateFileTests(unittest.TestCase):
    def test_same_resolved_file_is_applied_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _make_store(tmp)
            store.save({
                "name": "重复堆叠",
                "loras": [
                    {"name": "dup", "strength_model": 0.4, "strength_clip": 0.4},
                    {"name": "dup", "strength_model": 0.8, "strength_clip": 0.8},
                ],
            })
            store.close()

            patches = [
                mock.patch.object(ln, "LoraPresetStore", lambda: _make_store(tmp)),
                mock.patch.object(ln, "resolve_lora_rel_path", lambda n: n),
                mock.patch.object(ln, "get_lora_trigger_words", lambda n: ""),
                mock.patch.object(ln, "_lora_file_exists", lambda n: True),
            ]
            for p in patches:
                p.start()
            try:
                out = ln.AIPromptStudioLoraNode().execute(
                    preset_name="重复堆叠",
                    model=None,
                    clip=None,
                    lora_stack=None,
                    model_strength_scale=1.0,
                    clip_strength_scale=1.0,
                    extra_trigger_words="",
                    custom_stack_json="",
                )
                stack = out[2]
                self.assertEqual(len(stack), 1, "same file must be resolved to one load")
                self.assertAlmostEqual(stack[0][1], 0.8, msg="stronger weight should win")
            finally:
                for p in patches:
                    p.stop()


if __name__ == "__main__":
    unittest.main()