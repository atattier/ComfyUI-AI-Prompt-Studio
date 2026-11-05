"""Windows Credential Manager storage for the API key (M1).

Uses ``advapi32`` through ctypes; no third-party package.  On non-Windows, or
if the API is unavailable, callers fall back to the M0 credential file.

The secret is stored as a generic credential whose target name is prefixed by
``comfyui-ai-prompt-studio/``.  Only the API key goes here; Base URL and model
stay in a plain JSON file because they are not secrets.
"""

from __future__ import annotations

import ctypes
import os
import sys
from ctypes import wintypes

CRED_TYPE_GENERIC = 1
CRED_PERSIST_LOCAL_MACHINE = 2

TARGET_PREFIX = "comfyui-ai-prompt-studio/"


class _FILETIME(ctypes.Structure):
    _fields_ = [("dwLowDateTime", wintypes.DWORD), ("dwHighDateTime", wintypes.DWORD)]


class _CREDENTIALW(ctypes.Structure):
    _fields_ = [
        ("Flags", wintypes.DWORD),
        ("Type", wintypes.DWORD),
        ("TargetName", wintypes.LPWSTR),
        ("Comment", wintypes.LPWSTR),
        ("LastWritten", _FILETIME),
        ("CredentialBlobSize", wintypes.DWORD),
        ("CredentialBlob", ctypes.POINTER(ctypes.c_byte)),
        ("Persist", wintypes.DWORD),
        ("AttributeCount", wintypes.DWORD),
        ("Attributes", ctypes.c_void_p),
        ("TargetAlias", wintypes.LPWSTR),
        ("UserName", wintypes.LPWSTR),
    ]


_PCREDENTIALW = ctypes.POINTER(_CREDENTIALW)


def available() -> bool:
    return sys.platform == "win32" and hasattr(ctypes, "windll")


def _advapi():
    return ctypes.windll.advapi32


def _target(target: str | None) -> str:
    return TARGET_PREFIX + (target or "default")


def write(secret: str, *, target: str | None = None, username: str = "api-key") -> bool:
    if not available():
        return False
    if not secret:
        raise ValueError("secret must not be empty")
    blob = secret.encode("utf-16-le")
    buffer = ctypes.create_string_buffer(blob, len(blob))
    cred = _CREDENTIALW()
    cred.Flags = 0
    cred.Type = CRED_TYPE_GENERIC
    cred.TargetName = _target(target)
    cred.Comment = "ComfyUI AI Prompt Studio API key"
    cred.CredentialBlobSize = len(blob)
    cred.CredentialBlob = ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte))
    cred.Persist = CRED_PERSIST_LOCAL_MACHINE
    cred.AttributeCount = 0
    cred.Attributes = None
    cred.TargetAlias = None
    cred.UserName = username
    ok = _advapi().CredWriteW(ctypes.byref(cred), 0)
    return bool(ok)


def read(*, target: str | None = None) -> str | None:
    if not available():
        return None
    pointer = _PCREDENTIALW()
    ok = _advapi().CredReadW(_target(target), CRED_TYPE_GENERIC, 0, ctypes.byref(pointer))
    if not ok:
        return None
    try:
        cred = pointer.contents
        size = int(cred.CredentialBlobSize)
        if size <= 0:
            return None
        raw = ctypes.string_at(cred.CredentialBlob, size)
        return raw.decode("utf-16-le", "ignore")
    finally:
        _advapi().CredFree(pointer)


def delete(*, target: str | None = None) -> bool:
    if not available():
        return False
    return bool(_advapi().CredDeleteW(_target(target), CRED_TYPE_GENERIC, 0))


def backend_name() -> str:
    return "windows-credential-manager" if available() else "file"
