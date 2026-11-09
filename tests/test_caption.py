from __future__ import annotations

import unittest

from prompt_studio.caption import caption_image
from prompt_studio.client import image_part_from_bytes
from prompt_studio.png import make_split_probe_png

from tests.support import make_client


class CaptionTests(unittest.TestCase):
    def setUp(self):
        self.image = image_part_from_bytes(make_split_probe_png(32))

    def test_prose(self):
        _mock, _settings, client, _audit = make_client(self, model="vision-pro")
        result = caption_image(client, self.image, fmt="prose")
        self.assertEqual(result.text, "red blue")
        self.assertEqual(result.format, "prose")

    def test_tags_are_cleaned(self):
        _mock, _settings, client, _audit = make_client(self, model="caption-model")
        result = caption_image(client, self.image, fmt="tags")
        self.assertEqual(result.text, "quality, red, blue")
        self.assertNotIn("```", result.text)

    def test_moss(self):
        _mock, _settings, client, _audit = make_client(self, model="caption-model")
        result = caption_image(client, self.image, fmt="moss")
        self.assertIn("red and blue", result.text)
        self.assertEqual(result.format, "moss")

    def test_empty_caption_rejected(self):
        _mock, _settings, client, _audit = make_client(self, model="empty-model")
        with self.assertRaises(ValueError):
            caption_image(client, self.image, fmt="prose")

    def test_unknown_format_rejected(self):
        _mock, _settings, client, _audit = make_client(self)
        with self.assertRaises(ValueError):
            caption_image(client, self.image, fmt="yaml")

    def test_extra_instruction_is_sent(self):
        _mock, _settings, client, _audit = make_client(self, model="caption-model")
        result = caption_image(client, self.image, fmt="prose", extra_instruction="keep it short")
        self.assertTrue(result.text)

    def test_instructions_contain_spatial_anchoring(self):
        from prompt_studio.caption import _INSTRUCTIONS
        for key in ("prose", "moss"):
            instr = _INSTRUCTIONS[key].lower()
            self.assertIn("viewer's left", instr)
            self.assertTrue("mirror" in instr or "flip" in instr)


if __name__ == "__main__":
    unittest.main()
