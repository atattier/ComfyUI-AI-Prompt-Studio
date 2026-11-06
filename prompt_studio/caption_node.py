"""ComfyUI node: AI image reverse-engineering as part of the graph.

Three modes (caption / layout / hybrid) produce a STRING prompt plus the
MOSS-compatible ``width``/``height`` INT outputs.  The expensive model call is
NOT part of graph execution: the frontend's 「反推」button posts to
``/ai_prompt_studio/caption_node`` and stores the result in the node's
``payload`` widget, which is serialized with the workflow.  Execution only
reads that payload, so re-running a workflow never silently burns credits.

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

import json
import struct
import zlib
from pathlib import Path
from typing import Any

from .caption import caption_image
from .images import to_api_part
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
                        "tooltip": "反推与编辑结果（JSON，随工作流保存）。点节点上的「反推」按钮生成。",
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
    FUNCTION = "caption"
    CATEGORY = "AI Prompt Studio"
    DESCRIPTION = (
        "图片反推：caption（散文）/ layout（PromptBoard 布局 JSON）/ hybrid（完整描述+布局）。"
        "三种模式都输出 width/height（MOSS 官方 16 倍数尺寸）。"
        "点节点上的「反推」按钮调用模型，结果随工作流保存；跑图不重复调用模型。"
    )
    OUTPUT_NODE = False
    NODE_NAME = "AI 图像反推提示词"

    def caption(self, *, mode: str, payload: str, image: Any = None,
                image_path: str = "", extra_instruction: str = "",
                model: str = "", seed: int = 0):
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
        if width <= 0 or height <= 0:
            raise ValueError("请先点节点上的「反推」按钮生成结果（payload 为空）。")
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
        return (prompt, width, height)


def register(mappings: dict, display_names: dict) -> None:
    mappings["AIPromptStudioCaption"] = AIPromptStudioCaptionNode
    display_names["AIPromptStudioCaption"] = "AI 图像反推提示词"


__all__ = ["AIPromptStudioCaptionNode", "register", "image_dimensions", "MODES"]
