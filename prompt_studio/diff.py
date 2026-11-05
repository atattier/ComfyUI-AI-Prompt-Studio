"""Prompt edit operations, validation and block-level diff.

The model never returns a whole rewritten prompt as the thing we apply.
Instead it returns a small set of explicit operations against the current
prompt.  Every operation is validated against the text it is applied to, so a
hallucinated ``before`` string can never silently rewrite a user's prompt.

Operations (applied in order, each against the result of the previous one):

``replace``       ``before`` (must occur exactly once) -> ``after``
``delete``        remove ``before`` (must occur exactly once)
``insert_after``  insert ``after`` immediately after ``before``
``append``        append ``after`` to the end of the text

The same module also produces a block-level view (prompt blocks are split on
newlines or commas) used by the UI diff card.
"""

from __future__ import annotations

import difflib
import re
from dataclasses import dataclass, field
from typing import Any, Iterable

from .errors import StudioError

MAX_OPS = 24
MAX_TEXT_CHARS = 40_000
MAX_PART_CHARS = 8_000


class EditValidationError(StudioError):
    code = "invalid_edit"
    http_status = 422


@dataclass(slots=True)
class EditOp:
    op: str
    before: str = ""
    after: str = ""
    why: str = ""

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"op": self.op}
        if self.before:
            out["before"] = self.before
        if self.after:
            out["after"] = self.after
        if self.why:
            out["why"] = self.why
        return out


def _as_op(raw: Any) -> EditOp:
    if not isinstance(raw, dict):
        raise EditValidationError("Each change must be an object.")
    op = str(raw.get("op") or "").strip().lower()
    if op not in ("replace", "delete", "insert_after", "append"):
        raise EditValidationError(f"Unsupported edit operation: {op or '(empty)'}.")
    before = raw.get("before")
    after = raw.get("after")
    why = raw.get("why") or raw.get("reason") or ""
    before = "" if before is None else str(before)
    after = "" if after is None else str(after)
    if len(before) > MAX_PART_CHARS or len(after) > MAX_PART_CHARS:
        raise EditValidationError("A single edit is too large.")
    if op in ("replace", "delete", "insert_after") and not before:
        raise EditValidationError(f'Operation "{op}" requires a non-empty "before".')
    if op == "replace" and not after:
        raise EditValidationError('Operation "replace" requires a non-empty "after".')
    if op == "append" and not after:
        raise EditValidationError('Operation "append" requires a non-empty "after".')
    return EditOp(op=op, before=before, after=after, why=str(why)[:500])


def parse_ops(raw_ops: Any) -> list[EditOp]:
    if raw_ops is None:
        return []
    if not isinstance(raw_ops, list):
        raise EditValidationError("changes must be an array.")
    if len(raw_ops) > MAX_OPS:
        raise EditValidationError(f"Too many changes (max {MAX_OPS}).")
    return [_as_op(item) for item in raw_ops]


def _count(haystack: str, needle: str) -> int:
    return haystack.count(needle)


def apply_ops(text: str, ops: Iterable[EditOp | dict[str, Any]], *, require_change: bool = True) -> str:
    """Apply validated operations in order; never mutates the input."""
    if not isinstance(text, str):
        raise EditValidationError("prompt text must be a string.")
    if len(text) > MAX_TEXT_CHARS:
        raise EditValidationError("Prompt is too long for an edit.")
    parsed = [op if isinstance(op, EditOp) else _as_op(op) for op in ops]
    if not parsed and require_change:
        raise EditValidationError("The model returned no changes.")
    current = text
    for index, op in enumerate(parsed, 1):
        if op.op == "append":
            current = current + op.after
            continue
        occurrences = _count(current, op.before)
        if occurrences == 0:
            raise EditValidationError(
                f"Change {index} was not applied: its `before` text is not present in the prompt."
            )
        if occurrences > 1:
            raise EditValidationError(
                f"Change {index} is ambiguous: its `before` text appears {occurrences} times."
            )
        if op.op == "replace":
            current = current.replace(op.before, op.after, 1)
        elif op.op == "delete":
            current = current.replace(op.before, "", 1)
        elif op.op == "insert_after":
            position = current.index(op.before) + len(op.before)
            current = current[:position] + op.after + current[position:]
        if len(current) > MAX_TEXT_CHARS:
            raise EditValidationError("The edit would make the prompt too long.")
    if require_change and current == text:
        raise EditValidationError("The proposed edit does not change the prompt.")
    return current


def preview_ops(text: str, ops: Iterable[EditOp | dict[str, Any]]) -> dict[str, Any]:
    """Validate ops and return the resulting prompt plus a block diff."""
    parsed = [op if isinstance(op, EditOp) else _as_op(op) for op in ops]
    result = apply_ops(text, parsed)
    return {
        "text": result,
        "changes": [op.to_dict() for op in parsed],
        "blocks": block_diff(text, result),
        "changed": result != text,
    }


_BLOCK_SPLIT = re.compile(r"(\r?\n|[,，;；])")


def split_blocks(text: str) -> list[str]:
    """Split a prompt into display blocks, keeping the separators attached."""
    if not text:
        return []
    parts = _BLOCK_SPLIT.split(text)
    blocks: list[str] = []
    for index in range(0, len(parts), 2):
        body = parts[index]
        separator = parts[index + 1] if index + 1 < len(parts) else ""
        block = (body + separator).strip()
        if block:
            blocks.append(block)
    return blocks


_TRAILING = " \t\r\n,，;；"


def _same_block(left: str, right: str) -> bool:
    """A block that only gained a trailing separator is not a real change."""
    return left.rstrip(_TRAILING) == right.rstrip(_TRAILING)


def block_diff(before: str, after: str) -> list[dict[str, Any]]:
    """Block-level diff for the UI. Types: equal, add, del, change."""
    old = split_blocks(before)
    new = split_blocks(after)
    matcher = difflib.SequenceMatcher(a=old, b=new, autojunk=False)
    out: list[dict[str, Any]] = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for block in old[i1:i2]:
                out.append({"type": "equal", "text": block})
        elif tag == "delete":
            for block in old[i1:i2]:
                out.append({"type": "del", "text": block})
        elif tag == "insert":
            for block in new[j1:j2]:
                out.append({"type": "add", "text": block})
        else:  # replace
            old_blocks = old[i1:i2]
            new_blocks = new[j1:j2]
            for offset in range(max(len(old_blocks), len(new_blocks))):
                old_block = old_blocks[offset] if offset < len(old_blocks) else ""
                new_block = new_blocks[offset] if offset < len(new_blocks) else ""
                if old_block and new_block:
                    if _same_block(old_block, new_block):
                        out.append({"type": "equal", "text": new_block})
                    else:
                        out.append({"type": "change", "before": old_block, "after": new_block})
                elif old_block:
                    out.append({"type": "del", "text": old_block})
                else:
                    out.append({"type": "add", "text": new_block})
    return out


EXCERPT_LIMIT = 12


def summarize_blocks(blocks: list[dict[str, Any]]) -> dict[str, int]:
    counts = {"equal": 0, "add": 0, "del": 0, "change": 0}
    for block in blocks:
        kind = block.get("type")
        if kind in counts:
            counts[kind] += 1
    return counts
