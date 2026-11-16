"""Lora Preset Store for ComfyUI AI Prompt Studio.

Provides persistent storage for LoRA configurations (stacks, weights, trigger words,
categories, tags, notes, and previews), plus built-in classic LoRA stacks.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import re
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import logging
from urllib.parse import quote

from .credentials import default_home

logger = logging.getLogger("ai_prompt_studio.lora_presets")


MAX_LORA_PRESET_IMAGE_BYTES = 20 * 1024 * 1024
MAX_THUMBNAIL_CHARS = 600_000
MAX_CATEGORY_LEN = 128
DEFAULT_LORA_CATEGORY = "通用"

DEFAULT_LORA_CATEGORIES = [
    "通用",
    "画风风格",
    "人物角色",
    "光影质感",
    "细节增强",
    "服饰姿态",
]

BUILTIN_LORA_PRESETS: list[dict[str, Any]] = [
    {
        "id": "builtin_lora_cinematic_texture",
        "name": "电影级胶片光影与质感 (示例堆叠)",
        "category": "光影质感",
        "tags": ["电影感", "光影", "质感", "胶片"],
        "is_builtin": True,
        "loras": [
            {
                "name": "Realistic Skin Rendering",
                "strength_model": 0.75,
                "strength_clip": 0.75,
                "enabled": True,
            },
            {
                "name": "realskin_style_moss_v1.0",
                "strength_model": 0.50,
                "strength_clip": 0.50,
                "enabled": True,
            },
        ],
        "trigger_words": "cinematic lighting, 35mm photograph, film grain, depth of field, masterpiece, highly detailed",
        "notes": "增强画面的光影层次与微观皮肤质感，适合写实或半写实肖像。双 LoRA 组合协同提升画面质感。",
    },
    {
        "id": "builtin_lora_anime_illust",
        "name": "日系大师级厚涂插画 (示例堆叠)",
        "category": "画风风格",
        "tags": ["日系", "插画", "厚涂", "大师风"],
        "is_builtin": True,
        "loras": [
            {
                "name": "Yoneyama_Mai_MOSS",
                "strength_model": 0.80,
                "strength_clip": 0.80,
                "enabled": True,
            },
            {
                "name": "afk-art-style-moss-image-sft-v2",
                "strength_model": 0.60,
                "strength_clip": 0.60,
                "enabled": True,
            },
        ],
        "trigger_words": "by yoneyama mai, dynamic composition, expressive brushwork, intricate details, vivid color",
        "notes": "米山舞与精致美术风格结合，赋予画面强烈的动态构图与笔触张力。",
    },
    {
        "id": "builtin_lora_cyberpunk_neon",
        "name": "赛博机能与发光霓虹 (示例堆叠)",
        "category": "人物角色",
        "tags": ["赛博朋克", "机能风", "霓虹", "发光"],
        "is_builtin": True,
        "loras": [
            {
                "name": "Cyaniji-lora-comfy lora",
                "strength_model": 0.70,
                "strength_clip": 0.70,
                "enabled": True,
            },
            {
                "name": "SKP_MOS_Dv1",
                "strength_model": 0.50,
                "strength_clip": 0.50,
                "enabled": True,
            },
        ],
        "trigger_words": "cyberpunk, techwear, glowing neon accents, mechanical details, dark atmosphere",
        "notes": "科幻机械构件与霓虹发光细节，适合未来科幻与机能风角色。",
    },
]


def _sniff_image(raw: bytes) -> tuple[str, str] | None:
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png", "image/png"
    if raw.startswith(b"\xff\xd8\xff"):
        return "jpg", "image/jpeg"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "webp", "image/webp"
    return None


def _decode_image_payload(value: Any) -> bytes:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("image_data 不能为空。")
    text = value.strip()
    if text.startswith("data:"):
        _, _, text = text.partition(",")
    try:
        raw = base64.b64decode(text, validate=False)
    except (binascii.Error, ValueError) as err:
        raise ValueError("image_data 不是合法的 Base64。") from err
    if not raw:
        raise ValueError("image_data 为空。")
    if len(raw) > MAX_LORA_PRESET_IMAGE_BYTES:
        raise ValueError(
            f"图片体积过大 ({len(raw) // (1024 * 1024)} MB，上限 "
            f"{MAX_LORA_PRESET_IMAGE_BYTES // (1024 * 1024)} MB)。"
        )
    if _sniff_image(raw) is None:
        raise ValueError("图片必须是 PNG、JPEG 或 WEBP 格式。")
    return raw


def clean_category_name(value: Any) -> str:
    raw = str(value or "").strip().replace("\\", "/")
    segments = [s.strip() for s in raw.split("/") if s.strip()]
    if not segments:
        raise ValueError("分类名称不能为空。")
    name = "/".join(segments)
    if len(name) > MAX_CATEGORY_LEN:
        raise ValueError(f"分类名称不能超过 {MAX_CATEGORY_LEN} 个字符。")
    if name == "全部":
        raise ValueError("「全部」是保留名称，请换一个分类名。")
    return name


def scan_available_loras() -> list[str]:
    """Scan available LoRA files in ComfyUI or local directory."""
    try:
        import folder_paths
        loras = folder_paths.get_filename_list("loras")
        if loras:
            return sorted(list(loras))
    except Exception:
        pass

    possible_roots = [
        r"E:\AI_vedios\ComfyUI_aki\ComfyUI-aki-v3.2\ComfyUI\models\loras",
        os.path.join(os.getcwd(), "models", "loras"),
    ]
    found: set[str] = set()
    for root_dir in possible_roots:
        if os.path.isdir(root_dir):
            for dirpath, _, filenames in os.walk(root_dir):
                if ".lm-pending-delete" in dirpath:
                    continue
                for f in filenames:
                    if f.lower().endswith((".safetensors", ".ckpt", ".pt", ".bin")):
                        rel = os.path.relpath(os.path.join(dirpath, f), root_dir).replace("\\", "/")
                        found.add(rel)
    return sorted(list(found))


def get_lora_trigger_words(lora_rel_path: str) -> str:
    """Attempt to locate trigger words from sidecar json/txt files."""
    possible_roots = []
    try:
        import folder_paths
        lora_full = folder_paths.get_full_path("loras", lora_rel_path)
        if lora_full:
            possible_roots.append(os.path.dirname(lora_full))
    except Exception:
        pass

    possible_roots.extend([
        r"E:\AI_vedios\ComfyUI_aki\ComfyUI-aki-v3.2\ComfyUI\models\loras",
        os.path.join(os.getcwd(), "models", "loras"),
    ])

    for root_dir in possible_roots:
        if not os.path.isdir(root_dir):
            continue
        full_path = os.path.join(root_dir, lora_rel_path)
        base = os.path.splitext(full_path)[0]
        candidates = [
            base + ".metadata.json",
            full_path + ".weilin-info.json",
            base + ".safetensors.weilin-info.json",
            base + ".json",
            base + ".txt",
            base + ".civitai.info",
        ]
        for c in candidates:
            if os.path.isfile(c):
                try:
                    if c.endswith(".txt"):
                        text = open(c, encoding="utf-8", errors="ignore").read().strip()
                        if text:
                            return text
                    with open(c, encoding="utf-8", errors="ignore") as fp:
                        data = json.load(fp)
                    tw = (
                        data.get("civitai", {}).get("trainedWords")
                        or data.get("trainedWords")
                        or data.get("trigger_words")
                        or data.get("tags")
                    )
                    if tw:
                        return tw if isinstance(tw, str) else ", ".join(str(w) for w in tw if w)
                except Exception:
                    pass
    return ""


def find_lora_preview_path(lora_rel_path: str) -> str | None:
    """Find local preview image for a given LoRA (e.g. .preview.png, .jpeg, .png)."""
    possible_roots = []
    try:
        import folder_paths
        lora_full = folder_paths.get_full_path("loras", lora_rel_path)
        if lora_full:
            possible_roots.append(os.path.dirname(lora_full))
    except Exception:
        pass

    possible_roots.extend([
        r"E:\AI_vedios\ComfyUI_aki\ComfyUI-aki-v3.2\ComfyUI\models\loras",
        os.path.join(os.getcwd(), "models", "loras"),
    ])

    for root_dir in possible_roots:
        if not os.path.isdir(root_dir):
            continue
        full_path = os.path.join(root_dir, lora_rel_path)
        base = os.path.splitext(full_path)[0]
        candidates = [
            base + ".preview.png",
            base + ".jpeg",
            base + ".jpg",
            base + ".png",
            base + ".webp",
            full_path + ".preview.png",
            full_path + ".preview.jpeg",
            full_path + ".jpeg",
            full_path + ".png",
            base + ".thumb.jpg",
        ]
        for c in candidates:
            if os.path.isfile(c) and os.path.getsize(c) > 0:
                return os.path.abspath(c)
    return None


def scan_available_loras_metadata() -> dict[str, dict[str, Any]]:
    """Scan available LoRA files along with sidecar trigger words and preview image URLs."""
    loras = scan_available_loras()
    result = {}
    for lora_name in loras:
        tw = get_lora_trigger_words(lora_name)
        preview_path = find_lora_preview_path(lora_name)
        has_preview = bool(preview_path)
        result[lora_name] = {
            "trigger_words": tw,
            "has_preview": has_preview,
            "preview_url": f"/ai_prompt_studio/lora_presets/preview_image?name={quote(lora_name)}" if has_preview else "",
        }
    return result


def _clean_exif_val(val: Any) -> str:
    """Safely decode EXIF byte string / unicode payload."""
    if isinstance(val, str):
        return val.strip()
    if isinstance(val, bytes):
        for prefix in (b"UNICODE\x00", b"ASCII\x00\x00\x00", b"ASCII\x00"):
            if val.startswith(prefix):
                val = val[len(prefix):]
                break
        for enc in ("utf-8", "utf-16le", "latin-1", "gbk"):
            try:
                decoded = val.decode(enc).strip()
                if decoded:
                    return decoded
            except Exception:
                pass
    return ""


def extract_loras_from_image_bytes(raw: bytes, filename: str = "") -> dict[str, Any]:
    """Inspect image bytes (PNG, WebP, JPEG) and extract all embedded LoRAs & weights."""
    import io
    from PIL import Image

    found_loras: list[dict[str, Any]] = []
    seen_names: set[str] = set()
    thumbnail = ""

    def add_lora(name: Any, sm: Any = 1.0, sc: Any = None, enabled: bool = True, source: str = ""):
        if not name:
            return
        name_clean = str(name).strip().replace("\\", "/")
        if not name_clean or name_clean.lower() in ("none", "null", "undefined"):
            return
        norm_key = name_clean.lower()
        if norm_key in seen_names:
            return
        seen_names.add(norm_key)

        try:
            f_sm = round(float(sm), 3)
        except (ValueError, TypeError):
            f_sm = 1.0
        try:
            f_sc = round(float(sc if sc is not None else sm), 3)
        except (ValueError, TypeError):
            f_sc = f_sm

        # Match local LoRA and get trigger words
        tw = get_lora_trigger_words(name_clean)
        if not tw:
            for ext in (".safetensors", ".ckpt", ".pt", ".bin"):
                if norm_key.endswith(ext):
                    tw = get_lora_trigger_words(name_clean[:-len(ext)])
                    break
                else:
                    tw = get_lora_trigger_words(f"{name_clean}{ext}")
                    if tw:
                        break

        found_loras.append({
            "name": name_clean,
            "strength_model": f_sm,
            "strength_clip": f_sc,
            "enabled": bool(enabled),
            "trigger_words": tw,
            "source": source,
        })

    try:
        im = Image.open(io.BytesIO(raw))

        # 0. Generate 360px JPEG thumbnail for preview safely
        try:
            thumb_im = im.copy()
            resample_filter = getattr(getattr(Image, "Resampling", None), "LANCZOS", getattr(Image, "ANTIALIAS", None))
            if resample_filter:
                thumb_im.thumbnail((360, 360), resample_filter)
            else:
                thumb_im.thumbnail((360, 360))
            if thumb_im.mode != "RGB":
                thumb_im = thumb_im.convert("RGB")
            buf = io.BytesIO()
            thumb_im.save(buf, format="JPEG", quality=82)
            thumb_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
            thumbnail = f"data:image/jpeg;base64,{thumb_b64}"
        except Exception as exc:
            logger.warning(f"Failed to generate thumbnail: {exc}")
            thumbnail = ""

        # Collect raw metadata texts across all channels
        meta_texts: list[str] = []
        info = getattr(im, "info", {}) or {}
        text_chunks = getattr(im, "text", {}) or {}

        for k, v in {**text_chunks, **info}.items():
            if isinstance(v, str) and v.strip():
                meta_texts.append(v.strip())
            elif isinstance(v, bytes):
                dec = _clean_exif_val(v)
                if dec:
                    meta_texts.append(dec)

        # Inspect EXIF tags (specifically for JPEG / WebP)
        try:
            exif_data = im._getexif() if hasattr(im, "_getexif") else None
            if exif_data and isinstance(exif_data, dict):
                # 37510 is UserComment, 270 is ImageDescription
                for tag_id in (37510, 270, 0x9286, 0x010E):
                    val = exif_data.get(tag_id)
                    dec = _clean_exif_val(val)
                    if dec and dec not in meta_texts:
                        meta_texts.append(dec)
        except Exception:
            pass

        # 1. Inspect structured ComfyUI prompt & workflow JSON
        for txt in meta_texts:
            if "class_type" in txt or "nodes" in txt:
                try:
                    p_data = json.loads(txt)
                    if isinstance(p_data, dict):
                        # 1a. prompt format: { nid: { class_type, inputs } }
                        for nid, node in p_data.items():
                            if not isinstance(node, dict):
                                continue
                            ctype = str(node.get("class_type", ""))
                            inputs = node.get("inputs", {})
                            if not isinstance(inputs, dict):
                                continue

                            # Lora Loader (LoraManager) / Lora Stacker
                            if "loras" in inputs:
                                raw_loras = inputs.get("loras")
                                if isinstance(raw_loras, dict) and "__value__" in raw_loras:
                                    raw_loras = raw_loras["__value__"]
                                if isinstance(raw_loras, list):
                                    for l in raw_loras:
                                        if isinstance(l, dict) and l.get("name"):
                                            add_lora(
                                                l["name"],
                                                l.get("strength", 1.0),
                                                l.get("clipStrength", l.get("strength", 1.0)),
                                                l.get("active", True),
                                                ctype,
                                            )

                            # Standard LoraLoader / LoraLoaderModelOnly / Efficiency Loaders
                            if any(k in ctype.lower() for k in ("loraloader", "lora_loader")):
                                lname = inputs.get("lora_name") or inputs.get("lora")
                                if lname and isinstance(lname, str):
                                    sm = inputs.get("strength_model", inputs.get("strength", 1.0))
                                    sc = inputs.get("strength_clip", sm)
                                    add_lora(lname, sm, sc, True, ctype)

                            # Comfyroll CR LoRA Stack (lora_name_1, lora_name_2 ...)
                            for idx in range(1, 12):
                                lname_k = f"lora_name_{idx}"
                                if lname_k in inputs:
                                    lname = inputs.get(lname_k)
                                    if lname and isinstance(lname, str) and lname.lower() != "none":
                                        sm = inputs.get(f"model_weight_{idx}", 1.0)
                                        sc = inputs.get(f"clip_weight_{idx}", sm)
                                        sw = inputs.get(f"switch_{idx}", "On")
                                        enabled = str(sw).lower() in ("on", "true", "1")
                                        add_lora(lname, sm, sc, enabled, ctype)

                            # Power Lora Loader (rgthree)
                            for idx in range(1, 10):
                                lk = f"lora_{idx}"
                                if lk in inputs and isinstance(inputs[lk], dict):
                                    sub = inputs[lk]
                                    if sub.get("on") is not False and sub.get("lora"):
                                        add_lora(sub["lora"], sub.get("strength", 1.0), sub.get("strength", 1.0), True, ctype)

                            # AIPromptStudioLora
                            if "aipromptstudiolora" in ctype.lower():
                                stack_json = inputs.get("custom_stack_json")
                                if stack_json and isinstance(stack_json, str):
                                    try:
                                        s = json.loads(stack_json)
                                        s_list = s if isinstance(s, list) else s.get("loras", [])
                                        for item in s_list:
                                            if isinstance(item, dict) and item.get("name"):
                                                add_lora(
                                                    item["name"],
                                                    item.get("strength_model", 1.0),
                                                    item.get("strength_clip", 1.0),
                                                    item.get("enabled", True),
                                                    "AIPromptStudioLora",
                                                )
                                    except Exception:
                                        pass

                        # 1b. workflow format: { nodes: [ { type, widgets_values } ] }
                        if "nodes" in p_data and isinstance(p_data["nodes"], list):
                            for node in p_data["nodes"]:
                                if not isinstance(node, dict):
                                    continue
                                ntype = str(node.get("type", ""))
                                wv = node.get("widgets_values")
                                if isinstance(wv, list):
                                    for val in wv:
                                        if isinstance(val, list):
                                            for item in val:
                                                if isinstance(item, dict) and item.get("name") and ("strength" in item or "clipStrength" in item):
                                                    add_lora(
                                                        item["name"],
                                                        item.get("strength", 1.0),
                                                        item.get("clipStrength", item.get("strength", 1.0)),
                                                        item.get("active", True),
                                                        ntype,
                                                    )
                                        elif isinstance(val, str) and ("loras" in val or "custom_stack_json" in ntype.lower()):
                                            try:
                                                s = json.loads(val)
                                                s_list = s if isinstance(s, list) else s.get("loras", [])
                                                for item in s_list:
                                                    if isinstance(item, dict) and item.get("name"):
                                                        add_lora(
                                                            item["name"],
                                                            item.get("strength_model", item.get("strength", 1.0)),
                                                            item.get("strength_clip", item.get("clipStrength", 1.0)),
                                                            item.get("enabled", item.get("active", True)),
                                                            ntype,
                                                        )
                                            except Exception:
                                                pass
                except Exception:
                    pass

        # 2. Parse text prompts & parameters for <lora:name:strength> or <lora:name:model:clip>
        # Supports spaces, dashes, dots, and unicode in LoRA name: <lora:My Clean LoRA:0.8>
        lora_tag_pattern = re.compile(
            r'<lora:([^\r\n>:]+?)(?::(-?\d+(?:\.\d+)?))?(?::(-?\d+(?:\.\d+)?))?>',
            re.IGNORECASE,
        )
        for txt in meta_texts:
            for m in lora_tag_pattern.finditer(txt):
                name = m.group(1).strip()
                sm = float(m.group(2)) if m.group(2) else 1.0
                sc = float(m.group(3)) if m.group(3) else sm
                add_lora(name, sm, sc, True, "prompt_tag")

            # 3. Parse Civitai resources in WebUI parameters
            # e.g.: Civitai resources: [{"type":"lora","weight":0.7,"model":{"name":"..."}}]
            if "Civitai resources:" in txt:
                try:
                    civ_part = txt.split("Civitai resources:", 1)[1].strip()
                    civ_json_str = civ_part.split("\n", 1)[0].strip()
                    civ_list = json.loads(civ_json_str)
                    if isinstance(civ_list, list):
                        for item in civ_list:
                            if isinstance(item, dict) and item.get("type") == "lora":
                                model_name = item.get("modelName") or item.get("model", {}).get("name")
                                if model_name:
                                    w = item.get("weight", 1.0)
                                    add_lora(model_name, w, w, True, "civitai_resources")
                except Exception:
                    pass

    except Exception as exc:
        logger.error(f"Error extracting LoRAs from image: {exc}", exc_info=True)

    # Build suggested title and aggregated trigger words
    clean_fn = Path(filename).stem if filename else ""
    suggested_title = clean_fn.replace("_", " ").strip() if clean_fn else (
        f"{found_loras[0]['name']} 堆叠预设" if found_loras else "从图片提取的 LoRA 堆叠"
    )

    all_tws = [l["trigger_words"].strip() for l in found_loras if l.get("trigger_words")]
    aggregated_tw = ", ".join(dict.fromkeys(filter(None, all_tws)))

    return {
        "loras": found_loras,
        "suggested_name": suggested_title,
        "trigger_words": aggregated_tw,
        "thumbnail": thumbnail,
        "count": len(found_loras),
    }


class LoraPresetStore:
    """SQLite-backed store for LoRA stack presets."""

    def __init__(self, path: Path | None = None) -> None:
        if path is None:
            home = default_home()
            path = home / "lora_presets.sqlite3"
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.images_dir = self.path.parent / "lora_preset_images"
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._init_db()

    def _init_db(self) -> None:
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS lora_presets (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    category TEXT NOT NULL,
                    tags TEXT NOT NULL,
                    is_builtin INTEGER NOT NULL DEFAULT 0,
                    loras TEXT NOT NULL,
                    trigger_words TEXT NOT NULL,
                    notes TEXT,
                    thumbnail TEXT,
                    image_file TEXT,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_lora_presets_category
                    ON lora_presets(category);
                CREATE INDEX IF NOT EXISTS idx_lora_presets_updated
                    ON lora_presets(updated_at DESC);
                CREATE TABLE IF NOT EXISTS lora_categories (
                    name TEXT PRIMARY KEY,
                    created_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS deleted_builtin_loras (
                    id TEXT PRIMARY KEY
                );
                """
            )
            self._conn.commit()
            self._ensure_builtins()

    def _ensure_builtins(self) -> None:
        now = time.time()
        for p in BUILTIN_LORA_PRESETS:
            cur_del = self._conn.execute("SELECT id FROM deleted_builtin_loras WHERE id = ?", (p["id"],))
            if cur_del.fetchone() is not None:
                continue
            cur = self._conn.execute("SELECT id FROM lora_presets WHERE id = ?", (p["id"],))
            if cur.fetchone() is None:
                self._conn.execute(
                    """
                    INSERT INTO lora_presets
                    (id, name, category, tags, is_builtin, loras, trigger_words, notes, thumbnail, image_file, created_at, updated_at)
                    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        p["id"],
                        p["name"],
                        p["category"],
                        json.dumps(p.get("tags", []), ensure_ascii=False),
                        json.dumps(p.get("loras", []), ensure_ascii=False),
                        p.get("trigger_words", ""),
                        p.get("notes", ""),
                        p.get("thumbnail"),
                        p.get("image_file"),
                        now,
                        now,
                    ),
                )
        self._conn.commit()

    def reset_builtins(self) -> int:
        with self._lock:
            self._conn.execute("DELETE FROM deleted_builtin_loras")
            self._conn.commit()
            self._ensure_builtins()
            return len(BUILTIN_LORA_PRESETS)

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def _row_to_dict(self, row: sqlite3.Row) -> dict[str, Any]:
        tags = []
        try:
            tags = json.loads(row["tags"]) if row["tags"] else []
        except Exception:
            pass

        loras = []
        try:
            loras = json.loads(row["loras"]) if row["loras"] else []
        except Exception:
            pass

        return {
            "id": row["id"],
            "name": row["name"],
            "category": row["category"],
            "tags": tags,
            "is_builtin": bool(row["is_builtin"]),
            "loras": loras,
            "trigger_words": row["trigger_words"] or "",
            "notes": row["notes"] or "",
            "thumbnail": row["thumbnail"] or "",
            "image_file": row["image_file"] or "",
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def list(
        self,
        *,
        category: str | None = None,
        search: str | None = None,
    ) -> list[dict[str, Any]]:
        with self._lock:
            query = "SELECT * FROM lora_presets"
            params: list[Any] = []
            conditions: list[str] = []

            if category and category != "全部":
                conditions.append("category = ?")
                params.append(category)

            if search:
                kw = f"%{search.strip().lower()}%"
                conditions.append(
                    "(LOWER(name) LIKE ? OR LOWER(tags) LIKE ? OR LOWER(trigger_words) LIKE ? OR LOWER(loras) LIKE ? OR LOWER(notes) LIKE ?)"
                )
                params.extend([kw, kw, kw, kw, kw])

            if conditions:
                query += " WHERE " + " AND ".join(conditions)

            query += " ORDER BY updated_at DESC"
            cur = self._conn.execute(query, params)
            return [self._row_to_dict(r) for r in cur.fetchall()]

    def get(self, preset_id: str) -> dict[str, Any] | None:
        with self._lock:
            cur = self._conn.execute("SELECT * FROM lora_presets WHERE id = ?", (preset_id,))
            row = cur.fetchone()
            return self._row_to_dict(row) if row else None

    def save(self, data: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            preset_id = str(data.get("id") or "").strip()
            if not preset_id:
                preset_id = f"lora_{uuid.uuid4().hex[:12]}"

            name = str(data.get("name") or "").strip()
            if not name:
                name = "未命名 LoRA 预设"

            category = str(data.get("category") or DEFAULT_LORA_CATEGORY).strip()
            tags = data.get("tags") or []
            if not isinstance(tags, list):
                tags = [str(tags)]
            clean_tags = [str(t).strip() for t in tags if str(t).strip()]

            loras = data.get("loras") or []
            if not isinstance(loras, list):
                loras = []
            clean_loras = []
            for item in loras:
                if isinstance(item, dict):
                    clean_loras.append({
                        "name": str(item.get("name") or "").strip(),
                        "strength_model": float(item.get("strength_model", 1.0)),
                        "strength_clip": float(item.get("strength_clip", 1.0)),
                        "enabled": bool(item.get("enabled", True)),
                    })
                elif isinstance(item, (list, tuple)) and len(item) >= 1:
                    m_str = float(item[1]) if len(item) > 1 else 1.0
                    c_str = float(item[2]) if len(item) > 2 else m_str
                    clean_loras.append({
                        "name": str(item[0]).strip(),
                        "strength_model": m_str,
                        "strength_clip": c_str,
                        "enabled": True,
                    })

            trigger_words = str(data.get("trigger_words") or "").strip()
            notes = str(data.get("notes") or "").strip()

            thumbnail = data.get("thumbnail")
            image_file = data.get("image_file")
            image_data = data.get("image_data")

            if image_data:
                try:
                    raw_bytes = _decode_image_payload(image_data)
                    sniff = _sniff_image(raw_bytes)
                    ext = sniff[0] if sniff else "png"
                    sha = hashlib.sha256(raw_bytes).hexdigest()[:16]
                    img_name = f"{sha}.{ext}"
                    self.images_dir.mkdir(parents=True, exist_ok=True)
                    target_file = self.images_dir / img_name
                    if not target_file.exists():
                        target_file.write_bytes(raw_bytes)
                    image_file = img_name
                    if not thumbnail and len(raw_bytes) <= MAX_THUMBNAIL_CHARS:
                        mime = sniff[1] if sniff else "image/png"
                        thumbnail = f"data:{mime};base64,{base64.b64encode(raw_bytes).decode('ascii')}"
                except Exception:
                    pass

            now = time.time()
            existing = self.get(preset_id)
            is_builtin = int(data.get("is_builtin", False))
            if existing and existing.get("is_builtin"):
                is_builtin = 1

            if existing:
                self._conn.execute(
                    """
                    UPDATE lora_presets SET
                        name = ?,
                        category = ?,
                        tags = ?,
                        is_builtin = ?,
                        loras = ?,
                        trigger_words = ?,
                        notes = ?,
                        thumbnail = COALESCE(?, thumbnail),
                        image_file = COALESCE(?, image_file),
                        updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        name,
                        category,
                        json.dumps(clean_tags, ensure_ascii=False),
                        is_builtin,
                        json.dumps(clean_loras, ensure_ascii=False),
                        trigger_words,
                        notes,
                        thumbnail,
                        image_file,
                        now,
                        preset_id,
                    ),
                )
            else:
                self._conn.execute(
                    """
                    INSERT INTO lora_presets
                    (id, name, category, tags, is_builtin, loras, trigger_words, notes, thumbnail, image_file, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        preset_id,
                        name,
                        category,
                        json.dumps(clean_tags, ensure_ascii=False),
                        is_builtin,
                        json.dumps(clean_loras, ensure_ascii=False),
                        trigger_words,
                        notes,
                        thumbnail,
                        image_file,
                        now,
                        now,
                    ),
                )
            self._conn.commit()
            saved = self.get(preset_id)
            assert saved is not None
            return saved

    def delete(self, preset_id: str) -> bool:
        with self._lock:
            existing = self.get(preset_id)
            if not existing:
                return False
            if existing.get("is_builtin"):
                self._conn.execute(
                    "INSERT OR IGNORE INTO deleted_builtin_loras (id) VALUES (?)",
                    (preset_id,),
                )
            self._conn.execute("DELETE FROM lora_presets WHERE id = ?", (preset_id,))
            self._conn.commit()
            return True

    def categories(self) -> list[str]:
        with self._lock:
            cats = set(DEFAULT_LORA_CATEGORIES)
            for r in self._conn.execute("SELECT DISTINCT category FROM lora_presets").fetchall():
                if r[0]:
                    cats.add(r[0])
            for r in self._conn.execute("SELECT name FROM lora_categories").fetchall():
                if r[0]:
                    cats.add(r[0])
            cats.discard("全部")
            # Preserve default ordering where possible
            ordered = [c for c in DEFAULT_LORA_CATEGORIES if c in cats]
            for c in sorted(cats):
                if c not in ordered:
                    ordered.append(c)
            return ["全部"] + ordered

    def custom_categories(self) -> list[str]:
        with self._lock:
            return [r[0] for r in self._conn.execute("SELECT name FROM lora_categories ORDER BY name").fetchall()]

    def add_category(self, name: str) -> str:
        clean = clean_category_name(name)
        with self._lock:
            self._conn.execute(
                "INSERT OR IGNORE INTO lora_categories (name, created_at) VALUES (?, ?)",
                (clean, time.time()),
            )
            self._conn.commit()
        return clean

    def delete_category(self, name: str) -> dict[str, Any]:
        clean = clean_category_name(name)
        with self._lock:
            self._conn.execute("DELETE FROM lora_categories WHERE name = ?", (clean,))
            cur = self._conn.execute(
                "UPDATE lora_presets SET category = ? WHERE category = ?",
                (DEFAULT_LORA_CATEGORY, clean),
            )
            reassigned = cur.rowcount
            self._conn.commit()
        return {"deleted": clean, "reassigned_presets": reassigned}

    def rename_category(self, old_name: str, new_name: str) -> dict[str, Any]:
        old_clean = clean_category_name(old_name)
        new_clean = clean_category_name(new_name)
        with self._lock:
            self._conn.execute("DELETE FROM lora_categories WHERE name = ?", (old_clean,))
            self._conn.execute(
                "INSERT OR REPLACE INTO lora_categories (name, created_at) VALUES (?, ?)",
                (new_clean, time.time()),
            )
            cur = self._conn.execute(
                "UPDATE lora_presets SET category = ? WHERE category = ?",
                (new_clean, old_clean),
            )
            affected = cur.rowcount
            self._conn.commit()
        return {"old_name": old_clean, "new_name": new_clean, "affected_presets": affected}

    def get_image(self, preset_id: str) -> tuple[bytes, str, str] | None:
        preset = self.get(preset_id)
        if not preset:
            return None
        img_name = preset.get("image_file")
        if img_name:
            target = self.images_dir / img_name
            if target.exists() and target.is_file():
                raw = target.read_bytes()
                sniff = _sniff_image(raw)
                mime = sniff[1] if sniff else "image/png"
                return raw, mime, img_name

        thumb = preset.get("thumbnail")
        if thumb and isinstance(thumb, str) and thumb.startswith("data:"):
            try:
                raw = _decode_image_payload(thumb)
                sniff = _sniff_image(raw)
                mime = sniff[1] if sniff else "image/png"
                ext = sniff[0] if sniff else "png"
                return raw, mime, f"{preset_id}.{ext}"
            except Exception:
                pass
        return None

    def export_presets(self) -> list[dict[str, Any]]:
        return self.list()

    def import_presets(self, presets: list[dict[str, Any]]) -> dict[str, Any]:
        imported = 0
        skipped = 0
        for item in presets:
            if not isinstance(item, dict):
                skipped += 1
                continue
            try:
                self.save(item)
                imported += 1
            except Exception:
                skipped += 1
        return {"imported": imported, "skipped": skipped}
