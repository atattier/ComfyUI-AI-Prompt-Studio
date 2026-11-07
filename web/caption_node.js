/**
 * Frontend extension for the AIPromptStudioCaption graph node.
 *
 * Upgrades the node into a Rich Interactive Canvas Workbench:
 * - Supports selecting 1 to 3 modes (caption / layout / hybrid) simultaneously,
 *   feeding the node's 3 STRING output ports (`caption_prompt`, `layout_prompt`,
 *   `hybrid_prompt`) plus `width` and `height`.
 * - Hides the raw `payload` JSON textarea widget from cluttering the node while
 *   keeping ComfyUI workflow serialization (`widgets_values`) 100% intact.
 * - Renders an in-node visual stage with the reference image + SVG bounding-box
 *   overlay, multi-mode selector, 3-output-port preview switcher, live editable
 *   prompt, region pills, quick AI actions (反推 / 扩写 / 译英 / MOSS), and an
 *   inline AI instruction input right inside the node.
 * - Double-clicking the node or clicking 「🖥 双栏工作台」 opens the full
 *   Left-Right Dual-Column Studio Workbench.
 */

import { app } from "../../scripts/app.js";

import { StudioApi } from "./lib/api.js";
import { selectOps } from "./lib/diff.js";
import { blobToDataUrl, fileToDataUrl, uploadImageFile, dataUrlToFile } from "./lib/images.js";
import {
  OUTPUT_LANGUAGE_OPTIONS,
  PRESET_RULE_TEMPLATES,
  QUICK_RULE_TEMPLATES,
  RULE_PRESET_OPTIONS,
  normalizeDraft,
  openLayoutEditor,
  openSettingsModal,
  renderSvgStage,
  BOX_COLORS,
} from "./lib/layout_editor.js";
import { UndoStack } from "./lib/undo.js";

const NODE_TYPE = "AIPromptStudioCaption";
const ALL_MODES = ["caption", "layout", "danbooru"];

function formatFriendlyErrorMessage(err, actionName = "操作") {
  const msg = err?.message || String(err || "");
  const status = err?.status;
  if (msg.includes("mode must be one of caption, layout, hybrid") || msg.includes("danbooru")) {
    return "⚠️ 检测到 ComfyUI 正在运行旧版内核内存：请在秋叶启动器中点击一次【一键启动 / 重启内核】，重新加载 Danbooru 模式与新端口即可！";
  }
  if (status === 401 || msg.includes("401") || msg.includes("Unauthorized") || msg.includes("API key")) {
    return "❌ 网关鉴权失败 (401)：API Key 无效或未设置，请点击顶栏「⚙ 设置」配置有效密钥。";
  }
  if (status === 404 || msg.includes("404") || msg.includes("model_not_found")) {
    return "❌ 模型不存在 (404)：当前网关未提供该模型，请在顶栏「⚙ 设置」中重新探测可用模型。";
  }
  if (status === 429 || msg.includes("429") || msg.includes("quota") || msg.includes("rate_limit")) {
    return "❌ 请求受限 (429)：网关并发超限或账户额度耗尽，请稍后重试或检查账户余额。";
  }
  if (status >= 500 || msg.includes("500") || msg.includes("502") || msg.includes("503")) {
    return `❌ 网关服务异常 (${status || 500})：AI 上游网关暂时不可用，请稍后重试。`;
  }
  if (err?.code === "network_error" || msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("无法连接")) {
    return "❌ 网络连接失败：无法连接到 AI 服务网关，请确认网络连接或本地网关服务已开启。";
  }
  return `❌ ${actionName}失败：${msg}`;
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const api = new StudioApi();
const LEGACY_GARBAGE_VALUES = new Set([
  "null",
  "none",
  "undefined",
  "randomize",
  "fixed",
  "increment",
  "decrement",
  "true",
  "false",
]);

function cleanWidgetStr(val, { isPath = false } = {}) {
  const s = String(val ?? "").trim();
  if (!s) return "";
  if (LEGACY_GARBAGE_VALUES.has(s.toLowerCase())) return "";
  if (isPath && /^\d+$/.test(s)) return "";
  return s;
}

function healLegacyWidgets(node) {
  if (!node?.widgets) return;
  const pathW = widget(node, "image_path");
  if (pathW) {
    const cleaned = cleanWidgetStr(pathW.value, { isPath: true });
    if (cleaned !== String(pathW.value ?? "")) pathW.value = cleaned;
  }
  const extraW = widget(node, "extra_instruction");
  if (extraW) {
    const cleaned = cleanWidgetStr(extraW.value);
    if (cleaned !== String(extraW.value ?? "")) extraW.value = cleaned;
  }
  const modelW = widget(node, "model");
  if (modelW) {
    const cleaned = cleanWidgetStr(modelW.value);
    if (cleaned !== String(modelW.value ?? "")) modelW.value = cleaned;
  }
  const modeW = widget(node, "mode");
  if (modeW && !ALL_MODES.includes(String(modeW.value || ""))) {
    modeW.value = "caption";
  }
  for (const m of ALL_MODES) {
    const bw = widget(node, `enable_${m}`);
    if (bw && typeof bw.value !== "boolean") {
      bw.value = m === (modeW?.value || "caption");
    }
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const STYLE_VERSION = "20261107_v7";

function hasNodeSize(node) {
  return Boolean(node?.size && typeof node.size.length === "number" && node.size.length >= 2);
}

function getNodeSize(node) {
  if (hasNodeSize(node)) {
    return [Number(node.size[0]) || 430, Number(node.size[1]) || 480];
  }
  return [430, 480];
}

function setNodeSize(node, w, h) {
  const nextW = Math.max(360, Math.round(Number(w) || 430));
  const nextH = Math.max(360, Math.round(Number(h) || 480));
  if (typeof node?.setSize === "function") {
    node.setSize([nextW, nextH]);
  } else if (hasNodeSize(node)) {
    node.size[0] = nextW;
    node.size[1] = nextH;
  }
  node?.arrange?.();
  node?.setDirtyCanvas?.(true, true);
}

function parseRgbLuminance(cssColor) {
  const m = String(cssColor || "").match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (m) {
    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }
  const hex = String(cssColor || "").trim().replace(/^#/, "");
  if (hex.length === 3 || hex.length === 6) {
    const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
    const num = parseInt(full, 16);
    if (!Number.isNaN(num)) {
      const r = (num >> 16) & 255;
      const g = (num >> 8) & 255;
      const b = num & 255;
      return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    }
  }
  return null;
}

function detectIsLightTheme(elRef) {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return false;
  try {
    const rootStyle = getComputedStyle(elRef || document.documentElement);
    const menuBg = rootStyle.getPropertyValue("--comfy-menu-bg").trim();
    const bgLum = parseRgbLuminance(menuBg);
    if (bgLum !== null) return bgLum > 0.55;
    const fgColor = rootStyle.getPropertyValue("--fg-color").trim();
    const fgLum = parseRgbLuminance(fgColor);
    if (fgLum !== null) return fgLum < 0.45;
    const bodyBg = parseRgbLuminance(getComputedStyle(document.body).backgroundColor);
    if (bodyBg !== null) return bodyBg > 0.55;
  } catch {}
  return false;
}

function mountStyles() {
  if (typeof document === "undefined") return;
  const existing = document.querySelector("link[data-aps-style]");
  if (!existing || existing.dataset.apsStyle !== STYLE_VERSION) {
    existing?.remove();
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = new URL(`./style.css?v=${STYLE_VERSION}`, import.meta.url).href;
    link.dataset.apsStyle = STYLE_VERSION;
    document.head.append(link);
  }
  document.getElementById("aps-critical-v5")?.remove();
  document.getElementById("aps-critical-v6")?.remove();
  if (!document.getElementById("aps-critical-v7")) {
    const style = document.createElement("style");
    style.id = "aps-critical-v7";
    style.textContent = `
      .aps-node-card[data-theme="light"],
      .aps-modal-overlay[data-theme="light"] {
        --aps-fg: #181c22 !important;
        --aps-bg: #ffffff !important;
        --aps-panel: #eaeef4 !important;
        --aps-surface: #f4f6f9 !important;
        --aps-muted: #57606a !important;
        --aps-border: #cfd6e0 !important;
        --aps-accent: #2563eb !important;
        color: #181c22 !important;
        background: #ffffff !important;
      }
      .aps-node-card[data-theme="light"] .aps-node-prompt,
      .aps-node-card[data-theme="light"] .aps-node-chat-input,
      .aps-node-card[data-theme="light"] .aps-input,
      .aps-node-card[data-theme="light"] .aps-select,
      .aps-node-card[data-theme="light"] .aps-region-pill:not(.is-selected),
      .aps-node-card[data-theme="light"] .aps-node-size-badge,
      .aps-node-card[data-theme="light"] .aps-seg-group {
        background: #f4f6f9 !important;
        color: #181c22 !important;
        border-color: #cfd6e0 !important;
      }
      .aps-node-card[data-theme="light"] .aps-node-stage {
        background: #eef2f7 !important;
        border-color: #cfd6e0 !important;
      }
      .aps-node-card[data-theme="light"] .aps-node-rules-panel {
        background: #f1f4f8 !important;
        border-color: #cfd6e0 !important;
      }
      .aps-node-card[data-theme="light"] .aps-node-rules-textarea {
        background: #ffffff !important;
        color: #181c22 !important;
        border-color: #cfd6e0 !important;
      }
      .aps-node-card {
        position: relative !important;
        display: flex !important;
        flex-direction: column !important;
        width: 100% !important;
        box-sizing: border-box !important;
      }
      .aps-node-workspace {
        flex: 1 1 0 !important;
        min-height: 0 !important;
        height: 100% !important;
      }
      .aps-node-card[data-dock="split"] .aps-node-workspace {
        display: grid !important;
        grid-template-rows: minmax(0, 1fr) !important;
        align-items: stretch !important;
      }
      .aps-node-main-col {
        display: flex !important;
        flex-direction: column !important;
        flex: 1 1 0 !important;
        min-height: 0 !important;
        height: 100% !important;
      }
      .aps-node-stage-panel {
        display: flex !important;
        flex-direction: column !important;
        min-height: 0 !important;
      }
      .aps-node-card[data-dock="split"] .aps-node-stage-panel {
        height: 100% !important;
      }
      .aps-node-card[data-dock="left"] .aps-node-stage-panel,
      .aps-node-card[data-dock="right"] .aps-node-stage-panel {
        bottom: auto !important;
      }
      .aps-node-stage {
        flex: 1 1 0 !important;
        min-height: 120px !important;
        height: 100% !important;
      }
      .aps-node-prompt {
        flex: 1 1 0 !important;
        min-height: 90px !important;
        height: 100% !important;
        max-height: none !important;
        resize: none !important;
      }
      .aps-card-resizer {
        position: absolute !important;
        z-index: 25 !important;
        touch-action: none !important;
        user-select: none !important;
      }
      .aps-node-rules-panel {
        display: flex !important;
        flex-direction: column !important;
        gap: 6px !important;
        padding: 8px 10px !important;
        border-radius: 9px !important;
        border: 1px solid var(--aps-border) !important;
        background: color-mix(in srgb, var(--aps-panel) 65%, var(--aps-bg)) !important;
        box-sizing: border-box !important;
        font-size: 11px !important;
      }
      .aps-node-rules-panel[hidden] {
        display: none !important;
      }
      .aps-node-rules-head {
        display: flex !important;
        align-items: center !important;
        justify-content: space-between !important;
        gap: 6px !important;
      }
      .aps-node-rules-title {
        font-size: 11.5px !important;
        font-weight: 700 !important;
        color: var(--aps-fg) !important;
      }
      .aps-node-rules-hint {
        font-size: 10px !important;
        color: var(--aps-muted) !important;
      }
      .aps-node-rules-row {
        display: flex !important;
        align-items: center !important;
        gap: 6px !important;
        flex-wrap: wrap !important;
      }
      .aps-node-rules-grid {
        display: grid !important;
        grid-template-columns: 1.8fr 1.1fr 0.8fr !important;
        gap: 6px !important;
      }
      .aps-node-rules-textarea {
        width: 100% !important;
        min-height: 60px !important;
        max-height: 180px !important;
        resize: vertical !important;
        padding: 5px 7px !important;
        border-radius: 6px !important;
        border: 1px solid var(--aps-border) !important;
        background: var(--aps-surface) !important;
        color: var(--aps-fg) !important;
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace !important;
        font-size: 11px !important;
        line-height: 1.4 !important;
        box-sizing: border-box !important;
      }
      .aps-node-rules-foot {
        display: flex !important;
        align-items: center !important;
        justify-content: space-between !important;
        gap: 6px !important;
        flex-wrap: wrap !important;
      }
      .aps-node-rules-note {
        font-size: 10.5px !important;
        color: var(--aps-muted) !important;
      }
      .aps-node-rules-note[data-kind="ok"] {
        color: var(--aps-add) !important;
      }
      .aps-node-rules-note[data-kind="error"] {
        color: var(--aps-del) !important;
      }
    `;
    document.head.append(style);
  }
}

function widget(node, name) {
  return node.widgets?.find((w) => w.name === name) || null;
}

function normalizeStateObject(raw) {
  if (!raw || typeof raw !== "object") return {};
  const state = { ...raw };
  if ((!state.width || !state.height) && Array.isArray(state.size) && state.size.length === 2) {
    state.width = Number(state.size[0]) || 1024;
    state.height = Number(state.size[1]) || 1024;
  }
  if (!state.caption && state.summary?.caption) {
    state.caption = String(state.summary.caption);
  }
  if (!state.draft?.items?.length && Array.isArray(state.regions) && state.regions.length > 0) {
    const w = Number(state.width) || 1024;
    const h = Number(state.height) || 1024;
    state.draft = normalizeDraft(
      {
        width: w,
        height: h,
        summary: { caption: state.caption || "A composed image.", canvas: "single" },
        items: state.regions,
      },
      w,
      h,
    );
  }
  return state;
}

function setPayload(node, state) {
  const w = widget(node, "payload");
  if (!w) throw new Error("节点缺少 payload 控件。");
  const normalized = normalizeStateObject(state);
  w.value = JSON.stringify(normalized);
  node._apsDirty = false;
  node._apsSyncCard?.();
  node.setDirtyCanvas?.(true, true);
}

function readPayload(node) {
  const w = widget(node, "payload");
  try {
    const parsed = JSON.parse(w?.value || "{}");
    return normalizeStateObject(parsed);
  } catch {
    return {};
  }
}

function currentMode(node) {
  let val = String(widget(node, "mode")?.value || "caption").trim().toLowerCase();
  if (val === "hybrid") val = "danbooru";
  return ALL_MODES.includes(val) ? val : "caption";
}

function currentModes(node) {
  const primary = currentMode(node);
  const state = readPayload(node);
  const wCap = widget(node, "enable_caption");
  const wLay = widget(node, "enable_layout");
  const wDan = widget(node, "enable_danbooru") || widget(node, "enable_hybrid");

  const selected = new Set();
  if (wCap != null || wLay != null || wDan != null) {
    if (wCap?.value) selected.add("caption");
    if (wLay?.value) selected.add("layout");
    if (wDan?.value) selected.add("danbooru");
  } else if (Array.isArray(state.modes) && state.modes.length) {
    for (const m of state.modes) {
      const canonical = m === "hybrid" ? "danbooru" : m;
      if (ALL_MODES.includes(canonical)) selected.add(canonical);
    }
  }
  selected.add(primary);
  return ALL_MODES.filter((m) => selected.has(m));
}

function syncModeWidgets(node, modesList, primaryMode) {
  let primary = primaryMode || currentMode(node);
  if (primary === "hybrid") primary = "danbooru";
  const canonicalModes = (modesList || [primary]).map((m) => (m === "hybrid" ? "danbooru" : m));
  const set = new Set(canonicalModes);
  set.add(primary);
  const ordered = ALL_MODES.filter((m) => set.has(m));

  const mw = widget(node, "mode");
  if (mw && mw.value !== primary) {
    mw.value = primary;
    mw.callback?.(primary);
  }
  for (const m of ALL_MODES) {
    const bw = widget(node, `enable_${m}`);
    if (bw) bw.value = ordered.includes(m);
  }
  const oldHyb = widget(node, "enable_hybrid");
  if (oldHyb) oldHyb.value = ordered.includes("danbooru");

  const state = readPayload(node);
  if (state && typeof state === "object") {
    state.mode = primary;
    state.modes = ordered;
    const pw = widget(node, "payload");
    if (pw) pw.value = JSON.stringify(state);
  }
  node._apsSyncCard?.();
  node.setDirtyCanvas?.(true, true);
}

function setModeWidget(node, nextMode) {
  const modes = currentModes(node);
  if (!modes.includes(nextMode)) modes.push(nextMode);
  syncModeWidgets(node, modes, nextMode);
}

function toggleModeSelection(node, targetMode) {
  const primary = currentMode(node);
  const modes = currentModes(node);
  const has = modes.includes(targetMode);
  let nextModes;
  let nextPrimary = primary;
  if (has) {
    if (modes.length <= 1) return; // keep at least 1 mode enabled
    nextModes = modes.filter((m) => m !== targetMode);
    if (primary === targetMode) {
      nextPrimary = nextModes[0];
    }
  } else {
    nextModes = [...modes, targetMode];
  }
  syncModeWidgets(node, nextModes, nextPrimary);
}


/** Find upstream LoadImage node if connected to our IMAGE input. */
function getUpstreamLoadImageNode(node) {
  const link = node.inputs?.find((i) => i.name === "image" && i.link != null);
  if (!link) return null;
  const graph = node.graph;
  const sourceLink = graph?.links?.get
    ? graph.links.get(link.link)
    : Array.isArray(graph?.links)
      ? graph.links.find((l) => l && l.id === link.link)
      : graph?.links?.[link.link];
  if (!sourceLink) return null;
  const sourceId = sourceLink.origin_id ?? sourceLink[1];
  const source = graph?.getNodeById
    ? graph.getNodeById(sourceId)
    : (graph?._nodes || []).find((n) => String(n.id) === String(sourceId));
  if (!source) return null;
  if (source.type === "LoadImage" || source.widgets?.some((w) => w.name === "image")) {
    return source;
  }
  return null;
}

/** Robust reference image switcher: uploads to ComfyUI, syncs upstream LoadImage, and persists to node state. */
async function handleNewReferenceImage(node, fileOrDataUrl, statusEl = null) {
  if (!fileOrDataUrl) return;

  let dataUrl = "";
  let fileObj = null;

  if (typeof fileOrDataUrl === "string") {
    dataUrl = fileOrDataUrl;
    try {
      fileObj = dataUrlToFile(dataUrl, `ref_${Date.now()}.png`);
    } catch {
      fileObj = null;
    }
  } else if (fileOrDataUrl instanceof File || fileOrDataUrl instanceof Blob) {
    fileObj = fileOrDataUrl;
    dataUrl = await fileToDataUrl(fileObj);
  }

  if (!dataUrl) return;

  // 1. Immediately display on stage
  node._apsImageDataUrl = dataUrl;
  node._apsSyncCard?.();

  // 2. Persistently upload image to ComfyUI /upload/image
  let serverFilename = fileObj?.name || `ref_${Date.now()}.png`;
  if (fileObj) {
    try {
      serverFilename = await uploadImageFile(fileObj);
    } catch (err) {
      console.warn("上传到 ComfyUI input 失败，继续使用本地数据:", err);
    }
  }

  // 3. Bi-directionally sync upstream LoadImage node if connected
  const upstream = getUpstreamLoadImageNode(node);
  if (upstream) {
    const imgWidget = upstream.widgets?.find((w) => w.name === "image");
    if (imgWidget) {
      imgWidget.value = serverFilename;
      if (typeof imgWidget.callback === "function") {
        imgWidget.callback(serverFilename);
      }
      upstream.setDirtyCanvas?.(true, true);
    }
  }

  // 4. Save to persistent state so F5 refresh or restart won't reset to example.png
  const state = readPayload(node);
  state.last_image_file = serverFilename;
  node._apsLastUpstreamFile = serverFilename;
  writePayload(node, state);

  if (statusEl) {
    statusEl.textContent = upstream
      ? `已加载参考图并同步上游节点：${serverFilename}`
      : `已加载参考图：${serverFilename}`;
  }
  node._apsSyncCard?.();
}

/** Find the LoadImage node feeding our IMAGE input and read its filename widget. */
function upstreamImageFile(node) {
  const link = node.inputs?.find((i) => i.name === "image" && i.link != null);
  if (!link) return null;
  const graph = node.graph;
  const sourceLink = graph?.links?.get
    ? graph.links.get(link.link)
    : Array.isArray(graph?.links)
      ? graph.links.find((l) => l && l.id === link.link)
      : graph?.links?.[link.link];
  if (!sourceLink) return null;
  const sourceId = sourceLink.origin_id ?? sourceLink[1];
  const source = graph?.getNodeById
    ? graph.getNodeById(sourceId)
    : (graph?._nodes || []).find((n) => String(n.id) === String(sourceId));
  if (!source) return null;
  const fileWidget = source.widgets?.find((w) => w.name === "image");
  const value = fileWidget?.value;
  if (!value || typeof value !== "string") return null;
  return value;
}

async function fetchImageDataUrl(node) {
  const filename = upstreamImageFile(node);
  if (!filename) return node._apsImageDataUrl || null;
  if (node._apsLastUpstreamFile === filename && node._apsImageDataUrl) {
    return node._apsImageDataUrl;
  }
  const query = new URLSearchParams({ filename, type: "input" });
  const response = await fetch(`/view?${query.toString()}`, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`读取上游图片失败（HTTP ${response.status}）。`);
  const blob = await response.blob();
  if (blob.size > MAX_IMAGE_BYTES) {
    throw new Error(`图片过大（${Math.round(blob.size / 1024 / 1024)} MB），上限 8 MB。`);
  }
  if (!String(blob.type || "").startsWith("image/")) {
    throw new Error("上游节点输出的不是图片。");
  }
  const dataUrl = await blobToDataUrl(blob);
  node._apsLastUpstreamFile = filename;
  node._apsImageDataUrl = dataUrl;
  return dataUrl;
}

async function runCaption(node, statusEl) {
  healLegacyWidgets(node);
  const mode = currentMode(node);
  const modes = currentModes(node);
  const pathWidget = widget(node, "image_path");
  const imagePath = cleanWidgetStr(pathWidget?.value, { isPath: true });
  const existing = readPayload(node);
  // 编辑保护：用户手改过内容时，不静默覆盖。
  if (node._apsDirty && (existing.caption || existing.draft)) {
    if (!globalThis.confirm?.("已手动编辑过反推结果，重新反推会覆盖修改。继续吗？")) return;
  }
  statusEl.textContent = `正在反推图片（模式：${modes.join(" + ")}）…`;
  node._apsSetBusy?.(true);
  try {
    const imageData = await fetchImageDataUrl(node);
    if (!imageData && !imagePath) {
      throw new Error("请连接 LoadImage 节点、在节点内上传图片，或填写本地 image_path。");
    }
    const body = {
      mode,
      modes,
      image_path: imagePath,
      extra_instruction: cleanWidgetStr(widget(node, "extra_instruction")?.value),
      model: cleanWidgetStr(widget(node, "model")?.value),
      session_id: node._apsSessionId || undefined,
      create_session: true,
    };
    if (imageData) body.image = { data_url: imageData };
    const result = await api.request("/caption_node", { method: "POST", body });
    if (result.session_id) node._apsSessionId = result.session_id;
    const prevText = String(existing.caption || existing.draft?.summary?.caption || "");
    const state = result.payload || {};
    state.mode = mode;
    state.modes = result.modes || modes;
    setPayload(node, state);
    if (prevText !== String(state.caption || "")) {
      node._apsUndo?.record({
        key: "caption",
        before: prevText,
        after: String(state.caption || ""),
        label: `反推 (${modes.join("+")})`,
        source: "caption",
      });
    }
    statusEl.textContent = `反推完成（${modes.length}个格式已就绪）：${result.width}×${result.height}`;
    node._apsSyncCard?.();
    node.setDirtyCanvas?.(true, true);
  } catch (err) {
    statusEl.textContent = formatFriendlyErrorMessage(err, "反推");
  } finally {
    node._apsSetBusy?.(false);
  }
}

async function openEditor(node, statusEl) {
  healLegacyWidgets(node);
  const mode = currentMode(node);
  const state = readPayload(node);
  if (!state.width || !state.height) {
    state.width = 1024;
    state.height = 1024;
    state.caption = state.caption || "";
  }
  state.modes = currentModes(node);
  let imageUrl = node._apsImageDataUrl || null;
  if (!imageUrl) {
    try {
      imageUrl = await fetchImageDataUrl(node);
    } catch {
      imageUrl = null;
    }
  }
  const pathVal = cleanWidgetStr(widget(node, "image_path")?.value, { isPath: true });
  if (pathVal) state.image_path = pathVal;

  openLayoutEditor({
    state,
    mode,
    imageUrl,
    api,
    sessionId: node._apsSessionId || null,
    onSessionChange: (sid) => {
      node._apsSessionId = sid;
    },
    onImageChange: (dataUrl) => {
      void handleNewReferenceImage(node, dataUrl, statusEl);
    },
    onApply: (next) => {
      const resolvedMode = next.mode || mode;
      const resolvedModes = Array.isArray(next.modes) && next.modes.length ? next.modes : currentModes(node);
      delete next.image_path;
      syncModeWidgets(node, resolvedModes, resolvedMode);
      if (next.draft?.items?.length) {
        next.layout_draft = next.draft;
        next.hybrid_draft = {
          ...next.draft,
          summary: {
            ...(next.draft.summary || {}),
            caption: next.caption_text || next.caption || next.draft.summary?.caption || "",
          },
        };
      }
      setPayload(node, next);
      node._apsDirty = true; // manual edit: 反推 will ask before overwriting
      statusEl.textContent = "编辑已应用，已写入节点（随工作流保存）。";
      node._apsSyncCard?.();
      node.setDirtyCanvas?.(true, true);
    },
    onCancel: () => {
      statusEl.textContent = "已取消编辑，修改未应用。";
    },
  });
}

function openNodeSettings(node, statusEl) {
  healLegacyWidgets(node);
  openSettingsModal({
    api,
    nodeOverrides: {
      extra_instruction: cleanWidgetStr(widget(node, "extra_instruction")?.value),
      model: cleanWidgetStr(widget(node, "model")?.value),
    },
    onSaved: (cfg, nodeRes) => {
      if (nodeRes) {
        const extraW = widget(node, "extra_instruction");
        if (extraW) extraW.value = nodeRes.extra_instruction || "";
        const modelW = widget(node, "model");
        if (modelW) modelW.value = nodeRes.model || "";
      }
      node._apsActiveConfig = cfg || null;
      if (cfg) node._apsFillRules?.(cfg);
      node._apsSyncCard?.();
      node.setDirtyCanvas?.(true, true);
      statusEl.textContent = `✓ 设置已保存（模型：${nodeRes?.model || cfg?.model || "默认"} · 规则：${cfg?.rule_preset || "moss"}）`;
    },
  });
}

/** Collapse raw widgets so only the Rich Studio Card is shown in ComfyUI. */
function hideRawWidgets(node) {
  healLegacyWidgets(node);
  const alwaysHide = new Set(["payload", "enable_caption", "enable_layout", "enable_hybrid"]);
  const isBrowser = typeof document !== "undefined";

  for (const w of node.widgets || []) {
    if (!w || w.name === "aps_studio_card") continue;
    if (!isBrowser && !alwaysHide.has(w.name)) continue;
    w._apsHidden = true;
    w.hidden = true;
    if (w.options && typeof w.options === "object") {
      w.options.hidden = true;
    }
    if (w.visibility?.suppression) {
      w.visibility.suppression.byExtension = true;
    }
    if (w._visibility?.suppression) {
      w._visibility.suppression.byExtension = true;
    }
    w.computeSize = () => [0, -4];
    w.computeLayoutSize = () => ({ minHeight: 0, maxHeight: 0, minWidth: 0 });
    w.draw = () => {};
    if (w.inputEl) {
      w.inputEl.style.display = "none";
      if (w.inputEl.parentElement) {
        w.inputEl.parentElement.style.display = "none";
      }
    }
    if (w.element) {
      w.element.style.display = "none";
    }
  }
  const mw = widget(node, "mode");
  if (mw && !mw._apsHooked) {
    mw._apsHooked = true;
    const orig = mw.callback;
    mw.callback = function (...args) {
      const r = orig?.apply(this, args);
      const nextM = mw.value || "caption";
      const modes = currentModes(node);
      if (!modes.includes(nextM)) modes.push(nextM);
      syncModeWidgets(node, modes, nextM);
      return r;
    };
  }
}

/** Read the active prompt text for the currently selected mode on the node card. */
function activePromptForMode(state, mode) {
  if (mode === "caption") {
    return String(state.caption_text || state.caption || state.draft?.summary?.caption || "");
  }
  if (mode === "layout") {
    return String(
      state.layout_draft?.summary?.caption ||
        state.draft?.summary?.caption ||
        state.caption ||
        "",
    );
  }
  // danbooru / hybrid
  return String(
    state.danbooru_prompt ||
      state.danbooru_text ||
      state.tags ||
      state.hybrid_draft?.summary?.caption ||
      state.caption_text ||
      state.caption ||
      "",
  );
}

/** Write edited text back into the corresponding mode slot of `state`. */
function writePromptForMode(state, mode, nextVal) {
  state.caption = nextVal;
  if (mode === "caption") {
    state.caption_text = nextVal;
    if (state.hybrid_draft?.summary) state.hybrid_draft.summary.caption = nextVal;
  } else if (mode === "layout") {
    if (state.layout_draft?.summary) state.layout_draft.summary.caption = nextVal;
    if (state.draft?.summary) state.draft.summary.caption = nextVal;
  } else {
    state.danbooru_prompt = nextVal;
    state.danbooru_text = nextVal;
    state.tags = nextVal;
    if (state.hybrid_draft?.summary) state.hybrid_draft.summary.caption = nextVal;
    if (state.draft?.summary) state.draft.summary.caption = nextVal;
  }
}

function clampVal(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function svgCoords(svg, ev, w, h) {
  const rect = svg.getBoundingClientRect();
  if (!rect.width || !rect.height) return [0, 0];
  const scale = Math.min(rect.width / w, rect.height / h);
  const drawW = w * scale;
  const drawH = h * scale;
  const offX = (rect.width - drawW) / 2;
  const offY = (rect.height - drawH) / 2;
  const x = ((ev.clientX - rect.left - offX) / drawW) * w;
  const y = ((ev.clientY - rect.top - offY) / drawH) * h;
  return [clampVal(Math.round(x), 0, w), clampVal(Math.round(y), 0, h)];
}

/** Build the Rich In-Node Studio Card inside the ComfyUI node. */
function mountRichCard(node, statusEl) {
  if (typeof document === "undefined" || node._apsCardMounted) return;
  if (typeof node.addDOMWidget !== "function") return;
  node._apsCardMounted = true;
  mountStyles();
  node._apsUndo = node._apsUndo || new UndoStack({ limit: 30 });

  let dockMode = "right"; // "left" (节点左侧外挂) | "right" (节点右侧外挂) | "split" (节点内左右双栏)
  try {
    const savedDock = globalThis.localStorage?.getItem("aps_node_dock_mode");
    if (["left", "right", "split"].includes(savedDock)) dockMode = savedDock;
  } catch {}

  const defaultStageBox = {
    width: 420,
    height: 450,
    offsetX: 0,
    offsetY: 0,
    splitRatio: 0.52,
    customHeight: false,
  };
  let stageBox = { ...defaultStageBox };
  try {
    const rawBox = globalThis.localStorage?.getItem("aps_node_stage_box");
    if (rawBox) {
      const parsed = JSON.parse(rawBox);
      stageBox = {
        width: clampVal(Number(parsed.width) || 420, 260, 1200),
        height: clampVal(Number(parsed.height) || 450, 240, 1100),
        offsetX: clampVal(Number(parsed.offsetX) || 0, -900, 900),
        offsetY: clampVal(Number(parsed.offsetY) || 0, -700, 700),
        splitRatio: clampVal(Number(parsed.splitRatio) || 0.52, 0.25, 0.78),
        customHeight: Boolean(parsed.customHeight),
      };
    }
  } catch {}
  function saveStageBox() {
    try {
      globalThis.localStorage?.setItem("aps_node_stage_box", JSON.stringify(stageBox));
    } catch {}
  }

  let selectedRegion = 0;
  let dimStageImage = false;

  const card = el("div", "aps-node-card notranslate");
  card.setAttribute("translate", "no");

  // Stop LiteGraph canvas drag when interacting with side wing or controls
  for (const evtName of ["pointerdown", "mousedown", "dblclick", "contextmenu", "wheel"]) {
    card.addEventListener(evtName, (ev) => {
      ev.stopPropagation();
    });
  }

  // 1) Top Bar: Multi-mode check+preview buttons + All-3 toggle + Dock position switcher + Settings + Workbench
  const topBar = el("div", "aps-node-topbar");
  const modeGroup = el("div", "aps-seg-group aps-seg-sm");
  const modeBtns = {};
  const modeChecks = {};
  for (const [mKey, mLabel, mPort] of [
    ["caption", "散文", "caption_prompt"],
    ["layout", "布局", "layout_prompt"],
    ["danbooru", "Danbooru", "danbooru_prompt"],
  ]) {
    const b = el("button", "aps-seg-btn aps-mode-multi-btn");
    b.type = "button";
    b.title = `左键勾选框：启用/关闭 ${mPort} 输出（支持同时勾选 1~3 个格式）\n左键文字：切换当前预览到「${mLabel}」`;

    const chk = el("span", "aps-mode-check", "☑");
    chk.addEventListener("click", (ev) => {
      ev.stopPropagation();
      toggleModeSelection(node, mKey);
    });
    const lbl = el("span", "aps-mode-label", mLabel);
    b.append(chk, lbl);
    b.addEventListener("click", () => setModeWidget(node, mKey));
    modeBtns[mKey] = b;
    modeChecks[mKey] = chk;
    modeGroup.append(b);
  }

  const allModesBtn = el("button", "aps-chip-btn", "3格式全开");
  allModesBtn.type = "button";
  allModesBtn.title = "点击切换：开启全部 3 个格式 / 仅保留当前单个格式";
  allModesBtn.addEventListener("click", () => {
    const curModes = currentModes(node);
    const curActive = currentMode(node);
    if (curModes.length === ALL_MODES.length) {
      // Toggle off: keep only currently active mode
      syncModeWidgets(node, [curActive], curActive);
      const nameMap = { caption: "散文", layout: "布局", danbooru: "Danbooru" };
      statusEl.textContent = `已关闭 3 格式全开，当前仅输出【${nameMap[curActive] || curActive}】。`;
    } else {
      // Toggle on: open all 3 formats
      syncModeWidgets(node, ["caption", "layout", "danbooru"], curActive);
      statusEl.textContent = "已开启全部 3 个输出格式（散文 + 布局 + Danbooru）。";
    }
    syncCard();
    node.setDirtyCanvas?.(true, true);
  });

  // Dock Position Switcher: Left Wing / Right Wing / Split Inside
  const dockGroup = el("div", "aps-seg-group aps-seg-sm aps-dock-switch");
  const dockBtns = {};
  for (const [dKey, dLabel, dTip] of [
    ["left", "◧ 左翼", "将大号布局画框挂在节点的【左侧】外部"],
    ["right", "◨ 右翼", "将大号布局画框挂在节点的【右侧】外部"],
    ["split", "▣ 内嵌", "将布局画框嵌入节点内部作为左右分栏"],
  ]) {
    const db = el("button", "aps-seg-btn", dLabel);
    db.type = "button";
    db.title = dTip;
    db.addEventListener("click", () => {
      dockMode = dKey;
      try {
        globalThis.localStorage?.setItem("aps_node_dock_mode", dKey);
      } catch {}
      applyDockMode();
      syncCard();
    });
    dockBtns[dKey] = db;
    dockGroup.append(db);
  }

  const rulesToggleBtn = el("button", "aps-btn aps-btn-sm aps-node-rules-btn", "📐 规则偏好");
  rulesToggleBtn.type = "button";
  rulesToggleBtn.title = "在节点主面板展开/收起提示词规则与反推偏好设置";

  const settingsBtn = el("button", "aps-btn aps-btn-sm aps-node-settings-btn", "⚙ 设置");
  settingsBtn.type = "button";
  settingsBtn.title = "配置模型网关（Base URL / API Key / 模型选择）与提示词规则";
  settingsBtn.addEventListener("click", () => openNodeSettings(node, statusEl));

  const expandBtn = el("button", "aps-btn aps-btn-sm aps-accent aps-node-wb-btn", "🖥 工作台");
  expandBtn.type = "button";
  expandBtn.title = "打开全屏左右双栏精细工作台（大图画框 + 多轮对话改词）";
  expandBtn.addEventListener("click", () => openEditor(node, statusEl));
  topBar.append(modeGroup, allModesBtn, dockGroup, rulesToggleBtn, settingsBtn, expandBtn);

  // 2) Main Workspace Split Container (holds Stage Panel + Main Prompt Column)
  const workspaceWrap = el("div", "aps-node-workspace");

  // ---- Stage Panel (can dock outside Left, outside Right, or Split inside) ----
  const stagePanel = el("div", "aps-node-stage-panel");

  let domWidget = null;

  function computeTargetCardHeight() {
    const [, nodeH] = getNodeSize(node);
    const widgetY = (domWidget && Number(domWidget.y || domWidget.last_y)) || 108;
    return Math.max(260, Math.round(nodeH - widgetY - 16));
  }

  function ensureParentOverflowVisible() {
    card.dataset.theme = detectIsLightTheme(card) ? "light" : "dark";
    let p = card.parentElement;
    let depth = 0;
    while (p && p !== document.body && depth < 5) {
      if (p.style) {
        p.style.overflow = "visible";
        p.style.contain = "none";
        if (depth === 0) {
          p.style.display = "flex";
          p.style.flexDirection = "column";
        }
      }
      p = p.parentElement;
      depth++;
    }
  }

  function applyStageGeometry() {
    const targetCardH = computeTargetCardHeight();
    card.style.setProperty("height", `${targetCardH}px`, "important");
    card.style.setProperty("min-height", `${targetCardH}px`, "important");
    if (domWidget) {
      domWidget.computedHeight = targetCardH + 16;
    }

    if (dockMode === "split") {
      stagePanel.style.removeProperty("width");
      stagePanel.style.removeProperty("height");
      stagePanel.style.removeProperty("bottom");
      stagePanel.style.transform = "";
      const ratio = clampVal(Number(stageBox.splitRatio) || 0.52, 0.22, 0.8);
      workspaceWrap.style.gridTemplateColumns = `minmax(240px, ${ratio.toFixed(3)}fr) minmax(240px, ${(1 - ratio).toFixed(3)}fr)`;
    } else {
      workspaceWrap.style.gridTemplateColumns = "";
      const effectiveStageW = clampVal(Number(stageBox.width) || 420, 260, 1600);
      const effectiveStageH = stageBox.customHeight
        ? clampVal(Number(stageBox.height) || 450, 220, 1600)
        : Math.max(clampVal(Number(stageBox.height) || 450, 220, 1600), targetCardH + 38);
      stagePanel.style.setProperty("width", `${effectiveStageW}px`, "important");
      stagePanel.style.setProperty("height", `${effectiveStageH}px`, "important");
      stagePanel.style.setProperty("bottom", "auto", "important");
      stagePanel.style.transform =
        stageBox.offsetX || stageBox.offsetY
          ? `translate(${stageBox.offsetX}px, ${stageBox.offsetY}px)`
          : "";
    }
  }
  const stageHeader = el("div", "aps-node-stage-head");
  stageHeader.title = "按住此标题栏可自由拖动布局画框位置；拖拽画框四边或四角可自由调整大小；双击标题复位";
  const stageTitle = el("span", "aps-node-stage-title", "📐 布局画框");
  const sizeBadge = el("span", "aps-node-size-badge", "1024×1024");
  const stageTools = el("div", "aps-node-stage-tools");

  const addBoxBtn = el("button", "aps-chip-btn", "+ 加框");
  addBoxBtn.type = "button";
  addBoxBtn.title = "在画布中心新增一个区域框";
  addBoxBtn.addEventListener("click", () => {
    const state = readPayload(node);
    const w = Number(state.width) || 1024;
    const h = Number(state.height) || 1024;
    const draft = normalizeDraft(state.draft, w, h);
    draft.items.push({
      label: "object",
      caption: `Region ${draft.items.length + 1}`,
      bbox: [Math.round(w * 0.2), Math.round(h * 0.2), Math.round(w * 0.8), Math.round(h * 0.8)],
    });
    selectedRegion = draft.items.length - 1;
    commitDraftToState(state, draft, w, h, true, `新增区域 #${draft.items.length}`);
    statusEl.textContent = `已新增区域 #${draft.items.length}，可直接拖拽调整。`;
  });

  const stageUndoBtn = el("button", "aps-chip-btn", "↩ 撤销");
  stageUndoBtn.type = "button";
  stageUndoBtn.title = "撤销上一步画框操作（加框/移动/缩放/删除/改字等）";
  stageUndoBtn.disabled = true;
  stageUndoBtn.addEventListener("click", () => handleUndo());

  const dimImgBtn = el("button", "aps-chip-btn", "◐ 暗底");
  dimImgBtn.type = "button";
  dimImgBtn.title = "压暗参考图背景，使彩色布局框更清晰";
  dimImgBtn.addEventListener("click", () => {
    dimStageImage = !dimStageImage;
    dimImgBtn.classList.toggle("is-accent", dimStageImage);
    syncCard();
  });

  const fileInput = el("input", "");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileInput.hidden = true;
  const uploadMiniBtn = el("button", "aps-chip-btn", "📂 换图");
  uploadMiniBtn.type = "button";
  uploadMiniBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    fileInput.click();
  });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    try {
      await handleNewReferenceImage(node, file, statusEl);
    } catch (err) {
      statusEl.textContent = String(err?.message || err);
    }
  });


  const resetStageBtn = el("button", "aps-chip-btn", "↺");
  resetStageBtn.type = "button";
  resetStageBtn.title = "复位布局画框的默认大小与位置";
  resetStageBtn.addEventListener("click", () => {
    stageBox = { ...defaultStageBox };
    saveStageBox();
    applyStageGeometry();
    statusEl.textContent = "已复位布局画框默认大小与位置。";
  });

  stageTools.append(addBoxBtn, stageUndoBtn, dimImgBtn, uploadMiniBtn, resetStageBtn, fileInput);
  stageHeader.append(stageTitle, sizeBadge, stageTools);

  const stageWrap = el("div", "aps-node-stage");
  const svgNS = "http://www.w3.org/2000/svg";
  const stageSvg = document.createElementNS(svgNS, "svg");
  stageSvg.setAttribute("viewBox", "0 0 1024 1024");
  stageSvg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  stageSvg.className.baseVal = "aps-node-svg";
  stageWrap.append(stageSvg);
  stageWrap.title = "直接拖拽画框调整位置/大小；双击打开全屏双栏工作台";
  stageWrap.addEventListener("dblclick", () => openEditor(node, statusEl));

  // Direct Drag / Resize on stageSvg inside the node/wing!
  let dragCtx = null;
  stageSvg.addEventListener("pointerdown", (ev) => {
    ev.stopPropagation();
    const state = readPayload(node);
    const w = Number(state.width) || 1024;
    const h = Number(state.height) || 1024;
    if (!state.draft?.items?.length) return;
    const origStateJson = JSON.stringify(readPayload(node));
    const resizeAttr = ev.target?.getAttribute?.("data-resize");
    const groupEl = ev.target?.closest?.("g[data-index]");
    if (resizeAttr != null) {
      const idx = Number(resizeAttr);
      if (!state.draft.items[idx]) return;
      selectedRegion = idx;
      dragCtx = {
        kind: "resize",
        idx,
        w,
        h,
        state,
        orig: [...state.draft.items[idx].bbox],
        origStateJson,
      };
      stageSvg.setPointerCapture?.(ev.pointerId);
      ev.preventDefault();
      syncCard();
    } else if (groupEl) {
      const idx = Number(groupEl.getAttribute("data-index"));
      if (!state.draft.items[idx]) return;
      selectedRegion = idx;
      const [sx, sy] = svgCoords(stageSvg, ev, w, h);
      dragCtx = {
        kind: "move",
        idx,
        w,
        h,
        state,
        sx,
        sy,
        orig: [...state.draft.items[idx].bbox],
        origStateJson,
      };
      stageSvg.setPointerCapture?.(ev.pointerId);
      ev.preventDefault();
      syncCard();
    }
  });

  stageSvg.addEventListener("pointermove", (ev) => {
    if (!dragCtx) return;
    ev.stopPropagation();
    const { kind, idx, w, h, state, orig } = dragCtx;
    const item = state.draft?.items?.[idx];
    if (!item) return;
    const [cx, cy] = svgCoords(stageSvg, ev, w, h);
    if (kind === "resize") {
      item.bbox = [
        orig[0],
        orig[1],
        clampVal(cx, orig[0] + 16, w),
        clampVal(cy, orig[1] + 16, h),
      ];
    } else {
      const dx = cx - dragCtx.sx;
      const dy = cy - dragCtx.sy;
      const bw = orig[2] - orig[0];
      const bh = orig[3] - orig[1];
      const nx1 = clampVal(orig[0] + dx, 0, w - bw);
      const ny1 = clampVal(orig[1] + dy, 0, h - bh);
      item.bbox = [nx1, ny1, nx1 + bw, ny1 + bh];
    }
    renderSvgStage(stageSvg, {
      width: w,
      height: h,
      draft: state.draft,
      imageUrl: node._apsImageDataUrl || null,
      selected: selectedRegion,
      showBoxes: true,
      dimImage: dimStageImage,
    });
  });

  function finishStageDrag() {
    if (!dragCtx) return;
    const { state, w, h, origStateJson } = dragCtx;
    dragCtx = null;
    if (state.draft) {
      if (origStateJson) {
        node._apsUndo?.record({
          key: "payload_state",
          before: origStateJson,
          after: "",
          label: `调整区域 #${selectedRegion + 1} 坐标`,
          source: "stage",
        });
      }
      commitDraftToState(state, normalizeDraft(state.draft, w, h), w, h, false);
      statusEl.textContent = `已更新区域 #${selectedRegion + 1} 坐标。`;
    }
  }
  stageSvg.addEventListener("pointerup", finishStageDrag);
  stageSvg.addEventListener("pointercancel", finishStageDrag);

  // Regions Pills & Selected Region Inline Inspector inside Stage Panel
  const regionsBar = el("div", "aps-node-regions");
  const regionInspector = el("div", "aps-node-region-inspector");

  // 8-direction interactive resize handles on stagePanel + header drag-to-move
  let panelDragCtx = null;
  function getCanvasZoomScale(targetEl = stagePanel) {
    const elRef = targetEl && targetEl.offsetWidth ? targetEl : card;
    const r = elRef.getBoundingClientRect();
    const ow = elRef.offsetWidth || stageBox.width || 1;
    const s = r.width / ow;
    return s > 0.1 && s < 5 ? s : 1;
  }

  for (const dir of ["n", "s", "e", "w", "nw", "ne", "sw", "se"]) {
    const handle = el(
      "div",
      `aps-stage-resizer aps-stage-resizer-${dir}`,
      dir === "se" ? "⤡" : dir === "sw" ? "⤢" : "",
    );
    handle.title = "按住拖拽可自由调整布局画框长宽大小";
    handle.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      const [curNodeW, curNodeH] = getNodeSize(node);
      panelDragCtx = {
        kind: "resize",
        dir,
        startX: ev.clientX,
        startY: ev.clientY,
        scale: getCanvasZoomScale(stagePanel),
        orig: { ...stageBox },
        origActualH: stagePanel.offsetHeight || stageBox.height || 450,
        origPanelW: stagePanel.offsetWidth || stageBox.width || 380,
        origTotalW: workspaceWrap.offsetWidth || 680,
        origNodeW: curNodeW,
        origNodeH: curNodeH,
      };
      handle.setPointerCapture?.(ev.pointerId);
    });
    handle.addEventListener("pointermove", (ev) => {
      if (!panelDragCtx || panelDragCtx.kind !== "resize") return;
      ev.stopPropagation();
      const dx = (ev.clientX - panelDragCtx.startX) / panelDragCtx.scale;
      const dy = (ev.clientY - panelDragCtx.startY) / panelDragCtx.scale;
      const { orig } = panelDragCtx;

      if (dockMode === "split") {
        let nextNodeW = panelDragCtx.origNodeW;
        let nextNodeH = panelDragCtx.origNodeH;
        let resizedNode = false;
        if (dir.includes("e")) {
          const nextRatio = (panelDragCtx.origPanelW + dx) / Math.max(300, panelDragCtx.origTotalW);
          stageBox.splitRatio = clampVal(nextRatio, 0.22, 0.8);
        }
        if (dir.includes("w")) {
          nextNodeW = clampVal(Math.round(panelDragCtx.origNodeW - dx), 580, 2200);
          resizedNode = true;
        }
        if (dir.includes("s")) {
          nextNodeH = clampVal(Math.round(panelDragCtx.origNodeH + dy), 360, 2000);
          resizedNode = true;
        }
        if (dir.includes("n")) {
          nextNodeH = clampVal(Math.round(panelDragCtx.origNodeH - dy), 360, 2000);
          resizedNode = true;
        }
        if (resizedNode) {
          setNodeSize(node, nextNodeW, nextNodeH);
        }
        applyStageGeometry();
        return;
      }

      if (dir.includes("e")) {
        const nextW = clampVal(Math.round(orig.width + dx), 260, 1600);
        if (dockMode === "left") {
          stageBox.offsetX = Math.round(orig.offsetX + (nextW - orig.width));
        }
        stageBox.width = nextW;
      }
      if (dir.includes("w")) {
        const nextW = clampVal(Math.round(orig.width - dx), 260, 1600);
        if (dockMode === "right") {
          stageBox.offsetX = Math.round(orig.offsetX - (nextW - orig.width));
        }
        stageBox.width = nextW;
      }
      if (dir.includes("s")) {
        const baseH = panelDragCtx.origActualH || orig.height || 450;
        stageBox.height = clampVal(Math.round(baseH + dy), 220, 1600);
        stageBox.customHeight = true;
      }
      if (dir.includes("n")) {
        const baseH = panelDragCtx.origActualH || orig.height || 450;
        const nextH = clampVal(Math.round(baseH - dy), 220, 1600);
        stageBox.offsetY = Math.round(orig.offsetY - (nextH - baseH));
        stageBox.height = nextH;
        stageBox.customHeight = true;
      }
      applyStageGeometry();
    });
    const endResize = (ev) => {
      if (!panelDragCtx) return;
      ev.stopPropagation();
      panelDragCtx = null;
      saveStageBox();
      // Resize completed without overwriting active status messages
    };
    handle.addEventListener("pointerup", endResize);
    handle.addEventListener("pointercancel", endResize);
    stagePanel.append(handle);
  }

  // Allow dragging the stageHeader bar to freely reposition the floating wing
  stageHeader.addEventListener("pointerdown", (ev) => {
    if (ev.target.closest("button, input, select")) return;
    if (dockMode === "split") return;
    ev.stopPropagation();
    ev.preventDefault();
    panelDragCtx = {
      kind: "move",
      startX: ev.clientX,
      startY: ev.clientY,
      scale: getCanvasZoomScale(),
      orig: { ...stageBox },
    };
    stageHeader.setPointerCapture?.(ev.pointerId);
  });
  stageHeader.addEventListener("pointermove", (ev) => {
    if (!panelDragCtx || panelDragCtx.kind !== "move") return;
    ev.stopPropagation();
    const dx = (ev.clientX - panelDragCtx.startX) / panelDragCtx.scale;
    const dy = (ev.clientY - panelDragCtx.startY) / panelDragCtx.scale;
    stageBox.offsetX = clampVal(Math.round(panelDragCtx.orig.offsetX + dx), -900, 900);
    stageBox.offsetY = clampVal(Math.round(panelDragCtx.orig.offsetY + dy), -700, 700);
    applyStageGeometry();
  });
  const endHeaderMove = (ev) => {
    if (!panelDragCtx || panelDragCtx.kind !== "move") return;
    ev.stopPropagation();
    panelDragCtx = null;
    saveStageBox();
  };
  stageHeader.addEventListener("pointerup", endHeaderMove);
  stageHeader.addEventListener("pointercancel", endHeaderMove);
  stageHeader.addEventListener("dblclick", (ev) => {
    if (ev.target.closest("button, input, select")) return;
    stageBox = { ...defaultStageBox };
    saveStageBox();
    applyStageGeometry();
    statusEl.textContent = "已复位布局画框默认大小与位置。";
  });

  stagePanel.append(stageHeader, stageWrap, regionsBar, regionInspector);

  // ---- Main Prompt & AI Controls Column ----
  const mainCol = el("div", "aps-node-main-col");
  const nodeDiffHost = el("div", "aps-node-diff-host");

  const promptBox = el("textarea", "aps-node-prompt");
  promptBox.rows = 5;
  promptBox.placeholder = "提示词为空。点击「⚡ 反推」读取图片，或在下方直接输入创意/改词要求…";
  promptBox.addEventListener("change", () => {
    const mode = currentMode(node);
    const state = readPayload(node);
    const prev = activePromptForMode(state, mode);
    const nextVal = promptBox.value;
    if (prev !== nextVal) {
      node._apsUndo.record({ key: "caption", before: prev, after: nextVal, label: "手动修改", source: "node" });
      writePromptForMode(state, mode, nextVal);
      state.width = state.width || 1024;
      state.height = state.height || 1024;
      const pw = widget(node, "payload");
      if (pw) pw.value = JSON.stringify(state);
      node._apsDirty = true;
      syncCard();
      node.setDirtyCanvas?.(true, true);
    }
  });

  const promptStatsEl = el("div", "aps-node-prompt-stats");
  function updatePromptStats() {
    const text = promptBox.value || "";
    const mode = currentMode(node);
    if (mode === "danbooru") {
      const tags = text.split(",").map((s) => s.trim()).filter(Boolean);
      promptStatsEl.textContent = `📊 ${tags.length} 个标签 · ${text.length} 字符`;
    } else if (mode === "layout") {
      const state = readPayload(node);
      const count = Array.isArray(state?.draft?.items) ? state.draft.items.length : 0;
      promptStatsEl.textContent = `📊 ${count} 个空间区域 · ${text.length} 字符`;
    } else {
      const words = text.split(/\s+/).filter(Boolean);
      promptStatsEl.textContent = `📊 ${words.length} 词 · ${text.length} 字符`;
    }
  }
  promptBox.addEventListener("input", updatePromptStats);

  // Quick AI Actions + Inline Instruction Input
  const quickBar = el("div", "aps-node-quick-bar");
  const btnCopy = el("button", "aps-chip-btn", "📋 复制");
  btnCopy.type = "button";
  btnCopy.title = "一键复制当前输入框提示词到系统剪贴板";
  btnCopy.addEventListener("click", async () => {
    const text = promptBox.value;
    if (!text) {
      statusEl.textContent = "提示词为空，无可复制内容。";
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      statusEl.textContent = "✅ 已复制提示词到系统剪贴板！";
    } catch {
      promptBox.select();
      document.execCommand("copy");
      statusEl.textContent = "✅ 已复制提示词到系统剪贴板！";
    }
  });
  const btnReverse = el("button", "aps-btn aps-primary aps-btn-sm", "⚡ 反推");
  btnReverse.type = "button";
  btnReverse.addEventListener("click", () => runCaption(node, statusEl));

  const btnExpand = el("button", "aps-chip-btn", "✨ 扩写");
  btnExpand.type = "button";
  btnExpand.addEventListener("click", () =>
    runInlineEdit(
      "Expand and enrich the prompt with concrete lighting, composition, and texture details in English.",
      "扩写细节",
    ),
  );

  const btnTrans = el("button", "aps-chip-btn", "🌐 译英");
  btnTrans.type = "button";
  btnTrans.addEventListener("click", () =>
    runInlineEdit(
      "Translate any Chinese in the prompt into natural, idiomatic English image-generation phrasing.",
      "译为英文",
    ),
  );

  const btnMoss = el("button", "aps-chip-btn notranslate", "🎯 MOSS精炼");
  btnMoss.type = "button";
  btnMoss.setAttribute("translate", "no");
  btnMoss.addEventListener("click", () =>
    runInlineEdit(
      "Optimize prompt according to official MOSS-Image prompt conventions: describe visible choices (subject, appearance, setting, lighting, materials, framing, mood), preserve all user intent and exclusions, strictly remove any (word:weight) parentheses or generic quality tags, and quote visible typography verbatim in double quotes.",
      "MOSS优化",
    ),
  );

  function handleUndo() {
    const entry = node._apsUndo?.undo();
    if (!entry) return;
    const mode = currentMode(node);
    if (entry.key === "payload_state" && entry.before) {
      try {
        const restored = JSON.parse(entry.before);
        setPayload(node, restored);
        statusEl.textContent = `已撤销：${entry.label || "画框修改"}`;
        syncCard();
        node.setDirtyCanvas?.(true, true);
        return;
      } catch (e) {}
    }
    const state = readPayload(node);
    writePromptForMode(state, mode, entry.before);
    const pw = widget(node, "payload");
    if (pw) pw.value = JSON.stringify(state);
    statusEl.textContent = `已撤销：${entry.label || "修改"}`;
    syncCard();
    node.setDirtyCanvas?.(true, true);
  }

  const btnUndo = el("button", "aps-btn aps-btn-sm", "↩ 撤销");
  btnUndo.type = "button";
  btnUndo.disabled = true;
  btnUndo.addEventListener("click", handleUndo);

  quickBar.append(btnReverse, btnExpand, btnTrans, btnMoss, btnCopy, btnUndo);

  const chatRow = el("div", "aps-node-chat-row");
  const chatInput = el("input", "aps-input aps-node-chat-input");
  chatInput.type = "text";
  chatInput.placeholder = "直接输入改词指令或新创意（如：改成雨夜霓虹），回车让 AI 修改…";
  const chatSend = el("button", "aps-btn aps-accent aps-btn-sm", "改词 ✦");
  chatSend.type = "button";
  chatInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      const val = chatInput.value.trim();
      if (val) {
        chatInput.value = "";
        runInlineEdit(val, val);
      }
    }
  });
  chatSend.addEventListener("click", () => {
    const val = chatInput.value.trim();
    if (val) {
      chatInput.value = "";
      runInlineEdit(val, val);
    }
  });
  chatRow.append(chatInput, chatSend);

  // ---- Built-in Prompt Rules & Preferences Panel (.aps-node-rules-panel) ----
  const rulesPanel = el("div", "aps-node-rules-panel");
  let isRulesOpen = globalThis.localStorage?.getItem("aps_node_rules_open") !== "false";

  const rulesHead = el("div", "aps-node-rules-head");
  const rulesTitleWrap = el("div", "aps-node-rules-title-wrap");
  const rulesTitle = el("span", "aps-node-rules-title", "📐 提示词规则与反推偏好");
  const rulesHint = el("span", "aps-node-rules-hint", "（反推与改词均自动严格遵循）");
  rulesTitleWrap.append(rulesTitle, rulesHint);

  const rulesHeadActions = el("div", "aps-node-rules-head-actions");
  const saveRulesBtn = el("button", "aps-btn aps-primary aps-btn-xs", "💾 保存规则");
  saveRulesBtn.type = "button";
  saveRulesBtn.title = "立即保存当前提示词规则与偏好设置";

  const collapseRulesBtn = el("button", "aps-chip-btn aps-btn-xs", isRulesOpen ? "收起 ▴" : "展开 ▾");
  collapseRulesBtn.type = "button";

  rulesHeadActions.append(saveRulesBtn, collapseRulesBtn);
  rulesHead.append(rulesTitleWrap, rulesHeadActions);

  // 1) Rule Preset + Output Language + Max Regions Row
  const rulesGrid = el("div", "aps-node-rules-grid");

  const presetWrap = el("div", "aps-node-field");
  const presetLbl = el("label", "aps-field-label", "规则预设");
  const presetRow = el("div", "aps-node-field-row");
  const rulePresetSel = el("select", "aps-select aps-select-sm");
  for (const [val, label] of RULE_PRESET_OPTIONS) {
    const opt = el("option", "", label);
    opt.value = val;
    rulePresetSel.append(opt);
  }
  const loadPresetBtn = el("button", "aps-chip-btn aps-btn-xs", "📋 载入模版");
  loadPresetBtn.type = "button";
  loadPresetBtn.title = "将当前所选预设的标准规则填入下方文本框，方便随时修改与保存";
  presetRow.append(rulePresetSel, loadPresetBtn);
  presetWrap.append(presetLbl, presetRow);

  const langWrap = el("div", "aps-node-field");
  const langLbl = el("label", "aps-field-label", "输出语言");
  const ruleLangSel = el("select", "aps-select aps-select-sm");
  for (const [val, label] of OUTPUT_LANGUAGE_OPTIONS) {
    const opt = el("option", "", label);
    opt.value = val;
    ruleLangSel.append(opt);
  }
  langWrap.append(langLbl, ruleLangSel);

  const maxRegWrap = el("div", "aps-node-field");
  const maxRegLbl = el("label", "aps-field-label", "区域数 (1~8)");
  const ruleMaxRegInput = el("input", "aps-input aps-input-sm");
  ruleMaxRegInput.type = "number";
  ruleMaxRegInput.min = "1";
  ruleMaxRegInput.max = "8";
  ruleMaxRegInput.value = "6";
  maxRegWrap.append(maxRegLbl, ruleMaxRegInput);

  rulesGrid.append(presetWrap, langWrap, maxRegWrap);

  // 2) Node-specific extra instruction row (tied to extra_instruction widget)
  const extraRow = el("div", "aps-node-field");
  const extraLbl = el("label", "aps-field-label", "🎯 当前节点补充要求（extra_instruction · 随工作流保存）");
  const extraInput = el("input", "aps-input aps-node-chat-input");
  extraInput.type = "text";
  extraInput.placeholder = "仅对本节点生效的补充要求，例如：强调赛博朋克霓虹反光 / 必须全身照";
  const curExtraW = widget(node, "extra_instruction");
  extraInput.value = cleanWidgetStr(curExtraW?.value) || "";
  extraInput.addEventListener("input", () => {
    if (curExtraW) {
      curExtraW.value = extraInput.value;
      node.setDirtyCanvas?.(true, true);
    }
  });
  extraInput.addEventListener("change", () => {
    if (curExtraW) {
      curExtraW.value = extraInput.value;
      node.setDirtyCanvas?.(true, true);
      ruleStatusNote.textContent = `✓ 节点补充要求已保存：${extraInput.value.slice(0, 24) || "（空）"}`;
      ruleStatusNote.dataset.kind = "ok";
    }
  });
  extraRow.append(extraLbl, extraInput);

  // 3) Global custom rules textarea
  const customRulesWrap = el("div", "aps-node-field");
  const customRulesLbl = el("label", "aps-field-label", "全局自定义提示词规则（随时修改，自动注入到反推与改词中）");
  const customRulesArea = el("textarea", "aps-node-rules-textarea");
  customRulesArea.rows = 3;
  customRulesArea.placeholder = "在此输入提示词规则，例如：\n- 禁用 (word:1.2) 权重语法\n- 重点描述服装材质与光影方向\n- 保留画面可见文字";

  // Quick Chips
  const rulesQuickChips = el("div", "aps-quick-chips");
  for (const tpl of QUICK_RULE_TEMPLATES) {
    const chip = el("button", "aps-chip-btn", tpl.label);
    chip.type = "button";
    chip.addEventListener("click", () => {
      const cur = customRulesArea.value.trim();
      if (!cur.includes(tpl.text)) {
        customRulesArea.value = cur ? `${cur}\n- ${tpl.text}` : `- ${tpl.text}`;
      }
      triggerAutoSave();
    });
    rulesQuickChips.append(chip);
  }
  const clearRulesChip = el("button", "aps-chip-btn", "↺ 清空规则");
  clearRulesChip.type = "button";
  clearRulesChip.addEventListener("click", () => {
    customRulesArea.value = "";
    triggerAutoSave();
  });
  rulesQuickChips.append(clearRulesChip);

  customRulesWrap.append(customRulesLbl, customRulesArea, rulesQuickChips);

  // 3b) User custom requirements (auto-appended to EVERY rule preset)
  const userCustomWrap = el("div", "aps-node-field aps-settings-user-custom-wrap");
  const userCustomLbl = el(
    "label",
    "aps-field-label aps-highlight-label",
    "★ 用户自定义要求（自动写进每个规则，始终与选定规则一同交给模型）",
  );
  const userCustomArea = el("textarea", "aps-node-rules-textarea aps-user-custom-area");
  userCustomArea.rows = 2;
  userCustomArea.placeholder = "在此输入强制追加的自定义要求（如：纯白极简背景 / 赛博朋克霓虹反光 / 视线正对镜头）…";

  const userCustomQuickChips = el("div", "aps-quick-chips");
  const NODE_CUSTOM_QUICK_CHIPS = [
    { label: "+ 纯色极简背景", text: "背景始终保持纯色或极简设计，避免杂乱元素干扰" },
    { label: "+ 强制赛博霓虹反光", text: "强化冷色调赛博朋克光影，表现潮湿地面与金属表面的霓虹反光" },
    { label: "+ 角色直视镜头", text: "人物视线正对镜头，面部神态生动自然，突出眼神光" },
    { label: "+ 严格保留文字", text: "严格精准保留画面中所有英文、标点与数字，不做任何意译篡改" },
    { label: "↺ 清空要求", action: "clear" },
  ];
  for (const chipData of NODE_CUSTOM_QUICK_CHIPS) {
    const chip = el("button", "aps-chip-btn", chipData.label);
    chip.type = "button";
    chip.addEventListener("click", () => {
      if (chipData.action === "clear") {
        userCustomArea.value = "";
      } else {
        const cur = userCustomArea.value.trim();
        if (!cur.includes(chipData.text)) {
          userCustomArea.value = cur ? `${cur}\n- ${chipData.text}` : `- ${chipData.text}`;
        }
      }
      triggerAutoSave();
    });
    userCustomQuickChips.append(chip);
  }
  userCustomArea.addEventListener("input", triggerAutoSave);
  userCustomWrap.append(userCustomLbl, userCustomArea, userCustomQuickChips);

  // 4) Bottom note & save action
  const rulesFoot = el("div", "aps-node-rules-foot");
  const ruleStatusNote = el("span", "aps-node-rules-note", "随时修改上方提示词，失焦或点击按钮自动保存。");
  const saveBtnBottom = el("button", "aps-btn aps-primary aps-btn-xs", "💾 立即保存");
  saveBtnBottom.type = "button";

  rulesFoot.append(ruleStatusNote, saveBtnBottom);
  rulesPanel.append(rulesHead, rulesGrid, extraRow, customRulesWrap, userCustomWrap, rulesFoot);

  let saveTimer = null;
  async function doSaveRules({ showFeedback = true } = {}) {
    const preset = rulePresetSel.value || "moss";
    const lang = ruleLangSel.value || "en";
    const maxReg = Math.max(1, Math.min(8, Number(ruleMaxRegInput.value) || 6));
    const promptRules = customRulesArea.value.trim();
    const userCustomRules = userCustomArea.value.trim();
    try {
      const res = await api.saveConfig({
        rule_preset: preset,
        output_language: lang,
        max_regions: maxReg,
        prompt_rules: promptRules,
        user_custom_rules: userCustomRules,
      });
      if (res?.config) {
        node._apsActiveConfig = res.config;
      }
      if (showFeedback) {
        ruleStatusNote.textContent = `✓ 规则已保存并生效（预设: ${preset} · 语言: ${lang}）`;
        ruleStatusNote.dataset.kind = "ok";
        setTimeout(() => {
          if (ruleStatusNote.textContent.includes("已保存")) {
            ruleStatusNote.textContent = "随时修改上方提示词，失焦或点击按钮自动保存。";
            ruleStatusNote.dataset.kind = "";
          }
        }, 3500);
      }
      const curModel = cleanWidgetStr(widget(node, "model")?.value) || res?.config?.model || "";
      statusLine.textContent = `就绪 · 模型: ${curModel} · 规则: ${preset}（提示词规则已生效）`;
    } catch (err) {
      ruleStatusNote.textContent = `保存失败：${err?.message || err}`;
      ruleStatusNote.dataset.kind = "error";
    }
  }

  function triggerAutoSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => doSaveRules({ showFeedback: true }), 400);
  }

  function isTextMatchingAnyPreset(txt) {
    const trimmed = String(txt || "").trim();
    if (!trimmed) return true;
    return Object.values(PRESET_RULE_TEMPLATES).some((tpl) => tpl.trim() === trimmed);
  }

  function applyNodePresetTemplate(presetKey, { force = false } = {}) {
    const tpl = PRESET_RULE_TEMPLATES[presetKey] ?? "";
    const cur = customRulesArea.value.trim();
    if (!force && cur && !isTextMatchingAnyPreset(cur)) {
      ruleStatusNote.textContent = `已切到预设「${presetKey}」；点击「📋 载入模版」可覆盖载入标准规则。`;
      ruleStatusNote.dataset.kind = "";
      triggerAutoSave();
      return;
    }
    customRulesArea.value = tpl;
    ruleStatusNote.textContent = `✓ 已自动载入「${presetKey}」规则模版，可随时在下方修改。`;
    ruleStatusNote.dataset.kind = "ok";
    triggerAutoSave();
  }

  rulePresetSel.addEventListener("change", () => {
    applyNodePresetTemplate(rulePresetSel.value, { force: false });
  });

  loadPresetBtn.addEventListener("click", () => {
    const tpl = PRESET_RULE_TEMPLATES[rulePresetSel.value] ?? "";
    customRulesArea.value = tpl;
    ruleStatusNote.textContent = `✓ 已载入「${rulePresetSel.value}」标准规则模版，可随时在下方修改。`;
    ruleStatusNote.dataset.kind = "ok";
    triggerAutoSave();
  });

  saveRulesBtn.addEventListener("click", () => doSaveRules({ showFeedback: true }));
  saveBtnBottom.addEventListener("click", () => doSaveRules({ showFeedback: true }));
  ruleLangSel.addEventListener("change", triggerAutoSave);
  ruleMaxRegInput.addEventListener("change", triggerAutoSave);
  customRulesArea.addEventListener("change", triggerAutoSave);

  function updateRulesVisibility(open) {
    isRulesOpen = Boolean(open);
    try {
      globalThis.localStorage?.setItem("aps_node_rules_open", String(isRulesOpen));
    } catch {}
    rulesToggleBtn.classList.toggle("is-active", isRulesOpen);
    rulesToggleBtn.textContent = isRulesOpen ? "📐 规则偏好 ▴" : "📐 规则偏好 ▾";
    collapseRulesBtn.textContent = isRulesOpen ? "收起 ▴" : "展开 ▾";
    rulesPanel.hidden = !isRulesOpen;
    applyStageGeometry();
    node.setDirtyCanvas?.(true, true);
  }

  rulesToggleBtn.addEventListener("click", () => updateRulesVisibility(!isRulesOpen));
  collapseRulesBtn.addEventListener("click", () => updateRulesVisibility(!isRulesOpen));
  updateRulesVisibility(isRulesOpen);

  function fillRulesConfig(cfg) {
    if (!cfg) return;
    if (cfg.rule_preset && rulePresetSel.value !== cfg.rule_preset) {
      rulePresetSel.value = cfg.rule_preset;
    }
    if (cfg.output_language && ruleLangSel.value !== cfg.output_language) {
      ruleLangSel.value = cfg.output_language;
    }
    if (cfg.max_regions != null) {
      ruleMaxRegInput.value = String(cfg.max_regions);
    }
    if (typeof cfg.prompt_rules === "string" && document.activeElement !== customRulesArea) {
      customRulesArea.value =
        cfg.prompt_rules.trim() !== ""
          ? cfg.prompt_rules
          : (PRESET_RULE_TEMPLATES[cfg.rule_preset || "moss"] || "");
    }
    const extraW = widget(node, "extra_instruction");
    if (extraW && document.activeElement !== extraInput) {
      extraInput.value = cleanWidgetStr(extraW.value);
    }
  }
  node._apsFillRules = fillRulesConfig;

  const statusLine = el("div", "aps-node-status", "就绪 · 可勾选 1~3 个格式同时输出（caption / layout / hybrid）");

  mainCol.append(nodeDiffHost, promptBox, quickBar, chatRow, rulesPanel, statusLine);
  workspaceWrap.append(stagePanel, mainCol);
  card.append(topBar, workspaceWrap);

  // Interactive resize handles on the Left/Main Card (.aps-node-card) itself so the user
  // can drag either the card's own edges/corners OR the outer node frame to resize width & height!
  let cardDragCtx = null;
  for (const dir of ["s", "e", "w", "sw", "se"]) {
    const cHandle = el(
      "div",
      `aps-card-resizer aps-stage-resizer aps-stage-resizer-${dir}`,
      dir === "se" ? "⤡" : dir === "sw" ? "⤢" : "",
    );
    cHandle.title = "按住拖拽可自由调整主面板（及节点）的长宽大小";
    cHandle.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      const [curNodeW, curNodeH] = getNodeSize(node);
      cardDragCtx = {
        dir,
        startX: ev.clientX,
        startY: ev.clientY,
        scale: getCanvasZoomScale(card),
        origNodeW: curNodeW,
        origNodeH: curNodeH,
      };
      cHandle.setPointerCapture?.(ev.pointerId);
    });
    cHandle.addEventListener("pointermove", (ev) => {
      if (!cardDragCtx) return;
      ev.stopPropagation();
      const dx = (ev.clientX - cardDragCtx.startX) / cardDragCtx.scale;
      const dy = (ev.clientY - cardDragCtx.startY) / cardDragCtx.scale;
      let nextW = cardDragCtx.origNodeW;
      let nextH = cardDragCtx.origNodeH;
      const minW = dockMode === "split" ? 580 : 380;
      if (dir.includes("e")) {
        nextW = clampVal(Math.round(cardDragCtx.origNodeW + dx), minW, 2200);
      }
      if (dir.includes("w")) {
        nextW = clampVal(Math.round(cardDragCtx.origNodeW - dx), minW, 2200);
      }
      if (dir.includes("s")) {
        nextH = clampVal(Math.round(cardDragCtx.origNodeH + dy), 360, 2000);
      }
      setNodeSize(node, nextW, nextH);
      applyStageGeometry();
    });
    const endCardResize = (ev) => {
      if (!cardDragCtx) return;
      ev.stopPropagation();
      cardDragCtx = null;
      // Dimensions adjusted without overwriting active status messages
    };
    cHandle.addEventListener("pointerup", endCardResize);
    cHandle.addEventListener("pointercancel", endCardResize);
    card.append(cHandle);
  }

  function commitDraftToState(state, draft, w, h, shouldRecordUndo = true, label = "修改画框") {
    if (shouldRecordUndo) {
      const prevJson = JSON.stringify(readPayload(node));
      node._apsUndo?.record({
        key: "payload_state",
        before: prevJson,
        after: "",
        label,
        source: "stage",
      });
    }
    state.draft = draft;
    state.layout_draft = draft;
    state.hybrid_draft = {
      ...draft,
      summary: {
        ...(draft.summary || {}),
        caption: state.caption_text || state.caption || draft.summary?.caption || "",
      },
    };
    state.width = w;
    state.height = h;
    const pw = widget(node, "payload");
    if (pw) pw.value = JSON.stringify(state);
    node._apsDirty = true;
    syncCard();
    node.setDirtyCanvas?.(true, true);
    void Promise.all([
      api.renderLayout({ draft, mode: "layout" }).catch(() => null),
      api.renderLayout({ draft: state.hybrid_draft, mode: "hybrid" }).catch(() => null),
    ]).then(([lRes, hRes]) => {
      let updated = false;
      if (lRes?.caption) {
        state.layout_text = lRes.caption;
        if (currentMode(node) === "layout") state.caption = lRes.caption;
        updated = true;
      }
      if (hRes?.caption) {
        state.hybrid_text = hRes.caption;
        if (currentMode(node) === "danbooru" || currentMode(node) === "hybrid") state.caption = hRes.caption;
        updated = true;
      }
      if (updated) {
        if (pw) pw.value = JSON.stringify(state);
        syncCard();
      }
    });
  }



  function applyDockMode() {
    card.dataset.dock = dockMode;
    for (const [k, btn] of Object.entries(dockBtns)) {
      btn.classList.toggle("is-active", k === dockMode);
    }
    if (hasNodeSize(node)) {
      const [curW, curH] = getNodeSize(node);
      if (dockMode === "split") {
        setNodeSize(node, Math.max(curW, 740), Math.max(curH, 480));
      } else {
        setNodeSize(node, Math.max(curW, 430), Math.max(curH, 450));
      }
    }
    ensureParentOverflowVisible();
    applyStageGeometry();
  }

  Object.defineProperty(statusEl, "textContent", {
    get() {
      return statusLine.textContent;
    },
    set(v) {
      statusLine.textContent = v || "";
    },
    configurable: true,
  });

  let pendingProposal = null;

  async function runInlineEdit(instruction, label) {
    const mode = currentMode(node);
    const state = readPayload(node);
    const currentText = activePromptForMode(state, mode);
    statusEl.textContent = `正在执行：${label}…`;
    node._apsSetBusy?.(true);
    try {
      let imgUrl = node._apsImageDataUrl || null;
      if (!imgUrl) {
        try {
          imgUrl = await fetchImageDataUrl(node);
        } catch {
          imgUrl = null;
        }
      }
      const res = await api.edit({
        message: instruction,
        target: {
          node_id: node.id,
          widget: "caption",
          title: node.title || "AI 图像反推提示词",
          text: currentText,
        },
        images: imgUrl ? [{ data_url: imgUrl }] : undefined,
        session_id: node._apsSessionId || undefined,
        create_session: true,
        allow_empty: true,
      });
      if (res.session_id) node._apsSessionId = res.session_id;
      if (res.proposal && res.proposal.changed) {
        pendingProposal = res.proposal;
        renderNodeDiff();
        statusEl.textContent = res.proposal.reply || "已生成修改建议，请点「应用」确认。";
      } else {
        statusEl.textContent = res.proposal?.reply || "无需改动。";
      }
    } catch (err) {
      statusEl.textContent = formatFriendlyErrorMessage(err, "AI 改词");
    } finally {
      node._apsSetBusy?.(false);
    }
  }

  function renderNodeDiff() {
    nodeDiffHost.textContent = "";
    if (!pendingProposal) return;
    const banner = el("div", "aps-node-diff");
    const info = el(
      "div",
      "aps-node-diff-head",
      `✦ ${pendingProposal.reply || `建议 ${pendingProposal.changes?.length || 1} 处修改`}`,
    );
    const actions = el("div", "aps-node-diff-actions");
    const applyB = el("button", "aps-btn aps-primary aps-btn-sm", "✓ 应用");
    applyB.type = "button";
    applyB.addEventListener("click", async () => {
      const mode = currentMode(node);
      const state = readPayload(node);
      const currentText = activePromptForMode(state, mode);
      const ops = selectOps(
        pendingProposal.changes,
        pendingProposal.changes.map((_, i) => i),
      );
      try {
        const applied = await api.apply({ text: currentText, ops });
        node._apsUndo.record({
          key: "caption",
          before: currentText,
          after: applied.text,
          label: pendingProposal.reply || "AI 改词",
          source: "edit",
        });
        writePromptForMode(state, mode, applied.text);
        state.width = state.width || 1024;
        state.height = state.height || 1024;
        const pw = widget(node, "payload");
        if (pw) pw.value = JSON.stringify(state);
        node._apsDirty = true;
        pendingProposal = null;
        renderNodeDiff();
        syncCard();
        statusEl.textContent = "✓ 修改已应用（可点「↩ 撤销」恢复）。";
        node.setDirtyCanvas?.(true, true);
      } catch (err) {
        statusEl.textContent = `应用失败：${err?.message || err}`;
      }
    });
    const cancelB = el("button", "aps-btn aps-btn-sm", "放弃");
    cancelB.type = "button";
    cancelB.addEventListener("click", () => {
      pendingProposal = null;
      renderNodeDiff();
      statusEl.textContent = "已放弃本次修改。";
    });
    actions.append(applyB, cancelB);
    banner.append(info, actions);
    nodeDiffHost.append(banner);
  }

  function syncCard() {
    hideRawWidgets(node);
    ensureParentOverflowVisible();
    card.dataset.dock = dockMode;
    for (const [k, btn] of Object.entries(dockBtns)) {
      btn.classList.toggle("is-active", k === dockMode);
    }

    const mode = currentMode(node);
    const modes = currentModes(node);
    const state = readPayload(node);
    const w = Number(state.width) || 1024;
    const h = Number(state.height) || 1024;

    for (const [k, b] of Object.entries(modeBtns)) {
      b.classList.toggle("is-active", k === mode);
      const isChecked = modes.includes(k);
      b.classList.toggle("is-checked", isChecked);
      if (modeChecks[k]) {
        modeChecks[k].textContent = isChecked ? "☑" : "☐";
      }
    }
    const allOn = modes.length === ALL_MODES.length;
    allModesBtn.classList.toggle("is-accent", allOn);
    allModesBtn.textContent = allOn ? "3格式全开 ☑" : "3格式全开";
    sizeBadge.textContent = state.width && state.height ? `${w}×${h}` : "自动尺寸";
    const canUndo = Boolean(node._apsUndo?.canUndo);
    btnUndo.disabled = !canUndo;
    if (typeof stageUndoBtn !== "undefined") stageUndoBtn.disabled = !canUndo;

    const text = activePromptForMode(state, mode);
    if (document.activeElement !== promptBox) {
      promptBox.value = text;
    }

    // Regions summary pills + inline region inspector inside stagePanel
    regionsBar.textContent = "";
    const items = Array.isArray(state.draft?.items) ? state.draft.items : [];
    if (selectedRegion >= items.length) {
      selectedRegion = items.length - 1;
    }
    const showBoxes = mode !== "caption" || modes.includes("layout") || modes.includes("hybrid") || items.length > 0;
    if (items.length > 0) {
      regionsBar.hidden = false;
      items.forEach((it, idx) => {
        const displayName = it.name || (it.label === "character" ? "角色" : (it.label === "text" ? "文字" : "物体"));
        const descPreview = String(it.text || it.caption || "").slice(0, 16);
        const pillText = `#${idx + 1} ${displayName}${descPreview ? ": " + descPreview : ""}`;
        const color = BOX_COLORS[idx % BOX_COLORS.length];
        const pill = el(
          "button",
          `aps-region-pill${idx === selectedRegion ? " is-selected" : ""}`,
          pillText,
        );
        pill.style.borderLeft = `3.5px solid ${color}`;
        pill.type = "button";
        pill.title = `#${idx + 1} [${it.label}] ${it.caption || ""}\n单击选中并在下方微调；双击打开全屏双栏工作台`;
        pill.addEventListener("click", () => {
          selectedRegion = idx === selectedRegion ? -1 : idx;
          syncCard();
        });
        pill.addEventListener("dblclick", () => openEditor(node, statusEl));
        regionsBar.append(pill);
      });
    } else {
      regionsBar.hidden = true;
    }

    // Inline region inspector with Localized AI Modification & Fine-tuning
    if (selectedRegion >= 0 && items[selectedRegion]) {
      const item = items[selectedRegion];
      regionInspector.hidden = false;
      regionInspector.textContent = "";

      // Row 1: Header (Index, Label, Coordinates, Delete)
      const row1 = el("div", "aps-region-inspect-row aps-region-inspect-header");
      const badge = el("span", "aps-region-inspector-idx", `#${selectedRegion + 1}`);
      const labelSel = el("select", "aps-select aps-select-xs");
      for (const [val, textLabel] of [
        ["character", "角色"],
        ["object", "物体"],
        ["text", "文字"],
        ["background", "背景"],
        ["effect", "特效"],
        ["clothing", "服饰"],
      ]) {
        const opt = el("option", null, textLabel);
        opt.value = val;
        if (item.label === val) opt.selected = true;
        labelSel.append(opt);
      }
      labelSel.addEventListener("change", () => {
        item.label = labelSel.value;
        commitDraftToState(state, normalizeDraft(state.draft, w, h), w, h, true, `修改区域 #${selectedRegion + 1} 类型`);
        statusEl.textContent = `已修改区域 #${selectedRegion + 1} 类型为【${labelSel.options[labelSel.selectedIndex].text}】。`;
      });

      const [bx1, by1, bx2, by2] = item.bbox || [0, 0, 0, 0];
      const bw = Math.max(0, Math.round(bx2 - bx1));
      const bh = Math.max(0, Math.round(by2 - by1));
      
      const nameInput = el("input", "aps-input aps-input-xs aps-region-name-input");
      nameInput.type = "text";
      nameInput.placeholder = "实体名称（如：光环、宣传单）";
      nameInput.value = item.name || "";
      nameInput.style.maxWidth = "115px";
      nameInput.title = "区域实体名称（显示在画框与标签上）";
      nameInput.addEventListener("change", () => {
        item.name = nameInput.value.trim();
        commitDraftToState(state, normalizeDraft(state.draft, w, h), w, h, true, `修改区域 #${selectedRegion + 1} 名称`);
        statusEl.textContent = `已修改区域 #${selectedRegion + 1} 名称为【${item.name}】。`;
        syncCard();
      });

      const boundsBadge = el("span", "aps-region-bounds-badge", `${bw}×${bh} (${Math.round(bx1)},${Math.round(by1)})`);
      boundsBadge.title = `区域范围: 左上角 (${Math.round(bx1)}, ${Math.round(by1)})，尺寸 ${bw}×${bh}`;

      const delBtn = el("button", "aps-btn aps-btn-xs aps-danger-text", "🗑 删除框");
      delBtn.type = "button";
      delBtn.title = "删除该区域框（或按键盘 Delete 键）";
      delBtn.addEventListener("click", () => {
        state.draft.items.splice(selectedRegion, 1);
        selectedRegion = Math.min(selectedRegion, state.draft.items.length - 1);
        commitDraftToState(state, normalizeDraft(state.draft, w, h), w, h, true, `删除区域框`);
        statusEl.textContent = "已删除区域框。";
      });
      row1.append(badge, labelSel, nameInput, boundsBadge, delBtn);

      // Row 2: Detailed Caption & Text input
      const row2 = el("div", "aps-region-inspect-row");
      const capInput = el("input", "aps-input aps-input-sm aps-region-cap-input");
      capInput.type = "text";
      capInput.placeholder = "此区域的画面细节描述（回车即时更新）…";
      capInput.value = item.caption || "";
      capInput.addEventListener("change", () => {
        item.caption = capInput.value;
        commitDraftToState(state, normalizeDraft(state.draft, w, h), w, h, true, `修改区域 #${selectedRegion + 1} 描述`);
        statusEl.textContent = `已修改区域 #${selectedRegion + 1} 描述。`;
      });
      row2.append(capInput);

      if (item.label === "text") {
        const txtInput = el("input", "aps-input aps-input-sm aps-region-txt-input");
        txtInput.type = "text";
        txtInput.placeholder = "画面可见文字…";
        txtInput.value = item.text || "";
        txtInput.title = "画面中必须出现的精确可见文字";
        txtInput.addEventListener("change", () => {
          item.text = txtInput.value;
          commitDraftToState(state, normalizeDraft(state.draft, w, h), w, h, true, `修改区域 #${selectedRegion + 1} 文字`);
          statusEl.textContent = `已修改区域 #${selectedRegion + 1} 文字。`;
        });
        row2.append(txtInput);
      }

      // Row 3: AI Localized Modification & Refinement
      const row3 = el("div", "aps-region-inspect-row aps-region-ai-row");
      const regAiInput = el("input", "aps-input aps-input-xs aps-region-ai-input");
      regAiInput.type = "text";
      regAiInput.placeholder = "局部改词，如: 改成赛博霓虹机甲、长发飘逸…";

      const regAiBtn = el("button", "aps-btn aps-accent aps-btn-xs", "改此区 ✦");
      regAiBtn.type = "button";

      const regExpandBtn = el("button", "aps-btn aps-btn-xs", "✨ 扩写");
      regExpandBtn.type = "button";
      regExpandBtn.title = "AI 扩写并丰富此区域的材质、光影与细节";

      const regTransBtn = el("button", "aps-btn aps-btn-xs", "🌐 译英");
      regTransBtn.type = "button";
      regTransBtn.title = "将此区域描述翻译为精准生图英文";

      async function doRegionAi(instruction, actionTip) {
        const curItem = state.draft?.items?.[selectedRegion];
        if (!curItem) return;
        statusEl.textContent = `正在局部改词：${actionTip}…`;
        node._apsSetBusy?.(true);
        try {
          const res = await api.edit({
            message: `针对画面中【${curItem.label}】区域进行局部精准修改：${instruction}。必须只输出修改后的该区域精简视觉描述，不要引号，不要解释。`,
            target: {
              node_id: node.id,
              widget: `region_${selectedRegion}`,
              title: `区域 #${selectedRegion + 1} (${curItem.label})`,
              text: curItem.caption || "",
            },
            model: cleanWidgetStr(widget(node, "model")?.value) || undefined,
            allow_empty: true,
          });
          const nextText = res.proposal?.text?.trim() || curItem.caption;
          if (nextText && nextText !== curItem.caption) {
            curItem.caption = nextText;
            commitDraftToState(state, normalizeDraft(state.draft, w, h), w, h, true, `局部改词 #${selectedRegion + 1}`);
            statusEl.textContent = `✅ 区域 #${selectedRegion + 1} 已局部更新：${nextText.slice(0, 30)}...`;
            syncCard();
          } else {
            statusEl.textContent = res.proposal?.reply || "无需改动。";
          }
        } catch (err) {
          statusEl.textContent = formatFriendlyErrorMessage(err, "局部改词");
        } finally {
          node._apsSetBusy?.(false);
        }
      }

      regAiInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          const val = regAiInput.value.trim();
          if (val) {
            regAiInput.value = "";
            void doRegionAi(val, val);
          }
        }
      });
      regAiBtn.addEventListener("click", () => {
        const val = regAiInput.value.trim();
        if (val) {
          regAiInput.value = "";
          void doRegionAi(val, val);
        }
      });
      regExpandBtn.addEventListener("click", () => {
        void doRegionAi("丰富该区域的物理材质、光影质感、色彩与细微纹理", "扩写此区域");
      });
      regTransBtn.addEventListener("click", () => {
        void doRegionAi("Translate the description into accurate, descriptive English suitable for image generation prompts.", "译英此区域");
      });

      row3.append(regAiInput, regAiBtn, regExpandBtn, regTransBtn);
      regionInspector.append(row1, row2, row3);
    } else {
      regionInspector.hidden = true;
      regionInspector.textContent = "";
    }

    // Image recovery and upstream synchronization
    const upFile = upstreamImageFile(node);
    const savedFile = state.last_image_file || null;

    // 1. If memory dataUrl is absent (e.g. after refresh/restart), restore from savedFile or upFile
    if (!node._apsImageDataUrl && (savedFile || upFile)) {
      const restoreFile = savedFile || upFile;
      void (async () => {
        try {
          const query = new URLSearchParams({ filename: restoreFile, type: "input" });
          const resp = await fetch(`/view?${query.toString()}`, { credentials: "same-origin" });
          if (resp.ok) {
            const blob = await resp.blob();
            node._apsImageDataUrl = await blobToDataUrl(blob);
            node._apsLastUpstreamFile = restoreFile;
            renderSvgStage(stageSvg, {
              width: w,
              height: h,
              draft: state.draft,
              imageUrl: node._apsImageDataUrl,
              selected: selectedRegion,
              showBoxes,
              dimImage: dimStageImage,
            });
          }
        } catch (e) {
          console.warn("恢复画框图片失败:", e);
        }
      })();
    } else if (upFile && upFile !== node._apsLastUpstreamFile) {
      // 2. Upstream file changed on canvas (e.g. user selected another image in LoadImage)
      // Guard: do not let default placeholder 'example.png' overwrite user's custom saved file
      const isDefaultPlaceholder = (upFile === "example.png" || upFile.includes("example"));
      if (!(isDefaultPlaceholder && savedFile && savedFile !== upFile)) {
        void fetchImageDataUrl(node)
          .then((newUrl) => {
            if (newUrl) {
              state.last_image_file = upFile;
              writePayload(node, state);
            }
            renderSvgStage(stageSvg, {
              width: w,
              height: h,
              draft: state.draft,
              imageUrl: node._apsImageDataUrl,
              selected: selectedRegion,
              showBoxes,
              dimImage: dimStageImage,
            });
          })
          .catch(() => {});
      }
    }

    renderSvgStage(stageSvg, {
      width: w,
      height: h,
      draft: state.draft,
      imageUrl: node._apsImageDataUrl || null,
      selected: selectedRegion,
      showBoxes,
      dimImage: dimStageImage,
    });
    fillRulesConfig(node._apsActiveConfig);
    if (typeof updatePromptStats === "function") updatePromptStats();
  }

  node._apsSyncCard = syncCard;
  node._apsSetBusy = (isBusy) => {
    btnReverse.disabled = isBusy;
    chatSend.disabled = isBusy;
    card.classList.toggle("is-busy", isBusy);
  };

  domWidget = node.addDOMWidget("aps_studio_card", "custom", card, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => 260,
  });
  if (domWidget) {
    delete domWidget.computeSize;
    domWidget.computeLayoutSize = () => ({
      minHeight: 260,
      maxHeight: undefined,
      minWidth: 0,
    });
  }
  node._apsOnResize = () => {
    hideRawWidgets(node);
    ensureParentOverflowVisible();
    applyStageGeometry();
  };
  applyDockMode();
  syncCard();
  setTimeout(() => {
    hideRawWidgets(node);
    ensureParentOverflowVisible();
    applyStageGeometry();
  }, 80);
  void api
    .status()
    .then((st) => {
      if (st?.config) {
        node._apsActiveConfig = st.config;
        fillRulesConfig(st.config);
        const m = cleanWidgetStr(widget(node, "model")?.value) || st.config.model || "";
        const preset = st.config.rule_preset || "moss";
        if (statusLine.textContent.startsWith("就绪")) {
          statusLine.textContent = `就绪 · 模型: ${m} · 规则: ${preset}（提示词规则已生效）`;
        }
      }
    })
    .catch(() => {});
}

function addButtons(node) {
  if (node._apsButtonsAdded) return;
  node._apsButtonsAdded = true;
  const statusEl = { textContent: "" };
  node._apsStatus = statusEl;
  // Only add legacy canvas button widgets in headless test environments;
  // in the browser, all controls live inside the rich DOM card.
  if (typeof document === "undefined") {
    const run = node.addWidget("button", "反推", null, () => runCaption(node, statusEl), {
      serialize: false,
    });
    const edit = node.addWidget("button", "编辑…", null, () => openEditor(node, statusEl), {
      serialize: false,
    });
    if (run) run.options = { ...(run.options || {}), serialize: false };
    if (edit) edit.options = { ...(edit.options || {}), serialize: false };
  }
  hideRawWidgets(node);
  mountRichCard(node, statusEl);
}

function onNodeCreated(node) {
  if (node.comfyClass !== NODE_TYPE && node.type !== NODE_TYPE) return;
  addButtons(node);
  hideRawWidgets(node);

  const originalExecuted = node.onExecuted;
  node.onExecuted = function (message) {
    const values = message?.aps_payload || message?.output?.aps_payload;
    const rawState = Array.isArray(values) ? values.at(-1) : null;
    if (rawState) {
      try {
        setPayload(node, JSON.parse(rawState));
        if (node._apsStatus) {
          node._apsStatus.textContent = "执行期反推完成，结果已写回节点。";
        }
      } catch (err) {
        console.warn("[ai-prompt-studio] failed to apply executed payload", err);
      }
    }
    return originalExecuted?.apply(this, arguments);
  };

  const originalConfigure = node.onConfigure;
  node.onConfigure = function (...args) {
    const res = originalConfigure?.apply(this, args);
    hideRawWidgets(node);
    node._apsOnResize?.();
    node._apsSyncCard?.();
    return res;
  };

  const originalConnectionsChange = node.onConnectionsChange;
  node.onConnectionsChange = function (...args) {
    const res = originalConnectionsChange?.apply(this, args);
    node._apsSyncCard?.();
    return res;
  };

  const originalResize = node.onResize;
  node.onResize = function (...args) {
    const res = originalResize?.apply(this, args);
    node._apsOnResize?.();
    return res;
  };

  const originalDrawForeground = node.onDrawForeground;
  node.onDrawForeground = function (...args) {
    const [curW, curH] = getNodeSize(node);
    if (node._apsLastW !== curW || node._apsLastH !== curH) {
      node._apsLastW = curW;
      node._apsLastH = curH;
      node._apsOnResize?.();
    }
    return originalDrawForeground?.apply(this, args);
  };

  const original = node.onDblClick;
  node.onDblClick = function (...args) {
    openEditor(node, node._apsStatus || { textContent: "" });
    return original?.apply(this, args);
  };
}

export const extension = {
  name: "AI Prompt Studio.CaptionNode",
  async setup() {
    mountStyles();
    for (const node of app?.graph?._nodes || []) onNodeCreated(node);
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_TYPE) return;
    const origCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const r = origCreated?.apply(this, args);
      onNodeCreated(this);
      return r;
    };
  },
  async nodeCreated(node) {
    onNodeCreated(node);
  },
};

app.registerExtension(extension);

export const _test = { upstreamImageFile, readPayload, setPayload, currentMode, currentModes };
