from __future__ import annotations

import json
import unittest

from prompt_studio.client import image_part_from_bytes
from prompt_studio.png import make_split_probe_png

from tests.support import make_client


class TextCallTests(unittest.TestCase):
    def test_text_call_succeeds(self):
        _mock, settings, client, _audit = make_client(self, model="vision-pro")
        result = client.complete([{"role": "user", "content": "Reply with the single word OK."}])
        self.assertEqual(result.text, "OK")
        self.assertEqual(result.model, "vision-pro")
        self.assertEqual(result.finish_reason, "stop")
        self.assertGreaterEqual(result.latency_ms, 0)

    def test_usage_is_recorded(self):
        _mock, _settings, client, _audit = make_client(self)
        result = client.complete([{"role": "user", "content": "hello"}])
        self.assertIsInstance(result.usage, dict)
        self.assertEqual(result.usage.get("total_tokens"), 15)

    def test_model_override(self):
        _mock, _settings, client, _audit = make_client(self, model="vision-pro")
        result = client.complete([{"role": "user", "content": "hello"}], model="echo-model")
        self.assertEqual(result.model, "echo-model")
        self.assertIn("turns=1", result.text)

    def test_audit_written_without_content(self):
        _mock, settings, client, audit = make_client(self)
        client.complete([{"role": "user", "content": "a private prompt"}])
        entries = audit.tail(10)
        events = [e["event"] for e in entries]
        self.assertIn("request", events)
        self.assertIn("response", events)
        raw = settings.audit_path.read_text(encoding="utf-8")
        self.assertNotIn("a private prompt", raw)
        for line in raw.splitlines():
            json.loads(line)  # every line is valid JSON

    def test_image_part_builder(self):
        url = image_part_from_bytes(make_split_probe_png(8))["image_url"]["url"]
        self.assertTrue(url.startswith("data:image/png;base64,"))


if __name__ == "__main__":
    unittest.main()
