"""ComfyUI node: AI image captioning as part of the graph.

Unlike the sidebar workbench (which only edits existing widgets), this node is
a regular graph node: it takes an IMAGE tensor (ComfyUI's NHWC float 0-1
format) or a file path, sends it through the same backend used by the sidebar
(``caption_image``), and outputs a STRING prompt in any of the three formats.

Trade-off accepted by design: workflows saved with this node need the plugin
installed to reopen (ComfyUI marks missing node types in red).  The sidebar
remains the zero-footprint way to use the studio.
"""

from __future__ import annotations

import base64
import io
import struct
import zlib
from pathlib import Path
from typing import Any

from .caption import FORMATS, caption_image
from .images import to_api_part
from .sessions import MediaStore, decode_data_url

_FORMAT_NAMES = {"prose": "自然语言", "tags": "逗号标签", "moss": "MOSS 风格"}

_MAX_MEDIA_BYTES = 8 * 1024 * 1024


def _tensor_to_png(image: Any) -> bytes | None:
    """Encode a ComfyUI IMAGE tensor (NHWC float 0-1) as an 8-bit RGB PNG.

    Returns None when ``image`` does not look like a tensor (no shape
    attribute) so the caller can fall back to treating it as a path or URL.
    Accepts torch tensors and anything else exposing ``.shape`` plus
    sequence-style indexing (numpy arrays included); torch itself is
    imported lazily and only when a tensor-shaped input is present.
    """
    shape = getattr(image, "shape", None)
    if shape is None or len(shape) != 4 or shape[-1] not in (1, 3, 4):
        return None
    import numpy as np  # numpy ships with ComfyUI

    frame = np.asarray(image[0]) if shape[0] > 1 else np.asarray(image[0])
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


def _image_source_part(media: MediaStore, image: Any, image_path: str) -> dict[str, Any]:
    """Turn the node's inputs into one stored image part for the model call."""
    png = _tensor_to_png(image)
    if png is not None:
        if len(png) > media.max_bytes:
            raise ValueError(
                f"image too large after encoding ({len(png)} bytes > {media.max_bytes}); "
                "downscale it before captioning"
            )
        return media.put(png, "image/png")
    source = str(image_path or "").strip()
    if not source:
        raise ValueError("connect an IMAGE input or set image_path.")
    if source.lower().startswith(("http://", "https://")):
        # Stored as a plain part; the client fetches it server-side.
        return {"type": "image_url", "image_url": {"url": source}}
    path = Path(source)
    if not path.is_file():
        raise ValueError(f"image_path is not a file: {source}")
    data = path.read_bytes()
    if len(data) > _MAX_MEDIA_BYTES:
        raise ValueError(
            f"image_path file exceeds {_MAX_MEDIA_BYTES} bytes; downscale it first"
        )
    ext = path.suffix.lower().lstrip(".")
    mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
            "webp": "image/webp", "gif": "image/gif"}.get(ext)
    if mime is None:
        raise ValueError(f"unsupported image type: .{ext}")
    return media.put(data, mime)


class AIPromptStudioCaptionNode:
    """Image → text prompt, any 1-3 of the three studio formats."""

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        return {
            "required": {
                "format": (
                    list(FORMATS),
                    {"default": "prose", "tooltip": "输出格式：自然语言 / 逗号标签 / MOSS 风格"},
                ),
            },
            "optional": {
                "image": ("IMAGE", {"tooltip": "画布上的图片张量（LoadImage 等的输出）"}),
                "image_path": (
                    "STRING",
                    {"default": "", "tooltip": "或给一个本地图片绝对路径（image 未连接时使用）"},
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

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    FUNCTION = "caption"
    CATEGORY = "AI Prompt Studio"
    DESCRIPTION = (
        "把图片反推成提示词（自然语言 / 逗号标签 / MOSS 风格），"
        "走工作台同一模型网关。输出可直接连到 CLIP Text Encode。"
    )
    OUTPUT_NODE = False
    NODE_NAME = "AI 图像反推提示词"

    def caption(self, *, format: str, image: Any = None, image_path: str = "",
                extra_instruction: str = "", model: str = "", seed: int = 0):
        # comfyui_plugin lives at the package root (ComfyUI imports it there);
        # the lazy import keeps this module importable without ComfyUI present.
        import comfyui_plugin

        backend = comfyui_plugin.get_backend()
        if backend is None:
            raise RuntimeError(
                "AI Prompt Studio 后端未配置：请先运行 prompt_studio.credentials set（见插件 README）。"
            )
        part = _image_source_part(backend.media, image, image_path)
        api_part = to_api_part(backend.media, part)
        result = caption_image(
            backend.client,
            api_part,
            fmt=format,
            model=(model or "").strip() or None,
            extra_instruction=extra_instruction,
        )
        text = result.text
        backend.audit.log(
            "node_caption",
            request_id=result.request_id,
            format=result.format,
            latency_ms=result.latency_ms,
        )
        return {"ui": {"format": result.format}, "result": (text,)}


def register(mappings: dict, display_names: dict) -> None:
    mappings["AIPromptStudioCaption"] = AIPromptStudioCaptionNode
    display_names["AIPromptStudioCaption"] = "AI 图像反推提示词"
