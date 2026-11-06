"""ComfyUI node: AI image reverse-engineering as part of the graph.

Three modes (caption / layout / hybrid) produce a STRING prompt plus the
MOSS-compatible ``width``/``height`` INT outputs.  The frontend's 「反推」button
posts to ``/ai_prompt_studio/caption_node`` and stores the result in the node's
``payload`` widget, which is serialized with the workflow.  Execution normally
reads that payload, so re-running an unchanged workflow never repeats a model
call.  If a freshly created node is queued before the button was clicked, its
execution creates the result once from the graph's IMAGE input and sends the
payload back to the browser for persistence.

Image data chain (explicit, no assumptions about tensor access over HTTP):
  * if the node's ``image`` input is linked, the frontend resolves the upstream
    LoadImage widget's filename through same-origin ``/view`` and sends a data
    URL to the route;
  * otherwise, if ``image_path`` is set, the route reads that local file
    server-side;
  * ``image`` takes priority over ``image_path``; neither present -> error.
The API key never leaves the backend.
"""

from __future__ import annotations

import base64
import json
import struct
import zlib
from pathlib import Path
from typing import Any, Callable

from .caption import SAFETY_PREFIX, _INSTRUCTIONS, _clean
from .config import load_settings
from .errors import StudioError
from .images import to_api_part
from .layout import layout_instruction, match_canvas_size, parse_model_layout
from .sessions import MediaStore

MODES = ("caption", "layout", "hybrid")
_MAX_MEDIA_BYTES = 8 * 1024 * 1024
_MIME_BY_EXT = {
    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
    "webp": "image/webp", "gif": "image/gif",
}


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


def _generate_state(*, mode: str, raw: bytes, mime: str,
                    extra_instruction: str, model: str,
                    call_model: Callable[..., str] | None) -> dict[str, Any]:
    """Caption graph-owned image bytes once and build a serializable payload."""
    src_w, src_h = image_dimensions(raw)
    width, height = match_canvas_size(src_w, src_h)
    settings = load_settings()
    resolved_model = model.strip() or settings.model
    media = MediaStore(settings.media_dir, max_bytes=settings.max_image_bytes)
    part = to_api_part(media, media.put(raw, mime))
    if part.get("type") == "image_ref":
        # MediaStore is used by the route to avoid duplicating bytes in memory;
        # graph execution has the bytes already, so send a data URL directly.
        part = {"type": "image_url", "image_url": {
            "url": "data:%s;base64,%s" % (mime, base64.b64encode(raw).decode("ascii"))
        }}
    instruction = (
        SAFETY_PREFIX + _INSTRUCTIONS["prose"] if mode == "caption"
        else SAFETY_PREFIX + layout_instruction(mode, width, height, extra_instruction)
    )
    if mode == "caption" and extra_instruction.strip():
        instruction += "\n\nAdditional user requirement: " + extra_instruction.strip()
    max_tokens = 500 if mode == "caption" else 3000
    if call_model is None:
        call_model = _default_model_call
    try:
        text = call_model(
            instruction=instruction, image_part=part,
            model=resolved_model, max_tokens=max_tokens,
        )
    except StudioError as exc:
        # A gateway stall must not leak raw exception details or the API key.
        raise ValueError(
            "反推超时或上游暂时不可用：请检查 Magpie / Base URL / 模型名，"
            "在侧边栏降低超时与重试后重试；也可以先点「反推」单独生成结果再排队。"
        ) from exc
    except (TimeoutError, OSError) as exc:
        raise ValueError("反推网络超时；请检查 Magpie 是否可用后重试。") from exc
    state: dict[str, Any] = {
        "mode": mode,
        "width": width,
        "height": height,
        "source_width": src_w,
        "source_height": src_h,
    }
    if mode == "caption":
        caption = _clean(str(text or ""), "prose")
        if not caption:
            raise ValueError("The model returned an empty caption.")
        state["caption"] = caption
    else:
        try:
            draft = parse_model_layout(str(text or ""), width, height)
        except ValueError as exc:
            raise ValueError(
                f"布局反推失败（模型输出不是完整 JSON）：{exc}。请重试或换模型。"
            ) from exc
        state["caption"] = str(draft["summary"]["caption"])
        state["draft"] = draft
    return state


class AIPromptStudioCaptionNode:
    """Image → prompt + MOSS canvas size, in three modes."""

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        return {
            "required": {
                "mode": (
                    list(MODES),
                    {"default": "caption", "tooltip": "出图方式：散文描述 / 分区域布局 / 完整描述+布局"},
                ),
                "payload": (
                    "STRING",
                    {
                        "multiline": True,
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
            },
        }

    RETURN_TYPES = ("STRING", "INT", "INT")
    RETURN_NAMES = ("prompt", "width", "height")
    # Graph execution uses the 3 declared outputs.  The fourth value is only
    # returned when ``caption`` is called directly (tests / embedders) so a
    # freshly generated payload can be persisted; ComfyUI wraps this function
    # through ``execute`` below.
    FUNCTION = "execute"
    CATEGORY = "AI Prompt Studio"
    DESCRIPTION = (
        "图片反推：caption（散文）/ layout（PromptBoard 布局 JSON）/ hybrid（完整描述+布局）。"
        "三种模式都输出 width/height（MOSS 官方 16 倍数尺寸）。"
        "点「反推」或第一次排队时调用模型，结果存进 payload；之后跑图只读缓存。"
    )
    OUTPUT_NODE = False
    NODE_NAME = "AI 图像反推提示词"

    def caption(self, *, mode: str, payload: str, image: Any = None,
                image_path: str = "", extra_instruction: str = "",
                model: str = "", seed: int = 0,
                call_model: Callable[..., str] | None = None):
        """Return (prompt, width, height, updated_payload_or_None).

        ``call_model`` is a test seam only; ComfyUI never supplies it.  Keeping
        it out of ``INPUT_TYPES`` means ComfyUI will not serialize it.
        """
        if mode not in MODES:
            raise ValueError(f"unknown mode: {mode}")
        try:
            state = json.loads(payload or "{}")
        except json.JSONDecodeError as exc:
            raise ValueError(f"payload is not valid JSON: {exc}") from exc
        if not isinstance(state, dict):
            raise ValueError("payload must be a JSON object")
        width = int(state.get("width") or 0)
        height = int(state.get("height") or 0)
        new_payload: str | None = None
        if width <= 0 or height <= 0:
            raw, mime = _execution_image_bytes(image, image_path)
            state = _generate_state(
                mode=mode, raw=raw, mime=mime,
                extra_instruction=extra_instruction,
                model=model, call_model=call_model,
            )
            width = int(state["width"])
            height = int(state["height"])
            new_payload = json.dumps(state, ensure_ascii=False)
        draft = state.get("draft")
        if mode == "caption":
            text = state.get("caption")
            if not isinstance(text, str) or not text.strip():
                raise ValueError("payload 里没有 caption 文本；请重新反推或在编辑弹窗里填写。")
            prompt = text.strip()
        else:
            if not isinstance(draft, dict) or not draft.get("items"):
                raise ValueError("payload 里没有布局草稿；请切到布局模式重新反推。")
            prompt = json.dumps(draft, ensure_ascii=False, separators=(",", ":"))
        return (prompt, width, height, new_payload)

    def execute(self, **kwargs: Any):
        """ComfyUI entry point: three outputs plus a UI payload when generated."""
        prompt, width, height, new_payload = self.caption(**kwargs)
        if new_payload is None:
            return (prompt, width, height)
        # ComfyUI sends {"ui": ...} to the frontend's onExecuted handler.
        return {"ui": {"aps_payload": [new_payload]}, "result": (prompt, width, height)}

    @classmethod
    def IS_CHANGED(cls, *, payload: str = "{}", **kwargs: Any):
        """Cache a generated result, but always run once for an empty payload."""
        try:
            state = json.loads(payload or "{}")
        except json.JSONDecodeError:
            state = {}
        if not isinstance(state, dict) or int(state.get("width") or 0) <= 0:
            return float("nan")
        return payload


def _execution_image_bytes(image: Any, image_path: str) -> tuple[bytes, str]:
    """Read graph IMAGE bytes first, then an image_path file."""
    png = _tensor_to_png(image)
    if png is not None:
        return png, "image/png"
    source = str(image_path or "").strip()
    if not source:
        raise ValueError(
            "payload 为空：请连接 LoadImage 的 IMAGE 输出，或填写 image_path，"
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


__all__ = ["AIPromptStudioCaptionNode", "register", "image_dimensions", "MODES"]
