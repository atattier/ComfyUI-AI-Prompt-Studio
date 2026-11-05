from __future__ import annotations

import socket
import threading
import time
import unittest

from prompt_studio.errors import AuthError, NetworkError, RateLimitError, UpstreamError, UpstreamTimeoutError

from tests.mock_upstream import BAD_KEY, VALID_KEY
from tests.support import make_client


class AuthErrorTests(unittest.TestCase):
    def test_wrong_key_returns_auth_error(self):
        _mock, _settings, client, audit = make_client(self, api_key=BAD_KEY)
        with self.assertRaises(AuthError) as ctx:
            client.complete([{"role": "user", "content": "hello"}])
        err = ctx.exception
        self.assertEqual(err.http_status, 401)
        self.assertIn("401", err.message)
        self.assertFalse(err.retryable)
        self.assertEqual(err.attempts, 1)
        payload = err.to_dict()
        self.assertNotIn(BAD_KEY, str(payload))
        self.assertNotIn(BAD_KEY, str(err))
        errors = [e for e in audit.tail(20) if e["event"] == "error"]
        self.assertEqual(errors[-1]["code"], "auth_failed")

    def test_wrong_key_is_not_retried(self):
        mock, _settings, client, _audit = make_client(self, api_key=BAD_KEY)
        with self.assertRaises(AuthError):
            client.complete([{"role": "user", "content": "hello"}])
        self.assertEqual(mock.state.count("/v1/chat/completions"), 1)


class RetryTests(unittest.TestCase):
    def test_rate_limit_is_retried_once(self):
        mock, _settings, client, _audit = make_client(self, model="rate-limit-model", max_retries=2)
        result = client.complete([{"role": "user", "content": "hello"}])
        self.assertEqual(result.attempts, 2)
        self.assertTrue(result.text)
        self.assertEqual(mock.state.count("/v1/chat/completions"), 2)

    def test_server_errors_are_retried_then_succeed(self):
        _mock, _settings, client, _audit = make_client(self, model="flaky-model", max_retries=2)
        result = client.complete([{"role": "user", "content": "hello"}])
        self.assertEqual(result.attempts, 3)
        self.assertIn("mock reply", result.text)

    def test_retry_budget_is_respected(self):
        mock, _settings, client, _audit = make_client(self, model="flaky-model", max_retries=0)
        with self.assertRaises(UpstreamError) as ctx:
            client.complete([{"role": "user", "content": "hello"}])
        self.assertTrue(ctx.exception.retryable)
        self.assertEqual(ctx.exception.upstream_status, 503)
        self.assertEqual(mock.state.count("/v1/chat/completions"), 1)

    def test_rate_limit_error_type_when_not_retried(self):
        _mock, _settings, client, _audit = make_client(self, model="rate-limit-model", max_retries=0)
        with self.assertRaises(RateLimitError):
            client.complete([{"role": "user", "content": "hello"}])


class TimeoutAndNetworkTests(unittest.TestCase):
    def test_timeout_is_reported_clearly(self):
        _mock, _settings, client, _audit = make_client(
            self, model="slow-model", timeout_s=0.4, max_retries=0
        )
        started = time.perf_counter()
        with self.assertRaises(UpstreamTimeoutError) as ctx:
            client.complete([{"role": "user", "content": "hello"}])
        elapsed = time.perf_counter() - started
        self.assertLess(elapsed, 3.0)
        self.assertIn("0.4s", ctx.exception.message)
        self.assertTrue(ctx.exception.retryable)

    def test_timeout_retries_are_bounded(self):
        _mock, _settings, client, _audit = make_client(
            self, model="slow-model", timeout_s=0.3, max_retries=1
        )
        started = time.perf_counter()
        with self.assertRaises(UpstreamTimeoutError) as ctx:
            client.complete([{"role": "user", "content": "hello"}])
        self.assertEqual(ctx.exception.attempts, 2)
        self.assertLess(time.perf_counter() - started, 3.0)

    def test_unreachable_endpoint_raises_network_error(self):
        # A TCP peer that accepts and immediately closes is a deterministic
        # network failure on every platform (closed ports behave differently).
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        port = listener.getsockname()[1]

        def close_immediately():
            conn, _addr = listener.accept()
            conn.close()

        thread = threading.Thread(target=close_immediately, daemon=True)
        thread.start()
        self.addCleanup(listener.close)

        try:
            _mock, _settings, client, _audit = make_client(
                self, base_url=f"http://127.0.0.1:{port}", timeout_s=3.0, max_retries=0
            )
            with self.assertRaises(NetworkError) as ctx:
                client.complete([{"role": "user", "content": "hello"}])
            self.assertIn("Cannot reach", ctx.exception.message)
            self.assertTrue(ctx.exception.retryable)
        finally:
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
