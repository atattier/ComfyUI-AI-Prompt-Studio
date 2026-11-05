from __future__ import annotations

import json
import tempfile
import unittest
import uuid
from pathlib import Path

from prompt_studio import wincred
from prompt_studio.credentials import Credentials, delete_credentials, save_credentials
from prompt_studio.redaction import Redactor, mask_secret

KEY = "mock-" + "cred-" + "key-001"


class CredentialStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "credentials.json"
        # Never touch the real "default" vault entry from tests.
        self.target = "test-" + uuid.uuid4().hex
        self.addCleanup(delete_credentials, self.path, target=self.target)

    def test_roundtrip(self):
        save_credentials("https://api.example.com/v1", KEY, "model-a", self.path, target=self.target)
        creds = Credentials.load(self.path)
        self.assertIsNotNone(creds)
        assert creds is not None
        self.assertEqual(creds.api_key, KEY)
        self.assertEqual(creds.model, "model-a")
        self.assertEqual(creds.target, self.target)

    def test_key_is_not_written_in_clear_when_vault_is_available(self):
        save_credentials("https://api.example.com/v1", KEY, "model-a", self.path, target=self.target)
        raw = self.path.read_text(encoding="utf-8")
        if wincred.available():
            self.assertNotIn(KEY, raw)
            self.assertNotIn("api_key", json.loads(raw))
            self.assertEqual(json.loads(raw)["storage"], "wincred")
        else:
            self.assertIn(KEY, raw)  # documented fallback on platforms without a vault

    def test_incomplete_file_is_ignored(self):
        self.path.write_text(json.dumps({"base_url": "https://api.example.com"}), encoding="utf-8")
        self.assertIsNone(Credentials.load(self.path))

    def test_legacy_plaintext_is_migrated_to_vault(self):
        self.path.write_text(
            json.dumps(
                {
                    "base_url": "https://api.example.com/v1",
                    "api_key": KEY,
                    "model": "model-a",
                    "storage": "file",
                    "target": self.target,
                }
            ),
            encoding="utf-8",
        )
        creds = Credentials.load(self.path)
        self.assertIsNotNone(creds)
        assert creds is not None
        self.assertEqual(creds.api_key, KEY)
        if wincred.available():
            self.assertEqual(creds.storage, "wincred")
            self.assertNotIn(KEY, self.path.read_text(encoding="utf-8"))
            self.assertEqual(wincred.read(target=self.target), KEY)

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


@unittest.skipUnless(wincred.available(), "Windows Credential Manager is not available")
class WinCredTests(unittest.TestCase):
    def setUp(self):
        self.target = "test-" + uuid.uuid4().hex
        self.addCleanup(wincred.delete, target=self.target)

    def test_write_read_delete(self):
        self.assertTrue(wincred.write(KEY, target=self.target))
        self.assertEqual(wincred.read(target=self.target), KEY)
        self.assertTrue(wincred.delete(target=self.target))
        self.assertIsNone(wincred.read(target=self.target))

    def test_targets_are_namespaced(self):
        other = "test-" + uuid.uuid4().hex
        self.addCleanup(wincred.delete, target=other)
        self.assertTrue(wincred.write(KEY, target=self.target))
        self.assertTrue(wincred.write("other-key-value", target=other))
        self.assertEqual(wincred.read(target=self.target), KEY)
        self.assertEqual(wincred.read(target=other), "other-key-value")

    def test_empty_secret_rejected(self):
        with self.assertRaises(ValueError):
            wincred.write("", target=self.target)


if __name__ == "__main__":
    unittest.main()
