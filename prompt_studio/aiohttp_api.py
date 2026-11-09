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
from .diff import EditValidationError, preview_ops
from .edit_agent import build_chat_messages, request_edit
from .errors import (
    CapabilityError,
    ConfigError,
    InvalidRequestError,
    NotFoundError,
    StudioError,
)
from .images import image_to_part, to_api_part
from .redaction import Redactor
from .sessions import MediaStore, SessionStore
from .versions import VersionStore

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

    def close(self) -> None:
        try:
            self.sessions.close()
        finally:
            self.versions.close()

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
        effective_instruction = message + build_rule_suffix(self.settings, "")
        proposal = request_edit(
            self.client,
            current_text=target["text"],
            instruction=effective_instruction,
            target_hint=target["title"] or target["widget"],
            images=parts,
            history=history,
            model=req_model,
            allow_empty=allow_empty,
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
        combined_extra = build_rule_suffix(self.settings, extra_instruction).strip()
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
                rule_suffix=build_rule_suffix(self.settings, extra),
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
                rule_suffix=build_rule_suffix(self.settings, extra),
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
                rule_suffix=build_rule_suffix(self.settings, extra),
                layout_rule_suffix=build_rule_suffix(self.settings, extra, for_json_layout=True),
            )
        except (TypeError, ValueError) as exc:
            raise InvalidRequestError(str(exc)) from exc
        return {"payload": payload, "width": payload["width"], "height": payload["height"], "modes": payload["modes"]}

    def caption_node(self, body: dict[str, Any]) -> dict[str, Any]:
        """One model call for the graph node: image bytes → prompt+canvas+draft.

        Body: ``{mode, image:{data_url}, image_path?, extra_instruction?,
        model?, overwrite?: bool}``.  ``image`` takes priority over
        ``image_path``.  The image is read from the request body (data URL) or
        from a local file on the server; the API key never reaches the browser.
        """
        import copy
        from .caption import SAFETY_PREFIX, _INSTRUCTIONS, _clean
        from .client import ChatResult
        from .layout import (
            draft_json, layout_instruction, match_canvas_size, parse_model_layout,
        )
        from .caption_node import (
            MODES,
            _concise_summary,
            build_prompt_outputs,
            clean_widget_str,
            image_dimensions,
            normalize_modes,
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

        if "caption" in active_modes:
            base_fmt = "tags" if self.settings.rule_preset == "tags" else "prose"
            cap_text_prompt = (
                SAFETY_PREFIX
                + _INSTRUCTIONS[base_fmt]
                + build_rule_suffix(self.settings, extra_instruction)
            )
            cap_res: ChatResult = self.client.complete_via_stream(
                [{"role": "user", "content": [{"type": "text", "text": cap_text_prompt}, part]}],
                model=req_model,
                temperature=0.3,
                max_tokens=500,
            )
            last_request_id = cap_res.request_id
            cleaned_cap = _clean(cap_res.text, base_fmt)
            if not cleaned_cap:
                raise InvalidRequestError("The model returned an empty caption.")
            state["caption"] = cleaned_cap
            state["caption_text"] = cleaned_cap

        if "layout" in active_modes or "hybrid" in active_modes:
            target_layout_mode = "hybrid" if "hybrid" in active_modes else "layout"
            lay_extra = build_rule_suffix(self.settings, extra_instruction, for_json_layout=True).strip()
            lay_text_prompt = SAFETY_PREFIX + layout_instruction(
                target_layout_mode, width, height, lay_extra, max_regions=max_regions
            )
            lay_res: ChatResult = self.client.complete_via_stream(
                [{"role": "user", "content": [{"type": "text", "text": lay_text_prompt}, part]}],
                model=req_model,
                temperature=0.3,
                max_tokens=3000,
            )
            last_request_id = lay_res.request_id
            try:
                draft = parse_model_layout(lay_res.text, width, height, max_items=max_regions)
            except ValueError as exc:
                raise InvalidRequestError(
                    f"布局反推失败（模型输出不是完整 JSON，通常是被长度截断）：{exc}。"
                    "请点「反推」重试；仍失败可换模型或减少画面文字。"
                ) from exc
            full_caption = str(state.get("caption_text") or draft["summary"]["caption"]).strip()
            short_caption = (
                str(draft["summary"]["caption"]).strip()
                if target_layout_mode == "layout"
                else _concise_summary(draft["summary"]["caption"])
            )
            layout_draft = copy.deepcopy(draft)
            layout_draft["summary"]["caption"] = short_caption or full_caption
            hybrid_draft = copy.deepcopy(draft)
            hybrid_draft["summary"]["caption"] = full_caption or short_caption

            state["layout_draft"] = layout_draft
            state["hybrid_draft"] = hybrid_draft
            state["draft"] = hybrid_draft if mode == "hybrid" else (layout_draft if mode == "layout" else hybrid_draft)
            if not state.get("caption"):
                state["caption"] = str(state["draft"]["summary"]["caption"])

        if "danbooru" in active_modes:
            dan_instr = SAFETY_PREFIX + _INSTRUCTIONS["danbooru"] + build_rule_suffix(self.settings, extra_instruction)
            dan_res: ChatResult = self.client.complete_via_stream(
                [{"role": "user", "content": [{"type": "text", "text": dan_instr}, part]}],
                model=req_model,
                temperature=0.3,
                max_tokens=600,
            )
            last_request_id = dan_res.request_id
            dan_text = _clean(dan_res.text, "danbooru")
            state["danbooru_prompt"] = dan_text
            state["danbooru_text"] = dan_text
            state["tags"] = dan_text

        state["request_id"] = last_request_id
        caption_prompt, layout_prompt, dan_out = build_prompt_outputs(
            state, mode=mode, width=width, height=height, synthesize_missing_draft=True
        )
        hybrid_prompt = (
            json.dumps(state.get("hybrid_draft") or state.get("draft") or {}, ensure_ascii=False)
            if (state.get("hybrid_draft") or state.get("draft"))
            else dan_out
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
            "caption": state["caption"],
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
        session_id = self._optional_session(body, f"节点反推 ({','.join(active_modes)})")
        if session_id:
            user_note = f"[节点图像反推 · 模式: {','.join(active_modes)} · 画布: {width}×{height}]"
            if extra_instruction.strip():
                user_note += f" 补充要求：{extra_instruction.strip()}"
            self.sessions.append(session_id, "user", [{"type": "text", "text": user_note}, stored_part])
            summary_note = state["caption"]
            if state.get("draft") and isinstance(state["draft"].get("items"), list):
                items_desc = "; ".join(
                    f"#{idx + 1} {it.get('label')}: {it.get('caption')}"
                    for idx, it in enumerate(state["draft"]["items"])
                )
                summary_note = f"{state['caption']}\n[布局区域 ({len(state['draft']['items'])}): {items_desc}]"
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


# ----------------------------------------------------------------- aiohttp
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


def install_routes(routes: Any, backend: StudioBackend | None) -> None:
    """Register handlers on a RouteTableDef (ComfyUI server or test app)."""

    def require() -> StudioBackend:
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
        from .credentials import default_home, save_credentials
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
        api_key = (supplied_key or "").strip() or service.settings.api_key
        if not api_key:
            raise InvalidRequestError("api_key is required when no key is configured.")

        is_default_home = service.settings.home.resolve() == default_home().resolve()
        cred_path = None if is_default_home else (service.settings.home / "credentials.json")
        cred_target = "default" if is_default_home else f"test-{service.settings.home.name}"
        await asyncio.to_thread(
            save_credentials, base_url, api_key, model, cred_path, target=cred_target
        )
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
                "max_regions": max_regions,
            },
        )
        service.settings.base_url = base_url
        service.settings.model = model
        service.settings.api_key = api_key
        service.settings.timeout_s = timeout_s
        service.settings.max_retries = max_retries
        service.settings.rule_preset = rule_preset
        service.settings.output_language = output_language
        service.settings.prompt_rules = prompt_rules
        service.settings.user_custom_rules = user_custom_rules
        service.settings.max_regions = max_regions
        service.client.settings = service.settings
        service.redactor = Redactor([api_key])
        service.audit = AuditLogger(service.settings.audit_path, service.redactor)
        service.client.audit = service.audit
        service.client.redactor = service.redactor
        service.prober._cache.clear()
        return web.json_response({
            "config": service.settings.public_dict(),
            "message": "配置与提示词规则已保存并立即生效。",
        })

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
