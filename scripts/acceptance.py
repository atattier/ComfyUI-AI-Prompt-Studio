"""M0 acceptance runner.

Two independent passes:

* ``mock`` — deterministic protocol conformance against a local OpenAI-compatible
  server implemented in ``tests/mock_upstream.py``.  Covers all nine acceptance
  items, including failures that must never be induced against a shared gateway
  (wrong key, timeout, mid-stream drop).
* ``live`` — the same client against the configured real endpoint, covering
  text, image, streaming, multi-turn context, text-only detection and key
  leakage.

Usage::

    python scripts/acceptance.py --mode both
    PROMPT_STUDIO_BASE_URL=... PROMPT_STUDIO_API_KEY=... PROMPT_STUDIO_MODEL=... \
        python scripts/acceptance.py --mode live

Output: ``evidence/acceptance-<mode>-<timestamp>.{json,md}`` plus a summary on
stdout.  Nothing is written into ComfyUI.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from prompt_studio.audit import AuditLogger  # noqa: E402
from prompt_studio.capabilities import CapabilityProber  # noqa: E402
from prompt_studio.client import ChatClient, data_url, image_part_from_bytes  # noqa: E402
from prompt_studio.config import Settings, load_settings  # noqa: E402
from prompt_studio.errors import (  # noqa: E402
    AuthError,
    NetworkError,
    StreamInterruptedError,
    StudioError,
    UpstreamTimeoutError,
)
from prompt_studio.png import make_split_probe_png  # noqa: E402
from prompt_studio.sessions import MediaStore, SessionStore  # noqa: E402

try:
    from tests.mock_upstream import BAD_KEY, VALID_KEY, MockUpstream
except ImportError:  # pragma: no cover
    sys.path.insert(0, str(ROOT / "tests"))
    from mock_upstream import BAD_KEY, VALID_KEY, MockUpstream  # type: ignore


@dataclass
class Check:
    id: str
    name: str
    status: str  # pass | fail | skip
    detail: str
    data: dict[str, Any] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.status != "fail"


@dataclass
class RunReport:
    mode: str
    started_at: str
    ended_at: str = ""
    base_url: str = ""
    model: str = ""
    checks: list[Check] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def add(self, check: Check) -> None:
        self.checks.append(check)

    def summary(self) -> dict[str, int]:
        out = {"pass": 0, "fail": 0, "skip": 0}
        for check in self.checks:
            out[check.status] += 1
        return out


def _settings(mock: MockUpstream | None, home: Path, **overrides: Any) -> Settings:
    params: dict[str, Any] = {
        "base_url": mock.base_url if mock else "",
        "model": "vision-pro" if mock else "",
        "api_key": VALID_KEY if mock else "",
        "home": home,
        "timeout_s": 20.0,
        "max_retries": 1,
        "backoff_s": 0.02,
        "max_backoff_s": 0.05,
    }
    params.update(overrides)
    return Settings(**params)


def _scan_for_secret(secret: str, text: str) -> bool:
    return bool(secret) and secret in text


# --------------------------------------------------------------------- mock
def run_mock() -> RunReport:
    report = RunReport(mode="mock", started_at=_now())
    with MockUpstream() as mock:
        tmp = tempfile.TemporaryDirectory()
        home = Path(tmp.name)
        settings = _settings(mock, home, model="vision-pro")
        audit = AuditLogger(settings.audit_path)
        client = ChatClient(settings, audit=audit)
        captured: list[str] = []

        # 1. text
        try:
            result = client.complete(
                [{"role": "user", "content": "Reply with the single word OK."}], temperature=0
            )
            captured.append(result.text)
            ok = result.text.strip() == "OK"
            report.add(
                Check("text", "文本调用", "pass" if ok else "fail", f"reply={result.text!r} latency={result.latency_ms}ms",
                      {"reply": result.text, "latency_ms": result.latency_ms, "usage": result.usage})
            )
        except StudioError as err:
            report.add(Check("text", "文本调用", "fail", f"{err.code}: {err.message}", err.to_dict()))

        # 2. image
        try:
            png = make_split_probe_png(64)
            result = client.complete(
                [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "Name both colours from left to right."},
                            image_part_from_bytes(png),
                        ],
                    }
                ],
                temperature=0,
            )
            captured.append(result.text)
            ok = "red" in result.text.lower() and "blue" in result.text.lower()
            report.add(
                Check("image", "图片输入与视觉理解", "pass" if ok else "fail", f"reply={result.text!r}",
                      {"reply": result.text, "image_bytes": len(png), "data_url_prefix": data_url(png)[:32]})
            )
        except StudioError as err:
            report.add(Check("image", "图片输入与视觉理解", "fail", f"{err.code}: {err.message}", err.to_dict()))

        # 3. streaming
        try:
            deltas: list[str] = []
            final = None
            for event in client.stream_chat(
                [{"role": "user", "content": "hello there"}], model="echo-model", temperature=0
            ):
                if event.type == "delta":
                    deltas.append(event.text)
                elif event.type == "done":
                    final = event
            ok = final is not None and final.chunks >= 2 and final.saw_done and "".join(deltas) == final.text
            report.add(
                Check(
                    "streaming",
                    "流式响应",
                    "pass" if ok else "fail",
                    f"chunks={getattr(final, 'chunks', 0)} ttft_ms={getattr(final, 'ttft_ms', None)} "
                    f"saw_done={getattr(final, 'saw_done', None)}",
                    {
                        "chunks": getattr(final, "chunks", 0),
                        "ttft_ms": getattr(final, "ttft_ms", None),
                        "saw_done": getattr(final, "saw_done", None),
                        "text": getattr(final, "text", ""),
                        "usage": getattr(final, "usage", None),
                    },
                )
            )
        except StudioError as err:
            report.add(Check("streaming", "流式响应", "fail", f"{err.code}: {err.message}", err.to_dict()))

        # 4. multi-turn
        try:
            store = SessionStore(home / "sessions.sqlite3", media=MediaStore(home / "media"))
            session = store.create("acceptance")
            store.append(session["id"], "user", "remember 47")
            reply1 = client.complete(store.messages_for_api(session["id"]), model="echo-model").text
            store.append(session["id"], "assistant", reply1)
            store.append(session["id"], "user", "what number?")
            reply2 = client.complete(store.messages_for_api(session["id"]), model="echo-model").text
            store.close()
            captured.extend([reply1, reply2])
            ok = "user:remember 47" in reply2 and "assistant:" in reply2 and "turns=3" in reply2
            report.add(
                Check("multiturn", "多轮上下文", "pass" if ok else "fail", f"second reply={reply2[:160]!r}",
                      {"reply1": reply1, "reply2": reply2})
            )
        except StudioError as err:
            report.add(Check("multiturn", "多轮上下文", "fail", f"{err.code}: {err.message}", err.to_dict()))

        # 5. vision-unsupported detection
        try:
            text_settings = _settings(mock, home, model="text-only")
            text_client = ChatClient(text_settings, audit=AuditLogger(text_settings.audit_path))
            probe = CapabilityProber(text_client).probe()
            ok = probe.text and probe.vision is False
            report.add(
                Check(
                    "vision_unsupported",
                    "不支持视觉的模型识别",
                    "pass" if ok else "fail",
                    f"vision={probe.vision} reason={probe.details.get('vision', {}).get('reason')}",
                    probe.to_dict(),
                )
            )
        except StudioError as err:
            report.add(Check("vision_unsupported", "不支持视觉的模型识别", "fail", f"{err.code}: {err.message}", err.to_dict()))

        # 6. wrong key
        try:
            bad_settings = _settings(mock, home, api_key=BAD_KEY)
            bad_client = ChatClient(bad_settings, audit=AuditLogger(bad_settings.audit_path))
            bad_client.complete([{"role": "user", "content": "hello"}])
            report.add(Check("bad_key", "错误 API Key 处理", "fail", "request unexpectedly succeeded"))
        except AuthError as err:
            payload = err.to_dict()
            captured.append(json.dumps(payload, ensure_ascii=False))
            ok = err.http_status == 401 and not _scan_for_secret(BAD_KEY, json.dumps(payload, ensure_ascii=False))
            report.add(
                Check("bad_key", "错误 API Key 处理", "pass" if ok else "fail",
                      f"code={err.code} status={err.http_status} attempts={err.attempts}",
                      {"error": payload, "key_echoed": _scan_for_secret(BAD_KEY, json.dumps(payload))})
            )
        except StudioError as err:
            report.add(Check("bad_key", "错误 API Key 处理", "fail", f"unexpected {err.code}: {err.message}", err.to_dict()))

        # 7. timeout
        try:
            slow_settings = _settings(mock, home, model="slow-model", timeout_s=0.5, max_retries=0)
            slow_client = ChatClient(slow_settings, audit=AuditLogger(slow_settings.audit_path))
            started = time.perf_counter()
            slow_client.complete([{"role": "user", "content": "hello"}])
            report.add(Check("timeout", "超时错误反馈", "fail", "request unexpectedly succeeded"))
        except UpstreamTimeoutError as err:
            elapsed_ms = int((time.perf_counter() - started) * 1000)
            payload = err.to_dict()
            captured.append(json.dumps(payload, ensure_ascii=False))
            ok = "0.5s" in err.message and elapsed_ms < 3000 and err.retryable
            report.add(
                Check("timeout", "超时错误反馈", "pass" if ok else "fail",
                      f"{err.message} (elapsed {elapsed_ms}ms, retryable={err.retryable})", payload)
            )
        except StudioError as err:
            report.add(Check("timeout", "超时错误反馈", "fail", f"unexpected {err.code}: {err.message}", err.to_dict()))

        # 8. mid-stream interruption
        try:
            drop_settings = _settings(mock, home, model="drop-model", max_retries=0)
            drop_client = ChatClient(drop_settings, audit=AuditLogger(drop_settings.audit_path))
            for _event in drop_client.stream_chat([{"role": "user", "content": "hello"}]):
                pass
            report.add(Check("interrupted", "网络/流中断反馈", "fail", "stream unexpectedly completed"))
        except StreamInterruptedError as err:
            payload = err.to_dict()
            captured.append(json.dumps(payload, ensure_ascii=False))
            ok = err.code == "stream_interrupted" and err.partial_text.strip() == "partial"
            report.add(
                Check("interrupted", "网络/流中断反馈", "pass" if ok else "fail",
                      f"{err.message} partial={err.partial_text!r}", payload)
            )
        except StudioError as err:
            report.add(Check("interrupted", "网络/流中断反馈", "fail", f"unexpected {err.code}: {err.message}", err.to_dict()))

        # 9. key leakage across every audit file and captured payload
        blob_parts = [settings.audit_path.read_text(encoding="utf-8") if settings.audit_path.exists() else ""]
        for path in home.glob("*/audit.jsonl"):
            blob_parts.append(path.read_text(encoding="utf-8"))
        blob = "\n".join(blob_parts + captured + [json.dumps(settings.public_dict(), ensure_ascii=False)])
        leaked = _scan_for_secret(VALID_KEY, blob)
        audit_entries = sum(
            1 for line in "\n".join(blob_parts).splitlines() if line.strip()
        )
        report.add(
            Check("key_leak", "API Key 不泄露", "fail" if leaked else "pass",
                  f"scanned {audit_entries} audit lines + {len(captured)} payloads; key_found={leaked}",
                  {"audit_entries": audit_entries, "payloads_scanned": len(captured), "key_found": leaked})
        )

        # 10. network failure (peer accepts then closes)
        try:
            import socket
            import threading

            listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            port = listener.getsockname()[1]

            def close_immediately() -> None:
                try:
                    conn, _ = listener.accept()
                    conn.close()
                except OSError:
                    pass

            thread = threading.Thread(target=close_immediately, daemon=True)
            thread.start()
            net_settings = _settings(mock, home, base_url=f"http://127.0.0.1:{port}", timeout_s=3, max_retries=0)
            net_client = ChatClient(net_settings, audit=AuditLogger(net_settings.audit_path))
            try:
                net_client.complete([{"role": "user", "content": "hello"}])
                report.add(Check("network", "网络中断反馈", "fail", "request unexpectedly succeeded"))
            finally:
                thread.join(timeout=2)
                listener.close()
        except NetworkError as err:
            report.add(Check("network", "网络中断反馈", "pass", err.message, err.to_dict()))
        except StudioError as err:
            report.add(Check("network", "网络中断反馈", "fail", f"unexpected {err.code}: {err.message}", err.to_dict()))

        tmp.cleanup()
        report.base_url = mock.base_url
        report.model = "vision-pro / text-only / echo-model / slow-model / drop-model"
    report.ended_at = _now()
    report.notes.append("本地协议一致性上游由 tests/mock_upstream.py 提供；视觉回复由真实 PNG 像素解码得出。")
    return report


# --------------------------------------------------------------------- live
def run_live(
    *,
    vision_models: list[str] | None = None,
    text_models: list[str] | None = None,
) -> RunReport:
    settings = load_settings()
    report = RunReport(
        mode="live",
        started_at=_now(),
        base_url=settings.base_url,
        model=settings.model,
    )
    audit = AuditLogger(settings.audit_path)
    client = ChatClient(settings, audit=audit)
    captured: list[str] = []

    # The configured model is the product contract: one model for every task.
    # Extra candidates are only probed when explicitly requested on the CLI.
    vision_models = vision_models or [settings.model]
    text_models = text_models or []

    # Choose a vision-capable model from the candidates (the configured one first).
    chosen = None
    probe_details: list[dict[str, Any]] = []
    for model in vision_models:
        try:
            probe = CapabilityProber(client).probe(model=model, force=True)
        except StudioError as err:
            probe_details.append({"model": model, "error": err.code, "message": err.message})
            continue
        probe_details.append({"model": model, "report": probe.to_dict()})
        if probe.text and probe.vision and probe.streaming:
            chosen = (model, probe)
            break

    if chosen is None:
        report.add(
            Check("model_selection", "选择可用多模态模型", "fail",
                  "no candidate passed text+vision+streaming probe", {"probes": probe_details})
        )
        report.ended_at = _now()
        return report

    model, probe = chosen
    report.model = model
    report.add(
        Check("model_selection", "选择可用多模态模型", "pass",
              f"{model}: text={probe.text} vision={probe.vision} streaming={probe.streaming}",
              probe.to_dict())
    )

    # 1. text
    try:
        result = client.complete(
            [{"role": "user", "content": "Reply with the single word OK."}],
            model=model, temperature=0, max_tokens=128, timeout=60,
        )
        captured.append(result.text)
        ok = "OK" in result.text.upper()
        report.add(Check("text", "文本调用", "pass" if ok else "fail",
                         f"reply={result.text[:80]!r} latency={result.latency_ms}ms",
                         {"reply": result.text[:200], "latency_ms": result.latency_ms,
                          "usage": result.usage, "attempts": result.attempts}))
    except StudioError as err:
        report.add(Check("text", "文本调用", "fail", f"{err.code}: {err.message}", err.to_dict()))

    # 2. image (independent of the probe)
    try:
        png = make_split_probe_png(64)
        result = client.complete(
            [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "This image has two solid colours, left and right. Name both colours."},
                        image_part_from_bytes(png),
                    ],
                }
            ],
            model=model, temperature=0, max_tokens=128, timeout=90,
        )
        captured.append(result.text)
        lower = result.text.lower()
        ok = any(c in lower for c in ("red", "红", "crimson")) and any(c in lower for c in ("blue", "蓝", "navy"))
        report.add(Check("image", "图片输入与视觉理解", "pass" if ok else "fail",
                         f"reply={result.text[:120]!r}",
                         {"reply": result.text[:300], "latency_ms": result.latency_ms}))
    except StudioError as err:
        report.add(Check("image", "图片输入与视觉理解", "fail", f"{err.code}: {err.message}", err.to_dict()))

    # 3. streaming
    try:
        deltas: list[str] = []
        final = None
        for event in client.stream_chat(
            [
                {
                    "role": "user",
                    "content": (
                        "Write one short paragraph of about 80 words describing rain "
                        "on a city street at night."
                    ),
                }
            ],
            model=model, temperature=0.3, max_tokens=300, timeout=90,
        ):
            if event.type == "delta":
                deltas.append(event.text)
            elif event.type == "done":
                final = event
        ok = final is not None and final.chunks >= 2 and bool(final.text.strip())
        report.add(Check("streaming", "流式响应", "pass" if ok else "fail",
                         f"chunks={getattr(final, 'chunks', 0)} ttft_ms={getattr(final, 'ttft_ms', None)} "
                         f"stream_ignored={getattr(final, 'stream_ignored', None)}",
                         {"chunks": getattr(final, "chunks", 0), "ttft_ms": getattr(final, "ttft_ms", None),
                          "saw_done": getattr(final, "saw_done", None),
                          "stream_ignored": getattr(final, "stream_ignored", None),
                          "text": getattr(final, "text", "")[:300],
                          "usage": getattr(final, "usage", None)}))
    except StudioError as err:
        report.add(Check("streaming", "流式响应", "fail", f"{err.code}: {err.message}", err.to_dict()))

    # 4. multi-turn with the configured model
    try:
        store = SessionStore(settings.db_path, media=MediaStore(settings.media_dir))
        session = store.create("acceptance-live")
        store.append(session["id"], "user", "Please remember the number 47. Reply with OK.")
        first = client.complete(store.messages_for_api(session["id"]), model=model,
                                temperature=0, max_tokens=32, timeout=90).text
        store.append(session["id"], "assistant", first)
        store.append(session["id"], "user", "Which number did I ask you to remember? Reply with digits only.")
        second = client.complete(store.messages_for_api(session["id"]), model=model,
                                 temperature=0, max_tokens=32, timeout=90).text
        store.close()
        captured.extend([first, second])
        ok = "47" in second
        report.add(Check("multiturn", "多轮上下文", "pass" if ok else "fail",
                         f"first={first[:60]!r} second={second[:60]!r}",
                         {"first": first[:200], "second": second[:200]}))
    except StudioError as err:
        report.add(Check("multiturn", "多轮上下文", "fail", f"{err.code}: {err.message}", err.to_dict()))

    # 5. text-only model detection (only with --text-model; otherwise the mock
    #    pass carries this requirement)
    found = None
    attempts: list[dict[str, Any]] = []
    for candidate in text_models:
        try:
            candidate_probe = CapabilityProber(client).probe(model=candidate, force=True)
        except StudioError as err:
            attempts.append({"model": candidate, "error": err.code, "message": err.message})
            continue
        attempts.append({"model": candidate, "report": candidate_probe.to_dict()})
        if candidate_probe.text and candidate_probe.vision is False:
            found = candidate_probe
            break
    if found is not None:
        report.add(Check("vision_unsupported", "不支持视觉的模型识别", "pass",
                         f"{found.model}: vision=False reason={found.details.get('vision', {}).get('reason')}",
                         found.to_dict()))
    else:
        report.add(Check("vision_unsupported", "不支持视觉的模型识别", "skip",
                         "未通过 --text-model 指定纯文本模型；该验收项由 mock 通过项覆盖", {"attempts": attempts}))

    # 6. wrong key against a live provider (only meaningful if it enforces auth)
    try:
        import dataclasses

        bad_settings = dataclasses.replace(settings, api_key="invalid-" + "acceptance-" + "key")
        bad_client = ChatClient(bad_settings, audit=AuditLogger(settings.home / "audit-badkey.jsonl"))
        bad_client.complete([{"role": "user", "content": "hello"}], model=model, max_tokens=4, timeout=30)
        report.add(Check("bad_key", "错误 API Key 处理", "skip",
                         "the live endpoint accepted an invalid key (it does not enforce auth); "
                         "the mock pass covers the 401 path"))
    except AuthError as err:
        payload = err.to_dict()
        leaked = _scan_for_secret(bad_settings.api_key, json.dumps(payload, ensure_ascii=False))
        report.add(Check("bad_key", "错误 API Key 处理", "pass" if not leaked else "fail",
                         f"{err.code} status={err.http_status} leaked={leaked}", payload))
    except StudioError as err:
        report.add(Check("bad_key", "错误 API Key 处理", "skip",
                         f"live endpoint did not produce a clean 401: {err.code}", err.to_dict()))

    report.add(Check("timeout", "超时错误反馈", "skip",
                     "not induced against a shared live endpoint; covered by the mock pass"))
    report.add(Check("interrupted", "网络/流中断反馈", "skip",
                     "not induced against a shared live endpoint; covered by the mock pass"))

    # 7. key leakage in this pass's audit
    blob = settings.audit_path.read_text(encoding="utf-8") if settings.audit_path.exists() else ""
    leaked = _scan_for_secret(settings.api_key, blob)
    report.add(Check("key_leak", "API Key 不泄露", "fail" if leaked else "pass",
                     f"audit={settings.audit_path} key_found={leaked}",
                     {"audit_path": str(settings.audit_path), "key_found": leaked}))

    report.notes.append(f"Live endpoint: {settings.base_url} (configured via environment).")
    report.notes.append("超时与流中断只在本地 mock 上诱导；未对共享网关制造故障。")
    report.ended_at = _now()
    return report


# -------------------------------------------------------------------- output
def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def write_report(report: RunReport, out_dir: Path) -> tuple[Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    json_path = out_dir / f"acceptance-{report.mode}-{stamp}.json"
    md_path = out_dir / f"acceptance-{report.mode}-{stamp}.md"
    json_path.write_text(json.dumps(asdict(report), ensure_ascii=False, indent=2), encoding="utf-8")

    icon = {"pass": "✅", "fail": "❌", "skip": "⏭"}
    lines = [
        f"# M0 验收记录 · {report.mode}",
        "",
        f"- 开始：{report.started_at}",
        f"- 结束：{report.ended_at}",
        f"- 端点：{report.base_url}",
        f"- 模型：{report.model}",
        f"- 结果：{report.summary()['pass']} pass / {report.summary()['fail']} fail / {report.summary()['skip']} skip",
        "",
        "| 验收项 | 结果 | 证据 |",
        "|---|---|---|",
    ]
    for check in report.checks:
        detail = check.detail.replace("|", "\\|").replace("\n", " ")
        lines.append(f"| {check.name} | {icon[check.status]} {check.status} | {detail} |")
    if report.notes:
        lines += ["", "## 说明", ""] + [f"- {note}" for note in report.notes]
    md_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return json_path, md_path


def print_summary(report: RunReport) -> None:
    print(f"\n=== {report.mode} ===")
    for check in report.checks:
        print(f"[{check.status.upper():4}] {check.name}: {check.detail[:120]}")
    summary = report.summary()
    print(f"summary: {summary['pass']} pass / {summary['fail']} fail / {summary['skip']} skip")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="M0 acceptance runner")
    parser.add_argument("--mode", choices=("mock", "live", "both"), default="both")
    parser.add_argument("--vision-model", action="append", default=None)
    parser.add_argument("--text-model", action="append", default=None)
    parser.add_argument("--out", default=str(ROOT / "evidence"))
    args = parser.parse_args(argv)

    reports: list[RunReport] = []
    if args.mode in ("mock", "both"):
        reports.append(run_mock())
    if args.mode in ("live", "both"):
        reports.append(run_live(vision_models=args.vision_model, text_models=args.text_model))

    failed = 0
    for report in reports:
        json_path, md_path = write_report(report, Path(args.out))
        print_summary(report)
        print(f"report: {json_path}")
        print(f"report: {md_path}")
        failed += report.summary()["fail"]
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
