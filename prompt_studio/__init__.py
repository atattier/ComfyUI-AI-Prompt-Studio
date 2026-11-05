"""ComfyUI AI Prompt Studio — unified multimodal workbench for ComfyUI.

M0 covered the independent API prototype (configuration, text/vision/streaming
calls, multi-turn sessions, capability probing, retries, key custody and
auditing).  M1 adds the in-ComfyUI workbench: sidebar tab, node prompt
read/write, caption, validated diff, apply, undo and version history.

The core stays independent of ComfyUI: it can be imported and exercised
without installing anything or touching existing workflows.
"""

from __future__ import annotations

__version__ = "0.2.0-m1"

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
