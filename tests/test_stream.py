from __future__ import annotations

import socket
import time
import unittest
from unittest.mock import patch

from prompt_studio.errors import StreamInterruptedError, UpstreamTimeoutError

from tests.support import make_client


class _FakeSSEResp:
    def __init__(self, lines, *, delay_after_first: float = 0.0, raise_exc: Exception | None = None):
        self._lines = list(lines)
        self._delay = delay_after_first
        self._raise = raise_exc
        self.headers = {"Content-Type": "text/event-stream"}

    def __iter__(self):
        for idx, raw in enumerate(self._lines):
            if idx == 1 and self._delay > 0:
                time.sleep(self._delay)
            yield raw
        if self._raise is not None:
            raise self._raise

    def close(self) -> None:
        pass


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

    def test_stream_retry_resets_per_attempt_deadline(self):
        _mock, _settings, client, _audit = make_client(
            self, model="echo-model", timeout_s=0.15, max_retries=1, backoff_s=0.01
        )
        responses = [
            _FakeSSEResp([b": keepalive\n", b": still thinking\n"], delay_after_first=0.22),
            _FakeSSEResp(
                [
                    b'data: {"choices":[{"delta":{"content":"recovered"},"finish_reason":"stop"}]}\n',
                    b"data: [DONE]\n",
                ]
            ),
        ]
        call_count = 0

        def fake_open(*_args, **_kwargs):
            nonlocal call_count
            resp = responses[call_count]
            call_count += 1
            return resp, None

        with patch.object(client, "_open", side_effect=fake_open):
            result = client.complete_via_stream([{"role": "user", "content": "hello"}])
        self.assertEqual(result.text, "recovered")
        self.assertEqual(result.attempts, 2)

    def test_stream_budget_extends_for_thinking_and_timeout_raises_upstream_timeout(self):
        _mock, _settings, client, _audit = make_client(
            self, model="echo-model", timeout_s=20.0, max_retries=0
        )

        # Direct socket timeout with zero content must surface as UpstreamTimeoutError (504), not StreamInterruptedError.
        with patch.object(
            client,
            "_open",
            return_value=(_FakeSSEResp([], raise_exc=socket.timeout("timed out")), None),
        ):
            with self.assertRaises(UpstreamTimeoutError):
                client.complete_via_stream([{"role": "user", "content": "hello"}])

        # With timeout_s=20.0, the stream budget is max(20*3, 180) = 180s.
        ticks = iter([1000.0, 1181.0])
        with (
            patch.object(client, "_open", return_value=(_FakeSSEResp([b": keepalive\n"]), None)),
            patch("prompt_studio.client.time.monotonic", side_effect=lambda: next(ticks)),
        ):
            with self.assertRaises(UpstreamTimeoutError) as ctx:
                client.complete_via_stream([{"role": "user", "content": "hello"}])
        self.assertIn("180s budget", ctx.exception.message)

    def test_pre_first_token_connection_reset_reports_detail(self):
        _mock, _settings, client, _audit = make_client(
            self, model="echo-model", max_retries=0, timeout_s=5.0
        )
        reset_exc = ConnectionResetError(
            "[WinError 10054] An existing connection was forcibly closed by the remote host"
        )
        with patch.object(
            client,
            "_open",
            return_value=(_FakeSSEResp([], raise_exc=reset_exc), None),
        ):
            with self.assertRaises(StreamInterruptedError) as ctx:
                client.complete_via_stream([{"role": "user", "content": "hello"}])
        err = ctx.exception
        self.assertEqual(err.code, "stream_interrupted")
        self.assertIn("dropped before any content", err.message.lower())
        self.assertEqual(err.partial_text, "")
        self.assertEqual(err.attempts, 1)
        self.assertIn("ConnectionResetError", err.detail)
        self.assertIn("10054", err.detail)
        payload = err.to_dict()
        self.assertIn("10054", payload["detail"])
        self.assertNotIn("attempts", payload)

        # With max_retries=1, pre-first-token reset retries once and surfaces attempts=2
        _mock2, _settings2, client2, _audit2 = make_client(
            self, model="echo-model", max_retries=1, timeout_s=5.0
        )
        with patch.object(
            client2,
            "_open",
            side_effect=[
                (_FakeSSEResp([], raise_exc=reset_exc), None),
                (_FakeSSEResp([], raise_exc=reset_exc), None),
            ],
        ):
            with self.assertRaises(StreamInterruptedError) as ctx2:
                client2.complete_via_stream([{"role": "user", "content": "hello"}])
        self.assertEqual(ctx2.exception.attempts, 2)
        self.assertEqual(ctx2.exception.to_dict()["attempts"], 2)

    def test_empty_eof_stream_includes_diagnostic_detail(self):
        _mock, _settings, client, _audit = make_client(
            self, model="echo-model", max_retries=0, timeout_s=5.0
        )
        with patch.object(
            client,
            "_open",
            return_value=(_FakeSSEResp([b": keepalive\n"]), None),
        ):
            with self.assertRaises(StreamInterruptedError) as ctx:
                client.complete_via_stream([{"role": "user", "content": "hello"}])
        err = ctx.exception
        self.assertEqual(err.code, "stream_interrupted")
        self.assertIn("ended before any content", err.message.lower())
        self.assertIn("chunks=0", err.detail)


if __name__ == "__main__":
    unittest.main()
