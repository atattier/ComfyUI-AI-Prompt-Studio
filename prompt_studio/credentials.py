"""Credential storage: Windows Credential Manager first, file as fallback.

The API keys are secrets; Base URL and model are not.  On Windows each key goes
to Credential Manager as its own entry and only the non-secret metadata is
written to ``credentials.json``.  A legacy file that still contains ``api_key``
is migrated automatically the next time it is loaded: the key is moved to the
vault and removed from the file.

One Base URL can carry any number of keys.  The metadata file records the list
(``keys``: id / label / vault target) plus which one is currently active
(``active_key_id``).  Exactly one key is used at a time; there is no automatic
rotation, so a failing key is always traceable to the entry the user picked.
"""

from __future__ import annotations

import getpass
import json
import os
import stat
import sys
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

from . import wincred
from .redaction import mask_secret

LEGACY_KEY_ID = "default"
LEGACY_KEY_LABEL = "默认密钥"


def default_home() -> Path:
    return Path.home() / ".comfyui-ai-prompt-studio"


def default_credential_path() -> Path:
    return default_home() / "credentials.json"


@dataclass(slots=True)
class KeyEntry:
    """One API key: a display label plus the vault target that holds the secret."""

    id: str
    label: str
    target: str

    def to_dict(self) -> dict[str, str]:
        return {"id": self.id, "label": self.label, "target": self.target}


@dataclass(slots=True)
class Credentials:
    base_url: str
    api_key: str
    model: str
    storage: str = "file"
    target: str = "default"
    active_key_id: str = LEGACY_KEY_ID
    keys: list[KeyEntry] = field(default_factory=list)

    @classmethod
    def load(cls, path: Path | None = None) -> "Credentials | None":
        path = Path(path or default_credential_path())
        raw = _read_json(path)
        if raw is None:
            return None
        base_url = str(raw.get("base_url") or "").strip()
        model = str(raw.get("model") or "").strip()
        stored_key = str(raw.get("api_key") or "").strip()
        storage = str(raw.get("storage") or ("file" if stored_key else "wincred"))
        entries = _entries_from(raw)
        if not entries:
            return None
        active_id = _active_from(raw, entries)
        entry = _entry_for(entries, active_id)

        key = wincred.read(target=entry.target) if wincred.available() else None
        if not key and stored_key:
            if wincred.available() and wincred.write(stored_key, target=entry.target):
                # Legacy migration: keep a plaintext fallback on purpose — the vault
                # is not readable reliably from every process.
                _write_store(path, base_url, model, entries, entry.id, "wincred", fallback_key=stored_key)
                key = stored_key
                storage = "wincred"
            else:
                key = stored_key
                storage = "file"
        elif key and not stored_key:
            # Vault already holds the key; add the fallback copy for the next restart.
            _write_store(path, base_url, model, entries, entry.id, "wincred", fallback_key=key)
            storage = "wincred"

        if not (base_url and key and model):
            return None
        return cls(
            base_url=base_url,
            api_key=key,
            model=model,
            storage=storage,
            target=entry.target,
            active_key_id=entry.id,
            keys=entries,
        )


# -- metadata helpers ------------------------------------------------------


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return raw if isinstance(raw, dict) else None


def _entries_from(raw: Mapping[str, Any]) -> list[KeyEntry]:
    """Key list from metadata; a legacy single-key file becomes one entry."""
    if not raw:
        return []
    items = raw.get("keys")
    entries: list[KeyEntry] = []
    if isinstance(items, list):
        for item in items:
            if not isinstance(item, Mapping):
                continue
            key_id = str(item.get("id") or "").strip()
            target = str(item.get("target") or "").strip()
            if not key_id or not target:
                continue
            label = str(item.get("label") or "").strip()[:40] or key_id
            entries.append(KeyEntry(id=key_id, label=label, target=target))
    if entries:
        return entries
    target = str(raw.get("target") or "default").strip() or "default"
    return [KeyEntry(id=LEGACY_KEY_ID, label=LEGACY_KEY_LABEL, target=target)]


def _active_from(raw: Mapping[str, Any], entries: list[KeyEntry]) -> str:
    active = str(raw.get("active_key_id") or "").strip()
    if any(entry.id == active for entry in entries):
        return active
    return entries[0].id


def _entry_for(entries: list[KeyEntry], key_id: str) -> KeyEntry:
    for entry in entries:
        if entry.id == key_id:
            return entry
    return entries[0]


def _new_key_id() -> str:
    return "k" + uuid.uuid4().hex[:8]


def _write_file(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    tmp = path.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
    finally:
        try:
            os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)
        except OSError:
            pass
    os.replace(tmp, path)
    try:
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass


def _fallback_secret(raw: dict[str, Any], entries: list[KeyEntry], active_id: str) -> str:
    """要写进明文兜底副本的那条密钥（尽量取当前生效的那条）。"""
    entry = _entry_for(entries, active_id)
    secret = ""
    if entry is not None and wincred.available():
        secret = wincred.read(target=entry.target) or ""
    return secret or str(raw.get("api_key") or "").strip()


def _write_store(
    path: Path,
    base_url: str,
    model: str,
    entries: list[KeyEntry],
    active_id: str,
    storage: str,
    fallback_key: str = "",
) -> None:
    payload: dict[str, Any] = {
        "base_url": base_url.strip(),
        "model": model.strip(),
        "storage": storage,
        "target": entries[0].target,
        "active_key_id": active_id,
        "keys": [entry.to_dict() for entry in entries],
    }
    # 兜底副本：Windows 凭据管理器在不同进程/不同启动时机下会出现「写进去了、
    # 新进程读不出来」的情况，一旦发生整个后端就起不来。留一份明文在用户自己的
    # 目录里，读取时优先保险箱、失败再用它，保证重启后一定能用。
    if fallback_key:
        payload["api_key"] = fallback_key.strip()
    _write_file(path, payload)


def _write_legacy(
    path: Path,
    base_url: str,
    api_key: str,
    model: str,
    target: str = "default",
    entries: list[KeyEntry] | None = None,
    active_id: str | None = None,
) -> None:
    """Plaintext fallback for platforms without a secret vault."""
    payload: dict[str, Any] = {
        "base_url": base_url.strip(),
        "api_key": api_key.strip(),
        "model": model.strip(),
        "storage": "file",
        "target": target,
    }
    if entries:
        payload["keys"] = [entry.to_dict() for entry in entries]
        payload["active_key_id"] = active_id or entries[0].id
    _write_file(path, payload)


# -- public API ------------------------------------------------------------


def save_credentials(
    base_url: str,
    api_key: str,
    model: str,
    path: Path | None = None,
    *,
    target: str = "default",
) -> Path:
    """Store a key in the platform vault when possible; return metadata path.

    The entry that owns ``target`` is overwritten and becomes the active key,
    so the legacy "set my key" call keeps meaning "use this key from now on".
    Keys added earlier through :func:`add_key` are left untouched.
    """
    path = Path(path or default_credential_path())
    raw = _read_json(path) or {}
    entries = _entries_from(raw)
    entry = next((item for item in entries if item.target == target), None)
    if entry is None:
        entry = KeyEntry(
            id=LEGACY_KEY_ID if not entries else _new_key_id(),
            label=LEGACY_KEY_LABEL if not entries else f"密钥 {len(entries) + 1}",
            target=target,
        )
        entries.append(entry)
    if wincred.available() and wincred.write(api_key.strip(), target=entry.target):
        _write_store(path, base_url, model, entries, entry.id, "wincred", fallback_key=api_key)
    else:
        _write_legacy(path, base_url, api_key, model, target, entries, entry.id)
    return path


def add_key(
    api_key: str,
    label: str = "",
    path: Path | None = None,
    *,
    target_prefix: str = "default",
    activate: bool = False,
) -> "Credentials":
    """Add one key to the store under a fresh vault entry and return the state."""
    secret = (api_key or "").strip()
    if not secret:
        raise ValueError("api_key must not be empty")
    path = Path(path or default_credential_path())
    raw = _read_json(path)
    if raw is None:
        raise ValueError("还没有保存 Base URL 与模型，请先保存设置再添加密钥。")
    base_url = str(raw.get("base_url") or "").strip()
    model = str(raw.get("model") or "").strip()
    if not (base_url and model):
        raise ValueError("还没有保存 Base URL 与模型，请先保存设置再添加密钥。")
    if not wincred.available():
        raise ValueError("当前系统没有可用的凭据保险箱，无法保存多条密钥。")
    entries = _entries_from(raw)
    key_id = _new_key_id()
    vault_target = f"{target_prefix}#{key_id}" if target_prefix else key_id
    if not wincred.write(secret, target=vault_target):
        raise ValueError("写入 Windows 凭据管理器失败。")
    entries.append(
        KeyEntry(
            id=key_id,
            label=(label or f"密钥 {len(entries) + 1}").strip()[:40],
            target=vault_target,
        )
    )
    active = key_id if activate else _active_from(raw, entries)
    fallback = secret if activate else _fallback_secret(raw, entries, active)
    _write_store(path, base_url, model, entries, active, "wincred", fallback_key=fallback)
    creds = Credentials.load(path)
    if creds is None:  # pragma: no cover - write above produced a readable store
        raise ValueError("密钥已写入，但凭据文件无法重新读取。")
    return creds


def activate_key(key_id: str, path: Path | None = None) -> "Credentials":
    """Make one stored key the active one."""
    path = Path(path or default_credential_path())
    raw = _read_json(path)
    if raw is None:
        raise ValueError("还没有保存任何密钥。")
    entries = _entries_from(raw)
    entry = next((item for item in entries if item.id == key_id), None)
    if entry is None:
        raise ValueError(f"未知的密钥 id：{key_id}")
    _write_store(
        path,
        str(raw.get("base_url") or ""),
        str(raw.get("model") or ""),
        entries,
        entry.id,
        "wincred",
        fallback_key=_fallback_secret(raw, entries, entry.id),
    )
    creds = Credentials.load(path)
    if creds is None:  # pragma: no cover
        raise ValueError("切换密钥后无法重新读取凭据文件。")
    return creds


def delete_key(key_id: str, path: Path | None = None) -> "Credentials":
    """Remove one key (and its vault entry); the last key cannot be deleted."""
    path = Path(path or default_credential_path())
    raw = _read_json(path)
    if raw is None:
        raise ValueError("还没有保存任何密钥。")
    entries = _entries_from(raw)
    entry = next((item for item in entries if item.id == key_id), None)
    if entry is None:
        raise ValueError(f"未知的密钥 id：{key_id}")
    if len(entries) <= 1:
        raise ValueError("至少要保留一条密钥。")
    if wincred.available():
        wincred.delete(target=entry.target)
    remaining = [item for item in entries if item.id != key_id]
    active = _active_from(raw, entries)
    if active == key_id:
        active = remaining[0].id
    _write_store(
        path,
        str(raw.get("base_url") or ""),
        str(raw.get("model") or ""),
        remaining,
        active,
        "wincred",
        fallback_key=_fallback_secret(raw, remaining, active),
    )
    creds = Credentials.load(path)
    if creds is None:  # pragma: no cover
        raise ValueError("删除密钥后无法重新读取凭据文件。")
    return creds


def update_metadata(
    base_url: str,
    model: str,
    path: Path | None = None,
    *,
    target: str = "default",
) -> Path | None:
    """Rewrite Base URL / model without touching any stored secret.

    A missing store is left missing: there is nothing to preserve, and inventing
    an empty entry would show up in the key list as a key with no secret.
    """
    path = Path(path or default_credential_path())
    raw = _read_json(path)
    if raw is None:
        return None
    entries = _entries_from(raw)
    active = _active_from(raw, entries)
    storage = str(raw.get("storage") or "wincred")
    # Keep the plaintext fallback for the active key: this rewrite only changes
    # URL/model, and dropping the fallback makes the next process fail to start
    # whenever the vault cannot be read.
    fallback = _fallback_secret(raw, entries, active)
    _write_store(path, base_url, model, entries, active, storage, fallback_key=fallback)
    return path


def key_list(path: Path | None = None) -> list[dict[str, Any]]:
    """Display-safe list of stored keys: id, label, masked secret, active flag."""
    path = Path(path or default_credential_path())
    raw = _read_json(path)
    if raw is None:
        return []
    entries = _entries_from(raw)
    active = _active_from(raw, entries)
    plain = str(raw.get("api_key") or "")
    out: list[dict[str, Any]] = []
    for entry in entries:
        if wincred.available():
            secret = wincred.read(target=entry.target) or ""
        else:
            secret = plain if entry.target == str(raw.get("target") or "") else ""
        if not secret and entry.id == active:
            secret = plain
        out.append(
            {
                "id": entry.id,
                "label": entry.label,
                "masked": mask_secret(secret),
                "active": entry.id == active,
            }
        )
    return out


def delete_credentials(path: Path | None = None, *, target: str = "default") -> bool:
    path = Path(path or default_credential_path())
    removed = False
    raw = _read_json(path)
    targets = [entry.target for entry in _entries_from(raw)] if raw else [target]
    for vault_target in dict.fromkeys(targets):
        if wincred.available() and wincred.read(target=vault_target) is not None:
            removed = wincred.delete(target=vault_target) or removed
    if path.exists():
        path.unlink()
        removed = True
    return removed


def credential_backend(path: Path | None = None) -> str:
    creds = Credentials.load(path)
    return creds.storage if creds else wincred.backend_name()


def interactive_set(path: Path | None = None) -> Path:
    """Prompt for the three settings without echoing the key."""
    base_url = input("Base URL (e.g. https://api.example.com/v1): ").strip()
    model = input("Model: ").strip()
    api_key = getpass.getpass("API key (input hidden): ").strip()
    if not (base_url and model and api_key):
        raise SystemExit("All three fields are required.")
    saved = save_credentials(base_url, api_key, model, path)
    print(f"Saved metadata to {saved}")
    print(f"API key storage: {credential_backend(path)}")
    return saved


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] not in ("set", "show", "delete"):
        print("usage: python -m prompt_studio.credentials {set|show|delete}")
        return 2
    if argv[0] == "set":
        interactive_set()
        return 0
    path = default_credential_path()
    if argv[0] == "delete":
        print("Deleted stored credentials." if delete_credentials(path) else "No stored credentials.")
        return 0
    creds = Credentials.load(path)
    if not creds:
        print("No stored credentials.")
        return 1

    print(f"base_url: {creds.base_url}")
    print(f"model:    {creds.model}")
    for entry in key_list(path):
        mark = "*" if entry["active"] else " "
        print(f"key {mark}  {entry['masked']:<12} {entry['label']} (id={entry['id']})")
    print(f"storage:  {creds.storage}")
    print(f"file:     {path}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
