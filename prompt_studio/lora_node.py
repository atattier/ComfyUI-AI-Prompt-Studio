"""AIPromptStudioLoraNode: Standalone LoRA Preset and Stacker Node for ComfyUI.

Provides multi-LoRA stacking, weight scaling, trigger word generation,
and persistent preset management.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from .lora_presets import (
    BUILTIN_LORA_PRESETS,
    LoraPresetStore,
    get_lora_trigger_words,
    repair_lora_name,
    resolve_lora_rel_path,
)

logger = logging.getLogger("ai_prompt_studio.lora")


def get_lora_preset_names() -> list[str]:
    try:
        store = LoraPresetStore()
        presets = store.list()
        store.close()
        names = [p["name"] for p in presets if p.get("name")]
        return names if names else ["电影级胶片光影与质感 (示例堆叠)"]
    except Exception:
        return ["电影级胶片光影与质感 (示例堆叠)"]


def _lora_file_exists(lora_name: str) -> bool:
    """True when ComfyUI can actually resolve this LoRA path."""
    try:
        import folder_paths

        return bool(folder_paths.get_full_path("loras", lora_name))
    except Exception:
        return True  # Outside ComfyUI (tests) we cannot check; do not warn.


def safe_load_single_lora(
    model: Any,
    clip: Any,
    lora_name: str,
    strength_model: float,
    strength_clip: float,
) -> tuple[Any, Any]:
    """Safely apply one LoRA to model & clip using ComfyUI APIs if available."""
    if strength_model == 0.0 and strength_clip == 0.0:
        return model, clip
    if model is None and clip is None:
        return None, None

    try:
        import comfy.sd
        import comfy.utils
        import folder_paths

        lora_path = folder_paths.get_full_path_or_raise("loras", lora_name)
        lora, lora_metadata = comfy.utils.load_torch_file(lora_path, safe_load=True, return_metadata=True)
        model_out, clip_out = comfy.sd.load_lora_for_models(
            model, clip, lora, strength_model, strength_clip, lora_metadata=lora_metadata
        )
        return model_out, clip_out
    except Exception as exc:
        logger.warning(
            f"[AIPromptStudioLoraNode] 无法加载 LoRA '{lora_name}': {exc}，跳过此项继续执行。"
        )
        return model, clip


class AIPromptStudioLoraNode:
    """Standalone LoRA Preset & Multi-Stacker Node.

    Loads and sequentially applies a saved or custom stack of LoRAs to diffusion/clip
    models, or outputs standard LoRA stack tuples and trigger word syntax.
    """

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        preset_names = get_lora_preset_names()
        return {
            "required": {
                "preset_name": (
                    preset_names,
                    {"default": preset_names[0] if preset_names else "", "tooltip": "选择已保存的 LoRA 预设组合"},
                ),
            },
            "optional": {
                "model": ("MODEL", {"tooltip": "可选：连入需应用 LoRA 的 Diffusion 模型"}),
                "clip": ("CLIP", {"tooltip": "可选：连入需应用 LoRA 的 CLIP 模型"}),
                "lora_stack": ("LORA_STACK", {"tooltip": "可选：从上游连入已有的 LoRA 堆叠列表"}),
                "model_strength_scale": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": -10.0,
                        "max": 10.0,
                        "step": 0.05,
                        "tooltip": "全局整体缩放该预设中所有 LoRA 的 Model 权重（默认 1.0）",
                    },
                ),
                "clip_strength_scale": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": -10.0,
                        "max": 10.0,
                        "step": 0.05,
                        "tooltip": "全局整体缩放该预设中所有 LoRA 的 Clip 权重（默认 1.0）",
                    },
                ),
                "extra_trigger_words": (
                    "STRING",
                    {"default": "", "multiline": True, "tooltip": "可选：追加到触发词末尾的提示词"},
                ),
                "custom_stack_json": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "tooltip": "高级：网页卡片交互生成的实时堆叠 JSON，留空时读取上方选择的预设",
                    },
                ),
            },
        }

    RETURN_TYPES = ("MODEL", "CLIP", "LORA_STACK", "STRING", "STRING")
    RETURN_NAMES = ("MODEL", "CLIP", "lora_stack", "trigger_words", "lora_syntax")
    FUNCTION = "execute"
    CATEGORY = "AI Prompt Studio"
    DESCRIPTION = "独立 LoRA 预设与多重堆叠器：一键加载/保存多重 LoRA 组合配置，支持按序加载至模型或输出标准 LoRA 堆叠数据与触发词。"

    def execute(
        self,
        preset_name: str,
        model: Any = None,
        clip: Any = None,
        lora_stack: list[tuple[str, float, float]] | None = None,
        model_strength_scale: float = 1.0,
        clip_strength_scale: float = 1.0,
        extra_trigger_words: str = "",
        custom_stack_json: str = "",
    ):
        loras_to_apply: list[dict[str, Any]] = []
        trigger_words_base: str = ""

        # 1. Try reading custom_stack_json if provided
        custom_json_str = str(custom_stack_json or "").strip()
        if custom_json_str:
            try:
                parsed = json.loads(custom_json_str)
                if isinstance(parsed, list):
                    loras_to_apply = parsed
                elif isinstance(parsed, dict):
                    loras_to_apply = parsed.get("loras") or []
                    trigger_words_base = str(parsed.get("trigger_words") or "")
            except Exception:
                pass

        # 2. Fallback to reading from preset store
        if not loras_to_apply:
            store = LoraPresetStore()
            found = None
            for p in store.list():
                if p.get("name") == preset_name or p.get("id") == preset_name:
                    found = p
                    break
            store.close()

            if not found and BUILTIN_LORA_PRESETS:
                found = BUILTIN_LORA_PRESETS[0]

            if found:
                loras_to_apply = found.get("loras") or []
                if not trigger_words_base:
                    trigger_words_base = str(found.get("trigger_words") or "")

        # 3. Clean and scale LoRAs
        active_loras: list[tuple[str, float, float]] = []
        syntax_tags: list[str] = []
        collected_tw: list[str] = []

        for item in loras_to_apply:
            if not isinstance(item, dict):
                continue
            if not item.get("enabled", True):
                continue
            name = repair_lora_name(item.get("name"))
            if not name:
                continue
            resolved_name = resolve_lora_rel_path(name)
            m_str = round(float(item.get("strength_model", 1.0)) * float(model_strength_scale), 3)
            c_str = round(float(item.get("strength_clip", 1.0)) * float(clip_strength_scale), 3)

            active_loras.append((resolved_name, m_str, c_str))
            syntax_tags.append(f"<lora:{resolved_name}:{m_str}>")

            # Collect per-LoRA trigger words when the preset itself has none.
            item_tw = str(item.get("trigger_words") or "").strip()
            if not item_tw:
                item_tw = get_lora_trigger_words(resolved_name)
            if item_tw:
                collected_tw.append(item_tw)

        # 3b. Report unresolved LoRAs loudly instead of silently skipping them.
        missing = [n for n, _, _ in active_loras if not _lora_file_exists(n)]
        if missing:
            logger.warning(
                "[AIPromptStudioLoraNode] 以下 %d 个 LoRA 在 models/loras 中找不到，已自动跳过：%s",
                len(missing),
                ", ".join(missing),
            )

        # 4. Construct lora_stack (combine with upstream)
        out_stack: list[tuple[str, float, float]] = list(lora_stack) if lora_stack else []
        out_stack.extend(active_loras)

        # 5. Construct trigger words & syntax
        tw_parts = []
        if trigger_words_base.strip():
            tw_parts.append(trigger_words_base.strip())
        if collected_tw:
            tw_parts.append(", ".join(dict.fromkeys(collected_tw)))
        if extra_trigger_words.strip():
            tw_parts.append(extra_trigger_words.strip())
        final_trigger_words = ", ".join(tw_parts)

        final_syntax = " ".join(syntax_tags)

        # 6. Apply to MODEL and CLIP if provided
        curr_model = model
        curr_clip = clip

        if curr_model is not None or curr_clip is not None:
            for lora_name, m_str, c_str in active_loras:
                curr_model, curr_clip = safe_load_single_lora(
                    curr_model, curr_clip, lora_name, m_str, c_str
                )

        return (curr_model, curr_clip, out_stack, final_trigger_words, final_syntax)


def register(mappings: dict, display_names: dict) -> None:
    mappings["AIPromptStudioLora"] = AIPromptStudioLoraNode
    display_names["AIPromptStudioLora"] = "AI LoRA 预设与堆叠加载器"


__all__ = [
    "AIPromptStudioLoraNode",
    "get_lora_preset_names",
    "safe_load_single_lora",
    "register",
]
