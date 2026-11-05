from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from prompt_studio.png import make_split_probe_png
from prompt_studio.sessions import MediaStore, SessionStore, decode_data_url


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.store = SessionStore(self.root / "sessions.sqlite3")
        self.addCleanup(self.store.close)

    def test_create_get_list_delete(self):
        session = self.store.create("first")
        self.assertTrue(session["id"].startswith("s_"))
        self.assertEqual(self.store.get(session["id"])["title"], "first")
        self.assertEqual(len(self.store.list()), 1)
        self.assertTrue(self.store.delete(session["id"]))
        self.assertIsNone(self.store.get(session["id"]))
        self.assertFalse(self.store.delete(session["id"]))

    def test_multi_turn_order_and_roles(self):
        session = self.store.create()
        self.store.append(session["id"], "user", "hello")
        self.store.append(session["id"], "assistant", "hi")
        self.store.append(session["id"], "user", "again")
        messages = self.store.messages_for_api(session["id"])
        self.assertEqual([m["role"] for m in messages], ["user", "assistant", "user"])
        self.assertEqual(messages[0]["content"], "hello")
        self.assertEqual(self.store.message_count(session["id"]), 3)

    def test_image_ref_roundtrip(self):
        png = make_split_probe_png(16)
        ref = self.store.media.put(png, "image/png")
        self.assertEqual(self.store.media.read(ref), png)
        session = self.store.create()
        self.store.append(
            session["id"],
            "user",
            [
                {"type": "text", "text": "look"},
                ref,
            ],
        )
        messages = self.store.messages_for_api(session["id"])
        parts = messages[0]["content"]
        self.assertEqual(parts[0]["text"], "look")
        self.assertEqual(parts[1]["type"], "image_url")
        data, mime = decode_data_url(parts[1]["image_url"]["url"])
        self.assertEqual(data, png)
        self.assertEqual(mime, "image/png")

    def test_persistence_across_reopen(self):
        session = self.store.create("persisted")
        self.store.append(session["id"], "user", "kept")
        path = self.store.path
        self.store.close()
        reopened = SessionStore(path)
        self.addCleanup(reopened.close)
        self.assertEqual(reopened.messages_for_api(session["id"])[0]["content"], "kept")

    def test_media_store_rejects_oversized_image(self):
        media = MediaStore(self.root / "media", max_bytes=10)
        with self.assertRaises(ValueError):
            media.put(b"x" * 11)

    def test_media_store_deduplicates(self):
        png = make_split_probe_png(8)
        a = self.store.media.put(png)
        b = self.store.media.put(png)
        self.assertEqual(a["sha256"], b["sha256"])
        self.assertEqual(len(list((self.root / "media").glob("*.png"))), 1)


if __name__ == "__main__":
    unittest.main()
