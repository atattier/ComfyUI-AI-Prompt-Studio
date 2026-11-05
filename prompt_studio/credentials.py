"""Credential storage: Windows Credential Manager first, file as fallback.

The API key is a secret; Base URL and model are not.  On Windows the key goes
to Credential Manager and only the non-secret metadata is written to
``credentials.json``.  A legacy file that still contains ``api_key`` is
migrated automatically the next time it is loaded: the key is moved to the
vault and removed from the file.
"""

from __future__ import annotations

import getpass
import json
import os
import stat
import sys
from dataclasses import dataclass
from pathlib import Path

from . import wincred


def default_home() -> Path:
    return Path.home() / ".comfyui-ai-prompt-studio"


def default_credential_path() -> Path:
    return default_home() / "credentials.json"


@dataclass(slots=True)
class Credentials:
    base_url: str
    api_key: str
    model: str
    storage: str = "file"
    target: str = "default"

    @classmethod
    def load(cls, path: Path | None = None) -> "Credentials | None":
        path = Path(path or default_credential_path())
        if not path.exists():
            return None
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        base_url = str(raw.get("base_url") or "").strip()
        model = str(raw.get("model") or "").strip()
        stored_key = str(raw.get("api_key") or "").strip()
        storage = str(raw.get("storage") or ("file" if stored_key else "wincred"))
        target = str(raw.get("target") or "default")

        key = wincred.read(target=target) if wincred.available() else None
        if not key and stored_key:
            if wincred.available() and wincred.write(stored_key, target=target):
                # Legacy migration: move the secret out of the plain file.
                _write_metadata(path, base_url, model, "wincred", target)
                key = stored_key
                storage = "wincred"
            else:
                key = stored_key
                storage = "file"
        elif key and stored_key:
            # The vault already holds the key; drop the stale plaintext copy.
            _write_metadata(path, base_url, model, "wincred", target)
            storage = "wincred"

        if not (base_url and key and model):
            return None
        return cls(base_url=base_url, api_key=key, model=model, storage=storage, target=target)


def _write_metadata(path: Path, base_url: str, model: str, storage: str, target: str = "default") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(
        {"base_url": base_url.strip(), "model": model.strip(), "storage": storage, "target": target},
        ensure_ascii=False,
        indent=2,
    )
    tmp = path.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(payload + "\n")
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


def _write_legacy(path: Path, base_url: str, api_key: str, model: str, target: str = "default") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(
        {"base_url": base_url.strip(), "api_key": api_key.strip(), "model": model.strip(), "storage": "file", "target": target},
        ensure_ascii=False,
        indent=2,
    )
    tmp = path.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(payload + "\n")
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


def save_credentials(
    base_url: str,
    api_key: str,
    model: str,
    path: Path | None = None,
    *,
    target: str = "default",
) -> Path:
    """Store the key in the platform vault when possible; return metadata path."""
    path = Path(path or default_credential_path())
    if wincred.available() and wincred.write(api_key.strip(), target=target):
        _write_metadata(path, base_url, model, "wincred", target)
    else:
        _write_legacy(path, base_url, api_key, model, target)
    return path


def delete_credentials(path: Path | None = None, *, target: str = "default") -> bool:
    path = Path(path or default_credential_path())
    removed = False
    if wincred.available() and wincred.read(target=target) is not None:
        removed = wincred.delete(target=target) or removed
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
    from .redaction import mask_secret

    print(f"base_url: {creds.base_url}")
    print(f"model:    {creds.model}")
    print(f"api_key:  {mask_secret(creds.api_key)}")
    print(f"storage:  {creds.storage}")
    print(f"file:     {path}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
