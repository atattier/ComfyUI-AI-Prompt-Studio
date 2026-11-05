"""ComfyUI AI Prompt Studio — M0 unified multimodal API prototype.

This package is deliberately independent of ComfyUI: it can be imported and
exercised without installing anything into ComfyUI or touching existing
workflows.  M0 covers configuration, text/vision/streaming calls, multi-turn
sessions, capability probing, retries, key custody and auditing.
"""

from __future__ import annotations

__version__ = "0.1.0-m0"

from .capabilities import CapabilityProber, CapabilityReport  # noqa: E402
from .client import ChatClient, ChatResult, StreamEvent  # noqa: E402
from .config import Settings, load_settings  # noqa: E402
from .server import Service, create_server  # noqa: E402

__all__ = [
    "__version__",
    "CapabilityProber",
    "CapabilityReport",
    "ChatClient",
    "ChatResult",
    "StreamEvent",
    "Settings",
    "load_settings",
    "Service",
    "create_server",
]
