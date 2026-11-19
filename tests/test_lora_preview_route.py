"""Guard: every route module must import what its handlers reference.

A missing ``import os`` inside a handler is invisible to unit tests that call
the pure helpers directly, but it 500s the live HTTP route. These tests exercise
the real aiohttp handlers.
"""
from __future__ import annotations

import unittest
from urllib.parse import quote

from aiohttp.test_utils import AioHTTPTestCase

from prompt_studio import aiohttp_api as api
from prompt_studio.lora_presets import find_lora_preview_path


def _pick_existing_lora_with_cover() -> str | None:
    """Find any installed LoRA that actually has a cover file."""
    try:
        from prompt_studio.lora_presets import scan_available_loras

        for rel in scan_available_loras():
            if find_lora_preview_path(rel):
                return rel
    except Exception:
        pass
    return None


class LoraPreviewImageRouteTests(AioHTTPTestCase):
    async def get_application(self):
        return api.create_app(None)

    async def test_preview_image_route_returns_bytes_not_500(self):
        rel = _pick_existing_lora_with_cover()
        if not rel:
            self.skipTest("no installed LoRA with a cover image on this machine")

        url = f"/ai_prompt_studio/lora_presets/preview_image?name={quote(rel)}"
        resp = await self.client.get(url)
        self.assertEqual(
            resp.status,
            200,
            f"preview_image 500s for {rel!r} — a handler is referencing an unimported name",
        )
        body = await resp.read()
        self.assertGreater(len(body), 100)
        self.assertTrue(
            resp.content_type.startswith("image/"),
            f"unexpected content type {resp.content_type}",
        )

    async def test_preview_image_route_404s_for_unknown_name(self):
        url = f"/ai_prompt_studio/lora_presets/preview_image?name={quote('no_such_lora_xyz')}"
        resp = await self.client.get(url)
        self.assertEqual(resp.status, 404)

    async def test_preview_image_route_400s_without_name(self):
        resp = await self.client.get("/ai_prompt_studio/lora_presets/preview_image")
        self.assertEqual(resp.status, 400)


class RouteModuleImportTests(unittest.TestCase):
    """Cheap static check: the route module must import os."""

    def test_aiohttp_api_imports_os(self):
        import prompt_studio.aiohttp_api as mod

        self.assertTrue(hasattr(mod, "os"), "aiohttp_api.py lost its `import os`")


if __name__ == "__main__":
    unittest.main()