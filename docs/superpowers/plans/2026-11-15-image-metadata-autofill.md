# 反推节点：图片元数据自动识别 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 往反推节点拖入图片时读取其自带提示词元数据，弹框告知并可一键应用到节点（有 layout 数据则同时复原画框）。

**Architecture:** 后端新增只读接口 `POST /ai_prompt_studio/inspect_image`，复用 `presets.extract_metadata_from_image`，不写数据库。前端新增 `web/lib/image_metadata.js`（纯函数：识别结果摘要、合并进节点 state），`caption_node.js` 在图片载入完成后调用接口并弹框，用户确认后写回 payload。

**Tech Stack:** Python 3 + aiohttp + Pillow（已有依赖）；原生 ES Module 前端；`node:test` / `unittest`。

**Spec:** `docs/superpowers/specs/2026-11-15-image-metadata-autofill-design.md`

## Global Constraints

- 不引入新依赖；后端只用标准库 + aiohttp + PIL。
- 单图上限沿用 `MAX_PRESET_IMAGE_BYTES = 20 * 1024 * 1024`，请求体上限 `MAX_BODY = 25 MB`。
- 检测接口只读：不得写入 `presets` 表、不得新增预设。
- 没有用户点击「应用」时，不得修改节点的任何提示词或画框。
- 元数据里没有的内容（caption / layout / danbooru / draft）保持节点原值。
- 检测失败、图片无元数据、接口不可用，都不能阻断换图；只允许 `console.warn`，不弹错误框。
- 前端模块导入沿用现有版本查询串：`./layout_editor.js?v=20261115_v33`。
- 测试命令：`python -m unittest discover tests`、`node --test tests_js/*.test.mjs`。
- 本计划不包含自动提交：工作区已有大量未提交改动，是否提交由用户决定。

## Review Focus

- **有 layout 但无 caption 的图**：应用后不能把节点原有散文清空。
- **draft 坐标系与图片像素不一致**（节点画布坐标 vs 原图像素）：画框只能缩放到当前画布一次，不能二次缩放。
- **损坏图片 / 后端不可用**：图片照常显示，不弹框、不报错。
- **节点已有内容时拖图**：弹框须说明会覆盖；忽略则节点零变化；应用后可撤销一次。
- **粘贴路径的状态栏**：粘贴后的提示不能覆盖“已应用图片自带提示词”的结果（调用顺序）。

---

### Task 1: 后端只读检测接口

**Files:**
- Modify: `prompt_studio/aiohttp_api.py`（`import_preset_image` 方法之后 ~851 行；`presets/import_image` 路由之后 ~1649 行）
- Test: `tests/test_inspect_image_api.py`（新建）

**Interfaces:**
- Produces: `StudioBackend.inspect_image(body: dict[str, Any]) -> dict[str, Any]`
- Produces: `POST /ai_prompt_studio/inspect_image`，请求 `{image_data, filename?}`，响应：

```jsonc
{
  "found": true,
  "name": "CloudCity_001",
  "width": 800,
  "height": 600,
  "prompts": { "caption": "...", "layout": "...", "danbooru": "..." },
  "draft": { "width": 800, "height": 600, "summary": {...}, "items": [...] }
}
```

- 不返回 `thumbnail`、`tags`、`prompts.stages`。

- [ ] **Step 1: Write the failing test**

新建 `tests/test_inspect_image_api.py`；`Settings` 初始化照抄 `tests/test_preset_api.py`（含临时目录与 `StudioBackend` 生命周期），测试用 PNG 由 PIL 生成：

```python
import base64
import io
import json
import tempfile
import unittest
from pathlib import Path

from aiohttp.test_utils import AioHTTPTestCase
from PIL import Image
from PIL.PngImagePlugin import PngInfo

from prompt_studio.aiohttp_api import StudioBackend, create_app
from prompt_studio.config import Settings


def _png_with_studio_metadata() -> bytes:
    im = Image.new("RGB", (800, 600), color=(30, 60, 90))
    info = PngInfo()
    workflow = {
        "nodes": [{
            "type": "AIPromptStudioCaption",
            "widgets_values": [json.dumps({
                "caption_text": "A futuristic city in the clouds",
                "layout_prompt": "City in lower half, clouds on top",
                "danbooru_prompt": "1scenery, floating city",
                "draft": {
                    "width": 800,
                    "height": 600,
                    "items": [{"label": "云上城市", "box_2d": [200, 100, 800, 500]}],
                },
            })],
        }],
    }
    info.add_text("workflow", json.dumps(workflow))
    buf = io.BytesIO()
    im.save(buf, format="PNG", pnginfo=info)
    return buf.getvalue()


class InspectImageApiTests(AioHTTPTestCase):
    async def get_application(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        home = Path(self.temp_dir.name)
        # Settings 参数与 tests/test_preset_api.py 保持一致
        settings = Settings(...)
        self.backend = StudioBackend(settings)
        return create_app(self.backend)

    def tearDown(self) -> None:
        super().tearDown()
        self.backend.close()
        self.temp_dir.cleanup()

    async def test_inspect_returns_prompts_and_draft_without_thumbnail(self):
        raw = _png_with_studio_metadata()
        resp = await self.client.post(
            "/ai_prompt_studio/inspect_image",
            json={
                "image_data": "data:image/png;base64," + base64.b64encode(raw).decode(),
                "filename": "CloudCity_001.png",
            },
        )
        self.assertEqual(resp.status, 200)
        data = await resp.json()
        self.assertTrue(data["found"])
        self.assertEqual(data["width"], 800)
        self.assertEqual(data["height"], 600)
        self.assertEqual(data["prompts"]["caption"], "A futuristic city in the clouds")
        self.assertEqual(len(data["draft"]["items"]), 1)
        self.assertNotIn("thumbnail", data)
        self.assertNotIn("tags", data)

    async def test_inspect_plain_png_reports_not_found(self):
        buf = io.BytesIO()
        Image.new("RGB", (64, 64), color=(10, 10, 10)).save(buf, format="PNG")
        resp = await self.client.post(
            "/ai_prompt_studio/inspect_image",
            json={"image_data": "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()},
        )
        self.assertEqual(resp.status, 200)
        data = await resp.json()
        self.assertFalse(data["found"])
        self.assertEqual(data["draft"]["items"], [])

    async def test_inspect_rejects_non_image(self):
        resp = await self.client.post(
            "/ai_prompt_studio/inspect_image",
            json={"image_data": base64.b64encode(b"not an image").decode()},
        )
        self.assertEqual(resp.status, 400)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m unittest tests.test_inspect_image_api -v`
Expected: 前两个用例返回 404（路由不存在），第三个 404。

- [ ] **Step 3: Implement `StudioBackend.inspect_image` and the route**

在 `import_preset_image` 之后新增方法（签名与返回键严格按 Interfaces）：

- 用 `from .presets import _decode_image_payload, extract_metadata_from_image` 复用现有解析；`image_data` 缺失 → `InvalidRequestError("image_data is required.")`。
- `except (ValueError, KeyError, OSError)` → `InvalidRequestError(str(err))`（PIL 解不开的图片属于 `OSError`）。
- `found = bool(caption or danbooru or layout or draft.items)`；`prompts` 只输出 caption/layout/danbooru 三个字符串；`draft.width/height` 缺省回落到图片宽高，`items` 恒为列表。

路由放在 `presets/import_image` 路由之后：

```python
@routes.post("/ai_prompt_studio/inspect_image")
@guarded
async def inspect_image_route(request: web.Request) -> web.Response:
    body = await _json_body(request)
    res = await asyncio.to_thread(require().inspect_image, body)
    return web.json_response(res)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m unittest tests.test_inspect_image_api -v`
Expected: 3 passed。

- [ ] **Step 5: 回归预设接口**

Run: `python -m unittest tests.test_preset_api.py -v`
Expected: 全部通过（接口只读，不影响既有预设流程）。

---

### Task 2: 前端纯函数模块 `image_metadata.js`

**Files:**
- Create: `web/lib/image_metadata.js`
- Modify: `web/style.css`（`.aps-image-meta-caption`，放在 `.aps-subdialog-msg` 之后 ~4593 行）
- Test: `tests_js/image_metadata.test.mjs`（新建）

**Interfaces:**
- Consumes: `rescaleLayoutDraft(draft, nextWidth, nextHeight, oldWidth, oldHeight)`，来自 `web/lib/layout_editor.js`。
- Produces:
  - `imageMetadataSummary(meta) -> { parts: string[], captionSnippet: string, hasLayout: boolean, boxCount: number }`
  - `mergeImageMetadataIntoState(state, meta, { width, height } = {}) -> { applied: ("caption"|"layout"|"danbooru"|"boxes")[], boxCount: number }`
  - `openImageMetadataDialog({ summary, willOverwrite = false, imageName = "", width = 0, height = 0 } = {}) -> Promise<boolean>`（返回 `true` = 用户点了应用）

- [ ] **Step 1: Write the failing test**

`tests_js/image_metadata.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  imageMetadataSummary,
  mergeImageMetadataIntoState,
} from "../web/lib/image_metadata.js";

test("summary lists prompt types and box count", () => {
  const summary = imageMetadataSummary({
    prompts: { caption: "A".repeat(120), layout: "{}", danbooru: "1girl, solo" },
    draft: { items: [{}, {}, {}] },
  });
  assert.deepEqual(summary.parts, ["散文提示词", "布局提示词（3 个画框）", "Danbooru 标签"]);
  assert.equal(summary.hasLayout, true);
  assert.equal(summary.boxCount, 3);
  assert.equal(summary.captionSnippet.length, 91); // 90 chars + "…"
});

test("merge only writes slots present in metadata", () => {
  const state = { width: 1024, height: 1024, caption_text: "旧散文", layout_prompt: "旧布局" };
  const result = mergeImageMetadataIntoState(state, {
    width: 800,
    height: 600,
    prompts: { caption: "新散文" },
    draft: { width: 800, height: 600, items: [] },
  });
  assert.deepEqual(result.applied, ["caption"]);
  assert.equal(state.caption_text, "新散文");
  assert.equal(state.layout_prompt, "旧布局");
  assert.equal(state.draft, undefined);
});

test("merge scales boxes once from draft coords to canvas", () => {
  const state = { width: 1024, height: 1024 };
  const meta = {
    width: 512,
    height: 512,
    prompts: { caption: "c", danbooru: "d", layout: "l" },
    draft: {
      width: 512,
      height: 512,
      summary: { caption: "c" },
      items: [{ label: "object", caption: "x", bbox: [100, 100, 400, 400] }],
    },
  };
  const result = mergeImageMetadataIntoState(state, meta, { width: 1024, height: 1024 });
  assert.equal(result.boxCount, 1);
  assert.ok(result.applied.includes("boxes"));
  assert.deepEqual(state.draft.items[0].bbox, [200, 200, 800, 800]);
  assert.equal(state.layout_draft, state.draft);
  assert.equal(state.hybrid_draft.summary.caption, "c");
  assert.equal(state.width, 1024); // 画布尺寸不由合并函数改动
});

test("merge without items leaves existing draft untouched", () => {
  const old = { width: 1024, height: 1024, items: [{ bbox: [1, 2, 3, 4] }] };
  const state = { width: 1024, height: 1024, draft: old, layout_prompt: "旧布局" };
  const result = mergeImageMetadataIntoState(state, {
    width: 1024,
    height: 1024,
    prompts: {},
    draft: { width: 1024, height: 1024, items: [] },
  });
  assert.equal(state.draft, old);
  assert.equal(state.layout_prompt, "旧布局");
  assert.deepEqual(result.applied, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests_js/image_metadata.test.mjs`
Expected: `ERR_MODULE_NOT_FOUND`（模块不存在）。

- [ ] **Step 3: Implement `web/lib/image_metadata.js`**

```js
import { rescaleLayoutDraft } from "./layout_editor.js?v=20261115_v33";
```

`imageMetadataSummary`：
- `parts`：有 `prompts.caption` → `"散文提示词"`；有 `prompts.layout` 或 items → items 非空时 `"布局提示词（N 个画框）"`，否则 `"布局提示词"`；有 `prompts.danbooru` → `"Danbooru 标签"`。
- `captionSnippet` 取 `prompts.caption || draft.summary.caption`，超过 90 字截断并加 `…`。

`mergeImageMetadataIntoState`：
- caption：`prompts.caption || draft.summary.caption`，非空时写 `caption` / `caption_text`；
- danbooru：写 `danbooru` / `danbooru_prompt` / `danbooru_text` / `tags`；
- layout：写 `layout` / `layout_prompt` / `layout_text`；
- items 非空：`srcW = draft.width || meta.width || 当前宽`、`srcH` 同理，`rescaleLayoutDraft(draft, w, h, srcW, srcH)` 后写 `draft` / `layout_draft`；`hybrid_draft` 为 `{...scaled, summary: {...scaled.summary, caption: state.caption_text || state.caption || scaled.summary?.caption || ""}}`；
- 不修改 `state.width/height`；空 meta 返回 `{ applied: [], boxCount: 0 }`。

同文件追加 `openImageMetadataDialog`：

- `typeof document === "undefined"` 时直接 `resolve(false)`（保证 Node 测试可导入本模块）。
- 结构：`.aps-modal-overlay.aps-image-meta-overlay.notranslate` > `.aps-subdialog-card` > `.aps-subdialog-title`（「这张图自带提示词」）、两个 `.aps-subdialog-msg`（第一行 `「文件名」识别到：散文提示词 · 布局提示词（3 个画框）`；有尺寸时 `图片尺寸：800 × 600`）、有摘要时再加 `.aps-image-meta-caption`；`willOverwrite` 时补一句「应用后会覆盖当前节点里的提示词与画框。」
- `.aps-subdialog-foot`：「忽略」（`.aps-btn.aps-btn-sm`）、主按钮文案 `willOverwrite ? "应用并覆盖" : "应用提示词"`（`.aps-btn.aps-btn-sm.aps-primary`）。
- `document.body.append(overlay)`；Esc、点遮罩、忽略 → `resolve(false)`；应用 → `resolve(true)`；两种结局都移除节点并解绑 `keydown`。

`web/style.css` 追加：

```css
.aps-image-meta-caption {
  font-size: var(--aps-text-md);
  line-height: 1.5;
  color: var(--aps-fg);
  border-left: 3px solid var(--aps-accent);
  padding-left: 8px;
  max-height: 5.2em;
  overflow: hidden;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests_js/image_metadata.test.mjs`
Expected: 4 passed。

Run: `node --check web/lib/image_metadata.js`
Expected: 退出码 0。

---

### Task 3: `StudioApi.inspectImage`

**Files:**
- Modify: `web/lib/api.js`（`importPresetImage` 之前 ~324 行）
- Test: `tests_js/api.test.mjs`（追加用例）

**Interfaces:**
- Produces: `StudioApi.prototype.inspectImage({ dataUrl, filename } = {}) -> Promise<object>`，POST 到 `/inspect_image`，body 为 `{ image_data: dataUrl, filename }`。

- [ ] **Step 1: Write the failing test**

追加到 `tests_js/api.test.mjs`：

```js
test("inspectImage posts the data URL to the inspect route", async () => {
  const calls = [];
  const api = new StudioApi({
    fetchImpl: async (url, init) => {
      calls.push([url, init]);
      return jsonResponse({ found: true, prompts: {}, draft: { items: [] } });
    },
  });
  const out = await api.inspectImage({ dataUrl: "data:image/png;base64,AA==", filename: "a.png" });
  assert.equal(out.found, true);
  assert.equal(calls[0][0], "/ai_prompt_studio/inspect_image");
  assert.equal(calls[0][1].method, "POST");
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    image_data: "data:image/png;base64,AA==",
    filename: "a.png",
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests_js/api.test.mjs`
Expected: `api.inspectImage is not a function`。

- [ ] **Step 3: Implement**

```js
inspectImage({ dataUrl, filename = "" } = {}) {
  return this.request("/inspect_image", {
    method: "POST",
    body: { image_data: dataUrl, filename },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests_js/api.test.mjs`
Expected: 全部通过（含原有用例）。

---

### Task 4: 节点接入与弹框

**Files:**
- Modify: `web/caption_node.js`（导入区 ~50 行；`handleNewReferenceImage` ~1145；`openEditor` 的 `onImageChange` ~1429；粘贴处理 ~3471）

**Interfaces:**
- Consumes: `api.inspectImage`（Task 3）、`imageMetadataSummary` / `mergeImageMetadataIntoState` / `openImageMetadataDialog`（Task 2）、`node._apsUndo`、`readPayload` / `setPayload` / `setNodeStatus`。
- Produces: `handleNewReferenceImage(node, fileOrDataUrl, statusEl = null, options = {})`，`options.skipMetadata === true` 时跳过检测。

- [ ] **Step 1: 导入**

在 `caption_node.js` 的 lib 导入区（`./lib/chat_threads.js` 之前）加入：

```js
import {
  imageMetadataSummary,
  mergeImageMetadataIntoState,
  openImageMetadataDialog,
} from "./lib/image_metadata.js?v=20261115_v33";
```

- [ ] **Step 2: 新增 `maybeOfferImageMetadata`**

放在 `handleNewReferenceImage` 之前，签名 `async function maybeOfferImageMetadata(node, meta, filename, statusEl) -> boolean`：

- `!meta?.found` → `setNodeStatus(statusEl, `${statusEl?.textContent || ""} · 未发现提示词元数据`)`（保留原有加载提示），返回 `false`。
- 组装 `summary = imageMetadataSummary(meta)`；`hasContent = Boolean(state.caption_text || state.caption || state.danbooru_prompt || state.danbooru_text || state.tags || state.layout_prompt || state.draft?.items?.length)`，`state = readPayload(node)`。
- `await openImageMetadataDialog({ summary, willOverwrite: hasContent, imageName: filename, width: meta.width, height: meta.height })`；`false` → `setNodeStatus(statusEl, "已忽略图片自带的提示词。")`，返回 `false`。
- 确认后：先 `const before = JSON.stringify(readPayload(node))`；`const next = readPayload(node)`；`const { applied, boxCount } = mergeImageMetadataIntoState(next, meta, { width: Number(next.width) || 1024, height: Number(next.height) || 1024 })`；`node._apsUndo?.record({ key: "payload_state", before, after: "", label: "应用图片自带提示词", source: "stage" })`；`setPayload(node, next)`；`node._apsDirty = false`。
- 状态栏：`✓ 已应用图片自带提示词：${applied 中 caption→散文 / layout→布局 / danbooru→Danbooru，再加上 boxCount ? `${boxCount} 个画框` : ""，用 " · " 连接}`。
- 整段用 `try/catch` 包住，异常只 `console.warn` 并返回 `false`。

- [ ] **Step 3: 接入载入路径**

`handleNewReferenceImage(node, fileOrDataUrl, statusEl = null, options = {})`：

- 在拿到 `dataUrl` 后立即发起（不阻塞上传）：

```js
const detection = options.skipMetadata
  ? null
  : api.inspectImage({ dataUrl, filename: fileObj?.name || "" }).catch((err) => {
      console.warn("[ai-prompt-studio] 图片元数据检测失败:", err);
      return null;
    });
```

- 在函数末尾（原 `statusEl.textContent = ...` 与 `node._apsSyncCard?.()` 之后）执行：

```js
if (detection) {
  const meta = await detection;
  if (meta) await maybeOfferImageMetadata(node, meta, fileObj?.name || "", statusEl);
}
```

- 粘贴处理（~3477 行）把 `statusEl.textContent = "已从剪贴板粘贴并加载参考图！"` 移到 `await handleNewReferenceImage(...)` **之前**，避免覆盖元数据结果。
- `openEditor` 的 `onImageChange` 改为 `void handleNewReferenceImage(node, dataUrl, statusEl, { skipMetadata: true });`（工作台有独立草稿副本，见设计非目标）。

- [ ] **Step 4: 语法与回归检查**

Run: `node --check web/lib/image_metadata.js`
Expected: 无输出、退出码 0。

Run: `node --check web/caption_node.js`
Expected: 无输出、退出码 0。

Run: `node --test tests_js/*.test.mjs`
Expected: 全部通过。

- [ ] **Step 5: 手工验收（ComfyUI 内）**

1. 拖入一张本插件出过图、带 layout 的 PNG → 弹框显示「散文 · 布局（N 个画框）」→ 点「应用并覆盖」→ 三个槽位有字、底图出现 N 个框、状态栏显示已应用。
2. 同一张图在已有内容时点「忽略」→ 节点内容与画框零变化。
3. 应用后点节点「撤销」→ 回到应用前。
4. 拖入普通截图（无元数据）→ 不弹框，状态栏追加「未发现提示词元数据」，图片正常显示。
5. 粘贴一张带元数据的图 → 状态栏保留「已应用图片自带提示词」，不被粘贴提示覆盖。
6. 停掉后端/断网后拖图 → 图片照常显示，无错误弹框，只 console.warn。

---

## 收尾检查

- [ ] `python -m unittest discover tests` 全通过。
- [ ] `node --test tests_js/*.test.mjs` 全通过。
- [ ] `git status` 只出现本计划的文件改动，且未提交（由用户决定）。