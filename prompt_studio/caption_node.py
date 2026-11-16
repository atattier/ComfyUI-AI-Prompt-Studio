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
import threading
import zlib
from pathlib import Path
from typing import Any, Callable, Sequence

from . import budget
from .caption import SAFETY_PREFIX, _INSTRUCTIONS, _clean
from .config import build_rule_suffix, load_settings
from .errors import AuthError, ModelNotFoundError, RateLimitError, StudioError, UpstreamTimeoutError
from .images import to_api_part
from .layout import (
    compile_layout_prompt,
    grid_overlay_data_url,
    layout_instruction,
    match_canvas_size,
    parse_model_layout,
    recover_partial_layout,
    shrink_data_url,
)
from .sessions import MediaStore
from .imagine import auto_imagine_pipeline, STYLES, ASPECTS, THEMES
from .presets import PresetStore, BUILTIN_PRESETS

MODES = ("caption", "layout", "danbooru", "hybrid")

DEFAULT_PROSE_NEGATIVE = (
    "child, toddler, preteen, loli, babyface, flat chest, mature female, adult woman, milf, old, "
    "high cheekbones, hollow cheeks, deep-set eyes, pointy chin, V-shaped face, heavy eyeliner, "
    "spiky fake eyelashes, mascara, heavy makeup, fat, chubby, plump, wide adult hips, "
    "red face, burning red cheeks, sunburn, rosacea, tomato face, "
    "cosplay, cosplayer, wig, synthetic hair, cosplay wig, stiff hair, thick blunt bangs, colored contact lenses, "
    "blurry, out of focus, soft focus, lowres, censored, mosaic censoring, bar censor, "
    "anime, illustration, 2d, 3d render, cgi, doll, plastic skin, "
    "ugly face, distorted face, squished cheek, grimace, creepy eyes, worst quality, bad anatomy, "
    "fused bodies, fused legs, extra limbs, extra arms, extra legs, extra hands, three hands, "
    "extra fingers, mutated hands, fused fingers, six fingers, watermark, signature, text"
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


def _default_text_model_call(resolved_model: str):
    """Text-only model caller for autonomous ideation and prompt expansion."""
    import comfyui_plugin

    backend = comfyui_plugin.get_backend()
    if backend is None:
        raise ValueError("模型后端未配置。请在顶栏「⚙ 设置」中配置 Base URL 与 API Key。")

    def call(instruction: str, max_tokens: int, temperature: float) -> str:
        messages = [{"role": "user", "content": [{"type": "text", "text": instruction}]}]
        result = backend.client.complete_via_stream(
            messages, model=resolved_model, temperature=temperature, max_tokens=max_tokens
        )
        return result.text

    return call


_LAST_CALL_META = threading.local()


def _is_truncated(text: str | None, finish_reason: str | None) -> bool:
    """True when the budget ran out during thinking and no text came back."""
    return not str(text or "").strip() and finish_reason in budget.TRUNCATION_REASONS


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
    _LAST_CALL_META.finish_reason = result.finish_reason
    return result.text


def _format_layout_warnings(draft: dict[str, Any]) -> str | None:
    """Turn a parsed draft's schema warnings into a user-facing warning string."""
    issues = [str(w).strip() for w in (draft.get("warnings") or []) if str(w).strip()]
    if not issues:
        return None
    return "⚠️ 布局反推结果可能不准：" + " ".join(issues)


def resolve_layout_output(
    *,
    raw_text: str,
    finish_reason: str | None,
    width: int,
    height: int,
    max_regions: int,
    active_modes: Sequence[str],
    existing_caption: str = "",
) -> tuple[dict[str, Any], str | None]:
    """Parse layout JSON, salvage partial regions on cutoff, or explain failure truthfully."""
    raw_str = str(raw_text or "")
    try:
        draft = parse_model_layout(raw_str, width, height, max_items=max_regions)
        return draft, _format_layout_warnings(draft)
    except ValueError as exc:
        salvaged = recover_partial_layout(
            raw_str,
            width,
            height,
            max_items=max_regions,
            fallback_caption=existing_caption,
        )
        if salvaged is not None:
            reason_tag = (
                "安全策略拦截 (content_filter)"
                if finish_reason == "content_filter"
                else ("输出长度截断 (length)" if finish_reason == "length" else "JSON 未完全闭合")
            )
            warning = (
                f"⚠️ 布局输出因 {reason_tag} 被提前中断，已自动抢救保留前 {len(salvaged['items'])} 个完整区域框。"
            )
            extra = _format_layout_warnings(salvaged)
            if extra:
                warning = f"{warning} {extra}"
            return salvaged, warning

        has_other_mode = any(m in ("caption", "danbooru") for m in active_modes)
        cap_clean = str(existing_caption or "").strip()
        if cap_clean and has_other_mode and finish_reason in ("content_filter", "length"):
            placeholder = _fallback_draft(cap_clean, width, height)
            kept = [m for m in ("caption", "danbooru") if m in active_modes]
            kept_label = " / ".join("散文" if m == "caption" else "Danbooru" for m in kept) or "散文"
            if finish_reason == "content_filter":
                warning = (
                    f"⚠️ {kept_label}已反推成功并保留！但「布局」分框阶段触发上游安全策略拦截 "
                    f"(content_filter，第 {len(raw_str)} 字符处被中断)，暂以全图占位框兜底；"
                    "可更换视觉模型或调整补充要求后重试布局。"
                )
            else:
                warning = (
                    f"⚠️ {kept_label}已反推成功并保留！但「布局」分框因长度截断 (length) 未生成完整画框，"
                    "暂以全图占位框兜底；可降低「布局最大区域数」后重试。"
                )
            return placeholder, warning

        if finish_reason == "content_filter":
            raise ValueError(
                f"布局反推失败：模型在输出第 {len(raw_str)} 字符时触发上游安全策略拦截 "
                f"(finish_reason=content_filter) 被提前中断，未能生成有效区域框（{exc}）。"
                "建议切换其他视觉模型，或先勾选「散文 / Danbooru」模式。"
            ) from exc
        if finish_reason == "length":
            raise ValueError(
                f"布局反推失败：模型输出因达到长度上限被截断 (finish_reason=length，"
                f"第 {len(raw_str)} 字符)：{exc}。可降低「布局最大区域数」或换模型重试。"
            ) from exc
        raise ValueError(
            f"布局反推失败（finish_reason={finish_reason or 'unknown'}）：{exc}。"
            "模型没有按布局约定返回 items 区域数组，或 JSON 不完整。"
            "请点「反推」重试；仍失败可换模型或减少画面文字。"
        ) from exc


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


def _extract_clean_caption_and_draft(text: str) -> tuple[str, dict[str, Any] | None]:
    """Extract pure narrative caption and recovered layout draft if text got polluted with JSON."""
    if not text or not isinstance(text, str):
        return "", None
    t = text.strip()
    pure = ""
    draft_obj: dict[str, Any] | None = None

    try:
        data = json.loads(t)
        if isinstance(data, dict):
            cap = data.get("summary", {}).get("caption") or data.get("caption")
            if cap:
                pure = str(cap).strip()
                draft_obj = data
    except Exception:
        pass

    if not pure:
        m = re.search(r'^(.*?)(?:"?\s*,\s*"(?:items|layout|regions|objects)"\s*:\s*\[)', t, re.DOTALL)
        if m:
            candidate = m.group(1).strip().strip('"').strip()
            if candidate.startswith('{"summary":{"caption":"'):
                candidate = candidate.replace('{"summary":{"caption":"', '').strip()
            pure = candidate
            items_part = t[m.end() - len("["):]
            try:
                items_json = '{"items":' + items_part
                if not items_json.endswith("}"):
                    items_json += "}"
                draft_obj = json.loads(items_json)
            except Exception:
                draft_obj = None

    if pure:
        pure = re.sub(r'''^\s*\{\s*"(?:summary|caption|prompt|result)"\s*:\s*\{\s*"(?:caption|text|prompt)"\s*:\s*["']?''', '', pure, flags=re.IGNORECASE)
        pure = re.sub(r'''^\s*\{\s*"(?:summary|caption|prompt|result|description)"\s*:\s*["']?''', '', pure, flags=re.IGNORECASE)
        pure = re.sub(r"""["']\s*\}*\s*$""", '', pure)
        pure = re.sub(r'\s*\}\s*$', '', pure).strip()
    else:
        cleaned = re.sub(r'''^\s*\{\s*"(?:summary|caption|prompt|result)"\s*:\s*\{\s*"(?:caption|text|prompt)"\s*:\s*["']?''', '', t, flags=re.IGNORECASE)
        cleaned = re.sub(r'''^\s*\{\s*"(?:summary|caption|prompt|result|description)"\s*:\s*["']?''', '', cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r'"\s*,\s*"canvas".*$', '', cleaned, flags=re.DOTALL)
        cleaned = re.sub(r"""["']\s*\}*\s*$""", '', cleaned)
        pure = re.sub(r'\s*\}\s*$', '', cleaned).strip()

    if draft_obj and isinstance(draft_obj, dict):
        if not isinstance(draft_obj.get("summary"), dict):
            draft_obj["summary"] = {"caption": pure or "A composed image.", "canvas": "single"}
        elif pure and not draft_obj["summary"].get("caption"):
            draft_obj["summary"]["caption"] = pure
        # 兼容 box -> bbox 以及 description -> caption 映射
        for it in draft_obj.get("items", []):
            if isinstance(it, dict):
                if "box" in it and "bbox" not in it:
                    it["bbox"] = it["box"]
                if "description" in it and "caption" not in it:
                    it["caption"] = it["description"]

    return pure, draft_obj


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

    # 自愈保护：若 caption 被污染混入 JSON 或 "items"/"layout": [，将其智能解构拆分
    raw_cap = str(state.get("caption") or state.get("caption_text") or "").strip()
    if raw_cap and (any(k in raw_cap for k in ('"items"', '"layout"', '"regions"', '"objects"')) or raw_cap.startswith("{")):
        pure_cap, extracted_draft = _extract_clean_caption_and_draft(raw_cap)
        if pure_cap:
            state["caption"] = pure_cap
            state["caption_text"] = pure_cap
        if extracted_draft and (not state.get("draft") or not state["draft"].get("items")):
            try:
                state["draft"] = parse_model_layout(json.dumps(extracted_draft), width or 1024, height or 1024)
            except Exception:
                pass

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


def _shrunk_part(part: dict[str, Any]) -> dict[str, Any]:
    """送模型的图统一缩到长边 1280；失败就退回原图。"""
    url = (part.get("image_url") or {}).get("url") if isinstance(part, dict) else None
    if not isinstance(url, str):
        return part
    try:
        small = shrink_data_url(url)
    except Exception:
        return part
    if not small or small == url:
        return part
    return {"type": "image_url", "image_url": {"url": small}}


def _gridded_part(part: dict[str, Any]) -> dict[str, Any]:
    """把送模型的图换成叠了像素刻度的版本；任何异常都退回原图。"""
    url = (part.get("image_url") or {}).get("url") if isinstance(part, dict) else None
    if not isinstance(url, str):
        return part
    try:
        gridded = grid_overlay_data_url(url)
    except Exception:
        return part
    if not gridded or gridded == url:
        return part
    return {"type": "image_url", "image_url": {"url": gridded}}


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
    part = _shrunk_part(part)
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

    def _invoke(instr: str, max_tok: int, image_part: dict[str, Any] | None = None) -> tuple[str, str | None]:
        _LAST_CALL_META.finish_reason = None
        try:
            txt = call_model(
                instruction=instr, image_part=image_part or part,
                model=resolved_model, max_tokens=max_tok,
            )
            return txt, getattr(_LAST_CALL_META, "finish_reason", None)
        except AuthError as exc:
            raise ValueError("反推鉴权失败 (401)：API Key 无效或未设置，请在节点「⚙ 设置」中配置有效密钥。") from exc
        except ModelNotFoundError as exc:
            raise ValueError("模型不存在 (404)：当前 Magpie / 网关未提供该模型，请在节点「⚙ 设置」中检查模型名。") from exc
        except RateLimitError as exc:
            raise ValueError("网关并发受限或额度耗尽 (429)：请稍后重试或检查账户余额。") from exc
        except UpstreamTimeoutError as exc:
            raise ValueError(
                f"反推超时（{exc.message}）：Thinking 模型通常需要 20~45 秒，请在节点「⚙ 设置」中将请求超时调大至 120~180 秒后重试；也可以检查 Magpie 网关并先点「反推」单独生成再排队。"
            ) from exc
        except StudioError as exc:
            raise ValueError(
                "反推上游服务暂时不可用：请检查 Magpie / Base URL / 模型名，"
                "在节点「⚙ 设置」中调整模型或超时设置后重试；也可以先点「反推」单独生成结果再排队。"
            ) from exc
        except (TimeoutError, OSError) as exc:
            raise ValueError("反推网络超时；请检查 Magpie 是否可用后重试。") from exc

    has_existing_cap = isinstance(state.get("caption_text"), str) and bool(state["caption_text"].strip())
    need_layout_call = bool({"layout", "hybrid"} & set(active_modes)) and not _has_draft(state)
    # 布局反推默认先跑一次纯散文反推作为 caption_hint 再合并进 layout
    need_caption_call = (
        ("caption" in active_modes) or (need_layout_call and call_model is _default_model_call)
    ) and not has_existing_cap
    need_danbooru_call = ("danbooru" in active_modes) and not (
        isinstance(state.get("danbooru_prompt"), str) and state["danbooru_prompt"].strip()
    )

    warnings: list[str] = []

    if need_caption_call:
        base_fmt = "prose"
        cap_instr = (
            SAFETY_PREFIX
            + _INSTRUCTIONS[base_fmt]
            + build_rule_suffix(settings, extra_clean, mode="caption")
        )
        raw_cap, cap_finish = _invoke(cap_instr, budget.OUTPUT_BUDGET)
        if _is_truncated(raw_cap, cap_finish):
            raw_cap, cap_finish = _invoke(cap_instr, budget.ESCALATED_BUDGET)
        caption = _clean(str(raw_cap or ""), base_fmt)
        if not caption:
            if cap_finish == "content_filter":
                if not need_layout_call:
                    raise ValueError("散文反推触发上游安全策略拦截 (content_filter)，未生成内容。请更换视觉模型后重试。")
                warnings.append("⚠️ 散文反推被上游安全策略拦截，已改用布局摘要作为描述。")
            elif need_layout_call:
                # 布局还要跑：散文空返回不该打断整次反推，最后用布局摘要兜底
                warnings.append("⚠️ 散文反推这次没返回文字（模型空回），已改用布局摘要作为描述。")
            else:
                raise ValueError("散文反推返回为空：模型这次没吐文字，重试或换一个视觉模型。")
        if caption:
            state["caption"] = caption
            state["caption_text"] = caption

    if need_layout_call:
        layout_target_mode = "hybrid" if "hybrid" in active_modes else "layout"
        lay_extra = build_rule_suffix(
            settings, extra_clean, mode="layout", for_json_layout=True
        ).strip()
        ref_cap = str(state.get("caption") or state.get("caption_text") or "").strip()
        lay_instr = SAFETY_PREFIX + layout_instruction(
            layout_target_mode,
            width,
            height,
            lay_extra,
            max_regions=settings.max_regions,
            model=resolved_model,
            caption_hint=ref_cap,
        )
        raw_lay, lay_finish = _invoke(lay_instr, budget.OUTPUT_BUDGET, part)
        draft, lay_warning = resolve_layout_output(
            raw_text=str(raw_lay or ""),
            finish_reason=lay_finish,
            width=width,
            height=height,
            max_regions=settings.max_regions,
            active_modes=active_modes,
            existing_caption=ref_cap,
        )
        if lay_warning:
            warnings.append(lay_warning)

        draft_caption = str(draft["summary"]["caption"]).strip()
        full_caption = str(state.get("caption_text") or draft_caption).strip()
        # 优先使用保留完整视角特征与构图边框的散文摘要，防止 summary.caption 泛化丢失视角与边框设计
        best_summary_caption = full_caption if (full_caption and len(full_caption) > len(draft_caption) + 30) else (draft_caption or full_caption)
        layout_draft = copy.deepcopy(draft)
        layout_draft["summary"]["caption"] = best_summary_caption
        hybrid_draft = copy.deepcopy(draft)
        hybrid_draft["summary"]["caption"] = full_caption or draft_caption

        state["layout_draft"] = layout_draft
        state["hybrid_draft"] = hybrid_draft
        state["draft"] = hybrid_draft if mode in ("hybrid", "danbooru") else (layout_draft if mode == "layout" else hybrid_draft)
        state["compiled_layout_prompt"] = compile_layout_prompt(state["draft"])
        if not state.get("caption"):
            state["caption"] = str(state["draft"]["summary"]["caption"])

    if need_danbooru_call:
        dan_instr = (
            SAFETY_PREFIX
            + _INSTRUCTIONS["danbooru"]
            + build_rule_suffix(settings, extra_clean, mode="danbooru")
        )
        raw_dan, dan_finish = _invoke(dan_instr, budget.TAG_BUDGET)
        dan_text = _clean(str(raw_dan or ""), "danbooru")
        if not dan_text and dan_finish == "content_filter":
            if state.get("caption") or state.get("draft"):
                warnings.append("⚠️ Danbooru 标签反推触发上游安全策略拦截 (content_filter)，暂未生成标签。")
            else:
                raise ValueError("Danbooru 反推触发上游安全策略拦截 (content_filter)，未返回标签。可切换视觉模型重试。")
        state["danbooru_prompt"] = dan_text
        state["danbooru_text"] = dan_text
        state["tags"] = dan_text

    if warnings:
        state["warning"] = " ".join(warnings)
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
    if caption_text and (any(k in caption_text for k in ('"items"', '"layout"', '"regions"', '"objects"')) or caption_text.startswith("{")):
        pure_cap, _ = _extract_clean_caption_and_draft(caption_text)
        if pure_cap:
            caption_text = pure_cap
        elif has_draft:
            caption_text = str(draft.get("summary", {}).get("caption") or "").strip()
    elif not caption_text and has_draft:
        caption_text = str(draft.get("summary", {}).get("caption") or "").strip()

    if mode == "caption" and not caption_text:
        raise ValueError("payload 里没有 caption 文本；请重新反推或在编辑弹窗里填写。")

    danbooru_prompt = str(
        state.get("danbooru_prompt")
        or state.get("danbooru_text")
        or state.get("tags")
        or ""
    ).strip()

    if not has_draft:
        if mode in ("layout", "hybrid") and not synthesize_missing_draft:
            raise ValueError("payload 里没有布局草稿；请切到布局模式重新反推。")
        fallback = _fallback_draft(caption_text or "A composed image.", width, height)
        fallback_json = compile_layout_prompt(fallback)
        return (
            caption_text or fallback["summary"]["caption"],
            fallback_json,
            danbooru_prompt or fallback_json,
        )

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
        layout_draft["summary"] = {"caption": active_summary, "canvas": "single"}
    elif mode == "layout" or not layout_draft["summary"].get("caption"):
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

    layout_prompt = compile_layout_prompt(layout_draft)
    hybrid_prompt = compile_layout_prompt(hybrid_draft)
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
                    {"default": 0, "min": 0, "max": 0xffffffffffffffff,
                     "tooltip": "数值变化时强制重新执行；未连接参考图时作为开盲盒随机种子"},
                ),
                "theme": (
                    ["", "random"] + [k for k in THEMES.keys() if k != "random"],
                    {"default": "random", "tooltip": "题材方向（未连接图片或自动构思盲盒时遵循）"},
                ),
                "style": (
                    ["", "auto"] + [k for k in STYLES.keys() if k != "auto"],
                    {"default": "auto", "tooltip": "画面视觉风格：自动 / 动漫 / 写实 / 电影感 / 插画 / 3D"},
                ),
                "aspect": (
                    ["", "auto"] + list(ASPECTS.keys()),
                    {"default": "auto", "tooltip": "画幅比例：自动 / 竖版 / 横版 / 方形"},
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

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs: Any) -> bool | str:
        """Allow backwards-compatible and flexible input values."""
        return True
    CATEGORY = "AI Prompt Studio"
    DESCRIPTION = (
        "AI 提示词工作台（图生图反推 + 文生图自主灵感二合一）："
        "1. 连接图片时：精准反推镜头、光影、微观肌理与 BBox 布局画框；"
        "2. 未连接图片或开启自动构思时：连接 seed 到随机种子节点，每次点击「运行」模型都会如开盲盒般全自动自主构思新画面，并生成整套提示词与画框直通下游采样器！"
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
        idea: str = "",
        theme: str = "random",
        style: str = "auto",
        aspect: str = "auto",
        auto_brainstorm: bool = False,
        extra_instruction: str = "",
        model: str = "",
        seed: int = 0,
        enable_caption: bool | None = None,
        enable_layout: bool | None = None,
        enable_danbooru: bool | None = None,
        enable_hybrid: bool | None = None,
        call_model: Callable[..., str] | None = None,
        synthesize_missing_draft: bool = False,
    ) -> tuple[str, str, str, int, int, str, str | None]:
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
        clean_idea = clean_widget_str(idea)
        auto_imagine_enabled = bool(state.get("auto_imagine") or auto_brainstorm)
        # 合并核心：若无参考图输入，且（开启了自动盲盒 或 传入了想法 或 mode为imagine），走自主灵感画面生成链路
        is_imagine_route = (not has_image) and (clean_idea or auto_imagine_enabled or mode == "imagine")

        if is_imagine_route and (not has_image or auto_imagine_enabled):
            cached_seed = state.get("seed")
            need_imagine = (
                needs_size
                or needs_caption
                or (bool({"layout", "hybrid"} & set(active_modes)) and not _has_draft(state))
                or (seed != 0 and cached_seed != seed)
                or (auto_imagine_enabled and seed != 0)
                or clean_idea
            )
            if need_imagine:
                settings = load_settings()
                resolved_model = clean_widget_str(model) or settings.model
                text_caller = _default_text_model_call(resolved_model)
                extra_clean = clean_widget_str(extra_instruction)
                # 若未提供 explicit idea，优先使用 extra_instruction 作为构想指导；若均为空则完全自主想点子
                effective_idea = clean_idea or (extra_clean if not has_image else "")
                state = auto_imagine_pipeline(
                    text_caller,
                    effective_idea,
                    modes=active_modes,
                    theme=clean_widget_str(theme) or state.get("theme") or "random",
                    style=clean_widget_str(style) or state.get("style") or "auto",
                    aspect=clean_widget_str(aspect) or state.get("aspect") or "auto",
                    max_regions=settings.max_regions,
                    rule_suffix=build_rule_suffix(settings, extra_clean, mode="caption"),
                    layout_rule_suffix=build_rule_suffix(settings, extra_clean, mode="layout", for_json_layout=True),
                )
                state["seed"] = seed
                if auto_imagine_enabled:
                    state["auto_imagine"] = True
                width = int(state["width"])
                height = int(state["height"])
                new_payload = json.dumps(state, ensure_ascii=False)
        elif needs_size or ((needs_caption or needs_layout) and has_image):
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
            if isinstance(hybrid_draft, dict):
                hybrid_draft = copy.deepcopy(hybrid_draft)
                hybrid_draft["width"] = width
                hybrid_draft["height"] = height
                primary = compile_layout_prompt(hybrid_draft)
            else:
                primary = layout_prompt
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
            if isinstance(hyb, dict):
                hyb = copy.deepcopy(hyb)
                hyb["width"] = width
                hyb["height"] = height
                third = compile_layout_prompt(hyb)
            else:
                third = layout_prompt
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
        # 若开启了自动灵感盲盒模式或未连接图片：种子发生变化时强制重新触发
        has_img = _has_execution_image(kwargs.get("image"), kwargs.get("image_path", ""))
        seed = int(kwargs.get("seed") or 0)
        if (state.get("auto_imagine") or not has_img) and seed != 0:
            if seed != state.get("seed"):
                return float("nan")
            return f"imagine:{seed}:{mode}:{payload}"

        if ("layout" in active_modes or "hybrid" in active_modes) and not _has_draft(state):
            return float("nan")
        if ("caption" in active_modes) and not _has_caption(state):
            return float("nan")
        if seed != 0:
            return f"{mode}:{','.join(active_modes)}:{seed}:{payload}"
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




class AIPromptStudioImagineNode:
    """Idea / Autonomous AI Brainstorm → 1-3 mode prompts + MOSS canvas size."""

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        return {
            "required": {
                "theme": (
                    list(THEMES.keys()),
                    {"default": "random", "tooltip": "题材方向（模型自己想点子时遵循）"},
                ),
                "style": (
                    list(STYLES.keys()),
                    {"default": "auto", "tooltip": "画面视觉风格：自动 / 动漫 / 写实 / 电影感 / 插画 / 3D"},
                ),
                "aspect": (
                    list(ASPECTS.keys()) + ["auto"],
                    {"default": "auto", "tooltip": "画幅比例：自动 / 竖版 / 横版 / 方形"},
                ),
                "seed": (
                    "INT",
                    {"default": 0, "min": 0, "max": 0xFFFFFFFF, "tooltip": "随机种子；改变种子自动重新想点子与生成"},
                ),
            },
            "optional": {
                "idea": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "",
                        "tooltip": "核心想法（留空时模型会自动放飞想象、自己想点子！）",
                    },
                ),
                "extra_instruction": (
                    "STRING",
                    {"default": "", "tooltip": "补充要求或排除项"},
                ),
                "model": (
                    "STRING",
                    {"default": "", "tooltip": "留空使用工作台配置的模型"},
                ),
                "enable_caption": (
                    "BOOLEAN",
                    {"default": True, "tooltip": "输出自然语言英文长描述 (给 Krea2 / FLUX / SD)"},
                ),
                "enable_layout": (
                    "BOOLEAN",
                    {"default": False, "tooltip": "输出分区域 BBox 画框布局 JSON (给 MOSS-Image)"},
                ),
                "enable_danbooru": (
                    "BOOLEAN",
                    {"default": False, "tooltip": "输出 Danbooru 风格逗号分隔标签 (给动漫模型/LoRA)"},
                ),
                "payload": (
                    "STRING",
                    {"default": "{}", "tooltip": "自动缓存上次生成结果，随工作流保存"},
                ),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING", "INT", "INT", "STRING")
    RETURN_NAMES = ("caption_prompt", "layout_prompt", "danbooru_prompt", "width", "height", "negative_prompt")
    FUNCTION = "execute"

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs: Any) -> bool | str:
        """Allow backwards-compatible and flexible input values."""
        return True
    CATEGORY = "AI Prompt Studio"
    DESCRIPTION = (
        "AI 灵感画面生成（全自动链路）：输入一句话想法，或完全留空让模型自己想点子！"
        "自动规划画面构图、左右方位、BBox 空间画框与 Danbooru 标签，直连下游模型出图。"
    )
    NODE_NAME = "AI 灵感画面提示词"

    def execute(self, **kwargs: Any):
        node = AIPromptStudioCaptionNode()
        kwargs_copy = dict(kwargs)
        kwargs_copy["mode"] = "caption"
        kwargs_copy["auto_brainstorm"] = True
        return node.execute(**kwargs_copy)

    @classmethod
    def IS_CHANGED(cls, **kwargs: Any):
        seed = kwargs.get("seed", 0)
        idea = kwargs.get("idea", "")
        payload = kwargs.get("payload", "{}")
        return f"{seed}:{idea}:{payload}"


def get_preset_names() -> list[str]:
    try:
        store = PresetStore()
        presets = store.list()
        store.close()
        names = [p["name"] for p in presets if p.get("name")]
        return names if names else ["双人对视 · 电影宽幅 (2.33:1)"]
    except Exception:
        return ["双人对视 · 电影宽幅 (2.33:1)"]


class AIPromptStudioPresetNode:
    """Composition & Prompt Preset Loader.

    Loads a saved or built-in composition preset (layout, prompt, resolution)
    directly into workflow pipelines.
    """

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        preset_names = get_preset_names()
        return {
            "required": {
                "preset_name": (
                    preset_names,
                    {"default": preset_names[0] if preset_names else "", "tooltip": "选择构图与提示词预设"},
                ),
            },
            "optional": {
                "extra_prompt": (
                    "STRING",
                    {"default": "", "multiline": True, "tooltip": "可选：追加到提示词末尾的补充词"},
                ),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING", "INT", "INT")
    RETURN_NAMES = ("caption_prompt", "layout_prompt", "danbooru_prompt", "layout_json", "width", "height")
    FUNCTION = "execute"
    CATEGORY = "AI Prompt Studio"
    DESCRIPTION = "一键加载已保存的构图与提示词预设，输出散文、空间布局、Danbooru 标签及推荐画布尺寸。"

    def execute(self, preset_name: str, extra_prompt: str = ""):
        store = PresetStore()
        found = None
        for p in store.list():
            if p.get("name") == preset_name or p.get("id") == preset_name:
                found = p
                break
        store.close()

        if not found:
            found = BUILTIN_PRESETS[0] if BUILTIN_PRESETS else {}

        prompts = found.get("prompts") or {}
        draft = found.get("draft") or {}
        width = int(found.get("width") or 1024)
        height = int(found.get("height") or 1024)

        caption = str(prompts.get("caption") or "")
        layout_desc = str(prompts.get("layout") or "")
        danbooru = str(prompts.get("danbooru") or "")
        layout_json = json.dumps(draft, ensure_ascii=False)

        extra = str(extra_prompt or "").strip()
        if extra:
            caption = f"{caption}, {extra}" if caption else extra
            danbooru = f"{danbooru}, {extra}" if danbooru else extra

        return (caption, layout_desc, danbooru, layout_json, width, height)


def register(mappings: dict, display_names: dict) -> None:
    mappings["AIPromptStudioCaption"] = AIPromptStudioCaptionNode
    display_names["AIPromptStudioCaption"] = "AI 提示词工作台 (反推与自动灵感)"
    # 保留别名兼容历史工作流，指向合并后的全能主节点
    mappings["AIPromptStudioImagine"] = AIPromptStudioCaptionNode
    display_names["AIPromptStudioImagine"] = "AI 灵感画面提示词 (已合并至主节点)"
    mappings["AIPromptStudioPreset"] = AIPromptStudioPresetNode
    display_names["AIPromptStudioPreset"] = "AI 构图提示词预设加载器"


__all__ = [
    "AIPromptStudioCaptionNode",
    "AIPromptStudioPresetNode",
    "register",
    "image_dimensions",
    "MODES",
    "normalize_modes",
    "build_prompt_outputs",
]
