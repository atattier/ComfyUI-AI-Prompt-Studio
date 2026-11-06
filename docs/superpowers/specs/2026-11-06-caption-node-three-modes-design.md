# 设计：反推节点三模式（caption / layout / 混合）+ 尺寸匹配 + 布局编辑弹窗

- 日期：2026-11-06
- 状态：已与用户对齐方案，待批准实现
- 范围：ComfyUI-AI-Prompt-Studio 的图节点 `AIPromptStudioCaption`

## 1. 意图与为什么

现有图节点只能反推出一段文字。用户要的是完整的 MOSS 出图前置流程落在一张节点上：

1. 反推时**读取原图宽高比**，自动匹配 MOSS 官方允许的输出尺寸（用户最初说 32 倍数；核对官方约束后为**每边 256–2048、16 的倍数、总像素 ≤ 2,097,152**——依据 MossTool `mosi.py` 尺寸白名单与官方 `compile_prompt.py` 校验，向用户说明后接受）。
2. 三种**出图方式开关**：caption（纯描述）/ layout（分区域布局 JSON）/ 混合（两者）。只有 layout 与混合模式显示预览框，框可修改。
3. **修改对话框**：双击节点打开弹窗，里面改文字、拖改区域框。

## 2. 目标 / 非目标 / 反目标

目标：
- 一个节点完成「图片 → prompt + 尺寸」，layout 模式产物直接兼容 MossTool 的 Layout 草稿（`width/height/summary/items[{label,caption,bbox}]`），可喂给 ComfyUI-MOSS-PromptBoard 的 `MOSSPromptBoard` 节点编译。
- 弹窗内拖框、加删区域、改描述，写回节点后随工作流保存。
- 所有模式都输出 `width`/`height`（INT，16 的倍数，官方约束内）。

非目标：
- 不做 PromptBoard 编译（那节点已有）；本节点只产出草稿。
- 不做 camera/depth 短语（PromptBoard 节点里已有开关）。
- 侧边栏工作台本次不改。

反目标：
- 不能破坏「卸载插件后侧边栏零残留」的性质（节点是显式使用的，工作流里用了它自然会依赖插件，与 PromptBoard 同一性质）。
- API Key 不进前端；反推走既有后端网关。

## 3. 约束

- 后端纯标准库 + aiohttp；不引入新依赖。
- layout 草稿格式以 MossTool `skills.py` LAYOUT_SYSTEM 与 PromptBoard `draft.py sanitize_layout_draft` 为准：`bbox_coord_space:"abs"`、`bbox_format:"xyxy"`、label ∈ object|character|text、框在画布内。
- 新旧前端（LiteGraph / Node 2.0）都要能用弹窗；弹窗用 DOM 元素挂 document.body，不依赖节点内部绘制事件。

## 4. 方案对比（编辑 UI 落点）

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| A. 双击节点弹窗（DOM overlay） | 交互可靠、新旧前端一致、实现稳 | 多一次点击 | **用户选定** |
| B. 节点画布内自绘预览+拖框 | 少一次点击 | LiteGraph 自绘事件与 Node 2.0 兼容成本高 | 否 |
| C. 侧边栏编辑 | 复用现有面板 | 链路长（节点→侧栏→写回） | 否 |

## 5. 设计

### 5.1 节点接口（改造 `AIPromptStudioCaption`）

```
required:
  mode: ["caption", "layout", "混合"]        # 下拉；默认 caption
  format_note: —（caption 模式内部仍可选 prose/tags/moss？否——见决策 D1）
optional:
  image: IMAGE
  image_path: STRING
  extra_instruction: STRING
  model: STRING
  seed: INT（强制重跑）
RETURN_TYPES = ("STRING", "INT", "INT")
RETURN_NAMES = ("prompt", "width", "height")
```

决策 D1（我的调用）：caption 模式固定用 prose 描述（MOSS 官方 Caption 约定即英文散文）；不再暴露 prose/tags/moss 选择，要 tags 用侧边栏反推。理由：本节点定位是「MOSS 出图前置」，tags 是 SD 工作流的东西，混进来会让 mode 语义混乱。

决策 D2：`width/height` 作为**输出接口**而非 widget——用户明确要「输出接口」。同时节点上显示只读 widget 回显当前值。

### 5.2 尺寸匹配（纯后端，无模型调用）

- 从输入图直接读像素宽高（张量 shape 或图片文件头），算比例。
- 就近匹配：在「每边 256–2048、16 倍数、总像素 ≤ 2,097,152」约束内，按比例选候选集（参考 moss-prompt-studio 白名单 + 程序生成），取**总像素最接近 1,048,576（≈1M）**且长宽比偏差最小者；并列取面积大者。
- 图片过小（<256 边）或比例极端时夹紧到边界并报告所用值。
- 匹配结果进审计日志（event=node_caption）。

### 5.3 三模式的模型指令（新增 `prompt_studio/layout.py`）

- caption：复用现有 prose 指令。
- layout：新指令——让模型输出**严格 JSON**：`{width, height, summary:{caption}, items:[{label, caption, bbox:[x1,y1,x2,y2]}]}`，bbox 用 0–1000 归一化坐标系（模型对绝对像素坐标不可靠，归一化后由代码映射到真实尺寸），label 枚举校验，bbox clamp 进画布。失败重试 1 次，仍失败报错。
- 混合：layout JSON 之上 summary.caption 用完整 prose 描述。

### 5.4 输出内容

- caption 模式：`prompt` = 描述文本；width/height = 匹配尺寸。
- layout 模式：`prompt` = **sanitized Layout 草稿 JSON 字符串**（`bbox_coord_space:"abs"`、真实像素 bbox，可直接粘进 PromptBoard 的 draft 输入）；width/height 与草稿一致。
- 混合模式：`prompt` = 同 layout 的草稿 JSON（summary.caption 为完整描述）——与 layout 输出同构，仅 summary 内容更全。

### 5.5 弹窗与预览框（`web/lib/layout_editor.js` + 节点扩展 JS）

- 节点加一个按钮 widget「编辑布局…」（layout/混合模式可见）+ 「反推」按钮（调后端新路由）。
- 双击/点按钮打开 DOM 弹窗：
  - 上半部：按 width:height 的预览画布，SVG 框渲染 items；拖动=平移，角柄=缩放；点选框高亮对应列表项。
  - 下半部：区域列表（label 下拉、caption 文本框、text 字段仅 text 类型、删除、+加区域）。
  - 「应用」写回节点存储（widget 值为 JSON 字符串，随工作流保存）；「取消」丢弃。
- 预览框仅 layout/混合模式渲染；caption 模式弹窗只有文本编辑。
- 反推按钮走新路由 `POST /ai_prompt_studio/caption_node`（后端跑 5.2+5.3，返回 prompt/width/height/草稿 JSON），避免在前端复制指令逻辑。

### 5.6 文件与测试

| 层 | 文件 | 内容 |
|---|---|---|
| 后端 | `prompt_studio/layout.py` | 尺寸匹配 + layout 指令 + 归一化 bbox→像素 + sanitize |
| 后端 | `prompt_studio/caption_node.py` | mode 参数、三模式分发、输出 width/height |
| 后端 | `prompt_studio/aiohttp_api.py` | `POST /ai_prompt_studio/caption_node` 路由 |
| 前端 | `web/lib/layout_editor.js` | 弹窗、SVG 预览、拖框、列表编辑 |
| 前端 | `web/caption_node.js` | 节点按钮、模式切换显隐、弹窗调用、写回 |
| 测试 | `tests/test_layout.py` | 尺寸匹配（各比例/极端值）、bbox 映射与 clamp、JSON sanitize |
| 测试 | `tests/test_caption_node.py` | 扩展：三模式、width/height 输出 |
| 测试 | `tests/test_aiohttp_api.py` | 新路由用例 |

## 6. 遗留给实现者的决定

- 弹窗样式细节（遵循现有 style.css 变量）。
- 归一化坐标的精度取整。
- 混合模式的英文指令措辞（跑真实模型调优）。

## 7. 验收

1. LoadImage(3:2 图) → 节点自动给出 1216x832（或比例偏差最小的 16 倍数尺寸）。
2. caption 模式输出散文，无预览框。
3. layout 模式输出合法草稿 JSON，弹窗可见可拖框，改后写回并随工作流保存。
4. 混合模式同 3 且 summary 为完整描述。
5. 草稿 JSON 粘进 PromptBoard 节点能编译通过。
6. 155+ 既有测试不回归。
