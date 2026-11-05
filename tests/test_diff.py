from __future__ import annotations

import unittest

from prompt_studio.diff import (
    EditOp,
    EditValidationError,
    apply_ops,
    block_diff,
    parse_ops,
    preview_ops,
    split_blocks,
    summarize_blocks,
)

PROMPT = "a cat on a mat, sunny afternoon, 35mm photo"


class ApplyTests(unittest.TestCase):
    def test_replace(self):
        self.assertEqual(
            apply_ops(PROMPT, [EditOp("replace", "sunny afternoon", "rainy night")]),
            "a cat on a mat, rainy night, 35mm photo",
        )

    def test_delete(self):
        self.assertEqual(
            apply_ops(PROMPT, [EditOp("delete", ", sunny afternoon")]),
            "a cat on a mat, 35mm photo",
        )

    def test_insert_after(self):
        self.assertEqual(
            apply_ops(PROMPT, [EditOp("insert_after", "a cat", ", sleeping")]),
            "a cat, sleeping on a mat, sunny afternoon, 35mm photo",
        )

    def test_append(self):
        self.assertEqual(apply_ops("abc", [EditOp("append", "", ", def")]), "abc, def")

    def test_sequential_ops_apply_to_result(self):
        ops = [
            EditOp("replace", "a cat", "a dog"),
            EditOp("insert_after", "a dog", " wearing a hat"),
        ]
        self.assertTrue(apply_ops("a cat here", ops).startswith("a dog wearing a hat"))

    def test_missing_before_is_rejected(self):
        with self.assertRaises(EditValidationError):
            apply_ops(PROMPT, [EditOp("replace", "a horse", "a dog")])

    def test_ambiguous_before_is_rejected(self):
        with self.assertRaises(EditValidationError) as ctx:
            apply_ops("a cat and a cat", [EditOp("replace", "a cat", "a dog")])
        self.assertIn("2 times", str(ctx.exception))

    def test_require_change(self):
        with self.assertRaises(EditValidationError):
            apply_ops(PROMPT, [])
        self.assertEqual(apply_ops(PROMPT, [], require_change=False), PROMPT)

    def test_no_op_replace_is_rejected(self):
        with self.assertRaises(EditValidationError):
            apply_ops(PROMPT, [EditOp("replace", "a cat", "a cat")])

    def test_input_is_not_mutated(self):
        original = PROMPT
        apply_ops(PROMPT, [EditOp("replace", "a cat", "a dog")])
        self.assertEqual(PROMPT, original)


class ParseTests(unittest.TestCase):
    def test_parse_dicts(self):
        ops = parse_ops([{"op": "replace", "before": "a", "after": "b"}])
        self.assertEqual(ops[0].op, "replace")

    def test_rejects_unknown_op(self):
        with self.assertRaises(EditValidationError):
            parse_ops([{"op": "rewrite", "before": "a", "after": "b"}])

    def test_rejects_empty_before(self):
        with self.assertRaises(EditValidationError):
            parse_ops([{"op": "delete", "before": ""}])

    def test_rejects_too_many_ops(self):
        with self.assertRaises(EditValidationError):
            parse_ops([{"op": "append", "after": "x"} for _ in range(25)])


class BlockDiffTests(unittest.TestCase):
    def test_split_commas_and_newlines(self):
        self.assertEqual(split_blocks("a, b，c\n d"), ["a,", "b，", "c", "d"])

    def test_change_detected(self):
        blocks = block_diff("a, b, c", "a, x, c")
        self.assertEqual(summarize_blocks(blocks)["change"], 1)
        self.assertEqual(summarize_blocks(blocks)["equal"], 2)

    def test_insert_and_delete(self):
        self.assertEqual(summarize_blocks(block_diff("a, c", "a, b, c"))["add"], 1)
        self.assertEqual(summarize_blocks(block_diff("a, b, c", "a, c"))["del"], 1)

    def test_separator_only_change_is_not_a_change(self):
        blocks = block_diff("a, b, c", "a, b, c, extra")
        self.assertEqual(summarize_blocks(blocks)["change"], 0)
        self.assertEqual(summarize_blocks(blocks)["add"], 1)

    def test_preview_returns_text_and_blocks(self):
        preview = preview_ops("a, b", [EditOp("replace", "b", "c")])
        self.assertEqual(preview["text"], "a, c")
        self.assertTrue(preview["changed"])
        self.assertTrue(preview["blocks"])


if __name__ == "__main__":
    unittest.main()
