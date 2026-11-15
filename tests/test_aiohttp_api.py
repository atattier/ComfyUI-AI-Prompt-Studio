from __future__ import annotations

import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from prompt_studio.aiohttp_api import StudioBackend, create_app, install_routes, make_routes
from prompt_studio.client import data_url
from prompt_studio.config import Settings
from prompt_studio.credentials import delete_credentials, save_credentials
from prompt_studio.png import make_split_probe_png
from prompt_studio.redaction import mask_secret

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

    async def test_backend_is_rebuilt_when_it_was_missing_at_startup(self):
        """回归：启动时没配 Key 不能让所有路由永久死掉——连保存 Key 的接口都得能用。"""
        from aiohttp import web

        settings = replace(self.settings, model="echo-model")
        state = {"backend": None}
        routes = web.RouteTableDef()
        install_routes(routes, None, backend_getter=lambda: state["backend"])
        app = web.Application()
        app.add_routes(routes)
        client = TestClient(TestServer(app))
        await client.start_server()
        try:
            response = await client.get("/ai_prompt_studio/status")
            self.assertEqual(response.status, 500)
            state["backend"] = StudioBackend(settings)
            response = await client.get("/ai_prompt_studio/status")
            self.assertEqual(response.status, 200)
            body = await response.json()
            self.assertEqual(body["config"]["model"], "echo-model")
            state["backend"].close()
        finally:
            await client.close()

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

    async def test_caption_to_edit_session_continuity_and_allow_empty(self):
        image = {"data_url": data_url(make_split_probe_png(32))}
        cap_resp = await self.client.post(
            "/ai_prompt_studio/caption",
            json={"image": image, "format": "prose", "model": "vision-pro", "create_session": True},
        )
        cap_body = await cap_resp.json()
        self.assertEqual(cap_resp.status, 200)
        session_id = cap_body.get("session_id")
        self.assertTrue(session_id)

        edit_resp = await self.client.post(
            "/ai_prompt_studio/edit",
            json={
                "message": "生成一段电影感提示词",
                "model": "demo-model",
                "target": {**TARGET, "text": ""},
                "allow_empty": True,
                "session_id": session_id,
            },
        )
        edit_body = await edit_resp.json()
        self.assertEqual(edit_resp.status, 200)
        self.assertEqual(edit_body["session_id"], session_id)
        self.assertTrue(edit_body["proposal"]["text"].strip())

        sess_resp = await self.client.get(f"/ai_prompt_studio/sessions/{session_id}")
        sess_body = await sess_resp.json()
        self.assertEqual(len(sess_body["messages"]), 4)  # caption user/assistant + edit user/assistant

    async def test_caption_node_endpoint(self):
        image = {"data_url": data_url(make_split_probe_png(32))}
        response = await self.client.post(
            "/ai_prompt_studio/caption_node",
            json={
                "image": image,
                "mode": "hybrid",
                "style": "detailed",
                "width": 1024,
                "height": 1024,
                "max_regions": 4,
                "model": "demo-model",
                "create_session": True,
            },
        )
        body = await response.json()
        self.assertEqual(response.status, 200)
        self.assertTrue(body["caption"])
        self.assertIsInstance(body["draft"], dict)
        self.assertTrue(body["payload"])
        self.assertTrue(body.get("session_id"))

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

    async def test_caption_multiple_formats(self):
        image = {"data_url": data_url(make_split_probe_png(32))}
        response = await self.client.post(
            "/ai_prompt_studio/caption",
            json={"image": image, "format": ["tags", "prose"], "model": "caption-model"},
        )
        body = await response.json()
        self.assertEqual(response.status, 200)
        self.assertTrue(body["multi"])
        self.assertEqual(body["formats"], ["tags", "prose"])
        self.assertEqual(body["results"]["tags"]["text"], "quality, red, blue")
        self.assertEqual(body["results"]["prose"]["text"], "A vertically split poster in red and blue.")
        self.assertGreaterEqual(body["usage"]["prompt_tokens"], 20)  # summed from both calls

    async def test_caption_multiple_formats_rejects_unknown(self):
        image = {"data_url": data_url(make_split_probe_png(32))}
        response = await self.client.post(
            "/ai_prompt_studio/caption",
            json={"image": image, "format": ["prose", "yaml"]},
        )
        self.assertEqual(response.status, 400)
        response = await self.client.post(
            "/ai_prompt_studio/caption",
            json={"image": image, "format": []},
        )
        self.assertEqual(response.status, 400)

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

    async def test_models_list_and_config_prompt_rules(self):
        models_resp = await self.client.get("/ai_prompt_studio/models")
        self.assertEqual(models_resp.status, 200)
        models_body = await models_resp.json()
        model_ids = [m["id"] for m in models_body["models"]]
        self.assertIn("vision-pro", model_ids)
        self.assertIn("demo-model", model_ids)

        cfg_resp = await self.client.post(
            "/ai_prompt_studio/config",
            json={
                "base_url": self.mock.base_url,
                "model": "demo-model",
                "timeout_s": 45,
                "max_retries": 1,
                "rule_preset": "moss",
                "output_language": "zh",
                "prompt_rules": "Always describe physical light direction.",
                "user_custom_rules": "Always include fine details.",
                "max_regions": 4,
            },
        )
        self.assertEqual(cfg_resp.status, 200)
        cfg_body = await cfg_resp.json()
        self.assertEqual(cfg_body["config"]["model"], "demo-model")
        self.assertEqual(cfg_body["config"]["rule_preset"], "moss")
        self.assertEqual(cfg_body["config"]["output_language"], "zh")
        self.assertEqual(cfg_body["config"]["prompt_rules"], "Always describe physical light direction.")
        self.assertEqual(cfg_body["config"]["user_custom_rules"], "Always include fine details.")
        self.assertEqual(cfg_body["config"]["max_regions"], 4)

    async def test_key_manager_add_activate_delete(self):
        cred_path = Path(self.tmp.name) / "credentials.json"
        prefix = f"test-{Path(self.tmp.name).name}"
        save_credentials(self.mock.base_url, VALID_KEY, "vision-pro", cred_path, target=prefix)
        self.addCleanup(delete_credentials, cred_path, target=prefix)
        second = "mock-" + "cred-" + "key-second"

        listed = await self.client.get("/ai_prompt_studio/keys")
        self.assertEqual(listed.status, 200)
        body = await listed.json()
        self.assertEqual(len(body["keys"]), 1)
        self.assertTrue(body["keys"][0]["active"])
        self.assertNotIn(VALID_KEY, json.dumps(body))

        created = await self.client.post(
            "/ai_prompt_studio/keys",
            json={"api_key": second, "label": "备用 key"},
        )
        self.assertEqual(created.status, 200)
        created_body = await created.json()
        self.assertEqual(len(created_body["keys"]), 2)
        self.assertEqual(created_body["api_key_masked"], mask_secret(second))
        self.assertEqual(self.backend.settings.api_key, second)
        new_id = next(item["id"] for item in created_body["keys"] if item["label"] == "备用 key")
        self.assertNotIn(second, json.dumps(created_body))

        status_body = await (await self.client.get("/ai_prompt_studio/status")).json()
        self.assertEqual(status_body["config"]["active_key_id"], new_id)
        self.assertNotIn(second, json.dumps(status_body))

        first_id = next(item["id"] for item in created_body["keys"] if item["label"] == "默认密钥")
        switched = await self.client.post(f"/ai_prompt_studio/keys/{first_id}/activate", json={})
        self.assertEqual(switched.status, 200)
        self.assertEqual((await switched.json())["api_key_masked"], mask_secret(VALID_KEY))
        self.assertEqual(self.backend.settings.api_key, VALID_KEY)

        deleted = await self.client.delete(f"/ai_prompt_studio/keys/{new_id}")
        self.assertEqual(deleted.status, 200)
        self.assertEqual(len((await deleted.json())["keys"]), 1)

        refused = await self.client.delete(f"/ai_prompt_studio/keys/{first_id}")
        self.assertEqual(refused.status, 400)

    async def test_gateway_profiles_switch_url_model_and_key_in_one_call(self):
        cred_path = Path(self.tmp.name) / "credentials.json"
        prefix = f"test-{Path(self.tmp.name).name}"
        save_credentials(self.mock.base_url, VALID_KEY, "vision-pro", cred_path, target=prefix)
        self.addCleanup(delete_credentials, cred_path, target=prefix)
        second = "mock-" + "cred-" + "key-gateway"
        created = await self.client.post(
            "/ai_prompt_studio/keys", json={"api_key": second, "label": "远端密钥"}
        )
        self.assertEqual(created.status, 200)
        created_body = await created.json()
        second_id = next(item["id"] for item in created_body["keys"] if item["label"] == "远端密钥")
        first_id = next(item["id"] for item in created_body["keys"] if item["id"] != second_id)

        saved_a = await self.client.post(
            "/ai_prompt_studio/gateways",
            json={
                "label": "本地网关",
                "base_url": self.mock.base_url,
                "model": "vision-pro",
                "key_id": first_id,
            },
        )
        self.assertEqual(saved_a.status, 200)
        saved_a_body = await saved_a.json()
        a_id = saved_a_body["gateway"]["id"]
        self.assertEqual(saved_a_body["config"]["base_url"], self.mock.base_url)

        saved_b = await self.client.post(
            "/ai_prompt_studio/gateways",
            json={
                "label": "远端网关",
                "base_url": "http://127.0.0.1:9/v1",
                "model": "demo-model",
                "key_id": second_id,
                "activate": False,
            },
        )
        self.assertEqual(saved_b.status, 200)
        b_id = (await saved_b.json())["gateway"]["id"]

        listing = await (await self.client.get("/ai_prompt_studio/gateways")).json()
        self.assertEqual([g["id"] for g in listing["gateways"]], [a_id, b_id])
        self.assertEqual(listing["active_gateway_id"], a_id)
        self.assertNotIn(second, json.dumps(listing))

        switched = await self.client.post(f"/ai_prompt_studio/gateways/{b_id}/activate")
        self.assertEqual(switched.status, 200)
        switched_body = await switched.json()
        self.assertEqual(switched_body["config"]["base_url"], "http://127.0.0.1:9/v1")
        self.assertEqual(switched_body["config"]["model"], "demo-model")
        self.assertEqual(switched_body["api_key_masked"], mask_secret(second))
        self.assertEqual(self.backend.settings.api_key, second)
        self.assertEqual(self.backend.settings.active_key_id, second_id)

        back = await self.client.post(f"/ai_prompt_studio/gateways/{a_id}/activate")
        self.assertEqual(back.status, 200)
        self.assertEqual((await back.json())["config"]["model"], "vision-pro")
        self.assertEqual(self.backend.settings.api_key, VALID_KEY)

        deleted = await self.client.delete(f"/ai_prompt_studio/gateways/{b_id}")
        self.assertEqual(deleted.status, 200)
        self.assertEqual([g["id"] for g in (await deleted.json())["gateways"]], [a_id])

    async def test_key_creation_requires_a_non_empty_secret(self):
        cred_path = Path(self.tmp.name) / "credentials.json"
        prefix = f"test-{Path(self.tmp.name).name}"
        save_credentials(self.mock.base_url, VALID_KEY, "vision-pro", cred_path, target=prefix)
        self.addCleanup(delete_credentials, cred_path, target=prefix)
        response = await self.client.post("/ai_prompt_studio/keys", json={"api_key": "   "})
        self.assertEqual(response.status, 400)

    async def test_config_persists_three_independent_mode_rules(self):
        cfg_resp = await self.client.post(
            "/ai_prompt_studio/config",
            json={
                "base_url": self.mock.base_url,
                "model": "demo-model",
                "caption_rules": "CAP_RULE_PERSIST",
                "layout_rules": "LAY_RULE_PERSIST",
                "danbooru_rules": "DAN_RULE_PERSIST",
            },
        )
        self.assertEqual(cfg_resp.status, 200)
        cfg_body = await cfg_resp.json()
        self.assertEqual(cfg_body["config"]["caption_rules"], "CAP_RULE_PERSIST")
        self.assertEqual(cfg_body["config"]["layout_rules"], "LAY_RULE_PERSIST")
        self.assertEqual(cfg_body["config"]["danbooru_rules"], "DAN_RULE_PERSIST")
        prefs = json.loads((Path(self.tmp.name) / "preferences.json").read_text(encoding="utf-8"))
        self.assertEqual(prefs["caption_rules"], "CAP_RULE_PERSIST")
        self.assertEqual(prefs["layout_rules"], "LAY_RULE_PERSIST")
        self.assertEqual(prefs["danbooru_rules"], "DAN_RULE_PERSIST")

    async def test_edit_route_accepts_mode_and_preserves_multiturn_session(self):
        layout_json = json.dumps(
            {
                "summary": {"caption": "A bright street scene."},
                "items": [{"label": "character", "caption": "A girl", "bbox": [0, 0, 100, 100]}],
            }
        )
        r1 = await self.client.post(
            "/ai_prompt_studio/edit",
            json={
                "message": "背景色调要调整吗？",
                "mode": "layout",
                "model": "editor-noop",
                "create_session": True,
                "target": {**TARGET, "text": layout_json},
            },
        )
        self.assertEqual(r1.status, 200)
        b1 = await r1.json()
        sid = b1["session_id"]
        self.assertTrue(sid)
        self.assertFalse(b1["proposal"]["changed"])
        self.assertEqual(b1["proposal"]["text"], layout_json)

        r2 = await self.client.post(
            "/ai_prompt_studio/edit",
            json={
                "message": "replace the cat with a dog",
                "mode": "caption",
                "model": "editor-model",
                "session_id": sid,
                "target": TARGET,
            },
        )
        self.assertEqual(r2.status, 200)
        b2 = await r2.json()
        self.assertEqual(b2["session_id"], sid)
        self.assertTrue(b2["proposal"]["changed"])
        self.assertEqual(b2["proposal"]["text"], "a dog on a mat, sunny")

        sess = await self.client.get(f"/ai_prompt_studio/sessions/{sid}")
        self.assertEqual(sess.status, 200)
        messages = (await sess.json()).get("messages", [])
        self.assertEqual(len(messages), 4)

    async def test_validation_errors(self):
        response = await self.client.post("/ai_prompt_studio/chat", json={"message": "", "target": TARGET})
        self.assertEqual(response.status, 400)
        response = await self.client.post(
            "/ai_prompt_studio/edit", json={"message": "x", "target": {**TARGET, "text": "   "}}
        )
        self.assertEqual(response.status, 400)  # empty prompt
        response = await self.client.get("/ai_prompt_studio/versions")
        self.assertEqual(response.status, 400)

    async def test_complete_from_prompt_layout_zero_llm_and_size_inference(self):
        before_calls = len(self.mock.state.requests)
        moss_layout = json.dumps({
            "summary": {"caption": "A misty bamboo path.", "canvas": "single"},
            "items": [
                {"label": "object", "caption": "Bamboo forest backdrop", "bbox": [-608, -416, 608, 416]},
                {"label": "character", "caption": "Traveler walking center-left", "bbox": [-300, -250, 450, 120]},
            ],
            "bbox_coord_space": "abs_centralized",
            "bbox_format": "yxyx",
        })
        response = await self.client.post(
            "/ai_prompt_studio/complete_from_prompt",
            json={"prompt": moss_layout, "modes": ["layout"], "width": 1024, "height": 1024},
        )
        body = await response.json()
        self.assertEqual(response.status, 200)
        self.assertEqual(len(self.mock.state.requests), before_calls)  # 0 LLM calls
        self.assertEqual(body["detected_source"], "layout")
        self.assertEqual((body["width"], body["height"]), (832, 1216))
        self.assertEqual(len(body["payload"]["draft"]["items"]), 2)
        compiled = json.loads(body["outputs"]["layout_prompt"])
        self.assertEqual(compiled["bbox_coord_space"], "abs_centralized")
        self.assertEqual(compiled["bbox_format"], "yxyx")

    async def test_complete_from_prompt_caption_to_all_three_via_upstream(self):
        prose = "A dramatic portrait under warm lantern light, viewer's left figure holding a paper umbrella."
        response = await self.client.post(
            "/ai_prompt_studio/complete_from_prompt",
            json={
                "prompt": prose,
                "source_mode": "caption",
                "modes": ["caption", "layout", "danbooru"],
                "width": 1024,
                "height": 1024,
                "max_regions": 6,
                "model": "demo-model",
            },
        )
        body = await response.json()
        self.assertEqual(response.status, 200)
        self.assertEqual(body["detected_source"], "caption")
        self.assertEqual(body["outputs"]["caption_prompt"], prose)
        self.assertTrue(body["outputs"]["danbooru_prompt"])
        compiled_layout = json.loads(body["outputs"]["layout_prompt"])
        self.assertEqual(len(compiled_layout["items"]), 2)
        self.assertGreaterEqual(len(body["payload"]["draft"]["items"]), 2)

    async def test_complete_from_prompt_layout_to_all_three_modes(self):
        moss_layout = json.dumps({
            "summary": {"caption": "Cafe storefront at dusk."},
            "items": [
                {"label": "object", "caption": "Brick cafe wall", "bbox": [-608, -416, 608, 416]},
                {"label": "text", "caption": "Window sign", "text": "OPEN", "bbox": [-200, -150, -50, 150]},
            ],
            "bbox_coord_space": "abs_centralized",
            "bbox_format": "yxyx",
        })
        replies = [
            'Warm dusk illumination over a cozy brick cafe storefront with a glowing window sign reading "OPEN"',
            "cafe, storefront, neon_sign, dusk",
        ]

        def fake_text_call(_model):
            def _call(_instruction, _max_tokens, _temperature):
                return replies.pop(0)
            return _call

        with mock.patch.object(self.backend, "_text_call", side_effect=fake_text_call):
            response = await self.client.post(
                "/ai_prompt_studio/complete_from_prompt",
                json={
                    "prompt": moss_layout,
                    "source_mode": "auto",
                    "modes": ["caption", "layout", "danbooru"],
                    "width": 1024,
                    "height": 1024,
                },
            )
        body = await response.json()
        self.assertEqual(response.status, 200)
        self.assertEqual(body["detected_source"], "layout")
        self.assertEqual((body["width"], body["height"]), (832, 1216))
        self.assertTrue(body["outputs"]["caption_prompt"].endswith('reading "OPEN"'))
        self.assertEqual(body["outputs"]["danbooru_prompt"], "cafe, storefront, neon_sign, dusk")
        self.assertEqual(len(body["payload"]["layout_draft"]["items"]), 2)

    async def test_complete_from_prompt_validation_errors(self):
        for payload in (
            {"prompt": "   "},
            {"prompt": "hello", "source_mode": "yaml"},
            {"prompt": "hello", "width": 0, "height": 1024},
            {"prompt": "not valid json", "source_mode": "layout", "modes": ["layout"]},
        ):
            resp = await self.client.post("/ai_prompt_studio/complete_from_prompt", json=payload)
            self.assertEqual(resp.status, 400, f"expected 400 for {payload}")

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
