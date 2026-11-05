# ComfyUI AI Prompt Studio

独立的 ComfyUI AI 提示词工作台。**当前阶段：M0 — 统一多模态 API 原型。**

M0 只验证一件事：用户只配置 **一个 Base URL、一个 API Key、一个 Model**，后端就能稳定完成文本、图片理解、流式输出、多轮对话，并在失败时给出明确、可解释的错误。

> M0 **不安装到 ComfyUI**，**不修改** 现有 ComfyUI 与工作流，**不包含前端**，也未实现 M1–M3 的产品功能。

## M0 已实现

| 能力 | 位置 |
|---|---|
| Base URL / API Key / Model 统一配置（环境变量 > 凭据文件） | `prompt_studio/config.py` |
| OpenAI 兼容文本调用 | `prompt_studio/client.py` |
| 图片输入（data URL / base64 / 远程 URL） | `prompt_studio/client.py`、`server.py` |
| SSE 流式输出（增量转发、首字耗时、chunk 计数） | `prompt_studio/client.py` |
| 多轮会话（SQLite + 文件型图片仓库） | `prompt_studio/sessions.py` |
| 能力探测（文本 / 视觉 / 流式，两图交叉验证） | `prompt_studio/capabilities.py` |
| 超时、429/5xx 重试、断流与网络错误 | `prompt_studio/client.py`、`errors.py` |
| 后端密钥保管（不入前端、不入日志、不回显） | `credentials.py`、`redaction.py` |
| 调用审计（JSONL，只记元数据） | `audit.py` |
| 本地后端 API（127.0.0.1 + 本地令牌） | `server.py` |

## 快速开始

```bash
# 1) 保存凭据（密钥输入不回显，写入 ~/.comfyui-ai-prompt-studio/credentials.json）
python -m prompt_studio.credentials set
```

```bash
# 2) 能力探测
python -m prompt_studio probe
```

```bash
# 3) 启动本地后端（默认 127.0.0.1:8791）
python -m prompt_studio serve
```

```bash
# 4) 命令行发一条消息（仅用于验证，不是产品前端）
python -m prompt_studio chat "写一句测试"
```

环境变量可覆盖凭据文件：`PROMPT_STUDIO_BASE_URL`、`PROMPT_STUDIO_API_KEY`、`PROMPT_STUDIO_MODEL`、`PROMPT_STUDIO_HOME`、`PROMPT_STUDIO_TIMEOUT_S`、`PROMPT_STUDIO_MAX_RETRIES`。

## 本地后端 API

除 `/health` 外全部要求本地令牌（`X-Studio-Token` 或 `Authorization: Bearer`），令牌首次启动生成并写入 `~/.comfyui-ai-prompt-studio/server_token`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 存活检查（无鉴权，无敏感信息） |
| GET | `/api/config` | 公开配置（密钥仅显示掩码） |
| POST | `/api/chat` | 对话；`stream=true` 时返回 SSE |
| POST | `/api/probe` | 探测文本 / 视觉 / 流式能力 |
| GET | `/api/models` | 上游模型列表 |
| GET/POST | `/api/sessions` | 会话列表 / 新建 |
| GET/DELETE | `/api/sessions/{id}` | 会话详情 / 删除 |
| GET | `/api/audit` | 最近审计记录（已脱敏） |

SSE 事件：`meta` → `delta`（可多次）→ `done`，失败时为 `error`。

## 测试与验收

```bash
python -m unittest discover -v -s tests -t .
```

```bash
python scripts/acceptance.py --mode both
```

验收产物写入 `evidence/`；M0 验收报告见 [`docs/m0-report.md`](docs/m0-report.md)。

## 安全边界

- 后端默认只绑定 `127.0.0.1`；绑定非回环地址需显式设置 `PROMPT_STUDIO_ALLOW_REMOTE=1`。
- API Key 只存在于后端进程内存与用户目录凭据文件中，不写进项目、不进审计日志、不出现在任何响应里。
- 审计日志只记录元数据（模型、耗时、状态、token 用量、chunk 数），不记录提示词、图片或请求头。
- 详见 [`docs/security.md`](docs/security.md)。

## 许可证

本项目采用 **GPL-3.0-only**（见 [`LICENSE`](LICENSE)）。这是为公开发行选择的保守方案，不构成法律意见，也不是“因为 import 了 ComfyUI 所以必然如此”的结论。第三方组件与版本记录见 [`docs/license-audit.md`](docs/license-audit.md)。

- ComfyUI 与 ComfyUI Frontend：GPL-3.0（M0 未捆绑、未链接）。
- MOSS 官方 `compile_prompt.py`：Apache-2.0（属于兄弟项目 `ComfyUI-MOSS-PromptBoard`，本项目未包含）。
- `moss-image-prompt-skill`：CC BY-NC-ND 4.0，**不随本项目分发**；未来仅支持用户本地只读加载。

## 路线图

- **M0（本仓库当前状态）**：统一 API 原型。
- **M1**：会话工作台、差异确认、版本回退（接入 ComfyUI 前端）。
- **M2**：图片反推、提示词扩充与结构化输出。
- **M3**：双规则引擎、冲突检测与解释。
