"""Shared helpers for the M0 test suite."""

from __future__ import annotations

import json
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from prompt_studio.audit import AuditLogger
from prompt_studio.client import ChatClient
from prompt_studio.config import Settings
from prompt_studio.redaction import Redactor

from tests.mock_upstream import MockUpstream, VALID_KEY


def make_client(
    case: unittest.TestCase,
    *,
    model: str = "vision-pro",
    **overrides: Any,
) -> tuple[MockUpstream, Settings, ChatClient, AuditLogger]:
    mock = MockUpstream()
    mock.__enter__()
    case.addCleanup(mock.__exit__, None, None, None)
    tmp = tempfile.TemporaryDirectory()
    case.addCleanup(tmp.cleanup)
    params: dict[str, Any] = {
        "base_url": mock.base_url,
        "model": model,
        "api_key": VALID_KEY,
        "home": Path(tmp.name),
        "timeout_s": 5.0,
        "max_retries": 2,
        "backoff_s": 0.01,
        "max_backoff_s": 0.02,
    }
    params.update(overrides)
    settings = Settings(**params)
    audit = AuditLogger(settings.audit_path, Redactor([settings.api_key]))
    client = ChatClient(settings, audit=audit)
    return mock, settings, client, audit


def http_json(
    base: str,
    method: str,
    path: str,
    payload: dict[str, Any] | None = None,
    *,
    token: str | None = None,
    timeout: float = 15.0,
) -> tuple[int, dict[str, Any]]:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-Studio-Token"] = token
    request = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            return response.status, json.loads(raw or b"{}")
    except urllib.error.HTTPError as exc:
        try:
            raw = exc.read()
            try:
                body = json.loads(raw or b"{}")
            except ValueError:
                body = {"raw": raw.decode("utf-8", "replace")}
            return exc.code, body
        finally:
            exc.close()


def http_sse(
    base: str,
    path: str,
    payload: dict[str, Any],
    *,
    token: str,
    timeout: float = 15.0,
) -> list[tuple[str, dict[str, Any]]]:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        base + path,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "X-Studio-Token": token,
        },
        method="POST",
    )
    events: list[tuple[str, dict[str, Any]]] = []
    current: str | None = None
    with urllib.request.urlopen(request, timeout=timeout) as response:
        for raw_line in response:
            line = raw_line.decode("utf-8", "replace").rstrip("\r\n")
            if line.startswith("event:"):
                current = line[6:].strip()
            elif line.startswith("data:"):
                body = line[5:].strip()
                events.append((current or "message", json.loads(body)))
    return events
