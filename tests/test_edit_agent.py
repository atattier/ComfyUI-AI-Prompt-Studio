from __future__ import annotations

import json
import unittest

from prompt_studio.diff import EditValidationError
from prompt_studio.edit_agent import (
    build_chat_messages,
    build_edit_messages,
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


class MessageTests(unittest.TestCase):
    def test_edit_messages_include_prompt_verbatim(self):
        messages = build_edit_messages("a cat, sunny", "make it rainy")
        self.assertEqual(messages[0]["role"], "system")
        self.assertIn("a cat, sunny", messages[1]["content"])
        self.assertIn("make it rainy", messages[1]["content"])
        self.assertIn("JSON", messages[0]["content"])

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


class RequestEditTests(unittest.TestCase):
    def test_request_edit_returns_applied_proposal(self):
        _mock, _settings, client, _audit = make_client(self, model="editor-model")
        proposal = request_edit(
            client, current_text="a cat on a mat, sunny", instruction="replace the cat with a dog"
        )
        self.assertEqual(proposal.text, "a dog on a mat, sunny")
        self.assertEqual(proposal.changes[0]["before"], "a cat")
        self.assertGreater(proposal.latency_ms, -1)

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


if __name__ == "__main__":
    unittest.main()
