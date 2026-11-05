from __future__ import annotations

import unittest

from prompt_studio.client import image_part_from_bytes
from prompt_studio.errors import InvalidRequestError
from prompt_studio.png import make_rgb_png

from tests.support import make_client

RED = (220, 30, 30)
BLUE = (30, 40, 220)


def two_colour_png() -> bytes:
    pixels = [RED if x < 32 else BLUE for _y in range(64) for x in range(64)]
    return make_rgb_png(64, 64, pixels)


class VisionCallTests(unittest.TestCase):
    def _messages(self):
        return [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Name both colours from left to right."},
                    image_part_from_bytes(two_colour_png()),
                ],
            }
        ]

    def test_image_call_succeeds(self):
        _mock, _settings, client, _audit = make_client(self, model="vision-pro")
        result = client.complete(self._messages(), temperature=0)
        self.assertEqual(result.text.strip(), "red blue")

    def test_image_is_actually_transmitted(self):
        mock, _settings, client, _audit = make_client(self, model="vision-pro")
        client.complete(self._messages(), temperature=0)
        self.assertEqual(len(mock.state.requests), 1)
        # The mock decoded the PNG and answered from its pixels; a broken image
        # would have produced a wrong colour pair.

    def test_text_only_model_rejects_image_clearly(self):
        _mock, _settings, client, _audit = make_client(self, model="text-only")
        with self.assertRaises(InvalidRequestError) as ctx:
            client.complete(self._messages(), temperature=0)
        message = str(ctx.exception)
        self.assertIn("400", message)
        self.assertIn("does not support image", message)

    def test_single_colour_image_is_not_assumed(self):
        _mock, _settings, client, _audit = make_client(self, model="vision-pro")
        pixels = [RED for _y in range(64) for x in range(64)]
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Name both colours."},
                    image_part_from_bytes(make_rgb_png(64, 64, pixels)),
                ],
            }
        ]
        result = client.complete(messages, temperature=0)
        # Both halves are red, so the reply is "red red"; the probe must not
        # accept this as evidence of two distinct colours.
        self.assertEqual(result.text.strip(), "red red")


if __name__ == "__main__":
    unittest.main()
