"""Structured audit log (JSON Lines).

Only metadata is recorded: no prompt text, no image bytes, no headers, no API
key.  Every field passes through the redactor as a second line of defence.
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any

from .redaction import Redactor


class AuditLogger:
    def __init__(self, path: Path, redactor: Redactor | None = None, enabled: bool = True) -> None:
        self.path = Path(path)
        self.redactor = redactor or Redactor()
        self.enabled = enabled
        self._lock = threading.Lock()
        if self.enabled:
            self.path.parent.mkdir(parents=True, exist_ok=True)

    def log(self, event: str, **fields: Any) -> dict[str, Any]:
        record: dict[str, Any] = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "ts_unix": round(time.time(), 3),
            "pid": os.getpid(),
            "event": event,
        }
        for key, value in fields.items():
            if value is not None:
                record[key] = value
        record = self.redactor.scrub(record)
        if not self.enabled:
            return record
        line = json.dumps(record, ensure_ascii=False, default=str)
        with self._lock:
            with open(self.path, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        return record

    def tail(self, limit: int = 50) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        with self._lock:
            lines = self.path.read_text(encoding="utf-8").splitlines()
        out: list[dict[str, Any]] = []
        for line in lines[-limit:]:
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
        return out
