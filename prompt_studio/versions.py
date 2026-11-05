"""Prompt version history (snapshots) stored in SQLite.

A snapshot is written *before* an edit is applied (so it can always be
restored) and after a restore/undo.  Snapshots are keyed by a target string
built by the frontend from the workflow title, node id and widget name.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any


class VersionStore:
    def __init__(self, path: Path, *, keep_per_target: int = 100) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.keep_per_target = keep_per_target
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS prompt_versions (
                    id TEXT PRIMARY KEY,
                    target TEXT NOT NULL,
                    text TEXT NOT NULL,
                    source TEXT NOT NULL,
                    label TEXT,
                    meta TEXT,
                    created_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_versions_target
                    ON prompt_versions(target, created_at DESC);
                """
            )
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def add(
        self,
        target: str,
        text: str,
        *,
        source: str = "apply",
        label: str | None = None,
        meta: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        target = (target or "").strip()
        if not target:
            raise ValueError("target is required")
        if not isinstance(text, str):
            raise ValueError("text must be a string")
        version_id = "v_" + uuid.uuid4().hex[:16]
        created = time.time()
        with self._lock:
            self._conn.execute(
                "INSERT INTO prompt_versions (id, target, text, source, label, meta, created_at)"
                " VALUES (?,?,?,?,?,?,?)",
                (
                    version_id,
                    target[:300],
                    text,
                    source[:40],
                    (label or "")[:200] or None,
                    json.dumps(meta, ensure_ascii=False) if meta else None,
                    created,
                ),
            )
            self._conn.commit()
            self._prune(target)
        return {
            "id": version_id,
            "target": target,
            "text": text,
            "source": source,
            "label": label,
            "meta": meta,
            "created_at": created,
        }

    def _prune(self, target: str) -> None:
        rows = self._conn.execute(
            "SELECT id FROM prompt_versions WHERE target=? ORDER BY created_at DESC",
            (target,),
        ).fetchall()
        if len(rows) <= self.keep_per_target:
            return
        drop = [row["id"] for row in rows[self.keep_per_target :]]
        placeholders = ",".join("?" for _ in drop)
        self._conn.execute(f"DELETE FROM prompt_versions WHERE id IN ({placeholders})", drop)
        self._conn.commit()

    def list(self, target: str, *, limit: int = 50) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, target, source, label, meta, created_at, text"
                " FROM prompt_versions WHERE target=? ORDER BY created_at DESC LIMIT ?",
                (target, max(1, int(limit))),
            ).fetchall()
        return [self._row(row) for row in rows]

    def get(self, version_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT id, target, source, label, meta, created_at, text"
                " FROM prompt_versions WHERE id=?",
                (version_id,),
            ).fetchone()
        return self._row(row) if row else None

    def latest(self, target: str) -> dict[str, Any] | None:
        items = self.list(target, limit=1)
        return items[0] if items else None

    @staticmethod
    def _row(row: sqlite3.Row) -> dict[str, Any]:
        meta = row["meta"]
        try:
            meta = json.loads(meta) if meta else None
        except ValueError:
            meta = None
        return {
            "id": row["id"],
            "target": row["target"],
            "text": row["text"],
            "source": row["source"],
            "label": row["label"],
            "meta": meta,
            "created_at": row["created_at"],
            "text_chars": len(row["text"] or ""),
        }
