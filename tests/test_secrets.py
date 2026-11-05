from __future__ import annotations

import json
import unittest

from prompt_studio.client import image_part_from_bytes
from prompt_studio.errors import AuthError, StudioError
from prompt_studio.png import make_split_probe_png

from tests.mock_upstream import BAD_KEY, VALID_KEY
from tests.support import make_client


class SecretLeakTests(unittest.TestCase):
    def test_full_flow_never_leaks_key(self):
        _mock, settings, client, _audit = make_client(self, model="vision-pro")

        client.complete([{"role": "user", "content": "hello"}])
        client.complete(
            [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "colours?"},
                        image_part_from_bytes(make_split_probe_png()),
                    ],
                }
            ]
        )
        for _event in client.stream_chat([{"role": "user", "content": "stream please"}]):
            pass

        captured = [json.dumps(settings.public_dict(), ensure_ascii=False)]
        captured.append(settings.audit_path.read_text(encoding="utf-8"))
        blob = "\n".join(captured)
        self.assertNotIn(VALID_KEY, blob)
        self.assertNotIn("mock-valid-001", blob)
        # Audit log must not contain prompt content either.
        self.assertNotIn("stream please", blob)

    def test_auth_error_does_not_leak_key(self):
        _mock, _settings, client, _audit = make_client(self, api_key=BAD_KEY)
        try:
            client.complete([{"role": "user", "content": "hello"}])
        except AuthError as err:
            self.assertNotIn(BAD_KEY, str(err))
            self.assertNotIn(BAD_KEY, json.dumps(err.to_dict(), ensure_ascii=False))
        else:  # pragma: no cover
            self.fail("expected AuthError")

    def test_upstream_message_echoing_key_is_scrubbed(self):
        # The mock echoes whatever the request says in its error message.
        _mock, _settings, client, _audit = make_client(self, api_key=BAD_KEY)
        with self.assertRaises(AuthError) as ctx:
            client.complete([{"role": "user", "content": "hello"}])
        payload = ctx.exception.to_dict()
        self.assertNotIn(BAD_KEY, json.dumps(payload, ensure_ascii=False))

    def test_every_error_payload_is_json_serialisable_and_scrubbed(self):
        _mock, _settings, client, _audit = make_client(self, api_key=BAD_KEY)
        with self.assertRaises(StudioError) as ctx:
            client.complete([{"role": "user", "content": "hello"}])
        payload = ctx.exception.to_dict()
        self.assertEqual(payload["code"], "auth_failed")
        self.assertIn("message", payload)
        json.dumps(payload)


if __name__ == "__main__":
    unittest.main()
