from __future__ import annotations

import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

from prompt_studio.client import data_url
from prompt_studio.config import Settings
from prompt_studio.png import make_split_probe_png
from prompt_studio.server import Service, create_server

from tests.mock_upstream import VALID_KEY
from tests.support import http_json, http_sse

TOKEN = "local-" + "test-" + "token"


class ServerTests(unittest.TestCase):
    def setUp(self):
        from tests.mock_upstream import MockUpstream

        self.mock = MockUpstream()
        self.mock.__enter__()
        self.addCleanup(self.mock.__exit__, None, None, None)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.settings = Settings(
            base_url=self.mock.base_url,
            model="vision-pro",
            api_key=VALID_KEY,
            home=Path(self.tmp.name),
            port=0,
            server_token=TOKEN,
            timeout_s=5.0,
            max_retries=1,
            backoff_s=0.01,
            max_backoff_s=0.02,
        )
        self.service = Service(self.settings)
        self.server = create_server(self.settings, service=self.service)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.thread.join, 2)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.addCleanup(self.service.sessions.close)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.responses: list[str] = []

    def _json(self, method, path, payload=None, *, token=TOKEN):
        status, body = http_json(self.base, method, path, payload, token=token)
        self.responses.append(json.dumps(body, ensure_ascii=False))
        return status, body

    # ---------------------------------------------------------------- auth
    def test_health_is_public(self):
        status, body = http_json(self.base, "GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "ok")

    def test_api_requires_token(self):
        status, body = http_json(self.base, "GET", "/api/config")
        self.assertEqual(status, 401)
        self.assertEqual(body["error"]["code"], "server_unauthorized")

    def test_wrong_token_is_rejected(self):
        status, _body = http_json(self.base, "GET", "/api/config", token="wrong-token")
        self.assertEqual(status, 401)

    def test_config_never_returns_key(self):
        status, body = self._json("GET", "/api/config")
        self.assertEqual(status, 200)
        self.assertTrue(body["api_key_configured"])
        self.assertNotIn(VALID_KEY, json.dumps(body))
        self.assertIn("api_key_masked", body)

    # ---------------------------------------------------------------- chat
    def test_chat_creates_session_and_keeps_context(self):
        status, first = self._json(
            "POST", "/api/chat", {"message": "remember 47", "model": "echo-model"}
        )
        self.assertEqual(status, 200)
        self.assertIn("user:remember 47", first["text"])
        session_id = first["session_id"]

        status, second = self._json(
            "POST", "/api/chat", {"message": "what number?", "session_id": session_id, "model": "echo-model"}
        )
        self.assertEqual(status, 200)
        self.assertIn("assistant:", second["text"])
        self.assertIn("user:remember 47", second["text"])
        self.assertIn("user:what number?", second["text"])
        self.assertIn("turns=3", second["text"])

        status, history = self._json("GET", f"/api/sessions/{session_id}")
        self.assertEqual(status, 200)
        self.assertEqual(history["message_count"], 4)

    def test_stateless_chat(self):
        status, body = self._json(
            "POST",
            "/api/chat",
            {"stateless": True, "messages": [{"role": "user", "content": "hello"}]},
        )
        self.assertEqual(status, 200)
        self.assertIsNone(body["session_id"])

    def test_chat_stream_over_sse(self):
        events = http_sse(
            self.base,
            "/api/chat",
            {"message": "hello there", "stream": True, "model": "echo-model"},
            token=TOKEN,
        )
        names = [name for name, _ in events]
        self.assertEqual(names[0], "meta")
        self.assertIn("delta", names)
        self.assertEqual(names[-1], "done")
        deltas = [data["text"] for name, data in events if name == "delta"]
        done = events[-1][1]
        self.assertEqual("".join(deltas), done["text"])
        self.assertGreaterEqual(done["chunks"], 2)
        self.assertTrue(done["session_id"].startswith("s_"))

        status, history = self._json("GET", f"/api/sessions/{done['session_id']}")
        self.assertEqual(history["message_count"], 2)

    def test_image_chat_over_http(self):
        png = make_split_probe_png(64)
        status, body = self._json(
            "POST",
            "/api/chat",
            {"message": "name the colours", "images": [{"data_url": data_url(png)}]},
        )
        self.assertEqual(status, 200)
        self.assertEqual(body["text"].strip(), "red blue")
        status, history = self._json("GET", f"/api/sessions/{body['session_id']}")
        parts = history["messages"][0]["content"]
        self.assertEqual(parts[1]["type"], "image_ref")

    def test_probe_endpoint(self):
        status, body = self._json("POST", "/api/probe", {})
        self.assertEqual(status, 200)
        self.assertTrue(body["text"])
        self.assertTrue(body["vision"])
        self.assertTrue(body["streaming"])

    # ------------------------------------------------------------- sessions
    def test_session_crud(self):
        status, created = self._json("POST", "/api/sessions", {"title": "demo"})
        self.assertEqual(status, 201)
        status, listing = self._json("GET", "/api/sessions")
        self.assertEqual(status, 200)
        self.assertEqual(listing["sessions"][0]["title"], "demo")
        status, _deleted = self._json("DELETE", f"/api/sessions/{created['id']}")
        self.assertEqual(status, 200)
        status, body = self._json("GET", f"/api/sessions/{created['id']}")
        self.assertEqual(status, 404)

    def test_validation_and_not_found(self):
        status, body = self._json("POST", "/api/chat", {"message": ""})
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "invalid_request")
        status, _body = self._json("GET", "/api/nope")
        self.assertEqual(status, 404)

    def test_oversized_body_is_rejected(self):
        connection = http.client.HTTPConnection(
            "127.0.0.1", self.server.server_address[1], timeout=5
        )
        connection.putrequest("POST", "/api/chat")
        connection.putheader("X-Studio-Token", TOKEN)
        connection.putheader("Content-Type", "application/json")
        connection.putheader("Content-Length", str(25 * 1024 * 1024))
        connection.endheaders()
        response = connection.getresponse()
        self.assertEqual(response.status, 413)
        connection.close()

    def test_no_response_contains_key(self):
        self._json("GET", "/api/config")
        self._json("POST", "/api/chat", {"message": "hello"})
        self._json("POST", "/api/probe", {})
        blob = "\n".join(self.responses)
        self.assertNotIn(VALID_KEY, blob)
        audit_blob = (self.settings.audit_path).read_text(encoding="utf-8")
        self.assertNotIn(VALID_KEY, audit_blob)


if __name__ == "__main__":
    unittest.main()
