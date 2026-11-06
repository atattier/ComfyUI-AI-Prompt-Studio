"""ComfyUI AI Prompt Studio — custom node package entry point.

The repository root doubles as the ComfyUI custom-node folder.  The Python
backend lives in ``prompt_studio/`` and is also usable standalone (M0);
``comfyui_plugin.py`` wires it into ComfyUI's own HTTP server.

One node class is registered: AIPromptStudioCaption (image → prompt STRING).
Workflows that use it need the plugin installed to reopen; the sidebar
workbench itself remains zero-footprint.
"""

from __future__ import annotations

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS: dict = {}
NODE_DISPLAY_NAME_MAPPINGS: dict = {}

try:
    from comfyui_plugin import register as _register

    _register()
except Exception as exc:  # noqa: BLE001
    # Never take ComfyUI down because the workbench could not start.
    print(f"[ai_prompt_studio] plugin failed to register: {exc}")

try:
    from prompt_studio.caption_node import register as _register_node

    _register_node(NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS)
except Exception as exc:  # noqa: BLE001
    print(f"[ai_prompt_studio] caption node failed to register: {exc}")

__all__ = ["WEB_DIRECTORY", "NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
