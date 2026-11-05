from __future__ import annotations

import unittest

from prompt_studio.errors import StreamInterruptedError

from tests.support import make_client


class StreamingTests(unittest.TestCase):
    def test_stream_yields_incremental_deltas(self):
        _mock, _settings, client, _audit = make_client(self, model="echo-model")
        deltas = []
        final = None
        for event in client.stream_chat([{"role": "user", "content": "hello there"}], temperature=0):
            if event.type == "delta":
                deltas.append(event.text)
            elif event.type == "done":
                final = event
        self.assertGreaterEqual(len(deltas), 2)
        self.assertIsNotNone(final)
        assert final is not None
        self.assertTrue(final.saw_done)
        self.assertFalse(final.stream_ignored)
        self.assertEqual("".join(deltas), final.text)
        self.assertGreaterEqual(final.chunks, 2)
        self.assertIsNotNone(final.usage)

    def test_provider_that_ignores_stream_is_flagged(self):
        _mock, _settings, client, _audit = make_client(self, model="json-stream")
        final = None
        for event in client.stream_chat([{"role": "user", "content": "hello"}], temperature=0):
            if event.type == "done":
                final = event
        self.assertIsNotNone(final)
        assert final is not None
        self.assertTrue(final.stream_ignored)
        self.assertTrue(final.text)

    def test_dropped_stream_raises_with_partial_text(self):
        _mock, _settings, client, _audit = make_client(
            self, model="drop-model", max_retries=0, timeout_s=5.0
        )
        with self.assertRaises(StreamInterruptedError) as ctx:
            for _event in client.stream_chat([{"role": "user", "content": "hello"}]):
                pass
        err = ctx.exception
        self.assertEqual(err.code, "stream_interrupted")
        self.assertIn("dropped", err.message.lower())
        self.assertEqual(err.partial_text.strip(), "partial")
        self.assertFalse(err.retryable)
        payload = err.to_dict()
        self.assertEqual(payload["partial_text"].strip(), "partial")

    def test_stream_audit_records_ttft_and_chunks(self):
        _mock, _settings, client, audit = make_client(self, model="echo-model")
        for _event in client.stream_chat([{"role": "user", "content": "hello"}]):
            pass
        response = [e for e in audit.tail(20) if e["event"] == "response"][-1]
        self.assertGreaterEqual(response["chunks"], 2)
        self.assertIn("ttft_ms", response)
        self.assertEqual(response["status"], "ok")


if __name__ == "__main__":
    unittest.main()
