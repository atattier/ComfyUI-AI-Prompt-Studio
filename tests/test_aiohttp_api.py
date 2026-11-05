from __future__ import annotations

import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from prompt_studio.aiohttp_api import StudioBackend, create_app, make_routes
from prompt_studio.client import data_url
from prompt_studio.config import Settings
from prompt_studio.png import make_split_probe_png

from tests.mock_upstream import VALID_KEY
from tests.mock_upstream import MockUpstream

TARGET = {"workflow": "demo", "node_id": 12, "widget": "text", "title": "CLIP Text Encode", "text": "a cat on a mat, sunny"}


def parse_sse(text: str) -> list[tuple[str, dict]]:
    events = []
    name = None
    for line in text.splitlines():
        if line.startswith("event:"):
            name = line[6:].strip()
        elif line.startswith("data:"):
            events.append((name or "message", json.loads(line[5:].strip())))
    return events


class ApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
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
            timeout_s=10.0,
            max_retries=0,
            backoff_s=0.01,
        )
        self.backend = StudioBackend(self.settings)
        self.addCleanup(self.backend.close)
        self.client = TestClient(TestServer(self.build_app()))
        await self.client.start_server()

    def build_app(self):
        return create_app(self.backend)

    async def asyncTearDown(self):
        await self.client.close()

    async def test_health_and_status(self):
        response = await self.client.get("/ai_prompt_studio/health")
        self.assertEqual(response.status, 200)
        response = await self.client.get("/ai_prompt_studio/status")
        body = await response.json()
        self.assertEqual(response.status, 200)
        self.assertNotIn(VALID_KEY, json.dumps(body))
        self.assertIn("api_key_masked", body["config"])

    async def test_probe_returns_a_report(self):
        response = await self.client.post("/ai_prompt_studio/probe", json={"force": True})
        body = await response.json()
        self.assertEqual(response.status, 200)
        self.assertTrue(body["text"])
        self.assertTrue(body["vision"])
        self.assertTrue(body["streaming"])

    async def test_chat_streams_and_keeps_session(self):
        response = await self.client.post(
            "/ai_prompt_studio/chat",
            json={"message": "hello", "model": "echo-model", "target": TARGET},
        )
        text = await response.text()
        events = parse_sse(text)
        names = [name for name, _ in events]
        self.assertIn("meta", names)
        self.assertIn("delta", names)
        self.assertEqual(names[-1], "done")
        done = events[-1][1]
        session_id = done["session_id"]
        self.assertIn("user:", done["text"])
        self.assertIn("hello", done["text"])
        self.assertIn("a cat on a mat", done["text"])

        response = await self.client.post(
            "/ai_prompt_studio/chat",
            json={"message": "again", "session_id": session_id, "model": "echo-model", "target": TARGET},
        )
        events = parse_sse(await response.text())
        second = events[-1][1]["text"]
        self.assertIn("assistant:", second)
        self.assertIn("turns=4", second)  # system + user + assistant + user

    async def test_three_follow_up_turns_keep_context(self):
        session_id = None
        for index in range(3):
            payload = {"message": f"turn {index}", "model": "echo-model", "target": TARGET}
            if session_id:
                payload["session_id"] = session_id
            response = await self.client.post("/ai_prompt_studio/chat", json=payload)
            events = parse_sse(await response.text())
            done = events[-1][1]
            session_id = done["session_id"]
        self.assertIn("turns=6", done["text"])  # system + 3 user/assistant pairs
        for index in range(3):
            self.assertIn(f"turn {index}", done["text"])

    async def test_caption_disabled_after_vision_probe_fails(self):
        settings = replace(self.settings, model="text-only")
        backend = StudioBackend(settings)
        client = TestClient(TestServer(create_app(backend)))
        await client.start_server()
        try:
            report = await (await client.post("/ai_prompt_studio/probe", json={"force": True})).json()
            self.assertIs(report["vision"], False)
            response = await client.post(
                "/ai_prompt_studio/caption",
                json={"image": {"data_url": data_url(make_split_probe_png(32))}, "format": "prose"},
            )
            body = await response.json()
            self.assertEqual(response.status, 422)
            self.assertEqual(body["error"]["code"], "capability_unsupported")
        finally:
            await client.close()
            backend.close()

    async def test_edit_and_apply(self):
        response = await self.client.post(
            "/ai_prompt_studio/edit",
            json={"message": "replace the cat with a dog", "model": "editor-model", "target": TARGET},
        )
        body = await response.json()
        self.assertEqual(response.status, 200)
        proposal = body["proposal"]
        self.assertEqual(proposal["text"], "a dog on a mat, sunny")
        self.assertTrue(proposal["blocks"])

        response = await self.client.post(
            "/ai_prompt_studio/apply",
            json={"text": TARGET["text"], "ops": proposal["changes"]},
        )
        applied = await response.json()
        self.assertEqual(applied["text"], "a dog on a mat, sunny")

    async def test_invalid_edit_returns_422(self):
        response = await self.client.post(
            "/ai_prompt_studio/edit",
            json={"message": "x", "model": "editor-bad-json", "target": TARGET},
        )
        body = await response.json()
        self.assertEqual(response.status, 422)
        self.assertEqual(body["error"]["code"], "invalid_edit")

    async def test_caption_prose_and_tags(self):
        image = {"data_url": data_url(make_split_probe_png(32))}
        response = await self.client.post(
            "/ai_prompt_studio/caption",
            json={"image": image, "format": "prose", "model": "vision-pro"},
        )
        body = await response.json()
        self.assertEqual(response.status, 200)
        self.assertEqual(body["text"], "red blue")

        response = await self.client.post(
            "/ai_prompt_studio/caption",
            json={"image": image, "format": "tags", "model": "caption-model"},
        )
        body = await response.json()
        self.assertEqual(body["text"], "quality, red, blue")

    async def test_versions_endpoints(self):
        response = await self.client.post(
            "/ai_prompt_studio/versions", json={"target": "wf:12:text", "text": "v1", "source": "apply"}
        )
        self.assertEqual(response.status, 200)
        version = await response.json()
        response = await self.client.get("/ai_prompt_studio/versions", params={"target": "wf:12:text"})
        listing = await response.json()
        self.assertEqual(listing["versions"][0]["text"], "v1")
        response = await self.client.get(f"/ai_prompt_studio/versions/{version['id']}")
        self.assertEqual((await response.json())["text"], "v1")

    async def test_sessions_endpoints(self):
        response = await self.client.post("/ai_prompt_studio/sessions", json={"title": "demo"})
        self.assertEqual(response.status, 201)
        session = await response.json()
        response = await self.client.get("/ai_prompt_studio/sessions")
        listing = await response.json()
        self.assertEqual(listing["sessions"][0]["id"], session["id"])
        response = await self.client.delete(f"/ai_prompt_studio/sessions/{session['id']}")
        self.assertEqual(response.status, 200)

    async def test_validation_errors(self):
        response = await self.client.post("/ai_prompt_studio/chat", json={"message": "", "target": TARGET})
        self.assertEqual(response.status, 400)
        response = await self.client.post(
            "/ai_prompt_studio/edit", json={"message": "x", "target": {**TARGET, "text": "   "}}
        )
        self.assertEqual(response.status, 400)  # empty prompt
        response = await self.client.get("/ai_prompt_studio/versions")
        self.assertEqual(response.status, 400)

    async def test_unconfigured_backend_is_explicit(self):
        client = TestClient(TestServer(create_app(None)))
        await client.start_server()
        try:
            response = await client.get("/ai_prompt_studio/status")
            body = await response.json()
            self.assertEqual(response.status, 500)
            self.assertEqual(body["error"]["code"], "config_error")
        finally:
            await client.close()


class RouteGuardTests(ApiTests):
    """ComfyUI hands the plugin a RouteTableDef, not an Application.

    Without the app-level error middleware every StudioError would surface as
    aiohttp's bare 500.  These tests run the same suite against routes only.
    """

    def build_app(self):
        app = web.Application()
        app.add_routes(make_routes(self.backend))
        return app


if __name__ == "__main__":
    unittest.main()
