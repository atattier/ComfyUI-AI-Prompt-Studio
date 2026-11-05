"""Local UI harness: serve the real workbench against a mock model.

This is a development tool only.  It does not install anything into ComfyUI;
it mimics the small part of ComfyUI the sidebar tab uses (a static page, a stub
``/scripts/app.js`` and a fake canvas) and wires the workbench routes to
``tests.mock_upstream`` so the whole M1 loop can be exercised in a browser
without spending real API calls or touching a workflow.

    python scripts/dev_harness.py --port 8199 --model demo-model

Then open http://127.0.0.1:8199/.
"""

from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path

from aiohttp import web

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from prompt_studio.aiohttp_api import StudioBackend, make_routes  # noqa: E402
from prompt_studio.config import Settings  # noqa: E402
from prompt_studio.png import make_split_probe_png  # noqa: E402
from tests.mock_upstream import VALID_KEY, MockUpstream  # noqa: E402

DEV_DIR = ROOT / "dev"
WEB_DIR = ROOT / "web"
EXTENSION_NAME = "ComfyUI-AI-Prompt-Studio"


def build_app(backend: StudioBackend, mock: MockUpstream) -> web.Application:
    app = web.Application(client_max_size=25 * 1024 * 1024)

    async def index(_request: web.Request) -> web.FileResponse:
        return web.FileResponse(DEV_DIR / "harness.html")

    async def app_js(_request: web.Request) -> web.FileResponse:
        return web.FileResponse(DEV_DIR / "app_stub.js", headers={"Content-Type": "text/javascript"})

    async def preview(_request: web.Request) -> web.Response:
        return web.Response(body=make_split_probe_png(160), content_type="image/png")

    async def health(_request: web.Request) -> web.Response:
        return web.json_response(
            {"ok": True, "upstream": mock.base_url, "requests": len(mock.state.requests)}
        )

    app.router.add_get("/", index)
    app.router.add_get("/scripts/app.js", app_js)
    app.router.add_get("/view", preview)
    app.router.add_get("/harness/health", health)
    app.router.add_static(f"/extensions/{EXTENSION_NAME}", WEB_DIR)
    app.add_routes(make_routes(backend))
    return app


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8199)
    parser.add_argument("--model", default="demo-model", help="mock upstream model to expose")
    parser.add_argument("--home", default="", help="runtime data directory (default: a temp dir)")
    args = parser.parse_args(argv)

    mock = MockUpstream()
    mock.__enter__()
    home = Path(args.home) if args.home else Path(tempfile.mkdtemp(prefix="aps-harness-"))
    settings = Settings(
        base_url=mock.base_url,
        model=args.model,
        api_key=VALID_KEY,
        home=home,
        timeout_s=30.0,
        max_retries=1,
        backoff_s=0.05,
    )
    backend = StudioBackend(settings)
    app = build_app(backend, mock)

    print(f"UI harness        http://127.0.0.1:{args.port}/")
    print(f"mock upstream     {mock.base_url} (model={args.model})")
    print(f"runtime home      {home}")
    try:
        web.run_app(app, host="127.0.0.1", port=args.port, print=None)
    finally:
        backend.close()
        mock.__exit__(None, None, None)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
