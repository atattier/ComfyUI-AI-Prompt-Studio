"""Preset Store for ComfyUI AI Prompt Studio.

Provides persistent storage for composition drafts (stage layout boxes, sizes)
and multi-format prompts (prose, layout, danbooru), plus built-in classic
composition presets.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from . import budget
from .credentials import default_home

MAX_PRESET_IMAGE_BYTES = 20 * 1024 * 1024
MAX_THUMBNAIL_CHARS = 600_000
MAX_CATEGORY_LEN = 128
DEFAULT_CATEGORY = "通用"

BUILTIN_PRESETS: list[dict[str, Any]] = [
    {
        "id": "builtin_dual_cinematic_widescreen",
        "name": "双人对视 · 电影宽幅 (2.33:1)",
        "category": "双人互动",
        "tags": ["双人", "电影感", "宽画幅", "对峙", "对称"],
        "is_builtin": True,
        "width": 1344,
        "height": 576,
        "prompts": {
            "caption": "A cinematic widescreen 2.35:1 film still of two characters facing each other in dramatic tension. The left protagonist stands in medium-close shot, gaze fixed on the right character. The background has a shallow depth of field with subtle atmospheric lighting.",
            "layout": "Two key characters symmetrically framed on the left and right thirds of the widescreen frame, with atmospheric depth and blurred background.",
            "danbooru": "2characters, facing each other, eye contact, looking at each other, upper body, cinematic lighting, widescreen",
        },
        "draft": {
            "width": 1344,
            "height": 576,
            "summary": {"caption": "Two characters facing each other in a cinematic widescreen composition", "canvas": "single"},
            "items": [
                {"label": "背景环境", "box_2d": [0, 0, 1000, 1000], "depth": 0, "description": "Atmospheric cinematic backdrop"},
                {"label": "左侧主角", "box_2d": [120, 60, 920, 420], "depth": 1, "description": "Left character looking right"},
                {"label": "右侧主角", "box_2d": [120, 580, 920, 940], "depth": 1, "description": "Right character looking left"},
            ],
        },
    },
    {
        "id": "builtin_rule_of_thirds_portrait",
        "name": "黄金三分法 · 单人情绪肖像 (3:4)",
        "category": "单人特写",
        "tags": ["单人", "三分构图", "留白", "情绪肖像"],
        "is_builtin": True,
        "width": 896,
        "height": 1152,
        "prompts": {
            "caption": "A delicate emotional portrait of a single character positioned along the left vertical third line. Soft natural window illumination catches the facial features, leaving ample negative space on the right.",
            "layout": "Single subject aligned with the left third rule-of-thirds grid line, leaving expressive negative space on the right side.",
            "danbooru": "1girl, solo, off-center, looking aside, upper body, soft lighting, depth of field",
        },
        "draft": {
            "width": 896,
            "height": 1152,
            "summary": {"caption": "Rule of thirds portrait with character aligned to the left", "canvas": "single"},
            "items": [
                {"label": "背景留白", "box_2d": [0, 0, 1000, 1000], "depth": 0, "description": "Minimal soft environment with negative space"},
                {"label": "主体人物", "box_2d": [80, 80, 950, 620], "depth": 1, "description": "Main subject positioned on the left third"},
            ],
        },
    },
    {
        "id": "builtin_close_up_eye_focus",
        "name": "电影级极近景 · 眼神特写 (16:9)",
        "category": "单人特写",
        "tags": ["特写", "眼神", "浅景深", "电影质感"],
        "is_builtin": True,
        "width": 1280,
        "height": 720,
        "prompts": {
            "caption": "An intense cinematic extreme close-up focusing sharply on the character's expressive eyes and facial contours. Anamorphic horizontal lens flare and creamy bokeh falloff blur the hairline and background.",
            "layout": "Tight cinematic close-up framing the upper face and eyes with intense shallow depth of field.",
            "danbooru": "1girl, solo, close-up, expressive eyes, detailed face, cinematic lighting, shallow depth of field",
        },
        "draft": {
            "width": 1280,
            "height": 720,
            "summary": {"caption": "Extreme close-up framing face and eyes", "canvas": "single"},
            "items": [
                {"label": "背景散景", "box_2d": [0, 0, 1000, 1000], "depth": 0, "description": "Creamy bokeh background"},
                {"label": "面部与眼神核心", "box_2d": [60, 200, 940, 800], "depth": 1, "description": "Close-up face and eyes"},
            ],
        },
    },
    {
        "id": "builtin_epic_wide_landscape",
        "name": "广角大透视 · 史诗环境叙事 (16:9)",
        "category": "环境叙事",
        "tags": ["大场景", "广角", "渺小感", "风光叙事"],
        "is_builtin": True,
        "width": 1280,
        "height": 720,
        "prompts": {
            "caption": "An expansive wide-angle landscape where a lone character stands small in the lower center foreground, gazing out at monumental towering ancient architecture under a dramatic atmospheric sky.",
            "layout": "Grand wide landscape composition with vast environment dominating the frame and a small figure anchoring the lower scale.",
            "danbooru": "1person, solo, full body, small person, scenery, landscape, vast sky, ruins, epic composition",
        },
        "draft": {
            "width": 1280,
            "height": 720,
            "summary": {"caption": "Grand landscape with tiny character anchoring foreground scale", "canvas": "single"},
            "items": [
                {"label": "天空与远景群山", "box_2d": [0, 0, 650, 1000], "depth": 0, "description": "Distant sky and mountain peaks"},
                {"label": "中景古老遗迹", "box_2d": [250, 100, 750, 900], "depth": 1, "description": "Towering ancient ruins"},
                {"label": "前景主角", "box_2d": [620, 440, 950, 560], "depth": 2, "description": "Small focal character in the lower foreground"},
            ],
        },
    },
    {
        "id": "builtin_low_angle_dynamic",
        "name": "低角度仰拍 · 动态压迫感 (9:16)",
        "category": "动态构图",
        "tags": ["仰拍", "全身", "张力", "竖屏"],
        "is_builtin": True,
        "width": 768,
        "height": 1344,
        "prompts": {
            "caption": "A dramatic dynamic low-angle worm's-eye shot looking up at the standing subject. Powerful perspective distortion stretches the limbs and creates a towering heroic presence against the clouds.",
            "layout": "Low-angle dynamic vertical composition looking up at the figure stretching across the frame.",
            "danbooru": "1character, from below, looking down, full body, dynamic angle, dynamic pose, towering perspective",
        },
        "draft": {
            "width": 768,
            "height": 1344,
            "summary": {"caption": "Low-angle dynamic upward framing", "canvas": "single"},
            "items": [
                {"label": "天空与透视背景", "box_2d": [0, 0, 1000, 1000], "depth": 0, "description": "Upward sky and perspective lines"},
                {"label": "全身仰视主体", "box_2d": [60, 120, 980, 880], "depth": 1, "description": "Heroic towering character from low angle"},
            ],
        },
    },
    {
        "id": "builtin_isometric_topdown_overhead",
        "name": "俯视平铺 · 唯美上帝视角 (1:1)",
        "category": "单人特写",
        "tags": ["俯视", "正方形", "躺卧", "唯美"],
        "is_builtin": True,
        "width": 1024,
        "height": 1024,
        "prompts": {
            "caption": "A serene overhead birds-eye flat lay shot looking down at the character lying peacefully amidst floating flower petals and delicate fabric folds. Aesthetic symmetrical circular arrangement.",
            "layout": "Top-down overhead flat lay shot with centered figure surrounded by radial props and textures.",
            "danbooru": "1girl, lying, on back, top-down, from above, flowers, surrounded by petals, peaceful expression",
        },
        "draft": {
            "width": 1024,
            "height": 1024,
            "summary": {"caption": "Top-down flat lay with subject lying centered", "canvas": "single"},
            "items": [
                {"label": "背景织物与落花", "box_2d": [0, 0, 1000, 1000], "depth": 0, "description": "Fabric background with scattered petals"},
                {"label": "俯卧主体", "box_2d": [150, 180, 850, 820], "depth": 1, "description": "Subject lying down in the center"},
            ],
        },
    },
]


def _sniff_image(raw: bytes) -> tuple[str, str] | None:
    """Return (extension, mime) for PNG / JPEG / WEBP bytes, else None."""
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png", "image/png"
    if raw.startswith(b"\xff\xd8\xff"):
        return "jpg", "image/jpeg"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "webp", "image/webp"
    return None


def _decode_image_payload(value: Any) -> bytes:
    """Decode a data URL or bare base64 string into raw image bytes."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError("image_data must be a non-empty string.")
    text = value.strip()
    if text.startswith("data:"):
        _, _, text = text.partition(",")
    try:
        raw = base64.b64decode(text, validate=False)
    except (binascii.Error, ValueError) as err:
        raise ValueError("image_data is not valid base64.") from err
    if not raw:
        raise ValueError("image_data is empty.")
    if len(raw) > MAX_PRESET_IMAGE_BYTES:
        raise ValueError(
            f"Preset image is too large ({len(raw) // (1024 * 1024)} MB, limit "
            f"{MAX_PRESET_IMAGE_BYTES // (1024 * 1024)} MB)."
        )
    if _sniff_image(raw) is None:
        raise ValueError("Preset image must be a PNG, JPEG or WEBP file.")
    return raw


def clean_category_name(value: Any) -> str:
    raw = str(value or "").strip().replace("\\", "/")
    segments = [s.strip() for s in raw.split("/") if s.strip()]
    if not segments:
        raise ValueError("目录名称不能为空。")
    name = "/".join(segments)
    if len(name) > MAX_CATEGORY_LEN:
        raise ValueError(f"目录名称不能超过 {MAX_CATEGORY_LEN} 个字符。")
    if name == "全部":
        raise ValueError("「全部」是保留名称，请换一个目录名。")
    return name


def heuristic_title_from_prompt(prompt: str, draft: dict[str, Any] | None = None) -> str:
    """Fast local fallback to generate a 4-12 character concise title from prompt and draft."""
    clean_p = str(prompt or "").strip()
    p_lower = clean_p.lower()

    keywords: list[str] = []

    # 1. Franchise / Universe
    if "wuthering waves" in p_lower or "鸣潮" in clean_p:
        keywords.append("鸣潮")
    elif "genshin" in p_lower or "原神" in clean_p:
        keywords.append("原神")
    elif "arknights" in p_lower or "明日方舟" in clean_p:
        keywords.append("方舟")
    elif "honkai" in p_lower or "星穹铁道" in clean_p or "崩铁" in clean_p:
        keywords.append("星铁")

    # 2. Character Count / Focus
    if "2girls" in p_lower or "2characters" in p_lower or "two girls" in p_lower or "multiple girls" in p_lower:
        keywords.append("双人")
    elif "1girl" in p_lower or "1person" in p_lower or "solo" in p_lower:
        keywords.append("单人")

    # 3. Specific named characters / features
    if "suzuran" in p_lower or "铃兰" in clean_p:
        keywords.append("铃兰")

    if "horns" in p_lower or "horn" in p_lower or "角娘" in clean_p:
        keywords.append("角娘")
    elif "fox ears" in p_lower or "fox ear" in p_lower or "狐耳" in clean_p:
        keywords.append("狐耳")
    elif "cat ears" in p_lower or "nekomimi" in p_lower or "猫耳" in clean_p:
        keywords.append("猫耳")
    elif "elf" in p_lower or "pointy ears" in p_lower:
        keywords.append("精灵")

    if "kimono" in p_lower or "和服" in clean_p:
        keywords.append("和服")
    elif "swimsuit" in p_lower or "bikini" in p_lower or "泳装" in clean_p:
        keywords.append("泳装")
    elif "maid" in p_lower or "女仆" in clean_p:
        keywords.append("女仆")

    # 4. Composition / Camera
    if "low-angle" in p_lower or "low angle" in p_lower or "仰角" in clean_p or "仰拍" in clean_p:
        keywords.append("仰拍")
    elif "close-up" in p_lower or "close up" in p_lower or "特写" in clean_p:
        keywords.append("特写")
    elif "widescreen" in p_lower or "宽画幅" in clean_p or "宽幅" in clean_p:
        keywords.append("宽幅")
    elif "portrait" in p_lower or "肖像" in clean_p:
        keywords.append("肖像")

    # 5. Draft box labels if available
    items = draft.get("items") if isinstance(draft, dict) and isinstance(draft.get("items"), list) else []
    labels = [str(it.get("label") or it.get("name") or "") for it in items if isinstance(it, dict)]
    filtered_labels = [lb for lb in labels if lb and not any(ign in lb for ign in ["背景", "环境", "主体", "Region", "object", "character"])]
    for fl in filtered_labels:
        if fl not in keywords and len(fl) <= 6:
            keywords.append(fl)

    # Deduplicate while preserving order
    seen: set[str] = set()
    deduped: list[str] = []
    for k in keywords:
        if k not in seen:
            seen.add(k)
            deduped.append(k)

    if len(deduped) >= 2:
        return "·".join(deduped[:3])
    elif len(deduped) == 1:
        return f"{deduped[0]}构图" if len(deduped[0]) <= 3 else deduped[0]

    if clean_p:
        first_clause = re.split(r"[,，.\n]", clean_p)[0].strip()
        first_clause = re.sub(r"^(a|an|the)\s+", "", first_clause, flags=re.IGNORECASE).strip()
        if first_clause:
            return first_clause[:12].strip()

    return "构图预设"


def summarize_title_from_prompt(
    client: Any | None,
    prompt: str,
    *,
    draft: dict[str, Any] | None = None,
    model: str | None = None,
) -> str:
    """Summarize a 4-10 character concise Chinese title from prompt/draft using LLM or heuristic fallback."""
    clean_p = str(prompt or "").strip()
    if not clean_p and isinstance(draft, dict):
        clean_p = str(draft.get("summary", {}).get("caption") or "")

    if not clean_p:
        return "未命名构图"

    if client is not None:
        try:
            instruction = (
                "你是一个专业的 AI 视觉艺术总监。请根据以下图像提示词或构图描述，提炼出一个简短、精美、极具辨识度的【画面中文标题】。\n"
                "严格要求：\n"
                "1. 标题长度严格控制在 4 到 10 个汉字之间（例如：“双人对视·电影宽幅”、“和服铃兰·廊檐仰拍”、“金发双人角娘”、“赛博雨夜霓虹街角”）。\n"
                "2. 优先包含【核心主体/角色名】+【动作/姿态/服饰】+【视角或氛围】。\n"
                "3. 绝对只输出这一个最终中文标题，禁止包含任何引号、标点前缀、括号、序号或解释文字。"
            )
            messages = [
                {
                    "role": "user",
                    "content": [{"type": "text", "text": f"{instruction}\n\n提示词与构图信息：\n{clean_p[:1000]}"}],
                }
            ]
            result = client.complete_via_stream(
                messages,
                model=model,
                temperature=0.3,
                max_tokens=budget.TITLE_BUDGET,
                timeout=30.0,
            )
            raw_title = str(result.text or "").strip()
            raw_title = re.sub(r'["\'“”‘’《》【】\n\r`*]', "", raw_title).strip()
            if raw_title.startswith("标题：") or raw_title.startswith("画面标题："):
                raw_title = raw_title.split("：", 1)[-1].strip()
            if 2 <= len(raw_title) <= 16:
                return raw_title
        except Exception:
            pass

    return heuristic_title_from_prompt(clean_p, draft)


def _extract_embedded_layout(text: str) -> tuple[str, str, dict[str, Any] | None]:
    """Find and extract embedded JSON layout from text.

    Returns (cleaned_text_without_json, raw_json_str, parsed_dict).
    """
    if not text or "summary" not in text or "items" not in text:
        return text, "", None

    match = re.search(r'(\{[\s\S]*\"summary\"[\s\S]*\"items\"[\s\S]*\})', text)
    if not match:
        return text, "", None

    json_str = match.group(1)
    prefix = text[:match.start()].strip()
    suffix = text[match.end():].strip()
    cleaned = f"{prefix} {suffix}".strip()

    try:
        data = json.loads(json_str)
        if isinstance(data, dict) and "items" in data:
            return cleaned, json_str, data
    except Exception:
        pass
    return text, "", None


def _is_likely_danbooru(text: str) -> bool:
    """Heuristically classify whether a prompt string is Danbooru tags vs natural language prose."""
    clean = str(text or "").strip()
    if not clean:
        return False
    if "," in clean and not clean.endswith((".", "!", "?", "。", "！", "？")):
        parts = [p.strip() for p in clean.split(",") if p.strip()]
        if len(parts) >= 3:
            avg_words = sum(len(p.split()) for p in parts) / len(parts)
            if avg_words <= 4.5:
                return True
    lower = clean.lower()
    if any(tok in lower for tok in ("1girl", "2girls", "1boy", "solo,", "masterpiece,")) and not clean.endswith("."):
        return True
    return False


def _join_with_delimiter(parts: list[str], delimiter: str) -> str:
    """Join string fragments with delimiter while preventing duplicated separator punctuation."""
    clean_parts = [p.strip() for p in parts if p and p.strip()]
    if not clean_parts:
        return ""
    if not delimiter:
        return "".join(clean_parts)
    d_strip = delimiter.strip()
    result = clean_parts[0]
    for nxt in clean_parts[1:]:
        if d_strip and result.endswith(d_strip):
            if delimiter.endswith(" ") and not result.endswith(" "):
                result = f"{result} {nxt}"
            else:
                result = f"{result}{delimiter.lstrip(d_strip)}{nxt}"
        else:
            result = f"{result}{delimiter}{nxt}"
    return result


def extract_metadata_from_image(raw: bytes, filename: str = "") -> dict[str, Any]:
    """Inspect image bytes (PNG tEXt chunks, PIL info, etc.) and extract ComfyUI prompt & layout metadata

    using topology-aware backtracing across single-stage or multi-stage (1/2/3+ stage) execution pipelines.
    """
    import io
    from PIL import Image
    from .layout import parse_model_layout

    im = Image.open(io.BytesIO(raw))
    width, height = im.size

    # Generate 360px JPEG thumbnail for ultra-fast card loading
    thumb_im = im.copy()
    thumb_im.thumbnail((360, 360), Image.Resampling.LANCZOS)
    if thumb_im.mode in ("RGBA", "P"):
        thumb_im = thumb_im.convert("RGB")
    buf = io.BytesIO()
    thumb_im.save(buf, format="JPEG", quality=82)
    thumb_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    thumbnail = f"data:image/jpeg;base64,{thumb_b64}"

    caption = ""
    layout_prompt = ""
    danbooru = ""
    stages_out: list[dict[str, Any]] = []
    draft: dict[str, Any] = {"width": width, "height": height, "summary": {}, "items": []}
    tags: list[str] = ["图片导入"]

    info = getattr(im, "info", {}) or {}
    text_chunks = getattr(im, "text", {}) or {}
    all_meta = {**text_chunks, **info}

    workflow_raw = all_meta.get("workflow")
    prompt_raw = all_meta.get("prompt")

    parsed_workflow = None
    if isinstance(workflow_raw, str):
        try:
            parsed_workflow = json.loads(workflow_raw)
        except Exception:
            pass

    parsed_prompt = None
    if isinstance(prompt_raw, str):
        try:
            parsed_prompt = json.loads(prompt_raw)
        except Exception:
            pass

    found = False

    # 1. Topological backtrace on ComfyUI execution graph (parsed_prompt)
    if parsed_prompt and isinstance(parsed_prompt, dict):
        save_nodes = []
        for nid, node in parsed_prompt.items():
            if not isinstance(node, dict):
                continue
            ctype = str(node.get("class_type", ""))
            inputs = node.get("inputs", {})
            is_save = any(term in ctype for term in [
                "SaveImage", "ImageSave", "ZML_SaveImage", "SaveImageWebp",
                "CR Image Output", "SaveImageAdvanced", "SaveImageKJ", "VHS_VideoCombine",
            ])
            has_img_in = any(k in inputs for k in ["images", "image", "图像", "pixels"])
            if is_save or (has_img_in and "Preview" not in ctype):
                save_nodes.append((nid, node, 1 if is_save else 0))

        if not save_nodes:
            for nid, node in parsed_prompt.items():
                if isinstance(node, dict) and any(k in node.get("inputs", {}) for k in ["images", "image", "图像", "pixels"]):
                    save_nodes.append((nid, node, 0))

        save_nodes.sort(key=lambda x: x[2], reverse=True)

        SAMPLER_TERMS = [
            "KSampler", "SamplerCustom", "FluxSampler", "FaceDetailer",
            "DetailerForEach", "UltimateSDUpscale", "TiledDiffusion",
            "IterativeLatentUpscale", "BMAB", "ImpactKSampler",
        ]
        UPSTREAM_PIPE_KEYS = [
            "images", "image", "图像", "pixels", "samples", "latent", "latent_image",
            "samples_latent", "orig_latent", "denoised_output", "image_in",
            "input_image", "upscaled_image", "pipe", "basic_pipe", "detailer_pipe",
        ]

        def find_upstream_samplers(start_nid: str) -> list[str]:
            samplers: dict[str, int] = {}
            visited: dict[str, int] = {}
            queue: list[tuple[str, int]] = [(start_nid, 0)]
            while queue:
                curr_id, depth = queue.pop(0)
                if curr_id in visited and visited[curr_id] >= depth:
                    continue
                if curr_id not in parsed_prompt:
                    continue
                visited[curr_id] = depth
                cnode = parsed_prompt[curr_id]
                ctype = str(cnode.get("class_type", ""))
                if any(term in ctype for term in SAMPLER_TERMS):
                    samplers[curr_id] = max(samplers.get(curr_id, -1), depth)
                cinputs = cnode.get("inputs", {})
                for in_key in UPSTREAM_PIPE_KEYS:
                    val = cinputs.get(in_key)
                    if isinstance(val, list) and len(val) >= 1 and str(val[0]) in parsed_prompt:
                        queue.append((str(val[0]), depth + 1))
            # Chronological execution order: furthest upstream depth comes FIRST (Stage 1 -> N)
            return [sid for sid, _ in sorted(samplers.items(), key=lambda x: x[1], reverse=True)]

        active_samplers: list[str] = []
        for snid, _, _ in save_nodes:
            s_found = find_upstream_samplers(snid)
            if s_found:
                for sid in s_found:
                    if sid not in active_samplers:
                        active_samplers.append(sid)
                break

        if not active_samplers:
            for nid, node in parsed_prompt.items():
                if isinstance(node, dict) and any(term in str(node.get("class_type", "")) for term in SAMPLER_TERMS):
                    active_samplers.append(nid)

        def trace_text(nid: str, visited: set | None = None) -> tuple[str, dict[str, Any] | None, str]:
            if visited is None:
                visited = set()
            if nid in visited or nid not in parsed_prompt:
                return "", None, ""
            visited.add(nid)
            node = parsed_prompt[nid]
            ctype = str(node.get("class_type", ""))
            inputs = node.get("inputs", {})
            meta_title = str((node.get("_meta") or {}).get("title") or ctype).strip()

            # AIPromptStudio node on active execution chain
            if ctype in ("AIPromptStudioCaption", "AIPromptStudioImagine"):
                payload_raw = inputs.get("payload") or inputs.get("state_json")
                if isinstance(payload_raw, str):
                    try:
                        p = json.loads(payload_raw)
                        if isinstance(p, dict):
                            return "", p, meta_title
                    except Exception:
                        pass

            # ShowText / Display Any node: MUST follow input link if present to avoid stale cached widget values
            if "ShowText" in ctype or "Display" in ctype:
                text_link = inputs.get("text")
                if isinstance(text_link, list) and len(text_link) >= 1:
                    sub_t, sub_p, sub_title = trace_text(str(text_link[0]), visited)
                    return sub_t, sub_p, meta_title or sub_title
                for k in ["text_0", "text", "string"]:
                    val = inputs.get(k)
                    if isinstance(val, str) and val.strip():
                        return val.strip(), None, meta_title

            # Concatenation nodes
            if any(term in ctype for term in ["Concatenate", "Concat", "Combine"]):
                delim = str(inputs.get("delimiter") if "delimiter" in inputs else inputs.get("separator", ", "))
                parts = []
                for k in sorted(inputs.keys()):
                    if k in ("delimiter", "separator"):
                        continue
                    val = inputs[k]
                    if isinstance(val, list) and len(val) >= 1:
                        st, sp, _ = trace_text(str(val[0]), visited)
                        if sp:
                            return "", sp, meta_title
                        if st:
                            parts.append(st)
                    elif isinstance(val, str) and val.strip():
                        parts.append(val.strip())
                return _join_with_delimiter(parts, delim), None, meta_title

            # Multiline / PrimitiveStringMultiline / Text nodes
            for k in ["value", "text", "string", "prompt"]:
                val = inputs.get(k)
                if isinstance(val, list) and len(val) >= 1:
                    sub_t, sub_p, sub_title = trace_text(str(val[0]), visited)
                    return sub_t, sub_p, sub_title or meta_title
                if isinstance(val, str) and val.strip():
                    return val.strip(), None, meta_title

            return "", None, meta_title

        raw_stages: list[dict[str, Any]] = []
        seen_stage_keys: dict[str, int] = {}

        for samp_id in active_samplers:
            samp = parsed_prompt[samp_id]
            sinputs = samp.get("inputs", {})
            samp_title = str((samp.get("_meta") or {}).get("title") or samp.get("class_type") or samp_id).strip()

            pos_links: list[str] = []
            for pk in ["positive", "pos", "positive_conditioning", "conditioning", "guider", "basic_pipe", "pipe"]:
                pval = sinputs.get(pk)
                if isinstance(pval, list) and len(pval) >= 1:
                    pos_links.append(str(pval[0]))
            if not pos_links:
                continue

            cond_queue = list(pos_links)
            cond_visited = set()
            stage_prompt_entries: list[tuple[str, dict[str, Any] | None, str]] = []

            while cond_queue:
                cnid = cond_queue.pop(0)
                if cnid in cond_visited or cnid not in parsed_prompt:
                    continue
                cond_visited.add(cnid)
                cnode = parsed_prompt[cnid]
                cinputs = cnode.get("inputs", {})
                cmeta_title = str((cnode.get("_meta") or {}).get("title") or cnode.get("class_type") or "").strip()

                # Strictly follow positive conditioning & pipe combiners, avoiding 'negative'
                for ck in [
                    "conditioning", "conditioning1", "conditioning2",
                    "conditioning_1", "conditioning_2", "cond", "positive",
                    "basic_pipe", "pipe",
                ]:
                    cval = cinputs.get(ck)
                    if isinstance(cval, list) and len(cval) >= 1:
                        cond_queue.append(str(cval[0]))

                for tk in ["text", "prompt", "text_positive", "text_g", "text_l", "clip_l", "t5xxl"]:
                    tval = cinputs.get(tk)
                    if isinstance(tval, list) and len(tval) >= 1:
                        txt, pld, src_title = trace_text(str(tval[0]))
                        title_to_use = (
                            cmeta_title
                            if "CLIPTextEncode" in str(cnode.get("class_type", "")) and cmeta_title != "CLIPTextEncode"
                            else (src_title or cmeta_title or samp_title)
                        )
                        if pld or (txt and not txt.startswith("embedding:")):
                            stage_prompt_entries.append((txt, pld, title_to_use))
                    elif isinstance(tval, str) and tval.strip() and not tval.strip().startswith("embedding:"):
                        stage_prompt_entries.append((tval.strip(), None, cmeta_title or samp_title))

            for raw_txt, pld, node_title in stage_prompt_entries:
                dedup_key = json.dumps(pld, sort_keys=True) if pld else raw_txt
                if dedup_key in seen_stage_keys:
                    existing_idx = seen_stage_keys[dedup_key]
                    if samp_id not in raw_stages[existing_idx]["sampler_ids"]:
                        raw_stages[existing_idx]["sampler_ids"].append(samp_id)
                    continue

                st_idx = len(raw_stages) + 1
                st_obj: dict[str, Any] = {
                    "index": st_idx,
                    "sampler_ids": [samp_id],
                    "title": node_title or f"第 {st_idx} 段",
                    "raw_text": raw_txt,
                    "caption": "",
                    "danbooru": "",
                    "layout_json": "",
                    "draft": None,
                    "format": "caption",
                }

                if pld:
                    picked_draft = (
                        pld.get("draft")
                        or pld.get("hybrid_draft")
                        or pld.get("layout_draft")
                    )
                    sum_cap = (
                        picked_draft.get("summary", {}).get("caption")
                        if isinstance(picked_draft, dict) and isinstance(picked_draft.get("summary"), dict)
                        else ""
                    )
                    st_obj["caption"] = str(pld.get("caption_text") or pld.get("caption") or sum_cap or "")
                    st_obj["layout_json"] = str(pld.get("layout_prompt") or pld.get("compiled_layout_prompt") or "")
                    st_obj["danbooru"] = str(
                        pld.get("danbooru_prompt")
                        or pld.get("danbooru_text")
                        or pld.get("danbooru")
                        or ""
                    )
                    if isinstance(picked_draft, dict):
                        st_obj["draft"] = picked_draft
                    st_obj["format"] = (
                        "hybrid"
                        if st_obj["draft"]
                        else ("danbooru" if st_obj["danbooru"] and not st_obj["caption"] else "caption")
                    )
                else:
                    cleaned_text, raw_json, _ = _extract_embedded_layout(raw_txt)
                    if raw_json:
                        st_obj["layout_json"] = raw_json
                        try:
                            parsed_d = parse_model_layout(raw_json, width=width, height=height)
                            if parsed_d and parsed_d.get("items"):
                                st_obj["draft"] = parsed_d
                                st_obj["caption"] = parsed_d.get("summary", {}).get("caption", "")
                        except Exception:
                            pass
                    if cleaned_text:
                        if _is_likely_danbooru(cleaned_text):
                            st_obj["danbooru"] = cleaned_text
                        elif not st_obj["caption"]:
                            st_obj["caption"] = cleaned_text
                        else:
                            st_obj["caption"] = f"{st_obj['caption']}\n{cleaned_text}"

                    if st_obj["draft"] or st_obj["layout_json"]:
                        st_obj["format"] = "hybrid" if (st_obj["danbooru"] or st_obj["caption"]) else "layout"
                    elif st_obj["danbooru"]:
                        st_obj["format"] = "danbooru"
                    else:
                        st_obj["format"] = "caption"

                seen_stage_keys[dedup_key] = len(raw_stages)
                raw_stages.append(st_obj)

        if raw_stages:
            for st in raw_stages:
                if not danbooru and st["danbooru"]:
                    danbooru = st["danbooru"]
                if not caption and st["caption"]:
                    caption = st["caption"]
                if not layout_prompt and st["layout_json"]:
                    layout_prompt = st["layout_json"]
                if not draft.get("items") and isinstance(st.get("draft"), dict) and st["draft"].get("items"):
                    draft = st["draft"]
                    if "AI画框" not in tags:
                        tags.append("AI画框")
                elif isinstance(st.get("draft"), dict) and not draft.get("items"):
                    draft = st["draft"]
                    if "AI画框" not in tags:
                        tags.append("AI画框")

                stages_out.append({
                    "index": st["index"],
                    "sampler_ids": st["sampler_ids"],
                    "title": st["title"],
                    "format": st["format"],
                    "caption": st["caption"],
                    "danbooru": st["danbooru"],
                    "layout_json": st["layout_json"],
                    "has_layout": bool(st["layout_json"] or (isinstance(st.get("draft"), dict) and st["draft"].get("items"))),
                    "raw_text": st["raw_text"],
                })

            if len(stages_out) >= 3:
                tags.append(f"{len(stages_out)}段工作流")
            found = bool(caption or danbooru or layout_prompt or stages_out)

    # 2. Backtrace workflow links if execution prompt was absent or yielded no text
    if not found and parsed_workflow and isinstance(parsed_workflow, dict):
        all_wf_nodes = [n for n in parsed_workflow.get("nodes", []) if isinstance(n, dict)]
        wf_nodes = {n["id"]: n for n in all_wf_nodes if "id" in n}
        wf_links = {l[0]: l for l in parsed_workflow.get("links", []) if isinstance(l, list) and len(l) >= 4}

        wf_save_nodes = [
            n for n in wf_nodes.values()
            if any(term in str(n.get("type", "")) for term in ["SaveImage", "ImageSave", "ZML_SaveImage", "SaveImageWebp"])
        ]
        if not wf_save_nodes:
            wf_save_nodes = [
                n for n in wf_nodes.values()
                if "Save" in str(n.get("type", "")) or "Output" in str(n.get("type", ""))
            ]

        candidate_nodes: list[dict[str, Any]] = []
        if wf_save_nodes and wf_links:
            def wf_trace_upstream(nid: int | str, visited: set | None = None) -> list[dict[str, Any]]:
                if visited is None:
                    visited = set()
                if nid in visited or nid not in wf_nodes:
                    return []
                visited.add(nid)
                node = wf_nodes[nid]
                res = [node]
                for inp in node.get("inputs", []):
                    link_id = inp.get("link")
                    if link_id and link_id in wf_links:
                        origin_nid = wf_links[link_id][1]
                        res.extend(wf_trace_upstream(origin_nid, visited))
                return res

            for sn in wf_save_nodes:
                candidate_nodes.extend(wf_trace_upstream(sn["id"]))
        else:
            candidate_nodes = all_wf_nodes

        for an in candidate_nodes:
            if str(an.get("type") or an.get("comfyClass") or "") in ("AIPromptStudioCaption", "AIPromptStudioImagine"):
                wv = an.get("widgets_values")
                if isinstance(wv, list):
                    for v in wv:
                        if isinstance(v, str) and ("caption" in v or "draft" in v):
                            try:
                                payload = json.loads(v)
                                if isinstance(payload, dict):
                                    picked_draft = (
                                        payload.get("draft")
                                        or payload.get("hybrid_draft")
                                        or payload.get("layout_draft")
                                    )
                                    sum_cap = (
                                        picked_draft.get("summary", {}).get("caption")
                                        if isinstance(picked_draft, dict)
                                        and isinstance(picked_draft.get("summary"), dict)
                                        else ""
                                    )
                                    caption = str(
                                        payload.get("caption_text")
                                        or payload.get("caption")
                                        or sum_cap
                                        or ""
                                    )
                                    layout_prompt = str(
                                        payload.get("layout_prompt")
                                        or payload.get("compiled_layout_prompt")
                                        or ""
                                    )
                                    danbooru = str(
                                        payload.get("danbooru_prompt")
                                        or payload.get("danbooru_text")
                                        or payload.get("danbooru")
                                        or ""
                                    )
                                    if isinstance(picked_draft, dict):
                                        draft = picked_draft
                                    tags.append("AI画框")
                                    found = True
                                    break
                            except Exception:
                                pass
                if found:
                    break

    # 3. Fallback: A1111 parameters chunk
    if not caption and not danbooru and "parameters" in all_meta:
        params_str = str(all_meta["parameters"])
        lines = params_str.split("\n")
        caption = lines[0].strip()

    if not draft.get("items"):
        draft = {
            "width": width,
            "height": height,
            "summary": {"caption": caption or danbooru or (Path(filename).stem if filename else "图片预设")},
            "items": [],
        }

    clean_base = Path(filename).stem if filename else ""
    is_timestamp_or_digits = clean_base.isdigit() or bool(re.match(r"^\d{8,16}$", clean_base))
    if clean_base.lower().startswith("comfyui_") or is_timestamp_or_digits or not clean_base:
        full_text = f"{danbooru} {caption}".strip() or draft.get("summary", {}).get("caption", "")
        clean_base = heuristic_title_from_prompt(full_text, draft)

    prompts_dict: dict[str, Any] = {
        "caption": caption,
        "layout": layout_prompt,
        "danbooru": danbooru,
    }
    if stages_out:
        prompts_dict["stages"] = stages_out

    return {
        "name": clean_base,
        "width": width,
        "height": height,
        "thumbnail": thumbnail,
        "prompts": prompts_dict,
        "draft": draft,
        "tags": tags,
    }


class PresetStore:
    """SQLite-backed store for composition & prompt presets."""

    def __init__(self, path: Path | None = None) -> None:
        if path is None:
            home = default_home()
            path = home / "presets.sqlite3"
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.images_dir = self.path.parent / "preset_images"
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._init_db()

    def _init_db(self) -> None:
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS presets (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    category TEXT NOT NULL,
                    tags TEXT NOT NULL,
                    is_builtin INTEGER NOT NULL DEFAULT 0,
                    width INTEGER NOT NULL,
                    height INTEGER NOT NULL,
                    prompts TEXT NOT NULL,
                    draft TEXT NOT NULL,
                    thumbnail TEXT,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_presets_category
                    ON presets(category);
                CREATE INDEX IF NOT EXISTS idx_presets_updated
                    ON presets(updated_at DESC);
                CREATE TABLE IF NOT EXISTS preset_categories (
                    name TEXT PRIMARY KEY,
                    created_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS deleted_builtins (
                    id TEXT PRIMARY KEY
                );
                """
            )
            columns = {row["name"] for row in self._conn.execute("PRAGMA table_info(presets)")}
            if "image_file" not in columns:
                self._conn.execute("ALTER TABLE presets ADD COLUMN image_file TEXT")
            self._conn.commit()
            self._ensure_builtins()

    def _ensure_builtins(self) -> None:
        now = time.time()
        for p in BUILTIN_PRESETS:
            cur_del = self._conn.execute("SELECT id FROM deleted_builtins WHERE id = ?", (p["id"],))
            if cur_del.fetchone() is not None:
                continue
            cur = self._conn.execute("SELECT id FROM presets WHERE id = ?", (p["id"],))
            if cur.fetchone() is None:
                self._conn.execute(
                    """
                    INSERT INTO presets
                    (id, name, category, tags, is_builtin, width, height, prompts, draft, thumbnail, created_at, updated_at)
                    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        p["id"],
                        p["name"],
                        p["category"],
                        json.dumps(p.get("tags", []), ensure_ascii=False),
                        p.get("width", 1024),
                        p.get("height", 1024),
                        json.dumps(p.get("prompts", {}), ensure_ascii=False),
                        json.dumps(p.get("draft", {}), ensure_ascii=False),
                        p.get("thumbnail"),
                        now,
                        now,
                    ),
                )
        self._conn.commit()

    def reset_builtins(self) -> int:
        """Restore all deleted built-in presets."""
        with self._lock:
            self._conn.execute("DELETE FROM deleted_builtins")
            self._conn.commit()
            self._ensure_builtins()
            return len(BUILTIN_PRESETS)

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def list(self, *, category: str | None = None, search: str | None = None) -> list[dict[str, Any]]:
        query = "SELECT * FROM presets"
        params: list[Any] = []
        conditions: list[str] = []

        if category and category.strip() and category.strip() != "全部":
            cat = category.strip()
            # Exact category or child subcategory (e.g. "人物" or "人物/单人")
            conditions.append("(category = ? OR category LIKE ?)")
            params.extend([cat, f"{cat}/%"])

        if search and search.strip():
            kw = f"%{search.strip()}%"
            conditions.append("(name LIKE ? OR category LIKE ? OR tags LIKE ? OR prompts LIKE ?)")
            params.extend([kw, kw, kw, kw])

        if conditions:
            query += " WHERE " + " AND ".join(conditions)

        # Built-in or pinned order: built-ins first or by updated_at desc
        query += " ORDER BY is_builtin DESC, updated_at DESC"

        with self._lock:
            rows = self._conn.execute(query, params).fetchall()
            return [self._row_to_dict(r) for r in rows]

    def get(self, preset_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM presets WHERE id = ?", (preset_id,)).fetchone()
            return self._row_to_dict(row) if row else None

    def save(self, data: dict[str, Any]) -> dict[str, Any]:
        preset_id = str(data.get("id") or "").strip()
        now = time.time()
        is_new = False
        if not preset_id:
            preset_id = f"preset_{int(now * 1000)}_{uuid.uuid4().hex[:6]}"
            is_new = True

        name = str(data.get("name") or "未命名构图预设").strip()
        raw_cat = data.get("category")
        try:
            category = clean_category_name(raw_cat) if raw_cat and str(raw_cat).strip() else DEFAULT_CATEGORY
        except ValueError:
            category = DEFAULT_CATEGORY
        tags = data.get("tags") or []
        if isinstance(tags, str):
            tags = [t.strip() for t in tags.split(",") if t.strip()]

        width = int(data.get("width") or 1024)
        height = int(data.get("height") or 1024)

        prompts = data.get("prompts") or {}
        if not isinstance(prompts, dict):
            prompts = {"caption": str(prompts)}

        draft = data.get("draft") or {}
        if not isinstance(draft, dict):
            draft = {}

        thumbnail = data.get("thumbnail")
        if thumbnail and not isinstance(thumbnail, str):
            thumbnail = None
        if thumbnail and len(thumbnail) > MAX_THUMBNAIL_CHARS:
            raise ValueError("Preset thumbnail is too large.")

        image_raw: bytes | None = None
        if data.get("image_data"):
            image_raw = _decode_image_payload(data.get("image_data"))

        with self._lock:
            existing = self._conn.execute(
                "SELECT created_at, is_builtin, image_file FROM presets WHERE id = ?", (preset_id,)
            ).fetchone()
            image_file = existing["image_file"] if existing else None
            if image_raw is not None:
                image_file = self._write_image(preset_id, image_raw, previous=image_file)
            elif data.get("remove_image") and image_file:
                self._remove_image_file(image_file)
                image_file = None
            if existing:
                created_at = existing["created_at"]
                is_builtin = existing["is_builtin"]
                self._conn.execute(
                    """
                    UPDATE presets
                    SET name = ?, category = ?, tags = ?, width = ?, height = ?,
                        prompts = ?, draft = ?, thumbnail = ?, image_file = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        name,
                        category,
                        json.dumps(tags, ensure_ascii=False),
                        width,
                        height,
                        json.dumps(prompts, ensure_ascii=False),
                        json.dumps(draft, ensure_ascii=False),
                        thumbnail,
                        image_file,
                        now,
                        preset_id,
                    ),
                )
            else:
                created_at = now
                is_builtin = int(bool(data.get("is_builtin", 0)))
                self._conn.execute(
                    """
                    INSERT INTO presets
                    (id, name, category, tags, is_builtin, width, height, prompts, draft, thumbnail, image_file, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        preset_id,
                        name,
                        category,
                        json.dumps(tags, ensure_ascii=False),
                        is_builtin,
                        width,
                        height,
                        json.dumps(prompts, ensure_ascii=False),
                        json.dumps(draft, ensure_ascii=False),
                        thumbnail,
                        image_file,
                        created_at,
                        now,
                    ),
                )
            self._conn.commit()

        return self.get(preset_id) or {}

    # ---------------------------------------------------------------- images
    def _image_basename(self, preset_id: str) -> str:
        return hashlib.sha1(preset_id.encode("utf-8")).hexdigest()[:24]

    def _write_image(self, preset_id: str, raw: bytes, *, previous: str | None) -> str:
        sniffed = _sniff_image(raw)
        if sniffed is None:  # defensive: callers already validated
            raise ValueError("Preset image must be a PNG, JPEG or WEBP file.")
        ext, _mime = sniffed
        self.images_dir.mkdir(parents=True, exist_ok=True)
        filename = f"{self._image_basename(preset_id)}.{ext}"
        (self.images_dir / filename).write_bytes(raw)
        if previous and previous != filename:
            self._remove_image_file(previous)
        return filename

    def _remove_image_file(self, filename: str | None) -> None:
        if not filename:
            return
        target = (self.images_dir / Path(filename).name)
        try:
            target.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            pass

    def get_image(self, preset_id: str) -> tuple[bytes, str, str] | None:
        """Return (bytes, mime, filename) of the original image attached to a preset."""
        with self._lock:
            row = self._conn.execute("SELECT image_file FROM presets WHERE id = ?", (preset_id,)).fetchone()
        if not row or not row["image_file"]:
            return None
        filename = Path(row["image_file"]).name
        path = self.images_dir / filename
        try:
            raw = path.read_bytes()
        except OSError:
            return None
        sniffed = _sniff_image(raw)
        return raw, (sniffed[1] if sniffed else "application/octet-stream"), filename

    def delete(self, preset_id: str) -> bool:
        with self._lock:
            row = self._conn.execute(
                "SELECT is_builtin, image_file FROM presets WHERE id = ?", (preset_id,)
            ).fetchone()
            if not row:
                return False
            if row["is_builtin"]:
                self._conn.execute(
                    "INSERT OR REPLACE INTO deleted_builtins (id) VALUES (?)", (preset_id,)
                )
            self._conn.execute("DELETE FROM presets WHERE id = ?", (preset_id,))
            self._conn.commit()
            self._remove_image_file(row["image_file"])
            return True

    # ------------------------------------------------------------ categories
    def categories(self) -> list[str]:
        with self._lock:
            used = [
                r["category"]
                for r in self._conn.execute("SELECT DISTINCT category FROM presets ORDER BY category ASC")
                if r["category"]
            ]
            created = [
                r["name"]
                for r in self._conn.execute("SELECT name FROM preset_categories ORDER BY created_at ASC")
            ]
        cats: list[str] = []
        for raw in [DEFAULT_CATEGORY, *used, *created]:
            if not raw:
                continue
            parts = str(raw).split("/")
            accum = ""
            for p in parts:
                accum = f"{accum}/{p}" if accum else p
                if accum and accum not in cats:
                    cats.append(accum)
        return cats

    def custom_categories(self) -> list[str]:
        """Categories that can be managed or deleted (everything except root DEFAULT_CATEGORY)."""
        return [c for c in self.categories() if c != DEFAULT_CATEGORY]

    def add_category(self, name: Any) -> list[str]:
        clean = clean_category_name(name)
        parts = clean.split("/")
        now = time.time()
        with self._lock:
            accum = ""
            for p in parts:
                accum = f"{accum}/{p}" if accum else p
                self._conn.execute(
                    "INSERT OR IGNORE INTO preset_categories (name, created_at) VALUES (?, ?)",
                    (accum, now),
                )
            self._conn.commit()
        return self.categories()

    def rename_category(self, old_name: Any, new_name: Any) -> dict[str, Any]:
        old_cleaned = clean_category_name(old_name)
        new_cleaned = clean_category_name(new_name)
        if old_cleaned == DEFAULT_CATEGORY:
            raise ValueError("「通用」目录不能重命名。")
        if new_cleaned.startswith(old_cleaned + "/"):
            raise ValueError("不能将目录移动到自身的子目录下。")
        if old_cleaned == new_cleaned:
            return {"renamed": 0, "categories": self.categories()}

        now = time.time()
        with self._lock:
            # 1. Ensure new_cleaned (and its ancestors) exist in preset_categories
            accum = ""
            for p in new_cleaned.split("/"):
                accum = f"{accum}/{p}" if accum else p
                self._conn.execute(
                    "INSERT OR IGNORE INTO preset_categories (name, created_at) VALUES (?, ?)",
                    (accum, now),
                )

            # 2. Migrate any child categories in preset_categories without PK collisions
            sub_cats = self._conn.execute(
                "SELECT name, created_at FROM preset_categories WHERE name LIKE ?",
                (f"{old_cleaned}/%",),
            ).fetchall()
            for r in sub_cats:
                cname = r["name"]
                new_cname = new_cleaned + cname[len(old_cleaned):]
                self._conn.execute(
                    "INSERT OR IGNORE INTO preset_categories (name, created_at) VALUES (?, ?)",
                    (new_cname, r["created_at"] or now),
                )
            self._conn.execute(
                "DELETE FROM preset_categories WHERE name = ? OR name LIKE ?",
                (old_cleaned, f"{old_cleaned}/%"),
            )

            # 3. Update presets exact & children
            self._conn.execute(
                "UPDATE presets SET category = ? WHERE category = ?",
                (new_cleaned, old_cleaned),
            )
            p_rows = self._conn.execute(
                "SELECT id, category FROM presets WHERE category LIKE ?",
                (f"{old_cleaned}/%",),
            ).fetchall()
            for pr in p_rows:
                p_cat = pr["category"]
                new_p_cat = new_cleaned + p_cat[len(old_cleaned):]
                self._conn.execute(
                    "UPDATE presets SET category = ? WHERE id = ?",
                    (new_p_cat, pr["id"]),
                )

            self._conn.commit()

        return {
            "renamed": 1,
            "old_name": old_cleaned,
            "new_name": new_cleaned,
            "categories": self.categories(),
        }

    def delete_category(self, name: Any) -> dict[str, Any]:
        clean = clean_category_name(name)
        if clean == DEFAULT_CATEGORY:
            raise ValueError("「通用」目录不能删除。")

        with self._lock:
            cur = self._conn.execute(
                "SELECT name FROM preset_categories WHERE name = ? OR name LIKE ?",
                (clean, f"{clean}/%"),
            )
            found = [r["name"] for r in cur.fetchall()]
            moved_cur = self._conn.execute(
                "SELECT COUNT(*) as c FROM presets WHERE category = ? OR category LIKE ?",
                (clean, f"{clean}/%"),
            )
            moved_count = moved_cur.fetchone()["c"]
            if not found and moved_count == 0:
                raise KeyError(f"目录「{clean}」不存在。")

            parts = clean.split("/")
            parent_cat = "/".join(parts[:-1]) if len(parts) > 1 else DEFAULT_CATEGORY
            if not parent_cat:
                parent_cat = DEFAULT_CATEGORY

            self._conn.execute(
                "UPDATE presets SET category = ? WHERE category = ? OR category LIKE ?",
                (parent_cat, clean, f"{clean}/%"),
            )
            self._conn.execute(
                "DELETE FROM preset_categories WHERE name = ? OR name LIKE ?",
                (clean, f"{clean}/%"),
            )
            self._conn.commit()

        return {"deleted": clean, "moved_presets": moved_count, "fallback_category": parent_cat}

    def import_from_image(
        self, raw: bytes, filename: str = "", category: str = DEFAULT_CATEGORY
    ) -> dict[str, Any]:
        """Create a new preset directly by extracting prompt/workflow metadata from an image."""
        sniffed = _sniff_image(raw)
        if sniffed is None:
            raise ValueError("导入的图片必须是 PNG、JPEG 或 WEBP 格式。")
        _ext, mime = sniffed
        meta = extract_metadata_from_image(raw, filename)
        cleaned_cat = clean_category_name(category) if category else DEFAULT_CATEGORY
        self.add_category(cleaned_cat)
        save_data = {
            "name": meta["name"],
            "category": cleaned_cat,
            "tags": meta.get("tags") or ["图片导入"],
            "width": meta["width"],
            "height": meta["height"],
            "prompts": meta["prompts"],
            "draft": meta["draft"],
            "thumbnail": meta["thumbnail"],
            "image_data": f"data:{mime};base64," + base64.b64encode(raw).decode("ascii"),
        }
        return self.save(save_data)

    def export_all(self) -> list[dict[str, Any]]:
        return self.list()

    def import_presets(self, items: list[dict[str, Any]]) -> int:
        count = 0
        for item in items:
            if not isinstance(item, dict):
                continue
            item = dict(item)
            item.pop("is_builtin", None)  # 导入的预设视为用户自定义预设
            item.pop("image_data", None)  # 导入文件不携带原图
            item.pop("remove_image", None)
            if item.get("category"):
                try:
                    self.add_category(item["category"])
                except ValueError:
                    item["category"] = DEFAULT_CATEGORY
            if not item.get("id") or self.get(item["id"]):
                item["id"] = f"preset_{int(time.time() * 1000)}_{uuid.uuid4().hex[:6]}"
            self.save(item)
            count += 1
        return count

    def summarize_preset_title(
        self, preset_id: str, client: Any | None = None, model: str | None = None
    ) -> dict[str, Any]:
        """Summarize a concise Chinese title for the preset and save it."""
        preset = self.get(preset_id)
        if not preset:
            raise KeyError(f"Preset {preset_id} not found.")
        prompt = (
            preset.get("prompts", {}).get("caption")
            or preset.get("prompts", {}).get("danbooru")
            or preset.get("draft", {}).get("summary", {}).get("caption")
            or ""
        )
        new_title = summarize_title_from_prompt(client, prompt, draft=preset.get("draft"), model=model)
        with self._lock:
            self._conn.execute(
                "UPDATE presets SET name = ?, updated_at = ? WHERE id = ?",
                (new_title, time.time(), preset_id),
            )
            self._conn.commit()
        return self.get(preset_id) or {}

    def reload_preset_metadata(self, preset_id: str) -> dict[str, Any]:
        """Re-extract original prompt & layout metadata from the preset's image using topological backtracing."""
        preset = self.get(preset_id)
        if not preset:
            raise KeyError(f"Preset {preset_id} not found.")

        raw_info = self.get_image(preset_id)
        raw_bytes = raw_info[0] if raw_info else None
        if not raw_bytes and preset.get("thumbnail") and str(preset["thumbnail"]).startswith("data:"):
            try:
                _header, encoded = preset["thumbnail"].split(",", 1)
                raw_bytes = base64.b64decode(encoded)
            except Exception:
                raw_bytes = None

        if not raw_bytes:
            raise ValueError(f"预设「{preset['name']}」没有关联可重新解析的原图文件。")

        meta = extract_metadata_from_image(raw_bytes, filename=preset.get("name") or "")

        save_data = {
            "id": preset_id,
            "name": meta["name"] or preset["name"],
            "category": preset.get("category") or DEFAULT_CATEGORY,
            "tags": meta.get("tags") or ["图片导入"],
            "width": meta["width"],
            "height": meta["height"],
            "prompts": meta["prompts"],
            "draft": meta["draft"],
            "thumbnail": meta["thumbnail"],
        }
        return self.save(save_data)

    def re_caption_preset(
        self, preset_id: str, backend: Any, model: str | None = None
    ) -> dict[str, Any]:
        """Re-analyze the preset's image with multimodal AI vision to regenerate prompts & layout."""
        preset = self.get(preset_id)
        if not preset:
            raise KeyError(f"Preset {preset_id} not found.")

        raw_info = self.get_image(preset_id)
        raw_bytes = raw_info[0] if raw_info else None
        if not raw_bytes and preset.get("thumbnail") and str(preset["thumbnail"]).startswith("data:"):
            try:
                _header, encoded = preset["thumbnail"].split(",", 1)
                raw_bytes = base64.b64decode(encoded)
            except Exception:
                raw_bytes = None

        if not raw_bytes:
            raise ValueError(f"预设「{preset['name']}」没有关联可分析的原图文件。")

        from .caption import caption_image
        from .layout import parse_model_layout

        part = {"data": raw_bytes, "mime": "image/png"}
        cap_model = model or backend.settings.model

        # 1. 散文反推
        prose_res = caption_image(
            backend.client,
            part,
            fmt="prose",
            model=cap_model,
        )
        caption_text = str(prose_res.text or "").strip()

        # 2. 布局画框反推
        layout_text = ""
        new_draft = preset.get("draft") or {}
        try:
            layout_res = caption_image(
                backend.client,
                part,
                fmt="layout",
                model=cap_model,
                extra_instruction=caption_text,
            )
            layout_text = str(layout_res.text or "").strip()
            parsed_draft = parse_model_layout(
                layout_text,
                width=preset.get("width") or 1024,
                height=preset.get("height") or 1024,
            )
            if parsed_draft and parsed_draft.get("items"):
                new_draft = parsed_draft
        except Exception:
            pass

        # 3. Danbooru 反推
        danbooru_text = ""
        try:
            dan_res = caption_image(
                backend.client,
                part,
                fmt="danbooru",
                model=cap_model,
            )
            danbooru_text = str(dan_res.text or "").strip()
        except Exception:
            pass

        # 4. 自动根据新反推的提示词精炼标题
        new_title = summarize_title_from_prompt(
            backend.client,
            caption_text or danbooru_text,
            draft=new_draft,
            model=cap_model,
        )

        # 5. 更新并保存
        new_tags = list(preset.get("tags") or [])
        if "AI重新解读" not in new_tags:
            new_tags.append("AI重新解读")

        save_data = {
            "id": preset_id,
            "name": new_title or preset["name"],
            "category": preset.get("category") or DEFAULT_CATEGORY,
            "tags": new_tags,
            "width": preset.get("width") or 1024,
            "height": preset.get("height") or 1024,
            "prompts": {
                "caption": caption_text or preset.get("prompts", {}).get("caption", ""),
                "layout": layout_text or preset.get("prompts", {}).get("layout", ""),
                "danbooru": danbooru_text or preset.get("prompts", {}).get("danbooru", ""),
            },
            "draft": new_draft,
            "thumbnail": preset.get("thumbnail"),
        }
        return self.save(save_data)

    def _row_to_dict(self, row: sqlite3.Row) -> dict[str, Any]:
        tags = []
        try:
            tags = json.loads(row["tags"]) if row["tags"] else []
        except Exception:
            pass

        prompts = {}
        try:
            prompts = json.loads(row["prompts"]) if row["prompts"] else {}
        except Exception:
            pass

        draft = {}
        try:
            draft = json.loads(row["draft"]) if row["draft"] else {}
        except Exception:
            pass

        return {
            "id": row["id"],
            "name": row["name"],
            "category": row["category"],
            "tags": tags,
            "is_builtin": bool(row["is_builtin"]),
            "width": int(row["width"]),
            "height": int(row["height"]),
            "prompts": prompts,
            "draft": draft,
            "thumbnail": row["thumbnail"],
            "has_image": bool(row["image_file"]),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }
