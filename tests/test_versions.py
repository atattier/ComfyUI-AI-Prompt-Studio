from __future__ import annotations

import tempfile
import time
import unittest
from pathlib import Path

from prompt_studio.versions import VersionStore


class VersionStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = VersionStore(Path(self.tmp.name) / "versions.sqlite3", keep_per_target=3)
        self.addCleanup(self.store.close)

    def test_add_and_get(self):
        item = self.store.add("wf:1:text", "hello", source="apply", label="first")
        self.assertTrue(item["id"].startswith("v_"))
        loaded = self.store.get(item["id"])
        self.assertEqual(loaded["text"], "hello")
        self.assertEqual(loaded["label"], "first")
        self.assertIsNone(self.store.get("missing"))

    def test_list_is_newest_first(self):
        self.store.add("t", "one")
        time.sleep(0.002)
        self.store.add("t", "two")
        items = self.store.list("t")
        self.assertEqual([item["text"] for item in items], ["two", "one"])

    def test_prune_keeps_latest(self):
        for index in range(5):
            self.store.add("t", f"v{index}")
            time.sleep(0.002)
        items = self.store.list("t", limit=10)
        self.assertEqual(len(items), 3)
        self.assertEqual(items[0]["text"], "v4")

    def test_targets_are_isolated(self):
        self.store.add("a", "one")
        self.store.add("b", "two")
        self.assertEqual(self.store.list("a")[0]["text"], "one")
        self.assertEqual(self.store.latest("b")["text"], "two")

    def test_meta_roundtrip(self):
        item = self.store.add("t", "x", meta={"node_id": 12, "model": "m"})
        self.assertEqual(self.store.get(item["id"])["meta"]["node_id"], 12)

    def test_empty_target_rejected(self):
        with self.assertRaises(ValueError):
            self.store.add("", "x")


if __name__ == "__main__":
    unittest.main()
