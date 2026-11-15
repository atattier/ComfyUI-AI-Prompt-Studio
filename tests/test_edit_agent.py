from __future__ import annotations

import json
import unittest

from prompt_studio.diff import EditValidationError
from prompt_studio.edit_agent import (
    build_chat_messages,
    build_edit_messages,
    parse_layout_proposal,
    parse_proposal,
    request_edit,
)

from tests.support import make_client


class ParseProposalTests(unittest.TestCase):
    def test_plain_json(self):
        raw = json.dumps(
            {"reply": "改好了", "changes": [{"op": "replace", "before": "a cat", "after": "a dog"}]},
            ensure_ascii=False,
        )
        proposal = parse_proposal(raw, "a cat on a mat")
        self.assertEqual(proposal.reply, "改好了")
        self.assertEqual(proposal.text, "a dog on a mat")
        self.assertTrue(proposal.changed)

    def test_fenced_json(self):
        raw = '```json\n{"reply":"ok","changes":[]}\n```'
        proposal = parse_proposal(raw, "same")
        self.assertEqual(proposal.changes, [])
        self.assertEqual(proposal.text, "same")

    def test_json_embedded_in_prose(self):
        raw = 'Sure.\n{"reply":"ok","changes":[{"op":"append","after":"!"}]}\nThanks.'
        self.assertEqual(parse_proposal(raw, "hi").text, "hi!")

    def test_invalid_json(self):
        with self.assertRaises(EditValidationError):
            parse_proposal("I cannot do that.", "hi")

    def test_ambiguous_edit_rejected(self):
        raw = '{"reply":"x","changes":[{"op":"replace","before":"a ","after":"b "}]}'
        with self.assertRaises(EditValidationError):
            parse_proposal(raw, "a cat and a dog")

    def test_missing_before_rejected(self):
        raw = '{"reply":"x","changes":[{"op":"replace","before":"horse","after":"dog"}]}'
        with self.assertRaises(EditValidationError):
            parse_proposal(raw, "a cat")

    def test_allow_empty_normalizes_initial_draft_ops(self):
        raw = json.dumps(
            {
                "reply": "已从空状态起草提示词",
                "changes": [{"op": "replace", "before": "", "after": "cinematic neon skyline, 35mm"}],
            },
            ensure_ascii=False,
        )
        proposal = parse_proposal(raw, "", allow_empty=True)
        self.assertEqual(proposal.text, "cinematic neon skyline, 35mm")
        self.assertTrue(proposal.changed)
        self.assertEqual(proposal.changes[0]["op"], "append")


class MessageTests(unittest.TestCase):
    def test_edit_messages_include_prompt_verbatim(self):
        messages = build_edit_messages("a cat, sunny", "make it rainy")
        self.assertEqual(messages[0]["role"], "system")
        self.assertIn("a cat, sunny", messages[1]["content"])
        self.assertIn("make it rainy", messages[1]["content"])
        self.assertIn("JSON", messages[0]["content"])

    def test_edit_messages_with_history_and_allow_empty(self):
        history = [
            {"role": "user", "content": "反推参考图"},
            {"role": "assistant", "content": "海报主视觉，前景产品特写"},
        ]
        messages = build_edit_messages("", "帮我生成英文提示词", history=history, allow_empty=True)
        self.assertEqual([m["role"] for m in messages], ["system", "user", "assistant", "user"])
        self.assertIn("empty", messages[-1]["content"])

    def test_chat_messages_history_order(self):
        history = [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "hello"},
        ]
        messages = build_chat_messages("prompt text", "change it", history=history)
        self.assertEqual([m["role"] for m in messages], ["system", "user", "assistant", "user"])
        self.assertIn("prompt text", messages[-1]["content"])
        self.assertIn("change it", messages[-1]["content"])

    def test_image_is_attached_to_final_user_message(self):
        image = {"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}}
        messages = build_edit_messages("p", "i", images=[image])
        self.assertIsInstance(messages[-1]["content"], list)
        self.assertEqual(messages[-1]["content"][1]["type"], "image_url")

    def test_layout_mode_asks_for_patch_and_lists_item_indices(self):
        layout_json = json.dumps(
            {
                "summary": {"caption": "A bright street scene."},
                "items": [{"label": "character", "caption": "A girl", "bbox": [0, 0, 100, 100]}],
            }
        )
        messages = build_edit_messages(layout_json, "调整光照为柔和漫射光", mode="layout")
        # 布局模式换的是“只吐改动字段”的契约：模型不再重写整份 JSON
        self.assertIn("patch", messages[0]["content"])
        self.assertNotIn("Allowed ops", messages[0]["content"])
        self.assertIn("ITEMS (0-based index)", messages[-1]["content"])
        self.assertIn("#0 character", messages[-1]["content"])


class RequestEditTests(unittest.TestCase):
    def test_request_edit_returns_applied_proposal(self):
        _mock, _settings, client, _audit = make_client(self, model="editor-model")
        proposal = request_edit(
            client, current_text="a cat on a mat, sunny", instruction="replace the cat with a dog"
        )
        self.assertEqual(proposal.text, "a dog on a mat, sunny")
        self.assertEqual(proposal.changes[0]["before"], "a cat")
        self.assertGreater(proposal.latency_ms, -1)

    def test_request_edit_allow_empty_drafts_from_scratch(self):
        _mock, _settings, client, _audit = make_client(self, model="demo-model")
        proposal = request_edit(
            client, current_text="   ", instruction="写一段赛博朋克街景提示词", allow_empty=True
        )
        self.assertTrue(proposal.changed)
        self.assertTrue(proposal.text.strip())

    def test_request_edit_noop(self):
        _mock, _settings, client, _audit = make_client(self, model="editor-noop")
        proposal = request_edit(client, current_text="a cat", instruction="is this good?")
        self.assertFalse(proposal.changed)
        self.assertEqual(proposal.text, "a cat")
        self.assertTrue(proposal.reply)

    def test_request_edit_bad_json_is_rejected(self):
        _mock, _settings, client, _audit = make_client(self, model="editor-bad-json")
        with self.assertRaises(EditValidationError):
            request_edit(client, current_text="a cat", instruction="change it")

    def test_empty_instruction_rejected(self):
        _mock, _settings, client, _audit = make_client(self, model="editor-model")
        with self.assertRaises(EditValidationError):
            request_edit(client, current_text="a cat", instruction="   ")

    def test_layout_mode_rejects_non_json_reply_and_keeps_clarifying_noop(self):
        layout_json = json.dumps(
            {
                "summary": {"caption": "A bright street scene."},
                "items": [{"label": "character", "caption": "A girl", "bbox": [0, 0, 100, 100]}],
            }
        )
        # editor-bad-json 回的是人话，不是 JSON -> 必须拒绝，不能把整份布局弄坏
        _mock1, _s1, client_bad, _a1 = make_client(self, model="editor-bad-json")
        with self.assertRaises(EditValidationError):
            request_edit(client_bad, current_text=layout_json, instruction="add soft rim light", mode="layout")

        # editor-noop 只回 reply、不带 patch -> 布局原样保留
        _mock2, _s2, client_noop, _a2 = make_client(self, model="editor-noop")
        proposal = request_edit(
            client_noop, current_text=layout_json, instruction="帮我改一下背景", mode="layout"
        )
        self.assertFalse(proposal.changed)
        self.assertEqual(proposal.text, layout_json)
        self.assertTrue(proposal.reply)

    def test_layout_mode_applies_patch_and_keeps_rest_untouched(self):
        layout_json = json.dumps(
            {
                "summary": {"caption": "A girl stands in a bright street scene."},
                "items": [
                    {"label": "character", "caption": "A girl with long hair", "bbox": [10, 10, 90, 90]},
                    {"label": "object", "caption": "A wooden bench", "bbox": [0, 0, 5, 5]},
                ],
            },
            ensure_ascii=False,
        )
        _mock, _settings, client, _audit = make_client(self, model="editor-patch")
        proposal = request_edit(client, current_text=layout_json, instruction="换成短发骑士", mode="layout")
        self.assertTrue(proposal.changed)
        merged = json.loads(proposal.text)
        self.assertEqual(merged["summary"]["caption"], "A knight stands in a stone hall.")
        self.assertEqual(merged["items"][0]["caption"], "A short-haired knight in worn plate armor.")
        # 没被点名的框一个字段都不能动
        self.assertEqual(merged["items"][1]["caption"], "A wooden bench")
        self.assertEqual(merged["items"][1]["bbox"], [0, 0, 5, 5])
        self.assertEqual(merged["items"][0]["bbox"], [10, 10, 90, 90])

    def test_layout_patch_that_only_rewrites_summary_is_rejected(self):
        layout = {
            "summary": {"caption": "A girl stands in a bright street scene."},
            "items": [{"label": "object", "caption": "A deep blue night sky", "bbox": [0, 0, 100, 100]}],
        }
        raw = json.dumps({"reply": "已把背景换成晴天", "patch": {"summary": {"caption": "A sunny rooftop."}}})
        # 只改 summary、没动任何 items -> 画面其实没变，必须当失败重试而不是假成功
        with self.assertRaises(EditValidationError):
            parse_layout_proposal(raw, json.dumps(layout, ensure_ascii=False))

    def test_layout_patch_accepts_string_index(self):
        layout = {
            "summary": {"caption": "A girl stands in a bright street scene."},
            "items": [
                {"label": "character", "caption": "A girl with long hair", "bbox": [0, 0, 50, 50]},
                {"label": "object", "caption": "A wooden bench", "bbox": [0, 0, 10, 10]},
            ],
        }
        raw = json.dumps(
            {"reply": "改长椅", "patch": {"items": [{"index": "1", "name": "石长椅", "caption": "A stone bench"}]}}
        )
        proposal = parse_layout_proposal(raw, json.dumps(layout, ensure_ascii=False))
        self.assertTrue(proposal.changed)
        merged = json.loads(proposal.text)
        self.assertEqual(merged["items"][1]["caption"], "A stone bench")
        # 画框短名也要跟着改，否则画布上的框还是旧名字
        self.assertEqual(merged["items"][1]["name"], "石长椅")

    def test_layout_patch_covers_every_item_field_not_just_caption(self):
        layout = {
            "summary": {"caption": "A poster with a slogan."},
            "items": [
                {"label": "text", "caption": "Old slogan", "text": "OLD", "bbox": [0, 0, 100, 100]},
            ],
        }
        raw = json.dumps(
            {
                "reply": "换标语",
                "patch": {
                    "items": [
                        {
                            "index": 0,
                            "name": "主标语",
                            "label": "text",
                            "caption": "A bold new slogan across the wall.",
                            "text": "NEW WORLD",
                            "tags": ["bold", "white"],
                            "palette": ["red", "black"],
                            "bbox": [10, 20, 300, 400],
                        }
                    ]
                }
            }
        )
        proposal = parse_layout_proposal(raw, json.dumps(layout, ensure_ascii=False))
        item = json.loads(proposal.text)["items"][0]
        self.assertEqual(item["name"], "主标语")
        self.assertEqual(item["text"], "NEW WORLD")
        self.assertEqual(item["tags"], ["bold", "white"])
        self.assertEqual(item["palette"], ["red", "black"])
        self.assertEqual(item["bbox"], [10, 20, 300, 400])

    def test_bbox_from_model_is_converted_into_centralized_yxyx(self):
        layout = {
            "summary": {"caption": "A room."},
            "bbox_format": "yxyx",
            "bbox_coord_space": "abs_centralized",
            "items": [{"label": "object", "caption": "A chair", "bbox": [-200.0, -300.0, -100.0, -100.0]}],
        }
        # 模型永远给左上角原点的绝对 xyxy
        raw = json.dumps({"reply": "移椅子", "patch": {"items": [{"index": 0, "bbox": [100, 200, 300, 400]}]}})
        proposal = parse_layout_proposal(raw, json.dumps(layout, ensure_ascii=False), canvas=(800, 1200))
        box = json.loads(proposal.text)["items"][0]["bbox"]
        # 800x1200 画布 → 中心在 (400, 600)；xyxy → yxyx + 减半画布
        self.assertEqual(box, [-400.0, -300.0, -200.0, -100.0])

    def test_bbox_already_in_centered_space_is_not_shifted_again(self):
        layout = {
            "summary": {"caption": "A room."},
            "bbox_format": "yxyx",
            "bbox_coord_space": "abs_centralized",
            "items": [{"label": "object", "caption": "A chair", "bbox": [-100.0, -100.0, 100.0, 100.0]}],
        }
        # 模型抄了文档里邻框的写法（负数、以中心为原点），不能再减一次半画布
        raw = json.dumps({"reply": "微调", "patch": {"items": [{"index": 0, "bbox": [-200, -150, 200, 150]}]}})
        proposal = parse_layout_proposal(raw, json.dumps(layout, ensure_ascii=False), canvas=(800, 1200))
        self.assertEqual(json.loads(proposal.text)["items"][0]["bbox"], [-150.0, -200.0, 150.0, 200.0])


if __name__ == "__main__":
    unittest.main()
