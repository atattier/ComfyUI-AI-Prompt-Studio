"""A strict, local OpenAI-compatible upstream used by the M0 test suite.

It implements just enough of the protocol to exercise the real client over real
sockets: auth, model listing with declared modalities, text and vision replies,
SSE streaming, 429/503 failures, slow responses and abrupt stream drops.

The vision reply is derived from the actual PNG pixels, so a bug in the probe
image or in the client's content encoding shows up as a failed probe rather
than being masked by a canned answer.
"""

from __future__ import annotations

import base64
import json
import socket
import struct
import threading
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

VALID_KEY = "mock-" + "valid-" + "001"
BAD_KEY = "mock-" + "bad-" + "002"

MODELS = [
    {"id": "vision-pro", "modalities": {"input": ["text", "image"], "output": ["text"]}},
    {"id": "text-only", "modalities": {"input": ["text"], "output": ["text"]}},
    {"id": "echo-model", "modalities": {"input": ["text"], "output": ["text"]}},
    {"id": "flaky-model", "modalities": {"input": ["text"], "output": ["text"]}},
    {"id": "rate-limit-model", "modalities": {"input": ["text"], "output": ["text"]}},
    {"id": "slow-model", "modalities": {"input": ["text"], "output": ["text"]}},
    {"id": "drop-model", "modalities": {"input": ["text"], "output": ["text"]}},
    {"id": "json-stream", "modalities": {"input": ["text"], "output": ["text"]}},
    {"id": "editor-model", "modalities": {"input": ["text", "image"], "output": ["text"]}},
    {"id": "editor-noop", "modalities": {"input": ["text"], "output": ["text"]}},
    {"id": "editor-bad-json", "modalities": {"input": ["text"], "output": ["text"]}},
    {"id": "editor-ambiguous", "modalities": {"input": ["text"], "output": ["text"]}},
    {"id": "caption-model", "modalities": {"input": ["text", "image"], "output": ["text"]}},
    {"id": "empty-model", "modalities": {"input": ["text", "image"], "output": ["text"]}},
    {"id": "demo-model", "modalities": {"input": ["text", "image"], "output": ["text"]}},
]

_COLORS = {"red": (220, 30, 30), "green": (30, 170, 60), "blue": (30, 40, 220), "yellow": (235, 205, 40)}


class MockState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.requests: list[dict[str, Any]] = []
        self.flaky_remaining = 2
        self.rate_limit_remaining = 1

    def record(self, entry: dict[str, Any]) -> None:
        with self.lock:
            self.requests.append(entry)

    def count(self, path: str) -> int:
        with self.lock:
            return sum(1 for r in self.requests if r["path"] == path)


def decode_png_colors(data: bytes) -> tuple[str, str]:
    """Return the left and right colour names of our own 2-colour probe PNG."""
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("not png")
    pos = 8
    width = height = 0
    idat = b""
    while pos < len(data):
        length = struct.unpack(">I", data[pos : pos + 4])[0]
        tag = data[pos + 4 : pos + 8]
        chunk = data[pos + 8 : pos + 8 + length]
        pos += 12 + length
        if tag == b"IHDR":
            width, height, _depth, _ctype = struct.unpack(">IIBB", chunk[:10])
        elif tag == b"IDAT":
            idat += chunk
        elif tag == b"IEND":
            break
    raw = zlib.decompress(idat)
    stride = 1 + width * 3

    def pixel(x: int, y: int) -> tuple[int, int, int]:
        offset = y * stride + 1 + x * 3
        return (raw[offset], raw[offset + 1], raw[offset + 2])

    return _nearest(pixel(0, 0)), _nearest(pixel(width - 1, 0))


def _nearest(rgb: tuple[int, int, int]) -> str:
    return min(_COLORS, key=lambda name: sum((a - b) ** 2 for a, b in zip(_COLORS[name], rgb)))


def _content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            str(p.get("text") or "") for p in content if isinstance(p, dict) and p.get("type") == "text"
        )
    return ""


def _image_data(content: Any) -> list[bytes]:
    out = []
    if isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and part.get("type") == "image_url":
                url = str((part.get("image_url") or {}).get("url") or "")
                if url.startswith("data:") and ";base64," in url:
                    out.append(base64.b64decode(url.split(";base64,", 1)[1]))
    return out


class MockHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    state: MockState

    def log_message(self, fmt: str, *args: Any) -> None:
        return

    # ------------------------------------------------------------- helpers
    def _json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, message: str, *, retry_after: str | None = None) -> None:
        if retry_after:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Retry-After", retry_after)
            body = json.dumps({"error": {"message": message}}).encode()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self._json(status, {"error": {"message": message, "type": "invalid_request_error"}})

    def _authorized(self) -> bool:
        auth = self.headers.get("Authorization") or ""
        return auth.strip() == f"Bearer {VALID_KEY}"

    def _body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length) or b"{}")

    # -------------------------------------------------------------- routes
    def do_GET(self) -> None:  # noqa: N802
        self.state.record(
            {"method": "GET", "path": self.path, "auth_ok": self._authorized(), "model": None, "stream": False}
        )
        if self.path != "/v1/models":
            self._error(404, "not found")
            return
        if not self._authorized():
            self._error(401, "invalid api key")
            return
        self._json(200, {"object": "list", "data": MODELS})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/v1/chat/completions":
            self._error(404, "not found")
            return
        body = self._body()
        model = str(body.get("model") or "")
        stream = bool(body.get("stream"))
        self.state.record(
            {"method": "POST", "path": self.path, "auth_ok": self._authorized(), "model": model, "stream": stream}
        )
        if not self._authorized():
            self._error(401, "invalid api key")
            return

        if model == "flaky-model":
            with self.state.lock:
                if self.state.flaky_remaining > 0:
                    self.state.flaky_remaining -= 1
                    fail = True
                else:
                    fail = False
            if fail:
                self._error(503, "temporarily unavailable")
                return

        if model == "rate-limit-model":
            with self.state.lock:
                if self.state.rate_limit_remaining > 0:
                    self.state.rate_limit_remaining -= 1
                    limited = True
                else:
                    limited = False
            if limited:
                self._error(429, "slow down", retry_after="0")
                return

        if model == "slow-model":
            time.sleep(3.0)
            self._json(200, _response(model, "slow response"))
            return

        if model == "drop-model":
            self._stream_drop(model)
            return

        messages = body.get("messages") or []
        reply = self._reply(model, messages)

        if stream and model != "json-stream":
            self._stream(model, reply, usage={"prompt_tokens": 10, "completion_tokens": len(reply.split()), "total_tokens": 20})
            return

        self._json(200, _response(model, reply))

    # -------------------------------------------------------------- logic
    def _reply(self, model: str, messages: list[dict[str, Any]]) -> str:
        last = messages[-1] if messages else {"content": ""}
        content = last.get("content")
        images = _image_data(content)
        text = _content_text(content).strip()

        if images:
            if model == "text-only":
                # Raised as a real HTTP 400 by the mock; the client maps it.
                raise _ClientFacingError(400, "This model does not support image input.")
            if model == "vision-pro":
                left, right = decode_png_colors(images[0])
                return f"{left} {right}"

        if model == "demo-model":
            system = _content_text(messages[0].get("content")) if messages else ""
            lowered = system.lower()
            if '"changes"' in system and "json object" in lowered:
                if "<<<\n\n>>>" in text:
                    return json.dumps(
                        {
                            "reply": "已为您根据描述生成初始提示词草稿。",
                            "changes": [
                                {"op": "append", "after": "A cinematic scene in soft studio lighting, 35mm lens, sharp focus"},
                            ],
                        },
                        ensure_ascii=False,
                    )
                if "雨" in text or "rain" in text.lower():
                    return json.dumps(
                        {
                            "reply": "把晴天改成雨夜，镜头和构图保持不变。",
                            "changes": [
                                {"op": "replace", "before": "sunny afternoon", "after": "rainy night"},
                                {"op": "append", "after": ", wet reflections"},
                            ],
                        },
                        ensure_ascii=False,
                    )
                if "狗" in text or "dog" in text.lower():
                    return json.dumps(
                        {
                            "reply": "把猫换成狗。",
                            "changes": [{"op": "replace", "before": "a cat", "after": "a dog"}],
                        },
                        ensure_ascii=False,
                    )
                return json.dumps(
                    {
                        "reply": "信息已经比较完整，建议只补充一点光线。",
                        "changes": [{"op": "append", "after": ", soft rim light"}],
                    },
                    ensure_ascii=False,
                )
            if "summary" in lowered and "at most 6 regions" in lowered:
                left, right = decode_png_colors(images[0]) if images else ("red", "blue")
                caption = (
                    f"A high-contrast studio poster split into {left} and {right} halves with balanced composition and soft key light."
                    if "complete natural-language" in lowered
                    else f"A poster split into {left} and {right} halves."
                )
                return json.dumps(
                    {
                        "summary": {"caption": caption},
                        "items": [
                            {"label": "object", "caption": f"Bold {left} color block on the left side", "bbox": [0, 0, 500, 1000]},
                            {"label": "character", "caption": f"Subject silhouetted against the {right} right half", "bbox": [500, 120, 960, 920]},
                        ],
                    },
                    ensure_ascii=False,
                )
            if "comma-separated" in lowered:
                if images:
                    left, right = decode_png_colors(images[0])
                    return f"poster, {left}, {right}, centered composition, soft studio light"
                return "portrait, natural light, 50mm"
            if "moss-image style" in lowered or "describe the image" in lowered:
                if images:
                    left, right = decode_png_colors(images[0])
                    return f"A poster split into {left} and {right} halves, centered composition, soft studio light."
                return "A quiet portrait in natural light."
            if images:
                left, right = decode_png_colors(images[0])
                return f"我看到一张由 {left} 和 {right} 两块组成的图片，这种配色可以直接写进提示词。"
            return "这段提示词的主干很清楚。可以把背景、光线和镜头再具体一些，画面会更可控。"

        if model == "editor-model":
            return json.dumps(
                {"reply": "把猫改成狗", "changes": [{"op": "replace", "before": "a cat", "after": "a dog", "why": "test"}]},
                ensure_ascii=False,
            )

        if model == "editor-noop":
            return json.dumps({"reply": "不需要修改", "changes": []}, ensure_ascii=False)

        if model == "editor-bad-json":
            return "I think it looks fine."

        if model == "editor-ambiguous":
            return json.dumps(
                {"reply": "ambiguous", "changes": [{"op": "delete", "before": "a ", "why": "test"}]},
                ensure_ascii=False,
            )

        if model == "empty-model":
            return ""

        if model == "caption-model":
            lowered = text.lower()
            if "moss-image style" in lowered:
                return "A red and blue poster, centered composition, soft studio light."
            if "comma-separated" in lowered or "image-generation tags" in lowered:
                return "```\nquality, red, blue\n```"
            return "A vertically split poster in red and blue."

        if model == "echo-model":
            transcript = " | ".join(f"{m.get('role')}:{_content_text(m.get('content'))}" for m in messages)
            return f"turns={len(messages)} transcript={transcript}"

        if text.lower().startswith("reply with the single word ok"):
            return "OK"

        if model == "vision-pro":
            return "OK"
        return f"mock reply to: {text[:80]}"

    def _stream(self, model: str, reply: str, *, usage: dict[str, Any] | None = None) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        # An empty reply streams zero content chunks (real gateways do too);
        # the caller is responsible for rejecting an empty result.
        words = reply.split(" ") if reply else []
        for index, word in enumerate(words):
            chunk = word + (" " if index < len(words) - 1 else "")
            event = {"choices": [{"index": 0, "delta": {"content": chunk}, "finish_reason": None}]}
            self.wfile.write(f"data: {json.dumps(event, ensure_ascii=False)}\n\n".encode("utf-8"))
            self.wfile.flush()
            time.sleep(0.01)
        if usage is not None:
            self.wfile.write(f"data: {json.dumps({'choices': [], 'usage': usage})}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def _stream_drop(self, model: str) -> None:
        # Start a chunked body, send one chunk, then reset without terminating it.
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        event = {"choices": [{"index": 0, "delta": {"content": "partial "}, "finish_reason": None}]}
        payload = f"data: {json.dumps(event)}\n\n".encode()
        self.wfile.write(f"{len(payload):X}\r\n".encode() + payload + b"\r\n")
        self.wfile.flush()
        time.sleep(0.05)
        try:
            sock = self.connection
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
            sock.close()
        except OSError:
            pass
        self.close_connection = True


class _ClientFacingError(Exception):
    def __init__(self, status: int, message: str) -> None:
        self.status = status
        self.message = message


def _response(model: str, text: str) -> dict[str, Any]:
    return {
        "id": "chatcmpl-mock",
        "object": "chat.completion",
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
    }


def _wrap_handler(base: type[MockHandler]) -> type[MockHandler]:
    """Catch the mock's own client-facing errors and turn them into HTTP replies."""

    class Wrapped(base):  # type: ignore[misc, valid-type]
        def do_POST(self) -> None:  # noqa: N802
            try:
                super().do_POST()
            except _ClientFacingError as exc:
                self._error(exc.status, exc.message)

    return Wrapped


class MockUpstream:
    def __init__(self, host: str = "127.0.0.1") -> None:
        self.state = MockState()
        handler = _wrap_handler(MockHandler)
        handler.state = self.state
        self.server = ThreadingHTTPServer((host, 0), handler)
        self.server.daemon_threads = True
        # Abrupt client disconnects are part of the test matrix; keep the
        # unittest output clean instead of printing handler tracebacks.
        self.server.handle_error = lambda request, client_address: None
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        host, port = self.server.server_address[:2]
        return f"http://{host}:{port}/v1"

    def __enter__(self) -> "MockUpstream":
        self.thread.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
