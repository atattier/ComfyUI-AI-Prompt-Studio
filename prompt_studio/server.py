"""Local backend API for M0: chat, streaming, probing, sessions, audit.

Security posture for the prototype:

* binds to 127.0.0.1 by default and refuses non-loopback addresses unless
  explicitly overridden;
* every ``/api/*`` route requires a local bearer token (``X-Studio-Token`` or
  ``Authorization: Bearer``);
* the API key never appears in any response, log line or error message;
* request bodies are capped, and only JSON is accepted.

There is deliberately no frontend in M0.
"""

from __future__ import annotations

import hmac
import json
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlsplit

from . import __version__
from .audit import AuditLogger
from .capabilities import CapabilityProber
from .client import ChatClient
from .config import Settings
from .errors import (
    BodyTooLargeError,
    CapabilityError,
    InvalidRequestError,
    NotFoundError,
    ServerUnauthorizedError,
    StudioError,
)
from .redaction import Redactor
from .images import image_to_part
from .sessions import MediaStore, SessionStore

MAX_BODY_BYTES = 20 * 1024 * 1024


class Service:
    def __init__(self, settings: Settings, *, audit: AuditLogger | None = None) -> None:
        self.settings = settings
        self.redactor = Redactor([settings.api_key])
        self.audit = audit or AuditLogger(settings.audit_path, self.redactor)
        self.client = ChatClient(settings, audit=self.audit)
        self.prober = CapabilityProber(self.client)
        self.media = MediaStore(settings.media_dir, max_bytes=settings.max_image_bytes)
        self.sessions = SessionStore(settings.db_path, media=self.media)
        self.started_at = time.time()
        if not settings.server_token:
            settings.server_token = self._load_or_create_token()
        self.token_path = settings.home / "server_token"

    def _load_or_create_token(self) -> str:
        path = self.settings.home / "server_token"
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            token = path.read_text(encoding="utf-8").strip()
            if token:
                return token
        token = secrets.token_urlsafe(32)
        path.write_text(token + "\n", encoding="utf-8")
        try:
            path.chmod(0o600)
        except OSError:
            pass
        return token

    def check_token(self, presented: str | None) -> bool:
        expected = self.settings.server_token or ""
        return bool(presented) and hmac.compare_digest(str(presented), expected)

    def config_public(self) -> dict[str, Any]:
        data = self.settings.public_dict()
        data["version"] = __version__
        data["uptime_s"] = round(time.time() - self.started_at, 1)
        data["audit_path"] = str(self.settings.audit_path)
        return self.redactor.scrub(data)


class StudioHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], handler: type[BaseHTTPRequestHandler], service: Service):
        super().__init__(address, handler)
        self.service = service


class Handler(BaseHTTPRequestHandler):
    server_version = f"PromptStudioM0/{__version__}"
    protocol_version = "HTTP/1.1"

    # ------------------------------------------------------------- plumbing
    @property
    def service(self) -> Service:
        return self.server.service  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        # Silence the default stderr access log; structured audit is used instead.
        return

    def _send_json(self, status: int, payload: dict[str, Any], *, request_id: str | None = None) -> None:
        body = json.dumps(self.service.redactor.scrub(payload), ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if request_id:
            self.send_header("X-Request-Id", request_id)
        self.end_headers()
        self.wfile.write(body)

    def _send_error_json(self, err: StudioError, request_id: str) -> None:
        self._send_json(err.http_status, {"error": err.to_dict()}, request_id=request_id)

    def _read_body(self) -> bytes:
        length_header = self.headers.get("Content-Length")
        if not length_header:
            raise InvalidRequestError("Request body is required (Content-Length missing).")
        try:
            length = int(length_header)
        except ValueError as exc:
            raise InvalidRequestError("Invalid Content-Length.") from exc
        if length < 0:
            raise InvalidRequestError("Invalid Content-Length.")
        if length > MAX_BODY_BYTES:
            raise BodyTooLargeError(f"Request body exceeds {MAX_BODY_BYTES} bytes.")
        return self.rfile.read(length)

    def _json_body(self) -> dict[str, Any]:
        raw = self._read_body()
        try:
            obj = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise InvalidRequestError("Request body must be valid UTF-8 JSON.") from exc
        if not isinstance(obj, dict):
            raise InvalidRequestError("Request body must be a JSON object.")
        return obj

    def _token_from_request(self) -> str | None:
        token = self.headers.get("X-Studio-Token")
        if token:
            return token.strip()
        auth = self.headers.get("Authorization") or ""
        if auth.lower().startswith("bearer "):
            return auth[7:].strip()
        return None

    # -------------------------------------------------------------- routing
    def do_GET(self) -> None:  # noqa: N802
        self._dispatch("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._dispatch("POST")

    def do_DELETE(self) -> None:  # noqa: N802
        self._dispatch("DELETE")

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._send_json(405, {"error": {"code": "method_not_allowed", "message": "OPTIONS is not supported."}})

    def _dispatch(self, method: str) -> None:
        started = time.perf_counter()
        request_id = ChatClient.new_request_id()
        self._headers_sent = False
        self._stream_error = None
        path = urlsplit(self.path).path.rstrip("/") or "/"
        client_ip = self.client_address[0] if self.client_address else "?"
        try:
            if path == "/health" and method == "GET":
                self._send_json(
                    200,
                    {
                        "status": "ok",
                        "version": __version__,
                        "uptime_s": round(time.time() - self.service.started_at, 1),
                    },
                    request_id=request_id,
                )
                self._audit_request(method, path, 200, started, request_id, client_ip)
                return

            if not path.startswith("/api/"):
                raise NotFoundError("Unknown route.")
            if not self.service.check_token(self._token_from_request()):
                raise ServerUnauthorizedError(
                    "A local backend token is required. Read it from the server token file "
                    "or pass PROMPT_STUDIO_SERVER_TOKEN."
                )

            self._route(method, path, request_id)
            if self._stream_error is not None:
                self._audit_request(
                    method,
                    path,
                    self._stream_error.http_status,
                    started,
                    request_id,
                    client_ip,
                    error=self._stream_error.code,
                )
                return
            self._audit_request(method, path, 200, started, request_id, client_ip)
        except StudioError as err:
            err.request_id = err.request_id or request_id
            if not getattr(self, "_headers_sent", False):
                self._send_error_json(err, request_id)
            else:  # pragma: no cover - only for streaming failures
                try:
                    self._sse_send("error", err.to_dict())
                except Exception:
                    pass
            self._audit_request(method, path, err.http_status, started, request_id, client_ip, error=err.code)
        except Exception as exc:  # noqa: BLE001
            message = self.service.redactor.scrub_text(f"{type(exc).__name__}: {exc}")
            if not getattr(self, "_headers_sent", False):
                self._send_json(
                    500,
                    {
                        "error": {
                            "code": "internal_error",
                            "message": "Internal error in the local backend.",
                            "detail": message[:300],
                            "request_id": request_id,
                        }
                    },
                    request_id=request_id,
                )
            self._audit_request(method, path, 500, started, request_id, client_ip, error="internal_error")

    def _audit_request(
        self,
        method: str,
        path: str,
        status: int,
        started: float,
        request_id: str,
        client_ip: str,
        *,
        error: str | None = None,
    ) -> None:
        self.service.audit.log(
            "http_request",
            request_id=request_id,
            method=method,
            path=path,
            status=status,
            latency_ms=int((time.perf_counter() - started) * 1000),
            client=client_ip,
            error_code=error,
        )

    def _route(self, method: str, path: str, request_id: str) -> None:
        service = self.service
        if method == "GET" and path == "/api/config":
            self._send_json(200, service.config_public(), request_id=request_id)
            return
        if method == "GET" and path == "/api/models":
            models = service.client.list_models()
            self._send_json(200, {"models": models}, request_id=request_id)
            return
        if method == "GET" and path == "/api/audit":
            self._send_json(200, {"entries": service.audit.tail(100)}, request_id=request_id)
            return
        if method == "POST" and path == "/api/probe":
            body = self._json_body()
            report = service.prober.probe(model=body.get("model") or None, force=bool(body.get("force")))
            self._send_json(200, report.to_dict(), request_id=request_id)
            return
        if method == "POST" and path == "/api/chat":
            self._handle_chat(request_id)
            return
        if method == "POST" and path == "/api/sessions":
            body = self._json_body()
            session = service.sessions.create(str(body.get("title") or "") or None)
            self._send_json(201, session, request_id=request_id)
            return
        if method == "GET" and path == "/api/sessions":
            self._send_json(200, {"sessions": service.sessions.list()}, request_id=request_id)
            return
        if method == "GET" and path.startswith("/api/sessions/"):
            session_id = path.rsplit("/", 1)[-1]
            session = service.sessions.get(session_id)
            if session is None:
                raise NotFoundError("Session not found.")
            messages = service.sessions.messages(session_id)
            self._send_json(
                200,
                {
                    "session": session,
                    "messages": messages,
                    "message_count": len(messages),
                },
                request_id=request_id,
            )
            return
        if method == "DELETE" and path.startswith("/api/sessions/"):
            session_id = path.rsplit("/", 1)[-1]
            if not service.sessions.delete(session_id):
                raise NotFoundError("Session not found.")
            self._send_json(200, {"deleted": session_id}, request_id=request_id)
            return
        raise NotFoundError("Unknown route.")

    # ------------------------------------------------------------------ chat
    def _handle_chat(self, request_id: str) -> None:
        service = self.service
        body = self._json_body()
        stream = bool(body.get("stream"))
        model = body.get("model") or None
        temperature = body.get("temperature", 0.7)
        max_tokens = body.get("max_tokens")
        stateless = bool(body.get("stateless"))
        session_id = body.get("session_id")
        raw_messages = body.get("messages")

        if stateless and raw_messages is None:
            raise InvalidRequestError("stateless chat requires a messages array.")
        if raw_messages is not None:
            messages = self._validate_messages(raw_messages)
            session = None
        else:
            text = body.get("message")
            if not isinstance(text, str) or not text.strip():
                raise InvalidRequestError("message must be a non-empty string.")
            user_content: Any = text
            parts: list[dict[str, Any]] = [{"type": "text", "text": text}]
            for image in body.get("images") or []:
                parts.append(self._image_to_part(image))
            if len(parts) > 1:
                user_content = parts

            if session_id:
                session = service.sessions.get(str(session_id))
                if session is None:
                    raise NotFoundError("Session not found.")
            else:
                session = service.sessions.create(title=text.strip()[:40])
                session_id = session["id"]
            service.sessions.append(session_id, "user", user_content)
            messages = service.sessions.messages_for_api(session_id)
            if body.get("system"):
                messages = [{"role": "system", "content": str(body["system"])}] + messages

        if not messages:
            raise InvalidRequestError("No messages to send.")

        has_images = any(
            isinstance(m.get("content"), list)
            and any(isinstance(p, dict) and p.get("type") == "image_url" for p in m["content"])
            for m in messages
        )
        if has_images:
            cached = service.prober.cached_report(model=model or service.settings.model)
            if cached is not None and cached.vision is False:
                raise CapabilityError(
                    "The configured model was probed and does not appear to accept images. "
                    "Run /api/probe to re-check after changing models.",
                    detail=str(cached.details.get("vision", {}).get("reason") or ""),
                )

        started = time.perf_counter()
        if stream:
            self._stream_chat(messages, session_id, model, temperature, max_tokens, request_id)
            return

        result = service.client.complete(
            messages,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            request_id=request_id,
        )
        if session_id:
            service.sessions.append(session_id, "assistant", result.text)
        self._send_json(
            200,
            {
                "request_id": result.request_id,
                "session_id": session_id,
                "model": result.model,
                "text": result.text,
                "usage": result.usage,
                "finish_reason": result.finish_reason,
                "latency_ms": result.latency_ms,
                "attempts": result.attempts,
                "elapsed_ms": int((time.perf_counter() - started) * 1000),
            },
            request_id=request_id,
        )

    def _stream_chat(
        self,
        messages: list[dict[str, Any]],
        session_id: str | None,
        model: str | None,
        temperature: Any,
        max_tokens: Any,
        request_id: str,
    ) -> None:
        service = self.service
        self._sse_start(request_id)
        self._sse_send(
            "meta",
            {
                "request_id": request_id,
                "session_id": session_id,
                "model": model or service.settings.model,
            },
        )
        final_text = ""
        try:
            for event in service.client.stream_chat(
                messages,
                model=model,
                temperature=temperature,
                max_tokens=max_tokens,
                request_id=request_id,
            ):
                if event.type == "delta":
                    self._sse_send("delta", {"text": event.text})
                elif event.type == "reasoning":
                    self._sse_send("reasoning", {"text": event.reasoning})
                elif event.type == "done":
                    final_text = event.text
                    if session_id and final_text:
                        service.sessions.append(session_id, "assistant", final_text)
                    self._sse_send(
                        "done",
                        {
                            "request_id": event.request_id,
                            "session_id": session_id,
                            "text": final_text,
                            "usage": event.usage,
                            "finish_reason": event.finish_reason,
                            "ttft_ms": event.ttft_ms,
                            "chunks": event.chunks,
                            "saw_done": event.saw_done,
                            "stream_ignored": event.stream_ignored,
                        },
                    )
        except StudioError as err:
            err.request_id = err.request_id or request_id
            self._stream_error = err
            try:
                self._sse_send("error", err.to_dict())
            except OSError:
                pass
        finally:
            self._sse_end()

    # ------------------------------------------------------------------ sse
    def _sse_start(self, request_id: str) -> None:
        self._headers_sent = True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Connection", "close")
        self.send_header("X-Request-Id", request_id)
        self.end_headers()
        self.close_connection = True

    def _sse_send(self, event: str, data: dict[str, Any]) -> None:
        payload = self.service.redactor.scrub(data)
        chunk = (
            f"event: {event}\n"
            f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
        ).encode("utf-8")
        self.wfile.write(f"{len(chunk):X}\r\n".encode("ascii") + chunk + b"\r\n")
        self.wfile.flush()

    def _sse_end(self) -> None:
        try:
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except Exception:
            pass

    # ------------------------------------------------------------- helpers
    @staticmethod
    def _validate_messages(raw: Any) -> list[dict[str, Any]]:
        if not isinstance(raw, list) or not raw:
            raise InvalidRequestError("messages must be a non-empty array.")
        out = []
        for message in raw:
            if not isinstance(message, dict):
                raise InvalidRequestError("each message must be an object.")
            role = message.get("role")
            if role not in ("system", "user", "assistant"):
                raise InvalidRequestError("message role must be system, user or assistant.")
            content = message.get("content")
            if not isinstance(content, (str, list)):
                raise InvalidRequestError("message content must be a string or an array of parts.")
            out.append({"role": role, "content": content})
        return out

    def _image_to_part(self, image: Any) -> dict[str, Any]:
        return image_to_part(self.service.media, image)


def create_server(settings: Settings, *, service: Service | None = None) -> StudioHTTPServer:
    service = service or Service(settings)
    server = StudioHTTPServer((settings.host, settings.port), Handler, service)
    return server


def serve(settings: Settings) -> None:
    server = create_server(settings)
    token = server.service.settings.server_token
    print(f"ComfyUI AI Prompt Studio M0 backend listening on http://{settings.host}:{settings.port}")
    print(f"Backend token file: {server.service.token_path}")
    print(f"Audit log: {server.service.settings.audit_path}")
    if token:
        print(f"Backend token (local): {token}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
    finally:
        server.server_close()
