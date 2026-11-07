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

import json
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

RULE_PRESETS: dict[str, str] = {
    "moss": (
        "Follow official MOSS-Image prompt conventions: describe concrete visible choices "
        "(main subject & action, physical appearance, spatial setting, camera angle and framing, medium, directional lighting, surface materials, palette and mood); "
        "preserve explicit user intent, counts, spatial relationships, exclusions, and intended visible text verbatim inside quotation marks; "
        "strictly forbid weighted parentheses syntax like (word:1.2) and generic quality tags (masterpiece, 8k, photorealistic); "
        "distinguish visible text from tool instructions and constraints."
    ),
    "layout": (
        "Follow official MOSS-Image spatial layout planning conventions: "
        "use summary for global visual composition and canvas metadata; "
        "use flat items array with absolute pixel bounding boxes [x_min, y_min, x_max, y_max] from top-left origin (0,0); "
        "canvas dimensions must be positive multiples of 16; "
        "labels must be character, object, or text; "
        "for text items, quote exact visible characters verbatim with intended line breaks; "
        "establish clear visual reading order, prominence hierarchy, and natural spatial layering."
    ),
    "danbooru": (
        "Output clean, comma-separated Danbooru-style descriptive English tags (all lowercase, underscores or spaces inside multi-word tags). "
        "Strict hierarchy order: quality/medium, core character and count (e.g. 1girl, solo), hair/eye features, facial expression, clothing and accessories, pose/action, background/setting, lighting, camera angle, art style. "
        "Strictly forbid narrative prose sentences, forbid weighted syntax like (word:1.2), and forbid markdown quotes or numbers. "
        "For specific visible text to render, specify with quote or text tag."
    ),
    "tags": (
        "Output clean, comma-separated Danbooru-style descriptive English tags (all lowercase, underscores or spaces inside multi-word tags). "
        "Strict hierarchy order: quality/medium, core character and count (e.g. 1girl, solo), hair/eye features, facial expression, clothing and accessories, pose/action, background/setting, lighting, camera angle, art style. "
        "Strictly forbid narrative prose sentences, forbid weighted syntax like (word:1.2), and forbid markdown quotes or numbers."
    ),
    "custom": "",
}
OUTPUT_LANGUAGES = ("en", "zh", "auto")


def load_preferences(home: Path) -> dict[str, Any]:
    """Load non-secret user preferences (prompt rules, language, timeouts) from home."""
    path = Path(home) / "preferences.json"
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_preferences(home: Path, prefs: Mapping[str, Any]) -> Path:
    """Persist non-secret user preferences atomically in home/preferences.json."""
    home_path = Path(home)
    home_path.mkdir(parents=True, exist_ok=True)
    path = home_path / "preferences.json"
    existing = load_preferences(home_path)
    existing.update(dict(prefs))
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(existing, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)
    return path


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
    rule_preset: str = "moss"
    output_language: str = "en"
    prompt_rules: str = ""
    user_custom_rules: str = ""
    max_regions: int = 10

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
        self.rule_preset = str(self.rule_preset or "moss").strip().lower()
        if self.rule_preset in ("prose", "moss"):
            self.rule_preset = "moss"
        elif self.rule_preset in ("tags", "danbooru"):
            self.rule_preset = "danbooru"
        elif self.rule_preset in ("hybrid", "layout"):
            self.rule_preset = "layout"
        elif self.rule_preset not in RULE_PRESETS:
            self.rule_preset = "moss"
        self.output_language = str(self.output_language or "en").strip().lower()
        if self.output_language not in OUTPUT_LANGUAGES:
            self.output_language = "en"
        self.prompt_rules = str(self.prompt_rules or "").strip()
        self.user_custom_rules = str(self.user_custom_rules or "").strip()
        try:
            self.max_regions = max(1, min(16, int(self.max_regions or 10)))
        except (TypeError, ValueError):
            self.max_regions = 10

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
            "rule_preset": self.rule_preset,
            "output_language": self.output_language,
            "prompt_rules": self.prompt_rules,
            "user_custom_rules": self.user_custom_rules,
            "max_regions": self.max_regions,
        }

    def ensure_local_bind(self) -> None:
        if self.host in ("127.0.0.1", "localhost", "::1"):
            return
        if os.environ.get("PROMPT_STUDIO_ALLOW_REMOTE") != "1":
            raise ConfigError(
                "Refusing to bind the backend to a non-loopback address. "
                "Set PROMPT_STUDIO_ALLOW_REMOTE=1 only if you understand the risk."
            )


def build_rule_suffix(
    settings: Settings | None,
    extra_instruction: str = "",
    *,
    for_json_layout: bool = False,
) -> str:
    """Build combined prompt rule & extra requirement text from Settings."""
    clauses: list[str] = []
    if settings is not None:
        preset = str(settings.rule_preset or "moss").strip().lower()
        if preset in ("prose", "moss"):
            canonical_preset = "moss"
        elif preset in ("tags", "danbooru"):
            canonical_preset = "danbooru"
        elif preset in ("hybrid", "layout"):
            canonical_preset = "layout"
        else:
            canonical_preset = preset

        # 1. Base rule of selected preset
        base_rule = str(settings.prompt_rules or "").strip()
        if not base_rule and canonical_preset in RULE_PRESETS:
            base_rule = RULE_PRESETS[canonical_preset].strip()

        if base_rule:
            if for_json_layout and canonical_preset in ("danbooru", "tags"):
                clauses.append(
                    "For summary.caption and items[].caption inside the JSON, use structured comma-separated descriptive phrases."
                )
            else:
                clauses.append(f"Prompt style preset ({canonical_preset}):\n{base_rule}")

        # 2. User's global custom requirements (automatically appended to EVERY rule)
        user_custom = str(settings.user_custom_rules or "").strip()
        if user_custom:
            clauses.append(f"User custom requirements (strictly follow across all presets):\n{user_custom}")

        lang = str(settings.output_language or "en").strip().lower()
        if lang == "zh":
            clauses.append(
                "Write all descriptive prompt text (or summary.caption and items[].caption in JSON) in fluent, natural Chinese (简体中文)."
            )
        elif lang == "auto":
            clauses.append(
                "Match the language of the user's extra requirement (defaulting to English if unspecified)."
            )
    extra = str(extra_instruction or "").strip()
    if extra:
        clauses.append(f"Additional user requirement: {extra}")
    if not clauses:
        return ""
    return "\n\n" + "\n\n".join(clauses)


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
    prefs = load_preferences(home)

    resolved_base = (
        base_url or env.get(_ENV_BASE_URL) or (creds.base_url if creds else None) or DEFAULT_BASE_URL
    )
    resolved_key = api_key or env.get(_ENV_API_KEY) or (creds.api_key if creds else None)
    resolved_model = (
        model or env.get(_ENV_MODEL) or (creds.model if creds else None) or DEFAULT_MODEL
    )

    host = env.get("PROMPT_STUDIO_HOST", "127.0.0.1")
    port = _as_int(env.get("PROMPT_STUDIO_PORT"), "PROMPT_STUDIO_PORT", 8791)
    default_timeout = _as_float(prefs.get("timeout_s"), "timeout_s", 60.0)
    default_retries = _as_int(prefs.get("max_retries"), "max_retries", 2)
    settings = Settings(
        base_url=resolved_base or "",
        model=resolved_model or "",
        api_key=resolved_key or "",
        home=home,
        timeout_s=_as_float(env.get("PROMPT_STUDIO_TIMEOUT_S"), "PROMPT_STUDIO_TIMEOUT_S", default_timeout),
        max_retries=_as_int(env.get("PROMPT_STUDIO_MAX_RETRIES"), "PROMPT_STUDIO_MAX_RETRIES", default_retries),
        backoff_s=_as_float(env.get("PROMPT_STUDIO_BACKOFF_S"), "PROMPT_STUDIO_BACKOFF_S", 0.5),
        host=host,
        port=port,
        server_token=env.get("PROMPT_STUDIO_SERVER_TOKEN") or None,
        send_stream_options=env.get("PROMPT_STUDIO_STREAM_OPTIONS") == "1",
        audit_path=Path(env["PROMPT_STUDIO_AUDIT"]) if env.get("PROMPT_STUDIO_AUDIT") else None,
        db_path=Path(env["PROMPT_STUDIO_DB"]) if env.get("PROMPT_STUDIO_DB") else None,
        media_dir=Path(env["PROMPT_STUDIO_MEDIA"]) if env.get("PROMPT_STUDIO_MEDIA") else None,
        rule_preset=str(prefs.get("rule_preset") or "moss"),
        output_language=str(prefs.get("output_language") or "en"),
        prompt_rules=str(prefs.get("prompt_rules") or ""),
        user_custom_rules=str(prefs.get("user_custom_rules") or ""),
        max_regions=_as_int(prefs.get("max_regions"), "max_regions", 10),
    )
    settings.ensure_local_bind()
    return settings
