"""Saved gateway profiles: one named Base URL + model + API key, switched in one call.

The credential store intentionally keeps a single *current* gateway: one Base
URL, one model, one active key.  That is fine until the user works against a
local Magpie/Ollama gateway and a remote provider in the same session — every
switch then means retyping the URL and separately re-picking the key, and a
mismatched pair only shows up as a 401 at request time.

A gateway profile remembers the whole trio (``base_url`` + ``model`` + the id
of one stored key) so the panel can switch all three atomically.  Profiles live
in ``preferences.json`` because none of those fields is a secret; the key itself
stays in the credential vault and is referenced by id.
"""

from __future__ import annotations

import time
import uuid
from pathlib import Path
from typing import Any

from urllib.parse import urlsplit

from .config import load_preferences, normalize_base_url, save_preferences
from .credentials import activate_key, key_list, update_metadata
from .errors import ConfigError

GATEWAYS_PREF = "gateways"
ACTIVE_PREF = "active_gateway_id"
MAX_LABEL_LEN = 40


def _safe_base_url(value: Any) -> str:
    try:
        return normalize_base_url(str(value or ""))
    except ConfigError:
        return ""


def _public_profile(profile: dict[str, Any], keys: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Display-safe profile: never contains a secret, only the masked key."""
    key_id = str(profile.get("key_id") or "")
    key = next((item for item in (keys or []) if item.get("id") == key_id), None)
    return {
        "id": str(profile.get("id") or ""),
        "label": str(profile.get("label") or ""),
        "base_url": str(profile.get("base_url") or ""),
        "model": str(profile.get("model") or ""),
        "key_id": key_id,
        "key_label": str((key or {}).get("label") or ""),
        "key_masked": str((key or {}).get("masked") or ""),
        "key_missing": bool(key_id and key is None),
        "key_active": bool(key and key.get("active")),
        "created_at": profile.get("created_at"),
        "updated_at": profile.get("updated_at"),
    }


def _profiles(prefs: dict[str, Any]) -> list[dict[str, Any]]:
    raw = prefs.get(GATEWAYS_PREF)
    out: list[dict[str, Any]] = []
    if not isinstance(raw, list):
        return out
    for item in raw:
        if not isinstance(item, dict):
            continue
        gateway_id = str(item.get("id") or "").strip()
        base_url = _safe_base_url(item.get("base_url"))
        model = str(item.get("model") or "").strip()
        if not gateway_id or not base_url or not model:
            continue
        out.append(
            {
                "id": gateway_id,
                "label": str(item.get("label") or "").strip()[:MAX_LABEL_LEN],
                "base_url": base_url,
                "model": model,
                "key_id": str(item.get("key_id") or "").strip(),
                "created_at": item.get("created_at"),
                "updated_at": item.get("updated_at"),
            }
        )
    return out


def _same_gateway(profile: dict[str, Any], base_url: str, model: str) -> bool:
    return (
        str(profile.get("base_url") or "").rstrip("/").lower() == base_url.rstrip("/").lower()
        and str(profile.get("model") or "") == model
    )


def _write(home: Path, profiles: list[dict[str, Any]], active_id: str) -> None:
    save_preferences(home, {GATEWAYS_PREF: profiles, ACTIVE_PREF: active_id})


def default_label(base_url: str, model: str = "") -> str:
    """``host`` + model for a profile the user did not name."""
    try:
        host = urlsplit(base_url).netloc or base_url
    except ValueError:
        host = base_url
    host = host.replace("www.", "")
    return (f"{host} · {model}" if model else host)[:MAX_LABEL_LEN]


def list_gateways(
    home: Path,
    *,
    credential_path: Path | None = None,
    current_base_url: str = "",
    current_model: str = "",
) -> dict[str, Any]:
    """Saved profiles plus which one the live backend is currently on.

    ``current_base_url``/``current_model`` beat the remembered id: the backend
    may have been reconfigured by hand, and the list must never claim a profile
    is active when the request would go somewhere else.
    """
    prefs = load_preferences(home)
    profiles = _profiles(prefs)
    keys = key_list(credential_path)

    current = ""
    if current_base_url:
        normalized = _safe_base_url(current_base_url)
        for profile in profiles:
            if normalized and _same_gateway(profile, normalized, str(current_model or "")):
                current = profile["id"]
                break
    else:
        stored = str(prefs.get(ACTIVE_PREF) or "")
        if any(profile["id"] == stored for profile in profiles):
            current = stored

    return {
        "gateways": [_public_profile(profile, keys) for profile in profiles],
        "active_gateway_id": current,
    }


def sync_active_gateway(home: Path, base_url: str, model: str) -> str:
    """Remember which saved profile the current manual configuration matches.

    Called after ``POST /config``: editing the URL by hand must not leave an
    unrelated profile highlighted as active.
    """
    prefs = load_preferences(home)
    profiles = _profiles(prefs)
    normalized = _safe_base_url(base_url)
    match = ""
    if normalized:
        for profile in profiles:
            if _same_gateway(profile, normalized, str(model or "")):
                match = profile["id"]
                break
    if str(prefs.get(ACTIVE_PREF) or "") != match:
        _write(home, profiles, match)
    return match


def save_gateway(
    home: Path,
    *,
    base_url: str,
    model: str,
    label: str = "",
    key_id: str = "",
    gateway_id: str = "",
    activate: bool = True,
    credential_path: Path | None = None,
) -> dict[str, Any]:
    """Create or update one profile; the same URL+model updates in place."""
    normalized = normalize_base_url(str(base_url or ""))
    clean_model = str(model or "").strip()
    if not clean_model:
        raise ValueError("模型名不能为空。")

    prefs = load_preferences(home)
    profiles = _profiles(prefs)
    now = time.time()

    profile: dict[str, Any] | None = None
    if gateway_id:
        profile = next((item for item in profiles if item["id"] == gateway_id), None)
    if profile is None:
        profile = next(
            (item for item in profiles if _same_gateway(item, normalized, clean_model)), None
        )

    clean_label = str(label or "").strip()[:MAX_LABEL_LEN]
    if not clean_label:
        clean_label = default_label(normalized, clean_model)

    if profile is None:
        profile = {
            "id": "gw_" + uuid.uuid4().hex[:10],
            "created_at": now,
        }
        profiles.append(profile)
    profile["label"] = clean_label
    profile["base_url"] = normalized
    profile["model"] = clean_model
    profile["key_id"] = str(key_id or "").strip()
    profile["updated_at"] = now

    active_id = profile["id"] if activate else str(prefs.get(ACTIVE_PREF) or "")
    _write(home, profiles, active_id)
    return _public_profile(profile, key_list(credential_path))


def activate_gateway(
    home: Path, gateway_id: str, *, credential_path: Path | None = None
) -> dict[str, Any]:
    """Apply one profile to the credential store: URL, model, and its key."""
    prefs = load_preferences(home)
    profiles = _profiles(prefs)
    profile = next((item for item in profiles if item["id"] == str(gateway_id or "")), None)
    if profile is None:
        raise KeyError(f"未知的网关 id：{gateway_id}")

    # Validate before touching anything: a half-applied switch would leave the
    # credential file pointing at the new URL with the old key.
    key_id = str(profile.get("key_id") or "")
    if key_id and not any(item.get("id") == key_id for item in key_list(credential_path)):
        raise ValueError(
            f"网关「{profile['label']}」绑定的密钥已不存在，请在该网关下重新保存一条密钥。"
        )

    update_metadata(profile["base_url"], profile["model"], credential_path)
    if key_id:
        try:
            activate_key(key_id, credential_path)
        except ValueError as exc:
            raise ValueError(
                f"网关「{profile['label']}」绑定的密钥已不存在，请在该网关下重新保存一条密钥。"
            ) from exc

    _write(home, profiles, profile["id"])
    return _public_profile(profile, key_list(credential_path))


def delete_gateway(home: Path, gateway_id: str) -> bool:
    prefs = load_preferences(home)
    profiles = _profiles(prefs)
    remaining = [item for item in profiles if item["id"] != str(gateway_id or "")]
    if len(remaining) == len(profiles):
        return False
    active_id = str(prefs.get(ACTIVE_PREF) or "")
    if active_id == str(gateway_id or ""):
        active_id = ""
    _write(home, remaining, active_id)
    return True