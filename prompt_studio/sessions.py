"""Multi-turn conversation storage (SQLite) and image media store.

Messages are stored as OpenAI-style content (string or list of parts).  Image
bytes are written to a content-addressed media directory and referenced by
SHA-256, so the database stays small and the same image is stored once.  This
also keeps image data out of the audit log.
"""

from __future__ import annotations

import base64
import hashlib
import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from .client import data_url

_MIME_EXT = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
}


class MediaStore:
    def __init__(self, directory: Path, *, max_bytes: int = 8 * 1024 * 1024) -> None:
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.max_bytes = max_bytes

    def put(self, data: bytes, mime: str = "image/png") -> dict[str, Any]:
        if not data:
            raise ValueError("empty image")
        if len(data) > self.max_bytes:
            raise ValueError(f"image exceeds {self.max_bytes} bytes")
        mime = (mime or "image/png").split(";")[0].strip().lower()
        ext = _MIME_EXT.get(mime)
        if ext is None:
            raise ValueError(f"unsupported image type: {mime}")
        digest = hashlib.sha256(data).hexdigest()
        path = self.directory / f"{digest}{ext}"
        if not path.exists():
            tmp = path.with_suffix(ext + ".tmp")
            tmp.write_bytes(data)
            tmp.replace(path)
        return {"type": "image_ref", "sha256": digest, "mime": mime, "bytes": len(data), "ext": ext}

    def path_for(self, ref: dict[str, Any]) -> Path | None:
        digest = ref.get("sha256")
        ext = ref.get("ext") or _MIME_EXT.get(str(ref.get("mime")), "")
        if not digest or not ext:
            return None
        path = self.directory / f"{digest}{ext}"
        return path if path.exists() else None

    def read(self, ref: dict[str, Any]) -> bytes | None:
        path = self.path_for(ref)
        return path.read_bytes() if path else None

    def to_api_part(self, ref: dict[str, Any]) -> dict[str, Any] | None:
        data = self.read(ref)
        if data is None:
            return None
        return {
            "type": "image_url",
            "image_url": {"url": data_url(data, str(ref.get("mime") or "image/png"))},
        }


class SessionStore:
    def __init__(self, path: Path, *, media: MediaStore | None = None) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.media = media or MediaStore(self.path.parent / "media")
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA foreign_keys=ON")
            self._conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    title TEXT,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                    seq INTEGER NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_messages_session
                    ON messages(session_id, seq);
                """
            )
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # ------------------------------------------------------------- sessions
    def create(self, title: str | None = None) -> dict[str, Any]:
        now = time.time()
        session_id = "s_" + uuid.uuid4().hex[:16]
        with self._lock:
            self._conn.execute(
                "INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?,?,?,?)",
                (session_id, title or "新会话", now, now),
            )
            self._conn.commit()
        return {"id": session_id, "title": title or "新会话", "created_at": now, "updated_at": now}

    def get(self, session_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
        return dict(row) if row else None

    def list(self, limit: int = 50) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(r) for r in rows]

    def delete(self, session_id: str) -> bool:
        with self._lock:
            cur = self._conn.execute("DELETE FROM sessions WHERE id=?", (session_id,))
            self._conn.commit()
        return cur.rowcount > 0

    def touch(self, session_id: str, title: str | None = None) -> None:
        with self._lock:
            if title:
                self._conn.execute(
                    "UPDATE sessions SET updated_at=?, title=? WHERE id=?",
                    (time.time(), title[:80], session_id),
                )
            else:
                self._conn.execute(
                    "UPDATE sessions SET updated_at=? WHERE id=?", (time.time(), session_id)
                )
            self._conn.commit()

    # ------------------------------------------------------------- messages
    def append(self, session_id: str, role: str, content: Any) -> dict[str, Any]:
        with self._lock:
            row = self._conn.execute(
                "SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE session_id=?",
                (session_id,),
            ).fetchone()
            seq = int(row["seq"]) + 1
            created = time.time()
            self._conn.execute(
                "INSERT INTO messages (session_id, seq, role, content, created_at) VALUES (?,?,?,?,?)",
                (session_id, seq, role, json.dumps(content, ensure_ascii=False), created),
            )
            self._conn.execute(
                "UPDATE sessions SET updated_at=? WHERE id=?", (created, session_id)
            )
            self._conn.commit()
        return {"seq": seq, "role": role, "content": content, "created_at": created}

    def messages(self, session_id: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT seq, role, content, created_at FROM messages WHERE session_id=? ORDER BY seq",
                (session_id,),
            ).fetchall()
        out = []
        for row in rows:
            try:
                content = json.loads(row["content"])
            except ValueError:
                content = row["content"]
            out.append(
                {
                    "seq": row["seq"],
                    "role": row["role"],
                    "content": content,
                    "created_at": row["created_at"],
                }
            )
        return out

    def messages_for_api(self, session_id: str) -> list[dict[str, Any]]:
        """History with image refs resolved back to data URLs."""
        out: list[dict[str, Any]] = []
        for message in self.messages(session_id):
            content = message["content"]
            if isinstance(content, list):
                resolved = []
                for part in content:
                    if isinstance(part, dict) and part.get("type") == "image_ref":
                        api_part = self.media.to_api_part(part)
                        if api_part is not None:
                            resolved.append(api_part)
                    elif isinstance(part, dict):
                        resolved.append(part)
                content = resolved
            out.append({"role": message["role"], "content": content})
        return out

    def message_count(self, session_id: str) -> int:
        with self._lock:
            row = self._conn.execute(
                "SELECT COUNT(*) AS n FROM messages WHERE session_id=?", (session_id,)
            ).fetchone()
        return int(row["n"])


def decode_data_url(url: str) -> tuple[bytes, str]:
    """Decode ``data:image/png;base64,...`` into (bytes, mime)."""
    if not url.startswith("data:"):
        raise ValueError("not a data URL")
    header, _, encoded = url[5:].partition(",")
    if ";base64" not in header:
        raise ValueError("only base64 data URLs are supported")
    mime = header.split(";")[0] or "image/png"
    try:
        data = base64.b64decode(encoded, validate=True)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("invalid base64 image data") from exc
    return data, mime
