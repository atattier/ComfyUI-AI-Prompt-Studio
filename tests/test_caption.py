from __future__ import annotations

import json
import unittest

from prompt_studio.caption import _clean, caption_image
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


class CaptionCleanTests(unittest.TestCase):
    """A JSON envelope must never survive into the prose channel.

    Reported case: the model answered the "pure paragraph" instruction with
    ``{"layout_draft": {"caption": "...", "visible_text": []}}`` and the raw
    JSON landed in the 散文 output, because the old cleaner only knew a few
    hard-coded wrapper keys.
    """

    def test_strips_layout_draft_wrapper(self):
        prose = (
            "A close-up, high-angle upper-body portrait of a pale-skinned young woman "
            "reclining in shallow water, lit by soft cool light."
        )
        payload = json.dumps(
            {"layout_draft": {"caption": prose, "visible_text": []}}, ensure_ascii=False
        )
        cleaned = _clean(payload, "prose")
        self.assertEqual(cleaned, prose)
        self.assertNotIn("{", cleaned)

    def test_strips_unknown_nested_wrapper(self):
        payload = json.dumps(
            {
                "meta": {"tool": "vision"},
                "data": {"result": {"caption": "Deep nested prose that must survive."}},
            }
        )
        self.assertEqual(_clean(payload, "prose"), "Deep nested prose that must survive.")

    def test_strips_wrapper_inside_markdown_fence(self):
        body = json.dumps({"caption": "A lone lantern on a wet pier."}, ensure_ascii=False)
        self.assertEqual(_clean(f"```json\n{body}\n```", "prose"), "A lone lantern on a wet pier.")

    def test_legacy_summary_wrapper_still_handled(self):
        body = json.dumps({"summary": {"caption": "Legacy wrapped prose."}})
        self.assertEqual(_clean(body, "moss"), "Legacy wrapped prose.")

    def test_tolerates_chatter_around_the_json(self):
        raw = 'Here is the caption: {"caption": "Chatty wrapper around real prose."} -- done.'
        self.assertEqual(_clean(raw, "prose"), "Chatty wrapper around real prose.")

    def test_tag_envelope_is_joined_back_into_one_line(self):
        body = json.dumps({"tags": ["1girl", "solo", "blue_hair"]})
        self.assertEqual(_clean(body, "danbooru"), "1girl, solo, blue_hair")

    def test_strips_truncated_wrapper_with_missing_brace(self):
        # Exactly what the reported run produced: the closing inner brace is absent,
        # so json.loads() fails while the caption string is still intact.
        prose = (
            "A close-up, high-angle upper-body portrait of a pale-skinned young woman "
            "reclining in shallow water, with long loose wavy lilac-purple hair."
        )
        raw = (
            "{\n"
            '  "layout_draft": {\n'
            f'  "caption": "{prose}",\n'
            '  "visible_text": [\n'
            "\n"
            "  ]\n"
            "}\n"
        )
        cleaned = _clean(raw, "prose")
        self.assertEqual(cleaned, prose)
        self.assertNotIn("visible_text", cleaned)
        self.assertNotIn("{", cleaned)

    def test_plain_prose_is_left_untouched(self):
        prose = 'A woman holds a sign reading "OPEN" above her head.'
        self.assertEqual(_clean(prose, "prose"), prose)

    def test_in_image_quotes_inside_a_wrapper_survive(self):
        prose = 'A poster reading "SALE 50%" hangs on the wall behind her.'
        body = json.dumps({"caption": prose}, ensure_ascii=False)
        self.assertEqual(_clean(body, "prose"), prose)

    def test_truncated_json_envelope_still_yields_prose(self):
        # max_tokens 把布局 JSON 从中间截断：没有闭合引号、没有闭合花括号，
        # 但里面那句 caption 是完整可用的，不能因此判定为「空返回」
        truncated = (
            '{"summary": {"caption": "A full-body shot of a girl in a white shirt '
            "and a blue pinafore dress standing in a sunlit wooden room, with an "
            'easel behind her and a desk lamp on the le'
        )
        out = _clean(truncated, "prose")
        self.assertTrue(out.startswith("A full-body shot of a girl"))
        self.assertNotIn('"summary"', out)
        self.assertGreater(len(out), 40)


if __name__ == "__main__":
    unittest.main()
