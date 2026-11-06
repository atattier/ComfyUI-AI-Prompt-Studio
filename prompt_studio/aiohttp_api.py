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
from .config import Settings, load_settings
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

    # ------------------------------------------------------------------ chat
    def _image_parts(self, images: Any) -> list[dict[str, Any]]:
        if images in (None, []):
            return []
        if not isinstance(images, list):
            raise InvalidRequestError("images must be an array.")
        return [image_to_part(self.media, image) for image in images]

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
        message = body.get("message")
        if not isinstance(message, str) or not message.strip():
            raise InvalidRequestError("message must be a non-empty string.")
        target = self._target(body)
        if not target["text"].strip():
            raise InvalidRequestError("target.text is empty; nothing to edit.")
        parts = [to_api_part(self.media, part) for part in self._image_parts(body.get("images"))]
        proposal = request_edit(
            self.client,
            current_text=target["text"],
            instruction=message,
            target_hint=target["title"] or target["widget"],
            images=parts,
            model=body.get("model") or None,
        )
        return {"target": target, "proposal": proposal.to_dict()}

    def caption(self, body: dict[str, Any]) -> dict[str, Any]:
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
        part = to_api_part(self.media, image_to_part(self.media, image))
        cached = self.prober.cached_report()
        if cached is not None and cached.vision is False:
            raise CapabilityError(
                "The configured model was probed and does not appear to accept images.",
                detail=str((cached.details.get("vision") or {}).get("reason") or ""),
            )
        try:
            result = caption_image(
                self.client,
                part,
                fmt=formats,
                model=body.get("model") or None,
                extra_instruction=str(body.get("instruction") or ""),
            )
        except ValueError as exc:
            raise InvalidRequestError(str(exc)) from exc
        return result.to_dict()

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
