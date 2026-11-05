# 真实安装回归报告 — ComfyUI-AI-Prompt-Studio M1

- 日期：2026-11-05
- 版本：`0.2.0-m1`
- 目的：补上 M1 验收中「未安装进真实 ComfyUI」的空白——安装、跑通闭环、卸载，并确认现有工作流不受影响。
- 结论：**安装/卸载干净，节点类型与扩展集合完全回到安装前；同一工作流在安装与卸载两种状态下序列化结果逐字段一致。闭环在真实 ComfyUI + Magpie 上跑通。回归中发现并修复了 3 个真实环境才暴露的缺陷。**

## 1. 环境

| 项 | 值 |
|---|---|
| ComfyUI | `E:\AI_vedios\ComfyUI_aki\ComfyUI-aki-v3.2\ComfyUI`（用户既有安装，共享 `custom_nodes`） |
| Python | 3.13（`...\ComfyUI-aki-v3.2\python\python.exe`） |
| 启动参数 | `--port 8189 --listen 127.0.0.1 --cpu --disable-auto-launch`，`--user-directory` / `--temp-directory` 指向 `E:\AI\99_运行数据\ComfyUI-AI-Prompt-Studio_regression` |
| 已装第三方扩展 | 940 个前端扩展（含 comfyui_studio_suite、rgthree、Lora Manager 等），4096 种节点类型 |
| 模型网关 | 本机 Magpie `http://127.0.0.1:3425/v1`，模型 `gemini-3.8-flash`（凭据库中的真实 Key） |
| 用户自己的实例 | 8188 端口同时运行，本次回归不触碰 |

隔离 user/temp 目录只用于本次回归；插件本体是复制进真实 `custom_nodes` 的，与正式安装方式一致。

## 2. 安装前后对比

| 指标 | 安装前 | 安装后 | 卸载后 |
|---|---|---|---|
| `/object_info` 节点类型数 | 4096 | 4096（集合完全相同） | 4096（集合完全相同） |
| `/extensions` 数量 | 940 | 947（新增 7 个 `/extensions/ComfyUI-AI-Prompt-Studio/*.js`） | 940（集合与安装前完全相同） |
| 侧边栏标签 | 8 个 | 9 个（新增 `ai-prompt-studio`，`type: custom`） | 8 个 |
| `/ai_prompt_studio/health` | 404 | 200 `{"status":"ok","version":"0.2.0-m1"}` | 404 |
| 加载插件时控制台 | — | 无插件相关报错 | — |

`/status` 返回 `base_url=http://127.0.0.1:3425/v1`、`model=gemini-3.8-flash`、密钥仅掩码，符合默认配置要求。

## 3. 工作流零变化验证

用用户已保存的工作流 `图片反推提示词.json`（4 节点、2 连线）做对照。为保证不碰原文件，复制一份到隔离目录，通过前端 `app.loadGraphData()` 载入（与打开工作流走同一反序列化路径），再 `graph.serialize()` 取规范化 JSON 比较。

| 比较项 | 结果 |
|---|---|
| 节点 id 集合 / 数量 | 一致（1、2、3、4） |
| `type` / `title` | 逐节点一致 |
| `widgets_values`（全部提示词与参数） | 逐节点逐字段一致 |
| `pos` / `size` / `mode` / `flags` / `properties` | 逐字段一致 |
| `links` / `groups` / `last_node_id` / `last_link_id` | 一致 |
| 规范化序列化 SHA-256 | 安装后与卸载后**完全相同**：`26bcc1bd9afa4427a16ce0c06b3db21e5072b2039f11ebb16efd695ad15cb5ce` |

唯一与「首次加载前的文件」不同的顶层字段是 `extra`：`extra.ds`（画布视口缩放/偏移）、`qgn_navigation_groups`、`qgn_locked`（rgthree 的 quick_group_navigation 扩展在 configure 时写入）。同一页面状态下带插件与不带插件的序列化哈希完全相同，说明这些差异来自前端/其他扩展，与插件无关。

## 4. 真实闭环实测

面板识别到工作流上的 4 个提示词控件：`反推二 · 文本（#1）`、`✨图像反推提示词 · custom_rule_content（#2）`、`✨图像反推提示词 · user_prompt（#2）`、`反推一 · 文本（#3）`。

| 步骤 | 实测结果 |
|---|---|
| 能力探测 `↻` | 文本 ✓ / 视觉 ✓ / 流式 ✓；两张合成图颜色交叉验证均通过（`red+blue`、`green+yellow`），延迟约 7.6 s |
| 对话 | SSE 流式返回，气泡逐字更新，会话落库；回答内容正确引用了提示词里的英文输出约束 |
| 生成修改 | 指令「在提示词最后追加一句：所有输出均使用英文。」→ 提案 1 条 `insert_after`，diff 卡片显示「1 处新增」与插入位置 |
| 应用 | 全部应用后 `graph.serialize()` 中 #1 提示词 1437 → 1448 字符，末尾为 `所有输出均使用英文。` |
| 撤销 | 底部撤销后回到 1437 字符；撤销按钮禁用、重做按钮启用，状态提示「已撤销：…」 |
| 反推（浏览器上传） | 经 `<input type=file>` + DataTransfer 上传 `caption-test.jpg`，预览显示文件名；反推返回 442 字符自然语言描述（prose） |
| 反推写入 | 「追加到末尾」后提示词 1437 → 1881 字符，可撤销；撤销后回到 1437 |
| 历史 | 历史标签列出 `apply / undo / caption-append` 版本，含时间戳与文本摘要 |

截图：[`evidence/real-install-panel.jpg`](../evidence/real-install-panel.jpg)（真实 ComfyUI 画布 + 已加载工作流 + 侧边栏工作台）。

## 5. 回归中发现并修复的问题

| # | 现象 | 根因 | 修复 | 覆盖 |
|---|---|---|---|---|
| 1 | 对话/生成修改一律提示「无法连接到 ComfyUI 服务」，根本没有发出 HTTP 请求 | 发送给后端的 `target` 是 `describeTarget()` 的富对象，含 `node`、`widgetRef`（LiteGraph 循环引用），`JSON.stringify` 直接抛错，被 api 层映射成网络错误。开发环境的假节点恰好可序列化，所以没暴露 | 新增 `targetWire()`，只发送 `node_id / widget / title / text`；对话与编辑两处改用 | `tests_js/targets.test.mjs` 新增循环引用用例 |
| 2 | 只有 1 条修改时，「全部应用 / 应用勾选」始终禁用 | `renderDiff()` 仅在 `changes.length > 1` 时插入带复选框的操作列表，单条修改没有复选框 → `hasChecked` 永远为 false | 改为 `changes.length` 即插入；单条时仍只显示「全部应用」 | 真实安装手工回归 |
| 3 | 请求体不合法时返回 aiohttp 裸 500 | ComfyUI 只给出 `RouteTableDef`，无法挂错误中间件；`StudioError` 在线上环境无人捕获（开发测试用的是自建 app + 中间件） | 每个路由加 `@guarded`，把 `StudioError` 转成 JSON 4xx/5xx | 新增 `RouteGuardTests`：同一套 API 测试在「只有路由、无中间件」的 app 上再跑 12 个用例 |

## 6. 对 M1 结论的影响

- M1 报告 §4 标准 1（安装后现有工作流零变化）：**由设计保证升级为实机验证通过**。
- §4 标准 7（经典 LiteGraph / Node 2.0）：本机是经典 LiteGraph 类前端模式，**该模式通过**；Node 2.0 前端仍未验证。
- M1 报告 §6 第 1 条（未安装真实 ComfyUI）、第 3 条（浏览器上传未实测）：**本次已补验**。
- 仍未验证：Node 2.0 前端、停止流式按钮的交互、超大图片上传、其余 28 个工作流（只抽了 1 个 4 节点工作流做结构对照）。

## 7. 卸载与残留

- 删除 `custom_nodes\ComfyUI-AI-Prompt-Studio` 后重启：`/ai_prompt_studio/*` 全部 404，扩展与节点类型集合回到安装前，侧边栏回到 8 个标签。
- 运行数据（版本库 SQLite、审计日志、隔离 user/temp）在 `E:\AI\99_运行数据\ComfyUI-AI-Prompt-Studio_regression`，不写用户 ComfyUI 目录。
- 回归用临时 `.claude/launch.json`（`comfy-regression`）已删除，预览服务已停止。
