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
MAX_ITEMS = 16  # expanded to 16 to support rich hierarchical graph decomposition


def match_canvas_size(width: int, height: int) -> tuple[int, int]:
    """Pick the official-compatible size closest to the source aspect ratio."""
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
            err = abs((w / h) - ratio) / ratio
            area_gap = abs(w * h - TARGET_PIXELS)
            key = (err, area_gap, -(w * h))
            if best is None or key < best[:3]:
                best = (err, area_gap, -(w * h), w, h)
    assert best is not None
    return best[3], best[4]


def _clamp_int(value: Any, lo: int, hi: int, default: int) -> int:
    try:
        if isinstance(value, bool):
            return default
        return max(lo, min(hi, int(round(float(value)))))
    except (TypeError, ValueError):
        return default


def _infer_name(item: dict[str, Any], label: str, index: int) -> str:
    """Infer a concise, descriptive semantic name if the model omitted one."""
    raw_name = str(item.get("name") or item.get("title") or item.get("label_zh") or "").strip()
    if raw_name:
        return raw_name[:24]

    cap = str(item.get("caption") or "").lower()
    text = str(item.get("text") or "").strip()
    parent = str(item.get("parent") or "").lower()

    if label == "text" or text:
        if text:
            if "poster" in parent or "海报" in parent or "title" in cap:
                return f"海报标题「{text[:8]}」"
            if "flyer" in parent or "传单" in parent or "brochure" in parent:
                return f"宣传单文字「{text[:8]}」"
            return f"文字「{text[:10]}」"
        if "poster" in parent or "海报" in parent:
            return "海报标题"
        if "flyer" in parent or "传单" in parent:
            return "宣传单文字"
        return "画面文字"

    # Specific feature keywords inspired by KohakuGBC scene-graph hierarchy
    if any(k in cap for k in ("halo", "glowing ring", "光环")):
        return "光环"
    if any(k in cap for k in ("shard", "light wing", "energy wing", "碎片翼", "光之碎片翼")):
        return "光之碎片翼"
    if any(k in cap for k in ("wing", "wings", "翅膀", "羽翼")):
        return "羽翼"
    if any(k in cap for k in ("horn", "horns", "角")):
        return "角/饰角"
    if any(k in cap for k in ("poster", "海报")):
        if any(k in cap for k in ("door poster", "门上海报", "门上宣传海报")):
            return "门上宣传海报"
        return "宣传海报"
    if any(k in cap for k in ("flyer", "leaflet", "brochure", "传单")):
        if any(k in cap for k in ("table", "desk", "counter", "桌")):
            return "桌上宣传单"
        if any(k in cap for k in ("bottom", "left", "corner", "左下")):
            return "左下宣传单"
        return "宣传单"
    if any(k in cap for k in ("door", "glass door", "玻璃门", "门")):
        return "玻璃门"
    if any(k in cap for k in ("window", "windows", "落地窗", "窗")):
        return "观景窗"
    if any(k in cap for k in ("cafe", "coffee", "restaurant", "interior", "room", "background", "内景", "背景")):
        return "咖啡厅内景" if any(k in cap for k in ("cafe", "coffee", "咖啡")) else "场景内景"
    if any(k in cap for k in ("girl", "woman", "nurse", "anime girl", "少女", "女性")):
        if any(k in cap for k in ("red hair", "red-hair", "crimson hair", "红发")):
            return "红发少女"
        return "主要人物"

    if label == "character":
        return f"人物主体 #{index + 1}"
    return f"物体 #{index + 1}"


def _item_importance_score(it: dict[str, Any]) -> float:
    """Calculate an importance score so critical small features (halos, text) are never dropped."""
    score = 0.0
    name = str(it.get("name") or "").lower()
    cap = str(it.get("caption") or "").lower()
    lbl = str(it.get("label") or "").lower()

    if any(k in name or k in cap for k in ("halo", "wing", "光环", "翼", "翅膀", "horn", "weapon", "武器", "饰")):
        score += 120.0

    if lbl == "text" or it.get("text") or any(k in name for k in ("文字", "标题", "text", "title")):
        score += 100.0

    if lbl == "character" or any(k in name or k in cap for k in ("girl", "boy", "person", "woman", "man", "少女", "角色")):
        score += 90.0

    if any(k in name or k in cap for k in ("poster", "flyer", "海报", "传单", "paper")):
        score += 75.0

    if any(k in name or k in cap for k in ("door", "window", "cafe", "interior", "门", "窗", "景")):
        score += 65.0

    bbox = it.get("bbox", [0, 0, 0, 0])
    bw = max(0, bbox[2] - bbox[0])
    bh = max(0, bbox[3] - bbox[1])
    area = bw * bh
    score += math.sqrt(area) * 0.02
    return score


def parse_model_layout(raw: str, width: int, height: int, *, max_items: int = MAX_ITEMS) -> dict[str, Any]:
    """Parse a model's layout JSON, convert normalized boxes to pixels, and preserve semantic metadata."""
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("The model returned an empty layout.")
    text = raw.strip()
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", text, flags=re.DOTALL | re.IGNORECASE)
    if fence:
        text = fence.group(1).strip()
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

        raw_label = str(it.get("label") or "").strip().lower()
        cap = str(it.get("caption") or "").strip()
        if not cap:
            cap = f"Region {index + 1}"

        if raw_label in _LABELS:
            label = raw_label
        elif raw_label in ("person", "human", "figure", "feature", "accessory"):
            label = "character"
        elif raw_label in ("sign", "title", "typography", "caption_text"):
            label = "text"
        else:
            label = "object"

        bbox = it.get("bbox")
        if not (isinstance(bbox, list) and len(bbox) == 4):
            bbox = [100, 100, 900, 900]
        try:
            nums = [float(v) for v in bbox]
        except (TypeError, ValueError):
            nums = [100.0, 100.0, 900.0, 900.0]
        if any(not math.isfinite(v) for v in nums):
            nums = [100.0, 100.0, 900.0, 900.0]

        if max(nums) <= 1.0:
            nums = [v * 1000 for v in nums]
        elif max(nums) > 1000:
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

        item_name = _infer_name(it, label, index)
        parent_name = str(it.get("parent") or "").strip()

        item: dict[str, Any] = {
            "name": item_name,
            "label": label,
            "caption": cap,
            "bbox": [px1, py1, px2, py2],
        }
        if parent_name:
            item["parent"] = parent_name

        literal = it.get("text")
        if label == "text" or (isinstance(literal, str) and literal.strip()):
            if not isinstance(literal, str) or not literal.strip():
                literal = cap
            item["text"] = literal.strip()

        items.append(item)

    if not items:
        raise ValueError("The model layout has no usable items.")

    limit = max(1, min(MAX_ITEMS, int(max_items or MAX_ITEMS)))
    if len(items) > limit:
        ranked_indices = sorted(
            range(len(items)),
            key=lambda i: _item_importance_score(items[i]),
            reverse=True,
        )[:limit]
        items = [items[i] for i in sorted(ranked_indices)]

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
    """Build the model instruction for hierarchical graph-based layout detection."""
    region_limit = max(1, min(16, int(max_regions or 10)))
    count_clause = f"AT MOST {region_limit} regions"
    if region_limit != 6:
        count_clause += f" (up to at most 6 regions by default, typically 8 to {region_limit} for rich scenes)"
    strict = (
        "You are an expert Vision-Language Scene Graph parser and visual layout analyzer "
        "(inspired by KohakuGBC graph-based scene decomposition).\n"
        f"Your task is to decompose the entire image into a hierarchical, layered visual scene graph with "
        f"{count_clause}: distinct, precise, tightly bounded regions.\n\n"
        "### STRICT 6-LEVEL HIERARCHICAL DECOMPOSITION RULES:\n"
        "1. Level 0 - Global Environment Space: The overall background/setting (e.g. '咖啡厅内景' / 'Cafe Interior', 'Streetscape').\n"
        "2. Level 1 - Architectural / Structural Dividers: Physical structures framing the scene (e.g. '玻璃门' / 'Glass Door', 'Window', 'Counter').\n"
        "3. Level 2 - Main Character Subject: The primary character(s) body & pose (e.g. '红发少女' / 'Red-haired Girl').\n"
        "4. Level 3 - DECOUPLE DISTINCTIVE FEATURES & Fantasy Elements (CRITICAL):\n"
        "   NEVER merge standalone or fantasy features into the character body! Detect them as separate, tight boxes:\n"
        "   - Floating halos ('光环')\n"
        "   - Energy/light shard wings ('光之碎片翼')\n"
        "   - Horns, tails, weapons, or floating artifacts\n"
        "5. Level 4 - Standalone Props & Media: Significant objects (e.g. '门上宣传海报' / 'Door Poster', '桌上宣传单' / 'Table Flyer', '左下宣传单').\n"
        "6. Level 5 - Nested Text & Typography (Fine-Grained Children):\n"
        "   - Text/title inside posters/flyers (e.g. '海报标题' / 'Poster Title', '宣传单文字').\n"
        "   - Set 'parent' to the enclosing prop (e.g. '海报标题' parent is '门上宣传海报').\n"
        "   - Verbatim transcribe visible words into the 'text' field.\n\n"
        "### Bounding Box Coordinates:\n"
        "- [x1, y1, x2, y2] must be integers in 0-1000 normalized space (0,0 is top-left, 1000,1000 is bottom-right).\n"
        "- Ensure boxes are tightly wrapped around each object without sloppy margins.\n\n"
        "### JSON Output Format (STRICT JSON ONLY, NO MARKDOWN FENCE, NO EXPLANATIONS):\n"
        '{"summary":{"caption":"Overall cohesive image prompt"},"items":[{"name":"中文实体名 (如 光环 / 红发少女 / 门上宣传海报)","label":"object|character|text","parent":"父级实体名或空","bbox":[x1,y1,x2,y2],"caption":"Vivid English visual description for generation","text":"Visible text if text label"}]}\n'
    )
    if mode == "hybrid":
        strict += (
            "summary.caption must be a COMPLETE natural-language description of the whole image "
            "(subject, action, setting, composition, lighting, style), 2-4 sentences, not just a short title.\n"
        )
    else:
        strict += "summary.caption is a cohesive overall image description.\n"

    strict += (
        f"The target canvas is {width}x{height}; keep the boxes consistent with the "
        "image's composition regardless of target pixel size."
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
