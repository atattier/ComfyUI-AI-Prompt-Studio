"""Output-token budgets for every model call, in one place.

Why this module exists: a reasoning model spends part of ``max_tokens`` on
thinking before it writes anything, so the budget has to cover "thinking +
answer".  When the budget was picked per call site, every new feature guessed a
different number (500, 600, 128, 256, 1600...) and each guess produced the same
bug in a different place: the reply came back cut at its length, empty or with
half-written JSON.

Every call site therefore reads its budget from here, and every call that can
hit truncation goes through :func:`call`.
"""

from __future__ import annotations

from typing import Any, Callable

# Rich text (prose captions, layout JSON, edit operations): a reasoning model
# spends most of the budget thinking before the first useful character appears.
# Measured on the local gateway: 8192 → empty reply after 260s, 32768 → a full
# layout JSON in ~100s.  Small numbers here are the bug, not a saving.
OUTPUT_BUDGET = 32768
# Retry ceiling: nothing above this has ever changed the outcome.
ESCALATED_BUDGET = 32768
# A single comma-separated tag line, with thinking head-room.
TAG_BUDGET = 1600
# One-word / short-answer probes used by the capability test.
PROBE_BUDGET = 1024
# A short title generated from an existing prompt.
TITLE_BUDGET = 1024

TRUNCATION_REASONS = ("length", "max_tokens")


def truncated(result: Any) -> bool:
    """True when the reply was cut off at its length and left nothing usable."""
    text = str(getattr(result, "text", "") or "").strip()
    reason = getattr(result, "finish_reason", None)
    return not text and reason in TRUNCATION_REASONS


def call(
    client: Any,
    messages: list[dict[str, Any]],
    *,
    model: str | None = None,
    temperature: float = 0.3,
    budget: int = OUTPUT_BUDGET,
    retry_when: Callable[[Any], bool] | None = None,
) -> Any:
    """Stream one completion; retry once with a bigger budget if asked to.

    ``retry_when`` decides, from the first result, whether a larger budget is
    worth another attempt.  Repeating the same request at the same budget never
    helps — that is why the retry path always uses ESCALATED_BUDGET.
    """
    result = client.complete_via_stream(
        messages, model=model, temperature=temperature, max_tokens=budget
    )
    if retry_when is not None and retry_when(result):
        result = client.complete_via_stream(
            messages, model=model, temperature=temperature, max_tokens=ESCALATED_BUDGET
        )
    return result
