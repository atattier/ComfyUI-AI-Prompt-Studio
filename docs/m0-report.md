# M0 验收报告 · 统一多模态 API 原型

- 日期：2026-11-05
- 版本：`0.1.0-m0`
- 范围：仅 M0。**未安装到 ComfyUI，未修改 ComfyUI / 工作流，未开发前端，未进入 M1–M3。**
- 运行环境：Windows 11 26200 / Python 3.14.7 / 纯标准库
- 真实端点：本机 Magpie 网关 `http://127.0.0.1:3425/v1`，模型 `auto/gemini-3.8-flash`

## 1. 结论

| 验收方式 | 结果 |
|---|---|
| 单元/集成测试（65 项，真实本地 HTTP 上游） | **65 通过 / 0 失败** |
| 协议一致性验收（mock，含全部故障注入） | **10 通过 / 0 失败 / 0 跳过** |
| 真实网关验收（Magpie） | **6 通过 / 0 失败 / 4 跳过**（跳过项见 §4） |

M0 的 9 项必须完成内容全部实现；9 项验收标准中，9 项均有真实运行证据（其中 4 项以本地协议上游的真实 HTTP 故障复现，未对共享网关制造故障）。

## 2. 验收标准 → 证据

| # | 验收标准 | 结果 | 证据 |
|---|---|---|---|
| 1 | 文本调用成功 | ✅ | live：`reply='OK'`，2.9 s；mock：2 ms。`evidence/acceptance-*-2119*.json` |
| 2 | 图片调用成功 | ✅ | live：识别合成图 `red/blue`；mock：按真实 PNG 像素解码后回答。同左 |
| 3 | 流式响应成功 | ✅ | live：5 个增量 chunk，TTFT 13.5 s，`saw_done=true`；mock：3 chunk。同左 |
| 4 | 多轮上下文正确 | ✅ | live：第一轮记 47，第二轮答 `47`；mock：第二轮请求含 `assistant:` 与 3 条消息。同左 |
| 5 | 不支持视觉的模型能被识别 | ✅ | mock 上游返回真实 `HTTP 400 "does not support image input"`，探测输出 `vision=false, reason=rejected_by_api`。同左 |
| 6 | 错误 API Key 能正确处理 | ✅ | mock 返回真实 `HTTP 401`，客户端 `auth_failed`、不重试、1 次尝试。同左 |
| 7 | API Key 不泄露 | ✅ | 扫描审计日志 + 全部错误载荷 + 公开配置：`key_found=false`（live 与 mock 各一次）。同左 |
| 8 | 超时与网络中断有明确反馈 | ✅ | mock：`Upstream did not respond within 0.5s.`（504 ms，可重试）；断流：`The connection dropped mid-stream.`（带 partial 文本）；对端立即断开：`Cannot reach the API endpoint…`（NetworkError）。同左 |
| 9 | 全部测试通过并提供记录 | ✅ | `evidence/test-run-20261105-211755.txt`（65 项，28.0 s，OK） |

## 3. 实现清单

| 要求 | 实现 | 测试 |
|---|---|---|
| Base URL / Key / Model 统一配置 | `config.py`：环境变量 > 凭据文件；URL 自动补齐 `/v1` | `test_config.py`（12） |
| 文本请求 | `client.py::complete` | `test_client_text.py`（5） |
| 图片输入与视觉理解 | data URL / base64 / 远程 URL；`image_part_from_bytes` | `test_client_vision.py`（4） |
| 流式输出 | SSE 增量解析、`[DONE]`、usage、TTFT、chunk 计数 | `test_stream.py`（4） |
| 多轮对话 | SQLite 会话 + 内容寻址图片仓库 | `test_sessions.py`（7）、`test_server.py` |
| 能力探测 | 文本 + 两图交叉验证视觉 + 流式探测；带 TTL 缓存 | `test_capabilities.py`（4） |
| 超时 / 异常 / 重试 | 429/5xx/408 可重试，401/403/404/400 不重试；指数退避 + Retry-After；流式仅在首字前重试 | `test_errors.py`（9） |
| 后端密钥保管 | 用户目录凭据文件 0600、本地令牌、响应只给掩码 | `test_credentials.py`（5）、`test_secrets.py`（4） |
| 调用日志与安全审计 | JSONL 只记元数据，全字段脱敏，请求内容不落盘 | `test_client_text.py`、`test_secrets.py` |

合计 65 项测试。

## 4. 跳过项与原因（如实记录）

| 项 | 状态 | 原因 |
|---|---|---|
| live 不支持视觉模型识别 | ⏭ | 本机 Magpie 网关没有真正的纯文本线路：声明 `input: [text]` 的线路实测都能正确读图（`beam-free`、`codearts/glm-5.3-flash`、`catpaw/longcat-2.0` 等），另一些返回空内容。该能力只在**本地协议上游**上可确定复现（真实 HTTP 400）。M0 因此以 mock 结果作为该项证据。 |
| live 错误 Key | ⏭ | Magpie 本机网关不校验 Key，无效 Key 也会成功；401 路径由 mock 的真实 401 覆盖。 |
| live 超时 / 断流 | ⏭ | 不对共享网关主动制造超时或断流；两项均由 mock 真实复现。 |

## 5. 验收过程中发现并修复的问题

1. **推理模型 token 预算不足**：`auto/beam-free` 的 `reasoning_content` 占满 `max_tokens=8`，导致正文为空、被误判为“不支持文本”。已将文本探测预算提升到 128、视觉 128、流式 256，并在代码注释中说明原因。
2. **网络错误文案不一致**：连接被对端重置时落到 `OSError` 分支，提示与 `URLError` 分支不同。已统一为 “Cannot reach the API endpoint…”。
3. **声明模态不可信**：多个 `input: [text]` 的网关线路实际可读图。探测逻辑坚持“以直接证据为准”，声明值只作为旁证记录，不参与判定。
4. **空回复的语义**：视觉探测中空回复不再判为“不支持视觉”，而是 `vision=null, reason=empty_reply`，避免把供应商静默丢弃图片当成模型能力结论。

## 6. 安全与合规状态

- API Key：只存在于后端进程与 `~/.comfyui-ai-prompt-studio/credentials.json`；不进项目、不进日志、不出现在响应与异常信息中（有测试覆盖）。
- 后端默认仅监听 `127.0.0.1`，除 `/health` 外均需本地令牌。
- 审计日志仅元数据；提示词、图片、请求头不落盘。
- 许可证：项目 GPL-3.0-only；ComfyUI 0.43.2 / 前端 1.57.4 均为 GPL-3.0（M0 未捆绑）；MOSS Skill 未分发。详见 `docs/license-audit.md`。
- 已知限制（Windows 文件权限非强 ACL、无速率限制、无审计轮转、图片不自动清理）见 `docs/security.md`。

## 7. 未做的事（边界确认）

- ❌ 未复制、安装或启用任何 ComfyUI 自定义节点；
- ❌ 未启动、重启或修改 ComfyUI；
- ❌ 未改动任何现有工作流 JSON；
- ❌ 未实现对话工作台、diff 回滚、图片反推 UI、双规则引擎（M1–M3）；
- ❌ 未创建 GitHub 远端、未推送。

## 8. 下一阶段门禁

M0 验收通过后**停止**，等待用户批准 M1。M1 建议范围：ComfyUI 前端右侧工作台、会话与 diff 应用/回退、能力探测结果展示、密钥迁移到 Windows Credential Manager。
