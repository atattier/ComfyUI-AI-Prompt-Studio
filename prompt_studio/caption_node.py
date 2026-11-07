"""ComfyUI node: AI image reverse-engineering as part of the graph.

Supports selecting 1 to 3 modes (caption / layout / hybrid) simultaneously and
outputs three STRING prompt ports (``caption_prompt``, ``layout_prompt``,
``hybrid_prompt``) plus MOSS-compatible ``width``/``height`` INT outputs.
The frontend's 「反推」button posts to ``/ai_prompt_studio/caption_node`` and
stores the result in the node's ``payload`` widget, which is serialized with
the workflow. Execution normally reads that payload, so re-running an unchanged
workflow never repeats a model call. If a freshly created node is queued before
the button was clicked—or if the user switches/enables a layout mode whose
draft is not yet in ``payload``—execution automatically generates the missing
data from the graph's IMAGE input and sends the updated payload back to the
browser for persistence.
"""

from __future__ import annotations

import base64
import copy
import json
import re
import struct
import zlib
from pathlib import Path
from typing import Any, Callable, Sequence

from .caption import SAFETY_PREFIX, _INSTRUCTIONS, _clean
from .config import build_rule_suffix, load_settings
from .errors import StudioError
from .images import to_api_part
from .layout import layout_instruction, match_canvas_size, parse_model_layout
from .sessions import MediaStore

MODES = ("caption", "layout", "danbooru", "hybrid")

DEFAULT_PROSE_NEGATIVE = (
    "ugly, deformed, noisy, blurry, distorted, grainy, extra limbs, "
    "poorly drawn hands, poorly drawn face, bad proportions, watermark, signature"
)
DEFAULT_DANBOORU_NEGATIVE = (
    "lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, "
    "fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, "
    "signature, watermark, username, blurry, artist name"
)

_MAX_MEDIA_BYTES = 8 * 1024 * 1024
_MIME_BY_EXT = {
    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
    "webp": "image/webp", "gif": "image/gif",
}
_LEGACY_WIDGET_GARBAGE = {
    "null", "none", "undefined", "randomize", "fixed", "increment", "decrement", "true", "false",
}


def clean_widget_str(value: Any, *, is_path: bool = False) -> str:
    """Clean widget strings that may have been shifted by legacy workflow serialization."""
    text = str(value or "").strip()
    if not text:
        return ""
    if text.lower() in _LEGACY_WIDGET_GARBAGE:
        return ""
    if is_path and text.isdigit():
        return ""
    return text


def _tensor_to_png(image: Any) -> bytes | None:
    """Encode a ComfyUI IMAGE tensor (NHWC float 0-1) as an 8-bit RGB PNG.

    Returns None when ``image`` does not look like a tensor.  Only used when
    the node is executed directly with an IMAGE input (e.g. from a script);
    the browser route uses the byte-based path instead.
    """
    shape = getattr(image, "shape", None)
    if shape is None or len(shape) != 4 or shape[-1] not in (1, 3, 4):
        return None
    import numpy as np  # numpy ships with ComfyUI

    frame = np.asarray(image[0])
    if frame.ndim != 3:
        return None
    channels = frame.shape[-1]
    if channels == 1:
        frame = np.repeat(frame, 3, axis=-1)
    elif channels == 4:
        frame = frame[..., :3]
    frame = (frame * 255.0).round().clip(0, 255).astype("uint8")
    height, width = frame.shape[:2]
    rows = bytearray()
    for row in frame:
        rows.append(0)  # filter type: none
        rows.extend(row.tobytes())

    def chunk(tag: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(rows), 6))
        + chunk(b"IEND", b"")
    )


def image_dimensions(data: bytes) -> tuple[int, int]:
    """Read pixel dimensions from PNG/JPEG/GIF/WebP headers, stdlib only."""
    if not data:
        raise ValueError("empty image data")
    if data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) >= 24:
        w, h = struct.unpack(">II", data[16:24])
        return int(w), int(h)
    if data[:2] == b"\xff\xd8":
        pos = 2
        while pos + 9 < len(data):
            if data[pos] != 0xFF:
                pos += 1
                continue
            marker = data[pos + 1]
            pos += 2
            if marker in (0xD8, 0xD9, 0x01) or 0xD0 <= marker <= 0xD7:
                continue
            if pos + 2 > len(data):
                break
            (length,) = struct.unpack(">H", data[pos:pos + 2])
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                          0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                h, w = struct.unpack(">HH", data[pos + 3:pos + 7])
                return int(w), int(h)
            pos += length
        raise ValueError("cannot read JPEG dimensions")
    if data[:6] in (b"GIF87a", b"GIF89a") and len(data) >= 10:
        w, h = struct.unpack("<HH", data[6:10])
        return int(w), int(h)
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        kind = data[12:16]
        if kind == b"VP8X" and len(data) >= 30:
            w = int.from_bytes(data[24:27], "little") + 1
            h = int.from_bytes(data[27:30], "little") + 1
            return w, h
        if kind == b"VP8 " and len(data) >= 30:
            w, h = struct.unpack("<HH", data[26:30])
            return w & 0x3FFF, h & 0x3FFF
        if kind == b"VP8L" and len(data) >= 25:
            bits = int.from_bytes(data[21:25], "little")
            return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    raise ValueError("unsupported image format; use PNG/JPEG/GIF/WebP")


def _image_source_part(media: MediaStore, image: Any, image_path: str) -> tuple[dict[str, Any], bytes]:
    """Turn the node's inputs into (stored image part, raw bytes)."""
    png = _tensor_to_png(image)
    if png is not None:
        if len(png) > media.max_bytes:
            raise ValueError(
                f"image too large after encoding ({len(png)} bytes > {media.max_bytes}); "
                "downscale it before captioning"
            )
        return media.put(png, "image/png"), png
    source = str(image_path or "").strip()
    if not source:
        raise ValueError("connect an IMAGE input or set image_path.")
    if source.lower().startswith(("http://", "https://")):
        raise ValueError("image_path must be a local file; use the image input for URLs.")
    path = Path(source)
    if not path.is_file():
        raise ValueError(f"image_path is not a file: {source}")
    data = path.read_bytes()
    if len(data) > _MAX_MEDIA_BYTES:
        raise ValueError(f"image_path file exceeds {_MAX_MEDIA_BYTES} bytes; downscale it first")
    ext = path.suffix.lower().lstrip(".")
    mime = _MIME_BY_EXT.get(ext)
    if mime is None:
        raise ValueError(f"unsupported image type: .{ext}")
    return media.put(data, mime), data


def _default_model_call(*, instruction: str, image_part: dict[str, Any],
                        model: str, max_tokens: int) -> str:
    """Use the same OpenAI-compatible client and credentials as the HTTP route."""
    import comfyui_plugin

    backend = comfyui_plugin.get_backend()
    if backend is None:
        raise ValueError(
            "模型后端未配置。请在 ComfyUI 的 Python 里运行 "
            "python -m prompt_studio.credentials set，配置 Base URL / Model / API Key 后重启 ComfyUI。"
        )
    messages = [{"role": "user", "content": [
        {"type": "text", "text": instruction}, image_part,
    ]}]
    result = backend.client.complete_via_stream(
        messages, model=model, temperature=0.3, max_tokens=max_tokens
    )
    return result.text


def _concise_summary(text: str) -> str:
    """Extract a concise 1-sentence summary for layout mode from a longer description."""
    cleaned = " ".join(str(text or "").strip().split())
    if not cleaned:
        return "A composed image."
    for sep in (". ", "。", "！", "!", "; "):
        idx = cleaned.find(sep)
        if 12 <= idx <= 200:
            return cleaned[: idx + 1].strip()
    if len(cleaned) > 200:
        return cleaned[:197].rstrip() + "..."
    return cleaned


def _fallback_draft(caption: str, width: int, height: int) -> dict[str, Any]:
    """Build a valid single-region PromptBoard draft when only caption text is present."""
    w = max(256, int(width or 1024))
    h = max(256, int(height or 1024))
    summary = str(caption or "").strip() or "A composed image."
    return {
        "width": w,
        "height": h,
        "bbox_coord_space": "abs",
        "bbox_format": "xyxy",
        "summary": {"caption": summary, "canvas": "single"},
        "items": [
            {
                "label": "object",
                "caption": _concise_summary(summary),
                "bbox": [0, 0, w, h],
            }
        ],
    }


def _normalize_state_payload(raw_state: dict[str, Any]) -> dict[str, Any]:
    """Normalize both backend state payloads and frontend v1 schema payloads."""
    state = dict(raw_state)
    size = state.get("size")
    if (not state.get("width") or not state.get("height")) and isinstance(size, (list, tuple)) and len(size) == 2:
        try:
            state["width"] = int(size[0])
            state["height"] = int(size[1])
        except (TypeError, ValueError):
            pass

    width = int(state.get("width") or 0)
    height = int(state.get("height") or 0)

    if not state.get("caption") and isinstance(state.get("summary"), dict):
        summary_cap = str(state["summary"].get("caption") or "").strip()
        if summary_cap:
            state["caption"] = summary_cap

    draft = state.get("draft")
    regions = state.get("regions")
    if (not isinstance(draft, dict) or not draft.get("items")) and isinstance(regions, list) and regions and width > 0 and height > 0:
        summary_text = str(state.get("caption") or "").strip() or "A composed image."
        raw_draft = {
            "width": width,
            "height": height,
            "bbox_coord_space": "abs",
            "bbox_format": "xyxy",
            "summary": {"caption": summary_text, "canvas": "single"},
            "items": regions,
        }
        try:
            state["draft"] = parse_model_layout(json.dumps(raw_draft), width, height)
        except ValueError:
            pass
    return state


def _has_caption(state: dict[str, Any]) -> bool:
    cap = state.get("caption_text") or state.get("caption")
    if isinstance(cap, str) and cap.strip():
        return True
    draft = state.get("draft")
    if isinstance(draft, dict) and isinstance(draft.get("summary"), dict):
        return bool(str(draft["summary"].get("caption") or "").strip())
    return False


def _has_draft(state: dict[str, Any]) -> bool:
    draft = state.get("draft")
    return isinstance(draft, dict) and isinstance(draft.get("items"), list) and len(draft["items"]) > 0


def normalize_modes(
    mode: str,
    modes: Sequence[str] | None = None,
    *,
    enable_caption: bool | None = None,
    enable_layout: bool | None = None,
    enable_danbooru: bool | None = None,
    enable_hybrid: bool | None = None,
) -> list[str]:
    """Return a deduplicated list of 1-3 active modes in canonical order."""
    if mode not in MODES:
        raise ValueError(f"unknown mode: {mode}")
    selected: list[str] = []
    if modes is not None:
        if not isinstance(modes, (list, tuple)) or not modes:
            raise ValueError("modes must be a non-empty list")
        for m in modes:
            m_str = str(m or "").strip()
            if m_str not in MODES:
                raise ValueError(f"unknown mode: {m_str}")
            if m_str not in selected:
                selected.append(m_str)
    elif any(v is not None for v in (enable_caption, enable_layout, enable_danbooru, enable_hybrid)):
        if enable_caption:
            selected.append("caption")
        if enable_layout:
            selected.append("layout")
        if enable_danbooru:
            selected.append("danbooru")
        if enable_hybrid:
            selected.append("hybrid" if "hybrid" not in selected else "danbooru")
        if mode not in selected:
            selected.append(mode)
    else:
        selected.append(mode)

    if not selected:
        selected.append(mode)
    return selected


def _generate_state(*, mode: str, raw: bytes, mime: str,
                    extra_instruction: str, model: str,
                    call_model: Callable[..., str] | None,
                    modes: Sequence[str] | None = None,
                    existing_state: dict[str, Any] | None = None) -> dict[str, Any]:
    """Caption graph-owned image bytes and build a serializable payload for 1-3 modes."""
    active_modes = normalize_modes(mode, modes)
    src_w, src_h = image_dimensions(raw)
    width, height = match_canvas_size(src_w, src_h)
    settings = load_settings()
    extra_clean = clean_widget_str(extra_instruction)
    model_clean = clean_widget_str(model)
    resolved_model = model_clean or settings.model
    media = MediaStore(settings.media_dir, max_bytes=settings.max_image_bytes)
    part = to_api_part(media, media.put(raw, mime))
    if part.get("type") == "image_ref":
        part = {"type": "image_url", "image_url": {
            "url": "data:%s;base64,%s" % (mime, base64.b64encode(raw).decode("ascii"))
        }}
    if call_model is None:
        call_model = _default_model_call

    state: dict[str, Any] = dict(existing_state or {})
    state.update({
        "mode": mode,
        "modes": active_modes,
        "width": width,
        "height": height,
        "source_width": src_w,
        "source_height": src_h,
    })

    def _invoke(instr: str, max_tok: int) -> str:
        try:
            return call_model(
                instruction=instr, image_part=part,
                model=resolved_model, max_tokens=max_tok,
            )
        except StudioError as exc:
            raise ValueError(
                "反推超时或上游暂时不可用：请检查 Magpie / Base URL / 模型名，"
                "在节点「⚙ 设置」中调整模型或超时设置后重试；也可以先点「反推」单独生成结果再排队。"
            ) from exc
        except (TimeoutError, OSError) as exc:
            raise ValueError("反推网络超时；请检查 Magpie 是否可用后重试。") from exc

    need_caption_call = ("caption" in active_modes) and not (
        isinstance(state.get("caption_text"), str) and state["caption_text"].strip()
    )
    need_layout_call = bool({"layout", "hybrid"} & set(active_modes)) and not _has_draft(state)
    need_danbooru_call = ("danbooru" in active_modes) and not (
        isinstance(state.get("danbooru_prompt"), str) and state["danbooru_prompt"].strip()
    )

    if need_caption_call:
        base_fmt = "tags" if settings.rule_preset == "tags" else "prose"
        cap_instr = SAFETY_PREFIX + _INSTRUCTIONS[base_fmt] + build_rule_suffix(settings, extra_clean)
        raw_cap = _invoke(cap_instr, 500)
        caption = _clean(str(raw_cap or ""), base_fmt)
        if not caption:
            raise ValueError("The model returned an empty caption.")
        state["caption"] = caption
        state["caption_text"] = caption

    if need_layout_call:
        layout_target_mode = "hybrid" if "hybrid" in active_modes else "layout"
        lay_extra = build_rule_suffix(settings, extra_clean, for_json_layout=True).strip()
        lay_instr = SAFETY_PREFIX + layout_instruction(
            layout_target_mode, width, height, lay_extra, max_regions=settings.max_regions
        )
        raw_lay = _invoke(lay_instr, 3000)
        try:
            draft = parse_model_layout(
                str(raw_lay or ""), width, height, max_items=settings.max_regions
            )
        except ValueError as exc:
            raise ValueError(
                f"布局反推失败（模型输出不是完整 JSON）：{exc}。请重试或换模型。"
            ) from exc

        full_caption = str(state.get("caption_text") or draft["summary"]["caption"]).strip()
        short_caption = (
            str(draft["summary"]["caption"]).strip()
            if layout_target_mode == "layout"
            else _concise_summary(draft["summary"]["caption"])
        )
        layout_draft = copy.deepcopy(draft)
        layout_draft["summary"]["caption"] = short_caption or full_caption
        hybrid_draft = copy.deepcopy(draft)
        hybrid_draft["summary"]["caption"] = full_caption or short_caption

        state["layout_draft"] = layout_draft
        state["hybrid_draft"] = hybrid_draft
        state["draft"] = hybrid_draft if mode in ("hybrid", "danbooru") else (layout_draft if mode == "layout" else hybrid_draft)
        if not state.get("caption"):
            state["caption"] = str(state["draft"]["summary"]["caption"])

    if need_danbooru_call:
        dan_instr = SAFETY_PREFIX + _INSTRUCTIONS["danbooru"] + build_rule_suffix(settings, extra_clean)
        raw_dan = _invoke(dan_instr, 600)
        dan_text = _clean(str(raw_dan or ""), "danbooru")
        state["danbooru_prompt"] = dan_text
        state["danbooru_text"] = dan_text
        state["tags"] = dan_text

    return state


def build_prompt_outputs(
    state: dict[str, Any],
    *,
    mode: str,
    width: int,
    height: int,
    synthesize_missing_draft: bool = False,
) -> tuple[str, str, str]:
    """Return (caption_prompt, layout_prompt, hybrid_prompt) from normalized state."""
    draft = state.get("draft")
    has_draft = isinstance(draft, dict) and isinstance(draft.get("items"), list) and len(draft["items"]) > 0

    caption_text = str(state.get("caption_text") or state.get("caption") or "").strip()
    if not caption_text and has_draft:
        caption_text = str(draft.get("summary", {}).get("caption") or "").strip()

    if mode == "caption" and not caption_text:
        raise ValueError("payload 里没有 caption 文本；请重新反推或在编辑弹窗里填写。")

    if not has_draft:
        if mode in ("layout", "hybrid") and not synthesize_missing_draft:
            raise ValueError("payload 里没有布局草稿；请切到布局模式重新反推。")
        fallback = _fallback_draft(caption_text or "A composed image.", width, height)
        fallback_json = json.dumps(fallback, ensure_ascii=False, separators=(",", ":"))
        return (caption_text or fallback["summary"]["caption"], fallback_json, fallback_json)

    # Synchronize items and dimensions from the active draft so manual edits in
    # the workbench/node always propagate to both layout_prompt and hybrid_prompt.
    active_items = copy.deepcopy(draft["items"])
    active_summary = str(draft.get("summary", {}).get("caption") or caption_text or "A composed image.").strip()
    if not caption_text:
        caption_text = active_summary

    layout_draft = copy.deepcopy(state.get("layout_draft") if isinstance(state.get("layout_draft"), dict) else draft)
    layout_draft["width"] = width
    layout_draft["height"] = height
    layout_draft["items"] = copy.deepcopy(active_items)
    if not isinstance(layout_draft.get("summary"), dict):
        layout_draft["summary"] = {"caption": _concise_summary(active_summary), "canvas": "single"}
    elif mode == "layout":
        layout_draft["summary"]["caption"] = active_summary

    hybrid_draft = copy.deepcopy(state.get("hybrid_draft") if isinstance(state.get("hybrid_draft"), dict) else draft)
    hybrid_draft["width"] = width
    hybrid_draft["height"] = height
    hybrid_draft["items"] = copy.deepcopy(active_items)
    if not isinstance(hybrid_draft.get("summary"), dict):
        hybrid_draft["summary"] = {"caption": caption_text, "canvas": "single"}
    else:
        hybrid_draft["summary"]["caption"] = (
            active_summary if mode == "hybrid" else (caption_text or active_summary)
        )

    layout_prompt = json.dumps(layout_draft, ensure_ascii=False, separators=(",", ":"))
    hybrid_prompt = json.dumps(hybrid_draft, ensure_ascii=False, separators=(",", ":"))
    danbooru_prompt = str(
        state.get("danbooru_prompt")
        or state.get("danbooru_text")
        or state.get("tags")
        or ""
    ).strip()
    if not danbooru_prompt:
        tags_list = []
        if has_draft:
            for item in draft.get("items", []):
                cap = str(item.get("caption") or "").strip()
                if cap:
                    tags_list.extend([t.strip().lower() for t in re.split(r"[,;]+", cap) if t.strip()])
        if not tags_list and caption_text:
            clean_words = re.sub(r"[^\w\s]", " ", caption_text).lower().split()
            tags_list = [w for w in clean_words if len(w) > 2][:16]
        danbooru_prompt = ", ".join(tags_list) if tags_list else "masterpiece, solo, high quality"
    return (caption_text, layout_prompt, danbooru_prompt)


class AIPromptStudioCaptionNode:
    """Image → 1-3 mode prompts (caption / layout / hybrid) + MOSS canvas size."""

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        return {
            "required": {
                "mode": (
                    list(MODES),
                    {"default": "caption", "tooltip": "主模式：散文描述 / 分区域布局 / 完整描述+布局"},
                ),
                "payload": (
                    "STRING",
                    {
                        "multiline": False,
                        "default": "{}",
                        "tooltip": "反推与编辑结果（JSON，随工作流保存）。留空 {} 时第一次排队会自动反推。",
                    },
                ),
            },
            "optional": {
                "image": ("IMAGE", {"tooltip": "画布上的图片张量（LoadImage 等的输出）"}),
                "image_path": (
                    "STRING",
                    {"default": "", "tooltip": "本地图片绝对路径；image 输入优先，未连接时使用"},
                ),
                "extra_instruction": (
                    "STRING",
                    {"default": "", "tooltip": "补充要求，例如：强调画面构图"},
                ),
                "model": (
                    "STRING",
                    {"default": "", "tooltip": "留空使用工作台配置的模型"},
                ),
                "seed": (
                    "INT",
                    {"default": 0, "min": 0, "max": 0xFFFFFFFF,
                     "tooltip": "数值变化时强制重新执行（反推本身不受影响）"},
                ),
                "enable_caption": (
                    "BOOLEAN",
                    {"default": True, "tooltip": "勾选后生成并输出 caption_prompt（英文散文描述）"},
                ),
                "enable_layout": (
                    "BOOLEAN",
                    {"default": False, "tooltip": "勾选后同时生成并输出 layout_prompt（分区域布局草稿 JSON）"},
                ),
                "enable_danbooru": (
                    "BOOLEAN",
                    {"default": False, "tooltip": "勾选后同时生成并输出 danbooru_prompt（Danbooru 结构化逗号标签）"},
                ),
                "enable_hybrid": (
                    "BOOLEAN",
                    {"default": False, "tooltip": "兼容旧版：勾选后同时生成并输出 danbooru_prompt"},
                ),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING", "INT", "INT", "STRING")
    RETURN_NAMES = ("caption_prompt", "layout_prompt", "danbooru_prompt", "width", "height", "negative_prompt")
    FUNCTION = "execute"
    CATEGORY = "AI Prompt Studio"
    DESCRIPTION = (
        "图片反推：支持同时勾选 1~3 种模式（caption 散文 / layout 布局 JSON / hybrid 完整描述+布局 JSON），"
        "提供 3 个对应 STRING 输出端口及 width/height（MOSS 官方 16 倍数尺寸）。"
        "点「反推」或第一次排队时调用模型，结果存进 payload；之后跑图只读缓存。"
    )
    OUTPUT_NODE = False
    NODE_NAME = "AI 图像反推提示词"

    def caption_all(
        self,
        *,
        mode: str,
        payload: str,
        image: Any = None,
        image_path: str = "",
        extra_instruction: str = "",
        model: str = "",
        seed: int = 0,
        enable_caption: bool | None = None,
        enable_layout: bool | None = None,
        enable_danbooru: bool | None = None,
        enable_hybrid: bool | None = None,
        call_model: Callable[..., str] | None = None,
        synthesize_missing_draft: bool = False,
    ) -> tuple[str, str, str, int, int, str | None]:
        """Return (caption_prompt, layout_prompt, hybrid_prompt, width, height, updated_payload_or_None)."""
        if mode not in MODES:
            raise ValueError(f"unknown mode: {mode}")
        try:
            raw_state = json.loads(payload or "{}")
        except json.JSONDecodeError as exc:
            raise ValueError(f"payload is not valid JSON: {exc}") from exc
        if not isinstance(raw_state, dict):
            raise ValueError("payload must be a JSON object")

        state = _normalize_state_payload(raw_state)
        payload_modes = state.get("modes") if isinstance(state.get("modes"), list) else None
        active_modes = normalize_modes(
            mode,
            payload_modes if (enable_caption is None and enable_layout is None and enable_danbooru is None and enable_hybrid is None) else None,
            enable_caption=enable_caption,
            enable_layout=enable_layout,
            enable_danbooru=enable_danbooru,
            enable_hybrid=enable_hybrid,
        )
        if mode not in active_modes:
            active_modes.append(mode)

        width = int(state.get("width") or 0)
        height = int(state.get("height") or 0)
        needs_size = width <= 0 or height <= 0
        needs_caption = ("caption" in active_modes) and not _has_caption(state)
        needs_layout = bool({"layout", "hybrid"} & set(active_modes)) and not _has_draft(state)

        new_payload: str | None = None
        has_image = _has_execution_image(image, image_path)

        if needs_size or ((needs_caption or needs_layout) and has_image):
            raw, mime = _execution_image_bytes(image, image_path)
            state = _generate_state(
                mode=mode,
                modes=active_modes,
                raw=raw,
                mime=mime,
                extra_instruction=extra_instruction,
                model=model,
                call_model=call_model,
                existing_state=state if not needs_size else None,
            )
            width = int(state["width"])
            height = int(state["height"])
            new_payload = json.dumps(state, ensure_ascii=False)

        caption_prompt, layout_prompt, danbooru_prompt = build_prompt_outputs(
            state,
            mode=mode,
            width=width,
            height=height,
            synthesize_missing_draft=synthesize_missing_draft,
        )
        neg_prompt = str(state.get("negative_prompt") or "").strip()
        if not neg_prompt:
            canonical_mode = "danbooru" if mode == "danbooru" else "caption"
            neg_prompt = DEFAULT_DANBOORU_NEGATIVE if canonical_mode == "danbooru" else DEFAULT_PROSE_NEGATIVE
        return (caption_prompt, layout_prompt, danbooru_prompt, width, height, neg_prompt, new_payload)

    def caption(self, *, mode: str, payload: str, image: Any = None,
                image_path: str = "", extra_instruction: str = "",
                model: str = "", seed: int = 0,
                enable_caption: bool | None = None,
                enable_layout: bool | None = None,
                enable_danbooru: bool | None = None,
                enable_hybrid: bool | None = None,
                call_model: Callable[..., str] | None = None):
        """Return (prompt, width, height, updated_payload_or_None) for the primary ``mode``."""
        caption_prompt, layout_prompt, danbooru_prompt, width, height, neg_prompt, new_payload = self.caption_all(
            mode=mode,
            payload=payload,
            image=image,
            image_path=image_path,
            extra_instruction=extra_instruction,
            model=model,
            seed=seed,
            enable_caption=enable_caption,
            enable_layout=enable_layout,
            enable_danbooru=enable_danbooru,
            enable_hybrid=enable_hybrid,
            call_model=call_model,
            synthesize_missing_draft=False,
        )
        if mode == "caption":
            primary = caption_prompt
        elif mode == "layout":
            primary = layout_prompt
        elif mode == "hybrid":
            try:
                st = json.loads(new_payload or payload or "{}")
            except Exception:
                st = {}
            hybrid_draft = st.get("hybrid_draft") or st.get("draft")
            primary = json.dumps(hybrid_draft, ensure_ascii=False, separators=(",", ":")) if hybrid_draft else layout_prompt
        else:
            primary = danbooru_prompt
        return (primary, width, height, new_payload)

    def execute(self, **kwargs: Any):
        """ComfyUI entry point: 5 outputs (3 prompts + width + height) plus UI payload when updated."""
        caption_prompt, layout_prompt, danbooru_prompt, width, height, neg_prompt, new_payload = self.caption_all(
            **kwargs,
            synthesize_missing_draft=True,
        )
        if kwargs.get("mode") == "hybrid" or (kwargs.get("enable_hybrid") and not kwargs.get("enable_danbooru")):
            try:
                st = json.loads(new_payload or kwargs.get("payload") or "{}")
            except Exception:
                st = {}
            hyb = st.get("hybrid_draft") or st.get("draft")
            third = json.dumps(hyb, ensure_ascii=False, separators=(",", ":")) if hyb else danbooru_prompt
        else:
            third = danbooru_prompt
        outputs = (caption_prompt, layout_prompt, third, width, height, neg_prompt)
        if new_payload is None:
            return outputs
        return {"ui": {"aps_payload": [new_payload]}, "result": outputs}

    @classmethod
    def IS_CHANGED(
        cls,
        *,
        mode: str = "caption",
        payload: str = "{}",
        enable_caption: bool | None = None,
        enable_layout: bool | None = None,
        enable_danbooru: bool | None = None,
        enable_hybrid: bool | None = None,
        **kwargs: Any,
    ):
        """Cache a generated result, but re-run when payload is empty or missing a newly requested mode."""
        try:
            raw_state = json.loads(payload or "{}")
        except json.JSONDecodeError:
            raw_state = {}
        if not isinstance(raw_state, dict):
            return float("nan")
        state = _normalize_state_payload(raw_state)
        if int(state.get("width") or 0) <= 0 or int(state.get("height") or 0) <= 0:
            return float("nan")
        try:
            payload_modes = state.get("modes") if isinstance(state.get("modes"), list) else None
            active_modes = normalize_modes(
                mode if mode in MODES else "caption",
                payload_modes if (enable_caption is None and enable_layout is None and enable_danbooru is None and enable_hybrid is None) else None,
                enable_caption=enable_caption,
                enable_layout=enable_layout,
                enable_danbooru=enable_danbooru,
                enable_hybrid=enable_hybrid,
            )
        except ValueError:
            return float("nan")
        if ("layout" in active_modes or "hybrid" in active_modes) and not _has_draft(state):
            return float("nan")
        if ("caption" in active_modes) and not _has_caption(state):
            return float("nan")
        return f"{mode}:{','.join(active_modes)}:{payload}"


def _has_execution_image(image: Any, image_path: str) -> bool:
    """Return True if a valid image tensor or non-empty image_path was supplied."""
    shape = getattr(image, "shape", None)
    if shape is not None and len(shape) == 4 and shape[-1] in (1, 3, 4):
        return True
    return bool(clean_widget_str(image_path, is_path=True))


def _execution_image_bytes(image: Any, image_path: str) -> tuple[bytes, str]:
    """Read graph IMAGE bytes first, then an image_path file."""
    png = _tensor_to_png(image)
    if png is not None:
        return png, "image/png"
    source = clean_widget_str(image_path, is_path=True)
    if not source:
        raise ValueError(
            "payload 为空或缺少当前模式所需数据：请连接 LoadImage 的 IMAGE 输出，或填写 image_path，"
            "也可以先点节点上的「反推」按钮；并确认模型 / Base URL / API Key 已配置。"
        )
    path = Path(source)
    if not path.is_file():
        raise ValueError(f"image_path is not a file: {source}")
    data = path.read_bytes()
    if len(data) > _MAX_MEDIA_BYTES:
        raise ValueError(f"image_path file exceeds {_MAX_MEDIA_BYTES} bytes; downscale it first")
    mime = _MIME_BY_EXT.get(path.suffix.lower().lstrip("."))
    if mime is None:
        raise ValueError(f"unsupported image type: {path.suffix}")
    return data, mime


def register(mappings: dict, display_names: dict) -> None:
    mappings["AIPromptStudioCaption"] = AIPromptStudioCaptionNode
    display_names["AIPromptStudioCaption"] = "AI 图像反推提示词"


__all__ = [
    "AIPromptStudioCaptionNode",
    "register",
    "image_dimensions",
    "MODES",
    "normalize_modes",
    "build_prompt_outputs",
]
