"""Error taxonomy for the unified multimodal API client.

Every error carries a stable machine-readable ``code``, an HTTP status suitable
for the local backend API, and whether a retry could plausibly help.  Messages
are always safe to show to the user and must never contain the API key.
"""

from __future__ import annotations

from typing import Any


class StudioError(Exception):
    code = "studio_error"
    http_status = 500
    retryable = False

    def __init__(
        self,
        message: str,
        *,
        detail: str | None = None,
        request_id: str | None = None,
        retry_after: float | None = None,
        upstream_status: int | None = None,
        attempts: int = 1,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.detail = detail
        self.request_id = request_id
        self.retry_after = retry_after
        self.upstream_status = upstream_status
        self.attempts = attempts

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
        }
        if self.detail:
            out["detail"] = self.detail
        if self.request_id:
            out["request_id"] = self.request_id
        if self.retry_after is not None:
            out["retry_after_s"] = self.retry_after
        if self.upstream_status is not None:
            out["upstream_status"] = self.upstream_status
        if self.attempts > 1:
            out["attempts"] = self.attempts
        return out


class ConfigError(StudioError):
    code = "config_error"
    http_status = 500


class AuthError(StudioError):
    code = "auth_failed"
    http_status = 401


class AccessDeniedError(StudioError):
    code = "access_denied"
    http_status = 403


class ModelNotFoundError(StudioError):
    code = "model_not_found"
    http_status = 404


class InvalidRequestError(StudioError):
    code = "invalid_request"
    http_status = 400


class CapabilityError(StudioError):
    code = "capability_unsupported"
    http_status = 422


class RateLimitError(StudioError):
    code = "rate_limited"
    http_status = 429
    retryable = True


class UpstreamError(StudioError):
    code = "upstream_error"
    http_status = 502
    retryable = True


class UpstreamTimeoutError(StudioError):
    code = "upstream_timeout"
    http_status = 504
    retryable = True


class NetworkError(StudioError):
    code = "network_error"
    http_status = 502
    retryable = True


class StreamInterruptedError(StudioError):
    code = "stream_interrupted"
    http_status = 502
    retryable = False

    def __init__(self, message: str, *, partial_text: str = "", **kwargs: Any) -> None:
        super().__init__(message, **kwargs)
        self.partial_text = partial_text

    def to_dict(self) -> dict[str, Any]:
        out = super().to_dict()
        if self.partial_text:
            out["partial_text"] = self.partial_text
        return out


class BodyTooLargeError(StudioError):
    code = "body_too_large"
    http_status = 413


class ServerUnauthorizedError(StudioError):
    code = "server_unauthorized"
    http_status = 401


class NotFoundError(StudioError):
    code = "not_found"
    http_status = 404
