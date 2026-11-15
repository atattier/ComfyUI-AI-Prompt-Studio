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
from urllib.parse import urlsplit

from .credentials import Credentials, default_home, key_list
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

DEFAULT_MODE_RULES: dict[str, str] = {
    "caption": (
        "1. Shot Framing & Subject: start with shot scale and camera angle (e.g. close-up, waist-up, full-body), subject appearance, facial features, eye gaze, and exact hairstyle.\n"
        "2. Attire, Objects & Actions: describe visible clothing layers, fabric textures, accessories, pose, and held objects faithfully.\n"
        "3. Spatial Grounding: anchor asymmetrical subjects, hands, and foreground/background elements using viewer's left / viewer's right.\n"
        "4. Objective Style Fidelity: describe visible lighting, color palette, and setting objectively without injecting extra photographic film/camera style assumptions—downstream LoRA controls rendering style.\n"
        "5. Clean Plain Output: quote exact visible text inside double quotes \"text\"; do NOT wrap in JSON and do NOT use (word:1.2) weights or markdown fences."
    ),
    "layout": (
        "1. Summary & Metadata: write a coherent global caption in summary.caption (reusing the prose description when supplied), plus canvas, meta tags, and color palette.\n"
        "2. Depth-Ordered Regions: list visible regions in items ordered from background (furthest) to foreground (nearest).\n"
        "3. Labels & Quoted Text: label must be character, object, or text; copy legible visible text verbatim inside text items' text field.\n"
        "4. Tight Decoupled Boxes: separate background, characters, outer/inner garment layers, and held props into tight visible boxes.\n"
        "5. Strict JSON Output: output a single valid JSON object only, without markdown code fences."
    ),
    "danbooru": (
        "1. Clean Tags Format: output one lowercase English line of comma-separated Danbooru tags, using underscores inside multi-word tags.\n"
        "2. Canonical Order: order by character count (e.g. 1girl, solo), distinctive features/hair/eyes, expression, layered clothing & accessories, pose/action, background/props, lighting/framing, medium.\n"
        "3. Objective LoRA-Friendly Fidelity: record only genuinely visible attributes without adding unprompted style bias.\n"
        "4. Text & Prohibitions: denote legible visible text cleanly; forbid narrative sentences, (word:1.2) weights, markdown, or numbering."
    ),
}

RULE_PRESETS: dict[str, str] = {
    "moss": (
        "Follow official MOSS-Image (Qwen3.5-9B TE + DiT) natural prompt standards: "
        "1. Shot Framing & Subject Identity: open with accurate shot framing (e.g. waist-up portrait, full-body shot), subject appearance, facial features, eye color, and exact hairstyle (e.g. half-up hair, loose waves, ponytail). "
        "2. Layered Attire & Accessories: describe the overall fashion style (e.g. dark-academia attire, urban casual) and every visible garment layer, fabric texture, and accessory from outer to inner (e.g. oversized wool coat over a knit hoodie and pleated skirt, thin leather belt with silver buckle, folded tartan plaid scarf). "
        "3. Natural Pose, Props & Spatial Grounding: describe held props (e.g. open paperback book) and bags (e.g. crossbody bag slung over shoulder) naturally; ground asymmetrical positions to viewer's left or right side. "
        "4. Environment, Lighting & Palette: describe background architecture or scenery and faithful lighting quality (e.g. soft diffused overcast lighting, warm golden hour). "
        "5. Clean Fidelity: describe only what is genuinely visible in the image without inventing harsh flash or absent props; quote visible text inside double quotes and avoid weighted (word:1.2) syntax."
    ),
    "moss_cinematic": (
        "MOSS-Image 12 Photographic & Cinema Film Still Presets (Evidence Level A): "
        "Structure: [Photographic Medium & Optics] -> [Perspective & Foreground Framing Occlusion] -> [Subject & Distinctive Anatomy] -> [Lighting Instrument & Shadow Falloff] -> [Film Grain & Texture Lock]. "
        "Available optical profiles: 1990s disposable 35mm film flash (hard black drop shadow, dark vignette, heavy grain); "
        "Low-key chiaroscuro Rembrandt beam (half of face submerged in deep shadow, zero front fill); "
        "Wong Kar-wai Hong Kong neon (saturated emerald-green + amber tungsten neon, slow-shutter motion trails, red halation); "
        "Hollywood anamorphic widescreen (teal-and-orange grading, oval vertical bokeh orbs, horizontal blue streak flare); "
        "1994 home VHS camcorder (horizontal scanlines, RGB chroma bleed, green OSD timestamp); "
        "Airy Japanese pastel overexposed film (high-key soft window light, lifted milky shadows, cyan-mint & cream cast). "
        "Always add an out-of-focus foreground framing element (over-the-shoulder, vertical doorframe) and mundane life props to eliminate stiff AI posing."
    ),
    "moss_anime": (
        "MOSS-Image 2D Anime & Manga Stylization Channels (Evidence Level A): "
        "Keep the subject prompt neutral (no skin pores, flash, or photo film terms) and invoke authentic styles via top classifier groups: "
        "- 1990s Retro Cel OVA: 1990s (style), retro artstyle, anime screencap, cel shading, vintage 1990s OVA anime aesthetic, VHS tape color bleed, hand-painted cel animation; "
        "- Black & White Manga: manga page, monochrome, greyscale, screentones, inked lineart, bold black ink outlines, pen crosshatching (strip all color words from body); "
        "- Transparent Watercolor: watercolor (medium), traditional media, ink and wash, soft pastel watercolor bleed on rough textured paper; "
        "- Pop Flat Vector: flat color, vector illustration, bold thick colored outlines, vibrant pop art palette, hard geometric cel shading; "
        "- 16-bit Pixel Retro: pixel art, 16-bit retro PC-98 Japanese adventure game graphic, crisp visible square pixel grid, checkerboard dithering, limited 16-color palette. "
        "Never invent unknown artist names or force fragmented geometric facial features."
    ),
    "moss_closed_tags": (
        "Official MOSS-Image <|concept|>...<|/concept|> Closed-Tag Block Schema: "
        "Isolate visual concepts into closed blocks to reduce cross-concept token bleeding by over 50%: "
        "<|style_and_camera|>[Optics / medium, framing, camera angle, primary subject, viewer perspective]<|/style_and_camera|>\n"
        "<|left_or_upper_subject|>[Viewer's left / upper subject: anatomy, hair, clothing static state, unique key light]<|/left_or_upper_subject|>\n"
        "<|right_or_lower_subject|>[Viewer's right / lower subject: causal contrast, distinctive opposite traits]<|/right_or_lower_subject|>\n"
        "<|texture_lock|>Unretouched realistic human skin texture with microscopic pores, real human hair strands in sharp focus, authentic specular highlights, organic 35mm analog film grain.<|/texture_lock|>"
    ),
    "layout": (
        "Follow official MOSS-Image spatial layout planning conventions: "
        "use summary for global visual composition, canvas metadata, meta tags, and color palette; "
        "use items array ordered from background (furthest) to foreground (nearest); "
        "labels must be character, object, or text; "
        "for text items, quote exact visible characters verbatim; "
        "decouple background, character, layered garments (coat, inner hoodie, skirt, scarf), and held props/bags into distinct regions."
    ),
    "pixel_fidelity": (
        "Role: Expert Vision Reverse-Engineering & Pixel-Level Prompt Engineer (High-Fidelity Grounding Standard). "
        "Extract all concrete visual elements with multi-layered microscopic precision (subject, clothing materials, anatomy, props, spatial depth, lighting, textures). "
        "Anchor viewer-perspective spatial placement (viewer's left vs right) for all asymmetrical subjects, actions, and gestures to eliminate composition flipping. "
        "Eliminate generic praise (masterpiece, 8k) and describe tangible physical reality. "
        "Transcribe true visible signage/text verbatim inside quotation marks while scrubbing watermarks/logos. "
        "If extra instruction is provided, execute visual fusion: keep unmodified regions anchored to the reference while strictly prioritizing user's modifications."
    ),
    "portrait_master": (
        "Role: Master Portrait & Aesthetic Cinematography Prompt Specialist. "
        "Focus on natural photographic realism, authentic Asian aesthetic nuances, and tactile micro-textures: "
        "delicate skin pores, natural sebum sheen, subtle subcutaneous flush, lifelike iris depth, catchlights, individual hair strands. "
        "Specify camera optics: 50mm or 85mm prime lens, wide aperture f/1.4 shallow depth of field, creamy natural bokeh, soft directional key light and rim reflections. "
        "Avoid plastic waxy smoothing or harsh green/zombie skin tones."
    ),
    "character_extractor": (
        "Role: Character Design & Turnaround Sheet Extractor. "
        "Completely strip away background, environmental clutter, lighting moods, and original art medium/style. "
        "Isolate and crystallize the character's core identity: facial geometry, hair color/style, eye color, physiological proportions, "
        "all garment layers, fabrics, seams, accessories, insignia, and specialized equipment. "
        "Force neutral standing base posture to anchor character consistency for multi-view generation or video migration."
    ),
    "qwen_edit": (
        "Role: Visual Logic & Precise Image Editing Prompt Engineer (Qwen-Image-Edit Standard). "
        "Analyze the reference image and user edit intent: precisely anchor the target subject/region to alter, "
        "clearly distinguish preserved elements from modified elements, and specify the exact replacement, addition, or style transformation without unintended collateral changes."
    ),
    "video_wan_h3": (
        "Role: AI Cinematographer & Physical Dynamics Director (Wan 2.1 & MiniMax H3 5-Part Formula). "
        "Structure: [Subject] -> [Scene] -> [Motion & Dynamic Physics] -> [Aesthetics & Lighting] -> [Cinematic Style]. "
        "Describe complete motion trajectory, momentum, and secondary physics (hair inertia, garment fabric flutter, weight shifts), "
        "paired with explicit camera work (smooth push-in, lateral tracking, continuous one-take sequencing)."
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
    "cinematic": (
        "Structure prompt using high-end cinema language: specify camera framing (wide, medium, close-up), anamorphic lens focal length, "
        "volumetric Tyndall rays, key-to-fill lighting ratio, color grading palette (e.g. warm golden hour or moody teal/amber), and atmospheric depth."
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


_GEMINI_HOST = "generativelanguage.googleapis.com"


def normalize_base_url(url: str) -> str:
    url = (url or "").strip()
    if not url:
        raise ConfigError("Base URL is not configured.")
    if any(ch in url for ch in ("\n", "\r", "\t", " ")):
        raise ConfigError("Base URL must not contain whitespace.")
    if not re.match(r"^https?://", url, re.IGNORECASE):
        raise ConfigError("Base URL must start with http:// or https://")
    return _complete_known_path(url.rstrip("/"))


def _complete_known_path(url: str) -> str:
    """Finish a Gemini base URL the user may have pasted only halfway.

    Gemini serves its OpenAI-compatible layer under ``/v1beta/openai``.  Pasting
    just the host, or ``/v1beta``, would otherwise leave ``api_url()`` joining
    paths onto Google's native REST root, which rejects OpenAI chat payloads.
    """
    try:
        parts = urlsplit(url)
    except ValueError:
        return url
    if parts.netloc.lower() != _GEMINI_HOST:
        return url
    path = parts.path.rstrip("/")
    if not path:
        return url + "/v1beta/openai"
    if path.lower().endswith("/v1beta"):
        return url + "/openai"
    return url


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
    timeout_s: float = 120.0
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
    caption_rules: str = ""
    layout_rules: str = ""
    danbooru_rules: str = ""
    max_regions: int = 10
    active_key_id: str = ""
    api_keys: list[dict[str, Any]] = field(default_factory=list)

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
        self.caption_rules = str(self.caption_rules or "").strip()
        self.layout_rules = str(self.layout_rules or "").strip()
        self.danbooru_rules = str(self.danbooru_rules or "").strip()
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
            "active_key_id": self.active_key_id,
            "api_keys": [dict(item) for item in self.api_keys],
            "timeout_s": self.timeout_s,
            "max_retries": self.max_retries,
            "host": self.host,
            "port": self.port,
            "rule_preset": self.rule_preset,
            "output_language": self.output_language,
            "prompt_rules": self.prompt_rules,
            "user_custom_rules": self.user_custom_rules,
            "caption_rules": self.caption_rules,
            "layout_rules": self.layout_rules,
            "danbooru_rules": self.danbooru_rules,
            "default_mode_rules": dict(DEFAULT_MODE_RULES),
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


def _canonical_mode(mode: str, *, for_json_layout: bool = False) -> str:
    m = str(mode or "").strip().lower()
    if m in ("caption", "prose", "moss"):
        return "caption"
    if m == "layout":
        return "layout"
    if m in ("danbooru", "tags"):
        return "danbooru"
    if m == "hybrid":
        return "layout" if for_json_layout else "caption"
    return "layout" if for_json_layout else "caption"


def build_rule_suffix(
    settings: Settings | None,
    extra_instruction: str = "",
    *,
    mode: str | None = None,
    for_json_layout: bool = False,
) -> str:
    """Build combined prompt rule & extra requirement text from Settings.

    When ``mode`` is supplied (``caption`` | ``layout`` | ``danbooru`` or aliases
    ``prose`` / ``tags`` / ``moss`` / ``hybrid``), strictly reads ONLY that mode's
    dedicated rule (``caption_rules`` / ``layout_rules`` / ``danbooru_rules`` or
    ``DEFAULT_MODE_RULES[mode]``) so modes never cross-pollinate.
    """
    clauses: list[str] = []
    if settings is not None:
        if mode is not None:
            canonical_mode = _canonical_mode(mode, for_json_layout=for_json_layout)
            mode_rule = str(getattr(settings, f"{canonical_mode}_rules", "") or "").strip()
            if not mode_rule:
                mode_rule = DEFAULT_MODE_RULES[canonical_mode]
            if for_json_layout or canonical_mode == "layout":
                clauses.append(f"Layout mode rules:\n{mode_rule}")
            else:
                clauses.append(f"Mode rules ({canonical_mode}):\n{mode_rule}")
        else:
            preset = str(getattr(settings, "rule_preset", "moss") or "moss").strip().lower()
            if preset in ("prose", "moss"):
                canonical_preset = "moss"
            elif preset in ("tags", "danbooru"):
                canonical_preset = "danbooru"
            elif preset in ("hybrid", "layout"):
                canonical_preset = "layout"
            else:
                canonical_preset = preset

            # 1. Base rule of selected preset
            base_rule = str(getattr(settings, "prompt_rules", "") or "").strip()
            if not base_rule and canonical_preset in RULE_PRESETS:
                base_rule = RULE_PRESETS[canonical_preset].strip()

            if base_rule:
                if for_json_layout:
                    if canonical_preset in ("danbooru", "tags"):
                        clauses.append(
                            "For summary.caption and items[].caption inside the JSON, use structured comma-separated descriptive phrases."
                        )
                    elif str(getattr(settings, "prompt_rules", "") or "").strip():
                        clauses.append(f"Custom layout prompt rules:\n{str(getattr(settings, 'prompt_rules', '')).strip()}")
                else:
                    clauses.append(f"Prompt style preset ({canonical_preset}):\n{base_rule}")

        # 2. User's global custom requirements (automatically appended across modes)
        user_custom = str(getattr(settings, "user_custom_rules", "") or "").strip()
        if user_custom:
            clauses.append(f"User custom requirements (strictly follow):\n{user_custom}")

        lang = str(getattr(settings, "output_language", "en") or "en").strip().lower()
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
    default_timeout = _as_float(prefs.get("timeout_s"), "timeout_s", 120.0)
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
        caption_rules=str(prefs.get("caption_rules") or ""),
        layout_rules=str(prefs.get("layout_rules") or ""),
        danbooru_rules=str(prefs.get("danbooru_rules") or ""),
        max_regions=_as_int(prefs.get("max_regions"), "max_regions", 10),
    )
    settings.ensure_local_bind()
    if creds is not None:
        # The active key is one of possibly many; the panel lists them all.
        settings.active_key_id = creds.active_key_id
        settings.api_keys = key_list(credential_path)
    return settings
