# 设计：反推节点拖入图片时识别自带提示词（含画框）

- 日期：2026-11-15
- 状态：已与用户对齐方向，待批准实现
- 范围：`AIPromptStudioCaption` / `AIPromptStudioImagine` 节点卡片的图片载入路径

## 1. 意图与为什么

用户经常把 AI 生成的成品图直接拖回反推节点，想拿回这张图当初的提示词；如果图里带的是 layout 提示词，还希望画框也一起复原。现在只能靠「预设库 → 导入图片」再手动套用，链路长。

图片元数据里的提示词本来就是这张图的真实出图条件，比重新反推更准确、且不花模型调用。

用户选定交互：**拖入带提示词元数据的图片时，弹一个提示框说明识别到了什么，点一下即覆盖/应用**；图里没有元数据就按普通参考图加载，不打扰。

## 2. 目标 / 非目标 / 反目标

目标：

- 拖入 / 粘贴 / 「换图」三条载入路径，在图片正常显示后自动读取元数据。
- 识别到提示词时弹框，展示识别到的类型（散文 / 布局及画框数 / Danbooru 标签）与尺寸。
- 点「应用」后写入对应槽位；有画框数据时按画布缩放后在底图上标出。
- 元数据缺某类内容时不动该槽位；点「忽略」或关闭弹框则什么都不改。
- 无元数据、解析失败、接口不可用：静默跳过，图片照常加载。

非目标：

- 不做视觉反推（OCR / 看图写词）；只读文件自带元数据。
- 不写入预设库、不新增预设（与「预设库 → 导入图片」分开）。
- 不改全屏工作台（`openLayoutEditor`）内的拖图：那里有自己的草稿副本，节点侧写入会被它后续的「应用」盖回去，需要单独设计。
- 不主动解码 JPEG EXIF UserComment；现实中能读到的主要是 ComfyUI 输出的 PNG 与 A1111 `parameters`。

反目标：

- 不能因为元数据识别失败而阻断换图。
- 不能在没有用户点击的情况下覆盖已有提示词或画框。
- 不能把图片字节写进工作流 `widgets_values`（沿用现有 `last_image_file` 约定）。

## 3. 约束

- 复用既有 `prompt_studio.presets.extract_metadata_from_image`，不重写拓扑回溯。
- 后端纯标准库 + aiohttp + PIL（PIL 已是预设功能的依赖）。
- 单张图片上限沿用 `MAX_PRESET_IMAGE_BYTES = 20 MB`。
- 节点状态结构与现有 `payload` 一致（`caption_text` / `danbooru_prompt` / `layout_prompt` / `draft` / `layout_draft` / `hybrid_draft`）。
- 前端弹框用现有 `.aps-modal-overlay` / `.aps-subdialog-card` 样式，挂 `document.body`。

## 4. 方案对比

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| A. 静默自动填充 | 零点击 | 会覆盖用户正在编辑的内容，违背用户对「自动」的顾虑 | 否 |
| B. 识别后弹框，点一下应用（用户选定） | 明确告知、一次点击覆盖、可忽略 | 每次多一次点击 | **采用** |
| C. 节点内常驻提示条 | 不阻断操作 | 容易被忽略、占用卡片空间、需要新增状态位 | 否 |

## 5. 设计

### 5.1 后端：只读检测接口

新增 `POST /ai_prompt_studio/inspect_image`（`@guarded`，不落库）：

```jsonc
// request
{ "image_data": "data:image/png;base64,...", "filename": "ComfyUI_00012_.png" }

// response
{
  "found": true,
  "name": "图片标题或文件名",
  "width": 832,
  "height": 1216,
  "prompts": { "caption": "...", "layout": "...", "danbooru": "..." },
  "draft": { "width": 1024, "height": 1024, "summary": { "caption": "..." }, "items": [...] }
}
```

- `StudioBackend.inspect_image(body)`：`_decode_image_payload` → `extract_metadata_from_image` → 只挑上述字段返回（丢弃 `thumbnail`、`tags`，避免传输 100KB 级 base64）。
- `found = bool(caption or danbooru or layout or draft.items)`；`draft` 只在有 items 时返回，否则给空 items 骨架。
- 解码/解析失败 → `InvalidRequestError`（400）。前端吞掉该类错误，只 `console.warn`。

### 5.2 前端：检测 + 弹框

新增 `web/lib/image_metadata.js`：

- `imageMetadataSummary(meta)`（纯函数，可测）→ `{ parts: ["散文提示词", "布局提示词（3 个画框）", ...], captionSnippet, hasLayout }`。
- `mergeImageMetadataIntoState(state, meta, { width, height })`（纯函数，可测）→ 把元数据合并进节点 state，返回 `{ applied: [...], boxCount }`：
  - `prompts.caption` → `caption` / `caption_text`；
  - `prompts.danbooru` → `danbooru` / `danbooru_prompt` / `danbooru_text` / `tags`；
  - `prompts.layout` → `layout` / `layout_prompt` / `layout_text`；
  - `draft.items` → 用 `rescaleLayoutDraft(draft, w, h, draft.width || meta.width, draft.height || meta.height)` 换算到当前画布，写入 `draft` / `layout_draft` / `hybrid_draft`；
  - 元数据里没有的类型保持原值；`state.width/height` 不改（保持换图后已跟随的画布）。
- `openImageMetadataDialog({ summary, willOverwrite })` → Promise<boolean>；标题「这张图自带提示词」，正文列出识别结果 + 散文摘要 + 「应用后会覆盖当前节点里的提示词与画框」提示；按钮「应用并覆盖」/「忽略」（节点为空时主按钮文案为「应用提示词」）；Esc / 点遮罩 = 忽略。

### 5.3 接入点

`handleNewReferenceImage`（`web/caption_node.js`）末尾新增 `maybeOfferImageMetadata(node, dataUrl, filename, statusEl)`：

1. 图片已显示、上传、同步上游、画布跟随完成后调用，保证「应用」用的是最终画布尺寸。
2. 检测与上传并行发出（不额外增加等待）；检测失败/超时（10s）直接返回。
3. `found` 为假 → 状态栏一行「这张图没有可识别的提示词元数据，已按普通参考图加载。」，其余不变。
4. `found` 为真 → 弹框；用户确认后：
   - 记录一次 `payload_state` 撤销点（`node._apsUndo.record`）；
   - `mergeImageMetadataIntoState` + `setPayload` + `node._apsDirty = false`；
   - 状态栏「✓ 已应用图片自带提示词：散文 · 布局（3 个画框）」；
   - 用户忽略 → 「已忽略图片自带的提示词。」
5. 工作台路径：`openEditor` 的 `onImageChange` 调用 `handleNewReferenceImage` 时传入 `{ skipMetadata: true }`，避免与工作台草稿副本互相覆盖（见非目标）。

触发范围：节点卡片拖入、粘贴、节点「换图」、以及它们共用的 `handleNewReferenceImage`。上游 LoadImage 自动同步（`hookUpstreamImageNode`）不触发。

### 5.4 覆盖规则（明确）

- 只覆盖元数据里确实存在的槽位；图片只有 caption 时，已有 layout / 画框原样保留。
- 弹框主按钮在节点为空（无 caption / danbooru / 画框）时为「应用提示词」，有内容时为「应用并覆盖」。
- 应用后可撤销一次回到应用前状态。

## 6. 测试

- `tests/test_inspect_image_api.py`（AioHTTPTestCase）：
  - 带 ComfyUI `workflow` 元数据的 PNG → `found=true`，caption/draft items 正确，`thumbnail`/`tags` 不出现在响应里；
  - 纯色无元数据 PNG → `found=false`，draft.items 为空；
  - 非图片字节 → 400。
- `tests_js/image_metadata.test.mjs`：
  - `imageMetadataSummary` 的类型描述与摘要截断；
  - `mergeImageMetadataIntoState` 只改存在槽位、画框按 `draft.width/height → 画布` 缩放、空节点填充 caption；
  - 无 items 时不写 `draft`。
- `tests_js/api.test.mjs`：`inspectImage` 请求路径与 body。
- 手工验收：拖入一张本插件出图（带 layout）→ 弹框显示 3 个画框 → 点应用 → 底图出现框、三个槽位有字；拖入截图 → 只出现「没有元数据」提示，无其它变化。

## 7. 留给实现的选择

- 状态栏无元数据提示是否过于啰嗦：实现时若与既有「已加载参考图」提示冲突，可合并成一句。
- 弹框摘要长度：默认取 caption 前 90 字。