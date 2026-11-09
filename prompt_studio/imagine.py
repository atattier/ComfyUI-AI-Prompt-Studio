"""Idea → image prompt ("灵感生成") & Autonomous Ideation ("自主想点子").

Complete creative pipeline:
1. ``brainstorm_ideas``: Model dreams up unique, creative concept ideas on its own
   ("模型自己想点子"), with optional theme directions.
2. ``imagine_candidates``: An idea → N distinct visual compositions (camera framing,
   spatial depth, viewer-relative orientation, materials, lighting) as JSON.
3. ``expand_candidate``: Adopted prompt → node payload synchronized to all active modes
   (caption prose, MOSS-Image layout BBox draft, Danbooru tags).
4. ``auto_imagine_pipeline``: End-to-end zero-intervention automatic chain
   (brainstorm if empty -> imagine scene -> expand to layout & tags).
"""

from __future__ import annotations

import copy
import json
import re
from typing import Any, Callable, Sequence

from .caption import _clean, _INSTRUCTIONS
from .layout import match_canvas_size, parse_model_layout

STYLES: dict[str, str] = {
    "auto": "",
    "anime": "Japanese anime / illustration style with clean linework and cel or painterly shading.",
    "realistic": "Photorealistic photography with believable optics, natural skin and material textures.",
    "cinematic": "Cinematic film still: deliberate framing, lens choice, motivated lighting and color grading.",
    "illustration": "Polished digital illustration / concept art with painterly rendering.",
    "3d": "High-quality 3D render with physically based materials and global illumination.",
}

ASPECTS: dict[str, tuple[int, int]] = {
    "square": (1024, 1024),
    "portrait": (832, 1216),
    "landscape": (1216, 832),
}

THEMES: dict[str, str] = {
    "random": "任意富有想象力与视觉张力的题材，打破常规，拒绝平庸",
    "cyberpunk": "赛博朋克 / 未来高科技 / 霓虹光影与机甲义体",
    "fantasy": "史诗奇幻 / 魔法异世界 / 幻想生灵、神迹与古老遗迹",
    "cinematic": "电影故事感镜头 / 强叙事性 / 绝美光影与人物情绪张力",
    "anime": "精美二次元动漫美学 / 唯美通透采光 / 独特服饰与角色魅力",
    "surreal": "超现实主义与梦境奇观 / 意象碰撞 / 颠覆常理的时空重构",
    "nature": "壮丽自然地理 / 废墟与植被共生 / 绝美天象与气象光影",
}

MAX_CANDIDATES = 4
MAX_IDEA_CHARS = 1000

ModelCall = Callable[[str, int, float], str]


def aspect_size(aspect: str) -> tuple[int, int]:
    """Map an aspect keyword to an official-compatible MOSS canvas size."""
    w, h = ASPECTS.get(str(aspect or "").strip().lower(), ASPECTS["square"])
    return match_canvas_size(w, h)


def _extract_json(raw: str) -> Any:
    text = str(raw or "").strip()
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", text, flags=re.DOTALL | re.IGNORECASE)
    if fence:
        text = fence.group(1).strip()
    starts = [i for i in (text.find("{"), text.find("[")) if i >= 0]
    if starts:
        text = text[min(starts):]
    end = max(text.rfind("}"), text.rfind("]"))
    if end >= 0:
        text = text[: end + 1]
    return json.loads(text)


# ==============================================================================
# 1. Autonomous Ideation: Model Dreams Up Ideas ("模型自己想点子")
# ==============================================================================

def brainstorm_instruction(
    *,
    theme: str = "random",
    style: str = "auto",
    count: int = 3,
    rule_suffix: str = "",
) -> str:
    theme_desc = THEMES.get(theme, THEMES["random"])
    style_desc = STYLES.get(style, "")
    text = (
        "You are an elite creative director, visual artist, and image prompt muse.\n"
        f"Your mission is to invent {count} wildly creative, evocative, and memorable image concept idea(s) (画面点子).\n\n"
        f"### Theme Inspiration:\n{theme_desc}\n"
        f"{('### Visual Style Direction:\n' + style_desc + chr(10)) if style_desc else ''}\n"
        "### Creative Principles:\n"
        "- Never suggest generic clichés (e.g. avoid boring 'girl standing in a street').\n"
        "- Aim for imaginative juxtapositions, distinct tactile materials, dramatic motivated lighting, "
        "curious props or accessories, and compelling atmosphere.\n"
        "- Each idea must be a concise, concrete sentence in Chinese (20-45 字) describing the central subject, "
        "their action/pose, distinctive gear/apparel, and the unique environment.\n\n"
        "Output STRICT JSON ONLY (no markdown fence, no conversation) in this format:\n"
        '{"ideas":[{"title":"4-8字中文凝练标题","idea":"具体生动的画面创意点子","theme":"theme_keyword"}]}'
    )
    if rule_suffix.strip():
        text += "\n\n" + rule_suffix.strip()
    return text


def parse_brainstorm(raw: str, *, count: int = 3, fallback_theme: str = "random") -> list[dict[str, Any]]:
    items: list[Any] = []
    try:
        data = _extract_json(raw)
        if isinstance(data, dict):
            items = data.get("ideas") or data.get("candidates") or []
        elif isinstance(data, list):
            items = data
    except (ValueError, json.JSONDecodeError):
        items = []

    out: list[dict[str, Any]] = []
    for idx, it in enumerate(items):
        if isinstance(it, str):
            it = {"idea": it}
        if not isinstance(it, dict):
            continue
        idea_txt = str(it.get("idea") or it.get("prompt") or it.get("text") or "").strip()
        if not idea_txt:
            continue
        title = str(it.get("title") or f"创意灵感 {idx + 1}").strip()[:20]
        th = str(it.get("theme") or fallback_theme).strip()
        out.append({"title": title, "idea": idea_txt, "theme": th})
        if len(out) >= count:
            break

    if not out:
        clean = " ".join(str(raw or "").split())
        if clean:
            out.append({"title": "灵感方案", "idea": clean[:200], "theme": fallback_theme})
    return out


def brainstorm_ideas(
    call: ModelCall,
    *,
    theme: str = "random",
    style: str = "auto",
    count: int = 3,
    rule_suffix: str = "",
) -> list[dict[str, Any]]:
    """Model invents creative concept ideas on its own."""
    count = max(1, min(6, int(count or 3)))
    th = theme if theme in THEMES else "random"
    st = style if style in STYLES else "auto"
    instr = brainstorm_instruction(theme=th, style=st, count=count, rule_suffix=rule_suffix)
    raw = call(instr, 300 * count + 200, 0.95)
    return parse_brainstorm(raw, count=count, fallback_theme=th)


# ==============================================================================
# 2. Idea → Concrete Image Scene Prompt Candidates ("灵感画面生成")
# ==============================================================================

def candidates_instruction(idea: str, *, count: int, style: str, aspect: str, rule_suffix: str = "") -> str:
    style_line = STYLES.get(style, "")
    aspect_line = (
        f"Compose every scene for a {aspect} canvas."
        if aspect in ASPECTS
        else "Choose the best canvas orientation (portrait, landscape or square) for each scene."
    )
    variety = (
        "Each candidate must be a clearly different interpretation (different composition, camera, "
        "lighting or mood), not a rewording of the others. "
        if count > 1
        else ""
    )
    text = (
        "You are a visual concept artist and image-generation prompt writer.\n"
        f"The user's idea: \"{idea}\"\n\n"
        f"Imagine {count} complete, concrete picture(s) based on this idea. {variety}"
        "Keep everything the user explicitly asked for (subjects, counts, text, exclusions). "
        "Fill in what they left open with specific visible choices: subject appearance and action, "
        "setting, composition and camera framing, viewer-relative placement of offset elements "
        "(on the viewer's left / right side of the frame), lighting, materials, palette, mood and medium. "
        "Quote any text that should be visible in the image verbatim inside double quotes.\n"
        f"{('Style requirement: ' + style_line + chr(10)) if style_line else ''}"
        f"{aspect_line}\n"
        "Write each prompt as 3-5 sentences of cohesive natural prose that describes the picture directly; "
        "never say 'this image', never address the reader, no (word:1.2) weights, no generic quality tags.\n\n"
        "Output STRICT JSON ONLY (no markdown fence, no explanation) in this shape:\n"
        '{"candidates":[{"title":"4-10 字中文短标题","aspect":"portrait|landscape|square",'
        '"prompt":"the full image prompt, 3-5 sentences"}]}'
    )
    if rule_suffix.strip():
        text += "\n\n" + rule_suffix.strip()
    return text


def parse_candidates(raw: str, *, count: int, aspect: str) -> list[dict[str, Any]]:
    """Parse the model's candidate JSON; fall back to a single prose candidate."""
    items: list[Any] = []
    try:
        data = _extract_json(raw)
        if isinstance(data, dict):
            items = data.get("candidates") or data.get("items") or []
        elif isinstance(data, list):
            items = data
    except (ValueError, json.JSONDecodeError):
        items = []

    out: list[dict[str, Any]] = []
    for index, it in enumerate(items):
        if isinstance(it, str):
            it = {"prompt": it}
        if not isinstance(it, dict):
            continue
        prompt = _clean(str(it.get("prompt") or it.get("caption") or ""), "prose")
        if not prompt:
            continue
        cand_aspect = aspect if aspect in ASPECTS else str(it.get("aspect") or "").strip().lower()
        if cand_aspect not in ASPECTS:
            cand_aspect = "square"
        width, height = aspect_size(cand_aspect)
        out.append({
            "title": str(it.get("title") or f"方案 {index + 1}").strip()[:24],
            "aspect": cand_aspect,
            "width": width,
            "height": height,
            "prompt": prompt,
        })
        if len(out) >= count:
            break

    if not out:
        # The model ignored the JSON format: keep its prose as one candidate.
        prose = _clean(str(raw or ""), "prose")
        if not prose:
            raise ValueError("The model returned no usable prompt.")
        cand_aspect = aspect if aspect in ASPECTS else "square"
        width, height = aspect_size(cand_aspect)
        out.append({"title": "方案 1", "aspect": cand_aspect, "width": width, "height": height, "prompt": prose})
    return out


def imagine_candidates(
    call: ModelCall,
    idea: str,
    *,
    count: int = 3,
    style: str = "auto",
    aspect: str = "auto",
    rule_suffix: str = "",
) -> list[dict[str, Any]]:
    idea_clean = " ".join(str(idea or "").split())
    if not idea_clean:
        raise ValueError("请先输入一句想法。")
    if len(idea_clean) > MAX_IDEA_CHARS:
        raise ValueError(f"想法太长（上限 {MAX_IDEA_CHARS} 字）。")
    count = max(1, min(MAX_CANDIDATES, int(count or 3)))
    style = style if style in STYLES else "auto"
    aspect = str(aspect or "auto").strip().lower()
    instr = candidates_instruction(idea_clean, count=count, style=style, aspect=aspect, rule_suffix=rule_suffix)
    raw = call(instr, 600 * count + 400, 0.9)
    return parse_candidates(raw, count=count, aspect=aspect)


# ==============================================================================
# 3. Synchronize Adopted Prompt to Node Output Modes (Layout BBox & Tags)
# ==============================================================================

def layout_from_prompt_instruction(prompt: str, width: int, height: int, *, max_regions: int, rule_suffix: str = "") -> str:
    limit = max(1, min(16, int(max_regions or 8)))
    text = (
        "You are a visual layout planner for the MOSS-Image layout model.\n"
        f"Plan the composition of this imagined image on a {width}x{height} canvas:\n"
        f"\"{prompt}\"\n\n"
        f"Decompose it into AT MOST {limit} regions: the overall environment, main character(s), "
        "distinctive features (halos, wings, weapons, props) as separate tight boxes, and every piece of "
        "visible text as its own 'text' region with the exact words in the 'text' field. "
        "Place each box where the description puts it (respect viewer's left / right / foreground / background). "
        "Boxes are [x1, y1, x2, y2] integers in 0-1000 normalized space, (0,0) top-left.\n\n"
        "Output STRICT JSON ONLY (no markdown fence, no explanation):\n"
        '{"summary":{"caption":"the full image prompt"},"items":[{"name":"中文实体名","label":"object|character|text",'
        '"parent":"父级实体名或空","bbox":[x1,y1,x2,y2],"caption":"concise English visual description","text":"visible text if text label"}]}'
    )
    if rule_suffix.strip():
        text += "\n\n" + rule_suffix.strip()
    return text


def danbooru_from_prompt_instruction(prompt: str, rule_suffix: str = "") -> str:
    text = (
        "Convert this image description into image-generation tags.\n"
        f"Description: \"{prompt}\"\n\n"
        "Treat the description as the image. Rules: "
        f"{_INSTRUCTIONS['danbooru']}"
    )
    if rule_suffix.strip():
        text += "\n\n" + rule_suffix.strip()
    return text


def _concise(text: str) -> str:
    cleaned = " ".join(str(text or "").split())
    for sep in (". ", "。"):
        idx = cleaned.find(sep)
        if 12 <= idx <= 200:
            return cleaned[: idx + 1]
    return cleaned[:200]


def expand_candidate(
    call: ModelCall,
    prompt: str,
    *,
    modes: Sequence[str],
    width: int,
    height: int,
    max_regions: int = 8,
    rule_suffix: str = "",
    layout_rule_suffix: str = "",
) -> dict[str, Any]:
    """Build a node payload from an adopted prompt, filling every active mode."""
    prose = _clean(str(prompt or ""), "prose")
    if not prose:
        raise ValueError("prompt is required.")
    width, height = match_canvas_size(int(width or 1024), int(height or 1024))
    active = [m for m in modes if m in ("caption", "layout", "danbooru")] or ["caption"]
    primary = active[0]

    state: dict[str, Any] = {
        "source": "imagine",
        "mode": primary,
        "modes": list(active),
        "width": width,
        "height": height,
        "caption": prose,
        "caption_text": prose,
    }

    if "layout" in active:
        raw = call(
            layout_from_prompt_instruction(prose, width, height, max_regions=max_regions, rule_suffix=layout_rule_suffix),
            3000,
            0.4,
        )
        draft = parse_model_layout(str(raw or ""), width, height, max_items=max_regions)
        hybrid_draft = copy.deepcopy(draft)
        hybrid_draft["summary"]["caption"] = prose
        layout_draft = copy.deepcopy(draft)
        layout_draft["summary"]["caption"] = _concise(prose)
        state["layout_draft"] = layout_draft
        state["hybrid_draft"] = hybrid_draft
        state["draft"] = layout_draft if primary == "layout" else hybrid_draft

    if "danbooru" in active:
        raw = call(danbooru_from_prompt_instruction(prose, rule_suffix), 600, 0.3)
        tags = _clean(str(raw or ""), "danbooru")
        if tags:
            state["danbooru_prompt"] = tags
            state["danbooru_text"] = tags
            state["tags"] = tags

    return state


# ==============================================================================
# 4. Autonomous End-to-End Pipeline ("全自动灵感链路")
# ==============================================================================

def auto_imagine_pipeline(
    call: ModelCall,
    idea: str = "",
    *,
    modes: Sequence[str] = ("caption",),
    theme: str = "random",
    style: str = "auto",
    aspect: str = "auto",
    max_regions: int = 8,
    rule_suffix: str = "",
    layout_rule_suffix: str = "",
) -> dict[str, Any]:
    """Autonomous end-to-end pipeline:
    If idea is empty, the model first brainstorms an inspired idea on its own.
    Then it imagines the visual scene and expands into all requested node modes (prose, layout, tags).
    """
    clean_idea = " ".join(str(idea or "").split())
    brainstormed_title = ""
    if not clean_idea:
        ideas = brainstorm_ideas(call, theme=theme, style=style, count=1, rule_suffix=rule_suffix)
        if ideas:
            clean_idea = ideas[0]["idea"]
            brainstormed_title = ideas[0].get("title", "")
        else:
            clean_idea = "A surreal crystal greenhouse suspended above misty emerald mountains at twilight."

    candidates = imagine_candidates(
        call,
        clean_idea,
        count=1,
        style=style,
        aspect=aspect,
        rule_suffix=rule_suffix,
    )
    if not candidates:
        raise ValueError("灵感生成失败，未能生成有效方案。")
    best = candidates[0]
    payload = expand_candidate(
        call,
        best["prompt"],
        modes=modes,
        width=best["width"],
        height=best["height"],
        max_regions=max_regions,
        rule_suffix=rule_suffix,
        layout_rule_suffix=layout_rule_suffix,
    )
    payload["idea"] = clean_idea
    if brainstormed_title:
        payload["idea_title"] = brainstormed_title
    return payload


__all__ = [
    "STYLES",
    "ASPECTS",
    "THEMES",
    "aspect_size",
    "brainstorm_ideas",
    "brainstorm_instruction",
    "parse_brainstorm",
    "imagine_candidates",
    "candidates_instruction",
    "parse_candidates",
    "expand_candidate",
    "auto_imagine_pipeline",
]
