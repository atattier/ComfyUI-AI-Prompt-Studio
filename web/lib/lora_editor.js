/**
 * LoRA Preset Hub & Editor for ComfyUI AI Prompt Studio.
 *
 * Provides standalone LoRA stack preset management, Explorer-style library browsing,
 * editing, category organization, and 1-click application to canvas nodes.
 */

import { StudioApi } from "./api.js?v=20261116_v40";

function detectIsLightTheme() {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return false;
  try {
    const rootStyle = getComputedStyle(document.documentElement);
    const menuBg = rootStyle.getPropertyValue("--comfy-menu-bg").trim();
    const m = menuBg.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (m) {
      const [, r, g, b] = m.map(Number);
      return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55;
    }
    const bodyBg = getComputedStyle(document.body).backgroundColor;
    const mb = bodyBg.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (mb) {
      const [, r, g, b] = mb.map(Number);
      return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55;
    }
  } catch {}
  return false;
}

function el(tag, cls = "", text = "") {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

export function formatLoraStackSummary(loras = []) {
  if (!Array.isArray(loras) || loras.length === 0) return "无 LoRA";
  const active = loras.filter((l) => l && l.enabled !== false);
  return `${active.length} 个 LoRA 堆叠 (共 ${loras.length} 个)`;
}

export function buildLoraSyntaxString(loras = [], modelScale = 1.0, clipScale = 1.0) {
  if (!Array.isArray(loras)) return "";
  const parts = [];
  for (const item of loras) {
    if (!item || item.enabled === false) continue;
    const name = String(item.name || "").trim();
    if (!name) continue;
    const mw = Number((Number(item.strength_model || 1.0) * modelScale).toFixed(3));
    parts.push(`<lora:${name}:${mw}>`);
  }
  return parts.join(" ");
}

/**
 * Modal to save or edit a LoRA Stack Preset.
 */
export function openSaveLoraPresetModal({
  api: suppliedApi = null,
  preset = null,
  initialLoras = null,
  initialTriggerWords = "",
  onSaved = null,
  onClose = null,
} = {}) {
  const api = suppliedApi || new StudioApi();
  const isEditing = Boolean(preset && preset.id);
  let coverDataUrl = preset?.thumbnail || "";

  const overlay = el("div", "aps-modal-overlay aps-preset-modal-overlay notranslate");
  overlay.dataset.theme = detectIsLightTheme() ? "light" : "dark";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

  const modal = el("div", "aps-modal aps-preset-save-modal notranslate");
  modal.style.width = "min(720px, 94vw)";
  modal.style.maxWidth = "720px";
  modal.style.height = "min(88vh, 820px)";
  modal.style.maxHeight = "88vh";
  modal.style.display = "flex";
  modal.style.flexDirection = "column";
  modal.style.overflow = "hidden";
  modal.style.boxSizing = "border-box";
  modal.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

  // 1. Header
  const head = el("div", "aps-modal-head aps-wb-head");
  head.style.flexShrink = "0";
  const titleWrap = el("div", "aps-wb-brand");
  titleWrap.append(
    el("span", "aps-logo", "🥞"),
    el("div", "aps-modal-title", isEditing ? "编辑 LoRA 堆叠预设" : "保存 LoRA 堆叠到预设库")
  );
  const closeTopBtn = el("button", "aps-btn aps-btn-sm", "✕ 关闭");
  closeTopBtn.type = "button";
  head.append(titleWrap, closeTopBtn);
  modal.append(head);

  // 2. Body
  const body = el("div", "aps-modal-body aps-preset-modal-body");
  body.style.flex = "1 1 auto";
  body.style.minHeight = "0";
  body.style.overflowY = "auto";
  body.style.overflowX = "hidden";
  body.style.paddingRight = "6px";

  // Basic Info Form
  const formGroup = el("div", "aps-preset-form");

  // Name
  const nameLabel = el("label", "aps-form-label", "预设名称：");
  const nameInput = el("input", "aps-input aps-preset-name-input");
  nameInput.type = "text";
  nameInput.value = preset?.name || "新建 LoRA 堆叠预设";
  nameInput.placeholder = "例如：电影级胶片光影 / 米山舞动态插画";
  formGroup.append(nameLabel, nameInput);

  // Category & Tags Row
  const metaRow = el("div", "aps-form-row");
  metaRow.style.display = "flex";
  metaRow.style.gap = "12px";
  metaRow.style.marginTop = "8px";

  const catCol = el("div");
  catCol.style.flex = "1";
  catCol.append(el("label", "aps-form-label", "分类目录："));
  const catSelect = el("select", "aps-input aps-preset-cat-select");
  catCol.append(catSelect);

  const tagsCol = el("div");
  tagsCol.style.flex = "1.5";
  tagsCol.append(el("label", "aps-form-label", "标签 (逗号分隔)："));
  const tagsInput = el("input", "aps-input aps-preset-tags-input");
  tagsInput.type = "text";
  tagsInput.value = Array.isArray(preset?.tags) ? preset.tags.join(", ") : "";
  tagsInput.placeholder = "例如：画风, 胶片, 质感, SDXL";
  tagsCol.append(tagsInput);

  metaRow.append(catCol, tagsCol);
  formGroup.append(metaRow);

  // 2.2 Cover / Preview Image Row
  const coverRow = el("div", "aps-lora-cover-row");
  const thumbWrap = el("div", "aps-lora-cover-thumb-wrap");
  const thumbImg = el("img");
  thumbImg.alt = "预设效果图";
  const thumbPlaceholder = el("span", "", "🖼");
  thumbPlaceholder.style.fontSize = "26px";
  thumbPlaceholder.style.opacity = "0.5";
  thumbWrap.append(thumbImg, thumbPlaceholder);

  const coverInfo = el("div");
  coverInfo.style.flex = "1";
  coverInfo.style.display = "flex";
  coverInfo.style.flexDirection = "column";
  coverInfo.style.gap = "2px";

  const coverTitle = el("div", "", "预设组效果图 (生成画面效果封面)");
  coverTitle.style.fontSize = "12px";
  coverTitle.style.fontWeight = "bold";

  const coverHint = el("div", "", "识图提取时自动带入，或手动选择/拖入本地出图作为效果图");
  coverHint.style.fontSize = "11px";
  coverHint.style.color = "var(--aps-muted, #888)";
  coverInfo.append(coverTitle, coverHint);

  const coverBtnGroup = el("div");
  coverBtnGroup.style.display = "flex";
  coverBtnGroup.style.gap = "6px";

  const selectCoverBtn = el("button", "aps-btn aps-btn-xs", "📷 更换效果图");
  selectCoverBtn.type = "button";
  selectCoverBtn.title = "选择本地图片作为此预设组的效果图封面";

  const removeCoverBtn = el("button", "aps-btn aps-btn-xs", "✕ 移除");
  removeCoverBtn.type = "button";
  removeCoverBtn.style.color = "#ff6b6b";

  const customCoverFileInput = el("input");
  customCoverFileInput.type = "file";
  customCoverFileInput.accept = "image/png,image/webp,image/jpeg";
  customCoverFileInput.style.display = "none";
  modal.append(customCoverFileInput);

  coverBtnGroup.append(selectCoverBtn, removeCoverBtn);
  coverRow.append(thumbWrap, coverInfo, coverBtnGroup);
  formGroup.append(coverRow);

  function updateCoverDisplay(src) {
    if (src) {
      thumbImg.src = src;
      thumbImg.style.display = "block";
      thumbPlaceholder.style.display = "none";
      removeCoverBtn.style.display = "inline-block";
      coverHint.textContent = "已设置效果图，将在预设库与悬停卡片中呈现";
      coverHint.style.color = "#34d399";
    } else {
      thumbImg.src = "";
      thumbImg.style.display = "none";
      thumbPlaceholder.style.display = "inline-block";
      removeCoverBtn.style.display = "none";
      coverHint.textContent = "暂无效果图。识图提取时自动带入，或手动选择/拖入本地出图";
      coverHint.style.color = "var(--aps-muted, #888)";
    }
  }

  // 初始化已有封面
  if (coverDataUrl || (preset && preset.has_image)) {
    const initialCover = coverDataUrl || (preset?.id ? api.loraPresetImageUrl(preset.id) : "");
    updateCoverDisplay(initialCover);
  } else {
    updateCoverDisplay("");
  }

  selectCoverBtn.addEventListener("click", () => customCoverFileInput.click());
  removeCoverBtn.addEventListener("click", () => {
    coverDataUrl = "";
    updateCoverDisplay("");
  });

  customCoverFileInput.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      coverDataUrl = reader.result;
      updateCoverDisplay(coverDataUrl);
    };
    reader.readAsDataURL(file);
    customCoverFileInput.value = "";
  });

  // 支持直接将图片拖拽到弹窗更换效果图
  modal.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  modal.addEventListener("drop", (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file && (file.type?.startsWith("image/") || file.name?.match(/\.(png|webp|jpe?g)$/i))) {
      e.preventDefault();
      e.stopPropagation();
      const reader = new FileReader();
      reader.onload = () => {
        coverDataUrl = reader.result;
        updateCoverDisplay(coverDataUrl);
        statusMsg.textContent = `✓ 已从拖放图片更新效果图封面：${file.name}`;
        statusMsg.style.color = "#34d399";
      };
      reader.readAsDataURL(file);
    }
  });

  // 3. LoRA Stack Editor Section
  const stackSection = el("div", "aps-lora-stack-section");
  stackSection.style.marginTop = "16px";
  stackSection.style.borderTop = "1px solid var(--aps-border, #333)";
  stackSection.style.paddingTop = "12px";

  const stackHeader = el("div");
  stackHeader.style.display = "flex";
  stackHeader.style.justifyContent = "space-between";
  stackHeader.style.alignItems = "center";
  stackHeader.style.marginBottom = "8px";

  const stackTitle = el("div", "aps-form-label", "🥞 堆叠 LoRA 列表（按自上而下顺序加载应用）：");
  stackTitle.style.fontWeight = "bold";

  const btnGroup = el("div");
  btnGroup.style.display = "flex";
  btnGroup.style.gap = "6px";

  const inspectImgBtn = el("button", "aps-btn aps-btn-xs", "📷 识图提取");
  inspectImgBtn.type = "button";
  inspectImgBtn.title = "选择包含生成参数的图片，自动提取 LoRA 列表、权重与封面";

  const addRowBtn = el("button", "aps-btn aps-btn-xs aps-primary", "＋ 添加 LoRA");
  addRowBtn.type = "button";

  const imgFileInput = el("input");
  imgFileInput.type = "file";
  imgFileInput.accept = "image/png,image/webp,image/jpeg";
  imgFileInput.style.display = "none";
  modal.append(imgFileInput);

  btnGroup.append(inspectImgBtn, addRowBtn);
  stackHeader.append(stackTitle, btnGroup);
  stackSection.append(stackHeader);

  inspectImgBtn.addEventListener("click", () => imgFileInput.click());

  imgFileInput.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const b64 = reader.result;
      try {
        inspectImgBtn.textContent = "⏳ 识别中...";
        const res = await api.inspectImageLoras({ image_data: b64, filename: file.name });
        inspectImgBtn.textContent = "📷 识图提取";
        if (!res.loras || res.loras.length === 0) {
          alert("未在该图片的元数据中检测到 LoRA 信息。请确保图片包含生成工作流或参数。");
          return;
        }

        currentLoras = res.loras.map((l) => ({
          name: l.name,
          strength_model: Number(l.strength_model ?? 1.0),
          strength_clip: Number(l.strength_clip ?? l.strength_model ?? 1.0),
          enabled: l.enabled !== false,
        }));
        renderStackRows();

        if (res.suggested_name && (!nameInput.value || nameInput.value === "新建 LoRA 堆叠预设")) {
          nameInput.value = res.suggested_name;
        }
        if (res.trigger_words && !twTextarea.value) {
          twTextarea.value = res.trigger_words;
        }
        if (res.thumbnail) {
          coverDataUrl = res.thumbnail;
          updateCoverDisplay(coverDataUrl);
        }
        statusMsg.textContent = `✓ 成功提取 ${res.loras.length} 个 LoRA`;
        statusMsg.style.color = "#34d399";
      } catch (err) {
        inspectImgBtn.textContent = "📷 识图提取";
        console.error(err);
        alert("识别失败: " + (err.message || err));
      }
    };
    reader.readAsDataURL(file);
    imgFileInput.value = "";
  });

  // Datalist for available local LoRAs
  const loraDatalist = el("datalist");
  loraDatalist.id = "aps-available-loras-datalist";
  document.body.append(loraDatalist);

  api.getAvailableLoras()
    .then((res) => {
      loraDatalist.innerHTML = "";
      if (res && Array.isArray(res.loras)) {
        for (const l of res.loras) {
          const opt = el("option");
          opt.value = l;
          loraDatalist.append(opt);
        }
      }
    })
    .catch(() => {});

  const stackRowsContainer = el("div", "aps-lora-rows-container");
  stackRowsContainer.style.display = "flex";
  stackRowsContainer.style.flexDirection = "column";
  stackRowsContainer.style.gap = "6px";
  stackRowsContainer.style.maxHeight = "280px";
  stackRowsContainer.style.minHeight = "48px";
  stackRowsContainer.style.overflowY = "auto";
  stackRowsContainer.style.overflowX = "hidden";
  stackSection.append(stackRowsContainer);

  let currentLoras = [];
  if (Array.isArray(preset?.loras)) {
    currentLoras = JSON.parse(JSON.stringify(preset.loras));
  } else if (Array.isArray(initialLoras)) {
    currentLoras = JSON.parse(JSON.stringify(initialLoras));
  }
  if (currentLoras.length === 0) {
    currentLoras.push({ name: "", strength_model: 1.0, strength_clip: 1.0, enabled: true });
  }

  function renderStackRows() {
    stackRowsContainer.innerHTML = "";
    currentLoras.forEach((item, index) => {
      const row = el("div", "aps-lora-row");
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.gap = "8px";
      row.style.padding = "6px 8px";
      row.style.background = "var(--aps-bg-subtle, rgba(255, 255, 255, 0.04))";
      row.style.borderRadius = "4px";

      // Checkbox
      const check = el("input");
      check.type = "checkbox";
      check.checked = item.enabled !== false;
      check.title = "启用/停用该项";
      check.addEventListener("change", () => {
        item.enabled = check.checked;
      });

      // Name input
      const nameInput = el("input", "aps-input");
      nameInput.type = "text";
      nameInput.setAttribute("list", "aps-available-loras-datalist");
      nameInput.style.flex = "2";
      nameInput.value = item.name || "";
      nameInput.placeholder = "选择或输入 LoRA 文件名…";
      nameInput.addEventListener("input", () => {
        item.name = nameInput.value.trim();
      });

      // Model weight
      const mwWrap = el("div");
      mwWrap.style.display = "flex";
      mwWrap.style.alignItems = "center";
      mwWrap.style.gap = "4px";
      const mwLabel = el("span", "", "M:");
      mwLabel.style.fontSize = "12px";
      mwLabel.style.opacity = "0.75";
      const mwInput = el("input", "aps-input");
      mwInput.type = "number";
      mwInput.step = "0.05";
      mwInput.style.width = "72px";
      mwInput.value = item.strength_model ?? 1.0;
      mwInput.title = "Model 权重 (Strength Model)";
      mwInput.addEventListener("input", () => {
        item.strength_model = parseFloat(mwInput.value) || 0.0;
      });
      mwWrap.append(mwLabel, mwInput);

      // Clip weight
      const cwWrap = el("div");
      cwWrap.style.display = "flex";
      cwWrap.style.alignItems = "center";
      cwWrap.style.gap = "4px";
      const cwLabel = el("span", "", "C:");
      cwLabel.style.fontSize = "12px";
      cwLabel.style.opacity = "0.75";
      const cwInput = el("input", "aps-input");
      cwInput.type = "number";
      cwInput.step = "0.05";
      cwInput.style.width = "72px";
      cwInput.value = item.strength_clip ?? 1.0;
      cwInput.title = "Clip 权重 (Strength Clip)";
      cwInput.addEventListener("input", () => {
        item.strength_clip = parseFloat(cwInput.value) || 0.0;
      });
      cwWrap.append(cwLabel, cwInput);

      // Delete button
      const delBtn = el("button", "aps-btn aps-btn-xs", "✕");
      delBtn.type = "button";
      delBtn.title = "删除此 LoRA";
      delBtn.style.color = "#ff6b6b";
      delBtn.addEventListener("click", () => {
        currentLoras.splice(index, 1);
        if (currentLoras.length === 0) {
          currentLoras.push({ name: "", strength_model: 1.0, strength_clip: 1.0, enabled: true });
        }
        renderStackRows();
      });

      row.append(check, nameInput, mwWrap, cwWrap, delBtn);
      stackRowsContainer.append(row);
    });
  }

  addRowBtn.addEventListener("click", () => {
    currentLoras.push({ name: "", strength_model: 1.0, strength_clip: 1.0, enabled: true });
    renderStackRows();
  });

  renderStackRows();
  formGroup.append(stackSection);

  // 4. Trigger Words & Notes
  const twSection = el("div");
  twSection.style.marginTop = "14px";
  twSection.append(el("label", "aps-form-label", "触发词 / 搭配提示词："));
  const twTextarea = el("textarea", "aps-input aps-textarea");
  twTextarea.rows = 2;
  twTextarea.value = preset?.trigger_words || initialTriggerWords || "";
  twTextarea.placeholder = "例如：by yoneyama mai, cinematic lighting, masterpiece";
  twSection.append(twTextarea);
  formGroup.append(twSection);

  const notesSection = el("div");
  notesSection.style.marginTop = "10px";
  notesSection.append(el("label", "aps-form-label", "使用建议与备注："));
  const notesTextarea = el("textarea", "aps-input aps-textarea");
  notesTextarea.rows = 2;
  notesTextarea.value = preset?.notes || "";
  notesTextarea.placeholder = "例如：建议配合真实质感大模型，Model 权重调低到 0.6 时不易过拟合";
  notesSection.append(notesTextarea);
  formGroup.append(notesSection);

  body.append(formGroup);
  modal.append(body);

  // 5. Footer Buttons
  const foot = el("div", "aps-modal-foot");
  foot.style.flexShrink = "0";
  foot.style.marginTop = "auto";
  foot.style.paddingTop = "10px";
  foot.style.borderTop = "1px solid var(--aps-border)";
  foot.style.background = "var(--aps-bg)";
  const cancelBtn = el("button", "aps-btn", "取消");
  cancelBtn.type = "button";

  const saveBtn = el("button", "aps-btn aps-primary", "✓ 保存到预设库");
  saveBtn.type = "button";

  const statusMsg = el("span", "aps-status-inline");
  statusMsg.style.marginRight = "auto";
  statusMsg.style.fontSize = "12px";

  foot.append(statusMsg, cancelBtn, saveBtn);
  modal.append(foot);

  overlay.append(modal);
  document.body.append(overlay);

  let isCleanedUp = false;
  function cleanup() {
    if (isCleanedUp) return;
    isCleanedUp = true;
    overlay.remove();
    loraDatalist.remove();
    if (typeof onClose === "function") {
      try { onClose(); } catch {}
    }
  }

  closeTopBtn.addEventListener("click", cleanup);
  cancelBtn.addEventListener("click", cleanup);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) cleanup();
  });

  // Populate categories
  api.listLoraPresetCategories()
    .then((info) => {
      catSelect.innerHTML = "";
      const categories = (info && info.categories) ? info.categories : ["通用", "画风风格", "人物角色", "光影质感", "细节增强", "服饰姿态"];
      const activeCat = preset?.category || "画风风格";
      for (const c of categories) {
        if (c === "全部") continue;
        const opt = el("option", "", c);
        opt.value = c;
        if (c === activeCat) opt.selected = true;
        catSelect.append(opt);
      }
    })
    .catch(() => {});

  saveBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) {
      statusMsg.textContent = "请填写预设名称。";
      statusMsg.style.color = "#ff6b6b";
      return;
    }
    const cleanLoras = currentLoras.filter((item) => item && item.name.trim().length > 0);
    const tags = tagsInput.value.split(/[,，]/).map((t) => t.trim()).filter(Boolean);

    const payload = {
      id: preset?.id || undefined,
      name,
      category: catSelect.value || "通用",
      tags,
      loras: cleanLoras,
      trigger_words: twTextarea.value.trim(),
      notes: notesTextarea.value.trim(),
    };
    if (coverDataUrl) {
      payload.image_data = coverDataUrl;
    }

    saveBtn.disabled = true;
    statusMsg.textContent = "正在保存…";
    statusMsg.style.color = "var(--aps-text-muted, #aaa)";

    try {
      const saved = await api.saveLoraPreset(payload);
      statusMsg.textContent = "✓ 保存成功！";
      statusMsg.style.color = "#4ade80";
      setTimeout(() => {
        cleanup();
        if (typeof onSaved === "function") onSaved(saved);
      }, 500);
    } catch (err) {
      saveBtn.disabled = false;
      statusMsg.textContent = `保存失败：${err.message || err}`;
      statusMsg.style.color = "#ff6b6b";
    }
  });
}

/**
 * Render default placeholder for presets without cover image.
 */
function renderDefaultLoraStage(preset) {
  const wrap = el("div");
  wrap.style.display = "flex";
  wrap.style.flexDirection = "column";
  wrap.style.alignItems = "center";
  wrap.style.justifyContent = "center";
  wrap.style.gap = "4px";
  wrap.style.opacity = "0.75";
  wrap.innerHTML = `<span style="font-size: 34px;">🥞</span><span style="font-size: 11px; font-weight: bold; color: var(--aps-muted, #888);">${preset.name || "LoRA 预设"}</span>`;
  return wrap;
}

/**
 * Lightbox modal to view large preset cover, stack details, and change cover.
 */
export function openLoraPresetLightbox(preset, { api: suppliedApi = null, onApply = null, onUpdated = null } = {}) {
  const api = suppliedApi || new StudioApi();
  const overlay = el("div", "aps-modal-overlay aps-lora-lightbox-overlay notranslate");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

  const card = el("div", "aps-lora-lightbox-card notranslate");
  card.style.display = "flex";
  card.style.flexDirection = "column";

  // 1. Header
  const head = el("div", "aps-modal-head aps-wb-head");
  head.style.flexShrink = "0";
  const titleWrap = el("div", "aps-wb-brand");
  titleWrap.append(
    el("span", "aps-logo", "🥞"),
    el("div", "aps-modal-title", `${preset.name} · 预设效果图`)
  );
  const closeBtn = el("button", "aps-btn aps-btn-sm", "✕ 关闭");
  closeBtn.type = "button";
  head.append(titleWrap, closeBtn);
  card.append(head);

  // 2. Body: Left Media, Right Details
  const body = el("div");
  body.style.display = "flex";
  body.style.flex = "1 1 auto";
  body.style.minHeight = "0";
  body.style.overflow = "hidden";

  // Left Media
  const mediaWrap = el("div", "aps-lora-lightbox-media");
  mediaWrap.style.flex = "1.3";
  mediaWrap.style.position = "relative";
  mediaWrap.style.background = "#09090b";
  mediaWrap.style.display = "flex";
  mediaWrap.style.alignItems = "center";
  mediaWrap.style.justifyContent = "center";

  const img = el("img");
  img.alt = preset.name;
  let coverUrl = preset.thumbnail || (preset.has_image ? api.loraPresetImageUrl(preset.id) : "");
  if (!coverUrl && preset.loras && preset.loras.length > 0) {
    const firstL = preset.loras.find((l) => l.name);
    if (firstL && typeof api?.loraPreviewImageUrl === "function") {
      coverUrl = api.loraPreviewImageUrl(firstL.name);
    }
  }

  function renderMediaView() {
    mediaWrap.innerHTML = "";
    if (coverUrl) {
      img.src = coverUrl;
      mediaWrap.append(img);
    } else {
      const placeholder = el("div");
      placeholder.style.textAlign = "center";
      placeholder.style.padding = "30px";
      placeholder.innerHTML = `<span style="font-size: 54px;">🥞</span><div style="margin-top: 10px; font-size: 13px; color: var(--aps-muted, #888);">暂无大图封面<br>可点下方「更换效果图」上传</div>`;
      mediaWrap.append(placeholder);
    }
  }
  renderMediaView();

  // Right Info Pane
  const infoPane = el("div");
  infoPane.style.flex = "1";
  infoPane.style.padding = "16px";
  infoPane.style.display = "flex";
  infoPane.style.flexDirection = "column";
  infoPane.style.gap = "12px";
  infoPane.style.overflowY = "auto";
  infoPane.style.borderLeft = "1px solid var(--aps-border)";

  // Badges
  const metaBar = el("div");
  metaBar.style.display = "flex";
  metaBar.style.gap = "6px";
  metaBar.append(
    el("span", "aps-badge aps-badge-blue", preset.category || "通用"),
    el("span", "aps-badge aps-badge-purple", `🥞 ${(preset.loras || []).length} 个 LoRA 堆叠`)
  );
  if (preset.is_builtin) {
    metaBar.append(el("span", "aps-badge", "官方内置"));
  }
  infoPane.append(metaBar);

  // LoRA Stack List
  const lorasSec = el("div");
  lorasSec.append(el("div", "aps-form-label", "🥞 堆叠 LoRA 列表与权重:"));
  const lorasBox = el("div");
  lorasBox.style.display = "flex";
  lorasBox.style.flexDirection = "column";
  lorasBox.style.gap = "4px";
  lorasBox.style.background = "var(--aps-surface-0, rgba(0,0,0,0.2))";
  lorasBox.style.padding = "8px 10px";
  lorasBox.style.borderRadius = "6px";
  lorasBox.style.maxHeight = "160px";
  lorasBox.style.overflowY = "auto";

  (preset.loras || []).forEach((item) => {
    const row = el("div");
    row.style.display = "flex";
    row.style.justifyContent = "space-between";
    row.style.fontSize = "12px";
    row.style.opacity = item.enabled !== false ? "1" : "0.5";
    row.append(
      el("span", "", `• ${item.name || "未命名"}`),
      el("span", "", `M: ${item.strength_model}  C: ${item.strength_clip}`)
    );
    lorasBox.append(row);
  });
  lorasSec.append(lorasBox);
  infoPane.append(lorasSec);

  // Trigger words
  if (preset.trigger_words) {
    const twSec = el("div");
    const twHead = el("div");
    twHead.style.display = "flex";
    twHead.style.justifyContent = "space-between";
    twHead.style.alignItems = "center";
    twHead.append(el("div", "aps-form-label", "💬 搭配触发词:"));
    const copyBtn = el("button", "aps-btn aps-btn-xs", "📋 复制触发词");
    copyBtn.type = "button";
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(preset.trigger_words);
      copyBtn.textContent = "✓ 已复制";
      setTimeout(() => { copyBtn.textContent = "📋 复制触发词"; }, 1500);
    });
    twHead.append(copyBtn);
    twSec.append(twHead);

    const twContent = el("div", "aps-input");
    twContent.style.fontSize = "12px";
    twContent.style.lineHeight = "1.4";
    twContent.style.padding = "8px";
    twContent.style.maxHeight = "90px";
    twContent.style.overflowY = "auto";
    twContent.textContent = preset.trigger_words;
    twSec.append(twContent);
    infoPane.append(twSec);
  }

  // Notes
  if (preset.notes) {
    const notesSec = el("div");
    notesSec.append(el("div", "aps-form-label", "📝 使用建议与备注:"));
    const notesContent = el("div");
    notesContent.style.fontSize = "12px";
    notesContent.style.opacity = "0.75";
    notesContent.textContent = preset.notes;
    notesSec.append(notesContent);
    infoPane.append(notesSec);
  }

  body.append(mediaWrap, infoPane);
  card.append(body);

  // Hidden File input for changing cover
  const changeCoverInput = el("input");
  changeCoverInput.type = "file";
  changeCoverInput.accept = "image/png,image/webp,image/jpeg";
  changeCoverInput.style.display = "none";
  card.append(changeCoverInput);

  changeCoverInput.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const b64 = reader.result;
        const updated = await api.saveLoraPreset({
          id: preset.id,
          name: preset.name,
          category: preset.category,
          tags: preset.tags,
          loras: preset.loras,
          trigger_words: preset.trigger_words,
          notes: preset.notes,
          image_data: b64,
        });
        preset.thumbnail = updated.thumbnail || b64;
        preset.has_image = true;
        coverUrl = preset.thumbnail;
        renderMediaView();
        onUpdated?.();
      } catch (err) {
        alert(`更换效果图失败：${err.message || err}`);
      }
    };
    reader.readAsDataURL(file);
    changeCoverInput.value = "";
  });

  // Footer Buttons
  const foot = el("div", "aps-modal-foot");
  foot.style.flexShrink = "0";
  foot.style.padding = "10px 16px";
  foot.style.display = "flex";
  foot.style.justifyContent = "space-between";

  const leftBtns = el("div");
  leftBtns.style.display = "flex";
  leftBtns.style.gap = "8px";

  const uploadBtn = el("button", "aps-btn aps-btn-sm", "🖼 更换效果图");
  uploadBtn.type = "button";
  uploadBtn.addEventListener("click", () => changeCoverInput.click());
  leftBtns.append(uploadBtn);

  if (coverUrl) {
    const dlBtn = el("button", "aps-btn aps-btn-sm", "📥 下载效果图");
    dlBtn.type = "button";
    dlBtn.addEventListener("click", () => {
      const a = document.createElement("a");
      a.href = coverUrl;
      a.download = `${preset.name}_效果图.png`;
      a.click();
    });
    leftBtns.append(dlBtn);
  }

  const rightBtns = el("div");
  rightBtns.style.display = "flex";
  rightBtns.style.gap = "8px";

  const applyBtn = el("button", "aps-btn aps-btn-sm aps-primary", "⚡ 应用此预设到节点");
  applyBtn.type = "button";
  applyBtn.addEventListener("click", () => {
    overlay.remove();
    onApply?.(preset);
  });

  rightBtns.append(applyBtn);
  foot.append(leftBtns, rightBtns);
  card.append(foot);

  overlay.append(card);
  document.body.append(overlay);

  closeBtn.addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
}

/**
 * Explorer-style LoRA Preset Hub Gallery Modal.
 */
export function openLoraPresetLibraryModal({
  api: suppliedApi = null,
  onApply = null,
  onClose = null,
} = {}) {
  const api = suppliedApi || new StudioApi();

  const overlay = el("div", "aps-modal-overlay aps-preset-gallery-overlay notranslate");
  overlay.dataset.theme = detectIsLightTheme() ? "light" : "dark";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");

  const modal = el("div", "aps-modal aps-preset-gallery-modal notranslate");

  // 1. Header
  const head = el("div", "aps-modal-head aps-wb-head");
  const titleWrap = el("div", "aps-wb-brand");
  titleWrap.append(
    el("span", "aps-logo", "🥞"),
    el("div", "aps-modal-title", "LoRA 资产与堆叠预设库 (LoRA Preset Hub)")
  );
  const closeTopBtn = el("button", "aps-btn aps-btn-sm", "✕ 关闭");
  closeTopBtn.type = "button";
  head.append(titleWrap, closeTopBtn);
  modal.append(head);

  // 2. Body
  const body = el("div", "aps-modal-body aps-preset-gallery-body");
  const explorerLayout = el("div", "aps-explorer-layout");

  // 2.1 Sidebar (Category Tree)
  const sidebar = el("div", "aps-explorer-sidebar");
  const sidebarHead = el("div", "aps-explorer-sidebar-head");
  sidebarHead.append(el("span", "aps-explorer-sidebar-title", "📁 LoRA 分类"));

  const newCatBtn = el("button", "aps-btn aps-btn-xs aps-primary aps-explorer-new-top-btn", "＋ 新建分类");
  newCatBtn.type = "button";
  sidebarHead.append(newCatBtn);

  const treeContainer = el("div", "aps-explorer-tree");
  sidebar.append(sidebarHead, treeContainer);

  const sidebarFoot = el("div", "aps-explorer-sidebar-foot");
  const resetBuiltinsBtn = el("button", "aps-btn aps-btn-xs aps-explorer-reset-btn", "↺ 恢复默认堆叠");
  resetBuiltinsBtn.type = "button";
  sidebarFoot.append(resetBuiltinsBtn);
  sidebar.append(sidebarFoot);

  // 2.2 Main Pane (Toolbar + Preset Cards Grid)
  const mainPane = el("div", "aps-explorer-main");

  const topBar = el("div", "aps-explorer-topbar");
  const breadcrumbWrap = el("div", "aps-explorer-breadcrumbs");

  const topActionsWrap = el("div", "aps-explorer-top-actions");
  const searchInput = el("input", "aps-input aps-preset-search-input");
  searchInput.placeholder = "搜索 LoRA 名称、标签、触发词…";

  const newPresetBtn = el("button", "aps-btn aps-btn-sm aps-primary", "＋ 新建预设");
  newPresetBtn.type = "button";

  const importImgBtn = el("button", "aps-btn aps-btn-sm", "📷 识图导入");
  importImgBtn.type = "button";
  importImgBtn.title = "选择包含生成参数的图片，自动提取 LoRA 列表并保存为预设";

  const imgPicker = el("input");
  imgPicker.type = "file";
  imgPicker.accept = "image/png,image/webp,image/jpeg";
  imgPicker.style.display = "none";
  modal.append(imgPicker);

  const importJsonBtn = el("button", "aps-btn aps-btn-sm", "📥 导入 JSON");
  importJsonBtn.type = "button";

  const exportJsonBtn = el("button", "aps-btn aps-btn-sm", "📤 导出 JSON");
  exportJsonBtn.type = "button";

  topActionsWrap.append(searchInput, newPresetBtn, importImgBtn, importJsonBtn, exportJsonBtn);
  topBar.append(breadcrumbWrap, topActionsWrap);
  mainPane.append(topBar);

  const cardsContainer = el("div", "aps-explorer-grid");
  cardsContainer.style.padding = "16px";
  cardsContainer.style.display = "grid";
  cardsContainer.style.gridTemplateColumns = "repeat(auto-fill, minmax(290px, 1fr))";
  cardsContainer.style.gap = "14px";
  mainPane.append(cardsContainer);

  // Full-pane Drag & Drop Overlay (matches prompt library)
  const dropOverlay = el("div", "aps-explorer-drop-overlay");
  dropOverlay.style.display = "none";
  dropOverlay.style.position = "absolute";
  dropOverlay.style.inset = "0";
  dropOverlay.style.background = "rgba(0, 0, 0, 0.82)";
  dropOverlay.style.backdropFilter = "blur(6px)";
  dropOverlay.style.zIndex = "99";
  dropOverlay.style.flexDirection = "column";
  dropOverlay.style.alignItems = "center";
  dropOverlay.style.justifyContent = "center";
  dropOverlay.style.pointerEvents = "none";
  dropOverlay.style.border = "2px dashed var(--aps-accent, #d97757)";
  dropOverlay.style.borderRadius = "8px";
  dropOverlay.style.margin = "8px";
  dropOverlay.innerHTML = `
    <div style="font-size: 40px; margin-bottom: 10px; animation: bounce 1s infinite;">📥</div>
    <div class="aps-explorer-drop-title" style="font-size: 16px; font-weight: 700; color: #fff;">松开鼠标立即导入图片中的 LoRA 预设</div>
    <div style="font-size: 12px; color: var(--aps-accent, #d97757); margin-top: 6px;">自动解析 ComfyUI / WebUI / Civitai 元数据与 LoRA 权重</div>
  `;
  mainPane.style.position = "relative";
  mainPane.append(dropOverlay);

  explorerLayout.append(sidebar, mainPane);
  body.append(explorerLayout);
  modal.append(body);
  overlay.append(modal);
  document.body.append(overlay);

  let isCleanedUp = false;
  function cleanup() {
    if (isCleanedUp) return;
    isCleanedUp = true;
    overlay.remove();
    if (typeof onClose === "function") {
      try { onClose(); } catch (err) { console.warn("[AIPromptStudioLora] onClose error:", err); }
    }
  }

  closeTopBtn.addEventListener("click", cleanup);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) cleanup();
  });

  let selectedCategory = "全部";
  let searchKeyword = "";
  let allPresets = [];
  let categoryCounts = {};

  async function updateCategoryCounts() {
    try {
      const res = await api.listLoraPresets();
      const list = res.presets || [];
      const counts = { "全部": list.length };
      for (const p of list) {
        const cat = p.category || "通用";
        counts[cat] = (counts[cat] || 0) + 1;
      }
      categoryCounts = counts;
    } catch {}
  }

  async function loadCategories() {
    try {
      await updateCategoryCounts();
      const info = await api.listLoraPresetCategories();
      const cats = (info && info.categories) ? info.categories : ["全部", "通用", "画风风格", "人物角色", "光影质感", "细节增强", "服饰姿态"];
      treeContainer.innerHTML = "";

      for (const c of cats) {
        const isActive = c === selectedCategory;
        const item = el("div", `aps-tree-item aps-explorer-tree-item${isActive ? " is-active active" : ""}`);
        item.style.cursor = "pointer";
        item.style.padding = "7px 10px";
        item.style.borderRadius = "6px";
        item.style.display = "flex";
        item.style.justifyContent = "space-between";
        item.style.alignItems = "center";
        item.style.marginBottom = "3px";
        item.style.transition = "all 0.15s ease";

        if (isActive) {
          item.style.background = "color-mix(in srgb, var(--aps-accent, #6366f1) 24%, rgba(255, 255, 255, 0.08))";
          item.style.borderLeft = "3px solid var(--aps-accent, #6366f1)";
          item.style.color = "#ffffff";
          item.style.fontWeight = "600";
        } else {
          item.style.background = "transparent";
          item.style.borderLeft = "3px solid transparent";
          item.style.color = "var(--aps-fg, #e2e8f0)";
          item.style.fontWeight = "normal";
        }

        item.addEventListener("mouseenter", () => {
          if (c !== selectedCategory) {
            item.style.background = "rgba(255, 255, 255, 0.08)";
          }
        });
        item.addEventListener("mouseleave", () => {
          if (c !== selectedCategory) {
            item.style.background = "transparent";
          }
        });

        const leftWrap = el("div");
        leftWrap.style.display = "flex";
        leftWrap.style.alignItems = "center";
        leftWrap.style.gap = "6px";
        const iconSpan = el("span", "", c === "全部" ? "🗂" : "📁");
        const nameSpan = el("span", "", c);
        leftWrap.append(iconSpan, nameSpan);

        const count = categoryCounts[c] ?? 0;
        const countBadge = el("span", "aps-tree-count-badge", String(count));
        countBadge.style.fontSize = "11px";
        countBadge.style.padding = "1px 6px";
        countBadge.style.borderRadius = "10px";
        if (isActive) {
          countBadge.style.background = "var(--aps-accent, #6366f1)";
          countBadge.style.color = "#ffffff";
          countBadge.style.fontWeight = "bold";
        } else {
          countBadge.style.background = "rgba(0, 0, 0, 0.28)";
          countBadge.style.color = "var(--aps-muted, #94a3b8)";
        }

        item.append(leftWrap, countBadge);

        item.addEventListener("click", () => {
          selectedCategory = c;
          loadCategories();
          loadPresets();
        });

        treeContainer.append(item);
      }
    } catch {
      // fallback
    }
  }

  async function loadPresets() {
    cardsContainer.innerHTML = "";
    breadcrumbWrap.innerHTML = "";
    const bcIcon = el("span", "", "🗂 分类: ");
    bcIcon.style.opacity = "0.75";
    const bcCurrent = el("span", "aps-badge aps-badge-blue", selectedCategory);
    bcCurrent.style.fontSize = "12px";
    bcCurrent.style.padding = "2px 8px";
    breadcrumbWrap.append(bcIcon, bcCurrent);

    try {
      const res = await api.listLoraPresets({
        category: selectedCategory === "全部" ? "" : selectedCategory,
        search: searchKeyword,
      });
      allPresets = res.presets || [];

      if (allPresets.length === 0) {
        const empty = el("div", "aps-empty-state");
        empty.style.gridColumn = "1 / -1";
        empty.style.textAlign = "center";
        empty.style.padding = "48px 0";
        empty.style.opacity = "0.6";
        empty.textContent = "当前分类下暂无 LoRA 预设，点右上角「＋ 新建预设」添加。";
        cardsContainer.append(empty);
        return;
      }

      for (const preset of allPresets) {
        cardsContainer.append(createPresetCard(preset));
      }
    } catch (err) {
      const errBox = el("div", "aps-empty-state", `加载预设失败：${err.message || err}`);
      cardsContainer.append(errBox);
    }
  }

  function createPresetCard(preset) {
    const card = el("div", "aps-preset-card");
    card.style.background = "var(--aps-bg-card, #1e1e24)";
    card.style.border = "1px solid var(--aps-border, #333)";
    card.style.borderRadius = "8px";
    card.style.padding = "10px";
    card.style.display = "flex";
    card.style.flexDirection = "column";
    card.style.gap = "8px";

    const loras = Array.isArray(preset.loras) ? preset.loras : [];

    // 1. Stage Wrap (Visual Cover Showcase)
    const stageWrap = el("div", "aps-lora-card-stage");
    let coverUrl = preset.thumbnail || (preset.has_image ? api.loraPresetImageUrl(preset.id) : "");
    if (!coverUrl && loras.length > 0) {
      const firstWithPreview = loras.find((l) => l.name);
      if (firstWithPreview && typeof api?.loraPreviewImageUrl === "function") {
        coverUrl = api.loraPreviewImageUrl(firstWithPreview.name);
      }
    }

    if (coverUrl) {
      const img = el("img");
      img.src = coverUrl;
      img.alt = preset.name;
      img.loading = "lazy";
      img.onerror = () => {
        img.remove();
        stageWrap.append(renderDefaultLoraStage(preset));
      };
      stageWrap.append(img);

      const overlayShade = el("div", "aps-lora-stage-overlay");
      stageWrap.append(overlayShade);
    } else {
      stageWrap.append(renderDefaultLoraStage(preset));
    }

    // Badge on stage
    const countBadge = el("span", "aps-lora-stage-badge", `🥞 ${loras.length} 个 LoRA`);
    stageWrap.append(countBadge);

    // Quick Change Cover Button
    const quickCoverBtn = el("button", "aps-lora-stage-change-btn", "📷 换效果图");
    quickCoverBtn.type = "button";
    quickCoverBtn.title = "点击上传更换此预设的效果图";
    const cardCoverFileInput = el("input");
    cardCoverFileInput.type = "file";
    cardCoverFileInput.accept = "image/png,image/webp,image/jpeg";
    cardCoverFileInput.style.display = "none";
    card.append(cardCoverFileInput);

    quickCoverBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      cardCoverFileInput.click();
    });

    cardCoverFileInput.addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const b64 = reader.result;
          await api.saveLoraPreset({
            id: preset.id,
            name: preset.name,
            category: preset.category,
            tags: preset.tags,
            loras: preset.loras,
            trigger_words: preset.trigger_words,
            notes: preset.notes,
            image_data: b64,
          });
          loadPresets();
        } catch (err) {
          alert(`更换效果图失败：${err.message || err}`);
        }
      };
      reader.readAsDataURL(file);
      cardCoverFileInput.value = "";
    });

    stageWrap.append(quickCoverBtn);

    stageWrap.addEventListener("click", () => {
      openLoraPresetLightbox(preset, {
        api,
        onApply: (p) => {
          cleanup();
          if (typeof onApply === "function") onApply(p);
        },
        onUpdated: () => loadPresets(),
      });
    });

    card.append(stageWrap);

    // 2. Header: Title & Badges
    const headRow = el("div");
    headRow.style.display = "flex";
    headRow.style.justifyContent = "space-between";
    headRow.style.alignItems = "flex-start";
    headRow.style.gap = "8px";

    const title = el("div", "aps-preset-card-title", preset.name);
    title.style.fontWeight = "bold";
    title.style.fontSize = "14px";

    const badgeWrap = el("div");
    badgeWrap.style.display = "flex";
    badgeWrap.style.gap = "4px";

    const catBadge = el("span", "aps-badge aps-badge-blue", preset.category || "通用");
    catBadge.style.fontSize = "11px";
    catBadge.style.padding = "2px 6px";
    badgeWrap.append(catBadge);

    if (preset.is_builtin) {
      const builtinBadge = el("span", "aps-badge aps-badge-purple", "内置");
      builtinBadge.style.fontSize = "11px";
      builtinBadge.style.padding = "2px 6px";
      badgeWrap.append(builtinBadge);
    }
    headRow.append(title, badgeWrap);
    card.append(headRow);

    // LoRA stack list overview
    const stackOverview = el("div");
    stackOverview.style.background = "rgba(0, 0, 0, 0.2)";
    stackOverview.style.borderRadius = "4px";
    stackOverview.style.padding = "6px 8px";
    stackOverview.style.fontSize = "12px";

    const countLabel = el("div");
    countLabel.style.fontWeight = "bold";
    countLabel.style.marginBottom = "4px";
    countLabel.textContent = `🥞 ${formatLoraStackSummary(loras)}`;
    stackOverview.append(countLabel);

    const listUl = el("div");
    listUl.style.display = "flex";
    listUl.style.flexDirection = "column";
    listUl.style.gap = "2px";

    loras.slice(0, 4).forEach((item) => {
      const row = el("div");
      row.style.display = "flex";
      row.style.justifyContent = "space-between";
      row.style.opacity = item.enabled !== false ? "1" : "0.5";
      const nameSpan = el("span", "", `• ${item.name || "未命名"}`);
      nameSpan.style.overflow = "hidden";
      nameSpan.style.textOverflow = "ellipsis";
      nameSpan.style.whiteSpace = "nowrap";
      nameSpan.style.maxWidth = "170px";

      const weightSpan = el("span", "", `M:${item.strength_model} C:${item.strength_clip}`);
      weightSpan.style.opacity = "0.75";
      row.append(nameSpan, weightSpan);
      listUl.append(row);
    });
    if (loras.length > 4) {
      const more = el("div", "", `…还有 ${loras.length - 4} 个 LoRA`);
      more.style.opacity = "0.6";
      listUl.append(more);
    }
    stackOverview.append(listUl);
    card.append(stackOverview);

    // Trigger words snippet
    if (preset.trigger_words) {
      const twBox = el("div");
      twBox.style.fontSize = "12px";
      twBox.style.opacity = "0.8";
      twBox.style.display = "flex";
      twBox.style.justifyContent = "space-between";
      twBox.style.alignItems = "center";

      const twText = el("span", "", `触发词: ${preset.trigger_words.slice(0, 36)}${preset.trigger_words.length > 36 ? "…" : ""}`);
      const copyBtn = el("button", "aps-btn aps-btn-xs", "📋 复制");
      copyBtn.type = "button";
      copyBtn.title = "复制全部触发词";
      copyBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(preset.trigger_words);
        copyBtn.textContent = "✓ 已复制";
        setTimeout(() => { copyBtn.textContent = "📋 复制"; }, 1500);
      });
      twBox.append(twText, copyBtn);
      card.append(twBox);
    }

    // Actions Footer
    const footRow = el("div");
    footRow.style.marginTop = "auto";
    footRow.style.display = "flex";
    footRow.style.gap = "6px";
    footRow.style.paddingTop = "8px";

    const applyBtn = el("button", "aps-btn aps-btn-sm aps-primary", "⚡ 应用到节点");
    applyBtn.type = "button";
    applyBtn.style.flex = "1";
    applyBtn.addEventListener("click", () => {
      cleanup();
      if (typeof onApply === "function") {
        onApply(preset);
      }
    });

    const viewImgBtn = el("button", "aps-btn aps-btn-sm", "🖼");
    viewImgBtn.type = "button";
    viewImgBtn.title = "查看效果大图与全套参数";
    viewImgBtn.addEventListener("click", () => {
      openLoraPresetLightbox(preset, {
        api,
        onApply: (p) => {
          cleanup();
          if (typeof onApply === "function") onApply(p);
        },
        onUpdated: () => loadPresets(),
      });
    });

    const editBtn = el("button", "aps-btn aps-btn-sm", "✏");
    editBtn.type = "button";
    editBtn.title = "编辑该预设";
    editBtn.addEventListener("click", () => {
      openSaveLoraPresetModal({
        api,
        preset,
        onSaved: () => loadPresets(),
      });
    });

    const delBtn = el("button", "aps-btn aps-btn-sm", "🗑");
    delBtn.type = "button";
    delBtn.title = "删除此预设";
    delBtn.style.color = "#ff6b6b";
    delBtn.addEventListener("click", async () => {
      if (!confirm(`确定要删除 LoRA 预设「${preset.name}」吗？`)) return;
      try {
        await api.deleteLoraPreset(preset.id);
        loadPresets();
      } catch (err) {
        alert(`删除失败：${err.message || err}`);
      }
    });

    footRow.append(applyBtn, viewImgBtn, editBtn, delBtn);
    card.append(footRow);

    return card;
  }

  // Top Action Listeners
  searchInput.addEventListener("input", () => {
    searchKeyword = searchInput.value.trim();
    loadPresets();
  });

  newPresetBtn.addEventListener("click", () => {
    openSaveLoraPresetModal({
      api,
      onSaved: () => loadPresets(),
    });
  });

  // -------------------------------------------------------------------------
  // Drag & Drop Image Inspection (Explorer Style, matching prompt library)
  // -------------------------------------------------------------------------
  async function handleImportImageFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const b64 = reader.result;
      try {
        importImgBtn.textContent = "⏳ 解析中...";
        const res = await api.inspectImageLoras({ image_data: b64, filename: file.name });
        importImgBtn.textContent = "📷 识图导入";

        const hasLoras = Array.isArray(res.loras) && res.loras.length > 0;
        const targetCat = selectedCategory !== "全部" ? selectedCategory : "通用";

        openSaveLoraPresetModal({
          api,
          preset: {
            name: res.suggested_name || file.name.replace(/\.[^.]+$/, "") || "从图片提取的堆叠",
            category: targetCat,
            trigger_words: res.trigger_words || "",
            thumbnail: res.thumbnail || "",
          },
          initialLoras: hasLoras ? res.loras : [],
          initialTriggerWords: res.trigger_words || "",
          onSaved: () => loadPresets(),
        });

        if (!hasLoras) {
          setTimeout(() => {
            alert("已提取图片作为预设封面！但图片中未检测到内置的 LoRA 参数标签，您可以直接在弹窗中手动添加需要的 LoRA。");
          }, 300);
        }
      } catch (err) {
        importImgBtn.textContent = "📷 识图导入";
        console.error(err);
        alert("解析图片失败: " + (err.message || err));
      }
    };
    reader.readAsDataURL(file);
  }

  importImgBtn.addEventListener("click", () => imgPicker.click());
  imgPicker.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) handleImportImageFile(file);
    imgPicker.value = "";
  });

  // Drag and drop onto mainPane
  let dragCounter = 0;
  mainPane.addEventListener("dragenter", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter++;
    dropOverlay.style.display = "flex";
  });
  mainPane.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  mainPane.addEventListener("dragleave", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) {
      dropOverlay.style.display = "none";
    }
  });
  mainPane.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter = 0;
    dropOverlay.style.display = "none";
    const file = e.dataTransfer?.files?.[0];
    if (file && (file.type?.startsWith("image/") || file.name?.match(/\.(png|webp|jpe?g)$/i))) {
      handleImportImageFile(file);
    }
  });

  newCatBtn.addEventListener("click", async () => {
    const name = prompt("请输入新分类名称：");
    if (!name || !name.trim()) return;
    try {
      await api.addLoraPresetCategory(name.trim());
      loadCategories();
    } catch (err) {
      alert(`新建分类失败：${err.message || err}`);
    }
  });

  resetBuiltinsBtn.addEventListener("click", async () => {
    if (!confirm("确定要重新恢复所有默认内置的 LoRA 堆叠预设吗？")) return;
    try {
      await api.resetBuiltinLoraPresets();
      loadPresets();
    } catch (err) {
      alert(`恢复失败：${err.message || err}`);
    }
  });

  exportJsonBtn.addEventListener("click", async () => {
    try {
      const res = await api.exportLoraPresets();
      const blob = new Blob([JSON.stringify(res.presets || [], null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `lora_presets_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      alert(`导出失败：${err.message || err}`);
    }
  });

  importJsonBtn.addEventListener("click", () => {
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".json";
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        const list = Array.isArray(data) ? data : data.presets;
        if (!Array.isArray(list)) {
          alert("文件内容不符合预设 JSON 格式。");
          return;
        }
        await api.importLoraPresets(list);
        loadPresets();
      } catch (err) {
        alert(`导入失败：${err.message || err}`);
      }
    });
    fileInput.click();
  });

  // Initial load
  loadCategories();
  loadPresets();
}
