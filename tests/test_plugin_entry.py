from __future__ import annotations

import importlib.util
import sys
import types
import unittest
from pathlib import Path

from aiohttp import web

ROOT = Path(__file__).resolve().parents[1]


def fake_prompt_server() -> tuple[types.ModuleType, web.RouteTableDef]:
    routes = web.RouteTableDef()
    server = types.ModuleType("server")
    server.PromptServer = types.SimpleNamespace(  # type: ignore[attr-defined]
        instance=types.SimpleNamespace(routes=routes)
    )
    return server, routes


class PluginRegistrationTests(unittest.TestCase):
    def setUp(self):
        self.addCleanup(sys.modules.pop, "server", None)
        self.server, self.routes = fake_prompt_server()
        sys.modules["server"] = self.server

        import comfyui_plugin

        self.plugin = comfyui_plugin
        self.addCleanup(setattr, self.plugin, "get_backend", self.plugin.get_backend)
        # Never touch the real configuration or runtime data inside a test.
        self.plugin.get_backend = lambda: None
        self.plugin._BACKEND_ERROR = None

    def test_registers_routes_on_comfyui_server(self):
        self.assertTrue(self.plugin.register())
        paths = [route.path for route in self.routes]
        self.assertIn("/ai_prompt_studio/health", paths)
        self.assertIn("/ai_prompt_studio/chat", paths)
        self.assertIn("/ai_prompt_studio/apply", paths)

    def test_is_idempotent(self):
        self.assertTrue(self.plugin.register())
        before = len(list(self.routes))
        self.assertTrue(self.plugin.register())
        self.assertEqual(len(list(self.routes)), before)

    def test_package_registers_caption_node_only(self):
        spec = importlib.util.spec_from_file_location("aps_root_entry", ROOT / "__init__.py")
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        self.assertEqual(module.WEB_DIRECTORY, "./web")
        # Exactly one node: the caption node. The workbench itself stays a
        # sidebar extension and never injects nodes into existing workflows.
        self.assertEqual(
            set(module.NODE_CLASS_MAPPINGS), {"AIPromptStudioCaption", "AIPromptStudioImagine"}
        )
        self.assertEqual(
            module.NODE_DISPLAY_NAME_MAPPINGS,
            {
                "AIPromptStudioCaption": "AI 提示词工作台 (反推与自动灵感)",
                "AIPromptStudioImagine": "AI 灵感画面提示词 (已合并至主节点)",
            },
        )
        paths = [route.path for route in self.routes]
        self.assertIn("/ai_prompt_studio/health", paths)

    def test_missing_prompt_server_is_not_fatal(self):
        sys.modules.pop("server", None)
        sys.modules["server"] = types.ModuleType("server")  # no PromptServer
        self.assertFalse(self.plugin.register())


if __name__ == "__main__":
    unittest.main()
