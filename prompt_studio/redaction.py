"""Secret redaction for logs, error bodies and API responses.

The API key must never reach a log file, an exception message or an HTTP
response.  Redaction works on two levels:

* any known secret value (the configured key) is replaced literally;
* generic bearer tokens and ``sk-`` style keys are caught by pattern, so that
  keys echoed by a misbehaving upstream are scrubbed too.
"""

from __future__ import annotations

import re
from typing import Any, Iterable

_MASK = "***REDACTED***"

_PATTERNS = (
    re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._\-+/=]{6,}"),
    re.compile(r"\bsk-[A-Za-z0-9._\-]{6,}"),
    re.compile(r"\bAIza[0-9A-Za-z_\-]{20,}"),
)


def mask_secret(secret: str | None) -> str:
    """Return a short non-reversible fingerprint for display purposes."""
    if not secret:
        return ""
    if len(secret) < 12:
        return "***"
    return f"{secret[:4]}...{secret[-2:]}"


class Redactor:
    def __init__(self, secrets: Iterable[str] = ()) -> None:
        # Longest first so a secret that contains another is masked whole.
        self._secrets = sorted({s for s in secrets if s and len(s) >= 4}, key=len, reverse=True)

    def __call__(self, text: str) -> str:
        return self.scrub_text(text)

    def scrub_text(self, text: str) -> str:
        if not isinstance(text, str) or not text:
            return text
        out = text
        for secret in self._secrets:
            out = out.replace(secret, _MASK)
        for pattern in _PATTERNS:
            out = pattern.sub(lambda m: (m.group(1) if m.groups() else "") + _MASK, out)
        return out

    def scrub(self, value: Any) -> Any:
        if isinstance(value, str):
            return self.scrub_text(value)
        if isinstance(value, dict):
            return {k: self.scrub(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [self.scrub(v) for v in value]
        return value
