"""MOSS-Image layout helpers: canvas size matching, hybrid reverse-engineering,
depth/occlusion phrase generation, and official abs_centralized yxyx compilation.

The official MOSS-Image constraints (see MossTool's mosi.py and the official
compile_prompt validator) are: each side 256-2048, a multiple of 16, and
total pixels <= 2,097,152.
"""

from __future__ import annotations

import base64
import copy
import io
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
MAX_ITEMS = 16  # expanded to 16 to support rich hierarchical decomposition

_CJK = re.compile(r"[\u3400-\u9fff\uf900-\ufaff]")
_DEPTH_TAIL_RE = re.compile(
    r"\s*(?:In front of |Behind |Located in the (?:foreground|middle ground|background)|在「|位于(?:前景|中景|背景))[^.。]*(?:\.|。)\s*$",
    re.IGNORECASE,
)


def _is_cjk(text: str) -> bool:
    return bool(_CJK.search(text or ""))


def box_format_for(model: str = "") -> str:
    """Gemini / Gemma models are natively trained with box_2d [ymin, xmin, ymax, xmax]."""
    m = (model or "").lower()
    return "box_2d" if ("gemini" in m or "gemma" in m) else "box_1000"


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


def _clean_str_list(v: Any) -> list[str]:
    if not isinstance(v, list):
        return []
    return [str(x).strip() for x in v if isinstance(x, str) and str(x).strip()]


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
    if any(k in cap for k in ("arch", "column", "stone", "building", "architecture", "建筑", "石拱")):
        return "背景建筑"
    if any(k in cap for k in ("cafe", "coffee", "restaurant", "interior", "room", "background", "内景", "背景")):
        return "咖啡厅内景" if any(k in cap for k in ("cafe", "coffee", "咖啡")) else "场景内景"
    if any(k in cap for k in ("coat", "overcoat", "jacket", "大衣", "外套")):
        return "大衣外套"
    if any(k in cap for k in ("hoodie", "sweater", "shirt", "连帽衫", "卫衣", "内搭")):
        return "连帽内搭"
    if any(k in cap for k in ("skirt", "pleated", "百褶裙", "半身裙")):
        return "百褶裙"
    if any(k in cap for k in ("book", "paperback", "书")):
        return "手中书本"
    if any(k in cap for k in ("bag", "backpack", "duffle", "crossbody", "斜挎包", "背包")):
        return "斜挎包"
    if any(k in cap for k in ("scarf", "plaid", "围巾")):
        return "格子围巾"
    if any(k in cap for k in ("girl", "woman", "nurse", "anime girl", "少女", "女性", "女子")):
        if any(k in cap for k in ("red hair", "red-hair", "crimson hair", "红发")):
            return "红发少女"
        return "年轻女子"

    if label == "character":
        return f"人物主体 #{index + 1}"
    return f"物体 #{index + 1}"


def _item_importance_score(it: dict[str, Any]) -> float:
    """Calculate an importance score so critical small features (halos, text) are never dropped."""
    score = 0.0
    name = str(it.get("name") or "").lower()
    cap = str(it.get("caption") or "").lower()
    lbl = str(it.get("label") or "").lower()

    if any(k in name or k in cap for k in ("halo", "wing", "光环", "翼", "翅膀", "horn", "weapon", "武器", "饰", "book", "bag", "scarf")):
        score += 120.0

    if lbl == "text" or it.get("text") or any(k in name for k in ("文字", "标题", "text", "title")):
        score += 100.0

    if lbl == "character" or any(k in name or k in cap for k in ("girl", "boy", "person", "woman", "man", "少女", "女子", "角色")):
        score += 90.0

    if any(k in name or k in cap for k in ("poster", "flyer", "海报", "传单", "paper", "coat", "hoodie", "skirt")):
        score += 75.0

    if any(k in name or k in cap for k in ("door", "window", "cafe", "interior", "arch", "门", "窗", "景", "建筑")):
        score += 65.0

    bbox = it.get("bbox", [0, 0, 0, 0])
    bw = max(0, bbox[2] - bbox[0])
    bh = max(0, bbox[3] - bbox[1])
    area = bw * bh
    score += math.sqrt(area) * 0.02
    return score


def _extract_four_numbers(v: Any) -> list[float] | None:
    if isinstance(v, (list, tuple)) and len(v) == 4:
        try:
            nums = [float(x) for x in v if not isinstance(x, bool)]
            if len(nums) == 4 and all(math.isfinite(x) for x in nums):
                return nums
        except (TypeError, ValueError):
            return None
    if isinstance(v, dict):
        for ks in (("x1", "y1", "x2", "y2"), ("xmin", "ymin", "xmax", "ymax"),
                   ("x_min", "y_min", "x_max", "y_max"), ("left", "top", "right", "bottom")):
            if all(k in v for k in ks):
                try:
                    nums = [float(v[k]) for k in ks if not isinstance(v[k], bool)]
                    if len(nums) == 4 and all(math.isfinite(x) for x in nums):
                        return nums
                except (TypeError, ValueError):
                    pass
    return None


def _item_raw_box(it: dict[str, Any]) -> tuple[list[float], bool, str | None, str] | None:
    """Return (vals, default_yx, scale, key_name) from the first usable box field on an item."""
    for key, order, sc in (
        ("box_2d", "yx", "1000"),
        ("box_1000", "xy", "1000"),
        ("bbox_1000", "xy", "1000"),
        ("box_norm", "xy", None),
        ("box", "xy", None),
        ("bbox", "xy", None),
        ("bbox_2d", "xy", None),
    ):
        if key in it:
            vals = _extract_four_numbers(it[key])
            if vals is not None:
                return vals, order == "yx", sc, key
    return None


def _box_scale_class(
    found: tuple[list[float], bool, str | None, str],
    *,
    coord_space: str = "",
) -> str:
    """Classify the coordinate convention a raw box uses: "norm" (0-1), "1000" (0-1000) or "px" (canvas pixels)."""
    vals, _yx, scale, key = found
    mx = max(abs(v) for v in vals)
    if coord_space == "abs" and key in ("box", "bbox", "bbox_2d"):
        return "px"
    if scale == "1000":
        return "px" if mx > 1000.0 + 1e-6 else "1000"
    if mx <= 1.0 + 1e-6:
        return "norm"
    if mx <= 1000.0 + 1e-6:
        return "1000"
    return "px"


_BOX_SCALE_LABELS = {"norm": "0–1 归一化", "1000": "0–1000 归一化", "px": "画布像素"}
_BOX_SCALE_ORDER = ("norm", "1000", "px")


def _is_centralized_layout(data: dict[str, Any], width: int = 1024, height: int = 1024) -> bool:
    """Detect whether a layout dict uses MOSS abs_centralized coordinates."""
    cs = str(data.get("bbox_coord_space") or "").strip().lower()
    if cs == "abs_centralized":
        return True
    if cs:
        return False
    items_in = data.get("items") if isinstance(data.get("items"), list) else data.get("objects")
    if not isinstance(items_in, list) or not items_in:
        return False
    vals_all: list[float] = []
    has_neg = False
    for it in items_in:
        if not isinstance(it, dict):
            continue
        found = _item_raw_box(it)
        if not found:
            continue
        vals, _yx, sc, key = found
        if sc == "1000" or key in ("box_2d", "box_1000", "bbox_1000", "box_norm"):
            continue
        for v in vals:
            vals_all.append(v)
            if v < -1.0:
                has_neg = True
    if not has_neg or not vals_all:
        return False
    # Guard against out-of-range test inputs like [-500, -500, 9000, 9000] intended to clamp to 0..W, 0..H.
    return max(abs(v) for v in vals_all) <= (MAX_SIDE // 2)


def infer_canvas_size_from_layout(
    data: dict[str, Any],
    fallback_width: int = 1024,
    fallback_height: int = 1024,
) -> tuple[int, int]:
    """Infer valid MOSS canvas (width, height) from explicit dimensions or centralized coordinates."""
    fw, fh = (
        match_canvas_size(int(fallback_width), int(fallback_height))
        if fallback_width > 0 and fallback_height > 0
        else (1024, 1024)
    )
    if not isinstance(data, dict):
        return fw, fh

    w_raw = data.get("width")
    h_raw = data.get("height")
    if (
        isinstance(w_raw, (int, float))
        and not isinstance(w_raw, bool)
        and isinstance(h_raw, (int, float))
        and not isinstance(h_raw, bool)
        and w_raw > 0
        and h_raw > 0
    ):
        return match_canvas_size(int(round(float(w_raw))), int(round(float(h_raw))))

    if _is_centralized_layout(data, fw, fh):
        cs = str(data.get("bbox_coord_space") or "").strip().lower()
        fmt = str(data.get("bbox_format") or "").strip().lower()
        is_yxyx = (fmt == "yxyx") or (cs == "abs_centralized" and fmt != "xyxy")
        items_in = data.get("items") if isinstance(data.get("items"), list) else (data.get("objects") or [])
        ext_x = 0.0
        ext_y = 0.0
        boxes: list[tuple[float, float, float, float]] = []
        for it in items_in:
            if not isinstance(it, dict):
                continue
            found = _item_raw_box(it)
            if not found:
                continue
            vals, _yx, sc, key = found
            if sc == "1000" or key in ("box_2d", "box_1000", "bbox_1000", "box_norm"):
                continue
            if is_yxyx:
                y1, x1, y2, x2 = vals
            else:
                x1, y1, x2, y2 = vals
            ext_x = max(ext_x, abs(x1), abs(x2))
            ext_y = max(ext_y, abs(y1), abs(y2))
            boxes.append((x1, y1, x2, y2))

        if boxes:
            best_sym: tuple[int, int, int] | None = None
            for x1, y1, x2, y2 in boxes:
                rx1, ry1, rx2, ry2 = round(x1), round(y1), round(x2), round(y2)
                if rx1 != 0 and ry1 != 0 and abs(rx1) == abs(rx2) and abs(ry1) == abs(ry2):
                    cw = abs(rx1) * 2
                    ch = abs(ry1) * 2
                    if (
                        MIN_SIDE <= cw <= MAX_SIDE
                        and MIN_SIDE <= ch <= MAX_SIDE
                        and cw % MULTIPLE == 0
                        and ch % MULTIPLE == 0
                        and cw * ch <= MAX_PIXELS
                        and cw * ch >= 700000
                        and cw >= ext_x * 2 - 1e-6
                        and ch >= ext_y * 2 - 1e-6
                    ):
                        area = cw * ch
                        if best_sym is None or area > best_sym[0]:
                            best_sym = (area, cw, ch)
            if best_sym is not None:
                return best_sym[1], best_sym[2]

            if ext_x > fw / 2.0 + 1e-6 or ext_y > fh / 2.0 + 1e-6:
                est_w = max(MIN_SIDE, int(round(ext_x * 2.0)))
                est_h = max(MIN_SIDE, int(round(ext_y * 2.0)))
                return match_canvas_size(est_w, est_h)

    return fw, fh


def _parse_item_box_norm(
    it: dict[str, Any],
    width: int,
    height: int,
    *,
    centralized: bool = False,
    coord_space: str = "",
    bbox_format: str = "",
) -> tuple[float, float, float, float]:
    """Extract normalized [x1, y1, x2, y2] in 0..1 range supporting centralized, box_2d (yx), box_1000, and abs xyxy."""
    found = _item_raw_box(it)
    key = ""
    if found is None:
        vals = [100.0, 100.0, 900.0, 900.0]
        yx = False
        scale_class = "1000"
    else:
        vals, yx, _scale, key = found
        scale_class = _box_scale_class(found, coord_space=coord_space)

    if centralized and key in ("box", "bbox", "bbox_2d"):
        is_yxyx = (bbox_format == "yxyx") or (coord_space == "abs_centralized" and bbox_format != "xyxy")
        if is_yxyx:
            y1, x1, y2, x2 = vals
        else:
            x1, y1, x2, y2 = vals
        half_w = float(max(width, 1) // 2)
        half_h = float(max(height, 1) // 2)
        x1 = (x1 + half_w) / float(max(width, 1))
        x2 = (x2 + half_w) / float(max(width, 1))
        y1 = (y1 + half_h) / float(max(height, 1))
        y2 = (y2 + half_h) / float(max(height, 1))
        if x2 < x1:
            x1, x2 = x2, x1
        if y2 < y1:
            y1, y2 = y2, y1
        return x1, y1, x2, y2

    if yx:
        vals = [vals[1], vals[0], vals[3], vals[2]]

    x1, y1, x2, y2 = vals
    if scale_class == "norm":
        sx = sy = 1.0
    elif scale_class == "1000":
        sx = sy = 1000.0
    else:
        sx, sy = float(max(width, 1)), float(max(height, 1))

    x1, x2 = x1 / sx, x2 / sx
    y1, y2 = y1 / sy, y2 / sy
    if x2 < x1:
        x1, x2 = x2, x1
    if y2 < y1:
        y1, y2 = y2, y1
    return x1, y1, x2, y2


def _extract_layout_json_text(raw: str) -> dict[str, Any]:
    """Parse a JSON object from a raw layout string (supports fences and surrounding prose)."""
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
    return data


def _build_draft_from_data(
    data: dict[str, Any],
    width: int,
    height: int,
    *,
    max_items: int = MAX_ITEMS,
    allow_empty_summary: bool = False,
) -> dict[str, Any]:
    items_in = data.get("items")
    if not isinstance(items_in, list):
        items_in = data.get("objects") if isinstance(data.get("objects"), list) else None
    if not isinstance(items_in, list):
        top_keys = ", ".join(sorted(str(k) for k in data)) or "(no top-level fields)"
        raise ValueError(f"The model layout must have an items array; it returned: {top_keys}")

    raw_summary = data.get("summary") if isinstance(data.get("summary"), dict) else {}
    caption = raw_summary.get("caption") or data.get("caption") or ""
    if not isinstance(caption, str) or not caption.strip():
        if not allow_empty_summary:
            raise ValueError("The model layout has no summary caption.")
        snippets = [
            str(it.get("caption") or it.get("description") or it.get("text") or "").strip()
            for it in items_in
            if isinstance(it, dict)
        ]
        snippets = [s for s in snippets if s][:3]
        caption = "; ".join(snippets) or "A composed image."

    canvas_val = raw_summary.get("canvas")
    summary_out: dict[str, Any] = {
        "caption": caption.strip(),
        "canvas": canvas_val if canvas_val in ("single", "multi_panel", "collage") else "single",
    }
    for k in ("meta", "palette"):
        cleaned_list = _clean_str_list(raw_summary.get(k))
        if cleaned_list:
            summary_out[k] = cleaned_list

    coord_space = str(data.get("bbox_coord_space") or "").strip().lower()
    bbox_format = str(data.get("bbox_format") or "").strip().lower()
    centralized = _is_centralized_layout(data, width, height)

    issues: list[str] = []
    conventions: dict[str, str] = {}
    items: list[dict[str, Any]] = []
    for index, it in enumerate(items_in):
        if not isinstance(it, dict):
            continue

        raw_label = str(it.get("label") or "").strip().lower()
        cap = str(it.get("caption") or it.get("description") or "").strip()
        if centralized and cap:
            stripped_cap = _DEPTH_TAIL_RE.sub("", cap).strip()
            if stripped_cap:
                cap = stripped_cap
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

        item_name = _infer_name(it, label, index)
        parent_name = str(it.get("parent") or "").strip()

        found = _item_raw_box(it)
        if found is None:
            issues.append(
                f"第 {index + 1} 个区域「{item_name}」没有任何可识别的坐标字段"
                "（支持 box_2d / box_1000 / bbox_1000 / box_norm / box / bbox / bbox_2d），已丢弃该框。"
            )
            continue
        if not centralized:
            # abs_centralized drafts are canvas pixels by definition, so their boxes can never be "mixed".
            conventions.setdefault(_box_scale_class(found, coord_space=coord_space), item_name)

        x1, y1, x2, y2 = _parse_item_box_norm(
            it,
            width,
            height,
            centralized=centralized,
            coord_space=coord_space,
            bbox_format=bbox_format,
        )
        px1 = _clamp_int(x1 * width, 0, width - 2, 0)
        py1 = _clamp_int(y1 * height, 0, height - 2, 0)
        px2 = _clamp_int(x2 * width, px1 + 1, width, width)
        py2 = _clamp_int(y2 * height, py1 + 1, height, height)

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

        for k in ("tags", "palette"):
            cleaned_list = _clean_str_list(it.get(k))
            if cleaned_list:
                item[k] = cleaned_list

        items.append(item)

    if not items:
        detail = f" {' '.join(issues)}" if issues else ""
        raise ValueError(f"The model layout has no usable items.{detail}")

    if len(conventions) > 1:
        used = "、".join(_BOX_SCALE_LABELS[c] for c in _BOX_SCALE_ORDER if c in conventions)
        issues.insert(
            0,
            f"同一次回复里混用了坐标约定（{used}），部分框可能整体错位、大小失真"
            "（例如把 0–1000 的框当成整幅画布）。建议要求模型统一输出 box_1000（0–1000 整数）。",
        )

    limit = max(1, min(MAX_ITEMS, int(max_items or MAX_ITEMS)))
    if len(items) > limit:
        ranked_indices = sorted(
            range(len(items)),
            key=lambda i: _item_importance_score(items[i]),
            reverse=True,
        )[:limit]
        items = [items[i] for i in sorted(ranked_indices)]

    draft: dict[str, Any] = {
        "width": int(width),
        "height": int(height),
        "bbox_coord_space": "abs",
        "bbox_format": "xyxy",
        "summary": summary_out,
        "items": items,
    }
    if issues:
        draft["warnings"] = issues
    return draft


def parse_model_layout(raw: str, width: int, height: int, *, max_items: int = MAX_ITEMS) -> dict[str, Any]:
    """Parse a model's layout JSON, convert normalized or centralized boxes to pixels, and preserve semantic metadata."""
    data = _extract_layout_json_text(raw)
    return _build_draft_from_data(data, width, height, max_items=max_items, allow_empty_summary=False)


def parse_any_layout(
    raw: str,
    width: int = 0,
    height: int = 0,
    *,
    max_items: int = MAX_ITEMS,
    force_size: bool = False,
) -> tuple[dict[str, Any], int, int]:
    """Parse any layout JSON (MOSS abs_centralized yxyx, box_2d, box_1000, norm, abs xyxy) and infer MOSS canvas size."""
    data = _extract_layout_json_text(raw)
    fb_w = int(width) if int(width or 0) > 0 else 1024
    fb_h = int(height) if int(height or 0) > 0 else 1024
    inferred_w, inferred_h = infer_canvas_size_from_layout(data, fb_w, fb_h)
    draft = _build_draft_from_data(
        data,
        inferred_w,
        inferred_h,
        max_items=max_items,
        allow_empty_summary=True,
    )
    if force_size and int(width or 0) > 0 and int(height or 0) > 0:
        tw, th = match_canvas_size(int(width), int(height))
        if (tw, th) != (inferred_w, inferred_h):
            sx = tw / float(max(inferred_w, 1))
            sy = th / float(max(inferred_h, 1))
            for it in draft["items"]:
                bx1, by1, bx2, by2 = it["bbox"]
                nx1 = _clamp_int(bx1 * sx, 0, tw - 2, 0)
                ny1 = _clamp_int(by1 * sy, 0, th - 2, 0)
                nx2 = _clamp_int(bx2 * sx, nx1 + 1, tw, tw)
                ny2 = _clamp_int(by2 * sy, ny1 + 1, th, th)
                it["bbox"] = [nx1, ny1, nx2, ny2]
            draft["width"] = tw
            draft["height"] = th
            return draft, tw, th
    return draft, inferred_w, inferred_h


def _extract_balanced_json_object(text: str, start_brace: int) -> dict[str, Any] | None:
    """Parse a single balanced JSON object starting at ``start_brace``, or return None."""
    if start_brace < 0 or start_brace >= len(text) or text[start_brace] != "{":
        return None
    depth = 0
    in_str = False
    escape = False
    for i in range(start_brace, len(text)):
        ch = text[i]
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    parsed = json.loads(text[start_brace : i + 1])
                    return parsed if isinstance(parsed, dict) else None
                except ValueError:
                    return None
    return None


def recover_partial_layout(
    raw: str,
    width: int,
    height: int,
    *,
    max_items: int = MAX_ITEMS,
    fallback_caption: str = "",
) -> dict[str, Any] | None:
    """Salvage completed regions from truncated layout JSON (e.g. length/content_filter cutoff)."""
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        return parse_model_layout(raw, width, height, max_items=max_items)
    except ValueError:
        pass

    text = raw.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*```$", "", text).strip()
    first_brace = text.find("{")
    if first_brace < 0:
        return None
    text = text[first_brace:]

    items_match = re.search(r'"items"\s*:\s*\[', text)
    if not items_match:
        return None

    summary_obj: dict[str, Any] | None = None
    summary_match = re.search(r'"summary"\s*:\s*\{', text[: items_match.start()])
    if summary_match:
        summary_obj = _extract_balanced_json_object(text, summary_match.end() - 1)
    if not isinstance(summary_obj, dict):
        summary_cap = ""
        cap_match = re.search(r'"caption"\s*:\s*"((?:[^"\\]|\\.)*)"', text[: items_match.start()])
        if cap_match:
            try:
                summary_cap = json.loads(f'"{cap_match.group(1)}"')
            except ValueError:
                summary_cap = cap_match.group(1)
        summary_cap = str(summary_cap or fallback_caption or "A composed image.").strip() or "A composed image."
        summary_obj = {"caption": summary_cap, "canvas": "single"}
    elif not str(summary_obj.get("caption") or "").strip():
        summary_obj = {**summary_obj, "caption": (fallback_caption or "A composed image.").strip() or "A composed image."}

    recovered_items: list[dict[str, Any]] = []
    depth = 0
    in_str = False
    escape = False
    obj_start: int | None = None
    for i in range(items_match.end(), len(text)):
        ch = text[i]
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            if depth == 0:
                obj_start = i
            depth += 1
        elif ch == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and obj_start is not None:
                    try:
                        parsed_item = json.loads(text[obj_start : i + 1])
                        if isinstance(parsed_item, dict):
                            recovered_items.append(parsed_item)
                    except ValueError:
                        pass
                    obj_start = None
        elif ch == "]" and depth == 0:
            break

    if not recovered_items:
        return None

    rebuilt = json.dumps({"summary": summary_obj, "items": recovered_items}, ensure_ascii=False)
    try:
        return parse_model_layout(rebuilt, width, height, max_items=max_items)
    except ValueError:
        return None


# ---------- 遮挡关系短语（Depth / Occlusion Phrases）与官方编译器 ----------

def _short_ref(it: dict[str, Any], zh: bool) -> str:
    """生成「在 X 前面 / Behind X」里的 X。优先图层中文短名 name。"""
    name = str(it.get("name") or "").strip()
    if not name and it.get("label") == "text" and str(it.get("text") or "").strip():
        t = str(it["text"]).strip().splitlines()[0][:24]
        return f"文字「{t}」" if zh else f'the text "{t}"'
    src = name or str(it.get("caption") or "").strip()
    src = re.split(r"[，。,.;；:：!?！？\n]", src, maxsplit=1)[0].strip() or src.strip()
    if zh or _is_cjk(src):
        return f"「{src[:16]}」"
    words = src.split()
    if words and words[0].lower() in ("a", "an", "the"):
        words = words[1:]
    ref = " ".join(words[:6]) or "object"
    if not name:
        ref = ref[0].lower() + ref[1:] if len(ref) > 1 and not ref[:2].isupper() else ref
        return f"the {ref}"
    return f"the {ref}" if ref[:1].islower() else ref


def _area(b: list[int | float]) -> float:
    return max(0.0, float(b[2]) - float(b[0])) * max(0.0, float(b[3]) - float(b[1]))


def _inter(a: list[int | float], b: list[int | float]) -> float:
    w = min(float(a[2]), float(b[2])) - max(float(a[0]), float(b[0]))
    h = min(float(a[3]), float(b[3])) - max(float(a[1]), float(b[1]))
    return w * h if w > 0 and h > 0 else 0.0


def depth_phrases(items: list[dict[str, Any]]) -> list[str]:
    """根据图层顺序（数组越靠后越靠前/离镜头越近）+ 框重叠，为每个框生成前后遮挡关系短语。"""
    out: list[str] = []
    n = len(items)
    for i, it in enumerate(items):
        cap_raw = str(it.get("caption") or "")
        zh = _is_cjk(cap_raw)
        parts: list[str] = []
        if it.get("label") != "text":
            a = it.get("bbox") or [0, 0, 0, 0]
            fronts: list[tuple[float, str]] = []
            behinds: list[tuple[float, str]] = []
            for j in range(n):
                if j == i or items[j].get("label") == "text":
                    continue
                b = items[j].get("bbox") or [0, 0, 0, 0]
                inter = _inter(a, b)
                if inter <= 0:
                    continue
                small = min(_area(a), _area(b)) or 1.0
                if inter / small < 0.05:
                    continue
                ref = _short_ref(items[j], zh)
                if j < i:  # j 在 i 后面（背景侧）→ i 在 j 前方
                    covers_all = inter / (_area(b) or 1.0) >= 0.95
                    if zh:
                        txt = f"在{ref}前方" + ("" if covers_all else "，部分遮挡它")
                    else:
                        txt = f"in front of {ref}" + ("" if covers_all else ", partially occluding it")
                    fronts.append((inter, txt))
                else:  # j 在 i 前面（前景侧）→ i 在 j 后方
                    inside = inter / (_area(a) or 1.0) >= 0.95
                    if zh:
                        txt = f"在{ref}后方" + ("" if inside else "，被它部分遮挡")
                    else:
                        txt = f"behind {ref}" + ("" if inside else ", partly hidden by it")
                    behinds.append((inter, txt))
            fronts.sort(key=lambda x: -x[0])
            behinds.sort(key=lambda x: -x[0])
            parts += [t for _, t in fronts[:2]] + [t for _, t in behinds[:2]]
        if not parts:
            out.append("")
            continue
        sep = "；" if zh else "; "
        body = sep.join(parts)
        if zh:
            out.append(body + "。")
        else:
            out.append(body[0].upper() + body[1:] + ".")
    return out


def _append_sentence(base: str, extra: str) -> str:
    base = _DEPTH_TAIL_RE.sub("", (base or "").rstrip()).rstrip()
    if not extra:
        return base
    zh = _is_cjk(base)
    if base and base[-1] not in ".。!！?？;；":
        base += "。" if zh else "."
    if not base:
        return extra
    return f"{base}{extra}" if zh and base[-1] in "。！？；" else f"{base} {extra}"


def _centered_yxyx_box(box: list[int | float], width: int, height: int) -> list[int]:
    """Convert top-left abs xyxy [x1, y1, x2, y2] to MOSS official abs_centralized yxyx."""
    x1, y1, x2, y2 = (float(v) for v in box[:4])
    if x2 < x1:
        x1, x2 = x2, x1
    if y2 < y1:
        y1, y2 = y2, y1
    x1 = max(0.0, min(x1, float(width - 2)))
    y1 = max(0.0, min(y1, float(height - 2)))
    x2 = max(x1 + 1.0, min(x2, float(width)))
    y2 = max(y1 + 1.0, min(y2, float(height)))
    cy1 = math.floor(round(y1, 9)) - height // 2
    cx1 = math.floor(round(x1, 9)) - width // 2
    cy2 = math.ceil(round(y2, 9)) - height // 2
    cx2 = math.ceil(round(x2, 9)) - width // 2
    if cy2 <= cy1:
        cy2 = cy1 + 1
    if cx2 <= cx1:
        cx2 = cx1 + 1
    return [cy1, cx1, cy2, cx2]


def compile_layout_dict(draft: dict[str, Any], *, include_depth: bool = True) -> dict[str, Any]:
    """Compile an internal abs/xyxy layout draft into MOSS-Image official abs_centralized/yxyx schema."""
    if not isinstance(draft, dict):
        raise ValueError("Draft must be a JSON object")
    # If already compiled in abs_centralized + yxyx, return a clean copy
    if draft.get("bbox_coord_space") == "abs_centralized" and draft.get("bbox_format") == "yxyx":
        return {
            "summary": copy.deepcopy(draft.get("summary") or {"caption": "A composed image.", "canvas": "single"}),
            "items": copy.deepcopy(draft.get("items") or []),
            "bbox_coord_space": "abs_centralized",
            "bbox_format": "yxyx",
        }

    w = max(16, (_clamp_int(draft.get("width"), 256, 2048, 1024) // 16) * 16)
    h = max(16, (_clamp_int(draft.get("height"), 256, 2048, 1024) // 16) * 16)

    raw_sum = draft.get("summary") if isinstance(draft.get("summary"), dict) else {}
    cap = str(raw_sum.get("caption") or draft.get("caption") or "A composed image.").strip() or "A composed image."
    summary: dict[str, Any] = {
        "caption": cap,
        "canvas": raw_sum.get("canvas") if raw_sum.get("canvas") in ("single", "multi_panel", "collage") else "single",
    }
    for k in ("meta", "palette"):
        c = _clean_str_list(raw_sum.get(k))
        if c:
            summary[k] = c

    raw_items = [it for it in (draft.get("items") or []) if isinstance(it, dict) and not it.get("hidden")]
    if not raw_items:
        raw_items = [{
            "label": "object",
            "caption": cap,
            "bbox": [w // 8, h // 8, w * 7 // 8, h * 7 // 8],
        }]

    is_already_centralized_yxyx = (
        draft.get("bbox_coord_space") == "abs_centralized"
        and draft.get("bbox_format") == "yxyx"
    )
    phrases = (
        depth_phrases(raw_items)
        if (include_depth and not is_already_centralized_yxyx)
        else [""] * len(raw_items)
    )
    compiled_items: list[dict[str, Any]] = []
    for it, ph in zip(raw_items, phrases):
        lbl = it.get("label") if it.get("label") in _LABELS else "object"
        item_cap = str(it.get("caption") or "").strip() or "Region"
        if ph:
            item_cap = _append_sentence(item_cap, ph)
        bbox_raw = it.get("bbox")
        if not (isinstance(bbox_raw, list) and len(bbox_raw) == 4):
            bbox_raw = [w // 8, h // 8, w * 7 // 8, h * 7 // 8]
        if is_already_centralized_yxyx:
            c_box = [_clamp_int(v, -MAX_SIDE, MAX_SIDE, 0) for v in bbox_raw]
        else:
            c_box = _centered_yxyx_box(bbox_raw, w, h)

        out_it: dict[str, Any] = {
            "label": lbl,
            "caption": item_cap,
        }
        if lbl == "text":
            t = str(it.get("text") or item_cap).strip()
            out_it["text"] = t
        elif isinstance(it.get("text"), str) and it["text"].strip():
            out_it["text"] = it["text"].strip()
        for k in ("tags", "palette"):
            c = _clean_str_list(it.get(k))
            if c:
                out_it[k] = c
        out_it["bbox"] = c_box
        compiled_items.append(out_it)

    return {
        "summary": summary,
        "items": compiled_items,
        "bbox_coord_space": "abs_centralized",
        "bbox_format": "yxyx",
    }


def compile_layout_prompt(draft: dict[str, Any], *, include_depth: bool = True) -> str:
    """Serialize compiled official MOSS-Image layout JSON string."""
    compiled = compile_layout_dict(draft, include_depth=include_depth)
    return json.dumps(compiled, ensure_ascii=False, separators=(",", ":"))


CAPTION_HINT_BLOCK = """
散文参考（同一张图先单独做了一次 Caption 反推；它对动作、姿态、人物交互和服装层次的理解比直接框更准）：
\"\"\"
{caption}
\"\"\"
- 动作 / 姿态 / 朝向 / 谁在跟谁互动，沿用上面散文的理解与方位（viewer's left / right），不要自己另起一套。
- 每个 item 的 caption 仍然只写这个元素**在图上真实可见**的内容，别把散文里别处的描述搬过来。
- 散文没提到、框里却看得见的细节照常写；散文与图上明显不一致时，以图上看到的为准。
- summary.caption 用 1–2 句凝练、客观、简洁的英文概括整体构图与视觉焦点（约 25–60 词，适度中性化措辞；完整细节已保留在散文通道）。
- 坐标只能来自图上看到的位置：不要因为散文提到某物就补一个框。
"""


GRID_HINT = """
定位刻度（这张参考图上已经叠了刻度网格，网格旁边黄色的数字就是 0–1000 的坐标值）：
- 每个框的四个坐标就是这些刻度值，看元素离哪条线近、跨了哪几条线，直接读数字填进去。
- 网格只是刻度尺，不是画面内容：不要在 caption 里描述网格，也不要为网格线或数字建框。
"""


VISION_MAX_SIDE = 1280


def shrink_data_url(data_url: str, max_side: int = VISION_MAX_SIDE, quality: int = 85) -> str:
    """把送给模型的图缩到长边 max_side 并转 JPEG。

    原图 4000 像素也照样发给模型时，光是视觉 token 就把请求撑得又大又慢；缩小后
    画面内容不变、坐标仍按原图换算（模型给的本来就是 0–1000 归一化）。
    """
    try:
        from PIL import Image
    except Exception:
        return data_url
    prefix = "data:image/"
    idx = data_url.find(";base64,")
    if not data_url.startswith(prefix) or idx < 0:
        return data_url
    try:
        raw = base64.b64decode(data_url[idx + len(";base64,"):])
        im = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception:
        return data_url
    w, h = im.size
    long_side = max(w, h)
    if long_side <= max_side:
        return data_url
    scale = max_side / long_side
    im = im.resize((max(1, round(w * scale)), max(1, round(h * scale)),), Image.LANCZOS)
    out = io.BytesIO()
    im.save(out, format="JPEG", quality=quality, optimize=True)
    return "data:image/jpeg;base64," + base64.b64encode(out.getvalue()).decode("ascii")


def grid_overlay_data_url(data_url: str, cols: int = 6, rows: int = 6) -> str:
    """给送模型的图临时叠一层带像素刻度的网格（不保存、不回写原图）。

    模型对"看图猜坐标"很不稳，尤其画面边缘的小物件；叠上刻度后它可以照着线读数。
    解析失败或没有 PIL 时原样返回，绝不让这一步打断反推。
    """
    try:
        from PIL import Image, ImageDraw  # 延迟导入：纯文本环境不一定有 PIL
    except Exception:
        return data_url
    prefix = "data:image/"
    idx = data_url.find(";base64,")
    if not data_url.startswith(prefix) or idx < 0:
        return data_url
    mime = data_url[len("data:"): idx]
    try:
        raw = base64.b64decode(data_url[idx + len(";base64,"):])
        im = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception:
        return data_url
    w, h = im.size
    if w < 64 or h < 64:
        return data_url
    # 叠了网格的图是额外一次上行；大图先缩到 1280 长边再存 JPEG，避免把反推拖成几百秒。
    long_side = max(w, h)
    if long_side > VISION_MAX_SIDE:
        scale = 1280 / long_side
        im = im.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
        w, h = im.size
    draw = ImageDraw.Draw(im, "RGBA")
    line = (60, 220, 255, 150)
    text_bg = (0, 0, 0, 190)
    for i in range(1, cols):
        x = round(w * i / cols)
        draw.line([(x, 0), (x, h)], fill=line, width=2)
    for j in range(1, rows):
        y = round(h * j / rows)
        draw.line([(0, y), (w, y)], fill=line, width=2)
    step_x, step_y = w / cols, h / rows
    for i in range(1, cols):
        x = round(w * i / cols)
        draw.rectangle([x + 2, 2, x + 2 + 9 * len(str(x)), 16], fill=text_bg)
        draw.text((x + 4, 3), str(x), fill=(255, 255, 255, 255))
    for j in range(1, rows):
        y = round(h * j / rows)
        draw.rectangle([2, y + 1, 2 + 9 * len(str(y)), y + 15], fill=text_bg)
        draw.text((4, y + 2), str(y), fill=(255, 255, 255, 255))
    # 刻度标的是 0–1000 归一化值（和 box_1000 同一把尺），不标像素：
    # 否则模型要自己把像素换算成 0–1000，白烧一大段思考还容易错位。
    for i in range(1, cols):
        x = round(w * i / cols)
        label = str(round(1000 * i / cols))
        draw.text((x + 4, 17), label, fill=(255, 255, 0, 255))
    for j in range(1, rows):
        y = round(h * j / rows)
        label = str(round(1000 * j / rows))
        draw.text((4, y + 17), label, fill=(255, 255, 0, 255))
    draw.text((4, h - 16), f"grid {cols}x{rows}  scale 0-1000 (x right, y down)",
              fill=(255, 255, 255, 255))
    out = io.BytesIO()
    im.save(out, format="JPEG", quality=82, optimize=True)
    return "data:image/jpeg;base64," + base64.b64encode(out.getvalue()).decode("ascii")


def layout_instruction(
    mode: str,
    width: int,
    height: int,
    extra: str = "",
    *,
    max_regions: int = 6,
    model: str = "",
    caption_hint: str = "",
) -> str:
    """Build the model instruction for MOSS-Image layout reverse-engineering.
    
    Exactly matches the clean, proven architecture of moss-prompt-studio's reverse_rules.
    """
    region_limit = max(1, min(16, int(max_regions or 10)))
    fmt = box_format_for(model)
    if fmt == "box_2d":
        coord = (
            '"box_2d": [ymin, xmin, ymax, xmax]，四个整数，按原图归一化到 0–1000'
            '（左上角 0,0，右下角 1000,1000；先 y 后 x）'
        )
        example = '"box_2d":[120,300,950,640]'
    else:
        coord = (
            '"box_1000": [x_min, y_min, x_max, y_max]，四个整数，按原图归一化到 0–1000'
            '（左上角 0,0，右下角 1000,1000）'
        )
        example = '"box_1000":[300,120,640,950]'

    hint = ""
    if caption_hint.strip():
        hint = CAPTION_HINT_BLOCK.format(caption=caption_hint.strip()).strip() + "\n\n"

    prompt = f"""===== 本次任务：看图反推 + 定位框 =====
以下规则针对这张参考图，**优先级高于其他规定**。

定位框（最重要）：
- 每个 item 用 {coord}。
- 框要紧贴该元素在图中**真实可见**的范围：人物包含头发、四肢、手持物和衣摆；不要把阴影、背景算进去。
- 不要输出画布像素坐标的 bbox，坐标换算由程序完成。
{GRID_HINT}

框哪些东西：
- 只框图里真实看得见的东西，不要编造。每个主要人物单独一个框（label:"character"）；重要物体 / 动物 / 载具 / 建筑 / 服饰用 "object"；看得清的文字（标题、招牌、logo 字样）用 "text"，原文写进 text 字段。
- 天空、远景、墙面等大面积背景如果对画面重要，可以给一个覆盖它的 object 框。
- 一般 3–{region_limit} 个框，按从远到近（背景在前、前景在后）排列。
- 每个 item 加 "name"：2–6 个字的中文短名（如 "女孩"、"大衣"、"背包"、"招牌"），用于界面显示与遮挡引用。

{hint}描述要求（Detail level: LONG）：
- 为每个 item.caption 编写具体、客观的英文视觉描述（涵盖外观、材质质感、版型层次、光影氛围）；summary.caption 保持凝练流畅。
- summary 额外包含 "canvas":"single", "meta":["outdoors","portrait"...], "palette":["sage green","cream white"...]。
- 不要使用 markdown 代码块包裹，直接输出合法 JSON；字符串值内若需引号请改用单引号，避免未转义半角双引号导致 JSON 解析失败。

只输出一个 JSON 对象，不要 Markdown：
{{"summary":{{"caption":"...","canvas":"single","meta":["..."],"palette":["..."]}},
 "items":[{{"label":"object","name":"背景建筑","caption":"...",{example}}},
          {{"label":"character","name":"女孩","caption":"...",{example}}}]}}"""

    if extra.strip():
        prompt += f"\n\n附加要求：{extra.strip()}"
    return prompt


def draft_json(draft: dict[str, Any]) -> str:
    return json.dumps(draft, ensure_ascii=False, separators=(",", ":"))


__all__ = [
    "MAX_ITEMS",
    "MAX_PIXELS",
    "MAX_SIDE",
    "MIN_SIDE",
    "MULTIPLE",
    "TARGET_PIXELS",
    "box_format_for",
    "compile_layout_dict",
    "compile_layout_prompt",
    "depth_phrases",
    "draft_json",
    "infer_canvas_size_from_layout",
    "layout_instruction",
    "match_canvas_size",
    "parse_any_layout",
    "parse_model_layout",
    "recover_partial_layout",
]
