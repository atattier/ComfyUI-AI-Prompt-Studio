"""Unified API configuration: one Base URL, one API key, one model.

Resolution order (later wins):

1. built-in defaults (local Magpie gateway, see ``DEFAULT_BASE_URL``/``DEFAULT_MODEL``)
2. credential file  ``~/.comfyui-ai-prompt-studio/credentials.json``
3. environment      ``PROMPT_STUDIO_BASE_URL`` / ``..._API_KEY`` / ``..._MODEL``
4. explicit keyword arguments (tests, embedders)

The key is held in memory only in the backend process.  ``public_dict()`` is the
only representation that may cross the HTTP boundary and it never contains the
key itself.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

from .credentials import Credentials, default_home
from .errors import ConfigError
from .redaction import mask_secret

_ENV_BASE_URL = "PROMPT_STUDIO_BASE_URL"
_ENV_API_KEY = "PROMPT_STUDIO_API_KEY"
_ENV_MODEL = "PROMPT_STUDIO_MODEL"

# Defaults for this workspace: the local Magpie gateway, which ignores the API
# key and exposes an OpenAI-compatible endpoint.  Any of the three can be
# overridden by credentials or environment variables.
DEFAULT_BASE_URL = "http://127.0.0.1:3425/v1"
DEFAULT_MODEL = "gemini-3.8-flash"


def normalize_base_url(url: str) -> str:
    url = (url or "").strip()
    if not url:
        raise ConfigError("Base URL is not configured.")
    if any(ch in url for ch in ("\n", "\r", "\t", " ")):
        raise ConfigError("Base URL must not contain whitespace.")
    if not re.match(r"^https?://", url, re.IGNORECASE):
        raise ConfigError("Base URL must start with http:// or https://")
    return url.rstrip("/")


def _as_float(value: Any, name: str, default: float) -> float:
    if value in (None, ""):
        return default
    try:
        out = float(value)
    except (TypeError, ValueError) as exc:
        raise ConfigError(f"{name} must be a number, got {value!r}") from exc
    if out <= 0:
        raise ConfigError(f"{name} must be greater than zero.")
    return out


def _as_int(value: Any, name: str, default: int) -> int:
    if value in (None, ""):
        return default
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise ConfigError(f"{name} must be an integer, got {value!r}") from exc


@dataclass(slots=True)
class Settings:
    base_url: str
    model: str
    api_key: str
    home: Path
    timeout_s: float = 60.0
    max_retries: int = 2
    backoff_s: float = 0.5
    max_backoff_s: float = 8.0
    host: str = "127.0.0.1"
    port: int = 8791
    server_token: str | None = None
    send_stream_options: bool = False
    audit_path: Path = field(default=None)  # type: ignore[assignment]
    db_path: Path = field(default=None)  # type: ignore[assignment]
    media_dir: Path = field(default=None)  # type: ignore[assignment]
    max_image_bytes: int = 8 * 1024 * 1024

    def __post_init__(self) -> None:
        self.base_url = normalize_base_url(self.base_url)
        self.model = (self.model or "").strip()
        if not self.model:
            raise ConfigError("Model is not configured.")
        if not self.api_key:
            raise ConfigError("API key is not configured.")
        self.home = Path(self.home)
        self.audit_path = Path(self.audit_path or (self.home / "audit.jsonl"))
        self.db_path = Path(self.db_path or (self.home / "sessions.sqlite3"))
        self.media_dir = Path(self.media_dir or (self.home / "media"))

    # -- endpoints ---------------------------------------------------------
    def api_url(self, path: str) -> str:
        """Join ``path`` onto the configured base URL without duplicating /v1."""
        base = self.base_url.rstrip("/")
        if re.search(r"/(v1|v1beta|v1beta/openai|openai)$", base, re.IGNORECASE):
            return base + path
        return base + "/v1" + path

    # -- safety ------------------------------------------------------------
    def public_dict(self) -> dict[str, Any]:
        return {
            "base_url": self.base_url,
            "model": self.model,
            "api_key_configured": bool(self.api_key),
            "api_key_masked": mask_secret(self.api_key),
            "timeout_s": self.timeout_s,
            "max_retries": self.max_retries,
            "host": self.host,
            "port": self.port,
        }

    def ensure_local_bind(self) -> None:
        if self.host in ("127.0.0.1", "localhost", "::1"):
            return
        if os.environ.get("PROMPT_STUDIO_ALLOW_REMOTE") != "1":
            raise ConfigError(
                "Refusing to bind the backend to a non-loopback address. "
                "Set PROMPT_STUDIO_ALLOW_REMOTE=1 only if you understand the risk."
            )


def load_settings(
    *,
    env: Mapping[str, str] | None = None,
    credential_path: Path | None = None,
    base_url: str | None = None,
    api_key: str | None = None,
    model: str | None = None,
    home: Path | None = None,
) -> Settings:
    env = os.environ if env is None else env
    home = Path(home or env.get("PROMPT_STUDIO_HOME") or default_home())

    creds = Credentials.load(credential_path) if credential_path else Credentials.load()

    resolved_base = (
        base_url or env.get(_ENV_BASE_URL) or (creds.base_url if creds else None) or DEFAULT_BASE_URL
    )
    resolved_key = api_key or env.get(_ENV_API_KEY) or (creds.api_key if creds else None)
    resolved_model = (
        model or env.get(_ENV_MODEL) or (creds.model if creds else None) or DEFAULT_MODEL
    )

    host = env.get("PROMPT_STUDIO_HOST", "127.0.0.1")
    port = _as_int(env.get("PROMPT_STUDIO_PORT"), "PROMPT_STUDIO_PORT", 8791)
    settings = Settings(
        base_url=resolved_base or "",
        model=resolved_model or "",
        api_key=resolved_key or "",
        home=home,
        timeout_s=_as_float(env.get("PROMPT_STUDIO_TIMEOUT_S"), "PROMPT_STUDIO_TIMEOUT_S", 60.0),
        max_retries=_as_int(env.get("PROMPT_STUDIO_MAX_RETRIES"), "PROMPT_STUDIO_MAX_RETRIES", 2),
        backoff_s=_as_float(env.get("PROMPT_STUDIO_BACKOFF_S"), "PROMPT_STUDIO_BACKOFF_S", 0.5),
        host=host,
        port=port,
        server_token=env.get("PROMPT_STUDIO_SERVER_TOKEN") or None,
        send_stream_options=env.get("PROMPT_STUDIO_STREAM_OPTIONS") == "1",
        audit_path=Path(env["PROMPT_STUDIO_AUDIT"]) if env.get("PROMPT_STUDIO_AUDIT") else None,
        db_path=Path(env["PROMPT_STUDIO_DB"]) if env.get("PROMPT_STUDIO_DB") else None,
        media_dir=Path(env["PROMPT_STUDIO_MEDIA"]) if env.get("PROMPT_STUDIO_MEDIA") else None,
    )
    settings.ensure_local_bind()
    return settings
