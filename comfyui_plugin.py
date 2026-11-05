"""ComfyUI bootstrap for ComfyUI AI Prompt Studio (M1).

This module is imported by the custom-node loader.  It registers the backend
routes on ComfyUI's own aiohttp server and never starts a second listener.
If the backend cannot be configured (no credentials yet), the routes are still
registered and answer with a clear configuration error so the panel can explain
what to do instead of failing silently.
"""

from __future__ import annotations

import os
import sys
import traceback

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from prompt_studio.aiohttp_api import StudioBackend, install_routes  # noqa: E402

_BACKEND: StudioBackend | None = None
_BACKEND_ERROR: BaseException | None = None


def get_backend() -> StudioBackend | None:
    global _BACKEND, _BACKEND_ERROR
    if _BACKEND is None and _BACKEND_ERROR is None:
        try:
            _BACKEND = StudioBackend()
            print(
                "[ai_prompt_studio] backend ready: "
                f"{_BACKEND.settings.base_url} · {_BACKEND.settings.model}"
            )
        except Exception as exc:  # noqa: BLE001
            _BACKEND_ERROR = exc
            print(f"[ai_prompt_studio] backend not configured: {exc}")
    return _BACKEND


def register() -> bool:
    try:
        from server import PromptServer  # type: ignore
    except Exception as exc:  # noqa: BLE001
        print(f"[ai_prompt_studio] ComfyUI PromptServer unavailable, routes not registered: {exc}")
        return False

    routes = PromptServer.instance.routes
    if any(getattr(route, "path", "") == "/ai_prompt_studio/health" for route in routes):
        print("[ai_prompt_studio] routes already registered, skipping")
        return True

    backend = get_backend()
    if backend is None and _BACKEND_ERROR is not None:
        traceback.print_exception(type(_BACKEND_ERROR), _BACKEND_ERROR, _BACKEND_ERROR.__traceback__)
    install_routes(routes, backend)
    print("[ai_prompt_studio] routes registered at /ai_prompt_studio/*")
    return True


__all__ = ["get_backend", "register"]
