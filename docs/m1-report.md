# M1 验收报告 — 画布内的提示词闭环

- 日期：2026-11-05
- 版本：`0.2.0-m1`
- 范围：节点读写适配、反推、Diff 卡片、应用、撤销、版本历史、ComfyUI 侧边栏
- 状态：**实现完成；已在只读开发环境与真实 ComfyUI 安装中分别复现全链路，真实安装回归见 [`real-install-report.md`](real-install-report.md)。**

## 1. 结论

M1 的出口标准「反推 → 对话改 → 应用 → 撤销」已在浏览器中完整复现，并通过 142 个 Python 测试与 32 个 JavaScript 测试。模型输出不能直接覆盖提示词：所有写入都经过结构化操作校验、块级 diff 审阅、撤销栈和版本记录。

真实 ComfyUI 的安装回归（安装 → 闭环 → 卸载）已于 2026-11-05 完成：节点与扩展集合完全还原，同一工作流在安装/卸载两种状态下序列化哈希一致。回归中发现并修复了 3 个只在真实环境暴露的缺陷（见真实安装报告 §5）。剩余未验证项只剩 Node 2.0 前端等少数交互，详见 §6。

## 2. 交付内容

| 层 | 模块 | 作用 |
|---|---|---|
| 前端 | `web/ai_prompt_studio.js` | 侧边栏工作台：目标选择、对话、反推、diff、撤销、历史 |
| 前端 | `web/lib/targets.js` | 在 LiteGraph 节点上找提示词/图片控件，读写 widget |
| 前端 | `web/lib/sse.js` | 分块安全的 SSE 解析 |
| 前端 | `web/lib/undo.js` | 按控件键记录的撤销/重做栈 |
| 前端 | `web/lib/api.js`、`diff.js`、`images.js` | 路由客户端、diff 文案、图片转 data URL |
| 后端 | `prompt_studio/aiohttp_api.py` | 在 ComfyUI 的 aiohttp 上注册 `/ai_prompt_studio/*` |
| 后端 | `prompt_studio/edit_agent.py` | 编辑提案的 JSON 契约与解析 |
| 后端 | `prompt_studio/diff.py` | 操作校验、应用、块级 diff |
| 后端 | `prompt_studio/caption.py` | 三种反推格式 |
| 后端 | `prompt_studio/versions.py` | 版本历史（SQLite，每控件 100 条） |
| 后端 | `prompt_studio/wincred.py`、`credentials.py` | Windows 凭据库保管与明文迁移 |
| 接入 | `__init__.py`、`comfyui_plugin.py` | `WEB_DIRECTORY`、路由注册、幂等保护、零节点类 |
| 开发 | `scripts/dev_harness.py`、`dev/` | 假 ComfyUI 页面 + 假上游，只读演示 |

## 3. 闭环实测（开发环境）

环境：`python scripts/dev_harness.py --port 8199 --model demo-model`，假上游与真实 HTTP/SSE 协议一致，页面模拟 ComfyUI 的侧边栏容器与三个节点。

| 步骤 | 操作 | 实测结果 |
|---|---|---|
| 目标识别 | 选中「正向提示词」节点 | 下拉框显示 `正向提示词 · text（#6）`，提示词为 `a cat on a mat, sunny afternoon, 35mm photo` |
| 能力探测 | 点 `↻` | 文本 ✓ / 视觉 ✓ / 流式 ✓ |
| 对话 | 「这段提示词的光线该怎么补？」 | SSE 流式返回，气泡逐字更新，会话写入 SQLite |
| 反推 | 选中参考图 → 反推 → 用所选节点图片 → 自然语言 | 返回 `A poster split into red and blue halves, centered composition, soft studio light.` |
| 反推写入 | 追加到末尾 | 提示词与画布节点同步更新，可撤销 |
| 生成修改 | 「把晴天改成雨夜」 | 提案：`replace "sunny afternoon" → "rainy night"` + `append ", wet reflections"`；diff 显示 1 处修改、1 处新增 |
| 全部应用 | Diff 卡片 | 提示词变为 `a cat on a mat, rainy night, 35mm photo, wet reflections`；状态「已写入节点，可撤销」 |
| 逐条应用 | 取消勾选「追加」，应用勾选 | 只写入替换项：`a cat on a mat, rainy night, 35mm photo` |
| 撤销 / 重做 | 底部按钮 | 撤销恢复到原句；重做恢复修改；节点卡片与提示词同步 |
| 历史 | 历史标签 | 列出 `apply / undo / redo / caption-append` 版本；点开并「恢复这个版本」成功 |
| 切换目标 | 选中「负向提示词」 | 目标与提示词切换为 `blurry, low quality, watermark`，对话按控件隔离 |
| 视觉禁用 | 以 `text-only` 模型重开 | 徽章 `视觉 ✗`，提示「当前模型不支持图片输入（rejected_by_api），反推已禁用」，按钮禁用 |

截图证据：

- [`evidence/m1-ui-diff-card.jpg`](../evidence/m1-ui-diff-card.jpg) — diff 卡片、逐条勾选、撤销/重做
- [`evidence/m1-ui-caption.jpg`](../evidence/m1-ui-caption.jpg) — 反推预览与结果
- [`evidence/m1-ui-vision-gated.jpg`](../evidence/m1-ui-vision-gated.jpg) — 视觉能力探测失败后禁用反推

## 4. 验收标准对照

| # | 标准 | 状态 | 证据 |
|---|---|---|---|
| 1 | 安装后现有工作流节点数、连线、widget 值零变化 | **通过（实机）** | 插件不注册节点类（`NODE_CLASS_MAPPINGS = {}`）；真实安装回归中同一 4 节点工作流的节点/连线/提示词逐字段一致，安装态与卸载态序列化哈希相同，见 [`real-install-report.md`](real-install-report.md) §3。 |
| 2 | 图片 → 反推 → 连续追问 → 应用 → 撤销可复现 | **通过** | §3 全链路；三轮追问的上下文正确性由 `test_three_follow_up_turns_keep_context` 覆盖（模型看到 system + 3 轮消息） |
| 3 | `/probe` 对纯文本模型判定 `vision=false`，反推入口禁用且提示明确 | **通过** | `test_caption_disabled_after_vision_probe_fails`（422 `capability_unsupported`）＋ 截图 |
| 4 | 抓包、前端状态、日志三处均无 API Key 明文 | **通过** | `/status` 仅掩码（测试断言响应不含密钥）；浏览器网络面板逐条检查无密钥；审计只记元数据（`test_secrets`、`test_health_and_status`） |
| 5 | Skill 文件加载前后 SHA-256 一致 | 不适用 | M2 范围 |
| 6 | 冲突报告覆盖五类 | 不适用 | M3 范围 |
| 7 | 经典 LiteGraph 与 Node 2.0 前端均能完成闭环 | **部分** | 经典 LiteGraph：假 ComfyUI 与真实 ComfyUI 均通过；Node 2.0 前端仍未验证 |
| 8 | 对项目 A 的相似度自检低于阈值 | 未自动化 | 人工确认无复制；自动化相似度检查未做，建议发行前补 |

## 5. 测试记录

| 套件 | 命令 | 结果 | 记录 |
|---|---|---|---|
| Python（142） | `python -m unittest discover -s tests -t .` | OK | `evidence/test-run-real-install-20261105-230523.txt` |
| JavaScript（32） | `node --test tests_js/*.test.mjs` | 32 pass | `evidence/test-js-real-install-20261105-230728.txt` |
| 浏览器闭环 | 开发环境手工脚本化操作 | 见 §3 | 三张截图 |

M1 新增覆盖：编辑操作校验（唯一性/歧义/无变化/顺序应用）、块级 diff（含分隔符不算修改）、提案解析（纯 JSON/围栏/夹在散文里）、反推三格式与清洗、版本库与裁剪、ComfyUI 路由（聊天流、编辑、应用、反推、版本、会话）、视觉能力门禁、凭据库与明文迁移、插件注册幂等。真实安装回归后补充：无中间件路由的 4xx 错误映射（`RouteGuardTests` 整套重跑）、目标对象可序列化。

## 6. 已知限制与未验证项

1. ~~未安装进真实 ComfyUI~~ **已补验**（2026-11-05）：`WEB_DIRECTORY` 加载、真实 `app.extensionManager` 的侧边栏注册、真实画布的提示词控件识别均正常，见 [`real-install-report.md`](real-install-report.md)。
2. **Node 2.0 前端未验证**。控件适配取的是 `node.widgets` 与 `widget.value/callback`，两种前端都保留这些字段，但未实机确认。
3. ~~浏览器上传图片路径未实测~~ **已补验**：真实 ComfyUI 中经 `<input type=file>` 上传图片并反推成功。
4. **停止流式生成按钮未实测**（已实现 abort）。
5. **撤销栈是全局的**：条目按控件键写入，撤销不会写错节点；但按钮提示不区分目标，跨节点连续编辑时语义略弱。
6. **历史较密**：撤销与重做也会各记一条版本；M2 可合并为一次编辑事件。
7. **无速率限制、无版本库清理、审计不轮转**：与 M0 记录一致。

## 7. 建议的下一步

1. ~~真实 ComfyUI 安装回归~~ **已完成**：安装/卸载无残留、真实工作流前后一致、经典 LiteGraph 闭环通过；若要覆盖 Node 2.0，需要单独授权切换前端模式。
2. 若批准 M2：规则包引擎、Skill 只读适配器、结构化输出与冲突报告。
3. 发行前补：源文件 SPDX 头、对项目 A 的自动化相似度检查、GPL 源码分发说明。

> 本轮不自动进入 M2，等待批准。
