/**
 * Frontend extension for AIPromptStudioLora graph node.
 *
 * Provides a dedicated in-node control card for LoRA stack preset selection,
 * real-time weight overview, trigger word copying, and access to the full
 * LoRA Preset Hub.
 */

import { app } from "../../scripts/app.js";
import { StudioApi } from "./lib/api.js";
import {
  openSaveLoraPresetModal,
  openLoraPresetLibraryModal,
  formatLoraStackSummary,
  buildLoraSyntaxString,
} from "./lib/lora_editor.js";

const NODE_TYPE = "AIPromptStudioLora";

function el(tag, cls = "", text = "") {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

export function setupLoraNode(node) {
  if (node._apsLoraInitialized) return;
  node._apsLoraInitialized = true;

  const api = new StudioApi();

  // Find standard widgets
  const getWidget = (name) => node.widgets?.find((w) => w.name === name);
  const presetWidget = getWidget("preset_name");
  const customJsonWidget = getWidget("custom_stack_json");
  const extraTwWidget = getWidget("extra_trigger_words");

  // Hide raw JSON widget to keep node clean
  if (customJsonWidget) {
    customJsonWidget.type = "hidden";
    customJsonWidget.hidden = true;
    customJsonWidget.computeSize = () => [0, -4];
  }

  // Create In-Node Card Container
  const card = el("div", "aps-lora-node-card notranslate");
  card.style.display = "flex";
  card.style.flexDirection = "column";
  card.style.gap = "8px";
  card.style.padding = "10px";
  card.style.background = "var(--aps-bg-surface, #1e1e24)";
  card.style.border = "1px solid var(--aps-border, #3a3a46)";
  card.style.borderRadius = "8px";
  card.style.fontSize = "12px";
  card.style.boxSizing = "border-box";
  card.style.width = "100%";

  // 1. Toolbar Row
  const toolRow = el("div", "aps-lora-card-tools");
  toolRow.style.display = "flex";
  toolRow.style.justifyContent = "space-between";
  toolRow.style.alignItems = "center";
  toolRow.style.gap = "6px";

  const brand = el("div");
  brand.style.display = "flex";
  brand.style.alignItems = "center";
  brand.style.gap = "4px";
  brand.style.fontWeight = "bold";
  brand.style.color = "var(--aps-text-primary, #eee)";
  brand.append(el("span", "", "🥞"), el("span", "", "LoRA 资产与堆叠"));

  const btnGroup = el("div");
  btnGroup.style.display = "flex";
  btnGroup.style.gap = "4px";

  const saveBtn = el("button", "aps-btn aps-btn-xs", "💾 存为预设");
  saveBtn.type = "button";
  saveBtn.title = "将当前节点的 LoRA 堆叠保存到预设库";

  const libBtn = el("button", "aps-btn aps-btn-xs aps-primary", "📚 LoRA 预设库");
  libBtn.type = "button";
  libBtn.title = "打开 LoRA 资产与堆叠预设库浏览器";

  btnGroup.append(saveBtn, libBtn);
  toolRow.append(brand, btnGroup);
  card.append(toolRow);

  // 2. Preset Info & Stack Overview
  const infoRow = el("div");
  infoRow.style.display = "flex";
  infoRow.style.justifyContent = "space-between";
  infoRow.style.alignItems = "center";
  infoRow.style.padding = "4px 8px";
  infoRow.style.background = "rgba(0, 0, 0, 0.25)";
  infoRow.style.borderRadius = "4px";

  const presetBadge = el("span", "aps-badge aps-badge-blue");
  presetBadge.textContent = presetWidget?.value || "默认堆叠";

  const countBadge = el("span", "aps-badge aps-badge-purple");
  countBadge.textContent = "0 个 LoRA";

  infoRow.append(presetBadge, countBadge);
  card.append(infoRow);

  // 3. Stack Details Box
  const stackBox = el("div");
  stackBox.style.display = "flex";
  stackBox.style.flexDirection = "column";
  stackBox.style.gap = "3px";
  stackBox.style.maxHeight = "120px";
  stackBox.style.overflowY = "auto";
  stackBox.style.padding = "4px 6px";
  stackBox.style.background = "rgba(0, 0, 0, 0.15)";
  stackBox.style.borderRadius = "4px";
  stackBox.style.fontSize = "11px";
  card.append(stackBox);

  // 4. Trigger Words Preview Box
  const twRow = el("div");
  twRow.style.display = "flex";
  twRow.style.flexDirection = "column";
  twRow.style.gap = "4px";

  const twHeader = el("div");
  twHeader.style.display = "flex";
  twHeader.style.justifyContent = "space-between";
  twHeader.style.alignItems = "center";

  const twLabel = el("span", "", "触发词预览：");
  twLabel.style.opacity = "0.75";
  twLabel.style.fontSize = "11px";

  const copyTwBtn = el("button", "aps-btn aps-btn-xs", "📋 复制");
  copyTwBtn.type = "button";
  copyTwBtn.style.padding = "1px 6px";

  twHeader.append(twLabel, copyTwBtn);

  const twSnippet = el("div");
  twSnippet.style.padding = "4px 6px";
  twSnippet.style.background = "rgba(0, 0, 0, 0.25)";
  twSnippet.style.borderRadius = "4px";
  twSnippet.style.fontSize = "11px";
  twSnippet.style.color = "#93c5fd";
  twSnippet.style.wordBreak = "break-all";
  twSnippet.textContent = "（暂无触发词）";

  twRow.append(twHeader, twSnippet);
  card.append(twRow);

  // 5. Status / Syntax line
  const syntaxLine = el("div");
  syntaxLine.style.fontSize = "11px";
  syntaxLine.style.opacity = "0.6";
  syntaxLine.style.overflow = "hidden";
  syntaxLine.style.textOverflow = "ellipsis";
  syntaxLine.style.whiteSpace = "nowrap";
  syntaxLine.textContent = "语法: <无 LoRA>";
  card.append(syntaxLine);

  let currentPresetData = null;

  async function refreshDisplay() {
    let presetName = presetWidget?.value || "";
    presetBadge.textContent = presetName || "未命名堆叠";

    // Try reading customJsonWidget
    let loras = [];
    let tw = "";
    if (customJsonWidget?.value) {
      try {
        const parsed = JSON.parse(customJsonWidget.value);
        if (Array.isArray(parsed)) {
          loras = parsed;
        } else if (parsed && typeof parsed === "object") {
          loras = parsed.loras || [];
          tw = parsed.trigger_words || "";
        }
      } catch {}
    }

    // Fallback: fetch preset info from API
    if (loras.length === 0 && presetName) {
      try {
        const listRes = await api.listLoraPresets();
        const found = listRes.presets?.find(
          (p) => p.name === presetName || p.id === presetName
        );
        if (found) {
          currentPresetData = found;
          loras = found.loras || [];
          tw = found.trigger_words || "";
        }
      } catch {}
    }

    countBadge.textContent = formatLoraStackSummary(loras);

    // Render stack list
    stackBox.innerHTML = "";
    if (loras.length === 0) {
      const emptySpan = el("div", "", "暂无加载中的 LoRA。");
      emptySpan.style.opacity = "0.5";
      stackBox.append(emptySpan);
    } else {
      loras.forEach((item) => {
        const itemRow = el("div");
        itemRow.style.display = "flex";
        itemRow.style.justifyContent = "space-between";
        itemRow.style.alignItems = "center";
        itemRow.style.opacity = item.enabled !== false ? "1" : "0.5";

        const nameSpan = el("span", "", `• ${item.name || "未命名"}`);
        nameSpan.style.overflow = "hidden";
        nameSpan.style.textOverflow = "ellipsis";
        nameSpan.style.whiteSpace = "nowrap";
        nameSpan.style.maxWidth = "160px";

        const wSpan = el("span", "", `M:${item.strength_model} C:${item.strength_clip}`);
        wSpan.style.opacity = "0.75";

        itemRow.append(nameSpan, wSpan);
        stackBox.append(itemRow);
      });
    }

    // Trigger words
    const fullTw = [tw, extraTwWidget?.value].filter(Boolean).join(", ");
    twSnippet.textContent = fullTw.trim() || "（暂无触发词）";

    // Syntax
    const syntax = buildLoraSyntaxString(loras);
    syntaxLine.textContent = syntax ? `语法: ${syntax}` : "语法: <无 LoRA>";

    node.setDirtyCanvas?.(true, true);
  }

  // Hook widget changes
  if (presetWidget) {
    const origCallback = presetWidget.callback;
    presetWidget.callback = function (...args) {
      const r = origCallback?.apply(this, args);
      // Reset custom JSON when switching preset dropdown manually
      if (customJsonWidget) customJsonWidget.value = "";
      refreshDisplay();
      return r;
    };
  }

  copyTwBtn.addEventListener("click", () => {
    const text = twSnippet.textContent;
    if (text && text !== "（暂无触发词）") {
      navigator.clipboard.writeText(text);
      copyTwBtn.textContent = "✓ 已复制";
      setTimeout(() => { copyTwBtn.textContent = "📋 复制"; }, 1500);
    }
  });

  saveBtn.addEventListener("click", () => {
    let loras = [];
    if (customJsonWidget?.value) {
      try {
        const p = JSON.parse(customJsonWidget.value);
        loras = Array.isArray(p) ? p : p.loras || [];
      } catch {}
    } else if (currentPresetData?.loras) {
      loras = currentPresetData.loras;
    }

    openSaveLoraPresetModal({
      api,
      preset: currentPresetData,
      initialLoras: loras,
      initialTriggerWords: twSnippet.textContent !== "（暂无触发词）" ? twSnippet.textContent : "",
      onSaved: (saved) => {
        currentPresetData = saved;
        if (presetWidget) {
          if (!presetWidget.options?.values?.includes(saved.name)) {
            presetWidget.options?.values?.push(saved.name);
          }
          presetWidget.value = saved.name;
        }
        if (customJsonWidget) {
          customJsonWidget.value = JSON.stringify(saved);
        }
        refreshDisplay();
      },
    });
  });

  libBtn.addEventListener("click", () => {
    openLoraPresetLibraryModal({
      api,
      onApply: (preset) => {
        currentPresetData = preset;
        if (presetWidget) {
          if (!presetWidget.options?.values?.includes(preset.name)) {
            presetWidget.options?.values?.push(preset.name);
          }
          presetWidget.value = preset.name;
        }
        if (customJsonWidget) {
          customJsonWidget.value = JSON.stringify(preset);
        }
        refreshDisplay();
      },
    });
  });

  // Attach card as DOM widget if supported
  if (typeof node.addDOMWidget === "function") {
    node.addDOMWidget("aps_lora_card", "custom", card, {
      serialize: false,
      hideOnZoom: false,
      getMinHeight: () => 220,
    });
  }

  // Initial refresh
  setTimeout(() => {
    refreshDisplay();
  }, 100);
}

const extension = {
  name: "AIPromptStudio.LoraNode",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_TYPE) return;
    const origCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const r = origCreated?.apply(this, args);
      setupLoraNode(this);
      return r;
    };
  },
  async nodeCreated(node) {
    if (node.comfyClass === NODE_TYPE || node.type === NODE_TYPE) {
      setupLoraNode(node);
    }
  },
};

app.registerExtension(extension);

export const _test = {
  setupLoraNode,
};
