/**
 * Frontend extension for AIPromptStudioLora graph node.
 *
 * Modern, clean, and fully interactive in-node LoRA Stacker & Preset Manager.
 * Inspired by ComfyUI-Lora-Manager and Prompt-Gallery:
 * - Hides cluttering stock ComfyUI widgets.
 * - In-node interactive LoRA stack rows with on/off switch, Model/Clip strength steppers,
 *   single-LoRA trigger word copying, reordering, and deletion.
 * - Fast local LoRA search/select dropdown with auto trigger word detection.
 * - 1-click Preset saving, preset dropdown switching, and rich Preset Hub drawer.
 * - Real-time aggregated trigger words & <lora:...> syntax copying.
 */

import { app } from "../../scripts/app.js";
import { StudioApi } from "./lib/api.js?v=20261119_v49";
import {
  openSaveLoraPresetModal,
  openLoraPresetLibraryModal,
  openLoraPresetLightbox,
  buildLoraSyntaxString,
} from "./lib/lora_editor.js?v=20261119_v49";

const NODE_TYPE = "AIPromptStudioLora";
const STYLE_VERSION = "20261119_v49";

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
}

function parseRgbLuminance(colorStr) {
  if (!colorStr) return null;
  const m = String(colorStr).match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (m) {
    const [, r, g, b] = m.map(Number);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
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

function getNodeSize(node) {
  if (Array.isArray(node?.size) && node.size.length >= 2) {
    return [Math.max(10, Number(node.size[0]) || 0), Math.max(10, Number(node.size[1]) || 0)];
  }
  return [410, 490];
}

function hideRawWidgets(node) {
  if (!node || !node.widgets) return;
  const isBrowser = typeof document !== "undefined";
  for (const w of node.widgets) {
    if (!w || w.name === "aps_lora_card") continue;
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
      if (w.element.parentElement && w.element.parentElement !== node) {
        w.element.parentElement.style.display = "none";
      }
    }
  }
}

const MIN_CARD_HEIGHT = 340;

/**
 * The card fills whatever box ComfyUI lays out for the DOM widget.
 *
 * Previously the height came from `domWidget.y`, which in the current frontend
 * is a canvas-space offset (title bar + hidden widgets included). As the node
 * grew, `nodeH - widgetY` went negative and was clamped to the 340px floor, so
 * the card could never follow the node. Measuring the wrapper and feeding that
 * back into `computedHeight` is worse still: each pass re-adds the offset and
 * the box creeps.
 *
 * So: the wrapper is stretched to 100%, the card is 100% of the wrapper, and the
 * stack list owns the remaining space with its own scrollbar. Node resizes then
 * propagate purely through CSS with no JS measurement in the loop.
 */
function nodeDerivedHeight(node, domWidget) {
  const [, nodeH] = getNodeSize(node);
  const offset = Number(domWidget?.y ?? domWidget?.last_y ?? 0);
  const safeOffset = Number.isFinite(offset) && offset >= 0 && offset < nodeH ? offset : 0;
  return Math.max(MIN_CARD_HEIGHT, Math.round(nodeH - safeOffset - 12));
}

function applyCardGeometry(node, card, domWidget) {
  // Let the card fill the widget box via CSS height:100%.
  card.style.removeProperty("height");
  card.style.setProperty("min-height", `${MIN_CARD_HEIGHT}px`, "important");
  card.style.setProperty("height", "100%", "important");

  const wrapper = card.parentElement;
  const measured = wrapper?.clientHeight || 0;
  if (measured < MIN_CARD_HEIGHT) {
    // Layout not settled yet (or ComfyUI gave us a collapsed box): give the
    // widget an explicit floor derived from node size instead of the wrapper.
    const fallback = nodeDerivedHeight(node, domWidget);
    if (domWidget && domWidget.computedHeight !== fallback) {
      domWidget.computedHeight = fallback;
    }
  }

  // Grow to fill whatever vertical space the node offers.
  domWidget.computeLayoutSize = () => ({
    minHeight: MIN_CARD_HEIGHT,
    maxHeight: undefined,
    minWidth: 0,
  });
}

function ensureParentOverflowVisible(card) {
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
        // Filling the wrapper is what lets the card track node resizes.
        p.style.height = "100%";
        p.style.minHeight = "0";
      }
    }
    p = p.parentElement;
    depth++;
  }
}

function el(tag, cls = "", text = "") {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

let activeTooltip = null;
let hoverTimer = null;

function hideLoraPreviewTooltip() {
  if (hoverTimer) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  if (activeTooltip) {
    const elToDel = activeTooltip;
    elToDel.style.opacity = "0";
    elToDel.style.transform = "scale(0.96) translateY(4px)";
    setTimeout(() => {
      elToDel.remove();
    }, 140);
    activeTooltip = null;
  }
}

function showLoraPreviewTooltip(targetEl, info) {
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    if (!targetEl || !document.body.contains(targetEl)) return;
    hideLoraPreviewTooltip();

    const tooltip = el("div", "aps-lora-hover-preview-tooltip notranslate");
    tooltip.dataset.theme = detectIsLightTheme() ? "light" : "dark";

    const rect = targetEl.getBoundingClientRect();
    const previewUrl = info.preview_url;

    // 1. Cover Image
    if (previewUrl) {
      const imgWrap = el("div", "aps-lora-preview-img-wrap");
      const img = el("img", "aps-lora-preview-img");
      img.src = previewUrl;
      img.alt = info.name || "";
      img.onerror = () => {
        imgWrap.innerHTML = `<div class="aps-lora-preview-placeholder"><span style="font-size: 32px;">🥞</span><span style="font-size: 11px; opacity: 0.6; margin-top: 4px;">暂无本地封面</span></div>`;
      };
      imgWrap.append(img);
      tooltip.append(imgWrap);
    } else {
      const placeholder = el("div", "aps-lora-preview-placeholder");
      placeholder.innerHTML = `<span style="font-size: 32px;">🥞</span><span style="font-size: 11px; opacity: 0.6; margin-top: 4px;">暂无本地封面</span>`;
      tooltip.append(placeholder);
    }

    // 2. Info Content
    const content = el("div", "aps-lora-preview-content");
    const nameEl = el("div", "aps-lora-preview-title", info.name || "未命名");
    content.append(nameEl);

    if (info.trigger_words && info.trigger_words.trim()) {
      const twBox = el("div", "aps-lora-preview-tw-box");
      const twLabel = el("div", "aps-lora-preview-tw-label", "💬 触发词 (点击复制):");
      const twText = el("div", "aps-lora-preview-tw-text", info.trigger_words);
      twBox.append(twLabel, twText);
      twBox.addEventListener("click", () => {
        navigator.clipboard.writeText(info.trigger_words);
        twLabel.textContent = "✓ 已复制到剪贴板！";
        setTimeout(() => { twLabel.textContent = "💬 触发词 (点击复制):"; }, 1500);
      });
      content.append(twBox);
    }

    tooltip.append(content);
    document.body.append(tooltip);
    activeTooltip = tooltip;

    // Positioning
    const tooltipRect = tooltip.getBoundingClientRect();
    let left = rect.right + 12;
    if (left + tooltipRect.width > window.innerWidth - 10) {
      left = Math.max(10, rect.left - tooltipRect.width - 12);
    }
    let top = rect.top;
    if (top + tooltipRect.height > window.innerHeight - 10) {
      top = Math.max(10, window.innerHeight - tooltipRect.height - 10);
    }

    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(top)}px`;

    // Trigger transition
    requestAnimationFrame(() => {
      tooltip.style.opacity = "1";
      tooltip.style.transform = "scale(1) translateY(0)";
    });
  }, 90);
}

function showLoraPresetPreviewTooltip(targetEl, preset, api) {
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    if (!targetEl || !document.body.contains(targetEl) || !preset) return;
    hideLoraPreviewTooltip();

    const tooltip = el("div", "aps-lora-hover-preview-tooltip notranslate");
    tooltip.dataset.theme = detectIsLightTheme() ? "light" : "dark";
    tooltip.style.width = "290px";

    const rect = targetEl.getBoundingClientRect();
    const loras = Array.isArray(preset.loras) ? preset.loras : [];

    let coverUrl = preset.thumbnail || (preset.has_image ? api.loraPresetImageUrl(preset.id) : "");
    if (!coverUrl && loras.length > 0) {
      const firstWithPreview = loras.find((l) => l.name);
      if (firstWithPreview && typeof api?.loraPreviewImageUrl === "function") {
        coverUrl = api.loraPreviewImageUrl(firstWithPreview.name);
      }
    }

    // 1. Cover Image
    if (coverUrl) {
      const imgWrap = el("div", "aps-lora-preview-img-wrap");
      imgWrap.style.maxHeight = "180px";
      const img = el("img", "aps-lora-preview-img");
      img.src = coverUrl;
      img.alt = preset.name || "";
      img.onerror = () => {
        imgWrap.innerHTML = `<div class="aps-lora-preview-placeholder"><span style="font-size: 32px;">🥞</span><span style="font-size: 11px; opacity: 0.6; margin-top: 4px;">暂无效果图</span></div>`;
      };
      imgWrap.append(img);
      tooltip.append(imgWrap);
    } else {
      const placeholder = el("div", "aps-lora-preview-placeholder");
      placeholder.innerHTML = `<span style="font-size: 32px;">🥞</span><span style="font-size: 11px; opacity: 0.6; margin-top: 4px;">暂无预设效果图</span>`;
      tooltip.append(placeholder);
    }

    // 2. Info Content
    const content = el("div", "aps-lora-preview-content");
    const titleRow = el("div");
    titleRow.style.display = "flex";
    titleRow.style.justifyContent = "space-between";
    titleRow.style.alignItems = "center";
    titleRow.append(
      el("div", "aps-lora-preview-title", preset.name || "未命名预设"),
      el("span", "aps-badge aps-badge-blue", preset.category || "通用")
    );
    content.append(titleRow);

    // LoRA stack list summary
    if (loras.length > 0) {
      const listWrap = el("div");
      listWrap.style.fontSize = "11px";
      listWrap.style.color = "var(--aps-muted, #aaa)";
      listWrap.style.display = "flex";
      listWrap.style.flexDirection = "column";
      listWrap.style.gap = "2px";
      listWrap.style.marginTop = "4px";
      loras.slice(0, 3).forEach((item) => {
        listWrap.append(el("div", "", `• ${item.name} (M:${item.strength_model})`));
      });
      if (loras.length > 3) {
        listWrap.append(el("div", "", `…还有 ${loras.length - 3} 个 LoRA`));
      }
      content.append(listWrap);
    }

    if (preset.trigger_words && preset.trigger_words.trim()) {
      const twBox = el("div", "aps-lora-preview-tw-box");
      twBox.style.marginTop = "4px";
      const twLabel = el("div", "aps-lora-preview-tw-label", "💬 预设搭配触发词 (点击复制):");
      const twText = el("div", "aps-lora-preview-tw-text", preset.trigger_words);
      twBox.append(twLabel, twText);
      twBox.addEventListener("click", () => {
        navigator.clipboard.writeText(preset.trigger_words);
        twLabel.textContent = "✓ 已复制到剪贴板！";
        setTimeout(() => { twLabel.textContent = "💬 预设搭配触发词 (点击复制):"; }, 1500);
      });
      content.append(twBox);
    }

    tooltip.append(content);
    document.body.append(tooltip);
    activeTooltip = tooltip;

    // Positioning
    const tooltipRect = tooltip.getBoundingClientRect();
    let left = rect.right + 12;
    if (left + tooltipRect.width > window.innerWidth - 10) {
      left = Math.max(10, rect.left - tooltipRect.width - 12);
    }
    let top = rect.top;
    if (top + tooltipRect.height > window.innerHeight - 10) {
      top = Math.max(10, window.innerHeight - tooltipRect.height - 10);
    }

    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(top)}px`;

    requestAnimationFrame(() => {
      tooltip.style.opacity = "1";
      tooltip.style.transform = "scale(1) translateY(0)";
    });
  }, 100);
}

export function setupLoraNode(node) {
  if (node._apsLoraInitialized) return;
  node._apsLoraInitialized = true;

  mountStyles();

  const api = new StudioApi();

  // Find standard widgets
  const getWidget = (name) => node.widgets?.find((w) => w.name === name);
  const presetWidget = getWidget("preset_name");
  const modelScaleWidget = getWidget("model_strength_scale");
  const clipScaleWidget = getWidget("clip_strength_scale");
  const extraTwWidget = getWidget("extra_trigger_words");
  const customJsonWidget = getWidget("custom_stack_json");

  // Hide raw/cluttering widgets immediately
  hideRawWidgets(node);

  // Adjust node dimensions
  const [currentW, currentH] = getNodeSize(node);
  if (currentW < 410 || currentH < 490) {
    node.setSize([Math.max(currentW, 410), Math.max(currentH, 490)]);
  }

  // State
  let currentStack = []; // array of { id, name, strength_model, strength_clip, enabled, trigger_words, linked }
  let availableLoras = []; // array of filenames
  let loraDetails = {}; // map of { [name]: { trigger_words: string, has_preview: bool, preview_url: string } }
  let presetsList = []; // array of preset objects from database
  let currentPresetData = null;
  let showExtraInput = false;

  // Root Card Element with full Prompt Studio theme support
  const card = el("div", "aps-node-card aps-lora-node-card notranslate");
  card.dataset.theme = detectIsLightTheme(card) ? "light" : "dark";

  // Prevent canvas dragging / zooming when interacting inside card
  card.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
  card.addEventListener("pointerdown", (e) => e.stopPropagation());
  card.addEventListener("mousedown", (e) => e.stopPropagation());

  // ---------------------------------------------------------------------------
  // 1. Top Bar: Clean Brand Title & Preset Hub Actions (No clutter)
  // ---------------------------------------------------------------------------
  const topBar = el("div", "aps-lora-top-bar");
  const brand = el("div", "aps-lora-brand");
  brand.append(el("span", "", "🥞"), el("span", "", "LoRA 预设与多重堆叠"));

  const topActions = el("div", "aps-lora-actions");
  const saveBtn = el("button", "aps-btn aps-btn-xs aps-primary", "💾 存为预设");
  saveBtn.type = "button";
  saveBtn.title = "将当前堆叠保存为新预设或覆盖现有预设";

  const libBtn = el("button", "aps-btn aps-btn-xs", "📚 预设库");
  libBtn.type = "button";
  libBtn.title = "打开 LoRA 资产与堆叠预设库浏览器（支持分类、封面、图片拖拽识图导入）";

  const clearBtn = el("button", "aps-btn aps-btn-xs", "🗑️");
  clearBtn.type = "button";
  clearBtn.title = "清空当前堆叠";

  topActions.append(saveBtn, libBtn, clearBtn);
  topBar.append(brand, topActions);
  card.append(topBar);

  // ---------------------------------------------------------------------------
  // 2. Preset Row: Clean Dropdown to Switch Saved Presets + Cover Thumbnail
  // ---------------------------------------------------------------------------
  const presetBar = el("div", "aps-lora-preset-bar");
  const presetThumbBadge = el("div", "aps-lora-preset-thumb");
  presetThumbBadge.title = "点击查看预设效果大图；悬停预览生成效果与触发词";
  presetThumbBadge.innerHTML = "<span>🥞</span>";

  const presetLabel = el("span", "aps-lora-preset-label", "预设:");
  const presetSelect = el("select", "aps-lora-preset-select");
  presetSelect.title = "切换已保存的 LoRA 预设组合";

  presetBar.append(presetThumbBadge, presetLabel, presetSelect);
  card.append(presetBar);

  // Hover & Click on presetBar / thumbBadge
  presetThumbBadge.addEventListener("pointerenter", () => {
    if (currentPresetData) {
      showLoraPresetPreviewTooltip(presetBar, currentPresetData, api);
    }
  });
  presetThumbBadge.addEventListener("pointerleave", () => hideLoraPreviewTooltip());

  presetThumbBadge.addEventListener("click", () => {
    if (currentPresetData) {
      openLoraPresetLightbox(currentPresetData, {
        api,
        onApply: (p) => {
          applyPresetObject(p);
        },
      });
    }
  });

  // ---------------------------------------------------------------------------
  // 3. Quick Add Row: Pick local LoRA to add immediately
  // ---------------------------------------------------------------------------
  const addBar = el("div", "aps-lora-add-bar");
  const addSelect = el("select", "aps-lora-add-select");
  addSelect.title = "选择本地已安装的 LoRA 模型";

  const addBtn = el("button", "aps-btn aps-btn-xs aps-primary aps-lora-add-btn", "➕ 添加");
  addBtn.type = "button";
  addBtn.title = "将所选 LoRA 添加到当前堆叠列表";

  addBar.append(addSelect, addBtn);
  card.append(addBar);

  // ---------------------------------------------------------------------------
  // 4. Interactive LoRA Stack Box: Scrollable rows with switches, weights, deletes
  // ---------------------------------------------------------------------------
  const stackBox = el("div", "aps-lora-stack-box");
  card.append(stackBox);

  // ---------------------------------------------------------------------------
  // 5. Footer Bar: Aggregated Trigger Words, Copy & Syntax
  // ---------------------------------------------------------------------------
  const footerBar = el("div", "aps-lora-footer-bar");

  // Summary row
  const twBox = el("div", "aps-lora-footer-tw-box");
  const twLabel = el("span", "aps-lora-footer-tw-label", "💬 触发词:");
  const twPreview = el("span", "aps-lora-footer-tw-preview", "（暂无触发词）");
  twBox.append(twLabel, twPreview);

  // Extra input (foldable)
  const extraRow = el("div");
  extraRow.style.display = "none";
  const extraInput = el("input", "aps-lora-extra-input");
  extraInput.placeholder = "可选：输入追加的提示词...";
  extraInput.value = extraTwWidget?.value || "";
  extraRow.append(extraInput);

  // Button row
  const footerBtns = el("div", "aps-lora-footer-btns");
  const copyTwBtn = el("button", "aps-btn aps-btn-xs", "📋 复制触发词");
  copyTwBtn.type = "button";

  const copySyntaxBtn = el("button", "aps-btn aps-btn-xs", "📋 复制语法");
  copySyntaxBtn.type = "button";

  const toggleExtraBtn = el("button", "aps-btn aps-btn-xs", "➕ 附加词");
  toggleExtraBtn.type = "button";
  toggleExtraBtn.title = "展开/折叠附加触发词输入框";

  footerBtns.append(copyTwBtn, copySyntaxBtn, toggleExtraBtn);
  footerBar.append(twBox, extraRow, footerBtns);
  card.append(footerBar);

  // ---------------------------------------------------------------------------
  // LoRA name resolution helpers
  // ---------------------------------------------------------------------------
  /** Undo escaped-CJK names like "Moss-nai5-/u5176/u4e09" -> "Moss-nai5-其三". */
  function repairLoraName(name) {
    const raw = String(name || "").trim();
    if (!raw) return "";
    if (!/[/\\]u[0-9a-fA-F]{4}/.test(raw)) return raw.replace(/\\/g, "/");
    const repaired = raw.replace(/(?:[/\\]u[0-9a-fA-F]{4})+/g, (run) => {
      const hexes = run.match(/[0-9a-fA-F]{4}/g) || [];
      try {
        return hexes.map((h) => String.fromCharCode(parseInt(h, 16))).join("");
      } catch {
        return run;
      }
    });
    return repaired.replace(/\\/g, "/");
  }

  /** Stem (filename without folder / extension) — used to bridge short names. */
  function loraStem(name) {
    const raw = String(name || "").replace(/\\/g, "/");
    const file = raw.split("/").pop() || "";
    return file.replace(/\.(safetensors|ckpt|pt|bin)$/i, "");
  }

  /** Find LoRA metadata entry for a stored preset item (bare name or rel path). */
  function resolveLoraDetails(name) {
    const repaired = repairLoraName(name);
    if (!repaired) return null;
    if (loraDetails[repaired]) return loraDetails[repaired];

    const stem = loraStem(repaired).toLowerCase();
    if (!stem) return null;
    if (loraDetails[stem]) return loraDetails[stem];

    for (const key of Object.keys(loraDetails)) {
      if (loraStem(key).toLowerCase() === stem) return loraDetails[key];
    }
    return null;
  }

  /** Canonical relative path for a stored LoRA name (so ComfyUI can load it). */
  function resolveLoraPath(name) {
    const repaired = repairLoraName(name);
    const found = resolveLoraDetails(repaired);
    return found?.rel_path || found?.name || repaired;
  }
  // ---------------------------------------------------------------------------
  // Core Synchronization Logic
  // ---------------------------------------------------------------------------
  function getItemTriggerWords(item) {
    if (!item) return "";
    const own = String(item.trigger_words || "").trim();
    if (own) return own;
    return String(resolveLoraDetails(item.name)?.trigger_words || "").trim();
  }

  function getActiveTriggerWords() {
    const list = [];
    for (const item of currentStack) {
      if (item && item.enabled !== false) {
        const tw = getItemTriggerWords(item);
        if (tw) list.push(tw);
      }
    }
    const extra = extraInput.value.trim();
    if (extra) list.push(extra);
    return list.filter(Boolean).join(", ");
  }

  function syncStateToNode() {
    const activeTw = getActiveTriggerWords();
    twPreview.textContent = activeTw || "（暂无触发词）";
    twPreview.title = activeTw;

    const payload = {
      loras: currentStack.map((item) => ({
        name: resolveLoraPath(item.name),
        display_name: item.name,
        strength_model: Number(Number(item.strength_model ?? 1.0).toFixed(3)),
        strength_clip: Number(Number(item.strength_clip ?? 1.0).toFixed(3)),
        enabled: item.enabled !== false,
        trigger_words: getItemTriggerWords(item),
      })),
      trigger_words: activeTw,
    };

    if (customJsonWidget) {
      customJsonWidget.value = JSON.stringify(payload);
    }
    if (extraTwWidget) {
      extraTwWidget.value = extraInput.value.trim();
    }
    if (presetWidget && presetSelect.value) {
      presetWidget.value = presetSelect.value;
    }

    node.setDirtyCanvas?.(true, true);
  }

  function renderStackList() {
    stackBox.innerHTML = "";
    if (currentStack.length === 0) {
      const empty = el("div", "aps-lora-empty-state");
      empty.append(
        el("div", "", "🥞 暂无加载中的 LoRA"),
        el("div", "", "可在上方搜索选择本地 LoRA 添加，或切换已存预设")
      );
      stackBox.append(empty);
      syncStateToNode();
      return;
    }

    currentStack.forEach((item, index) => {
      const itemRow = el("div", `aps-lora-item ${item.enabled === false ? "is-disabled" : ""}`);

      // 1. Item Head: Toggle + Name + Tools (Reorder, Delete)
      const head = el("div", "aps-lora-item-head");
      const nameGroup = el("div", "aps-lora-item-name-group");

      const toggleBtn = el(
        "button",
        `aps-lora-toggle-btn ${item.enabled === false ? "is-off" : ""}`,
        item.enabled === false ? "OFF" : "ON"
      );
      toggleBtn.type = "button";
      toggleBtn.title = item.enabled === false ? "点击启用该 LoRA" : "点击禁用（静音）该 LoRA";
      toggleBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        item.enabled = item.enabled === false ? true : false;
        renderStackList();
      });

      // Thumbnail Badge
      const details = resolveLoraDetails(item.name) || {};
      const previewUrl = details.preview_url || "";
      const itemTw = getItemTriggerWords(item);
      const thumbBadge = el("div", "aps-lora-item-thumb");
      thumbBadge.title = "点击或悬停预览此 LoRA 封面与触发词";
      if (previewUrl) {
        const img = el("img");
        img.src = previewUrl;
        img.alt = item.name;
        img.onerror = () => { thumbBadge.textContent = "🥞"; };
        thumbBadge.append(img);
      } else {
        thumbBadge.textContent = "🥞";
      }

      const nameSpan = el("span", "aps-lora-item-name", item.display_name || item.name || "未命名 LoRA");
      // Files that left the disk must be obvious, not silently skipped on run.
      const isMissing = !resolveLoraDetails(item.name);
      if (isMissing) {
        nameSpan.classList.add("is-missing");
        nameSpan.textContent = `⚠ ${item.display_name || item.name}`;
      }
      nameSpan.title = isMissing
        ? `本地找不到此 LoRA 文件，执行时会被跳过：\n${item.name}`
        : (item.display_name && item.display_name !== item.name
            ? `${item.display_name}\n→ ${item.name}`
            : item.name);
      nameGroup.append(toggleBtn, thumbBadge, nameSpan);

      // Bind Hover preview
      const previewInfo = {
        name: item.name,
        preview_url: previewUrl,
        trigger_words: itemTw,
        strength_model: item.strength_model,
        strength_clip: item.strength_clip,
      };

      itemRow.addEventListener("pointerenter", () => showLoraPreviewTooltip(itemRow, previewInfo));
      itemRow.addEventListener("pointerleave", () => hideLoraPreviewTooltip());

      const tools = el("div", "aps-lora-item-tools");

      // Up button
      if (index > 0) {
        const upBtn = el("button", "aps-lora-icon-btn", "▲");
        upBtn.type = "button";
        upBtn.title = "上移一层";
        upBtn.addEventListener("click", () => {
          const temp = currentStack[index - 1];
          currentStack[index - 1] = currentStack[index];
          currentStack[index] = temp;
          renderStackList();
        });
        tools.append(upBtn);
      }

      // Down button
      if (index < currentStack.length - 1) {
        const downBtn = el("button", "aps-lora-icon-btn", "▼");
        downBtn.type = "button";
        downBtn.title = "下移一层";
        downBtn.addEventListener("click", () => {
          const temp = currentStack[index + 1];
          currentStack[index + 1] = currentStack[index];
          currentStack[index] = temp;
          renderStackList();
        });
        tools.append(downBtn);
      }

      // Delete button
      const delBtn = el("button", "aps-lora-icon-btn is-delete", "✕");
      delBtn.type = "button";
      delBtn.title = "移除该 LoRA";
      delBtn.addEventListener("click", () => {
        currentStack.splice(index, 1);
        renderStackList();
      });
      tools.append(delBtn);

      head.append(nameGroup, tools);
      itemRow.append(head);

      // 2. Weights Row: Model Strength, Link Button, Clip Strength
      const weightsRow = el("div", "aps-lora-item-weights");

      // Model Stepper
      const mStepper = el("div", "aps-weight-stepper");
      const mMinus = el("button", "", "-");
      mMinus.type = "button";
      const mInput = el("input");
      mInput.type = "number";
      mInput.step = "0.05";
      mInput.value = Number(item.strength_model ?? 1.0).toFixed(2);
      const mPlus = el("button", "", "+");
      mPlus.type = "button";

      mStepper.append(mMinus, mInput, mPlus);

      // Link button (Model & Clip lock)
      const isLinked = item.linked !== false;
      const linkBtn = el("button", `aps-link-btn ${isLinked ? "" : "is-unlinked"}`, isLinked ? "🔗" : "⛓️");
      linkBtn.type = "button";
      linkBtn.title = isLinked ? "权重联动已开启（点击解绑）" : "权重联动已解除（点击锁定联动）";

      // Clip Stepper
      const cStepper = el("div", "aps-weight-stepper");
      const cMinus = el("button", "", "-");
      cMinus.type = "button";
      const cInput = el("input");
      cInput.type = "number";
      cInput.step = "0.05";
      cInput.value = Number(item.strength_clip ?? item.strength_model ?? 1.0).toFixed(2);
      const cPlus = el("button", "", "+");
      cPlus.type = "button";

      cStepper.append(cMinus, cInput, cPlus);

      // Stepper change handlers
      const updateM = (val) => {
        const rounded = Number(val.toFixed(2));
        item.strength_model = rounded;
        mInput.value = rounded.toFixed(2);
        if (item.linked !== false) {
          item.strength_clip = rounded;
          cInput.value = rounded.toFixed(2);
        }
        syncStateToNode();
      };

      const updateC = (val) => {
        const rounded = Number(val.toFixed(2));
        item.strength_clip = rounded;
        cInput.value = rounded.toFixed(2);
        syncStateToNode();
      };

      mMinus.addEventListener("click", () => updateM((Number(mInput.value) || 1.0) - 0.05));
      mPlus.addEventListener("click", () => updateM((Number(mInput.value) || 1.0) + 0.05));
      mInput.addEventListener("change", () => updateM(Number(mInput.value) || 1.0));

      cMinus.addEventListener("click", () => updateC((Number(cInput.value) || 1.0) - 0.05));
      cPlus.addEventListener("click", () => updateC((Number(cInput.value) || 1.0) + 0.05));
      cInput.addEventListener("change", () => updateC(Number(cInput.value) || 1.0));

      linkBtn.addEventListener("click", () => {
        item.linked = item.linked === false ? true : false;
        if (item.linked) {
          updateM(Number(mInput.value) || 1.0);
        }
        renderStackList();
      });

      weightsRow.append(
        el("span", "", "M:"),
        mStepper,
        linkBtn,
        el("span", "", "C:"),
        cStepper
      );
      itemRow.append(weightsRow);

      // 3. Trigger words chip (if present)
      if (itemTw && itemTw.trim()) {
        const twRow = el("div", "aps-lora-item-tw");
        const twIcon = el("span", "", "🏷️");
        const twText = el("span", "aps-lora-item-tw-text", itemTw);
        twText.title = itemTw;

        const copyItemTw = el("button", "aps-lora-icon-btn", "📋");
        copyItemTw.type = "button";
        copyItemTw.title = "复制此 LoRA 的触发词";
        copyItemTw.addEventListener("click", () => {
          navigator.clipboard.writeText(itemTw);
          copyItemTw.textContent = "✓";
          setTimeout(() => { copyItemTw.textContent = "📋"; }, 1200);
        });

        twRow.append(twIcon, twText, copyItemTw);
        itemRow.append(twRow);
      }

      stackBox.append(itemRow);
    });

    syncStateToNode();
  }

  // ---------------------------------------------------------------------------
  // Load initial data (presets, local loras, stack) & Live Sync
  // ---------------------------------------------------------------------------
  async function refreshPresetsList(preferredName = null) {
    try {
      const presRes = await api.listLoraPresets();
      presetsList = Array.isArray(presRes?.presets) ? presRes.presets : [];
      updatePresetDropdown(preferredName);
      return presetsList;
    } catch (e) {
      console.warn("[AIPromptStudioLora] 获取 LoRA 预设库失败:", e);
      return [];
    }
  }

  async function initData() {
    // 1. Fetch Presets immediately & fetch local LoRAs in parallel
    await Promise.allSettled([
      refreshPresetsList(),
      (async () => {
        try {
          const res = await api.getAvailableLoras();
          availableLoras = res?.loras || [];
          loraDetails = res?.lora_details || {};

          addSelect.innerHTML = "";
          const defaultOpt = el("option", "", `+ 从本地添加 LoRA... (共 ${availableLoras.length} 个)`);
          defaultOpt.value = "";
          addSelect.append(defaultOpt);

          // Group local LoRAs by model family (MOSS / Anima / Krea2 ...)
          const groups = new Map();
          availableLoras.forEach((name) => {
            const type = loraDetails[name]?.model_type || "其他";
            if (!groups.has(type)) groups.set(type, []);
            groups.get(type).push(name);
          });
          const typeOrder = ["MOSS", "Anima", "Krea2", "MiniMax H3", "Flux", "Huge", "SD1.5", "SDXL", "Pony", "Illustrious", "NoobAI", "Qwen-Image", "Wan"];
          const sortedTypes = [...groups.keys()].sort((a, b) => {
            const ia = typeOrder.indexOf(a);
            const ib = typeOrder.indexOf(b);
            return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
          });
          sortedTypes.forEach((type) => {
            const names = groups.get(type).sort((a, b) => a.localeCompare(b));
            const group = document.createElement("optgroup");
            group.label = `🧠 ${type} (${names.length})`;
            names.forEach((name) => {
              const opt = el("option", "", name);
              opt.value = name;
              group.append(opt);
            });
            addSelect.append(group);
          });

          // Local LoRA details arrived after the first render: refresh covers/tw.
          if (currentStack.length > 0) {
            renderStackList();
            updatePresetThumbBadge();
          }
        } catch (e) {
          console.warn("[AIPromptStudioLora] 获取本地 LoRA 列表失败:", e);
        }
      })(),
    ]);

    // 2. Load initial stack from widgets or active preset
    loadStackFromWidgets();
  }

  function updatePresetDropdown(preferredName = null) {
    presetSelect.innerHTML = "";
    if (presetsList.length === 0) {
      const opt = el("option", "", "暂无保存的预设");
      opt.value = "";
      presetSelect.append(opt);
      currentPresetData = null;
      updatePresetThumbBadge();
      return;
    }

    presetsList.forEach((p) => {
      const mt = p.model_type && p.model_type !== "其他" ? ` · ${p.model_type}` : "";
      const opt = el("option", "", `${p.name} (${p.category || "通用"}${mt})`);
      opt.value = p.name;
      presetSelect.append(opt);
    });

    // Check if preferredName, presetWidget.value, or fallback to first preset matches
    const targetName = preferredName || presetWidget?.value || presetsList[0]?.name;
    let matched = presetsList.find((p) => p.name === targetName || p.id === targetName);
    if (!matched && presetsList.length > 0) {
      matched = presetsList[0];
    }

    if (matched) {
      presetSelect.value = matched.name;
      if (presetWidget) presetWidget.value = matched.name;
      currentPresetData = matched;
    } else {
      currentPresetData = null;
    }
    updatePresetThumbBadge();
  }

  function updatePresetThumbBadge() {
    presetThumbBadge.innerHTML = "";
    const activeName = presetSelect.value;
    const found = presetsList.find((p) => p.name === activeName);
    currentPresetData = found || null;

    let coverUrl = found?.thumbnail || (found?.has_image ? api.loraPresetImageUrl(found.id) : "");
    if (!coverUrl && found?.loras && found.loras.length > 0) {
      const firstL = found.loras.find((l) => l.name);
      if (firstL) {
        const d = resolveLoraDetails(firstL.name);
        if (d?.preview_url) coverUrl = d.preview_url;
      }
    }

    if (coverUrl) {
      const img = el("img");
      img.src = coverUrl;
      img.alt = activeName;
      img.onerror = () => { presetThumbBadge.innerHTML = "<span>🥞</span>"; };
      presetThumbBadge.append(img);
    } else {
      presetThumbBadge.innerHTML = "<span>🥞</span>";
    }
  }

  function applyPresetObject(preset) {
    if (!preset) return;
    currentPresetData = preset;

    // Ensure this preset is in presetsList
    const idx = presetsList.findIndex((p) => p.id === preset.id || p.name === preset.name);
    if (idx >= 0) {
      presetsList[idx] = preset;
    } else {
      presetsList.unshift(preset);
    }
    updatePresetDropdown(preset.name);

    if (presetWidget) presetWidget.value = preset.name;
    currentStack = (preset.loras || []).map((item) => ({
      name: repairLoraName(item.name),
      display_name: repairLoraName(item.display_name || item.name),
      strength_model: Number(item.strength_model ?? 1.0),
      strength_clip: Number(item.strength_clip ?? item.strength_model ?? 1.0),
      enabled: item.enabled !== false,
      trigger_words: item.trigger_words || resolveLoraDetails(item.name)?.trigger_words || "",
      linked: item.strength_model === item.strength_clip,
    }));
    updatePresetThumbBadge();
    renderStackList();
  }

  function loadStackFromWidgets() {
    let parsedStack = [];

    // Try custom_stack_json
    if (customJsonWidget?.value) {
      try {
        const raw = JSON.parse(customJsonWidget.value);
        if (Array.isArray(raw)) {
          parsedStack = raw;
        } else if (raw && Array.isArray(raw.loras)) {
          parsedStack = raw.loras;
        }
      } catch {}
    }

    // If custom stack has items, use them
    if (parsedStack.length > 0) {
      currentStack = parsedStack.map((item) => ({
        name: repairLoraName(item.name || "未命名"),
        display_name: repairLoraName(item.display_name || item.name || "未命名"),
        strength_model: Number(item.strength_model ?? 1.0),
        strength_clip: Number(item.strength_clip ?? item.strength_model ?? 1.0),
        enabled: item.enabled !== false,
        trigger_words: item.trigger_words || resolveLoraDetails(item.name)?.trigger_words || "",
        linked: item.strength_model === item.strength_clip,
      }));
      renderStackList();
      return;
    }

    // Otherwise load from active preset or first available preset
    const targetPresetName = presetWidget?.value || (presetsList[0]?.name);
    let found = presetsList.find((p) => p.name === targetPresetName || p.id === targetPresetName);
    if (!found && presetsList.length > 0) {
      found = presetsList[0];
    }
    if (found) {
      applyPresetObject(found);
      return;
    }

    // Empty fallback
    currentStack = [];
    renderStackList();
  }

  // ---------------------------------------------------------------------------
  // Event Listeners
  // ---------------------------------------------------------------------------
  // 1. Preset Dropdown Switch & Interactive Refresh
  presetSelect.addEventListener("change", () => {
    hideLoraPreviewTooltip();
    const selName = presetSelect.value;
    const found = presetsList.find((p) => p.name === selName || p.id === selName);
    if (found) {
      applyPresetObject(found);
    } else {
      updatePresetThumbBadge();
    }
  });

  const handleDropdownInteraction = () => {
    if (presetsList.length === 0) {
      refreshPresetsList();
    }
  };
  presetSelect.addEventListener("pointerdown", handleDropdownInteraction);
  presetSelect.addEventListener("focus", handleDropdownInteraction);

  // Live Sync: Listen for global preset updates across all modals & nodes
  const onPresetsUpdated = async (e) => {
    const savedName = e?.detail?.result?.name || e?.detail?.presetName || e?.detail?.name;
    await refreshPresetsList(savedName);
  };
  window.addEventListener("aps:lora-presets-updated", onPresetsUpdated);

  const origOnRemoved = node.onRemoved;
  node.onRemoved = function (...args) {
    try {
      window.removeEventListener("aps:lora-presets-updated", onPresetsUpdated);
    } catch {}
    return origOnRemoved?.apply(this, args);
  };

  // 2. Add LoRA Button
  addBtn.addEventListener("click", () => {
    const name = addSelect.value;
    if (!name) return;

    // Detect trigger words
    const tw = loraDetails[name]?.trigger_words || "";

    currentStack.push({
      name,
      strength_model: 1.0,
      strength_clip: 1.0,
      enabled: true,
      trigger_words: tw,
      linked: true,
    });

    addSelect.value = "";
    renderStackList();
  });

  // 3. Clear Stack
  clearBtn.addEventListener("click", () => {
    hideLoraPreviewTooltip();
    if (currentStack.length === 0) return;
    currentStack = [];
    renderStackList();
  });

  // 4. Save Preset Button
  saveBtn.addEventListener("click", () => {
    hideLoraPreviewTooltip();
    openSaveLoraPresetModal({
      api,
      preset: currentPresetData,
      initialLoras: currentStack,
      initialTriggerWords: getActiveTriggerWords(),
      onSaved: async (saved) => {
        await refreshPresetsList(saved?.name);
        if (saved) {
          applyPresetObject(saved);
        }
        syncStateToNode();
      },
    });
  });

  // 5. Open Full Library Drawer
  libBtn.addEventListener("click", () => {
    hideLoraPreviewTooltip();
    openLoraPresetLibraryModal({
      api,
      onApply: (preset) => {
        applyPresetObject(preset);
      },
      onClose: async () => {
        await refreshPresetsList();
      },
    });
  });

  // 6. Copy Trigger Words
  copyTwBtn.addEventListener("click", () => {
    const tw = getActiveTriggerWords();
    if (tw) {
      navigator.clipboard.writeText(tw);
      copyTwBtn.textContent = "✓ 已复制";
      setTimeout(() => { copyTwBtn.textContent = "📋 复制触发词"; }, 1500);
    }
  });

  // 7. Copy Syntax <lora:...>
  copySyntaxBtn.addEventListener("click", () => {
    const syntax = buildLoraSyntaxString(currentStack);
    if (syntax) {
      navigator.clipboard.writeText(syntax);
      copySyntaxBtn.textContent = "✓ 已复制语法";
      setTimeout(() => { copySyntaxBtn.textContent = "📋 复制语法"; }, 1500);
    }
  });

  // 8. Fold/Unfold Extra Trigger Words
  toggleExtraBtn.addEventListener("click", () => {
    showExtraInput = !showExtraInput;
    extraRow.style.display = showExtraInput ? "block" : "none";
    toggleExtraBtn.textContent = showExtraInput ? "▲ 折叠词" : "➕ 附加词";
  });

  extraInput.addEventListener("input", () => {
    syncStateToNode();
  });

  // Attach card as DOM widget
  let domWidget = null;
  if (typeof node.addDOMWidget === "function") {
    domWidget = node.addDOMWidget("aps_lora_card", "custom", card, {
      serialize: false,
      hideOnZoom: false,
      getMinHeight: () => 340,
    });
    if (domWidget) {
      delete domWidget.computeSize;
      domWidget.computeLayoutSize = () => ({
        minHeight: 340,
        maxHeight: undefined,
        minWidth: 0,
      });
    }
  }

  node._apsOnResize = () => {
    hideRawWidgets(node);
    ensureParentOverflowVisible(card);
    applyCardGeometry(node, card, domWidget);
  };

  // Observe the real laid-out wrapper: this fires for every drag step of the
  // node's resize handle, not just on the next canvas repaint.
  let resizeObserver = null;
  let rafPending = false;
  const scheduleGeometry = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      node._apsOnResize?.();
    });
  };

  const wrapper = card.parentElement;
  if (wrapper && typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(scheduleGeometry);
    resizeObserver.observe(wrapper);
  }

  const origRemoved = node.onRemoved;
  node.onRemoved = function (...args) {
    try {
      resizeObserver?.disconnect();
    } catch {}
    return origRemoved?.apply(this, args);
  };

  const origDraw = node.onDrawForeground;
  node.onDrawForeground = function (...args) {
    hideRawWidgets(node);
    const [curW, curH] = getNodeSize(node);
    if (curW !== node._apsLastW || curH !== node._apsLastH) {
      node._apsLastW = curW;
      node._apsLastH = curH;
      node._apsOnResize?.();
    }
    return origDraw?.apply(this, args);
  };

  // Immediate layout sync + a few delayed passes: ComfyUI lays out the DOM
  // widget asynchronously after mount, so the first measurement can be zero.
  hideRawWidgets(node);
  ensureParentOverflowVisible(card);
  applyCardGeometry(node, card, domWidget);
  [80, 240, 600].forEach((delay) =>
    setTimeout(() => {
      hideRawWidgets(node);
      ensureParentOverflowVisible(card);
      applyCardGeometry(node, card, domWidget);
    }, delay)
  );

  // Load data
  initData();
}

export const extension = {
  name: "AIPromptStudio.LoraNode",
  async setup() {
    mountStyles();
    for (const node of app?.graph?._nodes || []) {
      if (node.comfyClass === NODE_TYPE || node.type === NODE_TYPE) {
        setupLoraNode(node);
      }
    }
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_TYPE) return;
    const origCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const r = origCreated?.apply(this, args);
      setupLoraNode(this);
      return r;
    };
    const origConfig = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      const r = origConfig?.apply(this, args);
      setupLoraNode(this);
      return r;
    };
  },
  async nodeCreated(node) {
    if (node.comfyClass === NODE_TYPE || node.type === NODE_TYPE) {
      setupLoraNode(node);
    }
  },
  async afterConfigureGraph() {
    for (const node of app?.graph?._nodes || []) {
      if (node.comfyClass === NODE_TYPE || node.type === NODE_TYPE) {
        setupLoraNode(node);
      }
    }
  },
};

app.registerExtension(extension);

export const _test = {
  setupLoraNode,
};
