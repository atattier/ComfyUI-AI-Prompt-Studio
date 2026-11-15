from __future__ import annotations

import json
import tempfile
import unittest
import uuid
from pathlib import Path

from prompt_studio import wincred
from prompt_studio.credentials import (
    Credentials,
    add_key,
    activate_key,
    delete_credentials,
    delete_key,
    key_list,
    save_credentials,
    update_metadata,
)
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

    def test_key_is_kept_as_fallback_besides_the_vault(self):
        """凭据管理器在「另一个进程」里读不到是现实存在的故障，光靠它会让整个
        后端起不来，所以明文兜底副本必须一起写。"""
        save_credentials("https://api.example.com/v1", KEY, "model-a", self.path, target=self.target)
        raw = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(raw["api_key"], KEY)
        if wincred.available():
            self.assertEqual(raw["storage"], "wincred")

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
            # 明文兜底副本保留：换进程读保险箱失败时还要靠它启动
            self.assertIn(KEY, self.path.read_text(encoding="utf-8"))
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


@unittest.skipUnless(wincred.available(), "Windows Credential Manager is not available")
class MultiKeyStoreTests(unittest.TestCase):
    """One Base URL, many keys; exactly one of them is active at a time."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "credentials.json"
        self.prefix = "test-" + uuid.uuid4().hex
        self.addCleanup(delete_credentials, self.path, target=self.prefix)

    def _seed(self):
        save_credentials("https://api.example.com/v1", KEY, "model-a", self.path, target=self.prefix)
        creds = Credentials.load(self.path)
        assert creds is not None
        return creds

    def test_first_save_is_a_single_active_key(self):
        creds = self._seed()
        self.assertEqual(len(creds.keys), 1)
        self.assertEqual(creds.api_key, KEY)
        keys = key_list(self.path)
        self.assertEqual(len(keys), 1)
        self.assertTrue(keys[0]["active"])

    def test_add_key_keeps_the_current_active_key(self):
        first = self._seed()
        other = "mock-" + "cred-" + "key-002"
        creds = add_key(other, "备用", self.path, target_prefix=self.prefix)
        self.assertEqual(len(creds.keys), 2)
        self.assertEqual(creds.api_key, KEY)
        self.assertEqual(creds.active_key_id, first.active_key_id)
        keys = key_list(self.path)
        masks = [item["masked"] for item in keys]
        self.assertEqual(keys[0]["label"], "默认密钥")
        self.assertEqual(keys[1]["label"], "备用")
        self.assertNotIn(other, json.dumps(keys))
        self.assertTrue(all(mask for mask in masks))

    def test_add_key_can_activate_immediately(self):
        self._seed()
        other = "mock-" + "cred-" + "key-003"
        creds = add_key(other, "", self.path, target_prefix=self.prefix, activate=True)
        self.assertEqual(creds.api_key, other)
        self.assertEqual(len(creds.keys), 2)

    def test_activate_switches_the_secret_used_by_requests(self):
        self._seed()
        other = "mock-" + "cred-" + "key-004"
        creds = add_key(other, "备用", self.path, target_prefix=self.prefix)
        backup_id = next(item.id for item in creds.keys if item.label == "备用")
        activated = activate_key(backup_id, self.path)
        self.assertEqual(activated.api_key, other)
        self.assertEqual(activated.active_key_id, backup_id)
        back = activate_key(creds.keys[0].id, self.path)
        self.assertEqual(back.api_key, KEY)

    def test_delete_removes_vault_entry_and_never_leaves_zero_keys(self):
        self._seed()
        other = "mock-" + "cred-" + "key-005"
        creds = add_key(other, "临时", self.path, target_prefix=self.prefix, activate=True)
        temp_entry = next(item for item in creds.keys if item.label == "临时")
        remaining = delete_key(temp_entry.id, self.path)
        self.assertEqual(len(remaining.keys), 1)
        self.assertEqual(remaining.api_key, KEY)
        self.assertIsNone(wincred.read(target=temp_entry.target))
        with self.assertRaises(ValueError):
            delete_key(remaining.keys[0].id, self.path)

    def test_only_the_active_key_is_kept_as_fallback(self):
        """明文兜底只放当前生效那一条，别的密钥仍然只在保险箱里。"""
        self._seed()
        other = "mock-" + "cred-" + "key-006"
        add_key(other, "备用", self.path, target_prefix=self.prefix)
        raw = self.path.read_text(encoding="utf-8")
        self.assertNotIn(other, raw)
        payload = json.loads(raw)
        self.assertEqual(payload.get("api_key"), KEY)
        self.assertEqual(len(payload["keys"]), 2)
        self.assertTrue(payload["active_key_id"])

    def test_add_key_without_a_store_is_rejected(self):
        with self.assertRaises(ValueError):
            add_key("mock-" + "cred-" + "key-007", "无主", self.path, target_prefix=self.prefix)

    def test_update_metadata_keeps_secrets_and_skips_missing_store(self):
        self._seed()
        saved = update_metadata("https://api.example.com/v2", "model-b", self.path, target=self.prefix)
        self.assertEqual(saved, self.path)
        raw = json.loads(self.path.read_text(encoding="utf-8"))
        # 只改地址/模型也必须保留明文兜底，否则换进程读不到保险箱后整个后端起不来。
        self.assertEqual(raw.get("api_key"), KEY)
        creds = Credentials.load(self.path)
        assert creds is not None
        self.assertEqual(creds.api_key, KEY)
        self.assertTrue(creds.base_url.endswith("/v2"))
        missing = Path(self.tmp.name) / "absent" / "credentials.json"
        self.assertIsNone(update_metadata("https://x.example.com", "m", missing))


if __name__ == "__main__":
    unittest.main()
