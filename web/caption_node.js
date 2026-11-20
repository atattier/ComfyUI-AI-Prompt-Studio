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

import { StudioApi } from "./lib/api.js?v=20261120_v51";
import {
  blobToDataUrl,
  fileToDataUrl,
  uploadImageFile,
  dataUrlToFile,
  parseComfyImageRef,
  buildComfyViewUrl,
} from "./lib/images.js";
import {
  DEFAULT_MODE_RULE_TEXTS,
  MODE_RULE_TABS,
  MOSS_CANVAS_PRESETS,
  OUTPUT_LANGUAGE_OPTIONS,
  canvasSizeForImage,
  rescaleLayoutDraft,
  normalizeDraft,
  openLayoutEditor,
  openSettingsModal,
  openSavePresetModal,
  openPresetLibraryModal,
  openImportPromptModal,
  renderSvgStage,
  BOX_COLORS,
  detectBoxDeletion,
  extractLayoutJsonObject,
  inferCanvasSizeFromLayout,
  compileLayoutDraftForMoss,
  decompileMossLayoutToDraft,
  cleanCaptionPreserveQuotesJs,
} from "./lib/layout_editor.js?v=20261120_v51";
import {
  anyStudioModalOpen,
  isEscapeKey,
  removeRegion,
  shouldDeleteSelection,
} from "./lib/hotkeys.js?v=20261120_v51";
import { UndoStack } from "./lib/undo.js";
import {
  excerpt,
  formatBusyStatusText,
  formatFriendlyError,
  formatErrorTechnicalDetail,
  wordDiffRanges,
} from "./lib/diff.js?v=20261120_v51";
import {
  imageMetadataSummary,
  mergeImageMetadataIntoState,
  openImageMetadataDialog,
} from "./lib/image_metadata.js?v=20261120_v51";
import {
  ensureChatThreads,
  createChatThread,
  switchChatThread,
  renameChatThread,
  deleteChatThread,
  clearChatThread,
  updateThreadTurns,
  setThreadSessionId,
  preserveChatThreads,
  stripChatStateForRollback,
} from "./lib/chat_threads.js?v=20261120_v51";

const NODE_TYPES = ["AIPromptStudioCaption", "AIPromptStudioImagine"];
const ALL_MODES = ["caption", "layout", "danbooru"];

function setNodeStatus(statusEl, msg, { kind = "", title = "" } = {}) {
  if (!statusEl) return;
  if (typeof statusEl.setRichStatus === "function") {
    statusEl.setRichStatus(msg, { kind, title });
  } else {
    statusEl.textContent = msg;
    if (statusEl.dataset) statusEl.dataset.kind = kind || "";
    if (title) statusEl.title = title;
  }
}

function reportNodeError(statusEl, err, actionName = "操作") {
  const friendly = formatFriendlyError(err, actionName);
  const tech = formatErrorTechnicalDetail(err);
  const tip = tech ? `${friendly}\n\n${tech}` : friendly;
  setNodeStatus(statusEl, friendly, { kind: "error", title: tip });
  return { friendly, tech, tip };
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
  if (!node) return;
  const isCaptionNode = node.comfyClass === "AIPromptStudioCaption" || node.type === "AIPromptStudioCaption";

  // 自愈清除 AIPromptStudioCaption 节点上历史临时废弃字段（theme, style, aspect 已正式作为主节点可选配置支持）
  if (isCaptionNode) {
    const invalidNames = new Set(["idea", "auto_brainstorm"]);
    if (Array.isArray(node.widgets)) {
      node.widgets = node.widgets.filter((w) => !w || !invalidNames.has(w.name));
    }
    if (Array.isArray(node.inputs)) {
      node.inputs = node.inputs.filter((i) => !i || !invalidNames.has(i.name));
    }
  }

  if (!node.widgets) return;

  // 自愈与修复 seed 控件类型，防止旧工作流反序列化错位导致输入值类型错误
  const seedW = widget(node, "seed");
  if (seedW) {
    const num = Number(seedW.value);
    if (typeof seedW.value !== "number" || isNaN(num) || !Number.isFinite(num)) {
      seedW.value = Math.max(0, Math.floor(Math.abs(num || 0)));
    }
  }

  // 自愈与规范灵感选项默认值，防止旧工作流反序列化缺失值导致后端校验拦截
  const themeW = widget(node, "theme");
  if (themeW && (!themeW.value || typeof themeW.value !== "string")) themeW.value = "random";
  const styleW = widget(node, "style");
  if (styleW && (!styleW.value || typeof styleW.value !== "string")) styleW.value = "auto";
  const aspectW = widget(node, "aspect");
  if (aspectW && (!aspectW.value || typeof aspectW.value !== "string")) aspectW.value = "auto";

  // 自愈与隔离旧工作流中可能被污染成 JSON 的 caption 文本
  const pw = widget(node, "payload");
  if (pw && pw.value && typeof pw.value === "string") {
    try {
      const st = JSON.parse(pw.value);
      if (st && typeof st === "object") {
        let changed = false;
        if (
          typeof st.caption === "string" &&
          (st.caption.includes('"items"') ||
            st.caption.includes('"layout"') ||
            st.caption.includes('"regions"') ||
            st.caption.includes('"objects"') ||
            st.caption.trim().startsWith("{"))
        ) {
          const pure = cleanPureCaptionText(st.caption);
          if (pure && pure !== st.caption) {
            st.caption = pure;
            st.caption_text = pure;
            changed = true;
          }
        }
        // 旧工作流曾把参考图 base64 写进 payload，导致文件膨胀到 9 MB+；加载时迁移掉。
        if (typeof st.last_image_data === "string" && st.last_image_data) {
          adoptRuntimePayloadImage(node, st);
          delete st.last_image_data;
          changed = true;
        }
        if (changed) {
          pw.value = payloadToJson(st);
        }
      }
    } catch {}
  }

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

const STYLE_VERSION = "20261120_v51";

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
  document.getElementById("aps-critical-v7")?.remove();
  document.getElementById("aps-critical-v9")?.remove();
  if (!document.getElementById("aps-critical-v10")) {
    const style = document.createElement("style");
    style.id = "aps-critical-v10";
    style.textContent = `
      .aps-mode-rule-tabs {
        display: flex;
        gap: 5px;
        flex-wrap: wrap;
      }
      .aps-mode-rule-tab {
        flex: 1 1 0;
        min-width: 82px;
        padding: 4px 8px;
        border-radius: 7px;
        border: 1px solid var(--aps-border, #343b44);
        background: color-mix(in srgb, var(--aps-panel, #1b212a) 75%, transparent);
        color: var(--aps-muted, #9aa4b2);
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        text-align: center;
      }
      .aps-mode-rule-tab.is-active {
        border-color: var(--aps-accent, #38bdf8);
        background: color-mix(in srgb, var(--aps-accent, #38bdf8) 18%, var(--aps-panel, #1b212a));
        color: var(--aps-fg, #e6edf3);
      }
      .aps-node-chat-wrap {
        display: flex;
        flex-direction: column;
        gap: 5px;
        padding: 6px 8px;
        border-radius: 8px;
        border: 1px solid var(--aps-border, #343b44);
        background: color-mix(in srgb, var(--aps-panel, #161b22) 65%, var(--aps-surface, #0f1318));
      }
      .aps-node-chat-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        font-size: 11px;
        min-width: 0;
      }
      .aps-node-chat-title {
        font-weight: 700;
        color: var(--aps-fg, #e6edf3);
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .aps-node-chat-head-actions {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-shrink: 0;
      }
      .aps-chat-threads-bar {
        display: flex;
        align-items: center;
        gap: 5px;
        flex-wrap: nowrap;
        min-width: 0;
        width: 100%;
        overflow-x: auto;
        overflow-y: hidden;
        padding: 2px 1px 4px;
      }
      .aps-chat-threads-bar[hidden] { display: none !important; }
      .aps-chat-thread-tab {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        max-width: 170px;
        padding: 3px 8px;
        border-radius: 7px;
        border: 1px solid var(--aps-border, #343b44);
        background: color-mix(in srgb, var(--aps-surface, #0f1318) 82%, transparent);
        color: var(--aps-muted, #94a3b8);
        font-size: 11px;
        line-height: 1.35;
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
      }
      .aps-chat-thread-tab.is-active {
        border-color: var(--aps-accent, #38bdf8);
        background: color-mix(in srgb, var(--aps-accent, #38bdf8) 18%, var(--aps-surface, #0f1318));
        color: var(--aps-fg, #e6edf3);
        font-weight: 600;
      }
      .aps-chat-thread-tab.is-disabled { opacity: 0.55; cursor: not-allowed; }
      .aps-chat-thread-label { max-width: 112px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .aps-chat-thread-count {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 15px;
        height: 15px;
        padding: 0 4px;
        border-radius: 999px;
        font-size: 9.5px;
        font-weight: 700;
        color: var(--aps-muted, #94a3b8);
        background: rgba(255, 255, 255, 0.08);
      }
      .aps-chat-thread-close {
        border: 0;
        background: transparent;
        color: var(--aps-muted, #94a3b8);
        font-size: 13px;
        line-height: 1;
        padding: 0 2px;
        border-radius: 4px;
        cursor: pointer;
        flex-shrink: 0;
      }
      .aps-chat-thread-rename {
        width: 108px;
        height: 20px;
        padding: 0 5px;
        border-radius: 5px;
        border: 1px solid var(--aps-accent, #38bdf8);
        background: var(--aps-surface, #0f1318);
        color: var(--aps-fg, #e6edf3);
        font-size: 11px;
        outline: none;
      }
      .aps-chat-empty-hint {
        padding: 10px;
        border-radius: 7px;
        border: 1px dashed var(--aps-border, #343b44);
        color: var(--aps-muted, #94a3b8);
        font-size: 11px;
        line-height: 1.5;
        text-align: center;
      }
      .aps-node-chat-log {
        display: flex;
        flex-direction: column;
        gap: 6px;
        max-height: 210px;
        overflow-y: auto;
        padding-right: 2px;
      }
      .aps-node-chat-log[hidden] { display: none !important; }
      .aps-chat-turn {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .aps-chat-bubble {
        padding: 5px 8px;
        border-radius: 7px;
        font-size: 11px;
        line-height: 1.45;
        word-break: break-word;
        white-space: pre-wrap;
      }
      .aps-chat-bubble-user {
        align-self: flex-end;
        max-width: 92%;
        border: 1px solid color-mix(in srgb, var(--aps-accent, #38bdf8) 45%, var(--aps-border, #343b44));
        background: color-mix(in srgb, var(--aps-accent, #38bdf8) 14%, var(--aps-surface, #0f1318));
        color: var(--aps-fg, #e6edf3);
      }
      .aps-chat-bubble-ai {
        align-self: flex-start;
        width: 100%;
        box-sizing: border-box;
        border: 1px solid var(--aps-border, #343b44);
        background: var(--aps-surface, #0f1318);
        color: var(--aps-fg, #e6edf3);
      }
      .aps-chat-bubble-ai.is-question {
        border-color: color-mix(in srgb, #f59e0b 60%, var(--aps-border, #343b44));
      }
      .aps-chat-bubble-ai.is-error {
        border-color: color-mix(in srgb, #ef4444 65%, var(--aps-border, #343b44));
      }
      .aps-chat-meta {
        font-size: 10px;
        font-weight: 700;
        color: var(--aps-muted, #94a3b8);
        margin-bottom: 2px;
      }
      .aps-chat-diff {
        margin-top: 4px;
        padding: 4px 6px;
        border-radius: 5px;
        background: rgba(0, 0, 0, 0.16);
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        font-size: 10px;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .aps-chat-diff-del { color: #f87171; }
      .aps-chat-diff-add { color: #4ade80; }
      .aps-chat-diff-sum { cursor: pointer; color: var(--aps-muted, #94a3b8); font-family: inherit; list-style: none; }
      .aps-chat-error-details { margin-top: 6px; padding: 5px 7px; border: 1px solid color-mix(in srgb, #ef4444 35%, var(--aps-border, #343b44)); background: rgba(0, 0, 0, 0.22); }
      .aps-chat-error-details .aps-chat-diff-sum { font-size: 10.5px; font-weight: 600; }
      .aps-chat-error-details .aps-chat-diff-sum::before { content: ""; display: inline-block; }
      .aps-chat-error-details[open] .aps-chat-diff-sum::before { content: ""; }
      .aps-chat-error-pre { margin: 5px 0 0; padding: 6px 8px; border-radius: 5px; background: rgba(0, 0, 0, 0.28); border: 1px solid color-mix(in srgb, var(--aps-border, #343b44) 75%, transparent); color: var(--aps-fg, #e6edf3); font-family: ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, monospace; font-size: 10px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; max-height: 145px; overflow-y: auto; }
      .aps-menu-wrap { position: relative; display: inline-flex; }
      .aps-menu { position: absolute; top: calc(100% + 4px); left: 0; z-index: 60; min-width: 168px; display: flex; flex-direction: column; gap: 2px; padding: 5px; border-radius: 9px; border: 1px solid var(--aps-border, #343b44); background: var(--aps-panel, #161b22); box-shadow: 0 8px 24px rgba(0,0,0,.28); }
      .aps-menu[hidden] { display: none !important; }
      .aps-menu.is-right { left: auto; right: 0; }
      .aps-menu.aps-menu-up { top: auto; bottom: calc(100% + 4px); }
      .aps-menu .aps-menu-item { display: flex; align-items: center; justify-content: flex-start; gap: 6px; width: 100%; text-align: left; border: 0 !important; background: transparent !important; box-shadow: none !important; padding: 6px 8px; border-radius: 6px; font-size: 12px; cursor: pointer; color: var(--aps-fg, #e6edf3); }
      .aps-menu .aps-menu-item:hover { background: color-mix(in srgb, var(--aps-accent, #38bdf8) 16%, transparent) !important; }
      .aps-menu-sub { margin-left: auto; opacity: .55; font-size: 10px; }
      .aps-menu-row { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; }
      .aps-menu-row .aps-menu-sub { margin-left: 0; }
      .aps-mode-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: .25; display: inline-block; margin-right: 5px; }
      .aps-mode-multi-btn.is-checked .aps-mode-dot { opacity: .9; background: #22c55e; }
      .aps-node-topbar { display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; width: 100%; box-sizing: border-box; }
      .aps-node-topbar .aps-node-wb-btn { margin-left: auto; }
      .aps-node-topbar-left { display: none; min-width: 0; }
      .aps-node-topbar-right { display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; width: 100%; min-width: 0; }
      .aps-node-topbar-right .aps-node-wb-btn { margin-left: auto; }
      .aps-node-card[data-dock="split"] .aps-node-topbar {
        display: grid !important;
        grid-template-rows: auto !important;
        gap: 10px !important;
        align-items: center !important;
      }
      .aps-node-card[data-dock="split"] .aps-node-topbar-left {
        display: flex !important;
        align-items: center !important;
        min-width: 0 !important;
      }
      .aps-node-card[data-dock="split"] .aps-node-topbar-right {
        display: flex !important;
        align-items: center !important;
        gap: 6px !important;
        width: 100% !important;
        min-width: 0 !important;
      }
      .aps-chat-diff-sum::-webkit-details-marker { display: none; }
      .aps-prompt-markview { overflow: auto; white-space: pre-wrap; word-break: break-word; cursor: text; position: relative; }
      .aps-prompt-markview[hidden] { display: none !important; }
      .aps-prompt-mark { background: rgba(34, 197, 94, 0.22); color: inherit; border-bottom: 2px solid rgba(34, 197, 94, 0.75); border-radius: 2px; padding: 0 1px; }
      .aps-prompt-marktag { position: sticky; float: right; bottom: 2px; right: 2px; font-size: 10px; padding: 1px 7px; border-radius: 9px; background: rgba(34, 197, 94, 0.16); color: #16a34a; pointer-events: none; }
      .aps-chat-actions {
        margin-top: 5px;
        display: flex;
        align-items: center;
        gap: 5px;
        flex-wrap: wrap;
      }
      .aps-chat-badge {
        font-size: 10px;
        color: var(--aps-muted, #94a3b8);
        padding: 1px 5px;
        border-radius: 4px;
        border: 1px solid var(--aps-border, #343b44);
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
  if (
    typeof state.caption === "string" &&
    (state.caption.includes('"items"') ||
      state.caption.includes('"layout"') ||
      state.caption.includes('"regions"') ||
      state.caption.includes('"objects"') ||
      state.caption.trim().startsWith("{"))
  ) {
    const cleanedCap = cleanPureCaptionText(state.caption);
    if (cleanedCap) {
      state.caption = cleanedCap;
      state.caption_text = cleanedCap;
    }
  }
  if (!state.draft?.items?.length) {
    if (state.layout_draft?.items?.length) {
      state.draft = { ...state.layout_draft };
    } else if (state.hybrid_draft?.items?.length) {
      state.draft = { ...state.hybrid_draft };
    } else if (Array.isArray(state.regions) && state.regions.length > 0) {
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
  }
  return state;
}

/**
 * Base64 image bytes are runtime-only.
 *
 * The payload widget is serialized into `widgets_values` (and
 * `widgets_values_named`), so persisting the reference image there inflated a
 * single workflow to ~9 MB and blew the browser's draft quota, popping
 * "保存工作流草稿失败" on every canvas edit. The image itself is recoverable
 * from `last_image_file` through ComfyUI's `/view` endpoint, so only that
 * filename is written to the workflow.
 */
const PAYLOAD_RUNTIME_IMAGE_KEYS = ["last_image_data"];

function stripPayloadImageData(state) {
  if (!state || typeof state !== "object") return state;
  let copy = null;
  for (const key of PAYLOAD_RUNTIME_IMAGE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(state, key)) {
      copy = copy || { ...state };
      delete copy[key];
    }
  }
  return copy || state;
}

/** Serialize state for the payload widget without runtime-only image bytes. */
function payloadToJson(state) {
  return JSON.stringify(stripPayloadImageData(state));
}

/** Keep a legacy embedded data URL available at runtime without persisting it. */
function adoptRuntimePayloadImage(node, state) {
  if (state?.image_detached === true) return;
  const dataUrl = state?.last_image_data;
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) return;
  // Never replace an image the node is already showing (e.g. a freshly uploaded one).
  if (node._apsImageDataUrl) return;
  node._apsImageDataUrl = dataUrl;
  if (node.id) saveSessionImage(node.id, dataUrl);
}

function setPayload(node, state) {
  const w = widget(node, "payload");
  if (!w) throw new Error("节点缺少 payload 控件。");
  const normalized = normalizeStateObject(state);
  adoptRuntimePayloadImage(node, normalized);
  w.value = payloadToJson(normalized);
  node._apsDirty = false;
  node._apsSyncCard?.();
  node.setDirtyCanvas?.(true, true);
}

/**
 * The AIPromptStudioCaption card that last received a pointer press.
 *
 * Several caption nodes can live on one canvas, each tracking its own
 * `selectedRegion`; the Delete shortcut must only answer the node the user
 * last touched, otherwise one keypress could remove two boxes.
 */
let lastActiveStageCard = null;

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
    if (pw) pw.value = payloadToJson(state);
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


function getSessionImageKey(nodeId) {
  return `aps_img_cache_${nodeId}`;
}

function getSessionImage(nodeId) {
  if (!nodeId) return null;
  try {
    if (typeof sessionStorage !== "undefined") {
      return sessionStorage.getItem(getSessionImageKey(nodeId)) || null;
    }
  } catch {}
  return null;
}

function saveSessionImage(nodeId, dataUrl) {
  if (!dataUrl || !nodeId) return;
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(getSessionImageKey(nodeId), dataUrl);
    }
  } catch {
    try {
      if (typeof sessionStorage !== "undefined") {
        for (let i = sessionStorage.length - 1; i >= 0; i--) {
          const k = sessionStorage.key(i);
          if (k && k.startsWith("aps_img_cache_") && k !== getSessionImageKey(nodeId)) {
            sessionStorage.removeItem(k);
          }
        }
        sessionStorage.setItem(getSessionImageKey(nodeId), dataUrl);
      }
    } catch {}
  }
}

/** 解除底图时把缓存一并清掉，否则刷新页面又会把旧图捞回来。 */
function clearSessionImage(nodeId) {
  if (!nodeId) return;
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.removeItem(getSessionImageKey(nodeId));
    }
  } catch {}
}

/**
 * Recursively find the upstream image-producing node feeding our IMAGE input,
 * hopping through Reroute, preview, and pass-through nodes up to 10 levels deep.
 */
function findUpstreamImageSourceNode(node, depth = 0) {
  if (!node || depth > 10) return null;
  const link = node.inputs?.find((i) => (i.name === "image" || i.type === "IMAGE") && i.link != null);
  if (!link) return null;
  const graph = node.graph || app?.graph;
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

  // If this node provides an image (LoadImage, widget, imgs, images), return it
  if (
    source.type === "LoadImage" ||
    source.comfyClass === "LoadImage" ||
    source.widgets?.some((w) => w.name === "image" || w.name === "image_path") ||
    (Array.isArray(source.imgs) && source.imgs.length > 0) ||
    (Array.isArray(source.images) && source.images.length > 0)
  ) {
    return source;
  }

  // If it's a Reroute, mute/bypass, or intermediate node, trace its inputs further
  const upstream = findUpstreamImageSourceNode(source, depth + 1);
  return upstream || source;
}

function upstreamImageNode(node) {
  return findUpstreamImageSourceNode(node);
}

function getUpstreamLoadImageNode(node) {
  return findUpstreamImageSourceNode(node);
}

/** Get image URL directly from source node if already rendered by ComfyUI */
function getSourceNodeImageUrl(source) {
  if (!source) return null;
  if (Array.isArray(source.imgs) && source.imgs[0]?.src) {
    return source.imgs[0].src;
  }
  if (Array.isArray(source.images) && source.images[0]?.src) {
    return source.images[0].src;
  }
  const fileWidget = source.widgets?.find((w) => w.name === "image" || w.name === "image_path");
  if (fileWidget?.value && typeof fileWidget.value === "string") {
    return buildComfyViewUrl(fileWidget.value);
  }
  return null;
}

/** Find the upstream node feeding our IMAGE input and read its filename widget. */
function upstreamImageFile(node) {
  const source = findUpstreamImageSourceNode(node);
  if (!source) return null;
  const fileWidget = source.widgets?.find((w) => w.name === "image" || w.name === "image_path");
  const value = fileWidget?.value;
  if (!value || typeof value !== "string") return null;
  return value;
}

/**
 * Find the most recent downstream image generated from this node's output prompt/parameters,
 * or fall back to any recently executed image node in the workflow.
 * Returns { filename, subfolder, type } or null.
 */
function findDownstreamImageCandidate(node) {
  if (!node) return null;
  const graph = node.graph || app?.graph;
  if (!graph) return null;

  function getLink(linkId) {
    if (linkId == null) return null;
    if (typeof graph.links?.get === "function") return graph.links.get(linkId);
    if (Array.isArray(graph.links)) return graph.links.find((l) => l && (l.id === linkId || l[0] === linkId));
    return graph.links?.[linkId] || null;
  }

  function getNode(nodeId) {
    if (nodeId == null) return null;
    if (typeof graph.getNodeById === "function") return graph.getNodeById(nodeId);
    return (graph._nodes || []).find((n) => String(n?.id) === String(nodeId)) || null;
  }

  function extractImageRef(targetNode) {
    if (!targetNode) return null;
    // 1. Direct ComfyUI images array on node
    if (Array.isArray(targetNode.images) && targetNode.images.length > 0) {
      const last = targetNode.images[targetNode.images.length - 1];
      if (last?.filename) {
        return { filename: last.filename, subfolder: last.subfolder || "", type: last.type || "output" };
      }
    }
    // 2. ComfyUI app.nodeOutputs
    const out = app?.nodeOutputs?.[targetNode.id] || app?.nodeOutputs?.[String(targetNode.id)];
    if (Array.isArray(out?.images) && out.images.length > 0) {
      const last = out.images[out.images.length - 1];
      if (last?.filename) {
        return { filename: last.filename, subfolder: last.subfolder || "", type: last.type || "output" };
      }
    }
    // 3. imgs array (HTMLImageElement)
    if (Array.isArray(targetNode.imgs) && targetNode.imgs.length > 0) {
      const lastImg = targetNode.imgs[targetNode.imgs.length - 1];
      const src = lastImg?.src || (typeof lastImg === "string" ? lastImg : null);
      if (src) {
        try {
          const u = new URL(src, window.location.origin);
          const filename = u.searchParams.get("filename");
          if (filename) {
            return {
              filename,
              subfolder: u.searchParams.get("subfolder") || "",
              type: u.searchParams.get("type") || "output",
            };
          }
        } catch {}
      }
    }
    return null;
  }

  // 1. BFS downstream from our node's outputs (depth <= 12)
  const visited = new Set([String(node.id)]);
  const queue = [node];
  let depth = 0;

  while (queue.length > 0 && depth < 12) {
    depth++;
    const levelSize = queue.length;
    for (let s = 0; s < levelSize; s++) {
      const cur = queue.shift();
      if (!cur?.outputs) continue;

      for (const out of cur.outputs) {
        if (!out?.links || !Array.isArray(out.links)) continue;
        for (const linkId of out.links) {
          const lk = getLink(linkId);
          if (!lk) continue;
          const targetId = lk.target_id != null ? lk.target_id : lk[3];
          if (targetId == null || visited.has(String(targetId))) continue;
          visited.add(String(targetId));
          const target = getNode(targetId);
          if (!target) continue;

          const ref = extractImageRef(target);
          if (ref) return ref;
          queue.push(target);
        }
      }
    }
  }

  // 2. Fallback: check any SaveImage / PreviewImage in the whole graph that has executed images
  const allNodes = graph._nodes || [];
  for (let i = allNodes.length - 1; i >= 0; i--) {
    const n = allNodes[i];
    if (n && String(n.id) !== String(node.id)) {
      const typeStr = String(n.type || n.comfyClass || "");
      if (typeStr.includes("SaveImage") || typeStr.includes("PreviewImage") || typeStr.includes("Image")) {
        const ref = extractImageRef(n);
        if (ref) return ref;
      }
    }
  }

  return null;
}

/** Robust reference image switcher: uploads to ComfyUI, syncs upstream LoadImage, and persists to node state. */
function probeImageSize(dataUrl) {
  return new Promise((resolve) => {
    if (!dataUrl || typeof Image === "undefined") {
      resolve(null);
      return;
    }
    const probe = new Image();
    probe.onload = () => resolve({ nw: probe.naturalWidth, nh: probe.naturalHeight });
    probe.onerror = () => resolve(null);
    probe.src = dataUrl;
  });
}

/**
 * 换底图时让画布跟着新图走。
 * 只在新图比例与当前画布明显不同时才改尺寸——用户手动选的画布分辨率不会被同比例的换图冲掉。
 */
async function adoptCanvasSizeToImage(node, dataUrl, statusEl = null) {
  const size = await probeImageSize(dataUrl);
  if (!size || !size.nw || !size.nh) return false;
  const state = readPayload(node);
  const oldW = Number(state.width) || 1024;
  const oldH = Number(state.height) || 1024;
  if (Math.abs(size.nw / size.nh - oldW / oldH) < 0.02) return false;

  const want = canvasSizeForImage(size.nw, size.nh);
  node._apsUndo?.record({
    key: "payload_state",
    before: JSON.stringify(state),
    after: "",
    label: `画布跟随新图 ${want.width}×${want.height}`,
    source: "stage",
  });
  state.width = want.width;
  state.height = want.height;
  if (state.draft) state.draft = rescaleLayoutDraft(state.draft, want.width, want.height, oldW, oldH);
  if (state.layout_draft) {
    state.layout_draft = rescaleLayoutDraft(state.layout_draft, want.width, want.height, oldW, oldH);
  }
  if (state.hybrid_draft) {
    state.hybrid_draft = rescaleLayoutDraft(state.hybrid_draft, want.width, want.height, oldW, oldH);
  }
  setPayload(node, state);
  node._apsDirty = true;
  if (statusEl) {
    statusEl.textContent = `画布已跟随新图：${want.width}×${want.height}（原 ${oldW}×${oldH}，画框已按比例缩放）`;
  }
  node._apsSyncCard?.();
  return true;
}


async function maybeOfferImageMetadata(node, meta, filename, statusEl, imageSeq = 0) {
  if (!meta?.found) {
    const base = String(statusEl?.textContent || "").trim();
    setNodeStatus(statusEl, base ? `${base} · 未发现提示词元数据` : "未发现提示词元数据");
    return false;
  }
  try {
    const summary = imageMetadataSummary(meta);
    const state = readPayload(node);
    const hasText = (value) =>
      Array.isArray(value) ? value.length > 0 : Boolean(String(value || "").trim());
    const hasContent =
      hasText(state.caption_text) ||
      hasText(state.caption) ||
      hasText(state.danbooru_prompt) ||
      hasText(state.danbooru_text) ||
      hasText(state.tags) ||
      hasText(state.layout_prompt) ||
      (Array.isArray(state.draft?.items) && state.draft.items.length > 0);
    const ok = await openImageMetadataDialog({
      summary,
      willOverwrite: hasContent,
      imageName: filename,
      width: Number(meta.width) || 0,
      height: Number(meta.height) || 0,
    });
    if (!ok) {
      setNodeStatus(statusEl, "已忽略图片自带的提示词。");
      return false;
    }
    if (node._apsImageSeq !== imageSeq) {
      setNodeStatus(statusEl, "已加载新图，忽略上一张图的提示词。");
      return false;
    }
    const before = JSON.stringify(readPayload(node));
    const next = readPayload(node);
    const { applied, boxCount } = mergeImageMetadataIntoState(next, meta, {
      width: Number(next.width) || 1024,
      height: Number(next.height) || 1024,
      overwriteAll: true,
    });
    node._apsUndo?.record({
      key: "payload_state",
      before,
      after: "",
      label: "应用图片自带提示词",
      source: "stage",
    });

    // 自动切换到图片自带的提示词模式并同步更新对应输出通道
    const promptModes = applied.filter((kind) => kind !== "boxes");
    let targetMode = "caption";
    if (promptModes.includes("layout") || boxCount > 0) {
      targetMode = "layout";
    } else if (promptModes.includes("danbooru") && !promptModes.includes("caption")) {
      targetMode = "danbooru";
    } else if (promptModes.includes("caption")) {
      targetMode = "caption";
    } else if (promptModes.length > 0) {
      targetMode = promptModes[0];
    }
    const targetModes = promptModes.length > 0 ? promptModes : [targetMode];
    syncModeWidgets(node, targetModes, targetMode);

    setPayload(node, next);
    node._apsDirty = false;
    node._apsSyncCard?.();
    node.setDirtyCanvas?.(true, true);
    const labels = { caption: "散文", layout: "布局", danbooru: "Danbooru" };
    const parts = applied
      .filter((kind) => kind !== "boxes")
      .map((kind) => labels[kind])
      .filter(Boolean);
    if (boxCount) parts.push(`${boxCount} 个画框`);
    setNodeStatus(
      statusEl,
      `✓ 已应用图片自带提示词${parts.length ? `：${parts.join(" · ")}` : ""}（已清空旧提示词与画框）`,
    );
    return true;
  } catch (err) {
    console.warn("[ai-prompt-studio] 应用图片元数据失败:", err);
    return false;
  }
}

/**
 * 彻底解除参考图：内存缓存、sessionStorage、last_image_file 一起清掉。
 * 之后 AI 对话与改词都不再上传这张图，画框与提示词保持不动。
 */
function detachReferenceImage(node, statusEl = null) {
  const state = readPayload(node);
  // 记下"被断掉的那张图"：之后上游如果换成别的文件，仍然应该认作新底图。
  const dropped = state.last_image_file || node._apsLastUpstreamFile || "";
  if (dropped) state.detached_from_file = dropped;
  node._apsImageDataUrl = null;
  node._apsLastUpstreamFile = null;
  if (node.id) clearSessionImage(node.id);
  state.image_detached = true;
  delete state.last_image_file;
  delete state.source;
  setPayload(node, state);
  node._apsSyncCard?.();
  node.setDirtyCanvas?.(true, true);
  if (statusEl) {
    statusEl.textContent = "已解除底图：AI 对话与改词不再携带这张图。";
  }
}

async function handleNewReferenceImage(node, fileOrDataUrl, statusEl = null, options = {}) {
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

  // Read the image's own prompt metadata in parallel with the upload; the dialog
  // only appears once the canvas has settled on the new picture's size. The
  // sequence number keeps a slow inspection for image A from landing on image B.
  const imageSeq = (node._apsImageSeq || 0) + 1;
  node._apsImageSeq = imageSeq;
  let metadataTimer = null;
  let metadataController = null;
  const detection = options.skipMetadata
    ? null
    : (() => {
        metadataController = typeof AbortController === "function" ? new AbortController() : null;
        if (metadataController) {
          metadataTimer = setTimeout(() => metadataController.abort(), 10_000);
        }
        return api
          .inspectImage({
            dataUrl,
            filename: fileObj?.name || "",
            signal: metadataController?.signal,
          })
          .catch((err) => {
            if (err?.name !== "AbortError") {
              console.warn("[ai-prompt-studio] 图片元数据检测失败:", err);
            }
            return null;
          })
          .finally(() => {
            if (metadataTimer) clearTimeout(metadataTimer);
            metadataTimer = null;
          });
      })();

  // 1. Immediately display on stage and cache to session
  node._apsImageDataUrl = dataUrl;
  if (node.id) saveSessionImage(node.id, dataUrl);
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

  // 4. Save to persistent state so F5 refresh or restart won't reset to example.png.
  //    Only the server filename is persisted; the base64 stays in memory/sessionStorage
  //    and is re-fetched from ComfyUI after a reload.
  const state = readPayload(node);
  state.last_image_file = serverFilename;
  delete state.source;
  delete state.image_detached;
  delete state.detached_from_file;
  node._apsLastUpstreamFile = serverFilename;
  setPayload(node, state);

  // 5. 画布跟随新图：旧代码把上一张图的尺寸一直留着，新图被塞进旧画布。
  const adopted = await adoptCanvasSizeToImage(node, dataUrl, null);

  if (statusEl) {
    const base = upstream
      ? `已加载参考图并同步上游节点：${serverFilename}`
      : `已加载参考图：${serverFilename}`;
    statusEl.textContent = adopted ? `${base}（画布已跟随新图）` : base;
  }
  node._apsSyncCard?.();

  if (detection) {
    const meta = await detection;
    if (meta && node._apsImageSeq === imageSeq) {
      await maybeOfferImageMetadata(node, meta, fileObj?.name || "", statusEl, imageSeq);
    }
  }
}

/** Hook upstream LoadImage widget so choosing another image updates this node immediately. */
function hookUpstreamImageNode(node) {
  const source = findUpstreamImageSourceNode(node);
  if (!source) return;
  const fileWidget = source.widgets?.find((w) => w.name === "image" || w.name === "image_path");
  if (fileWidget && !fileWidget._apsHooked) {
    fileWidget._apsHooked = true;
    const origCallback = fileWidget.callback;
    fileWidget.callback = function (...args) {
      const res = origCallback?.apply(this, args);
      setTimeout(() => {
        node._apsSyncCard?.();
      }, 60);
      return res;
    };
  }
  if (!source._apsExecutedHooked && typeof source.onExecuted === "function") {
    source._apsExecutedHooked = true;
    const origExec = source.onExecuted;
    source.onExecuted = function (...args) {
      const res = origExec?.apply(this, args);
      setTimeout(() => {
        node._apsSyncCard?.();
      }, 100);
      return res;
    };
  }
}

async function fetchImageDataUrl(node) {
  // 用户导入纯文本提示词后主动解除了底图：不再回读上游图，也不把旧图塞回画布。
  if (readPayload(node).image_detached === true) return null;
  const sourceNode = findUpstreamImageSourceNode(node);
  const directUrl = getSourceNodeImageUrl(sourceNode);
  const upFile = upstreamImageFile(node);
  // After a reload the base64 cache may be gone; fall back to the reference image
  // this node uploaded itself (persisted as `last_image_file`, served by /view).
  const savedFile = readPayload(node).last_image_file || null;
  const filename =
    upFile && !String(upFile).includes("example") ? upFile : savedFile || upFile;

  if (directUrl && directUrl.startsWith("data:")) {
    node._apsImageDataUrl = directUrl;
    if (node.id) saveSessionImage(node.id, directUrl);
    return directUrl;
  }

  if (filename && node._apsLastUpstreamFile === filename && node._apsImageDataUrl) {
    return node._apsImageDataUrl;
  }
  if (!filename && node._apsImageDataUrl) {
    return node._apsImageDataUrl;
  }

  const viewUrl = directUrl || (filename ? buildComfyViewUrl(filename) : null);
  if (!viewUrl) {
    const cached = node._apsImageDataUrl || (node.id ? getSessionImage(node.id) : null);
    if (cached) return cached;
    return null;
  }

  const response = await fetch(viewUrl, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`读取上游图片失败（HTTP ${response.status}）。`);
  const blob = await response.blob();
  if (blob.size > MAX_IMAGE_BYTES) {
    throw new Error(`图片过大（${Math.round(blob.size / 1024 / 1024)} MB），上限 8 MB。`);
  }
  if (!String(blob.type || "").startsWith("image/")) {
    throw new Error("上游节点输出的不是图片。");
  }
  const dataUrl = await blobToDataUrl(blob);
  if (filename) node._apsLastUpstreamFile = filename;
  node._apsImageDataUrl = dataUrl;
  if (node.id) saveSessionImage(node.id, dataUrl);
  return dataUrl;
}

async function runCaption(node, statusEl) {
  healLegacyWidgets(node);
  const mode = currentMode(node);
  const modes = currentModes(node);
  const pathWidget = widget(node, "image_path");
  const imagePath = cleanWidgetStr(pathWidget?.value, { isPath: true });
  const existing = readPayload(node);
  const { activeId: reqThreadId, activeThread: reqThread } = ensureChatThreads(existing, { maxTurns: 20 });
  const reqSessionId = reqThread?.session_id || node._apsSessionId || undefined;
  // 编辑保护：用户手改过内容时，不静默覆盖。
  if (node._apsDirty && (existing.caption || existing.draft)) {
    if (!globalThis.confirm?.("已手动编辑过反推结果，重新反推会覆盖修改。继续吗？")) return;
  }
  statusEl.textContent = `正在反推图片（模式：${modes.join(" + ")}）…`;
  node._apsSetBusy?.(true, `正在扫描底图并反推 (${modes.join(" + ")})…`, true);
  try {
    const imageData = await fetchImageDataUrl(node);
    if (!imageData && !imagePath) {
      throw new Error(
        existing.image_detached === true
          ? "已解除底图引用，当前是纯文本编辑状态。要反推请先「上传/换图」或连接 LoadImage 节点。"
          : "请连接 LoadImage 节点、在节点内上传图片，或填写本地 image_path。",
      );
    }
    const body = {
      mode,
      modes,
      image_path: imagePath,
      extra_instruction: cleanWidgetStr(widget(node, "extra_instruction")?.value),
      model: cleanWidgetStr(widget(node, "model")?.value),
      session_id: reqSessionId,
      create_session: true,
    };
    if (imageData) body.image = { data_url: imageData };
    const result = await api.request("/caption_node", { method: "POST", body });
    const prevText = String(existing.caption || existing.draft?.summary?.caption || "");
    const state = result.payload || {};
    const latestExisting = readPayload(node);
    preserveChatThreads(state, latestExisting, { maxTurns: 20 });
    if (result.session_id) {
      setThreadSessionId(state, reqThreadId, result.session_id, { maxTurns: 20 });
    }
    const { activeThread: resolvedThread } = ensureChatThreads(state, { maxTurns: 20 });
    node._apsSessionId = resolvedThread?.session_id || null;
    state.mode = mode;
    state.modes = result.modes || modes;
    const activeFile = upstreamImageFile(node) || existing.last_image_file || node._apsLastUpstreamFile;
    if (activeFile) {
      state.last_image_file = activeFile;
    }
    // 反推用的是真实底图，这次反推本身就说明底图重新生效了。
    delete state.image_detached;
    delete state.detached_from_file;
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
    statusEl.textContent = result.warning
      ? `${result.warning}（其余已就绪：${result.width}×${result.height}）`
      : `反推完成（${modes.length}个格式已就绪）：${result.width}×${result.height}`;
    node._apsSyncCard?.();
    node.setDirtyCanvas?.(true, true);
  } catch (err) {
    reportNodeError(statusEl, err, "反推");
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
  // 用户已解除底图：不要再回读上游图，打开工作台就是干净的纯文本画布。
  if (state.image_detached === true) imageUrl = null;
  if (!imageUrl && state.image_detached !== true) {
    try {
      imageUrl = await fetchImageDataUrl(node);
    } catch {
      imageUrl = null;
    }
  }
  const pathVal = cleanWidgetStr(widget(node, "image_path")?.value, { isPath: true });
  if (pathVal) state.image_path = pathVal;
  const { activeThread: initThread } = ensureChatThreads(state, { maxTurns: 25 });
  if (node._apsSessionId && initThread && !initThread.session_id) {
    setThreadSessionId(state, initThread.id, node._apsSessionId, { maxTurns: 25 });
  }

  openLayoutEditor({
    state,
    mode,
    imageUrl,
    api,
    imageCandidate: () => findDownstreamImageCandidate(node),
    sessionId: initThread?.session_id || node._apsSessionId || null,
    showBoxes: state.stage_boxes_visible !== false,
    onChatStateChange: (chatState) => {
      const st = readPayload(node);
      if (Array.isArray(chatState?.chat_threads)) {
        st.chat_threads = JSON.parse(JSON.stringify(chatState.chat_threads));
      }
      if (chatState?.active_chat_id) st.active_chat_id = chatState.active_chat_id;
      if (chatState?.chat_seq) st.chat_seq = chatState.chat_seq;
      const { activeThread: act } = ensureChatThreads(st, { maxTurns: 25 });
      node._apsSessionId = act?.session_id || null;
      const pw = widget(node, "payload");
      if (pw) pw.value = payloadToJson(st);
      node._apsSyncChatLog?.();
      node.setDirtyCanvas?.(true, true);
    },
    onSessionChange: (sid) => {
      const st = readPayload(node);
      const { activeId } = ensureChatThreads(st, { maxTurns: 25 });
      setThreadSessionId(st, activeId, sid || null, { maxTurns: 25 });
      node._apsSessionId = sid || null;
      const pw = widget(node, "payload");
      if (pw) pw.value = payloadToJson(st);
    },
    onChatLogChange: (nextLog) => {
      const st = readPayload(node);
      const { activeId } = ensureChatThreads(st, { maxTurns: 25 });
      updateThreadTurns(st, activeId, nextLog, {
        sessionId: node._apsSessionId || undefined,
        maxTurns: 25,
      });
      const pw = widget(node, "payload");
      if (pw) pw.value = payloadToJson(st);
      node._apsSyncChatLog?.();
    },
    onImageChange: (dataUrl) => {
      if (!dataUrl) {
        // 工作台里解除了底图：节点缓存、sessionStorage 与上游文件名都要一起断掉，
        // 否则下一次对话/改词又会把旧图读回来当参考。
        detachReferenceImage(node, statusEl);
        return;
      }
      // The workbench keeps its own draft copy; applying metadata to the node
      // behind it would be overwritten by its later 「应用」.
      void handleNewReferenceImage(node, dataUrl, statusEl, { skipMetadata: true });
    },
    onApply: (next) => {
      const resolvedMode = next.mode || mode;
      const resolvedModes = Array.isArray(next.modes) && next.modes.length ? next.modes : currentModes(node);
      delete next.image_path;
      syncModeWidgets(node, resolvedModes, resolvedMode);
      const { activeThread: appliedThread } = ensureChatThreads(next, { maxTurns: 25 });
      node._apsSessionId = appliedThread?.session_id || null;
      // 解除底图后不能再把旧文件名塞回去，否则下一句对话又会带着这张图。
      if (next.image_detached === true) {
        delete next.last_image_file;
        delete next.source;
      } else if (state.last_image_file && !next.last_image_file) {
        next.last_image_file = state.last_image_file;
      }
      if (next.draft?.items) {
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
      node._apsSyncChatLog?.();
      node.setDirtyCanvas?.(true, true);
    },
    onCancel: () => {
      statusEl.textContent = "已关闭工作台。";
      node._apsSyncChatLog?.();
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
      statusEl.textContent = `✓ 设置已保存（模型：${nodeRes?.model || cfg?.model || "默认"} · 三模式独立规则已生效）`;
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

/** Extract pure narrative English caption without JSON markup, preserving internal/closing quotes. */
function cleanPureCaptionText(text) {
  return cleanCaptionPreserveQuotesJs(text);
}

/** Read the active prompt text for the currently selected mode on the node card. */
function activePromptForMode(state, mode) {
  if (!state || typeof state !== "object") return "";

  if (mode === "caption") {
    // 散文模式：绝对保证返回纯文本散文，杜绝任何 JSON 结构
    let cap = String(state.caption_text || state.caption || "");
    if (
      cap.includes('"items"') ||
      cap.includes('"layout"') ||
      cap.includes('"regions"') ||
      cap.includes('"objects"') ||
      cap.trim().startsWith("{")
    ) {
      const pure = cleanPureCaptionText(cap);
      if (pure) cap = pure;
      else if (state.draft?.summary?.caption) cap = String(state.draft.summary.caption);
    }
    if (!cap && state.draft?.summary?.caption) {
      cap = String(state.draft.summary.caption);
    }
    return cap.trim();
  }

  if (mode === "layout") {
    // 布局模式：返回编译后的 MOSS-Image 官方 abs_centralized + yxyx 布局 JSON（带前后遮挡短语与 meta/palette）
    const w = Number(state.width) || 1024;
    const h = Number(state.height) || 1024;
    const draft = (state.layout_draft?.items?.length ? state.layout_draft : null) || state.draft;
    if (draft && typeof draft === "object" && Array.isArray(draft.items) && draft.items.length > 0) {
      const compiled = compileLayoutDraftForMoss(draft, w, h);
      return JSON.stringify(compiled);
    }
    const rawFallback = state.layout_prompt || state.layout;
    if (rawFallback && typeof rawFallback === "string" && rawFallback.trim().startsWith("{")) {
      return rawFallback.trim();
    }
    // 尚未生成 items 时，返回标准格式骨架 JSON
    const summaryCap = cleanPureCaptionText(String(state.caption_text || state.caption || "A composed image."));
    return JSON.stringify({
      summary: { caption: summaryCap, canvas: "single" },
      items: [],
      bbox_coord_space: "abs_centralized",
      bbox_format: "yxyx",
    });
  }

  // danbooru 模式：纯逗号标签
  return String(
    state.danbooru_prompt ||
      state.danbooru_text ||
      state.tags ||
      ""
  ).trim();
}

/** Write edited text back into the corresponding mode slot of `state` with strict slot isolation. */
function writePromptForMode(state, mode, nextVal) {
  if (!state || typeof state !== "object") return;
  const val = String(nextVal || "").trim();

  if (mode === "caption") {
    const pure = cleanPureCaptionText(val);
    state.caption = pure;
    state.caption_text = pure;
    if (state.draft?.summary) state.draft.summary.caption = pure;
    if (state.layout_draft?.summary) state.layout_draft.summary.caption = pure;
    if (state.hybrid_draft?.summary) state.hybrid_draft.summary.caption = pure;
  } else if (mode === "layout") {
    const parsed = extractLayoutJsonObject(val);
    if (parsed && typeof parsed === "object") {
      const curW = Number(state.width) || 1024;
      const curH = Number(state.height) || 1024;
      const [w, h] = inferCanvasSizeFromLayout(parsed, curW, curH);
      const prevSumCap = String(state.draft?.summary?.caption || "").trim();
      const internalDraft = decompileMossLayoutToDraft(parsed, w, h, state.draft);
      state.width = w;
      state.height = h;
      state.draft = internalDraft;
      state.layout_draft = internalDraft;
      state.hybrid_draft = internalDraft;
      state.layout_prompt = JSON.stringify(compileLayoutDraftForMoss(internalDraft, w, h));
      delete state.layout_raw_json;
      const subCap = cleanPureCaptionText(String(internalDraft.summary?.caption || ""));
      if (subCap && subCap !== "A composed image." && (!state.caption_text || subCap !== prevSumCap)) {
        state.caption_text = subCap;
        state.caption = subCap;
      }
    } else {
      state.layout_raw_json = val;
    }
  } else {
    state.danbooru_prompt = val;
    state.danbooru_text = val;
    state.tags = val;
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

function applyPresetToNode(node, preset, statusEl) {
  if (!node || !preset) return;
  const state = readPayload(node);

  let w = Number(preset.width) || 1024;
  let h = Number(preset.height) || 1024;
  state.width = w;
  state.height = h;

  const prompts = preset.prompts || {};
  if (preset.draft && typeof preset.draft === "object" && Array.isArray(preset.draft.items) && preset.draft.items.length > 0) {
    state.draft = normalizeDraft(JSON.parse(JSON.stringify(preset.draft)), w, h);
    state.layout_draft = JSON.parse(JSON.stringify(state.draft));
  } else if (prompts.layout) {
    const parsedLayout = extractLayoutJsonObject(prompts.layout);
    if (parsedLayout) {
      const [iw, ih] = inferCanvasSizeFromLayout(parsedLayout, w, h);
      w = iw;
      h = ih;
      state.width = w;
      state.height = h;
      const dec = decompileMossLayoutToDraft(parsedLayout, w, h, null);
      state.draft = dec;
      state.layout_draft = JSON.parse(JSON.stringify(dec));
    }
  }

  if (prompts.caption) {
    const pure = cleanPureCaptionText(prompts.caption);
    state.caption = pure;
    state.caption_text = pure;
    if (state.draft?.summary && !state.draft.summary.caption) state.draft.summary.caption = pure;
  }
  if (prompts.layout) {
    state.layout = prompts.layout;
    state.layout_prompt = prompts.layout;
    state.layout_text = prompts.layout;
  }
  if (prompts.danbooru) {
    state.danbooru = prompts.danbooru;
    state.danbooru_prompt = prompts.danbooru;
    state.danbooru_text = prompts.danbooru;
    state.tags = prompts.danbooru;
  }
  if (state.draft) {
    state.hybrid_draft = {
      ...state.draft,
      summary: {
        ...(state.draft.summary || {}),
        caption: state.caption_text || state.caption || state.draft.summary?.caption || "",
      },
    };
  }

  setPayload(node, state);

  if (statusEl) {
    const boxCount = state.draft?.items?.length || preset.draft?.items?.length || 0;
    statusEl.textContent = `✓ 已应用构图预设：「${preset.name}」（${state.width}×${state.height} · ${boxCount} 个画框主体）`;
  }
}

/** Build the Rich In-Node Studio Card inside the ComfyUI node. */
function mountRichCard(node, statusEl) {
  if (typeof document === "undefined" || node._apsCardMounted) return;
  if (typeof node.addDOMWidget !== "function") return;
  node._apsCardMounted = true;
  mountStyles();
  node._apsUndo = node._apsUndo || new UndoStack({ limit: 30 });
  if (!node._apsImageDataUrl && node.id) {
    const cached = getSessionImage(node.id);
    if (cached) {
      node._apsImageDataUrl = cached;
    }
  }

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
    customWidth: false,
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
        customWidth: Boolean(parsed.customWidth),
        customHeight: Boolean(parsed.customHeight),
      };
    }
  } catch {}
  function saveStageBox() {
    try {
      globalThis.localStorage?.setItem("aps_node_stage_box", JSON.stringify(stageBox));
    } catch {}
  }

  let selectedRegion = -1;
  let dimStageImage = false;

  const card = el("div", "aps-node-card notranslate");
  card.setAttribute("translate", "no");

  // Stop LiteGraph canvas drag when interacting with side wing or controls
  for (const evtName of ["pointerdown", "mousedown", "dblclick", "contextmenu", "wheel"]) {
    card.addEventListener(evtName, (ev) => {
      if (evtName === "pointerdown" || evtName === "mousedown") lastActiveStageCard = card;
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
    b.title = `切换当前编辑/预览到「${mLabel}」（${mPort}）`;

    // Output-enable indicator lives in the 「输出」menu, not on the segmented button.
    const chk = el("span", "aps-mode-check", "☑");
    const lbl = el("span", "aps-mode-label", mLabel);
    const dot = el("i", "aps-mode-dot");
    b.append(dot, lbl);
    b.addEventListener("click", () => setModeWidget(node, mKey));
    modeBtns[mKey] = b;
    modeChecks[mKey] = chk;
    modeGroup.append(b);
  }

  // Small popover menu helper (absolute inside the card; card ancestors are overflow:visible).
  const openMenus = new Set();
  function closeAllMenus() {
    for (const m of openMenus) m.hidden = true;
    openMenus.clear();
  }
  card.addEventListener("pointerdown", (ev) => {
    if (!ev.target.closest?.(".aps-menu-wrap")) closeAllMenus();
  });
  function makeMenuButton(btn, menu) {
    const wrap = el("span", "aps-menu-wrap");
    menu.classList.add("aps-menu");
    menu.hidden = true;
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const willOpen = menu.hidden;
      closeAllMenus();
      if (willOpen) {
        menu.hidden = false;
        openMenus.add(menu);
      }
    });
    menu.addEventListener("click", (ev) => {
      if (ev.target.closest?.("[data-keep-open]")) return;
      if (ev.target.closest?.("button")) closeAllMenus();
    });
    wrap.append(btn, menu);
    return wrap;
  }
  function menuItem(label, title, onClick) {
    const b = el("button", "aps-menu-item", label);
    b.type = "button";
    if (title) b.title = title;
    b.addEventListener("click", onClick);
    return b;
  }

  // 「输出 N/3」menu: which formats feed the output ports
  const outputChip = el("button", "aps-chip-btn aps-output-chip", "输出 1/3 ▾");
  outputChip.type = "button";
  outputChip.title = "选择要输出的格式（对应节点右侧输出口）";
  const outputMenu = el("div", "");
  for (const [mKey, mLabel, mPort] of [
    ["caption", "散文", "caption_prompt"],
    ["layout", "布局", "layout_prompt"],
    ["danbooru", "Danbooru", "danbooru_prompt"],
  ]) {
    const row = el("button", "aps-menu-item");
    row.type = "button";
    row.setAttribute("data-keep-open", "1");
    row.append(modeChecks[mKey], el("span", "", ` ${mLabel}`), el("small", "aps-menu-sub", mPort));
    row.addEventListener("click", () => toggleModeSelection(node, mKey));
    outputMenu.append(row);
  }
  const allModesBtn = menuItem("全部开启 / 仅当前格式", "点击切换：开启全部 3 个格式 / 仅保留当前单个格式", () => {
    const curModes = currentModes(node);
    const curActive = currentMode(node);
    if (curModes.length === ALL_MODES.length) {
      syncModeWidgets(node, [curActive], curActive);
      const nameMap = { caption: "散文", layout: "布局", danbooru: "Danbooru" };
      statusEl.textContent = `当前仅输出【${nameMap[curActive] || curActive}】。`;
    } else {
      syncModeWidgets(node, ["caption", "layout", "danbooru"], curActive);
      statusEl.textContent = "已开启全部 3 个输出格式（散文 + 布局 + Danbooru）。";
    }
    syncCard();
    node.setDirtyCanvas?.(true, true);
  });
  allModesBtn.setAttribute("data-keep-open", "1");
  outputMenu.append(allModesBtn);
  const outputWrap = makeMenuButton(outputChip, outputMenu);

  // Dock Position Switcher: Left Wing / Right Wing / Split Inside
  const dockGroup = el("div", "aps-seg-group aps-seg-sm aps-dock-switch");
  const dockBtns = {};
  for (const [dKey, dLabel, dTip] of [
    ["left", "◧ 左翼", "将大号布局画框挂在节点的【左侧】外部"],
    ["right", "◨ 右翼", "将大号布局画框挂在节点的【右侧】外部"],
    ["split", "内嵌", "将布局画框嵌入节点内部作为左右分栏"],
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

  const rulesToggleBtn = el("button", "aps-btn aps-btn-sm aps-node-rules-btn", "规则偏好");
  rulesToggleBtn.type = "button";
  rulesToggleBtn.title = "在节点主面板展开/收起提示词规则与反推偏好设置";

  const settingsBtn = el("button", "aps-btn aps-btn-sm aps-node-settings-btn", "设置");
  settingsBtn.type = "button";
  settingsBtn.title = "配置模型网关（Base URL / API Key / 模型选择）与提示词规则";
  settingsBtn.addEventListener("click", () => openNodeSettings(node, statusEl));

  const expandBtn = el("button", "aps-btn aps-btn-sm aps-accent aps-node-wb-btn", "工作台");
  expandBtn.type = "button";
  expandBtn.title = "打开全屏左右双栏精细工作台（大图画框 + 多轮对话改词）";
  expandBtn.addEventListener("click", () => openEditor(node, statusEl));

  const savePresetBtn = el("button", "aps-btn aps-btn-sm aps-node-save-preset-btn", "💾 存为预设");
  savePresetBtn.type = "button";
  savePresetBtn.title = "快捷保存当前构图画框、提示词及推荐分辨率至本地预设库";
  savePresetBtn.addEventListener("click", () => {
    const state = readPayload(node);
    openSavePresetModal({
      api,
      state,
      imageCandidate: () => findDownstreamImageCandidate(node),
      onSaved: (saved) => {
        statusEl.textContent = `✓ 构图与提示词已保存至预设库：「${saved.name}」`;
      },
    });
  });

  const presetLibBtn = el("button", "aps-btn aps-btn-sm aps-node-preset-lib-btn", "预设库");
  presetLibBtn.type = "button";
  presetLibBtn.title = "浏览所有构图与提示词预设（支持一键应用到当前节点、导入/导出）";
  presetLibBtn.addEventListener("click", () => {
    openPresetLibraryModal({
      api,
      onApply: (preset) => {
        applyPresetToNode(node, preset, statusEl);
      },
    });
  });

  // 「⋯ 更多」menu: secondary tools tucked away from the main bar
  const moreBtn = el("button", "aps-btn aps-btn-sm aps-more-btn", "⋯");
  moreBtn.type = "button";
  moreBtn.title = "更多：规则偏好、设置、预设、面板位置";
  const moreMenu = el("div", "");
  for (const b of [rulesToggleBtn, settingsBtn, savePresetBtn, presetLibBtn]) {
    b.classList.add("aps-menu-item");
    moreMenu.append(b);
  }
  const dockRow = el("div", "aps-menu-row");
  dockRow.setAttribute("data-keep-open", "1");
  dockRow.append(el("small", "aps-menu-sub", "画框面板位置"), dockGroup);
  moreMenu.append(dockRow);
  const moreWrap = makeMenuButton(moreBtn, moreMenu);
  moreMenu.classList.add("is-right");

  const topBarLeft = el("div", "aps-node-topbar-left");
  const topBarRight = el("div", "aps-node-topbar-right");
  topBarRight.append(modeGroup, outputWrap, expandBtn, moreWrap);
  topBar.append(topBarLeft, topBarRight);

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
      const cols = `minmax(240px, ${ratio.toFixed(3)}fr) minmax(240px, ${(1 - ratio).toFixed(3)}fr)`;
      workspaceWrap.style.gridTemplateColumns = cols;
      topBar.style.gridTemplateColumns = cols;
    } else {
      workspaceWrap.style.gridTemplateColumns = "";
      topBar.style.gridTemplateColumns = "";
      const effectiveStageH = stageBox.customHeight
        ? clampVal(Number(stageBox.height) || 450, 220, 1600)
        : Math.max(clampVal(Number(stageBox.height) || 450, 220, 1600), targetCardH + 38);
      let effectiveStageW = clampVal(Number(stageBox.width) || 420, 260, 1600);
      if (!stageBox.customWidth) {
        const st = readPayload(node);
        const imgW = Math.max(16, Number(st.width) || 1024);
        const imgH = Math.max(16, Number(st.height) || 1024);
        // The reserve is constant on purpose: selecting a box must not resize
        // the canvas.  The region inspector floats over the image instead of
        // taking a slot in the flex column, so the picture stays put.
        const availCanvasH = Math.max(220, effectiveStageH - 76);
        effectiveStageW = clampVal(Math.round(availCanvasH * (imgW / imgH) + 20), 330, 760);
      }
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
  stageHeader.title = "按住此标题栏可自由拖动布局画框位置；拖拽画框四边或四角可自由调整大小；双击标题复位；选中画框后按 Delete / Backspace 可直接删除该框及其描述";
  const stageTitle = el("span", "aps-node-stage-title", "布局画框");
  const sizeBadge = el("button", "aps-node-size-badge is-clickable", "1024×1024 ▾");
  sizeBadge.type = "button";
  sizeBadge.title = "点击选择 MOSS-Image 16 倍数画布尺寸（将按比例同步缩放现有画框）";
  const sizeMenu = el("div", "aps-size-menu");
  for (const [mw, mh, mLabel] of MOSS_CANVAS_PRESETS) {
    sizeMenu.append(
      menuItem(mLabel, `切换画布为 ${mw}×${mh}`, () => {
        const st = readPayload(node);
        const oldW = Number(st.width) || 1024;
        const oldH = Number(st.height) || 1024;
        if (oldW === mw && oldH === mh) return;
        node._apsUndo?.record({
          key: "payload_state",
          before: JSON.stringify(st),
          after: "",
          label: `切换画布为 ${mw}×${mh}`,
          source: "stage",
        });
        st.width = mw;
        st.height = mh;
        if (st.draft) st.draft = rescaleLayoutDraft(st.draft, mw, mh, oldW, oldH);
        if (st.layout_draft) st.layout_draft = rescaleLayoutDraft(st.layout_draft, mw, mh, oldW, oldH);
        if (st.hybrid_draft) st.hybrid_draft = rescaleLayoutDraft(st.hybrid_draft, mw, mh, oldW, oldH);
        setPayload(node, st);
        node._apsDirty = true;
        statusEl.textContent = `✓ 画布尺寸已切换为 ${mw}×${mh}（MOSS 16 倍数）`;
        syncCard();
        node.setDirtyCanvas?.(true, true);
      }),
    );
  }
  const sizeWrap = makeMenuButton(sizeBadge, sizeMenu);
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

  const stageUndoBtn = el("button", "aps-chip-btn", "撤销");
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
  const uploadMiniBtn = el("button", "aps-chip-btn", "换图");
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
      reportNodeError(statusEl, err, "加载参考图");
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

  // 显隐画框：只影响底图上的框怎么显示，不改提示词内容。
  const boxesVisibleNow = readPayload(node).stage_boxes_visible !== false;
  const boxesToggleBtn = el("button", "aps-chip-btn", boxesVisibleNow ? "隐藏画框" : "显示画框");
  boxesToggleBtn.type = "button";
  boxesToggleBtn.title = "隐藏或显示底图上的布局框（提示词内容不受影响）";
  boxesToggleBtn.addEventListener("click", () => {
    const st = readPayload(node);
    st.stage_boxes_visible = st.stage_boxes_visible === false ? true : false;
    setPayload(node, st);
    boxesToggleBtn.textContent = st.stage_boxes_visible === false ? "显示画框" : "隐藏画框";
    statusEl.textContent = st.stage_boxes_visible === false ? "已隐藏画框。" : "已显示画框。";
    syncCard();
  });

  // Two controls stay on the bar (add / undo); the rest tuck into a「⋯」menu so
  // the header reads as a quiet label bar instead of a second toolbar.
  stageTools.append(addBoxBtn, stageUndoBtn, fileInput);

  const stageMoreBtn = el("button", "aps-chip-btn", "⋯");
  stageMoreBtn.type = "button";
  stageMoreBtn.title = "更多画框操作：显隐画框、暗底、换图、复位";
  const stageMoreMenu = el("div", "");
  for (const b of [boxesToggleBtn, dimImgBtn, uploadMiniBtn, resetStageBtn]) {
    b.classList.add("aps-menu-item");
    stageMoreMenu.append(b);
  }
  stageTools.append(makeMenuButton(stageMoreBtn, stageMoreMenu));

  stageHeader.append(stageTitle, sizeWrap, stageTools);

  const stageWrap = el("div", "aps-node-stage");
  stageWrap.addEventListener("dragenter", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    stageWrap.classList.add("is-drag-over");
  });
  stageWrap.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    stageWrap.classList.add("is-drag-over");
  });
  stageWrap.addEventListener("dragleave", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    stageWrap.classList.remove("is-drag-over");
  });
  stageWrap.addEventListener("drop", async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    stageWrap.classList.remove("is-drag-over");
    const file = ev.dataTransfer?.files?.[0];
    if (!file) return;
    if (!String(file.type || "").startsWith("image/")) {
      statusEl.textContent = "请拖入图片文件（JPG、PNG、WebP 等）。";
      return;
    }
    try {
      await handleNewReferenceImage(node, file, statusEl);
    } catch (err) {
      reportNodeError(statusEl, err, "加载参考图");
    }
  });
  const svgNS = "http://www.w3.org/2000/svg";
  const stageSvg = document.createElementNS(svgNS, "svg");
  stageSvg.setAttribute("viewBox", "0 0 1024 1024");
  stageSvg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  stageSvg.className.baseVal = "aps-node-svg";
  const stageScanOverlay = el("div", "aps-stage-scan-overlay");
  stageScanOverlay.hidden = true;
  stageScanOverlay.append(el("div", "aps-stage-progress"));
  stageWrap.append(stageSvg, stageScanOverlay);
  stageWrap.title = "点击画框可在主界面对话框中 @引用 局部修改；点击空白处取消引用；双击打开全屏双栏工作台";
  stageWrap.addEventListener("dblclick", () => openEditor(node, statusEl));

  // Direct Drag / Resize / @Quote selection on stageSvg inside the node/wing!
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
    } else if (selectedRegion !== -1) {
      // Clicking empty canvas space cancels @region quote and restores global edit mode
      selectedRegion = -1;
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

  // ---------------------------------------------------------------- keyboard
  // Delete / Backspace drops the selected region together with its caption,
  // name and visible text — they all live on the same draft item, so removing
  // the item removes the description with it.  Esc only clears the selection.
  // Both are ignored while typing in a control or while a studio modal owns
  // the screen, and the deletion goes through the node's undo stack.
  function deleteSelectedRegion() {
    if (selectedRegion < 0) return false;
    const state = readPayload(node);
    const items = state?.draft?.items;
    if (!Array.isArray(items) || !items[selectedRegion]) return false;
    const w = Number(state.width) || 1024;
    const h = Number(state.height) || 1024;
    const victim = items[selectedRegion] || {};
    const displayName =
      String(victim.name || victim.caption || "").trim().slice(0, 12) || `#${selectedRegion + 1}`;
    const removedIndex = selectedRegion;
    const result = removeRegion(items, removedIndex, selectedRegion);
    state.draft.items = result.items;
    selectedRegion = result.selectedIndex;
    commitDraftToState(
      state,
      normalizeDraft(state.draft, w, h),
      w,
      h,
      true,
      `删除区域 #${removedIndex + 1}「${displayName}」画框与描述`,
    );
    statusEl.textContent = `🗑 已删除区域 #${removedIndex + 1} 的画框及其描述（点「撤销」可恢复）。`;
    return true;
  }

  function onStageKeyDown(ev) {
    if (!stageSvg.isConnected) return;
    if (lastActiveStageCard && lastActiveStageCard !== card) return;
    if (anyStudioModalOpen(document)) return;
    if (shouldDeleteSelection(ev, selectedRegion)) {
      if (!deleteSelectedRegion()) return;
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation?.();
      return;
    }
    if (isEscapeKey(ev) && selectedRegion >= 0) {
      selectedRegion = -1;
      syncCard();
      statusEl.textContent = "已取消选框，主对话框恢复全局改词模式。";
      ev.stopPropagation();
    }
  }
  document.addEventListener("keydown", onStageKeyDown, true);
  // Detach the global key handler when the node is deleted, otherwise the closure
  // (node DOM + state + image data) never becomes collectable.
  const prevOnRemoved = node.onRemoved;
  node.onRemoved = function (...args) {
    document.removeEventListener("keydown", onStageKeyDown, true);
    if (lastActiveStageCard === card) lastActiveStageCard = null;
    return typeof prevOnRemoved === "function" ? prevOnRemoved.apply(this, args) : undefined;
  };

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
        stageBox.customWidth = true;
      }
      if (dir.includes("w")) {
        const nextW = clampVal(Math.round(orig.width - dx), 260, 1600);
        if (dockMode === "right") {
          stageBox.offsetX = Math.round(orig.offsetX - (nextW - orig.width));
        }
        stageBox.width = nextW;
        stageBox.customWidth = true;
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
  // The inspector is a drawer anchored to the panel's right edge, so it never
  // eats canvas height or covers the picture; it slides in on the sheet curve.
  // Double-click inside it must not open the studio editor.
  regionInspector.addEventListener("dblclick", (ev) => {
    ev.stopPropagation();
  });

  // ---- Main Prompt & AI Controls Column ----
  const mainCol = el("div", "aps-node-main-col");

  const promptBox = el("textarea", "aps-node-prompt");
  promptBox.rows = 5;
  promptBox.placeholder = "提示词为空。点击「反推」读取图片，或在下方直接输入创意/改词要求…";
  // Read-only overlay that marks the spots the AI just edited; click to go back to editing.
  const promptMarkView = el("div", "aps-node-prompt aps-prompt-markview");
  promptMarkView.hidden = true;
  promptMarkView.title = "绿色标记为 AI 刚改动的位置 · 点击进入编辑";
  const promptMarkTag = el("span", "aps-prompt-marktag");
  function renderPromptMarks(text, turn, { peek = false } = {}) {
    const marks = turn?.marks;
    const ok = marks && marks.len === text.length && Array.isArray(marks.ranges) && marks.ranges.length;
    if (!ok || node._apsMarksDismissed === turn.id) {
      promptMarkView.hidden = true;
      promptBox.hidden = false;
      promptMarksChip.hidden = true;
      return;
    }
    promptMarksChip.textContent = `AI 改动 ${marks.ranges.length} 处`;
    promptMarksChip.hidden = false;
    promptMarkView.textContent = "";
    let pos = 0;
    for (const [s, e] of marks.ranges) {
      if (s < pos || e > text.length) continue;
      promptMarkView.append(document.createTextNode(text.slice(pos, s)));
      promptMarkView.append(el("mark", "aps-prompt-mark", text.slice(s, e)));
      pos = e;
    }
    promptMarkView.append(document.createTextNode(text.slice(pos)));
    promptMarkTag.textContent = "点击这里继续编辑";
    promptMarkView.append(promptMarkTag);
    promptMarkView.onclick = () => {
      promptMarkView.hidden = true;
      promptBox.hidden = false;
      promptBox.focus();
    };
    // 默认不动输入框；只有用户点“AI 改动 N 处”时才切到只读预览。
    if (peek) {
      promptMarkView.hidden = false;
      promptBox.hidden = true;
    } else {
      promptMarkView.hidden = true;
      promptBox.hidden = false;
    }
  }
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
      if (pw) pw.value = payloadToJson(state);
      node._apsDirty = true;
      syncCard();
      node.setDirtyCanvas?.(true, true);
    }
  });
  promptBox.addEventListener("paste", (ev) => {
    const pasted = ev.clipboardData?.getData?.("text/plain") || "";
    if (!pasted || !pasted.includes("{")) return;
    const parsed = extractLayoutJsonObject(pasted);
    if (!parsed || (!Array.isArray(parsed.items) && !Array.isArray(parsed.objects))) return;
    ev.preventDefault();
    const prevState = readPayload(node);
    node._apsUndo?.record({
      key: "payload_state",
      before: JSON.stringify(prevState),
      after: "",
      label: "粘贴 Layout JSON",
      source: "paste",
    });
    const curW = Number(prevState.width) || 1024;
    const curH = Number(prevState.height) || 1024;
    const [nw, nh] = inferCanvasSizeFromLayout(parsed, curW, curH);
    const internalDraft = decompileMossLayoutToDraft(parsed, nw, nh, null);
    const nextState = { ...prevState };
    nextState.width = nw;
    nextState.height = nh;
    nextState.draft = internalDraft;
    nextState.layout_draft = internalDraft;
    nextState.hybrid_draft = internalDraft;
    nextState.layout_prompt = JSON.stringify(compileLayoutDraftForMoss(internalDraft, nw, nh));
    delete nextState.layout_raw_json;
    const subCap = cleanPureCaptionText(String(internalDraft.summary?.caption || ""));
    if (subCap && subCap !== "A composed image.") {
      nextState.caption = subCap;
      nextState.caption_text = subCap;
    }
    const turns = Array.isArray(nextState.chat_log) ? nextState.chat_log : [];
    const lastT = turns.at(-1);
    if (lastT?.id) node._apsMarksDismissed = lastT.id;
    selectedRegion = -1;
    setPayload(node, nextState);
    setModeWidget(node, "layout");
    node._apsDirty = true;
    promptBox.value = activePromptForMode(readPayload(node), "layout");
    syncCard();
    updatePromptStats();
    statusEl.textContent = `✓ 已自动识别并绘制 ${internalDraft.items.length} 个布局画框（${nw}×${nh}）；如需补全散文 / Danbooru 请点「导入 / 补全」。`;
    node.setDirtyCanvas?.(true, true);
  });

  const promptStatsEl = el("div", "aps-node-prompt-stats");
  // AI 改完后不再抢占输入框：改动位置收进这个可点的小标记，默认始终可直接编辑。
  const promptMarksChip = el("button", "aps-chip-btn", "AI 改动");
  promptMarksChip.type = "button";
  promptMarksChip.hidden = true;
  promptMarksChip.title = "查看 AI 刚改动的位置（只读预览，点预览即可回来继续编辑）";
  promptMarksChip.addEventListener("click", () => {
    const state = readPayload(node);
    renderPromptMarks(activePromptForMode(state, currentMode(node)), node._apsLastTurn, { peek: true });
  });

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
  const btnCopy = el("button", "aps-chip-btn", "复制");
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
  const btnReverse = el("button", "aps-btn aps-primary aps-btn-sm", "反推");
  btnReverse.type = "button";
  btnReverse.addEventListener("click", () => runCaption(node, statusEl));

  const btnExpand = el("button", "aps-chip-btn", "扩写");
  btnExpand.type = "button";
  btnExpand.addEventListener("click", () =>
    runInlineEdit(
      "Expand and enrich the prompt with concrete lighting, composition, and texture details in English.",
      "扩写细节",
    ),
  );

  const btnTrans = el("button", "aps-chip-btn", "译英");
  btnTrans.type = "button";
  btnTrans.addEventListener("click", () =>
    runInlineEdit(
      "Translate any Chinese in the prompt into natural, idiomatic English image-generation phrasing.",
      "译为英文",
    ),
  );

  const btnMoss = el("button", "aps-chip-btn notranslate", "MOSS精炼");
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
    if (pw) pw.value = payloadToJson(state);
    statusEl.textContent = `已撤销：${entry.label || "修改"}`;
    syncCard();
    node.setDirtyCanvas?.(true, true);
  }

  const btnUndo = el("button", "aps-btn aps-btn-sm", "撤销");
  btnUndo.type = "button";
  btnUndo.disabled = true;
  btnUndo.addEventListener("click", handleUndo);

  const btnImagine = el("button", "aps-btn aps-accent aps-btn-sm", "灵感");
  btnImagine.type = "button";
  btnImagine.title = "没有参考图？输入一句想法，让 AI 想象完整画面并生成提示词";

  const btnImportComplete = el("button", "aps-btn aps-btn-sm aps-import-trigger-btn", "导入 / 补全");
  btnImportComplete.type = "button";
  btnImportComplete.title = "填入成品提示词（Layout JSON / 自然语言 / Danbooru），保留原文并自动补全所选格式与画框";
  btnImportComplete.addEventListener("click", () => {
    const st = readPayload(node);
    const actMode = currentMode(node);
    const actText = activePromptForMode(st, actMode);
    const hasDraftBoxes = Boolean(st.draft?.items?.length || st.layout_draft?.items?.length);
    const initialText = actMode === "layout" && !hasDraftBoxes ? "" : actText;
    openImportPromptModal({
      api,
      initialText,
      initialModes: currentModes(node),
      initialMode: actMode,
      initialWidth: Number(st.width) || 1024,
      initialHeight: Number(st.height) || 1024,
      model: cleanWidgetStr(widget(node, "model")?.value) || "",
      extraInstruction: cleanWidgetStr(widget(node, "extra_instruction")?.value) || "",
      onApply: (result) => {
        const existing = readPayload(node);
        node._apsUndo?.record({
          key: "payload_state",
          before: JSON.stringify(existing),
          after: "",
          label: "导入并补全多格式提示词",
          source: "import",
        });
        const nextPayload = { ...(result?.payload || {}) };
        // 导入的是成品提示词（纯文本），旧底图必须一并解除：否则下一句对话/改词
        // 仍会把上一张图当参考图上传，AI 会拿无关的画面去理解这段新提示词。
        const hadImage = Boolean(existing.last_image_file || node._apsImageDataUrl);
        detachReferenceImage(node, null);
        delete nextPayload.last_image_file;
        delete nextPayload.source;
        nextPayload.image_detached = true;
        // 保留"断掉的是哪张图"，这样上游之后换成新图时仍能自动认作新底图。
        const detachedFrom = readPayload(node).detached_from_file;
        if (detachedFrom) nextPayload.detached_from_file = detachedFrom;
        preserveChatThreads(nextPayload, existing, { maxTurns: 20 });
        const lastT = Array.isArray(nextPayload.chat_log) ? nextPayload.chat_log.at(-1) : null;
        if (lastT?.id) node._apsMarksDismissed = lastT.id;
        if (typeof existing.auto_imagine === "boolean") {
          nextPayload.auto_imagine = existing.auto_imagine;
        }
        const canonicalMap = (m) => (m === "hybrid" ? "danbooru" : m);
        const resultModes = Array.isArray(result?.modes) && result.modes.length
          ? result.modes.map(canonicalMap).filter((m) => ALL_MODES.includes(m))
          : currentModes(node);
        const activeAfter = ALL_MODES.includes(canonicalMap(nextPayload.mode))
          ? canonicalMap(nextPayload.mode)
          : resultModes[0] || currentMode(node);
        selectedRegion = -1;
        syncModeWidgets(node, resultModes, activeAfter);
        setPayload(node, nextPayload);
        node._apsDirty = true;
        promptBox.value = activePromptForMode(readPayload(node), currentMode(node));
        syncCard();
        updatePromptStats();
        const boxCount = nextPayload.draft?.items?.length || 0;
        statusEl.textContent = `✅ 已导入并完成 ${resultModes.length} 个格式（${nextPayload.width || 1024}×${nextPayload.height || 1024}${boxCount ? ` · ${boxCount} 个画框` : ""}）${hadImage ? " · 旧底图已解除" : ""}`;
        node.setDirtyCanvas?.(true, true);
      },
    });
  });

  const polishBtn = el("button", "aps-chip-btn", "润色 ▾");
  polishBtn.type = "button";
  polishBtn.title = "扩写 / 译英 / MOSS 精炼";
  const polishMenu = el("div", "aps-menu-up");
  for (const b of [btnExpand, btnTrans, btnMoss]) {
    b.classList.add("aps-menu-item");
    polishMenu.append(b);
  }
  const polishWrap = makeMenuButton(polishBtn, polishMenu);

  quickBar.append(btnReverse, btnImportComplete, btnImagine, polishWrap, btnCopy, btnUndo);

  // ---- 💡 Imagine panel: idea → candidate prompts → adopt into active modes ----
  const imaginePanel = el("div", "aps-imagine-panel");
  imaginePanel.hidden = true;
  const imagineHead = el("div", "aps-imagine-head");
  const imagineTitle = el("span", "aps-imagine-title", "灵感生成");
  const imagineHint = el("span", "aps-imagine-hint", "一句话描述想法，AI 负责想象画面");
  const imagineClose = el("button", "aps-chip-btn aps-btn-xs", "✕");
  imagineClose.type = "button";
  imagineClose.title = "收起灵感面板";
  imagineHead.append(imagineTitle, imagineHint, imagineClose);

  // Themes Pills row (model dreams up ideas under selected genre)
  const imagineThemes = el("div", "aps-imagine-themes");
  const THEME_PILLS = [
    ["random", "🎲 帮我想点子"],
    ["cyberpunk", "🚀 赛博科幻"],
    ["fantasy", "史诗奇幻"],
    ["cinematic", "电影故事"],
    ["anime", "🌸 唯美动漫"],
    ["surreal", "🌌 梦境奇观"],
    ["nature", "🌿 自然光影"],
  ];
  THEME_PILLS.forEach(([tKey, tLabel], idx) => {
    const pill = el("button", `aps-chip-btn aps-btn-xs aps-theme-pill${idx === 0 ? " is-accent" : ""}`, tLabel);
    pill.type = "button";
    pill.title = idx === 0
      ? "让大模型完全自由想象、构想一个惊艳的新颖点子并自动生成构图方案"
      : `让大模型构想【${tLabel}】题材的创意点子并自动生成构图方案`;
    pill.addEventListener("click", () => void runBrainstorm(tKey));
    imagineThemes.append(pill);
  });

  const imagineRow = el("div", "aps-imagine-row");
  const imagineInput = el("input", "aps-input aps-imagine-input");
  imagineInput.type = "text";
  imagineInput.placeholder = "输入画面想法，或点击上方「🎲 帮我想点子」让 AI 自己构思…";

  const btnBrainstormRow = el("button", "aps-btn aps-accent aps-btn-sm aps-brainstorm-trigger", "🎲 想点子");
  btnBrainstormRow.type = "button";
  btnBrainstormRow.title = "无需打字！让大模型自己构想一个富有视觉张力和创意的绝妙点子，并直接生成画面方案";
  btnBrainstormRow.addEventListener("click", () => void runBrainstorm("random"));

  const imagineGo = el("button", "aps-btn aps-primary aps-btn-sm", "生成 ✦");
  imagineGo.type = "button";
  imagineGo.title = "根据当前输入的想法生成 3 种画幅和构图方案";
  imagineRow.append(imagineInput, btnBrainstormRow, imagineGo);

  function makeSelect(options, title) {
    const sel = el("select", "aps-select aps-select-xs");
    sel.title = title;
    for (const [val, label] of options) {
      const opt = el("option", "", label);
      opt.value = val;
      sel.append(opt);
    }
    return sel;
  }
  const imagineStyle = makeSelect(
    [["auto", "风格：自动"], ["anime", "动漫"], ["realistic", "写实摄影"], ["cinematic", "电影感"], ["illustration", "插画"], ["3d", "3D 渲染"]],
    "画面风格",
  );
  const imagineAspect = makeSelect(
    [["auto", "画幅：自动"], ["portrait", "竖版"], ["landscape", "横版"], ["square", "方形"]],
    "画布方向（会同步到 width/height 输出）",
  );
  const imagineCount = makeSelect([["3", "3 个候选"], ["1", "1 个"]], "一次生成几个候选");
  const imagineModesNote = el("span", "aps-imagine-modes");
  const imagineOpts = el("div", "aps-imagine-row aps-imagine-opts");
  imagineOpts.append(imagineStyle, imagineAspect, imagineCount, imagineModesNote);

  const autoImagineRow = el("div", "aps-imagine-row aps-auto-imagine-row");
  const autoImagineLabel = el("label", "aps-auto-imagine-toggle");
  autoImagineLabel.style.display = "inline-flex";
  autoImagineLabel.style.alignItems = "center";
  autoImagineLabel.style.gap = "6px";
  autoImagineLabel.style.cursor = "pointer";
  autoImagineLabel.style.fontSize = "12px";
  autoImagineLabel.style.color = "var(--aps-accent, #38bdf8)";
  autoImagineLabel.style.userSelect = "none";

  const autoImagineCheckbox = el("input");
  autoImagineCheckbox.type = "checkbox";
  autoImagineCheckbox.style.cursor = "pointer";
  autoImagineCheckbox.title = "勾选后启用全自动文生图盲盒链路：未连接图片时，每次点击「运行」模型都会自主构思新画面并生成整套提示词与画框！连接随机种子可每次排队自动开盲盒。";

  const autoImagineText = el("span", "", "🎲 每次排队自动开盲盒 (文生图全自动构思链路)");
  autoImagineLabel.append(autoImagineCheckbox, autoImagineText);

  autoImagineCheckbox.addEventListener("change", () => {
    const st = readPayload(node);
    st.auto_imagine = autoImagineCheckbox.checked;
    setPayload(node, st);
    node._apsDirty = true;
    if (autoImagineCheckbox.checked) {
      statusEl.textContent = "✓ 已开启全自动盲盒链路：连接 seed 到随机种子节点，每次点击「运行」模型都会自主构想全新画面！";
      btnImagine.style.borderColor = "var(--aps-accent, #38bdf8)";
    } else {
      statusEl.textContent = "已关闭自动盲盒链路，恢复常规缓存模式。";
      btnImagine.style.borderColor = "";
    }
    node.setDirtyCanvas?.(true, true);
  });
  autoImagineRow.append(autoImagineLabel);

  const imagineResults = el("div", "aps-imagine-results");
  imaginePanel.append(imagineHead, imagineThemes, imagineRow, imagineOpts, autoImagineRow, imagineResults);

  const MODE_LABELS = { caption: "散文", layout: "布局画框", danbooru: "Danbooru 标签" };
  const ASPECT_LABELS = { portrait: "竖版", landscape: "横版", square: "方形" };
  let imagineCandidates = [];

  function updateImagineModesNote() {
    const modes = currentModes(node);
    imagineModesNote.textContent = `采用后输出：${modes.map((m) => MODE_LABELS[m] || m).join(" + ")}`;
    imagineModesNote.title = "跟随节点顶部已勾选的格式；想要画框就勾上「布局」";
  }

  function setImagineOpen(open) {
    imaginePanel.hidden = !open;
    btnImagine.classList.toggle("is-active", open);
    if (open) {
      updateImagineModesNote();
      setTimeout(() => imagineInput.focus(), 0);
    }
    applyStageGeometry();
    node.setDirtyCanvas?.(true, true);
  }
  btnImagine.addEventListener("click", () => setImagineOpen(imaginePanel.hidden));
  imagineClose.addEventListener("click", () => setImagineOpen(false));

  function renderImagineResults() {
    imagineResults.textContent = "";
    imagineCandidates.forEach((cand, idx) => {
      const cardEl = el("div", "aps-imagine-card");
      const top = el("div", "aps-imagine-card-top");
      const title = el("span", "aps-imagine-card-title", `${idx + 1}. ${cand.title || "方案"}`);
      const badge = el("span", "aps-imagine-badge", `${ASPECT_LABELS[cand.aspect] || cand.aspect} ${cand.width}×${cand.height}`);
      const adopt = el("button", "aps-btn aps-primary aps-btn-xs", "采用");
      adopt.type = "button";
      adopt.addEventListener("click", () => adoptCandidate(cand));
      top.append(title, badge, adopt);
      const body = el("div", "aps-imagine-card-text", cand.prompt);
      body.title = "点击展开 / 收起全文";
      body.addEventListener("click", () => body.classList.toggle("is-open"));
      cardEl.append(top, body);
      imagineResults.append(cardEl);
    });
  }

  async function runBrainstorm(theme = "random") {
    statusEl.textContent = "🎲 模型正在自己想点子（头脑风暴中）…";
    imagineInput.placeholder = "🎲 AI 正在头脑风暴构思新点子…";
    node._apsSetBusy?.(true);
    try {
      const res = await api.request("/brainstorm", {
        method: "POST",
        body: {
          theme,
          style: imagineStyle.value,
          count: 1,
          model: cleanWidgetStr(widget(node, "model")?.value) || undefined,
          extra_instruction: cleanWidgetStr(widget(node, "extra_instruction")?.value) || undefined,
        },
      });
      const ideaObj = res.ideas?.[0];
      if (ideaObj?.idea) {
        imagineInput.value = ideaObj.idea;
        statusEl.textContent = `AI 已构思好点子「${ideaObj.title || "灵感"}」，正在生成画面方案…`;
        await runImagine();
      } else {
        statusEl.textContent = "未能生成有效点子，请重试。";
      }
    } catch (err) {
      reportNodeError(statusEl, err, "想点子");
    } finally {
      imagineInput.placeholder = "输入画面想法，或点击上方「🎲 帮我想点子」让 AI 自己构思…";
      node._apsSetBusy?.(false);
    }
  }

  async function runImagine() {
    const idea = imagineInput.value.trim();
    if (!idea) {
      statusEl.textContent = "请先输入一句想法。";
      imagineInput.focus();
      return;
    }
    statusEl.textContent = "AI 正在想象画面…";
    node._apsSetBusy?.(true);
    try {
      const res = await api.request("/imagine", {
        method: "POST",
        body: {
          idea,
          count: Number(imagineCount.value) || 3,
          style: imagineStyle.value,
          aspect: imagineAspect.value,
          model: cleanWidgetStr(widget(node, "model")?.value) || undefined,
          extra_instruction: cleanWidgetStr(widget(node, "extra_instruction")?.value) || undefined,
        },
      });
      imagineCandidates = Array.isArray(res.candidates) ? res.candidates : [];
      renderImagineResults();
      statusEl.textContent = imagineCandidates.length
        ? `已生成 ${imagineCandidates.length} 个画面方案，点「采用」写入节点。`
        : "模型没有返回可用方案，请换个说法重试。";
      applyStageGeometry();
    } catch (err) {
      reportNodeError(statusEl, err, "灵感生成");
    } finally {
      node._apsSetBusy?.(false);
    }
  }
  imagineGo.addEventListener("click", () => void runImagine());
  imagineInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      void runImagine();
    }
  });

  async function adoptCandidate(cand) {
    const existing = readPayload(node);
    if (node._apsDirty && (existing.caption || existing.draft)) {
      if (!globalThis.confirm?.("当前提示词手动改过，采用新方案会覆盖。继续吗？")) return;
    }
    const mode = currentMode(node);
    const modes = currentModes(node);
    const needsMore = modes.some((m) => m !== "caption");
    statusEl.textContent = needsMore
      ? `正在把方案转换为 ${modes.map((m) => MODE_LABELS[m] || m).join(" + ")}…`
      : "正在写入方案…";
    node._apsSetBusy?.(true);
    try {
      const ordered = [mode, ...modes.filter((m) => m !== mode)];
      const res = await api.request("/imagine_expand", {
        method: "POST",
        body: {
          prompt: cand.prompt,
          modes: ordered,
          width: cand.width,
          height: cand.height,
          model: cleanWidgetStr(widget(node, "model")?.value) || undefined,
          extra_instruction: cleanWidgetStr(widget(node, "extra_instruction")?.value) || undefined,
        },
      });
      const state = res.payload || {};
      preserveChatThreads(state, existing, { maxTurns: 20 });
      state.mode = mode;
      state.modes = modes;
      if (existing.last_image_file) state.last_image_file = existing.last_image_file;
      setPayload(node, state);
      node._apsUndo?.record({
        key: "payload_state",
        before: JSON.stringify(existing),
        after: "",
        label: `采用灵感方案「${cand.title || ""}」`,
        source: "imagine",
      });
      statusEl.textContent = `✅ 已采用「${cand.title || "方案"}」：${state.width}×${state.height}，可直接排队出图（撤销可恢复）。`;
      syncCard();
    } catch (err) {
      reportNodeError(statusEl, err, "采用方案");
    } finally {
      node._apsSetBusy?.(false);
    }
  }

  // ---- Visible Multi-Turn In-Node AI Chat Stream (.aps-node-chat-wrap) ----
  let isChatLogOpen = globalThis.localStorage?.getItem("aps_node_chat_open") !== "false";
  let editingThreadId = null;
  const chatWrap = el("div", "aps-node-chat-wrap");
  const chatHead = el("div", "aps-node-chat-head");
  const chatTitle = el("span", "aps-node-chat-title", "💬 AI 对话改词（0 轮）");
  const chatHeadActions = el("div", "aps-node-chat-head-actions");
  const chatNewBtn = el("button", "aps-chip-btn aps-btn-xs aps-chat-new-btn", "＋ 新对话");
  chatNewBtn.type = "button";
  chatNewBtn.title = "新建一个独立上下文的新对话标签页（不同对话互不干扰）";
  const chatClearBtn = el("button", "aps-chip-btn aps-btn-xs", "清空");
  chatClearBtn.type = "button";
  chatClearBtn.title = "仅清空当前选中对话的记录与多轮会话上下文";
  const chatToggleBtn = el("button", "aps-chip-btn aps-btn-xs", isChatLogOpen ? "收起 ▴" : "展开 ▾");
  chatToggleBtn.type = "button";
  chatHeadActions.append(chatNewBtn, chatClearBtn, chatToggleBtn);
  chatHead.append(chatTitle, chatHeadActions);

  const chatThreadsBar = el("div", "aps-chat-threads-bar");
  chatThreadsBar.hidden = true;
  const chatLogEl = el("div", "aps-node-chat-log");
  chatWrap.append(chatHead, chatThreadsBar, chatLogEl);

  function setChatLogOpen(open) {
    isChatLogOpen = Boolean(open);
    try {
      globalThis.localStorage?.setItem("aps_node_chat_open", String(isChatLogOpen));
    } catch {}
    chatToggleBtn.textContent = isChatLogOpen ? "收起 ▴" : "展开 ▾";
    renderChatLog();
    applyStageGeometry();
    node.setDirtyCanvas?.(true, true);
  }
  chatToggleBtn.addEventListener("click", () => setChatLogOpen(!isChatLogOpen));

  chatNewBtn.addEventListener("click", () => {
    if (nodeBusy) return;
    const st = readPayload(node);
    const created = createChatThread(st, { maxTurns: 20 });
    if (!created.ok) {
      statusEl.textContent = created.error;
      return;
    }
    node._apsSessionId = null;
    editingThreadId = null;
    const pw = widget(node, "payload");
    if (pw) pw.value = payloadToJson(st);
    isChatLogOpen = true;
    try {
      globalThis.localStorage?.setItem("aps_node_chat_open", "true");
    } catch {}
    chatToggleBtn.textContent = "收起 ▴";
    statusEl.textContent = `✓ 已新建独立对话「${created.thread.title}」。`;
    renderChatLog();
    applyStageGeometry();
    node.setDirtyCanvas?.(true, true);
    setTimeout(() => {
      try {
        chatInput.focus();
      } catch {}
    }, 0);
  });

  chatClearBtn.addEventListener("click", () => {
    if (nodeBusy) return;
    const st = readPayload(node);
    const { activeThread } = ensureChatThreads(st, { maxTurns: 20 });
    const oldSid = activeThread?.session_id;
    const clearedTitle = activeThread?.title || "当前对话";
    clearChatThread(st, activeThread?.id, { maxTurns: 20 });
    node._apsSessionId = null;
    if (oldSid) api.deleteSession(oldSid).catch(() => {});
    const pw = widget(node, "payload");
    if (pw) pw.value = payloadToJson(st);
    statusEl.textContent = `已清空「${clearedTitle}」对话记录，将开启新一轮独立上下文。`;
    renderChatLog();
    applyStageGeometry();
    node.setDirtyCanvas?.(true, true);
  });

  const chatHudBanner = el("div", "aps-hud-activity-banner");
  chatHudBanner.hidden = true;
  const chatTargetBar = el("div", "aps-target-lock-bar is-global");

  const chatRow = el("div", "aps-node-chat-row");
  let inlineEditController = null;
  const chatInput = el("input", "aps-input aps-node-chat-input");
  chatInput.type = "text";
  chatInput.placeholder = "输入改词要求、回答 AI 反问或提问（点选画框可 @引用 局部修改，回车发送）…";
  const chatSend = el("button", "aps-btn aps-accent aps-btn-sm", "发送 ✦");
  chatSend.type = "button";
  const chatStop = el("button", "aps-btn aps-btn-sm aps-node-chat-stop", "⏹ 终止");
  chatStop.type = "button";
  chatStop.hidden = true;
  chatStop.title = "立即中止本次 AI 请求（已生成的部分会保留）";
  chatStop.addEventListener("click", () => {
    inlineEditController?.abort();
    statusEl.textContent = "正在终止本次请求…";
  });
  chatInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      const val = chatInput.value.trim();
      if (val) {
        chatInput.value = "";
        void runInlineEdit(val, val);
      }
    }
  });
  chatSend.addEventListener("click", () => {
    const val = chatInput.value.trim();
    if (val) {
      chatInput.value = "";
      void runInlineEdit(val, val);
    }
  });
  chatRow.append(chatInput, chatStop, chatSend);

  // ---- Built-in Three-Mode Prompt Rules Panel (.aps-node-rules-panel) ----
  const rulesPanel = el("div", "aps-node-rules-panel");
  let isRulesOpen = globalThis.localStorage?.getItem("aps_node_rules_open") !== "false";

  const rulesHead = el("div", "aps-node-rules-head");
  const rulesTitleWrap = el("div", "aps-node-rules-title-wrap");
  const rulesTitle = el("span", "aps-node-rules-title", "📐 三模式独立规则");
  const rulesHint = el("span", "aps-node-rules-hint", "（散文 / 布局 / Danbooru 互不串台 · 风格交由 LoRA）");
  rulesTitleWrap.append(rulesTitle, rulesHint);

  const rulesHeadActions = el("div", "aps-node-rules-head-actions");
  const saveRulesBtn = el("button", "aps-btn aps-primary aps-btn-xs", "💾 保存");
  saveRulesBtn.type = "button";
  saveRulesBtn.title = "立即保存 3 模式提示词规则与偏好设置";

  const collapseRulesBtn = el("button", "aps-chip-btn aps-btn-xs", isRulesOpen ? "收起 ▴" : "展开 ▾");
  collapseRulesBtn.type = "button";

  rulesHeadActions.append(saveRulesBtn, collapseRulesBtn);
  rulesHead.append(rulesTitleWrap, rulesHeadActions);

  let defaultModeRules = { ...DEFAULT_MODE_RULE_TEXTS };
  const modeRuleBuffers = {
    caption: DEFAULT_MODE_RULE_TEXTS.caption,
    layout: DEFAULT_MODE_RULE_TEXTS.layout,
    danbooru: DEFAULT_MODE_RULE_TEXTS.danbooru,
  };
  let activeRuleTab = currentMode(node);
  let lastSyncedNodeMode = activeRuleTab;

  const ruleTabsRow = el("div", "aps-mode-rule-tabs");
  const ruleTabBtns = {};
  for (const [mKey, mLabel] of MODE_RULE_TABS) {
    const btn = el("button", `aps-mode-rule-tab${mKey === activeRuleTab ? " is-active" : ""}`, mLabel);
    btn.type = "button";
    btn.addEventListener("click", () => {
      modeRuleBuffers[activeRuleTab] = customRulesArea.value;
      activeRuleTab = mKey;
      syncNodeRuleTabUi();
    });
    ruleTabBtns[mKey] = btn;
    ruleTabsRow.append(btn);
  }

  const ruleMetaRow = el("div", "aps-node-rules-head");
  const ruleTabDesc = el("span", "aps-node-rules-hint", MODE_RULE_TABS[0][3]);
  const resetRuleBtn = el("button", "aps-chip-btn aps-btn-xs", "↺ 恢复默认");
  resetRuleBtn.type = "button";
  resetRuleBtn.title = "将当前模式的规则重置为客观 LoRA 友好默认规则";
  ruleMetaRow.append(ruleTabDesc, resetRuleBtn);

  // Language + Max Regions Row
  const rulesGrid = el("div", "aps-settings-grid-2");

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
  const maxRegLbl = el("label", "aps-field-label", "布局最大区域数 (1~16)");
  const ruleMaxRegInput = el("input", "aps-input aps-input-sm");
  ruleMaxRegInput.type = "number";
  ruleMaxRegInput.min = "1";
  ruleMaxRegInput.max = "16";
  ruleMaxRegInput.value = "10";
  maxRegWrap.append(maxRegLbl, ruleMaxRegInput);

  rulesGrid.append(langWrap, maxRegWrap);

  // Node-specific extra instruction row (tied to extra_instruction widget)
  const extraRow = el("div", "aps-node-field");
  const extraLbl = el("label", "aps-field-label", "当前节点补充要求（extra_instruction · 随工作流保存）");
  const extraInput = el("input", "aps-input aps-node-chat-input");
  extraInput.type = "text";
  extraInput.placeholder = "仅对本节点生效的补充要求，例如：重点描述人物交互 / 保留文字";
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

  // Active Mode Rule Textarea
  const customRulesWrap = el("div", "aps-node-field");
  const customRulesLbl = el("label", "aps-field-label", "当前模式专属规则");
  const customRulesArea = el("textarea", "aps-node-rules-textarea");
  customRulesArea.rows = 4;
  customRulesArea.placeholder = "编辑当前模式的提示词规则（留空则使用默认规则）…";
  customRulesArea.value = modeRuleBuffers[activeRuleTab];
  customRulesWrap.append(customRulesLbl, customRulesArea);

  function syncNodeRuleTabUi() {
    const meta = MODE_RULE_TABS.find(([k]) => k === activeRuleTab) || MODE_RULE_TABS[0];
    for (const [k, btn] of Object.entries(ruleTabBtns)) {
      btn.classList.toggle("is-active", k === activeRuleTab);
    }
    ruleTabDesc.textContent = meta[3];
    customRulesLbl.textContent = `${meta[1]}（仅对本模式生效）`;
    if (document.activeElement !== customRulesArea) {
      customRulesArea.value = modeRuleBuffers[activeRuleTab] ?? "";
    }
  }

  // Shared user custom requirements (optional global constraint across the 3 modes)
  const userCustomWrap = el("div", "aps-node-field aps-settings-user-custom-wrap");
  const userCustomLbl = el(
    "label",
    "aps-field-label aps-highlight-label",
    "★ 共享附加要求（可选 · 追加到以上 3 个模式末尾）",
  );
  const userCustomArea = el("textarea", "aps-node-rules-textarea aps-user-custom-area");
  userCustomArea.rows = 2;
  userCustomArea.placeholder = "例如：保留画面中所有可见文字；背景保持简洁…";
  userCustomWrap.append(userCustomLbl, userCustomArea);

  // Bottom note & save action
  const rulesFoot = el("div", "aps-node-rules-foot");
  const ruleStatusNote = el("span", "aps-node-rules-note", "修改后失焦或点击保存自动生效。");
  const saveBtnBottom = el("button", "aps-btn aps-primary aps-btn-xs", "💾 立即保存");
  saveBtnBottom.type = "button";

  rulesFoot.append(ruleStatusNote, saveBtnBottom);
  rulesPanel.append(
    rulesHead,
    ruleTabsRow,
    ruleMetaRow,
    customRulesWrap,
    rulesGrid,
    extraRow,
    userCustomWrap,
    rulesFoot,
  );

  let saveTimer = null;
  async function doSaveRules({ showFeedback = true } = {}) {
    modeRuleBuffers[activeRuleTab] = customRulesArea.value;
    const lang = ruleLangSel.value || "en";
    const maxReg = Math.max(1, Math.min(16, Number(ruleMaxRegInput.value) || 10));
    const userCustomRules = userCustomArea.value.trim();
    try {
      const res = await api.saveConfig({
        caption_rules: (modeRuleBuffers.caption || "").trim(),
        layout_rules: (modeRuleBuffers.layout || "").trim(),
        danbooru_rules: (modeRuleBuffers.danbooru || "").trim(),
        output_language: lang,
        max_regions: maxReg,
        user_custom_rules: userCustomRules,
      });
      if (res?.config) {
        node._apsActiveConfig = res.config;
      }
      if (showFeedback) {
        ruleStatusNote.textContent = `✓ 三模式规则已保存并生效（当前页: ${activeRuleTab} · 语言: ${lang}）`;
        ruleStatusNote.dataset.kind = "ok";
        setTimeout(() => {
          if (ruleStatusNote.textContent.includes("已保存")) {
            ruleStatusNote.textContent = "修改后失焦或点击保存自动生效。";
            ruleStatusNote.dataset.kind = "";
          }
        }, 3500);
      }
      const curModel = cleanWidgetStr(widget(node, "model")?.value) || res?.config?.model || "";
      statusLine.textContent = `就绪 · 模型: ${curModel} · 三模式独立规则已生效`;
      statusLine.title = statusLine.textContent;
      statusLine.dataset.kind = "";
    } catch (err) {
      const friendly = formatFriendlyError(err, "保存规则");
      const tech = formatErrorTechnicalDetail(err);
      ruleStatusNote.textContent = friendly;
      ruleStatusNote.title = tech ? `${friendly}\n\n${tech}` : friendly;
      ruleStatusNote.dataset.kind = "error";
    }
  }

  function triggerAutoSave() {
    modeRuleBuffers[activeRuleTab] = customRulesArea.value;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => doSaveRules({ showFeedback: true }), 450);
  }

  resetRuleBtn.addEventListener("click", () => {
    const defText = defaultModeRules[activeRuleTab] || DEFAULT_MODE_RULE_TEXTS[activeRuleTab] || "";
    modeRuleBuffers[activeRuleTab] = defText;
    customRulesArea.value = defText;
    ruleStatusNote.textContent = `✓ 已恢复「${activeRuleTab}」默认规则，正在保存…`;
    ruleStatusNote.dataset.kind = "ok";
    triggerAutoSave();
  });

  saveRulesBtn.addEventListener("click", () => doSaveRules({ showFeedback: true }));
  saveBtnBottom.addEventListener("click", () => doSaveRules({ showFeedback: true }));
  ruleLangSel.addEventListener("change", triggerAutoSave);
  ruleMaxRegInput.addEventListener("change", triggerAutoSave);
  customRulesArea.addEventListener("input", triggerAutoSave);
  customRulesArea.addEventListener("change", triggerAutoSave);
  userCustomArea.addEventListener("input", triggerAutoSave);
  userCustomArea.addEventListener("change", triggerAutoSave);

  function updateRulesVisibility(open) {
    isRulesOpen = Boolean(open);
    try {
      globalThis.localStorage?.setItem("aps_node_rules_open", String(isRulesOpen));
    } catch {}
    rulesToggleBtn.classList.toggle("is-active", isRulesOpen);
    rulesToggleBtn.textContent = isRulesOpen ? "规则偏好 ▴" : "规则偏好 ▾";
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
    if (cfg.default_mode_rules && typeof cfg.default_mode_rules === "object") {
      defaultModeRules = { ...DEFAULT_MODE_RULE_TEXTS, ...cfg.default_mode_rules };
    }
    if (document.activeElement !== customRulesArea) {
      modeRuleBuffers.caption = (cfg.caption_rules || "").trim() || defaultModeRules.caption;
      modeRuleBuffers.layout = (cfg.layout_rules || "").trim() || defaultModeRules.layout;
      modeRuleBuffers.danbooru = (cfg.danbooru_rules || "").trim() || defaultModeRules.danbooru;
      syncNodeRuleTabUi();
    }
    if (cfg.output_language && ruleLangSel.value !== cfg.output_language) {
      ruleLangSel.value = cfg.output_language;
    }
    if (cfg.max_regions != null && document.activeElement !== ruleMaxRegInput) {
      ruleMaxRegInput.value = String(cfg.max_regions);
    }
    if (typeof cfg.user_custom_rules === "string" && document.activeElement !== userCustomArea) {
      userCustomArea.value = cfg.user_custom_rules;
    }
    const extraW = widget(node, "extra_instruction");
    if (extraW && document.activeElement !== extraInput) {
      extraInput.value = cleanWidgetStr(extraW.value);
    }
  }
  node._apsFillRules = fillRulesConfig;

  const statusLine = el("div", "aps-node-status", "就绪 · 可勾选 1~3 个格式同时输出（散文 / 布局 / Danbooru）");

  const promptStatsRow = el("div", "aps-node-prompt-stats-row");
  promptStatsRow.append(promptMarksChip, promptStatsEl);
  mainCol.append(imaginePanel, promptBox, promptMarkView, promptStatsRow, quickBar, chatHudBanner, chatWrap, chatTargetBar, chatRow, rulesPanel, statusLine);
  workspaceWrap.append(stagePanel, mainCol);
  card.addEventListener("paste", async (ev) => {
    // Ignore paste if user is typing in an input or textarea
    if (ev.target && ["INPUT", "TEXTAREA"].includes(ev.target.tagName)) return;
    const items = ev.clipboardData?.items;
    if (!items || !items.length) return;
    for (const it of items) {
      if (it.type && it.type.startsWith("image/")) {
        const file = it.getAsFile();
        if (file) {
          ev.preventDefault();
          statusEl.textContent = "已从剪贴板粘贴并加载参考图！";
          try {
            await handleNewReferenceImage(node, file, statusEl);
          } catch (err) {
            reportNodeError(statusEl, err, "加载剪贴板图片");
          }
          break;
        }
      }
    }
  });

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
    if (pw) pw.value = payloadToJson(state);
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
        if (currentMode(node) === "hybrid") state.caption = hRes.caption;
        updated = true;
      }
      if (updated) {
        if (pw) pw.value = payloadToJson(state);
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

  statusEl.setRichStatus = (v, { kind = "", title = "" } = {}) => {
    const txt = v || "";
    statusLine.textContent = txt;
    statusLine.title = title || txt;
    statusLine.dataset.kind = kind || "";
  };

  Object.defineProperty(statusEl, "textContent", {
    get() {
      return statusLine.textContent;
    },
    set(v) {
      const txt = v || "";
      statusLine.textContent = txt;
      statusLine.title = txt;
      statusLine.dataset.kind = "";
    },
    configurable: true,
  });

  function snapshotStateForRollback(st) {
    if (!st || typeof st !== "object") return "{}";
    const copy = stripChatStateForRollback({ ...st });
    return JSON.stringify(copy);
  }

  function restoreFromRollbackSnapshot(snapshotJson) {
    const parsed = JSON.parse(snapshotJson || "{}");
    const curState = readPayload(node);
    const merged = {
      ...parsed,
      mode: parsed.mode || curState.mode || currentMode(node),
      modes: Array.isArray(parsed.modes) ? parsed.modes : curState.modes,
    };
    preserveChatThreads(merged, curState, { maxTurns: 20 });
    const { activeThread } = ensureChatThreads(merged, { maxTurns: 20 });
    node._apsSessionId = activeThread?.session_id || null;
    const pw = widget(node, "payload");
    if (pw) pw.value = payloadToJson(normalizeStateObject(merged));
    node._apsDirty = true;
    return merged;
  }

  function saveChatLog(nextLog, threadId = null, sessionIdUpdate = undefined) {
    const state = readPayload(node);
    const { activeId } = ensureChatThreads(state, { maxTurns: 20 });
    const targetTid = threadId || activeId;
    const updated = updateThreadTurns(state, targetTid, nextLog, {
      sessionId: sessionIdUpdate,
      maxTurns: 20,
    });
    if (state.active_chat_id === targetTid) {
      node._apsSessionId = updated?.session_id || null;
    }
    const pw = widget(node, "payload");
    if (pw) pw.value = payloadToJson(state);
    return state;
  }

  function compactChatBlocks(blocks) {
    if (!Array.isArray(blocks)) return [];
    const out = [];
    for (const blk of blocks) {
      if (!blk || blk.type === "equal") continue;
      if (blk.type === "change") {
        out.push({
          type: "change",
          before: String(blk.before || "").slice(0, 90),
          after: String(blk.after || "").slice(0, 90),
        });
      } else {
        out.push({
          type: String(blk.type || "add"),
          text: String(blk.text || "").slice(0, 90),
        });
      }
      if (out.length >= 4) break;
    }
    return out;
  }

  let nodeBusy = false;
  let nodeBusyStartMs = 0;
  let nodeBusyLabel = "";
  let nodeBusyTooltip = "";
  let nodeBusyTimer = null;
  let nodeHudTimerEl = null;

  function renderNodeHudBanner() {
    if (!nodeBusy) {
      chatHudBanner.hidden = true;
      chatHudBanner.textContent = "";
      nodeHudTimerEl = null;
      return;
    }
    chatHudBanner.hidden = false;
    const elapsedSec = Math.max(0, (Date.now() - nodeBusyStartMs) / 1000);
    if (!nodeHudTimerEl || !chatHudBanner.contains(nodeHudTimerEl)) {
      chatHudBanner.textContent = "";
      const dots = el("span", "aps-bouncing-dots");
      for (let i = 0; i < 3; i++) dots.append(el("i", ""));
      const titleSpan = el("span", "aps-hud-activity-title", excerpt(nodeBusyLabel || "处理中", 40) || "处理中");
      titleSpan.title = nodeBusyTooltip || nodeBusyLabel || "";
      nodeHudTimerEl = el("span", "aps-thinking-timer", `${elapsedSec.toFixed(1)}s`);
      chatHudBanner.append(dots, titleSpan, nodeHudTimerEl);
      return;
    }
    nodeHudTimerEl.textContent = `${elapsedSec.toFixed(1)}s`;
  }

  let lastRenderedThreadId = null;

  function renderChatLog() {
    const state = readPayload(node);
    const { threads, activeThread, activeId } = ensureChatThreads(state, { maxTurns: 20 });
    node._apsSessionId = activeThread?.session_id || null;
    const turns = Array.isArray(activeThread?.chat_log) ? activeThread.chat_log : [];

    chatTitle.textContent =
      threads.length > 1
        ? `💬 AI 对话改词（${threads.length} 个对话 · ${turns.length} 轮）`
        : `💬 AI 对话改词（${turns.length} 轮）`;
    chatClearBtn.hidden = turns.length === 0;

    const showThreadsBar = isChatLogOpen && (threads.length > 1 || turns.length > 0);
    chatThreadsBar.hidden = !showThreadsBar;
    const isRenamingFocused =
      editingThreadId &&
      chatThreadsBar.contains(document.activeElement) &&
      document.activeElement?.classList?.contains("aps-chat-thread-rename");

    if (showThreadsBar && !isRenamingFocused) {
      chatThreadsBar.textContent = "";
      for (const t of threads) {
        const isActive = t.id === activeId;
        const tab = el("div", `aps-chat-thread-tab${isActive ? " is-active" : ""}${nodeBusy ? " is-disabled" : ""}`);
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-selected", String(isActive));
        tab.title = nodeBusy
          ? "AI 正在回复中，请稍候"
          : `${t.title}${t.chat_log?.length ? ` (${t.chat_log.length} 轮)` : ""}\n单击切换 · 双击重命名`;

        if (editingThreadId === t.id && !nodeBusy) {
          const inp = el("input", "aps-chat-thread-rename");
          inp.type = "text";
          inp.maxLength = 40;
          inp.value = t.title;
          let committed = false;
          const finishRename = (save) => {
            if (committed) return;
            committed = true;
            editingThreadId = null;
            if (save) {
              const nextVal = inp.value.trim();
              if (nextVal && nextVal !== t.title) {
                const st = readPayload(node);
                renameChatThread(st, t.id, nextVal, { maxTurns: 20 });
                const pw = widget(node, "payload");
                if (pw) pw.value = payloadToJson(st);
                statusEl.textContent = `已重命名对话为「${nextVal.slice(0, 40)}」。`;
              }
            }
            renderChatLog();
          };
          for (const evName of ["click", "pointerdown", "mousedown", "dblclick"]) {
            inp.addEventListener(evName, (ev) => ev.stopPropagation());
          }
          inp.addEventListener("keydown", (ev) => {
            ev.stopPropagation();
            if (ev.key === "Enter") {
              ev.preventDefault();
              finishRename(true);
            } else if (ev.key === "Escape") {
              ev.preventDefault();
              finishRename(false);
            }
          });
          inp.addEventListener("blur", () => finishRename(true));
          tab.append(inp);
          setTimeout(() => {
            try {
              inp.focus();
              inp.select();
            } catch {}
          }, 0);
        } else {
          const lbl = el("span", "aps-chat-thread-label", t.title);
          tab.append(lbl);
          if (Array.isArray(t.chat_log) && t.chat_log.length > 0) {
            tab.append(el("span", "aps-chat-thread-count", String(t.chat_log.length)));
          }
          if (threads.length > 1) {
            const closeBtn = el("button", "aps-chat-thread-close", "×");
            closeBtn.type = "button";
            closeBtn.disabled = nodeBusy;
            closeBtn.title = "删除此对话";
            closeBtn.addEventListener("click", (ev) => {
              ev.stopPropagation();
              if (nodeBusy) return;
              const st = readPayload(node);
              const { deleted, activeThread: nextAct } = deleteChatThread(st, t.id, { maxTurns: 20 });
              node._apsSessionId = nextAct?.session_id || null;
              node._apsMarksDismissed = null;
              if (deleted?.session_id) api.deleteSession(deleted.session_id).catch(() => {});
              const pw = widget(node, "payload");
              if (pw) pw.value = payloadToJson(st);
              statusEl.textContent = `已删除「${deleted?.title || t.title}」，当前对话：${nextAct?.title || "对话 1"}。`;
              syncCard();
              applyStageGeometry();
              node.setDirtyCanvas?.(true, true);
            });
            tab.append(closeBtn);
          }
          tab.addEventListener("click", () => {
            if (nodeBusy) {
              statusEl.textContent = "当前正在等待 AI 回复，请完成后再切换对话。";
              return;
            }
            if (t.id === activeId) return;
            const st = readPayload(node);
            const sw = switchChatThread(st, t.id, { maxTurns: 20 });
            if (!sw.ok) return;
            node._apsSessionId = sw.thread?.session_id || null;
            node._apsMarksDismissed = null;
            editingThreadId = null;
            const pw = widget(node, "payload");
            if (pw) pw.value = payloadToJson(st);
            statusEl.textContent = `已切换到「${sw.thread.title}」。`;
            syncCard();
            node.setDirtyCanvas?.(true, true);
          });
          tab.addEventListener("dblclick", (ev) => {
            if (nodeBusy || ev.target.closest?.(".aps-chat-thread-close")) return;
            ev.stopPropagation();
            editingThreadId = t.id;
            renderChatLog();
          });
        }
        chatThreadsBar.append(tab);
        if (isActive && lastRenderedThreadId !== activeId) {
          lastRenderedThreadId = activeId;
          setTimeout(() => {
            try {
              tab.scrollIntoView?.({ block: "nearest", inline: "nearest" });
            } catch {}
          }, 0);
        }
      }
    }

    chatLogEl.textContent = "";
    const showLogArea = isChatLogOpen && (turns.length > 0 || threads.length > 1);
    chatLogEl.hidden = !showLogArea;
    if (!showLogArea) return;

    if (!turns.length) {
      chatLogEl.append(
        el(
          "div",
          "aps-chat-empty-hint",
          `💬 当前「${activeThread?.title || "新对话"}」暂无消息（上下文完全独立），在下方输入要求即可开始。`,
        ),
      );
      return;
    }

    for (const turn of turns) {
      const turnEl = el("div", "aps-chat-turn");
      const modeName = { caption: "散文", layout: "布局", danbooru: "Danbooru" }[turn.mode] || turn.mode || "";

      const uBubble = el("div", "aps-chat-bubble aps-chat-bubble-user");
      const uMeta = el("div", "aps-chat-meta");
      uMeta.append(el("span", "", `🧑‍🎨 你 · ${modeName}`));
      if (turn.regionBadge) {
        const rTag = el("span", "aps-chat-region-tag", turn.regionBadge);
        if (turn.regionColor) rTag.style.setProperty("--aps-tag-color", turn.regionColor);
        uMeta.append(rTag);
      }
      uBubble.append(
        uMeta,
        el("div", "", String(turn.label || turn.userText || "")),
      );

      const aiCls =
        "aps-chat-bubble aps-chat-bubble-ai" +
        (turn.pending
          ? " is-thinking"
          : turn.error
            ? " is-error"
            : !turn.changed
              ? " is-question"
              : "");
      const aBubble = el("div", aiCls);
      const aMeta = el("div", "aps-chat-meta");
      const roleTag = turn.pending
        ? "AI 视觉伙伴 · 思考中"
        : turn.error
          ? "⚠️ AI 视觉伙伴 · 异常"
          : turn.changed
            ? turn.rolledBack
              ? "AI 视觉伙伴 · 已撤回修改"
              : "AI 视觉伙伴 · 已更新提示词"
            : "❓ AI 视觉伙伴 · 反问 / 待确认";
      aMeta.append(el("span", "", roleTag));
      if (turn.regionBadge) {
        const rTag = el("span", "aps-chat-region-tag", turn.regionBadge);
        if (turn.regionColor) rTag.style.setProperty("--aps-tag-color", turn.regionColor);
        aMeta.append(rTag);
      }

      if (turn.pending) {
        // 进度只有一条（HUD 那条），这里不再放第二个「思考中」气泡。
      } else {
        const crestText = turn.error
          ? "ALERT"
          : turn.changed
            ? turn.rolledBack
              ? "ROLLED BACK"
              : turn.regionBadge
                ? "REGION UPDATED"
                : "DIFF APPLIED"
            : "QUEST / CONFIRM";
        const crestKind = turn.error ? "is-err" : turn.changed && !turn.rolledBack ? "is-ok" : "is-warn";
        aMeta.append(el("span", `aps-chat-crest ${crestKind}`, crestText));
        aBubble.append(
          aMeta,
          el("div", "", String(turn.reply || "")),
        );
      }

      if (turn.changed && Array.isArray(turn.blocks) && turn.blocks.length) {
        const diffBox = el("details", "aps-chat-diff");
        diffBox.append(el("summary", "aps-chat-diff-sum", `查看 ${turn.blocks.length} 处改动明细（原文已标出）`));
        for (const blk of turn.blocks) {
          if (blk.type === "change") {
            diffBox.append(
              el("div", "aps-chat-diff-del", `- ${blk.before}`),
              el("div", "aps-chat-diff-add", `+ ${blk.after}`),
            );
          } else if (blk.type === "del" || blk.type === "delete") {
            diffBox.append(el("div", "aps-chat-diff-del", `- ${blk.text}`));
          } else {
            diffBox.append(el("div", "aps-chat-diff-add", `+ ${blk.text}`));
          }
        }
        aBubble.append(diffBox);
      }

      if (turn.error && turn.errorDetail) {
        const errBox = el("details", "aps-chat-diff aps-chat-error-details");
        errBox.append(el("summary", "aps-chat-diff-sum", "查看技术细节（错误码 / 重试 / 报错原文）"));
        errBox.append(el("pre", "aps-chat-error-pre", String(turn.errorDetail)));
        aBubble.append(errBox);
      }

      if (!turn.pending) {
        const actRow = el("div", "aps-chat-actions");
        if (turn.changed && !turn.rolledBack && turn.beforeStateJson) {
          const rollbackBtn = el("button", "aps-chip-btn aps-btn-xs", "撤回此轮");
          rollbackBtn.type = "button";
          rollbackBtn.title = "撤回这一轮 AI 对提示词和布局框的改动（保留对话记录）";
          rollbackBtn.addEventListener("click", () => {
            try {
              restoreFromRollbackSnapshot(turn.beforeStateJson);
              const cur = readPayload(node);
              const { activeThread: actT } = ensureChatThreads(cur, { maxTurns: 20 });
              const curTurns = Array.isArray(actT?.chat_log) ? actT.chat_log : [];
              const nextTurns = curTurns.map((t) =>
                t.id === turn.id ? { ...t, rolledBack: true } : t,
              );
              saveChatLog(nextTurns, actT?.id || activeId);
              statusEl.textContent = "✓ 已撤回该轮 AI 修改，提示词与画框已恢复。";
              syncCard();
              node.setDirtyCanvas?.(true, true);
            } catch (err) {
              statusEl.textContent = `撤回失败：${err?.message || err}`;
            }
          });
          actRow.append(rollbackBtn);
        } else if (turn.rolledBack) {
          actRow.append(el("span", "aps-chat-badge", "已撤回"));
        }

        const retryBtn = el("button", "aps-chip-btn aps-btn-xs", "🔄 重试");
        retryBtn.type = "button";
        retryBtn.title = "回到本轮前的提示词状态，重新请求 AI 执行这一轮指令";
        retryBtn.addEventListener("click", () => {
          const fallbackBefore = snapshotStateForRollback(readPayload(node));
          let baseSnapshot = turn.beforeStateJson || fallbackBefore;
          if (turn.changed && !turn.rolledBack && turn.beforeStateJson) {
            try {
              restoreFromRollbackSnapshot(turn.beforeStateJson);
            } catch {}
          }
          void runInlineEdit(turn.userText || turn.label, turn.label || turn.userText, {
            retryTurnId: turn.id,
            beforeStateJsonOverride: baseSnapshot,
            modeOverride: turn.mode,
            regionIndexOverride: typeof turn.regionIdx === "number" ? turn.regionIdx : -1,
            threadIdOverride: activeId,
          });
        });
        actRow.append(retryBtn);
        aBubble.append(actRow);
      }

      turnEl.append(uBubble);
      if (!turn.pending) turnEl.append(aBubble);
      chatLogEl.append(turnEl);
    }
    chatLogEl.scrollTop = chatLogEl.scrollHeight;
  }
  node._apsSyncChatLog = renderChatLog;

  async function runInlineEdit(
    instruction,
    label,
    {
      retryTurnId = null,
      beforeStateJsonOverride = null,
      modeOverride = null,
      regionIndexOverride = undefined,
      threadIdOverride = null,
    } = {},
  ) {
    const mode = modeOverride || currentMode(node);
    const stateBefore = readPayload(node);
    const { activeId: ensActiveId } = ensureChatThreads(stateBefore, { maxTurns: 20 });
    const reqThreadId = threadIdOverride || ensActiveId;
    const reqThread = stateBefore.chat_threads?.find((t) => t.id === reqThreadId);
    const reqSessionId =
      reqThread?.session_id ||
      (reqThreadId === ensActiveId ? node._apsSessionId || stateBefore.session_id : null) ||
      undefined;
    const targetRegionIdx = regionIndexOverride !== undefined ? regionIndexOverride : selectedRegion;
    const targetRegionItem =
      targetRegionIdx >= 0 && Array.isArray(stateBefore.draft?.items)
        ? stateBefore.draft.items[targetRegionIdx]
        : null;
    const regDisplayName = targetRegionItem
      ? targetRegionItem.name ||
        (targetRegionItem.label === "character" ? "角色" : targetRegionItem.label === "text" ? "文字" : "物体")
      : "";
    const regionBadge = targetRegionItem ? `@画框 #${targetRegionIdx + 1}「${regDisplayName}」` : null;
    const regionColor = targetRegionItem ? BOX_COLORS[targetRegionIdx % BOX_COLORS.length] : null;

    // If a bounding box is @quoted, edit that box's description AND sync global prose caption if present!
    const pureGlobalCap = activePromptForMode(stateBefore, "caption");
    const hasBothRegionAndGlobal = Boolean(targetRegionItem && pureGlobalCap);
    const currentText = targetRegionItem
      ? hasBothRegionAndGlobal
        ? `[REGION_CAPTION]\n${targetRegionItem.caption || ""}\n[/REGION_CAPTION]\n\n[GLOBAL_CAPTION]\n${pureGlobalCap}\n[/GLOBAL_CAPTION]`
        : String(targetRegionItem.caption || "")
      : activePromptForMode(stateBefore, mode);
    const effectiveEditMode = targetRegionItem ? "caption" : mode;
    const effectiveMessage = targetRegionItem
      ? hasBothRegionAndGlobal
        ? `[当前用户在画布上点选并 @引用 了局部画框 #${targetRegionIdx + 1}「${regDisplayName}」（类型: ${targetRegionItem.label}, 坐标: ${JSON.stringify(targetRegionItem.bbox)}）。请根据用户指令修改 [REGION_CAPTION] 内的该区域描述，并同步修改 [GLOBAL_CAPTION] 全局描述中与该区域对应的词句（务必保留 [REGION_CAPTION] 与 [GLOBAL_CAPTION] 标签结构不变）。在 reply 中用中文简述改动了哪里；若拿不定主意请反问用户。]\n用户指令：${instruction}`
        : `[当前用户在画布上点选并 @引用 了局部画框 #${targetRegionIdx + 1}「${regDisplayName}」（类型: ${targetRegionItem.label}, 坐标: ${JSON.stringify(targetRegionItem.bbox)}）。请针对该局部区域描述进行修改，并用中文在 reply 中简述改动了哪里；若拿不定主意请反问用户。]\n用户指令：${instruction}`
      : instruction;

    const beforeStateJson = beforeStateJsonOverride || snapshotStateForRollback(stateBefore);

    const turnId = retryTurnId || `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const existingTurns = Array.isArray(reqThread?.chat_log) ? [...reqThread.chat_log] : [];
    const draftTurn = {
      id: turnId,
      mode,
      regionIdx: targetRegionItem ? targetRegionIdx : -1,
      regionBadge,
      regionColor,
      userText: instruction,
      label: label || instruction,
      beforeStateJson,
      reply: targetRegionItem
        ? `正在针对 @画框 #${targetRegionIdx + 1}「${excerpt(regDisplayName, 14)}」分析并生成修改…`
        : "正在思考并检查需要修改的部分…",
      changed: false,
      blocks: [],
      rolledBack: false,
      pending: true,
      error: false,
    };
    const idx = existingTurns.findIndex((t) => t.id === turnId);
    if (idx >= 0) {
      existingTurns[idx] = draftTurn;
    } else {
      existingTurns.push(draftTurn);
    }
    saveChatLog(existingTurns, reqThreadId);
    isChatLogOpen = true;
    renderChatLog();

    const flatLabel = String(label || instruction || "").replace(/\s+/g, " ").trim();
    const fullBusyText = targetRegionItem
      ? `正在修改 @画框 #${targetRegionIdx + 1}「${regDisplayName}」：${flatLabel}…`
      : `正在执行：${flatLabel}…`;
    const busyText = formatBusyStatusText(label || instruction, {
      regionIndex: targetRegionItem ? targetRegionIdx : -1,
      regionName: regDisplayName,
      maxInstructionChars: targetRegionItem ? 16 : 22,
      maxRegionChars: 10,
    });
    statusEl.textContent = busyText;
    statusLine.title = fullBusyText;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    inlineEditController = controller;
    node._apsSetBusy?.(true, busyText, false, fullBusyText);
    try {
      let imgUrl = node._apsImageDataUrl || null;
      if (!imgUrl) {
        try {
          imgUrl = await fetchImageDataUrl(node);
        } catch {
          imgUrl = null;
        }
      }
      const res = await api.edit(
        {
          message: effectiveMessage,
          mode: effectiveEditMode,
          target: {
            node_id: node.id,
            widget: targetRegionItem ? `region_${targetRegionIdx}` : "caption",
            title: targetRegionItem
              ? `区域画框 #${targetRegionIdx + 1} (${regDisplayName})`
              : node.title || "AI 图像反推提示词",
            text: currentText,
          },
          images: imgUrl ? [{ data_url: imgUrl }] : undefined,
          session_id: reqSessionId,
          create_session: true,
          allow_empty: true,
          canvas: { width: Number(stateBefore.width) || 1024, height: Number(stateBefore.height) || 1024 },
        },
        { signal: controller?.signal },
      );
      if (res.session_id) {
        const stSid = readPayload(node);
        setThreadSessionId(stSid, reqThreadId, res.session_id, { maxTurns: 20 });
        if (stSid.active_chat_id === reqThreadId) {
          node._apsSessionId = res.session_id;
        }
        const pwSid = widget(node, "payload");
        if (pwSid) pwSid.value = payloadToJson(stSid);
      }
      const proposal = res.proposal || {};

      let finalTurn;
      if (proposal.changed) {
        if (!targetRegionItem && mode === "layout") {
          let parsedOk = false;
          try {
            const parsed = JSON.parse(String(proposal.text || ""));
            parsedOk = Boolean(parsed && typeof parsed === "object" && (parsed.summary || Array.isArray(parsed.items)));
          } catch {
            parsedOk = false;
          }
          if (!parsedOk) {
            finalTurn = {
              ...draftTurn,
              pending: false,
              changed: false,
              error: true,
              reply: "❌ 本次 Layout JSON 校验未通过，未覆盖当前布局框。请点击「🔄 重试」。",
            };
            const curSt = readPayload(node);
            ensureChatThreads(curSt, { maxTurns: 20 });
            const curT = curSt.chat_threads?.find((t) => t.id === reqThreadId);
            const curLog = Array.isArray(curT?.chat_log) ? curT.chat_log : existingTurns;
            saveChatLog(curLog.map((t) => (t.id === turnId ? finalTurn : t)), reqThreadId, res.session_id || undefined);
            statusEl.textContent = finalTurn.reply;
            renderChatLog();
            return;
          }
        }

        const nextState = readPayload(node);
        ensureChatThreads(nextState, { maxTurns: 20 });
        if (res.session_id) setThreadSessionId(nextState, reqThreadId, res.session_id, { maxTurns: 20 });
        const w = Number(nextState.width) || 1024;
        const h = Number(nextState.height) || 1024;

        // Detect if user instruction or AI proposal deletes a bounding box from stage
        const delIdx = detectBoxDeletion(
          instruction,
          nextState.draft?.items,
          targetRegionIdx,
          proposal.reply,
        );
        let deletedBoxDesc = "";
        if (delIdx >= 0 && Array.isArray(nextState.draft?.items) && nextState.draft.items[delIdx]) {
          const delItem = nextState.draft.items[delIdx];
          deletedBoxDesc = delItem.name || delItem.label || `画框 #${delIdx + 1}`;
          nextState.draft.items.splice(delIdx, 1);
          if (selectedRegion === delIdx) {
            selectedRegion = -1;
          } else if (selectedRegion > delIdx) {
            selectedRegion -= 1;
          }
        }

        if (targetRegionItem && nextState.draft?.items?.[targetRegionIdx] && delIdx !== targetRegionIdx) {
          const outText = String(proposal.text || "").trim();
          const regMatch = outText.match(/\[REGION_CAPTION\]\s*([\s\S]*?)\s*\[\/REGION_CAPTION\]/i);
          const globMatch = outText.match(/\[GLOBAL_CAPTION\]\s*([\s\S]*?)\s*\[\/GLOBAL_CAPTION\]/i);
          if (regMatch && regMatch[1].trim()) {
            nextState.draft.items[targetRegionIdx].caption = regMatch[1].trim();
          } else if (!globMatch && outText) {
            nextState.draft.items[targetRegionIdx].caption = outText
              .replace(/\[\/?(?:REGION_CAPTION|GLOBAL_CAPTION)\]/gi, "")
              .trim();
          }
          if (globMatch && globMatch[1].trim()) {
            const nextGlobal = cleanPureCaptionText(globMatch[1].trim());
            if (nextGlobal) {
              nextState.caption = nextGlobal;
              nextState.caption_text = nextGlobal;
              if (nextState.draft?.summary) nextState.draft.summary.caption = nextGlobal;
            }
          }
        } else if (targetRegionItem && delIdx === targetRegionIdx) {
          // The selected box was deleted, sync global caption if returned
          const outText = String(proposal.text || "").trim();
          const globMatch = outText.match(/\[GLOBAL_CAPTION\]\s*([\s\S]*?)\s*\[\/GLOBAL_CAPTION\]/i);
          if (globMatch && globMatch[1].trim()) {
            const nextGlobal = cleanPureCaptionText(globMatch[1].trim());
            if (nextGlobal) {
              nextState.caption = nextGlobal;
              nextState.caption_text = nextGlobal;
              if (nextState.draft?.summary) nextState.draft.summary.caption = nextGlobal;
            }
          }
        } else {
          writePromptForMode(nextState, mode, proposal.text);
        }

        if (nextState.draft) {
          const normDraft = normalizeDraft(nextState.draft, w, h);
          nextState.draft = normDraft;
          nextState.layout_draft = normDraft;
          nextState.hybrid_draft = {
            ...normDraft,
            summary: {
              ...(normDraft.summary || {}),
              caption: nextState.caption_text || nextState.caption || normDraft.summary?.caption || "",
            },
          };
        }

        nextState.width = w;
        nextState.height = h;
        node._apsUndo?.record({
          key: "payload_state",
          before: beforeStateJson,
          after: "",
          label: proposal.reply || label || "AI 改词",
          source: "edit",
        });

        let replyMsg = proposal.reply || `已完成 ${proposal.changes?.length || 1} 处修改。`;
        if (deletedBoxDesc && !replyMsg.includes("删除") && !replyMsg.includes("移除")) {
          replyMsg = (replyMsg ? `${replyMsg} ` : "") + `（已从画面中删除画框「${deletedBoxDesc}」）`;
        }

        finalTurn = {
          ...draftTurn,
          pending: false,
          changed: true,
          error: false,
          rolledBack: false,
          reply: replyMsg,
          blocks: compactChatBlocks(proposal.blocks),
        };
        try {
          const beforeText = activePromptForMode(JSON.parse(beforeStateJson), mode);
          const afterText = activePromptForMode(nextState, mode);
          const ranges = wordDiffRanges(beforeText, afterText);
          if (ranges.length) finalTurn.marks = { len: afterText.length, ranges: ranges.slice(0, 40) };
        } catch {}
        const targetThread = nextState.chat_threads?.find((t) => t.id === reqThreadId);
        const baseTurns = Array.isArray(targetThread?.chat_log) ? targetThread.chat_log : existingTurns;
        updateThreadTurns(
          nextState,
          reqThreadId,
          baseTurns.map((t) => (t.id === turnId ? finalTurn : t)),
          { sessionId: res.session_id || undefined, maxTurns: 20 },
        );
        const pw = widget(node, "payload");
        if (pw) pw.value = payloadToJson(normalizeStateObject(nextState));
        node._apsDirty = true;
        statusEl.textContent = `✓ ${finalTurn.reply}`;
        syncCard();
        node.setDirtyCanvas?.(true, true);
      } else {
        const nextState = readPayload(node);
        ensureChatThreads(nextState, { maxTurns: 20 });
        if (res.session_id) setThreadSessionId(nextState, reqThreadId, res.session_id, { maxTurns: 20 });
        const w = Number(nextState.width) || 1024;
        const h = Number(nextState.height) || 1024;

        // Even if proposal text wasn't changed, check if a box should be deleted from canvas
        const delIdx = detectBoxDeletion(
          instruction,
          nextState.draft?.items,
          targetRegionIdx,
          proposal?.reply,
        );
        if (delIdx >= 0 && Array.isArray(nextState.draft?.items) && nextState.draft.items[delIdx]) {
          const delItem = nextState.draft.items[delIdx];
          const delName = delItem.name || delItem.label || `画框 #${delIdx + 1}`;
          nextState.draft.items.splice(delIdx, 1);
          if (selectedRegion === delIdx) {
            selectedRegion = -1;
          } else if (selectedRegion > delIdx) {
            selectedRegion -= 1;
          }
          const normDraft = normalizeDraft(nextState.draft, w, h);
          nextState.draft = normDraft;
          nextState.layout_draft = normDraft;
          nextState.hybrid_draft = {
            ...normDraft,
            summary: {
              ...(normDraft.summary || {}),
              caption: nextState.caption_text || nextState.caption || normDraft.summary?.caption || "",
            },
          };
          node._apsUndo?.record({
            key: "payload_state",
            before: beforeStateJson,
            after: "",
            label: `删除画框 #${delIdx + 1}「${delName}」`,
            source: "edit",
          });
          finalTurn = {
            ...draftTurn,
            pending: false,
            changed: true,
            error: false,
            reply: `✓ 已从画面中删除画框 #${delIdx + 1}「${delName}」并更新布局。`,
          };
          const targetThread = nextState.chat_threads?.find((t) => t.id === reqThreadId);
          const baseTurns = Array.isArray(targetThread?.chat_log) ? targetThread.chat_log : existingTurns;
          updateThreadTurns(
            nextState,
            reqThreadId,
            baseTurns.map((t) => (t.id === turnId ? finalTurn : t)),
            { sessionId: res.session_id || undefined, maxTurns: 20 },
          );
          const pw = widget(node, "payload");
          if (pw) pw.value = payloadToJson(normalizeStateObject(nextState));
          node._apsDirty = true;
          statusEl.textContent = `✓ ${finalTurn.reply}`;
          syncCard();
          node.setDirtyCanvas?.(true, true);
          return;
        }

        finalTurn = {
          ...draftTurn,
          pending: false,
          changed: false,
          error: false,
          reply: proposal.reply || "当前提示词无需改动；如需进一步调整请告诉我具体要求。",
        };
        const targetThread = nextState.chat_threads?.find((t) => t.id === reqThreadId);
        const baseTurns = Array.isArray(targetThread?.chat_log) ? targetThread.chat_log : existingTurns;
        saveChatLog(baseTurns.map((t) => (t.id === turnId ? finalTurn : t)), reqThreadId, res.session_id || undefined);
        statusEl.textContent = `💬 ${finalTurn.reply}`;
        renderChatLog();
        node.setDirtyCanvas?.(true, true);
      }
    } catch (err) {
      if (err?.name === "AbortError") {
        const curSt = readPayload(node);
        ensureChatThreads(curSt, { maxTurns: 20 });
        const curT = curSt.chat_threads?.find((t) => t.id === reqThreadId);
        const curLog = Array.isArray(curT?.chat_log) ? curT.chat_log : existingTurns;
        const abortedTurn = {
          ...draftTurn,
          pending: false,
          changed: false,
          error: false,
          reply: "⏹ 已终止本次请求，提示词保持原样未改动。",
        };
        saveChatLog(curLog.map((t) => (t.id === turnId ? abortedTurn : t)), reqThreadId);
        statusEl.textContent = "⏹ 已终止本次请求。";
        renderChatLog();
      } else {
        const { friendly: errMsg, tech: errTech } = reportNodeError(statusEl, err, "AI 改词");
        const curSt = readPayload(node);
        ensureChatThreads(curSt, { maxTurns: 20 });
        const curT = curSt.chat_threads?.find((t) => t.id === reqThreadId);
        const curLog = Array.isArray(curT?.chat_log) ? curT.chat_log : existingTurns;
        saveChatLog(
          curLog.map((t) =>
            t.id === turnId
              ? {
                  ...draftTurn,
                  pending: false,
                  changed: false,
                  error: true,
                  reply: errMsg,
                  errorDetail: errTech || "",
                }
              : t,
          ),
          reqThreadId,
        );
        renderChatLog();
      }
    } finally {
      inlineEditController = null;
      node._apsSetBusy?.(false);
    }
  }

  function syncChatTargetBar(items) {
    chatTargetBar.textContent = "";
    if (selectedRegion >= 0 && items[selectedRegion]) {
      const item = items[selectedRegion];
      const color = BOX_COLORS[selectedRegion % BOX_COLORS.length];
      const displayName =
        item.name || (item.label === "character" ? "角色" : item.label === "text" ? "文字" : "物体");
      chatTargetBar.className = "aps-target-lock-bar is-locked";
      chatTargetBar.style.setProperty("--aps-lock-color", color);

      const badge = el("span", "aps-target-lock-badge", `@画框 #${selectedRegion + 1}「${displayName}」`);
      badge.style.backgroundColor = color;
      const snippet = el(
        "span",
        "aps-target-lock-snippet",
        item.caption ? String(item.caption).slice(0, 56) : "（可直接输入指令修改此框）",
      );

      const actionsWrap = el("div", "aps-target-lock-actions");
      const expBtn = el("button", "aps-target-action-btn", "扩写此框");
      expBtn.type = "button";
      expBtn.title = "使用 AI 丰富此画框区域的材质、光影与细节";
      expBtn.addEventListener("click", () => {
        void runInlineEdit(
          "丰富该区域的物理材质、光影质感、色彩与细微纹理",
          `扩写 @画框 #${selectedRegion + 1}「${displayName}」`,
        );
      });

      const trBtn = el("button", "aps-target-action-btn", "译英此框");
      trBtn.type = "button";
      trBtn.title = "将此画框区域的描述翻译为地道英文";
      trBtn.addEventListener("click", () => {
        void runInlineEdit(
          "Translate the description into accurate, descriptive English suitable for image generation prompts.",
          `译英 @画框 #${selectedRegion + 1}「${displayName}」`,
        );
      });

      const unquoteBtn = el("button", "aps-target-unlock-btn", "✕ 取消引用");
      unquoteBtn.type = "button";
      unquoteBtn.title = "取消选框引用，恢复修改全局提示词";
      unquoteBtn.addEventListener("click", () => {
        selectedRegion = -1;
        syncCard();
      });

      actionsWrap.append(expBtn, trBtn, unquoteBtn);
      chatTargetBar.append(badge, snippet, actionsWrap);
      chatInput.placeholder = `已引用 @画框 #${selectedRegion + 1}「${displayName}」：输入针对该框的改词要求（回车发送）…`;
      chatSend.textContent = `改 #${selectedRegion + 1} ✦`;
    } else {
      chatTargetBar.className = "aps-target-lock-bar is-global";
      chatTargetBar.style.removeProperty("--aps-lock-color");
      const globalBadge = el("span", "aps-target-global-badge", "全局改词");
      const globalHint = el(
        "span",
        "aps-target-lock-snippet",
        items.length
          ? "鼠标点击左侧画框可 @引用 针对该框修改；未选框则修改全局提示词"
          : "直接输入要求修改全局提示词（支持撤回/重试）",
      );
      chatTargetBar.append(globalBadge, globalHint);
      chatInput.placeholder = "输入全局改词要求、回答 AI 反问或提问（点选左侧画框可 @引用 局部改词，回车发送）…";
      chatSend.textContent = "发送 ✦";
    }
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
    const { activeThread } = ensureChatThreads(state, { maxTurns: 20 });
    node._apsSessionId = activeThread?.session_id || null;
    if (mode !== lastSyncedNodeMode) {
      lastSyncedNodeMode = mode;
      if (document.activeElement !== customRulesArea) {
        modeRuleBuffers[activeRuleTab] = customRulesArea.value;
        activeRuleTab = mode;
        syncNodeRuleTabUi();
      }
    }
    if (typeof autoImagineCheckbox !== "undefined") {
      autoImagineCheckbox.checked = Boolean(state.auto_imagine);
      btnImagine.style.borderColor = state.auto_imagine ? "var(--aps-accent, #38bdf8)" : "";
    }
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
    outputChip.textContent = `输出 ${modes.length}/${ALL_MODES.length} ▾`;
    outputChip.classList.toggle("is-accent", allOn);
    sizeBadge.textContent = state.width && state.height ? `${w}×${h} ▾` : "1024×1024 ▾";
    const canUndo = Boolean(node._apsUndo?.canUndo);
    btnUndo.disabled = !canUndo;
    if (typeof stageUndoBtn !== "undefined") stageUndoBtn.disabled = !canUndo;

    const text = activePromptForMode(state, mode);
    if (document.activeElement !== promptBox) {
      promptBox.value = text;
    }
    {
      const lastTurn = (Array.isArray(state.chat_log) ? state.chat_log : []).slice(-1)[0];
      const fresh = lastTurn && lastTurn.changed && !lastTurn.rolledBack && !lastTurn.pending;
      node._apsLastTurn = fresh ? lastTurn : null;
      renderPromptMarks(text, fresh ? lastTurn : null);
    }

    // Regions summary pills + inline property inspector inside stagePanel (NO duplicate AI dialog box!)
    regionsBar.textContent = "";
    const items = Array.isArray(state.draft?.items) ? state.draft.items : [];
    if (selectedRegion >= items.length) {
      selectedRegion = items.length - 1;
    }
    // 用户可在「⋯」里隐藏画框；隐藏后只留底图，提示词与框数据都不变。
    const boxesVisible = state.stage_boxes_visible !== false;
    const showBoxes = boxesVisible && (mode !== "caption" || modes.includes("layout") || modes.includes("hybrid") || items.length > 0);
    if (items.length > 0) {
      regionsBar.hidden = false;
      items.forEach((it, idx) => {
        const displayName = it.name || (it.label === "character" ? "角色" : (it.label === "text" ? "文字" : "物体"));
        const color = BOX_COLORS[idx % BOX_COLORS.length];
        const pill = el("button", `aps-region-pill${idx === selectedRegion ? " is-selected" : ""}`);
        const dot = el("span", "aps-region-dot");
        dot.style.background = color;
        pill.append(dot, document.createTextNode(`#${idx + 1} ${displayName}`));
        pill.type = "button";
        pill.title = `#${idx + 1} [${it.label}] ${it.caption || ""}\n单击 @引用 到右侧主对话框修改（再次单击取消引用）；双击打开全屏双栏工作台`;
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

    // Compact property inspector for the selected box (AI modification is unified in the main dialog box!)
    if (selectedRegion >= 0 && items[selectedRegion]) {
      const item = items[selectedRegion];
      regionInspector.classList.add("is-open");
      regionInspector.textContent = "";

      // Row 1: Header (Index, Label, Name, Coordinates, Spatial Anchor, Delete, Unselect)
      const row1 = el("div", "aps-region-inspect-row aps-region-inspect-header");
      const badge = el("span", "aps-region-inspector-idx", `#${selectedRegion + 1}`);
      badge.style.backgroundColor = BOX_COLORS[selectedRegion % BOX_COLORS.length];
      badge.style.color = "#fff";
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
      nameInput.style.maxWidth = "110px";
      nameInput.title = "区域实体名称（显示在画框与主对话框 @引用 标签上）";
      nameInput.addEventListener("change", () => {
        item.name = nameInput.value.trim();
        commitDraftToState(state, normalizeDraft(state.draft, w, h), w, h, true, `修改区域 #${selectedRegion + 1} 名称`);
        statusEl.textContent = `已修改区域 #${selectedRegion + 1} 名称为【${item.name}】。`;
        syncCard();
      });

      const boundsBadge = el("span", "aps-region-bounds-badge", `${bw}×${bh} (${Math.round(bx1)},${Math.round(by1)})`);
      boundsBadge.title = `区域范围: 左上角 (${Math.round(bx1)}, ${Math.round(by1)})，尺寸 ${bw}×${bh}`;

      const centerX = (bx1 + bx2) / 2;
      let posText = "居中";
      let posPhraseEn = "in the center of the frame";
      if (centerX < w * 0.42) {
        posText = "画面左侧";
        posPhraseEn = "on the viewer's left side of the frame";
      } else if (centerX > w * 0.58) {
        posText = "画面右侧";
        posPhraseEn = "on the viewer's right side of the frame";
      }

      const regPosBtn = el("button", "aps-btn aps-btn-xs", `📍 注入【${posText}】`);
      regPosBtn.type = "button";
      regPosBtn.title = `一键将观众视角的绝对空间方位（${posPhraseEn}）注入此区域描述，锁定构图防止生图模型左右颠倒！`;
      regPosBtn.addEventListener("click", () => {
        let curCap = (item.caption || "").trim();
        if (curCap.toLowerCase().includes("left") || curCap.toLowerCase().includes("right") || curCap.toLowerCase().includes("center")) {
          statusEl.textContent = `该区域描述中已包含方位词。`;
          return;
        }
        item.caption = curCap ? `${posPhraseEn}, ${curCap}` : posPhraseEn;
        commitDraftToState(state, normalizeDraft(state.draft, w, h), w, h, true, `注入方位词 #${selectedRegion + 1}`);
        statusEl.textContent = `✅ 已为区域 #${selectedRegion + 1} 注入空间方位【${posText}】！`;
        syncCard();
      });

      const delBtn = el("button", "aps-btn aps-btn-xs aps-danger-text", "🗑 删除");
      delBtn.type = "button";
      delBtn.title = "删除该区域框";
      delBtn.addEventListener("click", () => {
        state.draft.items.splice(selectedRegion, 1);
        selectedRegion = Math.min(selectedRegion, state.draft.items.length - 1);
        commitDraftToState(state, normalizeDraft(state.draft, w, h), w, h, true, `删除区域框`);
        statusEl.textContent = "已删除区域框。";
      });

      const unselectBtn = el("button", "aps-btn aps-btn-xs", "✕ 取消选框");
      unselectBtn.type = "button";
      unselectBtn.title = "取消选框，主对话框恢复全局修改模式";
      unselectBtn.addEventListener("click", () => {
        selectedRegion = -1;
        syncCard();
      });

      row1.append(badge, labelSel, nameInput, boundsBadge, regPosBtn, delBtn, unselectBtn);

      // Row 2: Direct Manual Caption & Literal Text input
      const row2 = el("div", "aps-region-inspect-row");
      const capInput = el("input", "aps-input aps-input-sm aps-region-cap-input");
      capInput.type = "text";
      capInput.placeholder = "此区域的画面细节描述（可直接手改，或在右侧主对话框发送指令让 AI 修改此框）…";
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

      regionInspector.append(row1, row2);
    } else {
      regionInspector.classList.remove("is-open");
      regionInspector.textContent = "";
    }

    syncChatTargetBar(items);
    applyStageGeometry();

    // Image recovery and upstream synchronization
    hookUpstreamImageNode(node);
    const upNode = findUpstreamImageSourceNode(node);
    const upFile = upstreamImageFile(node);
    const directUrl = getSourceNodeImageUrl(upNode);
    const savedFile = state.last_image_file || null;
    const isImagined = state.source === "imagine";
    // 解除底图后即使上游还挂着同一张旧图，也不再自动回填：用户要的就是纯文本编辑。
    // 但上游换成了一张新图时，那确实是新底图，解除标记自动作废。
    const detachedFrom = String(state.detached_from_file || "");
    const upstreamIsNewImage = Boolean(upFile && (!detachedFrom || upFile !== detachedFrom));
    const isDetached = state.image_detached === true && !upstreamIsNewImage;

    let targetFile = null;
    if (!isImagined && !isDetached) {
      const isUpDefault = !upFile || upFile === "example.png" || upFile.includes("example");
      if (upFile && !isUpDefault) {
        targetFile = upFile;
      } else if (savedFile) {
        targetFile = savedFile;
      } else if (upFile) {
        targetFile = upFile;
      }
    }

    if (!node._apsImageDataUrl && !isImagined && !isDetached) {
      if (node.id) {
        const cached = getSessionImage(node.id);
        if (cached) node._apsImageDataUrl = cached;
      }
    }

    const needFetch = Boolean(
      !isImagined &&
      !isDetached &&
      (targetFile || directUrl) &&
      (!node._apsImageDataUrl || (targetFile && targetFile !== node._apsLastUpstreamFile)) &&
      node._apsFetchingFile !== (targetFile || directUrl)
    );

    if (needFetch) {
      const fetchKey = targetFile || directUrl;
      node._apsFetchingFile = fetchKey;
      void (async () => {
        try {
          if (directUrl && directUrl.startsWith("data:")) {
            node._apsImageDataUrl = directUrl;
            if (targetFile) node._apsLastUpstreamFile = targetFile;
            node._apsFetchingFile = null;
            if (node.id) saveSessionImage(node.id, directUrl);
            node._apsSyncCard?.();
            return;
          }
          const fetchUrl = directUrl || buildComfyViewUrl(targetFile);
          if (fetchUrl) {
            const resp = await fetch(fetchUrl, { credentials: "same-origin" });
            if (resp.ok) {
              const blob = await resp.blob();
              node._apsImageDataUrl = await blobToDataUrl(blob);
              if (targetFile) node._apsLastUpstreamFile = targetFile;
              node._apsFetchingFile = null;
              if (node.id) saveSessionImage(node.id, node._apsImageDataUrl);

              const curState = readPayload(node);
              if (curState && targetFile && curState.last_image_file !== targetFile) {
                curState.last_image_file = targetFile;
                delete curState.source;
                delete curState.image_detached;
                delete curState.detached_from_file;
                setPayload(node, curState);
              } else {
                node._apsSyncCard?.();
              }
            } else {
              node._apsFetchingFile = null;
            }
          } else {
            node._apsFetchingFile = null;
          }
        } catch (e) {
          node._apsFetchingFile = null;
          console.warn("恢复底图图片失败:", e);
        }
      })();
    }

    renderSvgStage(stageSvg, {
      width: w,
      height: h,
      draft: state.draft,
      imageUrl: isImagined || isDetached ? null : (node._apsImageDataUrl || null),
      selected: selectedRegion,
      showBoxes,
      dimImage: dimStageImage,
    });
    fillRulesConfig(node._apsActiveConfig);
    renderChatLog();
    if (typeof updatePromptStats === "function") updatePromptStats();
    if (!imaginePanel.hidden) updateImagineModesNote();
  }

  node._apsSyncCard = syncCard;
  node._apsSetBusy = (isBusy, actionLabel = "", isStageScan = false, actionTooltip = "") => {
    nodeBusy = Boolean(isBusy);
    btnReverse.disabled = nodeBusy;
    if (typeof btnImportComplete !== "undefined") btnImportComplete.disabled = nodeBusy;
    chatSend.disabled = nodeBusy;
    chatStop.hidden = !inlineEditController;
    chatStop.disabled = !inlineEditController;
    chatNewBtn.disabled = nodeBusy;
    chatClearBtn.disabled = nodeBusy;
    imagineGo.disabled = nodeBusy;
    imagineResults.querySelectorAll("button").forEach((b) => { b.disabled = nodeBusy; });
    card.classList.toggle("is-busy", nodeBusy);
    stageScanOverlay.hidden = !(nodeBusy && isStageScan);
    if (nodeBusyTimer) {
      clearInterval(nodeBusyTimer);
      nodeBusyTimer = null;
    }
    if (nodeBusy) {
      nodeBusyStartMs = Date.now();
      const rawAction = String(actionLabel || statusLine.textContent || "AI 正在处理中…");
      nodeBusyLabel = excerpt(rawAction, 44);
      nodeBusyTooltip = String(actionTooltip || rawAction).replace(/\s+/g, " ").trim();
      renderNodeHudBanner();
      renderChatLog();
      if (typeof setInterval === "function") {
        nodeBusyTimer = setInterval(() => {
          if (!nodeBusy) return;
          renderNodeHudBanner();
        }, 500);
      }
    } else {
      nodeBusyLabel = "";
      nodeBusyTooltip = "";
      renderNodeHudBanner();
      renderChatLog();
    }
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
        if (statusLine.textContent.startsWith("就绪")) {
          statusLine.textContent = `就绪 · 模型: ${m} · 三模式独立规则已生效`;
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
  if (!NODE_TYPES.includes(node.comfyClass) && !NODE_TYPES.includes(node.type)) return;
  addButtons(node);
  hideRawWidgets(node);

  const originalExecuted = node.onExecuted;
  node.onExecuted = function (message) {
    const values = message?.aps_payload || message?.output?.aps_payload;
    const rawState = Array.isArray(values) ? values.at(-1) : null;
    if (rawState) {
      try {
        const cur = readPayload(node);
        const nextSt = JSON.parse(rawState);
        preserveChatThreads(nextSt, cur, { maxTurns: 20 });
        if (node._apsSessionId && !nextSt.session_id) {
          const { activeId } = ensureChatThreads(nextSt, { maxTurns: 20 });
          setThreadSessionId(nextSt, activeId, node._apsSessionId, { maxTurns: 20 });
        }
        setPayload(node, nextSt);
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
    // 加载旧工作流时立即把 payload 里的参考图 base64 迁到运行时缓存，
    // 避免它继续被自动草稿/保存写进 widgets_values。
    healLegacyWidgets(node);
    hideRawWidgets(node);
    node._apsOnResize?.();
    node._apsSyncCard?.();
    // 延迟多段重试同步，防止上游 LoadImage 节点或连接关系后于本节点反序列化完成
    let retryCount = 0;
    const retryTimer = setInterval(() => {
      retryCount++;
      node._apsSyncCard?.();
      if (node._apsImageDataUrl || retryCount >= 6) {
        clearInterval(retryTimer);
      }
    }, 300);
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
    if (!NODE_TYPES.includes(nodeData?.name)) return;
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

export const _test = {
  upstreamImageFile,
  findUpstreamImageSourceNode,
  getSourceNodeImageUrl,
  getSessionImage,
  saveSessionImage,
  readPayload,
  setPayload,
  currentMode,
  currentModes,
  cleanPureCaptionText,
  writePromptForMode,
  activePromptForMode,
  applyPresetToNode,
};
