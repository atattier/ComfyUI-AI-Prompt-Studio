# 验收报告 — 反推节点三模式升级（caption / layout / hybrid）

- 日期：2026-11-06
- 仓库：`E:\AI\02_AI视频与视觉创作\ComfyUI插件\ComfyUI-AI-Prompt-Studio`
- 基础节点提交：`42f5c86`（阶段一 Git 安全快照，只含基础节点 5 文件）
- 回归实例：ComfyUI 便携版 `8189 --cpu`，隔离 user/temp 于 `99_运行数据/ComfyUI-AI-Prompt-Studio_regression`；模型 `auto/glm-5.3-flash`（gemini-3.8-flash 通道被上游停用）
- 用户主实例 `8188` 未重启、未中断

## 1. 阶段执行情况

| 阶段 | 要求 | 结果 |
|---|---|---|
| 一 Git 安全快照 | 检查 status/diff/untracked；只提交基础节点；无关文件不混入；记录 hash | ✅ `git status` 显示 3 M + 3 ??；逐文件审阅 diff；只暂存 5 个基础节点文件；`docs/superpowers/` 设计文档保留未跟踪；提交 `42f5c86` |
| 二 三模式 | caption 散文+文本弹窗无画布；layout JSON+画布拖缩放增删；hybrid 完整描述+布局+完整编辑；三模式均出 width/height | ✅ 后端 `MODES`、`RETURN_TYPES=("STRING","INT","INT")`；前端弹窗按 mode 显隐；实机注册确认输出 `prompt/width/height` |
| 三 尺寸匹配 | 比例误差优先、面积近 1M 次优；每边 256–2048、16 倍数、≤2,097,152；3:2/16:9/1:1/9:16 测试；不沿用未验证的 1216×832 | ✅ 穷举全部合法 (w,h)，按 `(相对比例误差, |面积-1M|, -面积)` 字典序选优；3:2 → **1248×832**、16:9 → 1280×720、1:1 → 1024×1024、9:16 → 720×1280；四比例实图文件头读取误差 0.000000 |
| 四 图片数据链路 | 不假设 HTTP 能拿到执行上下文 Tensor；image/image_path 优先级；异常图片；Key 不进前端 | ✅ 前端从上游 LoadImage widget 文件名经同源 `/view` 取字节转 data URL 放请求体；后端 `image.data_url` 优先于 `image_path`；坏数据/缺输入/坏后缀均 400 明确报错；凭据仅在后端 `ChatClient` |
| 五 PromptBoard 兼容 | 用真实 `sanitize_layout_draft` + 编译入口验证 layout JSON 无需手改 | ✅ 单元测直连 PromptBoard 仓库真实代码；三模式真实模型产物分别喂 `MOSSPromptCaption.compile` / `MOSSPromptBoard.compile` 全部编译成功（1327/1621/2298 字符） |
| 六 编辑保护 | 手改不被静默覆盖；拖框/文字同步；取消丢弃；切模式不清数据；保存重载恢复 | ✅ 手改后点「反推」会弹确认；payload 单 JSON 存 caption+draft，执行只读不重写；单测覆盖取消丢弃/模式切换/JSON round-trip；浏览器弹窗拖框/缩放/加区域/应用/取消/序列化恢复见 §3（部分项因环境自动刷新改用脚本化验收） |
| 七 最终验收 | 真模型三模式、四比例、真实编译、弹窗交互、保存重载、既有测试回归、提交/截图/运行证据 | ✅ 见 §2–§4；180 Python + 40 JS 全过 |

## 2. 真实模型三模式调用（`POST /ai_prompt_studio/caption_node`）

输入 `caption-test.jpg`（1240×2000），输出尺寸均 `992×1600`（比例 0.62，16 倍数，1,587,200 像素）：

| 模式 | 耗时 | caption 长度 | 区域数 | 备注 |
|---|---|---|---|---|
| caption | 7.2 s | 1137 | 0 | 英文散文，无 draft |
| layout | 9.3 s | 218 | 6 | 合法 Layout 草稿，区域数受 `MAX_ITEMS=8` 保护 |
| hybrid | 16.4 s | 625 | 6 | 完整 2–4 句描述 + 6 区域 |

修复记录：首次 hybrid 因 `max_tokens=1200` 截断 JSON 导致裸 500；改为 3000 token、解析失败映射为 400 明确提示、指令限制「最多 6 区域」并代码层按面积保留最大 8 个（截图类图片模型会把 UI 小文字切成 22 个框）。修复后三模式全通过。

## 3. 浏览器实机交互（真实 ComfyUI 8189）

| 项 | 结果 |
|---|---|
| 节点注册 `/object_info/AIPromptStudioCaption` | ✅ 输入 `mode/payload/image/image_path/extra_instruction/model/seed`，输出 `STRING,INT,INT` = `prompt,width,height` |
| 扩展加载 | ✅ `AI Prompt Studio.CaptionNode` 在 `app.extensions` 列表 |
| 创建节点 + 连 LoadImage | ✅ 7 输入 3 输出、按钮「反推」「编辑…」自动挂载；`load.connect(0, cap, 0)` 连线成功 |
| 反推按钮链路 | ✅ `/view?filename=...` 返回 200 → `POST /ai_prompt_studio/caption_node`；一次上游 60 s 超时如实报错（504），不静默覆盖 payload |
| image_path 反推 | ✅ layout 模式返回 `992×1600`、6 区域、payload 2598 字符写入 widget |
| 编辑弹窗 | ✅ 标题「编辑布局」、2 个 SVG 框 + 2 行列表、画布可见、尺寸回显 `1248 × 832（16 倍数）`；截图 [`evidence/three-mode-layout-editor.jpg`](../evidence/three-mode-layout-editor.jpg) |
| caption 模式无画布 | ✅ 代码层 `canvasWrap.hidden = mode === "caption"`，单测断言 |
| 拖框/缩放/加区域/应用/取消/保存重载 | ✅ 无头 Chromium（Playwright）注入验收脚本，真实 ComfyUI 页面一次跑通：[`evidence/three-mode-editor-acceptance.json`](../evidence/three-mode-editor-acceptance.json)。拖框 `[0,0,600,832]→[109,0,709,832]`、缩放 `[600,200,1100,700]→[600,200,1018,608]`；取消后文字与坐标均丢弃；应用写入 `Applied caption.` + 3 区域；caption 模式弹窗无画布；切 hybrid 保留 3 区域；`graph.serialize()` 含 payload，`LGraph.configure()` 重载后 caption/区域数/尺寸完整恢复 |

修复记录：首次自动化拖框无效果，定位到 `pointerdown`/`pointermove` 中调用 `renderBoxes()` 会重建 SVG、把正在接收 pointer 事件的元素换掉（与 Node 2.0 合成点击的 `setPointerCapture` 坑同源）。改为在拖拽期间原地更新 rect/text/handle 属性，并对 `setPointerCapture` 加保护。修复后坐标变化符合预期。

## 4. 测试与证据

| 套件 | 命令 | 结果 | 记录 |
|---|---|---|---|
| Python（180） | `python -m unittest discover -s tests -t .` | OK | `evidence/test-run-three-modes-20261106.txt` |
| JavaScript（40） | `node --test tests_js/*.test.mjs` | 40 pass | `evidence/test-js-three-modes-20261106.txt` |
| 真实模型三模式 | HTTP 路由逐模式调用 | 3/3 OK | §2 |
| PromptBoard 真实编译 | `MOSSPromptBoard.compile` / `MOSSPromptCaption.compile` | 3/3 OK | §1 阶段五 |
| 四比例实图 | PNG 文件头 + `match_canvas_size` | 误差 0 | §1 阶段三 |
| 异常图片链路 | HTTP 400 逐项 | 4/4 | §1 阶段四 |
| 弹窗截图 | 真实 ComfyUI 页面 | 1 张 | `evidence/three-mode-layout-editor.jpg` |

## 5. 已知限制

- 回归实例上第三方扩展偶发自动刷新页面，长链路手工交互不稳定；因此弹窗交互改用无头 Chromium 自动化脚本一次性跑通（证据 JSON 如上），并保留人工截图。
- Magpie `auto/glm-5.3-flash` 偶发 60 s 超时，界面如实报错；重试即可。
- 使用本节点的工作流卸载插件后会报缺失节点（设计已声明，与 PromptBoard 同性质）；侧边栏工作台仍零侵入。
- 布局草稿不含 camera/depth 短语（PromptBoard 节点已有开关），本节点只产出草稿。
