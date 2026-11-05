"""Local credential storage for the backend process.

The key lives outside the project tree (``~/.comfyui-ai-prompt-studio`` by
default), is written with owner-only permissions where the platform supports
them, and is never printed back.  On Windows the POSIX mode is advisory; M1
will move the secret to Windows Credential Manager.  This limitation is
recorded in ``docs/security.md``.
"""

from __future__ import annotations

import getpass
import json
import os
import stat
import sys
from dataclasses import dataclass
from pathlib import Path


def default_home() -> Path:
    return Path.home() / ".comfyui-ai-prompt-studio"


def default_credential_path() -> Path:
    return default_home() / "credentials.json"


@dataclass(slots=True)
class Credentials:
    base_url: str
    api_key: str
    model: str

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
        api_key = str(raw.get("api_key") or "").strip()
        model = str(raw.get("model") or "").strip()
        if not (base_url and api_key and model):
            return None
        return cls(base_url=base_url, api_key=api_key, model=model)


def save_credentials(
    base_url: str,
    api_key: str,
    model: str,
    path: Path | None = None,
) -> Path:
    path = Path(path or default_credential_path())
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(
        {"base_url": base_url.strip(), "api_key": api_key.strip(), "model": model.strip()},
        ensure_ascii=False,
        indent=2,
    )
    # Write atomically, then tighten permissions.
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
    return path


def interactive_set(path: Path | None = None) -> Path:
    """Prompt for the three settings without echoing the key."""
    base_url = input("Base URL (e.g. https://api.example.com/v1): ").strip()
    model = input("Model: ").strip()
    api_key = getpass.getpass("API key (input hidden): ").strip()
    if not (base_url and model and api_key):
        raise SystemExit("All three fields are required.")
    saved = save_credentials(base_url, api_key, model, path)
    print(f"Saved to {saved}")
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
        if path.exists():
            path.unlink()
            print(f"Deleted {path}")
        else:
            print("No stored credentials.")
        return 0
    creds = Credentials.load(path)
    if not creds:
        print("No stored credentials.")
        return 1
    from .redaction import mask_secret

    print(f"base_url: {creds.base_url}")
    print(f"model:    {creds.model}")
    print(f"api_key:  {mask_secret(creds.api_key)}")
    print(f"file:     {path}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
