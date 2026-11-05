from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from prompt_studio.credentials import Credentials, save_credentials
from prompt_studio.redaction import Redactor, mask_secret

KEY = "mock-" + "cred-" + "key-001"


class CredentialStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "credentials.json"

    def test_roundtrip(self):
        save_credentials("https://api.example.com/v1", KEY, "model-a", self.path)
        creds = Credentials.load(self.path)
        self.assertIsNotNone(creds)
        assert creds is not None
        self.assertEqual(creds.api_key, KEY)
        self.assertEqual(creds.model, "model-a")

    def test_file_is_owner_only_where_supported(self):
        save_credentials("https://api.example.com/v1", KEY, "model-a", self.path)
        mode = self.path.stat().st_mode & 0o777
        if hasattr(Path, "chmod") and __import__("os").name == "posix":
            self.assertEqual(mode, 0o600)

    def test_incomplete_file_is_ignored(self):
        self.path.write_text(json.dumps({"base_url": "https://api.example.com"}), encoding="utf-8")
        self.assertIsNone(Credentials.load(self.path))

    def test_mask_never_reveals_full_key(self):
        masked = mask_secret(KEY)
        self.assertNotIn(KEY, masked)
        self.assertTrue(masked.startswith(KEY[:4]))

    def test_redactor_scrubs_known_and_pattern_keys(self):
        pattern_key = "sk-" + "live-" + "abcdef123456"
        redactor = Redactor([KEY])
        text = redactor.scrub_text(f"key={KEY} auth=Bearer abcdef1234567890 other={pattern_key}")
        self.assertNotIn(KEY, text)
        self.assertNotIn("abcdef1234567890", text)
        self.assertNotIn(pattern_key, text)


if __name__ == "__main__":
    unittest.main()
