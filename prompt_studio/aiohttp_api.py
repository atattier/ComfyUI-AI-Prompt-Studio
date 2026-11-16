"""ComfyUI-hosted HTTP API for M1.

The same core client used by the standalone M0 server is exposed through
ComfyUI's own aiohttp server, so the frontend can call same-origin routes with
no extra port, no CORS and no duplicated credentials.

Routes are registered under ``/ai_prompt_studio/*``.  They inherit ComfyUI's
exposure: if ComfyUI listens on a LAN interface, these routes are reachable
too.  Bind ComfyUI to 127.0.0.1 unless you have added your own authentication.
"""

from __future__ import annotations

import asyncio
import json
import threading
from pathlib import Path
from typing import Any, AsyncIterator, Iterator

from aiohttp import web

from . import __version__
from .audit import AuditLogger
from .capabilities import CapabilityProber
from .caption import FORMATS, caption_image
from .client import ChatClient
from .config import (
    OUTPUT_LANGUAGES,
    RULE_PRESETS,
    Settings,
    build_rule_suffix,
    load_settings,
    save_preferences,
)
from .credentials import (
    Credentials,
    add_key,
    activate_key,
    default_home,
    delete_key,
    key_list,
    save_credentials,
    update_metadata,
)
from .diff import EditValidationError, preview_ops
from .edit_agent import build_chat_messages, request_edit
from .gateways import (
    activate_gateway,
    delete_gateway,
    list_gateways,
    save_gateway,
    sync_active_gateway,
)
from .errors import (
    CapabilityError,
    ConfigError,
    InvalidRequestError,
    NotFoundError,
    StudioError,
)
from .images import image_to_part, to_api_part
from .redaction import Redactor, mask_secret
from .sessions import MediaStore, SessionStore
from .versions import VersionStore
from .presets import PresetStore
from .lora_presets import (
    LoraPresetStore,
    scan_available_loras,
    scan_available_loras_metadata,
    extract_loras_from_image_bytes,
    find_lora_preview_path,
)

MAX_BODY = 25 * 1024 * 1024


class StudioBackend:
    """Process-wide backend used by both ComfyUI routes and the dev harness."""

    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or load_settings()
        self.redactor = Redactor([self.settings.api_key])
        self.audit = AuditLogger(self.settings.audit_path, self.redactor)
        self.client = ChatClient(self.settings, audit=self.audit)
        self.media = MediaStore(self.settings.media_dir, max_bytes=self.settings.max_image_bytes)
        self.prober = CapabilityProber(self.client)
        self.sessions = SessionStore(self.settings.db_path, media=self.media)
        self.versions = VersionStore(self.settings.home / "versions.sqlite3")
        self.presets = PresetStore(self.settings.home / "presets.sqlite3")
        self.lora_presets = LoraPresetStore(self.settings.home / "lora_presets.sqlite3")

    def close(self) -> None:
        try:
            self.sessions.close()
        finally:
            try:
                self.versions.close()
            finally:
                try:
                    self.presets.close()
                finally:
                    self.lora_presets.close()

    # ------------------------------------------------------------------ info
    def status(self) -> dict[str, Any]:
        cached = self.prober.cached_report()
        return {
            "version": __version__,
            "config": self.settings.public_dict(),
            "capabilities": cached.to_dict() if cached else None,
            "auth": "inherits-comfyui",
        }

    def probe(self, *, force: bool = False) -> dict[str, Any]:
        return self.prober.probe(force=force).to_dict()

    def capabilities(self) -> dict[str, Any]:
        cached = self.prober.cached_report()
        return {"checked": cached is not None, "capabilities": cached.to_dict() if cached else None}

    def list_models(self) -> dict[str, Any]:
        raw_models = self.client.list_models(timeout=min(self.settings.timeout_s, 15.0))
        models: list[dict[str, Any]] = []
        seen: set[str] = set()
        for item in raw_models:
            if not isinstance(item, dict):
                continue
            model_id = str(item.get("id") or "").strip()
            if not model_id or model_id in seen:
                continue
            seen.add(model_id)
            models.append({
                "id": model_id,
                "owned_by": str(item.get("owned_by") or ""),
                "modalities": item.get("modalities") if isinstance(item.get("modalities"), dict) else None,
            })
        return {
            "models": models,
            "current_model": self.settings.model,
            "base_url": self.settings.base_url,
        }

    # ------------------------------------------------------------------ chat
    def _image_parts(self, images: Any) -> list[dict[str, Any]]:
        if images in (None, []):
            return []
        if not isinstance(images, list):
            raise InvalidRequestError("images must be an array.")
        return [image_to_part(self.media, image) for image in images]

    def _optional_session(self, body: dict[str, Any], default_title: str) -> str | None:
        session_id = str(body.get("session_id") or "").strip() or None
        create_session = bool(body.get("create_session"))
        if session_id:
            session = self.sessions.get(session_id)
            if session is not None:
                return session_id
            if not create_session:
                session = self.sessions.create(title=default_title[:40] or "Prompt Studio")
                return session["id"]
        if create_session:
            session = self.sessions.create(title=default_title[:40] or "Prompt Studio")
            return session["id"]
        return None

    @staticmethod
    def _target(body: dict[str, Any], *, require_text: bool = True) -> dict[str, Any]:
        target = body.get("target")
        if target is None:
            target = {}
        if not isinstance(target, dict):
            raise InvalidRequestError("target must be an object.")
        text = target.get("text")
        if require_text and not isinstance(text, str):
            raise InvalidRequestError("target.text must be a string.")
        return {
            "workflow": str(target.get("workflow") or "")[:200],
            "node_id": target.get("node_id"),
            "widget": str(target.get("widget") or "")[:80],
            "title": str(target.get("title") or "")[:120],
            "text": text if isinstance(text, str) else "",
        }

    def chat_events(self, body: dict[str, Any]) -> Iterator[tuple[str, dict[str, Any]]]:
        message = body.get("message")
        if not isinstance(message, str) or not message.strip():
            raise InvalidRequestError("message must be a non-empty string.")
        target = self._target(body)
        parts = self._image_parts(body.get("images"))
        model = body.get("model") or None
        session_id = body.get("session_id") or None

        if session_id:
            session = self.sessions.get(str(session_id))
            if session is None:
                raise NotFoundError("Session not found.")
        else:
            session = self.sessions.create(title=message.strip()[:40])
            session_id = session["id"]

        history = self.sessions.messages_for_api(session_id)
        user_content: Any = message
        if parts:
            user_content = [{"type": "text", "text": message}, *parts]
        self.sessions.append(session_id, "user", user_content)

        api_images = [to_api_part(self.media, part) for part in parts]
        messages = build_chat_messages(
            target["text"], message, target_hint=target["title"] or target["widget"],
            images=api_images, history=history,
        )
        request_id = ChatClient.new_request_id()
        yield "meta", {"request_id": request_id, "session_id": session_id, "model": model or self.settings.model}
        final = None
        try:
            for event in self.client.stream_chat(messages, model=model, request_id=request_id):
                if event.type == "delta":
                    yield "delta", {"text": event.text}
                elif event.type == "reasoning":
                    yield "reasoning", {"text": event.reasoning}
                elif event.type == "done":
                    final = event
        except StudioError as err:
            err.request_id = err.request_id or request_id
            self.audit.log(
                "studio_chat_error", request_id=request_id, code=err.code, message=err.message
            )
            yield "error", err.to_dict()
            return
        if final is None:
            yield "error", {"code": "no_response", "message": "The model returned no content.", "retryable": False}
            return
        if final.text:
            self.sessions.append(session_id, "assistant", final.text)
        yield "done", {
            "request_id": final.request_id,
            "session_id": session_id,
            "text": final.text,
            "usage": final.usage,
            "finish_reason": final.finish_reason,
            "ttft_ms": final.ttft_ms,
            "chunks": final.chunks,
            "saw_done": final.saw_done,
            "stream_ignored": final.stream_ignored,
        }

    def edit(self, body: dict[str, Any]) -> dict[str, Any]:
        from .caption_node import clean_widget_str

        message = body.get("message")
        if not isinstance(message, str) or not message.strip():
            raise InvalidRequestError("message must be a non-empty string.")
        target = self._target(body)
        allow_empty = bool(body.get("allow_empty"))
        if not target["text"].strip() and not allow_empty:
            raise InvalidRequestError("target.text is empty; nothing to edit.")
        stored_parts = self._image_parts(body.get("images"))
        parts = [to_api_part(self.media, part) for part in stored_parts]
        session_id = self._optional_session(body, message.strip())
        history = self.sessions.messages_for_api(session_id) if session_id else None
        req_model = clean_widget_str(body.get("model")) or None
        edit_mode = clean_widget_str(body.get("mode")).lower()
        canvas = _canvas_from_body(body.get("canvas"))
        effective_instruction = message + build_rule_suffix(
            self.settings, "", mode=edit_mode or None
        )
        proposal = request_edit(
            self.client,
            current_text=target["text"],
            instruction=effective_instruction,
            target_hint=target["title"] or target["widget"],
            images=parts,
            history=history,
            model=req_model,
            allow_empty=allow_empty,
            mode=edit_mode,
            canvas=canvas,
        )
        if session_id:
            user_content: Any = message
            if stored_parts:
                user_content = [{"type": "text", "text": message}, *stored_parts]
            self.sessions.append(session_id, "user", user_content)
            reply_summary = proposal.reply or (
                f"已生成 {len(proposal.changes)} 处提示词修改建议。" if proposal.changed else "当前提示词无需改动。"
            )
            self.sessions.append(session_id, "assistant", reply_summary)
        out: dict[str, Any] = {"target": target, "proposal": proposal.to_dict()}
        if session_id:
            out["session_id"] = session_id
        return out

    def caption(self, body: dict[str, Any]) -> dict[str, Any]:
        from .caption_node import clean_widget_str

        fmt = body.get("format")
        # Single string keeps the M1 shape; a list selects any 1-3 formats.
        if isinstance(fmt, list):
            formats = [str(name) for name in fmt]
        elif fmt is None:
            formats = ["prose"]
        else:
            formats = [str(fmt)]
        image = body.get("image")
        if not image:
            raise InvalidRequestError("image is required.")
        stored_part = image_to_part(self.media, image)
        part = to_api_part(self.media, stored_part)
        cached = self.prober.cached_report()
        if cached is not None and cached.vision is False:
            raise CapabilityError(
                "The configured model was probed and does not appear to accept images.",
                detail=str((cached.details.get("vision") or {}).get("reason") or ""),
            )
        extra_instruction = clean_widget_str(body.get("instruction"))
        cap_mode = "danbooru" if (len(formats) == 1 and formats[0] in ("tags", "danbooru")) else "caption"
        combined_extra = build_rule_suffix(self.settings, extra_instruction, mode=cap_mode).strip()
        req_model = clean_widget_str(body.get("model")) or None
        try:
            result = caption_image(
                self.client,
                part,
                fmt=formats,
                model=req_model,
                extra_instruction=combined_extra,
            )
        except ValueError as exc:
            raise InvalidRequestError(str(exc)) from exc
        out = result.to_dict()
        session_id = self._optional_session(body, "图片反推")
        if session_id:
            user_note = f"[图片反推 · {', '.join(formats)}]" + (f" {extra_instruction}" if extra_instruction else "")
            self.sessions.append(session_id, "user", [{"type": "text", "text": user_note}, stored_part])
            assistant_text = out.get("text") or ""
            if not assistant_text and isinstance(out.get("results"), dict):
                assistant_text = "\n\n".join(
                    f"[{k}] {v.get('text', '')}" for k, v in out["results"].items() if isinstance(v, dict) and v.get("text")
                )
            if assistant_text:
                self.sessions.append(session_id, "assistant", assistant_text)
            out["session_id"] = session_id
        return out

    # --------------------------------------------------------------- imagine
    def _text_call(self, model: str | None):
        def call(instruction: str, max_tokens: int, temperature: float) -> str:
            messages = [{"role": "user", "content": [{"type": "text", "text": instruction}]}]
            result = self.client.complete_via_stream(
                messages, model=model, temperature=temperature, max_tokens=max_tokens
            )
            return result.text
        return call

    def brainstorm(self, body: dict[str, Any]) -> dict[str, Any]:
        """Model invents creative concept ideas on its own. Body: {theme?, style?, count?, model?}."""
        from .caption_node import clean_widget_str
        from .imagine import brainstorm_ideas

        model = clean_widget_str(body.get("model")) or None
        extra = clean_widget_str(body.get("extra_instruction"))
        try:
            ideas = brainstorm_ideas(
                self._text_call(model),
                theme=str(body.get("theme") or "random"),
                style=str(body.get("style") or "auto"),
                count=int(body.get("count") or 3),
                rule_suffix=build_rule_suffix(self.settings, extra, mode="caption"),
            )
        except (TypeError, ValueError) as exc:
            raise InvalidRequestError(str(exc)) from exc
        return {"ideas": ideas}

    def imagine(self, body: dict[str, Any]) -> dict[str, Any]:
        """Idea → N imagined prompt candidates. Body: {idea, count?, style?, aspect?, model?}."""
        from .caption_node import clean_widget_str
        from .imagine import imagine_candidates

        model = clean_widget_str(body.get("model")) or None
        extra = clean_widget_str(body.get("extra_instruction"))
        try:
            candidates = imagine_candidates(
                self._text_call(model),
                str(body.get("idea") or ""),
                count=int(body.get("count") or 3),
                style=str(body.get("style") or "auto"),
                aspect=str(body.get("aspect") or "auto"),
                rule_suffix=build_rule_suffix(self.settings, extra, mode="caption"),
            )
        except (TypeError, ValueError) as exc:
            raise InvalidRequestError(str(exc)) from exc
        return {"candidates": candidates}

    def imagine_expand(self, body: dict[str, Any]) -> dict[str, Any]:
        """Adopted prompt → node payload for every active mode. Body: {prompt, modes, width, height, model?}."""
        from .caption_node import clean_widget_str
        from .imagine import expand_candidate

        model = clean_widget_str(body.get("model")) or None
        extra = clean_widget_str(body.get("extra_instruction"))
        modes = body.get("modes") if isinstance(body.get("modes"), list) else ["caption"]
        try:
            payload = expand_candidate(
                self._text_call(model),
                str(body.get("prompt") or ""),
                modes=[str(m) for m in modes],
                width=int(body.get("width") or 1024),
                height=int(body.get("height") or 1024),
                max_regions=int(self.settings.max_regions or 8),
                rule_suffix=build_rule_suffix(self.settings, extra, mode="danbooru"),
                layout_rule_suffix=build_rule_suffix(self.settings, extra, mode="layout", for_json_layout=True),
            )
        except (TypeError, ValueError) as exc:
            raise InvalidRequestError(str(exc)) from exc
        return {"payload": payload, "width": payload["width"], "height": payload["height"], "modes": payload["modes"]}

    def complete_from_prompt(self, body: dict[str, Any]) -> dict[str, Any]:
        """Accept a finished prompt (layout JSON, prose caption, or Danbooru tags) and complete selected modes."""
        from .caption_node import MODES, build_prompt_outputs, clean_widget_str, normalize_modes
        from .imagine import complete_from_finished_prompt

        prompt = body.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip():
            raise InvalidRequestError("请先填入成品提示词。")

        source_mode = str(body.get("source_mode") or "auto").strip().lower()
        if source_mode not in ("auto", "caption", "layout", "danbooru"):
            raise InvalidRequestError("source_mode must be auto, caption, layout, or danbooru.")

        raw_modes = body.get("modes")
        req_mode = clean_widget_str(body.get("mode")).lower()
        if isinstance(raw_modes, list) and len(raw_modes) > 0:
            base_mode = req_mode if req_mode in MODES else str(raw_modes[0] or "caption").strip().lower()
            if base_mode not in MODES:
                base_mode = "caption"
            try:
                active_modes = normalize_modes(base_mode, [str(m).strip().lower() for m in raw_modes])
            except ValueError as exc:
                raise InvalidRequestError(str(exc)) from exc
        else:
            base_mode = req_mode if req_mode in MODES else "caption"
            active_modes = [base_mode]

        raw_w = body.get("width")
        raw_h = body.get("height")
        try:
            if isinstance(raw_w, bool) or isinstance(raw_h, bool):
                raise ValueError("bool is not valid dimension")
            width = 1024 if raw_w is None or raw_w == "" else int(raw_w)
            height = 1024 if raw_h is None or raw_h == "" else int(raw_h)
        except (TypeError, ValueError) as exc:
            raise InvalidRequestError("width and height must be positive integers.") from exc
        if width <= 0 or height <= 0:
            raise InvalidRequestError("width and height must be positive integers.")

        max_regions = int(self.settings.max_regions or 8)
        if body.get("max_regions") not in (None, ""):
            try:
                max_regions = max(1, min(16, int(body["max_regions"])))
            except (TypeError, ValueError):
                pass

        force_size = str(body.get("size_mode") or "auto").strip().lower() == "explicit"
        model = clean_widget_str(body.get("model")) or None
        extra = clean_widget_str(body.get("extra_instruction"))

        try:
            payload = complete_from_finished_prompt(
                self._text_call(model),
                prompt,
                source_mode=source_mode,
                modes=active_modes,
                width=width,
                height=height,
                max_regions=max_regions,
                rule_suffix=build_rule_suffix(self.settings, extra, mode="caption"),
                danbooru_rule_suffix=build_rule_suffix(self.settings, extra, mode="danbooru"),
                layout_rule_suffix=build_rule_suffix(self.settings, extra, mode="layout", for_json_layout=True),
                force_size=force_size,
            )
        except (TypeError, ValueError) as exc:
            raise InvalidRequestError(str(exc)) from exc

        caption_prompt, layout_prompt, dan_out = build_prompt_outputs(
            payload,
            mode=payload["mode"],
            width=payload["width"],
            height=payload["height"],
            synthesize_missing_draft=True,
        )
        if hasattr(self, "audit") and self.audit is not None:
            self.audit.log(
                "complete_from_prompt",
                source_type=payload.get("detected_source", source_mode),
                modes=",".join(payload["modes"]),
                canvas=f"{payload['width']}x{payload['height']}",
            )
        return {
            "payload": payload,
            "detected_source": payload.get("detected_source", source_mode),
            "width": payload["width"],
            "height": payload["height"],
            "modes": payload["modes"],
            "outputs": {
                "caption_prompt": caption_prompt,
                "layout_prompt": layout_prompt,
                "danbooru_prompt": dan_out,
            },
        }

    def caption_node(self, body: dict[str, Any]) -> dict[str, Any]:
        """One model call for the graph node: image bytes → prompt+canvas+draft.

        Body: ``{mode, image:{data_url}, image_path?, extra_instruction?,
        model?, overwrite?: bool}``.  ``image`` takes priority over
        ``image_path``.  The image is read from the request body (data URL) or
        from a local file on the server; the API key never reaches the browser.
        """
        import copy
        from . import budget
        from .caption import SAFETY_PREFIX, _INSTRUCTIONS, _clean
        from .client import ChatResult
        from .layout import (
            compile_layout_prompt, draft_json, grid_overlay_data_url, layout_instruction, match_canvas_size,
        )
        from .caption_node import (
            MODES,
            _concise_summary,
            build_prompt_outputs,
            clean_widget_str,
            image_dimensions,
            normalize_modes,
            resolve_layout_output,
        )
        from .images import image_to_part
        from .sessions import decode_data_url

        mode = str(body.get("mode") or "caption")
        if mode not in MODES:
            raise InvalidRequestError(f"mode must be one of {', '.join(MODES)}.")
        raw_modes = body.get("modes")
        try:
            active_modes = normalize_modes(mode, raw_modes if raw_modes is not None else None)
        except ValueError as exc:
            raise InvalidRequestError(str(exc)) from exc

        image = body.get("image")
        image_path = clean_widget_str(body.get("image_path"), is_path=True)
        raw: bytes
        mime: str
        if isinstance(image, dict) and image.get("data_url"):
            try:
                raw, mime = decode_data_url(str(image["data_url"]))
            except ValueError as exc:
                raise InvalidRequestError(f"image rejected: {exc}") from exc
        elif image_path:
            from pathlib import Path

            path = Path(image_path)
            if not path.is_file():
                raise InvalidRequestError(f"image_path is not a file: {image_path}")
            raw = path.read_bytes()
            ext = path.suffix.lower().lstrip(".")
            mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
                    "webp": "image/webp", "gif": "image/gif"}.get(ext, "")
            if not mime:
                raise InvalidRequestError(f"unsupported image type: .{ext}")
        else:
            raise InvalidRequestError("image.data_url or image_path is required.")
        if not raw or len(raw) > MAX_BODY:
            raise InvalidRequestError("image is empty or too large (25 MB max).")
        try:
            src_w, src_h = image_dimensions(raw)
        except ValueError as exc:
            raise InvalidRequestError(str(exc)) from exc
        width, height = match_canvas_size(src_w, src_h)

        stored_part = image_to_part(
            self.media, {"base64": __import__("base64").b64encode(raw).decode("ascii"), "mime": mime}
        )
        part = to_api_part(self.media, stored_part)
        part = _shrunk_part(part)
        extra_instruction = clean_widget_str(body.get("extra_instruction"))
        req_model = clean_widget_str(body.get("model")) or None
        max_regions = self.settings.max_regions
        if body.get("max_regions") not in (None, ""):
            try:
                max_regions = max(1, min(16, int(body["max_regions"])))
            except (TypeError, ValueError):
                pass

        state: dict[str, Any] = {
            "mode": mode,
            "modes": active_modes,
            "width": width,
            "height": height,
            "source_width": src_w,
            "source_height": src_h,
        }
        last_request_id = ""

        effective_model = req_model or self.settings.model
        is_mock_model = effective_model in ("vision-pro", "demo-model", "caption-model", "empty-model")
        want_layout = ("layout" in active_modes) or ("hybrid" in active_modes)
        warnings: list[str] = []
        # 布局反推先用纯自然语言（prose）反推一次并合并进 layout 的 caption_hint
        if "caption" in active_modes or (want_layout and not is_mock_model):
            base_fmt = "prose"
            cap_text_prompt = (
                SAFETY_PREFIX
                + _INSTRUCTIONS[base_fmt]
                + build_rule_suffix(self.settings, extra_instruction, mode="caption")
            )
            cap_res: ChatResult = budget.call(
                self.client,
                [{"role": "user", "content": [{"type": "text", "text": cap_text_prompt}, part]}],
                model=req_model,
                temperature=0.3,
                retry_when=budget.truncated,
            )
            last_request_id = cap_res.request_id
            cleaned_cap = _clean(cap_res.text, base_fmt)
            if not cleaned_cap and "caption" in active_modes:
                if cap_res.finish_reason == "content_filter":
                    if not want_layout:
                        raise InvalidRequestError(
                            "散文反推触发上游安全策略拦截 (content_filter)，未生成内容。请更换视觉模型后重试。"
                        )
                    warnings.append("⚠️ 散文反推被上游安全策略拦截，已改用布局摘要作为描述。")
                elif want_layout:
                    # 布局还要跑：散文空返回不该打断整次反推，最后用布局摘要兜底
                    warnings.append("⚠️ 散文反推这次没返回文字（模型空回），已改用布局摘要作为描述。")
                else:
                    raise InvalidRequestError(
                        "散文反推返回为空：模型这次没吐文字，重试或换一个视觉模型。"
                    )
            if cleaned_cap:
                state["caption"] = cleaned_cap
                state["caption_text"] = cleaned_cap

        if want_layout:
            target_layout_mode = "hybrid" if "hybrid" in active_modes else "layout"
            lay_extra = build_rule_suffix(
                self.settings, extra_instruction, mode="layout", for_json_layout=True
            ).strip()
            ref_cap = str(state.get("caption") or state.get("caption_text") or "").strip()
            lay_text_prompt = SAFETY_PREFIX + layout_instruction(
                target_layout_mode,
                width,
                height,
                lay_extra,
                max_regions=max_regions,
                model=effective_model,
                caption_hint=ref_cap,
            )
            lay_res: ChatResult = budget.call(
                self.client,
                [{"role": "user", "content": [{"type": "text", "text": lay_text_prompt}, part]}],
                model=req_model,
                temperature=0.3,
                retry_when=budget.truncated,
            )
            last_request_id = lay_res.request_id
            try:
                draft, lay_warning = resolve_layout_output(
                    raw_text=lay_res.text,
                    finish_reason=lay_res.finish_reason,
                    width=width,
                    height=height,
                    max_regions=max_regions,
                    active_modes=active_modes,
                    existing_caption=ref_cap,
                )
            except ValueError as exc:
                raise InvalidRequestError(str(exc)) from exc
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

        if "danbooru" in active_modes:
            dan_instr = (
                SAFETY_PREFIX
                + _INSTRUCTIONS["danbooru"]
                + build_rule_suffix(self.settings, extra_instruction, mode="danbooru")
            )
            dan_res: ChatResult = budget.call(
                self.client,
                [{"role": "user", "content": [{"type": "text", "text": dan_instr}, part]}],
                model=req_model,
                temperature=0.3,
                budget=budget.TAG_BUDGET,
                retry_when=budget.truncated,
            )
            last_request_id = dan_res.request_id
            dan_text = _clean(dan_res.text, "danbooru")
            if not dan_text and dan_res.finish_reason == "content_filter":
                if state.get("caption") or state.get("draft"):
                    warnings.append("⚠️ Danbooru 标签反推触发上游安全策略拦截 (content_filter)，暂未生成标签。")
                else:
                    raise InvalidRequestError(
                        "Danbooru 反推触发上游安全策略拦截 (content_filter)，未返回标签。可切换视觉模型重试。"
                    )
            state["danbooru_prompt"] = dan_text
            state["danbooru_text"] = dan_text
            state["tags"] = dan_text

        if warnings:
            state["warning"] = " ".join(warnings)
        state.setdefault("caption", "")
        state["request_id"] = last_request_id
        caption_prompt, layout_prompt, dan_out = build_prompt_outputs(
            state, mode=mode, width=width, height=height, synthesize_missing_draft=True
        )
        hybrid_prompt = (
            compile_layout_prompt(state.get("hybrid_draft") or state.get("draft"))
            if (state.get("hybrid_draft") or state.get("draft"))
            else layout_prompt
        )
        self.audit.log(
            "node_caption", request_id=last_request_id, mode=",".join(active_modes),
            source=f"{src_w}x{src_h}", canvas=f"{width}x{height}",
            operation="stream",
        )
        out: dict[str, Any] = {
            "mode": mode,
            "modes": active_modes,
            "width": width,
            "height": height,
            "source_width": src_w,
            "source_height": src_h,
            "caption": state.get("caption") or "",
            "draft": state.get("draft"),
            "outputs": {
                "caption_prompt": caption_prompt,
                "layout_prompt": layout_prompt,
                "danbooru_prompt": dan_out,
                "hybrid_prompt": hybrid_prompt,
            },
            "payload": state,
            "request_id": last_request_id,
        }
        if warnings:
            out["warning"] = state["warning"]
        session_id = self._optional_session(body, f"节点反推 ({','.join(active_modes)})")
        if session_id:
            user_note = f"[节点图像反推 · 模式: {','.join(active_modes)} · 画布: {width}×{height}]"
            if extra_instruction.strip():
                user_note += f" 补充要求：{extra_instruction.strip()}"
            self.sessions.append(session_id, "user", [{"type": "text", "text": user_note}, stored_part])
            summary_note = state.get("caption") or state.get("danbooru_prompt") or ""
            if state.get("draft") and isinstance(state["draft"].get("items"), list):
                items_desc = "; ".join(
                    f"#{idx + 1} {it.get('label')}: {it.get('caption')}"
                    for idx, it in enumerate(state["draft"]["items"])
                )
                summary_note = f"{summary_note}\n[布局区域 ({len(state['draft']['items'])}): {items_desc}]".strip()
            if state.get("warning"):
                summary_note = f"{summary_note}\n{state['warning']}".strip()
            if summary_note:
                self.sessions.append(session_id, "assistant", summary_note)
            out["session_id"] = session_id
        return out

    def apply_edits(self, body: dict[str, Any]) -> dict[str, Any]:
        text = body.get("text")
        if not isinstance(text, str):
            raise InvalidRequestError("text must be a string.")
        ops = body.get("ops")
        if not isinstance(ops, list) or not ops:
            raise InvalidRequestError("ops must be a non-empty array.")
        return preview_ops(text, ops)

    # -------------------------------------------------------------- history
    def add_version(self, body: dict[str, Any]) -> dict[str, Any]:
        target = body.get("target")
        text = body.get("text")
        if not isinstance(target, str) or not target.strip():
            raise InvalidRequestError("target is required.")
        if not isinstance(text, str):
            raise InvalidRequestError("text must be a string.")
        meta = body.get("meta") if isinstance(body.get("meta"), dict) else None
        return self.versions.add(
            target,
            text,
            source=str(body.get("source") or "apply"),
            label=body.get("label"),
            meta=meta,
        )

    # -------------------------------------------------------------- presets
    def list_presets(self, *, category: str | None = None, search: str | None = None) -> list[dict[str, Any]]:
        return self.presets.list(category=category, search=search)

    def get_preset(self, preset_id: str) -> dict[str, Any]:
        p = self.presets.get(preset_id)
        if not p:
            raise NotFoundError(f"Preset {preset_id} not found.")
        return p

    def save_preset(self, body: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(body, dict):
            raise InvalidRequestError("Preset data must be an object.")
        try:
            return self.presets.save(body)
        except ValueError as err:
            raise InvalidRequestError(str(err)) from err

    def delete_preset(self, preset_id: str) -> dict[str, Any]:
        try:
            ok = self.presets.delete(preset_id)
        except ValueError as err:
            raise InvalidRequestError(str(err)) from err
        if not ok:
            raise NotFoundError(f"Preset {preset_id} not found.")
        return {"status": "ok", "deleted_id": preset_id}

    def list_preset_categories(self) -> list[str]:
        return self.presets.categories()

    def preset_category_info(self) -> dict[str, Any]:
        return {
            "categories": self.presets.categories(),
            "custom": self.presets.custom_categories(),
        }

    def add_preset_category(self, body: dict[str, Any]) -> dict[str, Any]:
        name = body.get("name") if isinstance(body, dict) else None
        try:
            self.presets.add_category(name)
        except ValueError as err:
            raise InvalidRequestError(str(err)) from err
        return self.preset_category_info()

    def delete_preset_category(self, name: str) -> dict[str, Any]:
        try:
            result = self.presets.delete_category(name)
        except KeyError as err:
            raise NotFoundError(f"目录「{name}」不存在。") from err
        except ValueError as err:
            raise InvalidRequestError(str(err)) from err
        return {**result, **self.preset_category_info()}

    def rename_preset_category(self, old_name: str, body: dict[str, Any]) -> dict[str, Any]:
        new_name = body.get("new_name") if isinstance(body, dict) else None
        try:
            result = self.presets.rename_category(old_name, new_name)
        except ValueError as err:
            raise InvalidRequestError(str(err)) from err
        return {**result, **self.preset_category_info()}

    def import_preset_image(self, body: dict[str, Any]) -> dict[str, Any]:
        from .presets import _decode_image_payload

        image_data = body.get("image_data") if isinstance(body, dict) else None
        if not image_data:
            raise InvalidRequestError("image_data is required.")
        filename = str(body.get("filename") or "imported_preset.png")
        category = str(body.get("category") or "通用")
        try:
            raw = _decode_image_payload(image_data)
            saved = self.presets.import_from_image(raw, filename=filename, category=category)
        except (ValueError, KeyError) as err:
            raise InvalidRequestError(str(err)) from err
        return saved

    def inspect_image(self, body: dict[str, Any]) -> dict[str, Any]:
        """Read prompt & layout metadata out of an image without saving a preset."""
        from .presets import _decode_image_payload, extract_metadata_from_image

        image_data = body.get("image_data") if isinstance(body, dict) else None
        if not image_data:
            raise InvalidRequestError("image_data is required.")
        filename = str(body.get("filename") or "")
        try:
            raw = _decode_image_payload(image_data)
            meta = extract_metadata_from_image(raw, filename)
        except (ValueError, KeyError, OSError) as err:
            raise InvalidRequestError(str(err)) from err

        prompts = meta.get("prompts") if isinstance(meta.get("prompts"), dict) else {}
        draft = meta.get("draft") if isinstance(meta.get("draft"), dict) else {}
        width = _as_int(meta.get("width"), 0)
        height = _as_int(meta.get("height"), 0)
        caption = str(prompts.get("caption") or "")
        layout = str(prompts.get("layout") or "")
        danbooru = str(prompts.get("danbooru") or "")
        items = draft.get("items") if isinstance(draft.get("items"), list) else []
        summary = draft.get("summary") if isinstance(draft.get("summary"), dict) else {}
        return {
            "found": bool(caption or layout or danbooru or items),
            "name": str(meta.get("name") or ""),
            "width": width,
            "height": height,
            "prompts": {"caption": caption, "layout": layout, "danbooru": danbooru},
            "draft": {
                "width": _as_int(draft.get("width"), width),
                "height": _as_int(draft.get("height"), height),
                "summary": summary,
                "items": items,
            },
        }

    def reset_builtin_presets(self) -> dict[str, Any]:
        count = self.presets.reset_builtins()
        return {"status": "ok", "reset_count": count}

    def summarize_preset_title(self, body: dict[str, Any]) -> dict[str, Any]:
        preset_id = str(body.get("preset_id") or "").strip()
        model = str(body.get("model") or "").strip() or None
        if preset_id:
            try:
                preset = self.presets.summarize_preset_title(preset_id, client=self.client, model=model)
                return {"status": "ok", "preset": preset, "title": preset["name"]}
            except KeyError as err:
                raise NotFoundError(str(err)) from err

        prompt = str(body.get("prompt") or "").strip()
        draft = body.get("draft") if isinstance(body.get("draft"), dict) else None
        from .presets import summarize_title_from_prompt

        title = summarize_title_from_prompt(self.client, prompt, draft=draft, model=model)
        return {"status": "ok", "title": title}

    def re_caption_preset(self, preset_id: str, body: dict[str, Any]) -> dict[str, Any]:
        model = str(body.get("model") or "").strip() or None
        try:
            updated = self.presets.re_caption_preset(preset_id, self, model=model)
            return {"status": "ok", "preset": updated}
        except KeyError as err:
            raise NotFoundError(str(err)) from err
        except ValueError as err:
            raise InvalidRequestError(str(err)) from err

    def reload_preset_metadata(self, preset_id: str) -> dict[str, Any]:
        try:
            updated = self.presets.reload_preset_metadata(preset_id)
            return {"status": "ok", "preset": updated}
        except KeyError as err:
            raise NotFoundError(str(err)) from err
        except ValueError as err:
            raise InvalidRequestError(str(err)) from err

    def get_preset_image(self, preset_id: str) -> tuple[bytes, str, str]:
        found = self.presets.get_image(preset_id)
        if found is None:
            raise NotFoundError("该预设没有附带原图。")
        return found

    def import_presets(self, body: dict[str, Any]) -> dict[str, Any]:
        items = body.get("presets") if isinstance(body, dict) else None
        if not isinstance(items, list):
            raise InvalidRequestError("presets must be an array.")
        count = self.presets.import_presets(items)
        return {"status": "ok", "imported": count}

    def export_presets(self) -> list[dict[str, Any]]:
        return self.presets.export_all()

    # --------------------------------------------------------- lora presets
    def list_lora_presets(self, *, category: str | None = None, search: str | None = None) -> list[dict[str, Any]]:
        return self.lora_presets.list(category=category, search=search)

    def get_lora_preset(self, preset_id: str) -> dict[str, Any]:
        p = self.lora_presets.get(preset_id)
        if not p:
            raise NotFoundError(f"LoRA preset {preset_id} not found.")
        return p

    def save_lora_preset(self, body: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(body, dict):
            raise InvalidRequestError("LoRA preset data must be an object.")
        try:
            return self.lora_presets.save(body)
        except ValueError as err:
            raise InvalidRequestError(str(err)) from err

    def delete_lora_preset(self, preset_id: str) -> dict[str, Any]:
        try:
            ok = self.lora_presets.delete(preset_id)
        except ValueError as err:
            raise InvalidRequestError(str(err)) from err
        if not ok:
            raise NotFoundError(f"LoRA preset {preset_id} not found.")
        return {"status": "ok", "deleted_id": preset_id}

    def list_lora_categories(self) -> list[str]:
        return self.lora_presets.categories()

    def lora_category_info(self) -> dict[str, Any]:
        return {
            "categories": self.lora_presets.categories(),
            "custom": self.lora_presets.custom_categories(),
        }

    def add_lora_category(self, body: dict[str, Any]) -> dict[str, Any]:
        name = body.get("name") if isinstance(body, dict) else None
        try:
            self.lora_presets.add_category(name)
        except ValueError as err:
            raise InvalidRequestError(str(err)) from err
        return self.lora_category_info()

    def delete_lora_category(self, name: str) -> dict[str, Any]:
        try:
            result = self.lora_presets.delete_category(name)
        except KeyError as err:
            raise NotFoundError(f"分类「{name}」不存在。") from err
        except ValueError as err:
            raise InvalidRequestError(str(err)) from err
        return {**result, **self.lora_category_info()}

    def rename_lora_category(self, old_name: str, body: dict[str, Any]) -> dict[str, Any]:
        new_name = body.get("new_name") if isinstance(body, dict) else None
        try:
            result = self.lora_presets.rename_category(old_name, new_name)
        except ValueError as err:
            raise InvalidRequestError(str(err)) from err
        return {**result, **self.lora_category_info()}

    def get_lora_preset_image(self, preset_id: str) -> tuple[bytes, str, str]:
        res = self.lora_presets.get_image(preset_id)
        if not res:
            raise NotFoundError(f"Image for LoRA preset {preset_id} not found.")
        return res

    def export_lora_presets(self) -> list[dict[str, Any]]:
        return self.lora_presets.export_presets()

    def import_lora_presets(self, body: dict[str, Any]) -> dict[str, Any]:
        presets = body.get("presets") if isinstance(body, dict) else None
        if not isinstance(presets, list):
            raise InvalidRequestError("presets must be a list of preset objects.")
        return self.lora_presets.import_presets(presets)

    def reset_builtin_loras(self) -> dict[str, Any]:
        count = self.lora_presets.reset_builtins()
        return {"status": "ok", "recovered_count": count}

    def list_available_loras(self) -> list[str]:
        return scan_available_loras()

    def list_available_loras_metadata(self) -> dict[str, Any]:
        return scan_available_loras_metadata()

    def inspect_image_loras(self, body: dict[str, Any]) -> dict[str, Any]:
        """Extract LoRA stack and weights out of image bytes without saving a preset."""
        from .presets import _decode_image_payload
        raw = _decode_image_payload(body.get("image_data") or body.get("image"))
        filename = str(body.get("filename") or "")
        return extract_loras_from_image_bytes(raw, filename)


# ----------------------------------------------------------------- aiohttp
def _as_int(value: Any, default: int = 0) -> int:
    """Best-effort integer coercion for metadata fields that may arrive as text."""
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _canvas_from_body(value: Any) -> tuple[int, int] | None:
    """画布尺寸由前端上报，用于把模型给的绝对像素 bbox 换算成文档坐标系。"""
    if not isinstance(value, dict):
        return None
    try:
        w = int(float(value.get("width")))
        h = int(float(value.get("height")))
    except (TypeError, ValueError):
        return None
    if w <= 0 or h <= 0:
        return None
    return (w, h)


def _shrunk_part(part: Any) -> Any:
    """送给模型的图统一缩到长边 1280：原图 4000 像素会让请求又大又慢。"""
    url = (part.get("image_url") or {}).get("url") if isinstance(part, dict) else None
    if not isinstance(url, str):
        return part
    try:
        from .layout import shrink_data_url

        small = shrink_data_url(url)
    except Exception:
        return part
    if not small or small == url:
        return part
    return {"type": "image_url", "image_url": {"url": small}}


def _gridded_part(part: Any) -> Any:
    """布局反推送一张叠了像素刻度的图，失败就退回原图。"""
    url = (part.get("image_url") or {}).get("url") if isinstance(part, dict) else None
    if not isinstance(url, str):
        return part
    try:
        from .layout import grid_overlay_data_url

        gridded = grid_overlay_data_url(url)
    except Exception:
        return part
    if not gridded or gridded == url:
        return part
    return {"type": "image_url", "image_url": {"url": gridded}}


def _error_response(err: StudioError, *, status: int | None = None) -> web.Response:
    return web.json_response(
        {"error": err.to_dict()}, status=status or err.http_status, dumps=lambda v: json.dumps(v, ensure_ascii=False)
    )


async def _json_body(request: web.Request) -> dict[str, Any]:
    if request.content_length and request.content_length > MAX_BODY:
        raise InvalidRequestError("request body is too large.")
    try:
        body = await request.json()
    except (ValueError, UnicodeDecodeError) as exc:
        raise InvalidRequestError("request body must be valid JSON.") from exc
    if not isinstance(body, dict):
        raise InvalidRequestError("request body must be a JSON object.")
    return body


async def _aiter_sync(gen: Iterator[Any]) -> AsyncIterator[Any]:
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()

    def run() -> None:
        try:
            for item in gen:
                loop.call_soon_threadsafe(queue.put_nowait, ("item", item))
        except BaseException as exc:  # noqa: BLE001
            loop.call_soon_threadsafe(queue.put_nowait, ("error", exc))
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, ("end", None))

    threading.Thread(target=run, daemon=True).start()
    while True:
        kind, payload = await queue.get()
        if kind == "end":
            return
        if kind == "error":
            raise payload
        yield payload


def _chain_first(first: Any, rest: Iterator[Any]) -> Iterator[Any]:
    if first is not None:
        yield first
    yield from rest


def install_routes(
    routes: Any,
    backend: StudioBackend | None,
    backend_getter: Any = None,
) -> None:
    """Register handlers on a RouteTableDef (ComfyUI server or test app).

    ``backend_getter`` lets the ComfyUI side rebuild the backend on demand: if
    the plugin started before an API key existed, every route would otherwise
    stay dead until the next full restart (including the very route that saves
    the key).
    """

    def require() -> StudioBackend:
        nonlocal backend
        if backend is None and backend_getter is not None:
            backend = backend_getter()
        if backend is None:
            raise ConfigError("ComfyUI AI Prompt Studio is not configured. Run prompt_studio.credentials set.")
        return backend

    def guarded(handler: Any) -> Any:
        """Turn StudioError into a JSON 4xx/5xx response.

        ComfyUI hands us a RouteTableDef, not an Application, so we cannot add
        the error middleware there.  Wrapping each handler keeps validation
        failures (bad JSON, missing fields, unknown sessions) as ordinary
        responses instead of aiohttp's bare 500.
        """

        async def wrapper(request: web.Request) -> web.StreamResponse:
            try:
                return await handler(request)
            except StudioError as err:
                return _error_response(err)

        wrapper.__name__ = getattr(handler, "__name__", "handler")
        return wrapper

    @routes.get("/ai_prompt_studio/health")
    @guarded
    async def health(_request: web.Request) -> web.Response:
        return web.json_response({"status": "ok", "version": __version__})

    @routes.get("/ai_prompt_studio/status")
    @guarded
    async def status(_request: web.Request) -> web.Response:
        return web.json_response(require().status())

    @routes.get("/ai_prompt_studio/models")
    @guarded
    async def list_models_route(_request: web.Request) -> web.Response:
        result = await asyncio.to_thread(require().list_models)
        return web.json_response(result)

    @routes.post("/ai_prompt_studio/config")
    @guarded
    async def save_config(request: web.Request) -> web.Response:
        """Save URL/model/prompt rules and optionally replace the key in the OS vault.

        The key is accepted here only because the user explicitly asked for a
        browser entry.  It is never echoed, logged or written to the metadata
        file: ``save_credentials`` puts it in Windows Credential Manager.
        """
        body = await _json_body(request)
        from .config import normalize_base_url
        from .errors import ConfigError

        service = require()
        raw_base_url = body.get("base_url")
        if raw_base_url in (None, ""):
            raw_base_url = service.settings.base_url
        try:
            base_url = normalize_base_url(str(raw_base_url or ""))
        except ConfigError as exc:
            raise InvalidRequestError(str(exc)) from exc
        model = str(body.get("model") or service.settings.model or "").strip()
        if not model:
            raise InvalidRequestError("model is required.")
        timeout_raw = body.get("timeout_s")
        retries_raw = body.get("max_retries")
        try:
            timeout_s = float(timeout_raw) if timeout_raw not in (None, "") else service.settings.timeout_s
            max_retries = int(retries_raw) if retries_raw not in (None, "") else service.settings.max_retries
        except (TypeError, ValueError) as exc:
            raise InvalidRequestError("timeout_s must be a number; max_retries an integer.") from exc
        if not 10 <= timeout_s <= 300:
            raise InvalidRequestError("timeout_s must be between 10 and 300 seconds.")
        if not 0 <= max_retries <= 3:
            raise InvalidRequestError("max_retries must be between 0 and 3.")

        rule_preset = str(body.get("rule_preset") or service.settings.rule_preset or "moss").strip().lower()
        if rule_preset not in RULE_PRESETS:
            raise InvalidRequestError(f"rule_preset must be one of {', '.join(RULE_PRESETS)}.")
        output_language = str(body.get("output_language") or service.settings.output_language or "en").strip().lower()
        if output_language not in OUTPUT_LANGUAGES:
            raise InvalidRequestError(f"output_language must be one of {', '.join(OUTPUT_LANGUAGES)}.")
        prompt_rules = (
            str(body["prompt_rules"]).strip()
            if "prompt_rules" in body and body["prompt_rules"] is not None
            else service.settings.prompt_rules
        )
        user_custom_rules = (
            str(body["user_custom_rules"]).strip()
            if "user_custom_rules" in body and body["user_custom_rules"] is not None
            else service.settings.user_custom_rules
        )
        caption_rules = (
            str(body["caption_rules"]).strip()
            if "caption_rules" in body and body["caption_rules"] is not None
            else service.settings.caption_rules
        )
        layout_rules = (
            str(body["layout_rules"]).strip()
            if "layout_rules" in body and body["layout_rules"] is not None
            else service.settings.layout_rules
        )
        danbooru_rules = (
            str(body["danbooru_rules"]).strip()
            if "danbooru_rules" in body and body["danbooru_rules"] is not None
            else service.settings.danbooru_rules
        )
        max_regions_raw = body.get("max_regions")
        try:
            max_regions = int(max_regions_raw) if max_regions_raw not in (None, "") else service.settings.max_regions
        except (TypeError, ValueError) as exc:
            raise InvalidRequestError("max_regions must be an integer between 1 and 16.") from exc
        if not 1 <= max_regions <= 16:
            raise InvalidRequestError("max_regions must be between 1 and 16.")

        supplied_key = body.get("api_key")
        if supplied_key is not None and not isinstance(supplied_key, str):
            raise InvalidRequestError("api_key must be a string.")
        api_key = (supplied_key or "").strip()
        if not api_key and not service.settings.api_key:
            raise InvalidRequestError("api_key is required when no key is configured.")

        is_default_home = service.settings.home.resolve() == default_home().resolve()
        cred_path = None if is_default_home else (service.settings.home / "credentials.json")
        cred_target = "default" if is_default_home else f"test-{service.settings.home.name}"
        if api_key:
            # An explicit key written here replaces the primary entry and becomes
            # active; keys added through /keys are left alone.
            await asyncio.to_thread(
                save_credentials, base_url, api_key, model, cred_path, target=cred_target
            )
        else:
            # Nothing typed: keep every stored secret exactly as it is.
            await asyncio.to_thread(
                update_metadata, base_url, model, cred_path, target=cred_target
            )
        creds = await asyncio.to_thread(Credentials.load, cred_path)
        await asyncio.to_thread(
            save_preferences,
            service.settings.home,
            {
                "timeout_s": timeout_s,
                "max_retries": max_retries,
                "rule_preset": rule_preset,
                "output_language": output_language,
                "prompt_rules": prompt_rules,
                "user_custom_rules": user_custom_rules,
                "caption_rules": caption_rules,
                "layout_rules": layout_rules,
                "danbooru_rules": danbooru_rules,
                "max_regions": max_regions,
            },
        )
        service.settings.base_url = base_url
        service.settings.model = model
        active_key = api_key or (creds.api_key if creds else service.settings.api_key)
        service.settings.api_key = active_key
        if creds is not None:
            service.settings.active_key_id = creds.active_key_id
        service.settings.api_keys = await asyncio.to_thread(key_list, cred_path)
        service.settings.timeout_s = timeout_s
        service.settings.max_retries = max_retries
        service.settings.rule_preset = rule_preset
        service.settings.output_language = output_language
        service.settings.prompt_rules = prompt_rules
        service.settings.user_custom_rules = user_custom_rules
        service.settings.caption_rules = caption_rules
        service.settings.layout_rules = layout_rules
        service.settings.danbooru_rules = danbooru_rules
        service.settings.max_regions = max_regions
        service.client.settings = service.settings
        service.redactor = Redactor([active_key])
        service.audit = AuditLogger(service.settings.audit_path, service.redactor)
        service.client.audit = service.audit
        service.client.redactor = service.redactor
        service.prober._cache.clear()
        # A hand-edited URL may no longer match any saved gateway; keep the
        # profile list honest about what is actually in effect.
        active_gateway = await asyncio.to_thread(
            sync_active_gateway, service.settings.home, base_url, model
        )
        return web.json_response({
            "config": service.settings.public_dict(),
            "active_gateway_id": active_gateway,
            "message": "配置与提示词规则已保存并立即生效。",
        })

    # ------------------------------------------------------------ API keys
    def _cred_store() -> tuple[Path | None, str]:
        """Credential file and vault target prefix for this backend's home."""
        service = require()
        is_default_home = service.settings.home.resolve() == default_home().resolve()
        cred_path = None if is_default_home else (service.settings.home / "credentials.json")
        prefix = "default" if is_default_home else f"test-{service.settings.home.name}"
        return cred_path, prefix

    def _publish_keys(service: StudioBackend, creds: Credentials, cred_path: Path | None) -> dict[str, Any]:
        """Point the live backend at the active key and republish the list."""
        service.settings.api_key = creds.api_key
        service.settings.active_key_id = creds.active_key_id
        service.settings.api_keys = key_list(cred_path)
        service.redactor = Redactor([creds.api_key])
        service.audit = AuditLogger(service.settings.audit_path, service.redactor)
        service.client.settings = service.settings
        service.client.redactor = service.redactor
        service.client.audit = service.audit
        service.prober._cache.clear()
        return {
            "keys": service.settings.api_keys,
            "active_key_id": service.settings.active_key_id,
            "api_key_masked": mask_secret(creds.api_key),
        }

    @routes.get("/ai_prompt_studio/keys")
    @guarded
    async def list_keys_route(_request: web.Request) -> web.Response:
        cred_path, _prefix = _cred_store()
        service = require()
        keys = await asyncio.to_thread(key_list, cred_path)
        return web.json_response({"keys": keys, "active_key_id": service.settings.active_key_id})

    @routes.post("/ai_prompt_studio/keys")
    @guarded
    async def create_key(request: web.Request) -> web.Response:
        body = await _json_body(request)
        secret = body.get("api_key")
        if not isinstance(secret, str) or not secret.strip():
            raise InvalidRequestError("api_key must be a non-empty string.")
        label = str(body.get("label") or "").strip()[:40]
        activate = body.get("activate")
        activate = True if activate is None else bool(activate)
        cred_path, prefix = _cred_store()
        service = require()
        try:
            creds = await asyncio.to_thread(
                add_key,
                secret,
                label,
                cred_path,
                target_prefix=prefix,
                activate=activate,
            )
        except ValueError as exc:
            raise InvalidRequestError(str(exc)) from exc
        return web.json_response(_publish_keys(service, creds, cred_path))

    @routes.post("/ai_prompt_studio/keys/{key_id}/activate")
    @guarded
    async def activate_key_route(request: web.Request) -> web.Response:
        key_id = str(request.match_info.get("key_id") or "").strip()
        if not key_id:
            raise InvalidRequestError("key_id is required.")
        cred_path, _prefix = _cred_store()
        service = require()
        try:
            creds = await asyncio.to_thread(activate_key, key_id, cred_path)
        except ValueError as exc:
            raise InvalidRequestError(str(exc)) from exc
        return web.json_response(_publish_keys(service, creds, cred_path))

    @routes.delete("/ai_prompt_studio/keys/{key_id}")
    @guarded
    async def delete_key_route(request: web.Request) -> web.Response:
        key_id = str(request.match_info.get("key_id") or "").strip()
        if not key_id:
            raise InvalidRequestError("key_id is required.")
        cred_path, _prefix = _cred_store()
        service = require()
        try:
            creds = await asyncio.to_thread(delete_key, key_id, cred_path)
        except ValueError as exc:
            raise InvalidRequestError(str(exc)) from exc
        return web.json_response(_publish_keys(service, creds, cred_path))

    # --------------------------------------------------------- gateways
    def _gateway_state(service: StudioBackend, cred_path: Path | None) -> dict[str, Any]:
        listing = list_gateways(
            service.settings.home,
            credential_path=cred_path,
            current_base_url=service.settings.base_url,
            current_model=service.settings.model,
        )
        return {
            "config": service.settings.public_dict(),
            "keys": service.settings.api_keys,
            "active_key_id": service.settings.active_key_id,
            "api_key_masked": mask_secret(service.settings.api_key),
            **listing,
        }

    def _apply_gateway(service: StudioBackend, cred_path: Path | None) -> None:
        """Point the live backend at the gateway now stored in credentials."""
        creds = Credentials.load(cred_path)
        if creds is None:
            return
        service.settings.base_url = creds.base_url
        service.settings.model = creds.model
        service.settings.api_key = creds.api_key
        service.settings.active_key_id = creds.active_key_id
        service.settings.api_keys = key_list(cred_path)
        service.redactor = Redactor([creds.api_key])
        service.audit = AuditLogger(service.settings.audit_path, service.redactor)
        service.client.settings = service.settings
        service.client.redactor = service.redactor
        service.client.audit = service.audit
        service.prober._cache.clear()

    @routes.get("/ai_prompt_studio/gateways")
    @guarded
    async def list_gateways_route(_request: web.Request) -> web.Response:
        cred_path, _prefix = _cred_store()
        service = require()
        return web.json_response(await asyncio.to_thread(_gateway_state, service, cred_path))

    @routes.post("/ai_prompt_studio/gateways")
    @guarded
    async def save_gateway_route(request: web.Request) -> web.Response:
        body = await _json_body(request)
        service = require()
        from .config import normalize_base_url

        raw_base_url = body.get("base_url") or service.settings.base_url
        try:
            base_url = normalize_base_url(str(raw_base_url or ""))
        except ConfigError as exc:
            raise InvalidRequestError(str(exc)) from exc
        model = str(body.get("model") or service.settings.model or "").strip()
        if not model:
            raise InvalidRequestError("model is required.")
        label = str(body.get("label") or "").strip()
        key_id = body.get("key_id")
        if key_id is None:
            key_id = service.settings.active_key_id
        activate = body.get("activate")
        activate = True if activate is None else bool(activate)
        cred_path, _prefix = _cred_store()
        try:
            profile = await asyncio.to_thread(
                save_gateway,
                service.settings.home,
                base_url=base_url,
                model=model,
                label=label,
                key_id=str(key_id or ""),
                activate=False,
                credential_path=cred_path,
            )
            if activate:
                profile = await asyncio.to_thread(
                    activate_gateway,
                    service.settings.home,
                    profile["id"],
                    credential_path=cred_path,
                )
        except (ConfigError, ValueError) as exc:
            raise InvalidRequestError(str(exc)) from exc
        if activate:
            _apply_gateway(service, cred_path)
        return web.json_response({"gateway": profile, **_gateway_state(service, cred_path)})

    @routes.post("/ai_prompt_studio/gateways/{gateway_id}/activate")
    @guarded
    async def activate_gateway_route(request: web.Request) -> web.Response:
        gateway_id = str(request.match_info.get("gateway_id") or "").strip()
        if not gateway_id:
            raise InvalidRequestError("gateway_id is required.")
        service = require()
        cred_path, _prefix = _cred_store()
        try:
            profile = await asyncio.to_thread(
                activate_gateway, service.settings.home, gateway_id, credential_path=cred_path
            )
        except KeyError as exc:
            raise InvalidRequestError(str(exc)) from exc
        except ValueError as exc:
            raise InvalidRequestError(str(exc)) from exc
        _apply_gateway(service, cred_path)
        return web.json_response({"gateway": profile, **_gateway_state(service, cred_path)})

    @routes.delete("/ai_prompt_studio/gateways/{gateway_id}")
    @guarded
    async def delete_gateway_route(request: web.Request) -> web.Response:
        gateway_id = str(request.match_info.get("gateway_id") or "").strip()
        if not gateway_id:
            raise InvalidRequestError("gateway_id is required.")
        service = require()
        cred_path, _prefix = _cred_store()
        removed = await asyncio.to_thread(delete_gateway, service.settings.home, gateway_id)
        if not removed:
            raise InvalidRequestError(f"未知的网关 id：{gateway_id}")
        return web.json_response(_gateway_state(service, cred_path))

    @routes.get("/ai_prompt_studio/capabilities")
    @guarded
    async def capabilities(_request: web.Request) -> web.Response:
        return web.json_response(require().capabilities())

    @routes.post("/ai_prompt_studio/probe")
    @guarded
    async def probe(request: web.Request) -> web.Response:
        body = await _json_body(request)
        report = await asyncio.to_thread(require().probe, force=bool(body.get("force")))
        return web.json_response(report)

    @routes.post("/ai_prompt_studio/chat")
    @guarded
    async def chat(request: web.Request) -> web.StreamResponse:
        service = require()
        body = await _json_body(request)
        events = service.chat_events(body)
        # Run up to the first event before committing to a 200 stream, so
        # request validation still yields an ordinary 4xx JSON response.
        first = await asyncio.to_thread(next, events, None)
        response = web.StreamResponse(
            status=200,
            headers={
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
            },
        )
        await response.prepare(request)
        try:
            pending: AsyncIterator[tuple[str, dict[str, Any]]] = _aiter_sync(_chain_first(first, events))
            async for name, data in pending:
                payload = json.dumps(service.redactor.scrub(data), ensure_ascii=False)
                await response.write(f"event: {name}\ndata: {payload}\n\n".encode("utf-8"))
        except ConnectionResetError:
            return response
        except StudioError as err:
            payload = json.dumps(err.to_dict(), ensure_ascii=False)
            try:
                await response.write(f"event: error\ndata: {payload}\n\n".encode("utf-8"))
            except ConnectionResetError:
                return response
        await response.write_eof()
        return response

    @routes.post("/ai_prompt_studio/edit")
    @guarded
    async def edit(request: web.Request) -> web.Response:
        body = await _json_body(request)
        result = await asyncio.to_thread(require().edit, body)
        return web.json_response(result)

    @routes.post("/ai_prompt_studio/caption")
    @guarded
    async def caption(request: web.Request) -> web.Response:
        body = await _json_body(request)
        result = await asyncio.to_thread(require().caption, body)
        return web.json_response(result)

    @routes.post("/ai_prompt_studio/caption_node")
    @guarded
    async def caption_node(request: web.Request) -> web.Response:
        body = await _json_body(request)
        result = await asyncio.to_thread(require().caption_node, body)
        return web.json_response(result)

    @routes.post("/ai_prompt_studio/brainstorm")
    @guarded
    async def brainstorm(request: web.Request) -> web.Response:
        body = await _json_body(request)
        result = await asyncio.to_thread(require().brainstorm, body)
        return web.json_response(result)

    @routes.post("/ai_prompt_studio/imagine")
    @guarded
    async def imagine(request: web.Request) -> web.Response:
        body = await _json_body(request)
        result = await asyncio.to_thread(require().imagine, body)
        return web.json_response(result)

    @routes.post("/ai_prompt_studio/imagine_expand")
    @guarded
    async def imagine_expand(request: web.Request) -> web.Response:
        body = await _json_body(request)
        result = await asyncio.to_thread(require().imagine_expand, body)
        return web.json_response(result)

    @routes.post("/ai_prompt_studio/complete_from_prompt")
    @guarded
    async def complete_from_prompt_route(request: web.Request) -> web.Response:
        body = await _json_body(request)
        result = await asyncio.to_thread(require().complete_from_prompt, body)
        return web.json_response(result)

    @routes.post("/ai_prompt_studio/cloud_generate")
    @guarded
    async def cloud_generate(request: web.Request) -> web.Response:
        """Generate prompt/node payload via remote API/imagine_expand."""
        body = await _json_body(request)
        prompt = str(body.get("prompt") or "").strip()
        if not prompt:
            raise InvalidRequestError("prompt is required.")
        width = int(body.get("width") or 0)
        height = int(body.get("height") or 0)
        mode = str(body.get("mode") or "caption").strip()
        model = str(body.get("model") or "").strip() or None

        service = require()
        expand_body: dict[str, Any] = {
            "prompt": prompt,
            "modes": [mode] if mode else ["caption"],
            "width": width or 1024,
            "height": height or 1024,
            "model": model,
        }
        payload_res = await asyncio.to_thread(service.imagine_expand, expand_body)
        return web.json_response({
            "payload": payload_res["payload"],
            "width": payload_res["width"],
            "height": payload_res["height"],
            "modes": payload_res["modes"],
            "generated_image": None,
        })


    @routes.post("/ai_prompt_studio/apply")
    @guarded
    async def apply(request: web.Request) -> web.Response:
        body = await _json_body(request)
        return web.json_response(require().apply_edits(body))

    @routes.get("/ai_prompt_studio/versions")
    @guarded
    async def list_versions(request: web.Request) -> web.Response:
        target = request.query.get("target") or ""
        if not target:
            raise InvalidRequestError("target query parameter is required.")
        limit = request.query.get("limit") or "50"
        try:
            limit_int = max(1, min(200, int(limit)))
        except ValueError:
            limit_int = 50
        return web.json_response({"versions": require().versions.list(target, limit=limit_int)})

    @routes.post("/ai_prompt_studio/versions")
    @guarded
    async def add_version(request: web.Request) -> web.Response:
        body = await _json_body(request)
        return web.json_response(require().add_version(body))

    @routes.get("/ai_prompt_studio/versions/{version_id}")
    @guarded
    async def get_version(request: web.Request) -> web.Response:
        version = require().versions.get(request.match_info["version_id"])
        if version is None:
            raise NotFoundError("Version not found.")
        return web.json_response(version)

    @routes.get("/ai_prompt_studio/sessions")
    @guarded
    async def list_sessions(_request: web.Request) -> web.Response:
        return web.json_response({"sessions": require().sessions.list()})

    @routes.post("/ai_prompt_studio/sessions")
    @guarded
    async def create_session(request: web.Request) -> web.Response:
        body = await _json_body(request)
        return web.json_response(require().sessions.create(str(body.get("title") or "") or None), status=201)

    @routes.get("/ai_prompt_studio/sessions/{session_id}")
    @guarded
    async def get_session(request: web.Request) -> web.Response:
        service = require()
        session_id = request.match_info["session_id"]
        session = service.sessions.get(session_id)
        if session is None:
            raise NotFoundError("Session not found.")
        return web.json_response(
            {"session": session, "messages": service.sessions.messages(session_id)}
        )

    @routes.delete("/ai_prompt_studio/sessions/{session_id}")
    @guarded
    async def delete_session(request: web.Request) -> web.Response:
        if not require().sessions.delete(request.match_info["session_id"]):
            raise NotFoundError("Session not found.")
        return web.json_response({"deleted": True})

    @routes.get("/ai_prompt_studio/presets")
    @guarded
    async def list_presets_route(request: web.Request) -> web.Response:
        category = request.query.get("category")
        search = request.query.get("search")
        presets = await asyncio.to_thread(require().list_presets, category=category, search=search)
        return web.json_response({"presets": presets})

    @routes.get("/ai_prompt_studio/presets/categories")
    @guarded
    async def list_preset_categories_route(_request: web.Request) -> web.Response:
        info = await asyncio.to_thread(require().preset_category_info)
        return web.json_response(info)

    @routes.post("/ai_prompt_studio/presets/categories")
    @guarded
    async def add_preset_category_route(request: web.Request) -> web.Response:
        body = await _json_body(request)
        info = await asyncio.to_thread(require().add_preset_category, body)
        return web.json_response(info)

    @routes.delete("/ai_prompt_studio/presets/categories/{name}")
    @guarded
    async def delete_preset_category_route(request: web.Request) -> web.Response:
        name = request.match_info["name"]
        info = await asyncio.to_thread(require().delete_preset_category, name)
        return web.json_response(info)

    @routes.put("/ai_prompt_studio/presets/categories/{name}")
    @guarded
    async def rename_preset_category_route(request: web.Request) -> web.Response:
        name = request.match_info["name"]
        body = await _json_body(request)
        info = await asyncio.to_thread(require().rename_preset_category, name, body)
        return web.json_response(info)

    @routes.post("/ai_prompt_studio/presets/import_image")
    @guarded
    async def import_preset_image_route(request: web.Request) -> web.Response:
        body = await _json_body(request)
        saved = await asyncio.to_thread(require().import_preset_image, body)
        return web.json_response(saved, status=201)

    @routes.post("/ai_prompt_studio/inspect_image")
    @guarded
    async def inspect_image_route(request: web.Request) -> web.Response:
        body = await _json_body(request)
        res = await asyncio.to_thread(require().inspect_image, body)
        return web.json_response(res)

    @routes.post("/ai_prompt_studio/presets/reset_builtins")
    @guarded
    async def reset_builtins_route(_request: web.Request) -> web.Response:
        res = await asyncio.to_thread(require().reset_builtin_presets)
        return web.json_response(res)

    @routes.post("/ai_prompt_studio/presets/summarize_title")
    @guarded
    async def summarize_title_route(request: web.Request) -> web.Response:
        body = await _json_body(request)
        res = await asyncio.to_thread(require().summarize_preset_title, body)
        return web.json_response(res)

    @routes.post("/ai_prompt_studio/presets/{preset_id}/re_caption")
    @guarded
    async def re_caption_preset_route(request: web.Request) -> web.Response:
        preset_id = request.match_info["preset_id"]
        body = await _json_body(request)
        res = await asyncio.to_thread(require().re_caption_preset, preset_id, body)
        return web.json_response(res)

    @routes.post("/ai_prompt_studio/presets/{preset_id}/reload_metadata")
    @guarded
    async def reload_preset_metadata_route(request: web.Request) -> web.Response:
        preset_id = request.match_info["preset_id"]
        res = await asyncio.to_thread(require().reload_preset_metadata, preset_id)
        return web.json_response(res)

    @routes.get("/ai_prompt_studio/presets/{preset_id}/image")
    @guarded
    async def get_preset_image_route(request: web.Request) -> web.Response:
        raw, mime, filename = await asyncio.to_thread(require().get_preset_image, request.match_info["preset_id"])
        return web.Response(
            body=raw,
            content_type=mime,
            headers={
                "Content-Disposition": f'inline; filename="{filename}"',
                "Cache-Control": "private, max-age=300",
                "X-Content-Type-Options": "nosniff",
            },
        )

    @routes.get("/ai_prompt_studio/presets/export")
    @guarded
    async def export_presets_route(_request: web.Request) -> web.Response:
        data = await asyncio.to_thread(require().export_presets)
        return web.json_response({"presets": data})

    @routes.get("/ai_prompt_studio/presets/{preset_id}")
    @guarded
    async def get_preset_route(request: web.Request) -> web.Response:
        preset_id = request.match_info["preset_id"]
        preset = await asyncio.to_thread(require().get_preset, preset_id)
        return web.json_response(preset)

    @routes.post("/ai_prompt_studio/presets")
    @guarded
    async def save_preset_route(request: web.Request) -> web.Response:
        body = await _json_body(request)
        saved = await asyncio.to_thread(require().save_preset, body)
        return web.json_response(saved, status=200)

    @routes.delete("/ai_prompt_studio/presets/{preset_id}")
    @guarded
    async def delete_preset_route(request: web.Request) -> web.Response:
        preset_id = request.match_info["preset_id"]
        res = await asyncio.to_thread(require().delete_preset, preset_id)
        return web.json_response(res)

    @routes.post("/ai_prompt_studio/presets/import")
    @guarded
    async def import_presets_route(request: web.Request) -> web.Response:
        body = await _json_body(request)
        res = await asyncio.to_thread(require().import_presets, body)
        return web.json_response(res)

    # --------------------------------------------------- lora preset routes
    @routes.get("/ai_prompt_studio/lora_presets")
    @guarded
    async def list_lora_presets_route(request: web.Request) -> web.Response:
        category = request.query.get("category")
        search = request.query.get("search")
        data = await asyncio.to_thread(require().list_lora_presets, category=category, search=search)
        return web.json_response({"presets": data})

    @routes.get("/ai_prompt_studio/lora_presets/available_loras")
    @guarded
    async def available_loras_route(_request: web.Request) -> web.Response:
        data = await asyncio.to_thread(require().list_available_loras)
        details = await asyncio.to_thread(require().list_available_loras_metadata)
        return web.json_response({"loras": data, "lora_details": details})

    @routes.get("/ai_prompt_studio/lora_presets/preview_image")
    @guarded
    async def lora_preview_image_route(request: web.Request) -> web.Response:
        name = request.query.get("name", "").strip()
        if not name:
            return web.Response(status=400, text="name is required")
        img_path = await asyncio.to_thread(find_lora_preview_path, name)
        if not img_path or not os.path.isfile(img_path):
            return web.Response(status=404, text="No preview image found")
        ext = os.path.splitext(img_path)[1].lower()
        content_type = "image/png"
        if ext in (".jpg", ".jpeg"):
            content_type = "image/jpeg"
        elif ext == ".webp":
            content_type = "image/webp"
        with open(img_path, "rb") as fp:
            img_data = fp.read()
        return web.Response(body=img_data, content_type=content_type, headers={"Cache-Control": "public, max-age=3600"})

    @routes.post("/ai_prompt_studio/lora_presets/inspect_image_loras")
    @guarded
    async def inspect_image_loras_route(request: web.Request) -> web.Response:
        body = await _json_body(request)
        res = await asyncio.to_thread(require().inspect_image_loras, body)
        return web.json_response(res)

    @routes.get("/ai_prompt_studio/lora_presets/categories")
    @guarded
    async def list_lora_preset_categories_route(_request: web.Request) -> web.Response:
        info = await asyncio.to_thread(require().lora_category_info)
        return web.json_response(info)

    @routes.post("/ai_prompt_studio/lora_presets/categories")
    @guarded
    async def add_lora_preset_category_route(request: web.Request) -> web.Response:
        body = await _json_body(request)
        info = await asyncio.to_thread(require().add_lora_category, body)
        return web.json_response(info, status=201)

    @routes.delete("/ai_prompt_studio/lora_presets/categories/{name}")
    @guarded
    async def delete_lora_preset_category_route(request: web.Request) -> web.Response:
        name = request.match_info["name"]
        info = await asyncio.to_thread(require().delete_lora_category, name)
        return web.json_response(info)

    @routes.put("/ai_prompt_studio/lora_presets/categories/{name}")
    @guarded
    async def rename_lora_preset_category_route(request: web.Request) -> web.Response:
        name = request.match_info["name"]
        body = await _json_body(request)
        info = await asyncio.to_thread(require().rename_lora_category, name, body)
        return web.json_response(info)

    @routes.post("/ai_prompt_studio/lora_presets/reset_builtins")
    @guarded
    async def reset_builtin_loras_route(_request: web.Request) -> web.Response:
        res = await asyncio.to_thread(require().reset_builtin_loras)
        return web.json_response(res)

    @routes.get("/ai_prompt_studio/lora_presets/export")
    @guarded
    async def export_lora_presets_route(_request: web.Request) -> web.Response:
        data = await asyncio.to_thread(require().export_lora_presets)
        return web.json_response({"presets": data})

    @routes.post("/ai_prompt_studio/lora_presets/import")
    @guarded
    async def import_lora_presets_route(request: web.Request) -> web.Response:
        body = await _json_body(request)
        res = await asyncio.to_thread(require().import_lora_presets, body)
        return web.json_response(res)

    @routes.get("/ai_prompt_studio/lora_presets/{preset_id}/image")
    @guarded
    async def get_lora_preset_image_route(request: web.Request) -> web.Response:
        raw, mime, filename = await asyncio.to_thread(require().get_lora_preset_image, request.match_info["preset_id"])
        headers = {
            "Content-Type": mime,
            "Content-Disposition": f'inline; filename="{filename}"',
            "Cache-Control": "public, max-age=86400",
        }
        return web.Response(body=raw, headers=headers)

    @routes.get("/ai_prompt_studio/lora_presets/{preset_id}")
    @guarded
    async def get_lora_preset_route(request: web.Request) -> web.Response:
        preset_id = request.match_info["preset_id"]
        preset = await asyncio.to_thread(require().get_lora_preset, preset_id)
        return web.json_response(preset)

    @routes.post("/ai_prompt_studio/lora_presets")
    @guarded
    async def save_lora_preset_route(request: web.Request) -> web.Response:
        body = await _json_body(request)
        saved = await asyncio.to_thread(require().save_lora_preset, body)
        return web.json_response(saved, status=200)

    @routes.delete("/ai_prompt_studio/lora_presets/{preset_id}")
    @guarded
    async def delete_lora_preset_route(request: web.Request) -> web.Response:
        preset_id = request.match_info["preset_id"]
        res = await asyncio.to_thread(require().delete_lora_preset, preset_id)
        return web.json_response(res)


@web.middleware
async def _error_middleware(request: web.Request, handler: Any) -> web.StreamResponse:
    try:
        return await handler(request)
    except StudioError as err:
        return _error_response(err)


def make_routes(backend: StudioBackend | None) -> web.RouteTableDef:
    routes = web.RouteTableDef()
    install_routes(routes, backend)
    return routes


def create_app(backend: StudioBackend | None) -> web.Application:
    app = web.Application(client_max_size=MAX_BODY)
    app.add_routes(make_routes(backend))
    app.middlewares.append(_error_middleware)
    return app


__all__ = ["StudioBackend", "install_routes", "make_routes", "create_app", "EditValidationError"]
