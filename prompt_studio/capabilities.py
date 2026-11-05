"""Capability probing for the single configured multimodal model.

ComfyUI AI Prompt Studio assumes one model can do text, vision and streaming.
Assumptions are not evidence, so the backend probes all three before the
workbench relies on them:

* text      — a one-word completion must come back;
* vision    — two synthetic two-colour images must both be described correctly
              (a single correct guess is treated as inconclusive);
* streaming — a streaming request must yield incremental deltas rather than a
              single buffered body.

The probe never trusts provider metadata, but records it as corroboration when
``GET /models`` exposes input modalities.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field, replace
from typing import Any

from .client import ChatClient, data_url
from .errors import InvalidRequestError, StudioError
from .png import make_rgb_png

_COLOR_WORDS = {
    "red": ("red", "crimson", "scarlet", "红"),
    "blue": ("blue", "navy", "蓝"),
    "green": ("green", "绿"),
    "yellow": ("yellow", "amber", "gold", "黄"),
}

_IMAGE_REJECTION_MARKERS = (
    "does not support image",
    "not support image",
    "image input is not supported",
    "unsupported image",
    "image_url is not supported",
    "vision is not supported",
    "does not support vision",
    "multimodal is not supported",
    "text-only",
    "text only model",
    "no vision",
    "invalid content type",
    "不支持图片",
    "不支持图像",
    "不支持多模态",
    "仅支持文本",
)

_CANNOT_SEE_MARKERS = (
    "cannot see",
    "can't see",
    "unable to view",
    "unable to see",
    "no image was provided",
    "no image provided",
    "i don't see an image",
    "i do not see an image",
    "无法查看图片",
    "无法看到图片",
    "看不到图片",
    "没有收到图片",
    "没有提供图片",
)


def _contains_color(text: str, color: str) -> bool:
    lowered = text.lower()
    return any(word in lowered for word in _COLOR_WORDS[color])


def _looks_like_image_rejection(text: str) -> bool:
    lowered = text.lower()
    return any(marker in lowered for marker in _IMAGE_REJECTION_MARKERS)


def _looks_like_cannot_see(text: str) -> bool:
    lowered = text.lower()
    return any(marker in lowered for marker in _CANNOT_SEE_MARKERS)


@dataclass(slots=True)
class CapabilityReport:
    base_url: str
    model: str
    text: bool
    vision: bool | None
    streaming: bool | None
    declared_modalities: dict[str, Any] | None
    checked_at: str
    details: dict[str, Any] = field(default_factory=dict)
    cached: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "base_url": self.base_url,
            "model": self.model,
            "text": self.text,
            "vision": self.vision,
            "streaming": self.streaming,
            "declared_modalities": self.declared_modalities,
            "checked_at": self.checked_at,
            "details": self.details,
            "cached": self.cached,
        }


class CapabilityProber:
    def __init__(self, client: ChatClient, *, ttl_s: float = 600.0, clock: Any = time.time) -> None:
        self.client = client
        self.ttl_s = ttl_s
        self.clock = clock
        self._cache: dict[tuple[str, str], tuple[float, CapabilityReport]] = {}

    def cached_report(self, *, model: str | None = None) -> CapabilityReport | None:
        model = model or self.client.settings.model
        entry = self._cache.get((self.client.settings.base_url, model))
        if entry is None:
            return None
        if self.clock() - entry[0] >= self.ttl_s:
            return None
        return entry[1]

    def probe(self, *, model: str | None = None, force: bool = False) -> CapabilityReport:
        model = model or self.client.settings.model
        key = (self.client.settings.base_url, model)
        now = self.clock()
        cached = self._cache.get(key)
        if cached and not force and now - cached[0] < self.ttl_s:
            return replace(cached[1], cached=True)

        details: dict[str, Any] = {}
        declared = self._declared_modalities(model, details)
        text_ok, text_error = self._probe_text(model, details)
        vision: bool | None = None
        streaming: bool | None = None

        if text_ok:
            vision = self._probe_vision(model, details)
            streaming = self._probe_streaming(model, details)
        else:
            details["vision"] = {"supported": None, "reason": "text_probe_failed"}
            details["streaming"] = {"supported": None, "reason": "text_probe_failed"}

        report = CapabilityReport(
            base_url=self.client.settings.base_url,
            model=model,
            text=text_ok,
            vision=vision,
            streaming=streaming,
            declared_modalities=declared,
            checked_at=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            details=details,
        )
        self._cache[key] = (now, report)
        return report

    # ------------------------------------------------------------------ parts
    def _declared_modalities(
        self, model: str, details: dict[str, Any]
    ) -> dict[str, Any] | None:
        try:
            models = self.client.list_models()
        except StudioError as err:
            details["models_endpoint"] = {"ok": False, "error": err.code}
            return None
        match = next((m for m in models if m.get("id") == model), None)
        if match is None:
            details["models_endpoint"] = {"ok": True, "matched": False, "count": len(models)}
            return None
        modalities = match.get("modalities")
        if isinstance(modalities, dict):
            details["models_endpoint"] = {"ok": True, "matched": True}
            return modalities
        details["models_endpoint"] = {"ok": True, "matched": True, "modalities": None}
        return None

    def _probe_text(self, model: str, details: dict[str, Any]) -> tuple[bool, str | None]:
        try:
            result = self.client.complete(
                [{"role": "user", "content": "Reply with the single word OK."}],
                model=model,
                temperature=0,
                max_tokens=128,  # reasoning models may spend budget before content
                timeout=min(self.client.settings.timeout_s, 30.0),
            )
        except StudioError as err:
            details["text"] = {"supported": False, "error": err.code, "message": err.message}
            return False, err.code
        ok = bool(result.text.strip())
        details["text"] = {
            "supported": ok,
            "latency_ms": result.latency_ms,
            "reply_chars": len(result.text),
        }
        return ok, None

    def _probe_vision(self, model: str, details: dict[str, Any]) -> bool | None:
        trials = (
            ("red", "blue", (220, 30, 30), (30, 40, 220)),
            ("green", "yellow", (30, 170, 60), (235, 205, 40)),
        )
        results: list[dict[str, Any]] = []
        passed = 0
        wrong_answers = 0
        empty_answers = 0

        for left_name, right_name, left_rgb, right_rgb in trials:
            mid = 32
            pixels = [left_rgb if x < mid else right_rgb for _y in range(64) for x in range(64)]
            png = make_rgb_png(64, 64, pixels)
            messages = [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": (
                                "This image is split vertically into two solid colour halves. "
                                "Name both colours from left to right. "
                                "Answer with exactly two colour words and nothing else."
                            ),
                        },
                        {"type": "image_url", "image_url": {"url": data_url(png)}},
                    ],
                }
            ]
            try:
                result = self.client.complete(
                    messages,
                    model=model,
                    temperature=0,
                    max_tokens=128,
                    timeout=min(self.client.settings.timeout_s, 45.0),
                )
            except InvalidRequestError as err:
                combined = f"{err.message} {err.detail or ''}"
                if _looks_like_image_rejection(combined):
                    details["vision"] = {
                        "supported": False,
                        "reason": "rejected_by_api",
                        "message": err.message[:300],
                    }
                    return False
                details["vision"] = {
                    "supported": None,
                    "reason": "request_error",
                    "error": err.code,
                    "message": err.message[:300],
                }
                return None
            except StudioError as err:
                details["vision"] = {
                    "supported": None,
                    "reason": "request_error",
                    "error": err.code,
                    "message": err.message[:300],
                }
                return None

            reply = result.text.strip()
            found = _contains_color(reply, left_name) and _contains_color(reply, right_name)
            results.append(
                {
                    "expected": f"{left_name}+{right_name}",
                    "matched": found,
                    "reply": reply[:120],
                }
            )
            if found:
                passed += 1
            elif _looks_like_image_rejection(reply) or _looks_like_cannot_see(reply):
                details["vision"] = {
                    "supported": False,
                    "reason": "model_says_no_image",
                    "trials": results,
                }
                return False
            elif reply:
                wrong_answers += 1
            else:
                # An empty completion is weak evidence either way: some providers
                # silently drop image content, others simply return nothing.
                empty_answers += 1

        if passed == len(trials):
            details["vision"] = {"supported": True, "reason": "both_probe_images_described", "trials": results}
            return True
        if wrong_answers:
            details["vision"] = {
                "supported": False,
                "reason": "no_visual_evidence",
                "trials": results,
            }
            return False
        if empty_answers:
            details["vision"] = {
                "supported": None,
                "reason": "empty_reply",
                "trials": results,
            }
            return None
        details["vision"] = {"supported": None, "reason": "probe_failed", "trials": results}
        return None

    def _probe_streaming(self, model: str, details: dict[str, Any]) -> bool | None:
        try:
            events = self.client.stream_chat(
                [{"role": "user", "content": "Count from one to three."}],
                model=model,
                temperature=0,
                max_tokens=256,
                timeout=min(self.client.settings.timeout_s, 45.0),
            )
            deltas = 0
            final = None
            for event in events:
                if event.type == "delta":
                    deltas += 1
                elif event.type == "done":
                    final = event
        except StudioError as err:
            text = f"{err.message} {getattr(err, 'detail', '') or ''}".lower()
            if "stream" in text and ("not support" in text or "unsupported" in text):
                details["streaming"] = {"supported": False, "reason": "rejected_by_api", "error": err.code}
                return False
            details["streaming"] = {
                "supported": None,
                "reason": "request_error",
                "error": err.code,
                "message": err.message[:300],
            }
            return None

        if final is None:
            details["streaming"] = {"supported": False, "reason": "no_done_event"}
            return False
        if final.stream_ignored:
            details["streaming"] = {
                "supported": False,
                "reason": "provider_ignored_stream",
                "chunks": final.chunks,
            }
            return False
        ok = bool(final.text.strip()) and deltas >= 1
        details["streaming"] = {
            "supported": ok,
            "chunks": deltas,
            "ttft_ms": final.ttft_ms,
            "saw_done": final.saw_done,
            "stream_ignored": final.stream_ignored,
        }
        return ok
