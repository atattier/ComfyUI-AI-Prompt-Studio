from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aiohttp.test_utils import TestClient, TestServer

from prompt_studio.aiohttp_api import StudioBackend, create_app
from prompt_studio.config import Settings

from tests.mock_upstream import MockUpstream, VALID_KEY


class CloudGenerateRouteTests(unittest.IsolatedAsyncioTestCase):
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
        self.client = TestClient(TestServer(create_app(self.backend)))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()

    async def test_cloud_generate_missing_prompt(self):
        resp = await self.client.post("/ai_prompt_studio/cloud_generate", json={})
        self.assertEqual(resp.status, 400)
        data = await resp.json()
        self.assertIn("prompt is required", str(data))

    async def test_cloud_generate_empty_prompt(self):
        resp = await self.client.post("/ai_prompt_studio/cloud_generate", json={"prompt": "   "})
        self.assertEqual(resp.status, 400)
        data = await resp.json()
        self.assertIn("prompt is required", str(data))

    async def test_cloud_generate_success(self):
        body = {
            "prompt": "A serene zen garden in morning mist",
            "width": 1024,
            "height": 768,
            "mode": "caption",
        }
        resp = await self.client.post("/ai_prompt_studio/cloud_generate", json=body)
        self.assertEqual(resp.status, 200)
        data = await resp.json()
        self.assertIn("payload", data)
        self.assertEqual(data["width"] % 16, 0)
        self.assertEqual(data["height"] % 16, 0)
        self.assertEqual(data["modes"], ["caption"])
        self.assertEqual(data["payload"]["caption"], "A serene zen garden in morning mist")
        self.assertEqual(data["payload"]["source"], "imagine")


if __name__ == "__main__":
    unittest.main()
