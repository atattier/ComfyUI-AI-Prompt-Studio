"""OpenAI-compatible multimodal chat client (text, images, streaming).

Design notes
------------
* Transport is stdlib ``urllib`` only; no third-party dependency is needed for
  M0, which keeps the prototype auditable and easy to install.
* One Base URL + one key + one model serve every task; callers may override the
  model per request for capability probing but not the credential.
* Retries are limited to genuinely retryable failures (429, 5xx, timeouts,
  network errors) and never happen after the first streamed token, so a partial
  answer is never duplicated.
* Error messages are scrubbed and never embed the API key.
"""

from __future__ import annotations

import base64
import http.client
import json
import random
import socket
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field
from typing import Any, Iterable, Iterator, Sequence

from .audit import AuditLogger
from .config import Settings
from .errors import (
    AccessDeniedError,
    AuthError,
    InvalidRequestError,
    ModelNotFoundError,
    NetworkError,
    RateLimitError,
    StreamInterruptedError,
    StudioError,
    UpstreamError,
    UpstreamTimeoutError,
)
from .redaction import Redactor

RETRYABLE_STATUS = {408, 425, 429, 500, 502, 503, 504}


@dataclass(slots=True)
class ChatResult:
    text: str
    usage: dict[str, Any] | None
    finish_reason: str | None
    model: str
    request_id: str
    latency_ms: int
    attempts: int


@dataclass(slots=True)
class StreamEvent:
    type: str  # "delta" | "reasoning" | "done"
    text: str = ""
    reasoning: str = ""
    usage: dict[str, Any] | None = None
    finish_reason: str | None = None
    request_id: str = ""
    attempts: int = 1
    ttft_ms: int | None = None
    chunks: int = 0
    saw_done: bool = False
    stream_ignored: bool = False


def data_url(image: bytes, mime: str = "image/png") -> str:
    return f"data:{mime};base64," + base64.b64encode(image).decode("ascii")


def image_part_from_bytes(image: bytes, mime: str = "image/png") -> dict[str, Any]:
    return {"type": "image_url", "image_url": {"url": data_url(image, mime)}}


def image_part_from_url(url: str) -> dict[str, Any]:
    return {"type": "image_url", "image_url": {"url": url}}


def text_part(text: str) -> dict[str, Any]:
    return {"type": "text", "text": text}


def _content_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        chunks = []
        for item in content:
            if isinstance(item, str):
                chunks.append(item)
            elif isinstance(item, dict) and item.get("type") in (None, "text"):
                chunks.append(str(item.get("text") or ""))
        return "".join(chunks)
    return str(content)


def _extract_usage(obj: dict[str, Any]) -> dict[str, Any] | None:
    usage = obj.get("usage")
    return usage if isinstance(usage, dict) else None


def _extract_text(obj: dict[str, Any]) -> tuple[str, str | None, dict[str, Any] | None]:
    choices = obj.get("choices")
    if not isinstance(choices, list) or not choices:
        raise UpstreamError("Upstream response contained no choices.")
    first = choices[0] if isinstance(choices[0], dict) else {}
    message = first.get("message") if isinstance(first.get("message"), dict) else {}
    text = _content_text(message.get("content"))
    finish = first.get("finish_reason")
    return text, (finish if isinstance(finish, str) else None), _extract_usage(obj)


def _error_message_from_body(body: str) -> str:
    body = (body or "").strip()
    if not body:
        return ""
    try:
        obj = json.loads(body)
    except ValueError:
        return body[:500]
    if isinstance(obj, dict):
        err = obj.get("error")
        if isinstance(err, dict):
            msg = err.get("message") or err.get("msg")
            if msg:
                return str(msg)[:800]
        if isinstance(err, str):
            return err[:800]
        for key in ("message", "detail", "msg"):
            if obj.get(key):
                return str(obj[key])[:800]
    return body[:500]


_CEILING_BUDGET = 32768


def _clean_model_name(name: str) -> str:
    """把人手填的模型名整理成上游能接受的 ID。

    Google 的 OpenAI 兼容层会直接 400「unexpected model name format」，
    只要名字里有空格或大写（例如「Gemini 3.8 Flash」）。模型 ID 的字符集本来
    就是 a-z 0-9 . - _ /，所以：去引号、空格转连字符、全小写。
    中文/其他字符不做猜测，原样送出去让上游报错，报错会翻成中文提示。
    """
    raw = str(name or "").strip().strip("\"'").strip()
    if not raw:
        return raw
    if all(ch.isascii() and (ch.isalnum() or ch in " .-_/") for ch in raw):
        # 只有「看起来像人念的显示名」才动它；已经是合法 ID 的保持原样，别改别人的大小写
        if " " in raw:
            return raw.replace(" ", "-").lower()
    return raw


def _budget_exhausted(message: str) -> bool:
    """上游说明“输出额度被思考吃光”，重发同一请求不会变好。"""
    low = (message or "").lower()
    return any(
        s in low
        for s in (
            "cut at its length",
            "empty reply",
            "spent on reasoning",
            "max_tokens",
            "ask for less reasoning",
            "输出额度",
        )
    )


class ChatClient:
    def __init__(
        self,
        settings: Settings,
        *,
        audit: AuditLogger | None = None,
        opener: Any | None = None,
        sleep: Any = time.sleep,
        rng: random.Random | None = None,
    ) -> None:
        self.settings = settings
        self.audit = audit
        self.redactor = Redactor([settings.api_key])
        self._opener = opener or urllib.request.build_opener()
        self._sleep = sleep
        self._rng = rng or random.Random()

    # ------------------------------------------------------------------ HTTP
    def _headers(self, accept: str) -> dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "Accept": accept,
            "User-Agent": "comfyui-ai-prompt-studio/0.1.0-m0",
        }
        if self.settings.api_key:
            headers["Authorization"] = "Bearer " + self.settings.api_key
        return headers

    def _backoff(self, attempt: int) -> float:
        base = self.settings.backoff_s * (2 ** (attempt - 1))
        jitter = 1.0 + self._rng.uniform(-0.2, 0.2)
        return min(base * jitter, self.settings.max_backoff_s)

    def _log(self, event: str, **fields: Any) -> None:
        if self.audit is not None:
            self.audit.log(event, **fields)

    def _error_from_http(
        self, exc: urllib.error.HTTPError, request_id: str, attempt: int
    ) -> StudioError:
        try:
            raw = exc.read(8192)
        except Exception:  # pragma: no cover - body may already be consumed
            raw = b""
        body = raw.decode("utf-8", "replace")
        upstream_message = self.redactor.scrub_text(_error_message_from_body(body))
        detail = self.redactor.scrub_text(body[:1000])
        common = {
            "request_id": request_id,
            "upstream_status": exc.code,
            "attempts": attempt,
            "detail": detail,
        }
        retry_after = None
        header = exc.headers.get("Retry-After") if exc.headers else None
        if header:
            try:
                retry_after = max(0.0, float(header))
            except ValueError:
                retry_after = None
        if exc.code == 401:
            return AuthError(
                "Authentication failed (HTTP 401). Check the API key.", **common
            )
        if exc.code == 403:
            return AccessDeniedError(
                "Access denied by the provider (HTTP 403)." + (f" {upstream_message}" if upstream_message else ""),
                **common,
            )
        if exc.code == 404:
            return ModelNotFoundError(
                "Endpoint or model not found (HTTP 404). Check Base URL and model name."
                + (f" {upstream_message}" if upstream_message else ""),
                **common,
            )
        if exc.code == 429:
            err = RateLimitError(
                "Rate limited by the provider (HTTP 429)." + (f" {upstream_message}" if upstream_message else ""),
                **common,
            )
            err.retry_after = retry_after
            return err
        if exc.code in RETRYABLE_STATUS:
            err = UpstreamError(
                f"Upstream server error (HTTP {exc.code})." + (f" {upstream_message}" if upstream_message else ""),
                **common,
            )
            # 「思考把 max_tokens 吃光、一个字没吐」不是网络抖动：同一请求重发多少次
            # 都是同一个结果，重试只会让人白等三个超时周期。
            if _budget_exhausted(upstream_message):
                err.retryable = False
            low_upstream = (upstream_message or "").lower()
            if exc.code == 503 and "high demand" in low_upstream:
                # Google 3.8 这类新模型会回「排队人多，稍后再试」——等它自己好没意义，
                # 直接告诉用户换一个模型，别让他盯着进度条等三个超时。
                err.retryable = False
                err.message = (
                    f"模型当前排队过多（上游 503 UNAVAILABLE）：{detail or 'high demand'}。"
                    "这不是没权限，是 Google 那边此刻挤爆了；换 gemini-3.6-flash 立刻可用，或过一会儿再试。"
                    f"（请求 ID {request_id}）"
                )
            return err
        if exc.code in (400, 413, 422):
            hint = ""
            if "unexpected model name format" in upstream_message:
                hint = (
                    "（模型名只能是小写字母 / 数字 / 点 / 横线，例如 gemini-3.6-flash；"
                    "请清空「节点专属模型覆盖」，或在设置里从联想列表里选一个模型。）"
                )
            return InvalidRequestError(
                f"请求参数被上游拒绝 (HTTP {exc.code})。{hint}"
                + (f" {upstream_message}" if upstream_message else ""),
                **common,
            )
        return UpstreamError(
            f"Unexpected upstream response (HTTP {exc.code})."
            + (f" {upstream_message}" if upstream_message else ""),
            **common,
        )

    def _open(
        self,
        path: str,
        *,
        request_id: str,
        method: str = "POST",
        payload: dict[str, Any] | None = None,
        accept: str = "application/json",
        timeout: float | None = None,
        max_retries: int | None = None,
    ) -> tuple[Any, int]:
        url = self.settings.api_url(path)
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
        timeout = self.settings.timeout_s if timeout is None else timeout
        max_retries = self.settings.max_retries if max_retries is None else max_retries
        attempt = 0
        while True:
            attempt += 1
            req = urllib.request.Request(
                url, data=data, headers=self._headers(accept), method=method
            )
            try:
                return self._opener.open(req, timeout=timeout), attempt
            except urllib.error.HTTPError as exc:
                err = self._error_from_http(exc, request_id, attempt)
                if err.retryable and attempt <= max_retries:
                    delay = err.retry_after if err.retry_after is not None else self._backoff(attempt)
                    self._log(
                        "retry",
                        request_id=request_id,
                        operation=path,
                        attempt=attempt,
                        delay_s=round(delay, 3),
                        reason=err.code,
                        upstream_status=err.upstream_status,
                    )
                    self._sleep(delay)
                    continue
                err.attempts = attempt
                raise err
            except (TimeoutError, socket.timeout) as exc:  # noqa: UP041
                err = UpstreamTimeoutError(
                    f"Upstream did not respond within {timeout:g}s.",
                    request_id=request_id,
                    attempts=attempt,
                    detail=self.redactor.scrub_text(f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__),
                )
                if attempt <= max_retries:
                    self._log(
                        "retry",
                        request_id=request_id,
                        operation=path,
                        attempt=attempt,
                        delay_s=round(self._backoff(attempt), 3),
                        reason="timeout",
                    )
                    self._sleep(self._backoff(attempt))
                    continue
                raise err
            except urllib.error.URLError as exc:
                reason = exc.reason
                if isinstance(reason, (TimeoutError, socket.timeout)):  # noqa: UP041
                    err = UpstreamTimeoutError(
                        f"Upstream did not respond within {timeout:g}s.",
                        request_id=request_id,
                        attempts=attempt,
                        detail=self.redactor.scrub_text(
                            f"{type(reason).__name__}: {reason}" if str(reason) else type(reason).__name__
                        ),
                    )
                else:
                    reason_detail = (
                        f"{type(reason).__name__}: {reason}"
                        if isinstance(reason, BaseException)
                        else str(reason)
                    )
                    err = NetworkError(
                        "Cannot reach the API endpoint. Check Base URL and network connectivity.",
                        request_id=request_id,
                        attempts=attempt,
                        detail=self.redactor.scrub_text(reason_detail),
                    )
                if attempt <= max_retries:
                    self._log(
                        "retry",
                        request_id=request_id,
                        operation=path,
                        attempt=attempt,
                        delay_s=round(self._backoff(attempt), 3),
                        reason=err.code,
                    )
                    self._sleep(self._backoff(attempt))
                    continue
                raise err
            except OSError as exc:
                err = NetworkError(
                    "Cannot reach the API endpoint. Check Base URL and network connectivity.",
                    request_id=request_id,
                    attempts=attempt,
                    detail=self.redactor.scrub_text(f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__),
                )
                if attempt <= max_retries:
                    self._sleep(self._backoff(attempt))
                    continue
                raise err

    # ---------------------------------------------------------------- public
    @staticmethod
    def new_request_id() -> str:
        return uuid.uuid4().hex[:12]

    def complete_via_stream(
        self,
        messages: Sequence[dict[str, Any]],
        *,
        model: str | None = None,
        temperature: float | None = 0.7,
        max_tokens: int | None = None,
        timeout: float | None = None,
        request_id: str | None = None,
    ) -> ChatResult:
        """Run a non-interactive completion by streaming and aggregating.

        Some gateways (Magpie among them) serve streaming completions fine while
        their non-streaming path stalls or rejects the model.  Internally we
        therefore ask with ``stream: true`` and join the deltas into one
        ``ChatResult``; callers keep the same shape.  The audit log records the
        operation as ``stream`` (the wire truth) with the aggregated usage.
        """
        request_id = request_id or self.new_request_id()
        try:
            result = self._stream_once(
                messages, model=model, temperature=temperature,
                max_tokens=max_tokens, timeout=timeout, request_id=request_id,
            )
            # 思考模型常见的第二种形态：HTTP 200、finish=stop、正文一个字没有，
            # 因为额度全花在 reasoning 上。这不是成功，重发同额度也没用，只能抬额度。
            if (
                not result.text.strip()
                and (result.finish_reason or "") not in ("content_filter", "content_filtered")
                and max_tokens
                and max_tokens < _CEILING_BUDGET
            ):
                result = self._stream_once(
                    messages, model=model, temperature=temperature,
                    max_tokens=_CEILING_BUDGET, timeout=timeout,
                    request_id=self.new_request_id(),
                )
            return result
        except UpstreamError as err:
            # 上游明确说“思考把输出额度吃光了”：同一额度重发必然还是空。
            # 唯一有用的动作是把额度翻上去再发一次（网关自己也是这么建议的）。
            raised = max_tokens or 0
            if _budget_exhausted(str(err)) and raised and raised < _CEILING_BUDGET:
                return self._stream_once(
                    messages, model=model, temperature=temperature,
                    max_tokens=_CEILING_BUDGET, timeout=timeout,
                    request_id=self.new_request_id(),
                )
            raise

    def _stream_once(
        self,
        messages: Sequence[dict[str, Any]],
        *,
        model: str | None,
        temperature: float | None,
        max_tokens: int | None,
        timeout: float | None,
        request_id: str,
    ) -> ChatResult:
        events = self.stream_chat(
            messages,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            timeout=timeout,
            include_usage=True,
            request_id=request_id,
        )
        text = ""
        usage: dict[str, Any] | None = None
        finish: str | None = None
        done: StreamEvent | None = None
        for event in events:
            if event.type == "delta":
                text += event.text
            elif event.type == "done":
                done = event
                text = event.text or text
                usage = event.usage
                finish = event.finish_reason
        if done is None:
            raise UpstreamError("Upstream stream ended without a done event.")
        return ChatResult(
            text=text,
            usage=usage,
            finish_reason=finish,
            model=model or self.settings.model,
            request_id=done.request_id,
            latency_ms=done.ttft_ms or 0,
            attempts=done.attempts,
        )

    def complete(
        self,
        messages: Sequence[dict[str, Any]],
        *,
        model: str | None = None,
        temperature: float | None = 0.7,
        max_tokens: int | None = None,
        timeout: float | None = None,
        request_id: str | None = None,
    ) -> ChatResult:
        request_id = request_id or self.new_request_id()
        model_name = _clean_model_name(model or self.settings.model)
        if model and self.settings.model and "/" in self.settings.model and "/" not in model:
            candidate = f"{self.settings.model.split('/', 1)[0]}/{model.strip()}"
            if candidate == self.settings.model:
                model_name = candidate
        body: dict[str, Any] = {"model": model_name, "messages": list(messages), "stream": False}
        if temperature is not None:
            body["temperature"] = temperature
        if max_tokens is not None:
            body["max_tokens"] = max_tokens
        started = time.perf_counter()
        self._log(
            "request",
            request_id=request_id,
            operation="chat",
            model=model_name,
            message_count=len(messages),
            prompt_chars=_messages_char_len(messages),
            image_count=_count_images(messages),
            stream=False,
        )
        try:
            resp, attempts = self._open(
                "/chat/completions", request_id=request_id, payload=body, timeout=timeout
            )
            try:
                raw = resp.read()
            finally:
                resp.close()
            try:
                obj = json.loads(raw.decode("utf-8", "replace"))
            except ValueError as exc:
                raise UpstreamError(
                    "Upstream returned a non-JSON response.",
                    request_id=request_id,
                    detail=self.redactor.scrub_text(raw[:500].decode("utf-8", "replace")),
                ) from exc
            text, finish, usage = _extract_text(obj)
        except StudioError as err:
            latency_ms = int((time.perf_counter() - started) * 1000)
            self._log(
                "error",
                request_id=request_id,
                operation="chat",
                model=model_name,
                code=err.code,
                message=err.message,
                upstream_status=err.upstream_status,
                attempts=err.attempts,
                latency_ms=latency_ms,
            )
            raise
        latency_ms = int((time.perf_counter() - started) * 1000)
        self._log(
            "response",
            request_id=request_id,
            operation="chat",
            model=model_name,
            status="ok",
            attempts=attempts,
            latency_ms=latency_ms,
            usage=usage,
            text_chars=len(text),
            finish_reason=finish,
        )
        return ChatResult(
            text=text,
            usage=usage,
            finish_reason=finish,
            model=model_name,
            request_id=request_id,
            latency_ms=latency_ms,
            attempts=attempts,
        )

    def stream_chat(
        self,
        messages: Sequence[dict[str, Any]],
        *,
        model: str | None = None,
        temperature: float | None = 0.7,
        max_tokens: int | None = None,
        timeout: float | None = None,
        include_usage: bool | None = None,
        request_id: str | None = None,
    ) -> Iterator[StreamEvent]:
        request_id = request_id or self.new_request_id()
        model_name = _clean_model_name(model or self.settings.model)
        # Smart prefix fallback: if node provides a model name without prefix but default model has prefix
        if model and self.settings.model and "/" in self.settings.model and "/" not in model:
            candidate = f"{self.settings.model.split('/', 1)[0]}/{model.strip()}"
            if candidate == self.settings.model:
                model_name = candidate

        body: dict[str, Any] = {"model": model_name, "messages": list(messages), "stream": True}
        if temperature is not None:
            body["temperature"] = temperature
        if max_tokens is not None:
            body["max_tokens"] = max_tokens
        if include_usage is None:
            include_usage = self.settings.send_stream_options
        if include_usage:
            body["stream_options"] = {"include_usage": True}

        timeout = self.settings.timeout_s if timeout is None else timeout
        open_timeout = float(timeout)
        stream_budget = (
            max(open_timeout * 3.0, 180.0) if open_timeout >= 10.0 else open_timeout
        )
        started = time.perf_counter()
        self._log(
            "request",
            request_id=request_id,
            operation="stream",
            model=model_name,
            message_count=len(messages),
            prompt_chars=_messages_char_len(messages),
            image_count=_count_images(messages),
            stream=True,
        )

        parts: list[str] = []
        reasoning_parts: list[str] = []
        usage: dict[str, Any] | None = None
        finish_reason: str | None = None
        chunks = 0
        ttft_ms: int | None = None
        saw_done = False
        stream_ignored = False
        attempts = 0

        while True:
            attempts += 1
            try:
                resp, _ = self._open(
                    "/chat/completions",
                    request_id=request_id,
                    payload=body,
                    accept="text/event-stream",
                    timeout=timeout,
                    max_retries=0,
                )
            except StudioError as err:
                if err.retryable and attempts <= self.settings.max_retries:
                    self._log(
                        "retry",
                        request_id=request_id,
                        operation="stream",
                        attempt=attempts,
                        delay_s=round(self._backoff(attempts), 3),
                        reason=err.code,
                    )
                    self._sleep(self._backoff(attempts))
                    continue
                err.attempts = attempts
                self._log(
                    "error",
                    request_id=request_id,
                    operation="stream",
                    model=model_name,
                    code=err.code,
                    message=err.message,
                    upstream_status=err.upstream_status,
                    attempts=attempts,
                    latency_ms=int((time.perf_counter() - started) * 1000),
                )
                raise

            emitted = False
            try:
                content_type = (resp.headers.get("Content-Type") or "").lower()
                if "application/json" in content_type:
                    raw = resp.read()
                    try:
                        obj = json.loads(raw.decode("utf-8", "replace"))
                    except ValueError as exc:
                        raise UpstreamError(
                            "Upstream returned a non-JSON response to a streaming request.",
                            request_id=request_id,
                            detail=self.redactor.scrub_text(raw[:500].decode("utf-8", "replace")),
                        ) from exc
                    text, finish_reason, usage = _extract_text(obj)
                    stream_ignored = True
                    if text:
                        chunks += 1
                        ttft_ms = int((time.perf_counter() - started) * 1000)
                        parts.append(text)
                        yield StreamEvent(
                            "delta", text=text, request_id=request_id, attempts=attempts,
                            ttft_ms=ttft_ms, chunks=chunks,
                        )
                    break

                attempt_deadline = time.monotonic() + stream_budget
                for raw_line in resp:
                    if time.monotonic() > attempt_deadline:
                        raise UpstreamTimeoutError(
                            f"Streaming exceeded the {stream_budget:g}s budget.",
                            request_id=request_id,
                            attempts=attempts,
                        )
                    line = raw_line.decode("utf-8", "replace").strip()
                    if not line or line.startswith(":"):
                        continue
                    if line.startswith("event:"):
                        continue
                    if not line.startswith("data:"):
                        continue
                    payload = line[5:].strip()
                    if payload == "[DONE]":
                        saw_done = True
                        break
                    try:
                        obj = json.loads(payload)
                    except ValueError:
                        continue
                    if not isinstance(obj, dict):
                        continue
                    if obj.get("error"):
                        raise UpstreamError(
                            "Upstream reported an error inside the stream: "
                            + self.redactor.scrub_text(_error_message_from_body(payload)),
                            request_id=request_id,
                            attempts=attempts,
                            detail=self.redactor.scrub_text(payload[:800]),
                        )
                    if isinstance(obj.get("usage"), dict):
                        usage = obj["usage"]
                    for choice in obj.get("choices") or []:
                        if not isinstance(choice, dict):
                            continue
                        if choice.get("finish_reason"):
                            finish_reason = str(choice["finish_reason"])
                        delta = choice.get("delta") or choice.get("message") or {}
                        if not isinstance(delta, dict):
                            continue
                        chunk = delta.get("content")
                        if isinstance(chunk, list):
                            chunk = "".join(
                                str(p.get("text") or "") for p in chunk if isinstance(p, dict)
                            )
                        if chunk:
                            if ttft_ms is None:
                                ttft_ms = int((time.perf_counter() - started) * 1000)
                            chunks += 1
                            emitted = True
                            parts.append(str(chunk))
                            yield StreamEvent(
                                "delta", text=str(chunk), request_id=request_id,
                                attempts=attempts, ttft_ms=ttft_ms, chunks=chunks,
                            )
                        think = delta.get("reasoning_content") or delta.get("reasoning")
                        if think:
                            reasoning_parts.append(str(think))
                            yield StreamEvent(
                                "reasoning", reasoning=str(think), request_id=request_id,
                                attempts=attempts,
                            )
                if not emitted and not parts and not stream_ignored and not saw_done:
                    raise StreamInterruptedError(
                        "The stream ended before any content arrived.",
                        request_id=request_id,
                        attempts=attempts,
                        detail=f"http_status={getattr(resp, 'status', 200)}, chunks=0, saw_done=False",
                    )
            except StudioError as err:
                err.attempts = attempts
                self._log(
                    "error",
                    request_id=request_id,
                    operation="stream",
                    model=model_name,
                    code=err.code,
                    message=err.message,
                    attempts=attempts,
                    latency_ms=int((time.perf_counter() - started) * 1000),
                )
                if err.retryable and not emitted and attempts <= self.settings.max_retries:
                    self._sleep(self._backoff(attempts))
                    continue
                raise
            except (TimeoutError, socket.timeout) as exc:  # noqa: UP041
                if not emitted and attempts <= self.settings.max_retries:
                    self._sleep(self._backoff(attempts))
                    continue
                timeout_detail = self.redactor.scrub_text(
                    f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__
                )
                if not emitted and not parts:
                    raise UpstreamTimeoutError(
                        f"Upstream did not respond within {open_timeout:g}s.",
                        request_id=request_id,
                        attempts=attempts,
                        detail=timeout_detail,
                    ) from exc
                raise StreamInterruptedError(
                    "The stream timed out before completion.",
                    partial_text="".join(parts),
                    request_id=request_id,
                    attempts=attempts,
                    detail=timeout_detail,
                ) from exc
            except (http.client.HTTPException, OSError, ValueError) as exc:
                if not emitted and attempts <= self.settings.max_retries:
                    self._log(
                        "retry",
                        request_id=request_id,
                        operation="stream",
                        attempt=attempts,
                        delay_s=round(self._backoff(attempts), 3),
                        reason="stream_reset",
                    )
                    self._sleep(self._backoff(attempts))
                    continue
                partial_joined = "".join(parts)
                drop_msg = (
                    "The connection dropped mid-stream."
                    if partial_joined
                    else "The connection dropped before any content arrived."
                )
                raise StreamInterruptedError(
                    drop_msg,
                    partial_text=partial_joined,
                    request_id=request_id,
                    attempts=attempts,
                    detail=self.redactor.scrub_text(
                        f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__
                    ),
                ) from exc
            finally:
                try:
                    resp.close()
                except Exception:  # pragma: no cover
                    pass
            break

        total = "".join(parts)
        latency_ms = int((time.perf_counter() - started) * 1000)
        self._log(
            "response",
            request_id=request_id,
            operation="stream",
            model=model_name,
            status="ok",
            attempts=attempts,
            latency_ms=latency_ms,
            usage=usage,
            text_chars=len(total),
            chunks=chunks,
            ttft_ms=ttft_ms,
            finish_reason=finish_reason,
            saw_done=saw_done,
            stream_ignored=stream_ignored,
        )
        yield StreamEvent(
            "done",
            text=total,
            reasoning="".join(reasoning_parts),
            usage=usage,
            finish_reason=finish_reason,
            request_id=request_id,
            attempts=attempts,
            ttft_ms=ttft_ms,
            chunks=chunks,
            saw_done=saw_done,
            stream_ignored=stream_ignored,
        )

    def list_models(self, *, timeout: float | None = None) -> list[dict[str, Any]]:
        request_id = self.new_request_id()
        started = time.perf_counter()
        self._log("request", request_id=request_id, operation="models")
        try:
            resp, attempts = self._open(
                "/models",
                request_id=request_id,
                method="GET",
                accept="application/json",
                timeout=timeout,
            )
            try:
                raw = resp.read()
            finally:
                resp.close()
            obj = json.loads(raw.decode("utf-8", "replace"))
        except (StudioError, ValueError) as exc:
            err = exc if isinstance(exc, StudioError) else UpstreamError(
                "Model list endpoint returned invalid JSON.", request_id=request_id
            )
            self._log(
                "error",
                request_id=request_id,
                operation="models",
                code=err.code,
                message=err.message,
                latency_ms=int((time.perf_counter() - started) * 1000),
            )
            raise err
        data = obj.get("data") if isinstance(obj, dict) else None
        models = [m for m in data if isinstance(m, dict)] if isinstance(data, list) else []
        self._log(
            "response",
            request_id=request_id,
            operation="models",
            status="ok",
            attempts=attempts,
            latency_ms=int((time.perf_counter() - started) * 1000),
            model_count=len(models),
        )
        return models


def _messages_char_len(messages: Iterable[dict[str, Any]]) -> int:
    total = 0
    for message in messages:
        content = message.get("content")
        total += len(_content_text(content))
    return total


def _count_images(messages: Iterable[dict[str, Any]]) -> int:
    count = 0
    for message in messages:
        content = message.get("content")
        if isinstance(content, list):
            count += sum(
                1 for part in content if isinstance(part, dict) and part.get("type") == "image_url"
            )
    return count
