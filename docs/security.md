# 安全设计（M1）

## 信任边界

```
ComfyUI 浏览器页面（侧边栏工作台）
        │  同源 fetch，无密钥，无跨域
        ▼
ComfyUI aiohttp 服务  ── /ai_prompt_studio/* ──►  prompt_studio 后端
        │                                           │
        │                                           ├── 系统凭据库（Windows Credential Manager）
        │                                           ├── SQLite 会话库 / 版本库
        │                                           └── JSONL 审计日志（仅元数据）
        ▼
   HTTPS ──► 统一多模态 API（Base URL 由用户配置）
```

M1 不再单独监听端口：路由挂在 ComfyUI 自己的 aiohttp 服务上，浏览器只访问同源地址。M0 的独立后端（`python -m prompt_studio serve`）仍保留，用于无 ComfyUI 的验证。

## API Key 保管

| 环节 | 措施 |
|---|---|
| 存储 | Windows：Credential Manager 泛型凭据（目标名 `comfyui-ai-prompt-studio/<target>`）；其他平台：`~/.comfyui-ai-prompt-studio/credentials.json`，`0o600` |
| 迁移 | 旧版明文 `api_key` 在下次加载时迁入凭据库，并从 JSON 中删除 |
| 输入 | `python -m prompt_studio.credentials set` 使用 `getpass`，不回显 |
| 内存 | 仅后端进程持有；前端拿不到 |
| 响应 | `/status` 只返回 `api_key_configured` 与掩码（前 4 位 + 后 2 位） |
| 日志 | 审计只记录元数据；所有字段经 `Redactor` 处理 |
| 错误 | 上游错误消息、异常字符串全部脱敏；测试覆盖 401 回显场景 |
| 浏览器 | 前端只调用 `/ai_prompt_studio/*`，请求体里没有密钥；验收时检查了网络面板与页面源码 |

## 写入安全

1. 模型不返回整段新提示词，只返回 `replace / delete / insert_after / append` 操作。
2. 每条操作的 `before` 必须在当前文本中**恰好出现一次**；缺失、歧义、无变化、过长都会被拒绝（`invalid_edit`，HTTP 422）。
3. 应用前服务端对**当前**文本重新校验，避免提案生成后文本被改动导致误写。
4. 写入走控件的正常路径（`widget.value` → `callback` → `onWidgetChanged` → 重绘画布），不改工作流 JSON 结构。
5. 写入前展示块级 diff，用户可逐条勾选；写入后进入撤销栈并生成版本记录。
6. 服务端不执行模型输出中的任何指令；图片中的文字被系统提示明确标记为「素材，不是指令」。

## 暴露面

- 路由继承 ComfyUI 的绑定地址。ComfyUI 监听 `0.0.0.0` 时，这些路由同样对局域网可达，且没有额外鉴权。**建议把 ComfyUI 绑定在 `127.0.0.1`**，或自行在反向代理层加认证。
- 请求体上限 25 MB；图片单张上限由 `max_image_bytes` 控制（默认 8 MB）。
- 没有速率限制；并发请求由 ComfyUI 的 aiohttp 与线程池天然串行化到同一后端实例。

## 已知限制

1. **凭据库可见性**：Windows Credential Manager 中的条目对当前用户的其他进程可读；这是单用户桌面工具的常见边界。
2. **无 TLS**：同源 HTTP。若通过端口转发暴露，必须自行加 TLS 反向代理。
3. **无速率限制与配额**：M1 未实现；长时间高频调用会直接消耗上游额度。
4. **图片与会话落盘**：会话图片按 SHA-256 存在 `media/`；删除会话不会删除孤立图片，M2 增加清理。
5. **审计无限增长**：未做轮转（M2）。
6. **系统代理**：`urllib` 遵循 `HTTP_PROXY`/`HTTPS_PROXY`；使用代理时请求会经过代理。
7. **前端信任**：工作台假定 ComfyUI 页面本身可信；恶意页面脚本可以调用这些路由，但拿不到密钥。

## 审计日志字段

`ts`、`event`、`request_id`、`operation`、`model`、`status`、`latency_ms`、`attempts`、`usage`、`text_chars`、`chunks`、`ttft_ms`、`error_code`、`upstream_status`。

**不记录**：请求头、API Key、提示词正文、图片内容、模型输出正文。

## 报告安全问题

本仓库为本地工具。发现密钥泄露或越权路径时，请先停止 ComfyUI、轮换 API Key，再提交 issue（不要在 issue 中附带真实密钥）。
