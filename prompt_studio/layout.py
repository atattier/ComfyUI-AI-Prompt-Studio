"""MOSS-Image layout helpers: canvas size matching and layout draft handling.

The official MOSS-Image constraints (see MossTool's mosi.py and the official
compile_prompt validator) are: each side 256-2048, a multiple of 16, and
total pixels <= 2,097,152.  PromptBoard's compiler is the consumer of our
layout drafts, so drafts produced here must pass ``sanitize_layout_draft`` and
``compile_prompt`` unchanged.
"""

from __future__ import annotations

import json
import math
import re
from typing import Any

MIN_SIDE = 256
MAX_SIDE = 2048
MULTIPLE = 16
MAX_PIXELS = 2097152
TARGET_PIXELS = 1048576  # ~1M: preferred output area, secondary to aspect ratio

_LABELS = ("object", "character", "text")
MAX_ITEMS = 8  # keep the editor usable when the model over-segments UI text


def match_canvas_size(width: int, height: int) -> tuple[int, int]:
    """Pick the official-compatible size closest to the source aspect ratio.

    Selection is lexicographic: **aspect-ratio error first** (primary), then
    distance of total pixels from ~1M (secondary), then larger area as a
    tie-break.  Candidates are all (w, h) pairs with sides in 256..2048,
    multiples of 16, and w*h <= 2,097,152.  Roughly 112^2 pairs are examined,
    which is cheap and avoids hand-maintained whitelists drifting out of sync
    with the official rule.
    """
    w0 = int(width)
    h0 = int(height)
    if w0 <= 0 or h0 <= 0:
        raise ValueError(f"image dimensions must be positive, got {width}x{height}")
    ratio = w0 / h0
    sides = range(MIN_SIDE, MAX_SIDE + 1, MULTIPLE)
    best: tuple[float, float, int, int, int] | None = None
    for w in sides:
        max_h = min(MAX_SIDE, MAX_PIXELS // w)
        for h in sides:
            if h > max_h:
                continue
            err = abs((w / h) - ratio) / ratio  # relative aspect error
            area_gap = abs(w * h - TARGET_PIXELS)
            key = (err, area_gap, -(w * h))
            if best is None or key < best[:3]:
                best = (err, area_gap, -(w * h), w, h)
    assert best is not None  # sides are non-empty
    return best[3], best[4]


def _clamp_int(value: Any, lo: int, hi: int, default: int) -> int:
    try:
        if isinstance(value, bool):
            return default
        return max(lo, min(hi, int(round(float(value)))))
    except (TypeError, ValueError):
        return default


def parse_model_layout(raw: str, width: int, height: int, *, max_items: int = MAX_ITEMS) -> dict[str, Any]:
    """Parse a model's layout JSON and convert normalized boxes to pixels.

    The model is asked for bbox values in 0..1000 normalized space (models are
    unreliable at absolute pixel coordinates).  Anything that superficially
    looks like 0..1 normalized input is scaled as well.  The output is a
    strict PromptBoard-compatible draft: only root/summary/item fields the
    official compiler accepts, with integer xyxy boxes clamped to the canvas.
    """
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("The model returned an empty layout.")
    text = raw.strip()
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", text, flags=re.DOTALL | re.IGNORECASE)
    if fence:
        text = fence.group(1).strip()
    # Tolerate prose around the JSON object.
    if not text.startswith("{"):
        start = text.find("{")
        if start >= 0:
            text = text[start:]
    end = text.rfind("}")
    if end >= 0:
        text = text[:end + 1]
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"The model returned invalid layout JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError("The model layout must be a JSON object.")

    summary = data.get("summary") if isinstance(data.get("summary"), dict) else {}
    caption = summary.get("caption") or data.get("caption") or ""
    if not isinstance(caption, str) or not caption.strip():
        raise ValueError("The model layout has no summary caption.")
    items_in = data.get("items")
    if not isinstance(items_in, list):
        raise ValueError("The model layout must have an items array.")
    items: list[dict[str, Any]] = []
    for index, it in enumerate(items_in):
        if not isinstance(it, dict):
            continue
        label = it.get("label")
        if label not in _LABELS:
            label = "object"
        cap = it.get("caption")
        if not isinstance(cap, str) or not cap.strip():
            cap = f"Region {index + 1}"
        bbox = it.get("bbox")
        if not (isinstance(bbox, list) and len(bbox) == 4):
            bbox = [100, 100, 900, 900]
        try:
            nums = [float(v) for v in bbox]
        except (TypeError, ValueError):
            nums = [100.0, 100.0, 900.0, 900.0]
        if any(not math.isfinite(v) for v in nums):
            nums = [100.0, 100.0, 900.0, 900.0]
        # 0..1 fractional coordinates -> scale to 0..1000; otherwise treat as
        # 0..1000 normalized (models occasionally emit 0..100 or raw pixels).
        if max(nums) <= 1.0:
            nums = [v * 1000 for v in nums]
        elif max(nums) > 1000:
            # Raw pixel coordinates for a different canvas: map proportionally.
            scale_x = 1000 / max(width, 1)
            scale_y = 1000 / max(height, 1)
            nums = [nums[0] * scale_x, nums[1] * scale_y, nums[2] * scale_x, nums[3] * scale_y]
        x1, y1, x2, y2 = (v / 1000 for v in nums)
        if x2 < x1:
            x1, x2 = x2, x1
        if y2 < y1:
            y1, y2 = y2, y1
        px1 = _clamp_int(x1 * width, 0, width - 2, 0)
        py1 = _clamp_int(y1 * height, 0, height - 2, 0)
        px2 = _clamp_int(x2 * width, px1 + 1, width, width)
        py2 = _clamp_int(y2 * height, py1 + 1, height, height)
        item: dict[str, Any] = {
            "label": label,
            "caption": cap.strip(),
            "bbox": [px1, py1, px2, py2],
        }
        if label == "text":
            literal = it.get("text")
            if not isinstance(literal, str) or not literal.strip():
                literal = cap.strip()
            item["text"] = literal.strip()
        items.append(item)
    if not items:
        raise ValueError("The model layout has no usable items.")
    limit = max(1, min(MAX_ITEMS, int(max_items or MAX_ITEMS)))
    if len(items) > limit:
        # Models over-segment screenshots into dozens of tiny UI text boxes.
        # Keep the largest regions (by area), preserving model order afterwards.
        ranked = sorted(
            range(len(items)),
            key=lambda i: (
                (items[i]["bbox"][2] - items[i]["bbox"][0])
                * (items[i]["bbox"][3] - items[i]["bbox"][1])
            ),
            reverse=True,
        )[:limit]
        items = [items[i] for i in sorted(ranked)]
    return {
        "width": int(width),
        "height": int(height),
        "bbox_coord_space": "abs",
        "bbox_format": "xyxy",
        "summary": {"caption": caption.strip(), "canvas": "single"},
        "items": items,
    }


def layout_instruction(
    mode: str,
    width: int,
    height: int,
    extra: str = "",
    *,
    max_regions: int = 6,
) -> str:
    """Build the model instruction for layout/hybrid mode."""
    region_limit = max(1, min(8, int(max_regions or 6)))
    region_clause = (
        "AT MOST 6 regions"
        if region_limit == 6
        else f"AT MOST {region_limit} regions (up to at most 6 regions by default)"
    )
    strict = (
        "Analyse the image and identify the main visual regions (subjects, "
        "objects, background, visible text). Output ONE strictly valid JSON "
        "object only, no markdown, no explanations. Schema exactly:\n"
        '{"summary":{"caption":"..."},"items":[{"label":"object|character|text",'
        '"caption":"...","bbox":[x1,y1,x2,y2],"text":"..."}]}\n'
        "bbox values are integers in a 0-1000 normalized coordinate space "
        "(top-left origin, xyxy), NOT pixels. Use the full extent of the image. "
        "label must be one of object, character, text; for label=text include "
        "the literal visible text as 'text'. captions are concise English "
        f"descriptions of visible appearance. items must contain at least one "
        f"entry and {region_clause}: group small details together and ignore "
        "tiny UI labels/text unless they are a dominant subject."
    )
    if mode == "hybrid":
        strict += (
            " summary.caption must be a COMPLETE natural-language description of "
            "the whole image (subject, action, setting, composition, lighting, "
            "style), 2-4 sentences, not just a short title."
        )
    else:
        strict += " summary.caption is a short overall image description."
    strict += (
        "\nThe target canvas is %dx%d; keep the boxes consistent with the "
        "image's composition regardless of the target pixel size." % (width, height)
    )
    if extra.strip():
        strict += "\n\nAdditional user requirement: " + extra.strip()
    return strict


def draft_json(draft: dict[str, Any]) -> str:
    return json.dumps(draft, ensure_ascii=False, separators=(",", ":"))


__all__ = [
    "match_canvas_size", "parse_model_layout", "layout_instruction",
    "draft_json", "MIN_SIDE", "MAX_SIDE", "MULTIPLE", "MAX_PIXELS",
]
