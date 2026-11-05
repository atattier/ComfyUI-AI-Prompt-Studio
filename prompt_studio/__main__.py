"""Command line entry point for the M0 prototype (no UI)."""

from __future__ import annotations

import argparse
import json
import sys

from . import __version__
from .capabilities import CapabilityProber
from .client import ChatClient
from .config import load_settings
from .credentials import main as credentials_main
from .errors import StudioError
from .server import serve
from .sessions import MediaStore, SessionStore


def _client(args: argparse.Namespace) -> ChatClient:
    settings = load_settings()
    return ChatClient(settings)


def cmd_serve(args: argparse.Namespace) -> int:
    settings = load_settings()
    if args.port:
        settings.port = args.port
    if args.host:
        settings.host = args.host
        settings.ensure_local_bind()
    serve(settings)
    return 0


def cmd_probe(args: argparse.Namespace) -> int:
    client = _client(args)
    report = CapabilityProber(client).probe(model=args.model, force=args.force)
    print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
    return 0


def cmd_chat(args: argparse.Namespace) -> int:
    settings = load_settings()
    client = ChatClient(settings, audit=None)
    messages = [{"role": "user", "content": args.message}]
    if args.session:
        store = SessionStore(settings.db_path, media=MediaStore(settings.media_dir))
        store.append(args.session, "user", args.message)
        messages = store.messages_for_api(args.session)
    try:
        if args.no_stream:
            result = client.complete(messages, model=args.model)
            print(result.text)
        else:
            final = None
            for event in client.stream_chat(messages, model=args.model):
                if event.type == "delta":
                    sys.stdout.write(event.text)
                    sys.stdout.flush()
                elif event.type == "done":
                    final = event
            print()
            if final is None:
                print("No response.", file=sys.stderr)
                return 1
        if args.session:
            text = result.text if args.no_stream else final.text
            store.append(args.session, "assistant", text)
    except StudioError as err:
        print(json.dumps(err.to_dict(), ensure_ascii=False, indent=2), file=sys.stderr)
        return 2
    return 0


def cmd_config(args: argparse.Namespace) -> int:
    settings = load_settings()
    print(json.dumps(settings.public_dict(), ensure_ascii=False, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="prompt_studio", description=f"ComfyUI AI Prompt Studio M0 ({__version__})")
    sub = parser.add_subparsers(dest="command", required=True)

    p_serve = sub.add_parser("serve", help="run the local backend API")
    p_serve.add_argument("--host")
    p_serve.add_argument("--port", type=int)
    p_serve.set_defaults(func=cmd_serve)

    p_probe = sub.add_parser("probe", help="probe text / vision / streaming capabilities")
    p_probe.add_argument("--model")
    p_probe.add_argument("--force", action="store_true")
    p_probe.set_defaults(func=cmd_probe)

    p_chat = sub.add_parser("chat", help="send one message (stdout only, no UI)")
    p_chat.add_argument("message")
    p_chat.add_argument("--model")
    p_chat.add_argument("--session")
    p_chat.add_argument("--no-stream", action="store_true")
    p_chat.set_defaults(func=cmd_chat)

    p_config = sub.add_parser("config", help="show configuration (key masked)")
    p_config.set_defaults(func=cmd_config)

    p_creds = sub.add_parser("creds", help="manage stored credentials")
    p_creds.add_argument("action", nargs="*", default=["show"])
    p_creds.set_defaults(func=lambda args: credentials_main(args.action))

    args = parser.parse_args(argv)
    try:
        return int(args.func(args) or 0)
    except StudioError as err:
        print(json.dumps(err.to_dict(), ensure_ascii=False, indent=2), file=sys.stderr)
        return 2


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
