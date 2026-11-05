# M0 安全设计

## 信任边界

```
ComfyUI / 浏览器 (M1 才接入)
        │  本地令牌 + JSON（127.0.0.1）
        ▼
本地后端 (prompt_studio)  ── HTTPS ──►  统一多模态 API
   │
   ├── 凭据文件（仅属主可读）
   ├── SQLite 会话库
   └── JSONL 审计日志（仅元数据）
```

M0 的后端只监听回环地址；没有前端，也没有跨域配置。

## API Key 保管

| 环节 | 措施 |
|---|---|
| 存储 | `~/.comfyui-ai-prompt-studio/credentials.json`，`os.open(..., 0o600)` 写入后 `chmod 600`；不放进项目目录 |
| 输入 | `python -m prompt_studio.credentials set` 使用 `getpass`，不回显 |
| 内存 | 仅后端进程持有；前端永远拿不到 |
| 响应 | `/api/config` 只返回 `api_key_configured` 与掩码（前 4 位 + 后 2 位） |
| 日志 | 审计只记录元数据；所有字段经 `Redactor` 处理 |
| 错误 | 上游错误消息、异常字符串、`to_dict()` 全部脱敏；测试覆盖 401 回显场景 |

## 已知限制

1. **Windows 文件权限**：NTFS 上 `chmod 600` 不是强 ACL 保证。M1 计划改用 Windows Credential Manager（`wincred`），并在文档中删除明文文件路径。
2. **本地令牌**：`server_token` 以明文文件保存在用户目录，任何能读该文件的本地进程都可调用后端。M0 定位是单用户原型。
3. **无 TLS**：后端仅回环 HTTP。若通过端口转发暴露，必须自行加 TLS 反向代理。
4. **无速率限制**：M0 未实现请求配额；M1 增加。
5. **图片落盘**：会话图片按 SHA-256 存在 `media/`，便于多轮引用。删除会话不会删除孤立图片（M1 增加清理）。
6. **审计无限增长**：M0 不做轮转；M1 增加按大小轮转与保留期。
7. **系统代理**：`urllib` 会遵循 `HTTP_PROXY`/`HTTPS_PROXY` 环境变量；使用代理时，请求会经过代理，请自行确认代理可信。
8. **提示词注入**：M0 不执行模型返回的任何指令，模型输出只作为文本返回，不参与工具调用。M1 的“应用改动”必须是结构化 diff，并由规则引擎校验。

## 审计日志字段

`ts`、`event`、`request_id`、`operation`、`model`、`status`、`latency_ms`、`attempts`、`usage`、`text_chars`、`chunks`、`ttft_ms`、`error_code`、`upstream_status`。

**不记录**：请求头、API Key、提示词正文、图片内容、模型输出正文。

## 报告安全问题

本仓库为本地原型。发现密钥泄露或越权路径时，请先停止后端、轮换 API Key，再提交 issue（不要在 issue 中附带真实密钥）。
