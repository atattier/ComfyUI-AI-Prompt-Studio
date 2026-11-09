/**
 * Dual-Column Studio Workbench & Interactive Layout Editor.
 *
 * Pure-DOM overlay attached to document.body: works identically on both
 * classic LiteGraph and Vue Node 2.0 frontends.
 *
 * Left Column:
 *   - True-aspect-ratio Reference Image + Interactive SVG Bounding Box Canvas
 *   - Inline Diff Review Card (never hides the chat stream)
 *   - Live Prompt & Region List Editor with Undo / Redo & JSON preview
 *
 * Right Column:
 *   - Unified Image Reverse-Engineering + One-Click Prompt Actions
 *     (Expand, Translate to EN, MOSS Rules, Tag Extract, Polish)
 *   - Multi-Turn Conversational Stream (keeps image + prompt context)
 *   - Unified Smart Composer (merges "Chat" & "Generate Edit" into one flow)
 */

import { StudioApi } from "./api.js";
import { describeOp, describeStats, selectOps } from "./diff.js";
import { fileToDataUrl } from "./images.js";
import { UndoStack } from "./undo.js";

const LABELS = ["object", "character", "text"];
const LABEL_NAMES = {
  object: "object (物体/背景)",
  character: "character (人物/主体)",
  text: "text (画面文字)",
};
export const BOX_COLORS = [
  "#2563eb", // 1 蓝 (如 咖啡厅内景)
  "#f59e0b", // 2 暖橙/金黄 (如 玻璃门)
  "#10b981", // 3 翠绿 (如 门上宣传海报)
  "#ec4899", // 4 品红 (如 海报标题)
  "#8b5cf6", // 5 紫 (如 光环)
  "#06b6d4", // 6 天青 (如 光之碎片翼)
  "#3b82f6", // 7 亮蓝 (如 红发少女)
  "#d97706", // 8 琥珀橙 (如 桌上宣传单)
  "#059669", // 9 墨绿 (如 宣传单文字)
  "#f43f5e", // 10 玫瑰红 (如 左下宣传单)
  "#a855f7", // 11 浅紫
  "#14b8a6", // 12 薄荷青
  "#e11d48", // 13 猩红
  "#eab308", // 14 明黄
  "#6366f1", // 15 靛蓝
  "#84cc16", // 16 嫩绿
];

const QUICK_ACTIONS = [
  {
    id: "expand",
    label: "✨ 扩写细节",
    title: "补充具象的画面光影、材质纹理、景深与构图描述",
    instruction:
      "Expand and enrich the prompt with concrete visual details (lighting, composition, textures, atmosphere) while preserving the core subject and style. Output in English.",
  },
  {
    id: "translate_en",
    label: "🌐 译为英文",
    title: "将中文描述或混合提示词准确翻译为自然、地道的英文提示词",
    instruction:
      "Translate all Chinese parts of the current prompt into natural, idiomatic English image-generation phrasing. Keep existing accurate English terms intact.",
  },
  {
    id: "moss_optimize",
    label: "🎯 MOSS 规则优化",
    title: "遵循 MOSS-Image 官方视觉扩写规范：描述客观可见选择，移除权重括号与冗余词，精确引用文字",
    instruction:
      "Optimize this prompt according to official MOSS-Image conventions: describe concrete visible choices (subject, appearance, setting, camera framing, lighting, materials, palette, mood), strictly preserve explicit user intent and quote visible text verbatim in double quotes, remove (tag:weight) parentheses and generic quality tags, without adding invisible process notes.",
  },
  {
    id: "polish",
    label: "🧹 精简润色",
    title: "清理重复词与冗余修饰，使语句紧凑清晰",
    instruction:
      "Clean up redundant words, duplicate phrases, and contradictory modifiers in the prompt while keeping all key visual information concise and vivid.",
  },
  {
    id: "to_tags",
    label: "🏷 转逗号标签",
    title: "将散文描述提炼为逗号分隔的图像生成标签",
    instruction:
      "Convert the prompt into clean, comma-separated English image generation tags ordered from subject and appearance to environment, lighting, and camera.",
  },
  {
    id: "moss_cinematic",
    label: "🎞 电影胶片质感",
    title: "应用 MOSS 官方 A 级实测电影摄影语法：注入 35mm 胶片硬直闪、暗角、真实光学景深与微观毛孔",
    instruction:
      "Rewrite this prompt using MOSS-Image authentic cinema/analog film photography conventions: prepend concrete optical traits (raw 35mm film photograph, harsh direct on-camera flash, hard drop shadow, razor-sharp focus, deep depth of field), describe specific physical lighting falloff, and finish with texture lock (unretouched real human skin texture with microscopic pores, organic Kodak film grain). Keep prompt in English.",
  },
  {
    id: "moss_anti_bleed",
    label: "🛡 肢体防崩/防撞脸",
    title: "MOSS A 级实测防崩坏规范：衣服拉扯转静态结果防多手、多人因果阻断防双胞胎",
    instruction:
      "Audit and repair this prompt for MOSS-Image stability: 1) Convert dynamic garment pulling/lifting verbs into completed static states (e.g. 'shirt already pushed up') so the model does not draw extra hands. 2) If multiple subjects exist, put primary character first and begin secondary character with causal blocking ('In sharp contrast, the second person has NO...'). 3) Anchor viewer perspective (viewer's left vs right) for asymmetrical poses.",
  },
];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

function cloneDraft(state, width, height) {
  const draft = state?.draft || state?.layout_draft || state?.hybrid_draft;
  if (draft && Array.isArray(draft.items) && draft.items.length) {
    return {
      width: draft.width || width,
      height: draft.height || height,
      bbox_coord_space: "abs",
      bbox_format: "xyxy",
      summary: { caption: String(draft.summary?.caption || state?.caption || ""), canvas: "single" },
      items: draft.items.map((it) => ({
        name: String(it.name || ""),
        parent: String(it.parent || ""),
        label: LABELS.includes(it.label) ? it.label : "object",
        caption: String(it.caption || ""),
        text: String(it.text || ""),
        bbox:
          Array.isArray(it.bbox) && it.bbox.length === 4
            ? it.bbox.map((v) => Number(v) || 0)
            : [0, 0, width, height],
      })),
    };
  }
  return {
    width,
    height,
    bbox_coord_space: "abs",
    bbox_format: "xyxy",
    summary: { caption: String(state?.caption || ""), canvas: "single" },
    items: [],
  };
}

export function normalizeDraft(draft, width, height) {
  const out = cloneDraft({ draft }, width, height);
  out.width = width;
  out.height = height;
  out.items = out.items.map((it, idx) => {
    let [x1, y1, x2, y2] = it.bbox.map(Math.round);
    x1 = clamp(x1, 0, width - 2);
    y1 = clamp(y1, 0, height - 2);
    x2 = clamp(x2, x1 + 1, width);
    y2 = clamp(y2, y1 + 1, height);
    it.bbox = [x1, y1, x2, y2];
    if (!it.caption.trim()) it.caption = `Region ${idx + 1}`;
    if (it.label === "text") {
      if (!it.text.trim()) it.text = it.caption;
    } else {
      delete it.text;
    }
    return it;
  });
  if (!out.summary.caption.trim()) out.summary.caption = "A composed image.";
  return out;
}

function createSvg(width, height) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.style.width = "100%";
  svg.style.height = "100%";
  return svg;
}

function svgRect(NS, x, y, w, h, attrs = {}) {
  const rect = document.createElementNS(NS, "rect");
  rect.setAttribute("x", x);
  rect.setAttribute("y", y);
  rect.setAttribute("width", w);
  rect.setAttribute("height", h);
  for (const [k, v] of Object.entries(attrs)) rect.setAttribute(k, v);
  return rect;
}

/**
 * Render the SVG stage with optional background reference image and bounding boxes.
 * Shared by both the in-node preview card and the dual-column workbench.
 */
export function renderSvgStage(svg, { width, height, draft, imageUrl, selected = -1, showBoxes = true, dimImage = false }) {
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.textContent = "";
  const NS = "http://www.w3.org/2000/svg";

  // Base dark canvas rect
  svg.append(
    svgRect(NS, 0, 0, width, height, {
      fill: "#0f1318",
      stroke: "#343b44",
      "stroke-width": 2,
    }),
  );

  // Reference image layer underneath boxes
  if (imageUrl) {
    const img = document.createElementNS(NS, "image");
    img.setAttribute("href", imageUrl);
    img.setAttribute("x", "0");
    img.setAttribute("y", "0");
    img.setAttribute("width", String(width));
    img.setAttribute("height", String(height));
    img.setAttribute("preserveAspectRatio", "none");
    if (dimImage) img.setAttribute("opacity", "0.52");
    img.style.pointerEvents = "none";
    svg.append(img);
  } else {
    // Beautiful empty state / dropzone prompt
    const border = svgRect(NS, 28, 28, Math.max(10, width - 56), Math.max(10, height - 56), {
      fill: "none",
      stroke: "rgba(56, 189, 248, 0.4)",
      "stroke-width": 3,
      "stroke-dasharray": "12 8",
      rx: 16,
    });
    border.style.pointerEvents = "none";
    svg.append(border);

    const midX = Math.round(width / 2);
    const midY = Math.round(height / 2);
    const mainFontSize = Math.max(22, Math.round(width / 28));
    const subFontSize = Math.max(14, Math.round(width / 44));

    const textMain = document.createElementNS(NS, "text");
    textMain.setAttribute("x", String(midX));
    textMain.setAttribute("y", String(midY - 12));
    textMain.setAttribute("text-anchor", "middle");
    textMain.setAttribute("fill", "#e2e8f0");
    textMain.setAttribute("font-size", String(mainFontSize));
    textMain.setAttribute("font-weight", "700");
    textMain.setAttribute("font-family", '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Microsoft YaHei", sans-serif');
    textMain.textContent = "📥 拖拽图片至此，或按 Ctrl+V 粘贴";
    textMain.style.pointerEvents = "none";

    const textSub = document.createElementNS(NS, "text");
    textSub.setAttribute("x", String(midX));
    textSub.setAttribute("y", String(midY + subFontSize + 14));
    textSub.setAttribute("text-anchor", "middle");
    textSub.setAttribute("fill", "#94a3b8");
    textSub.setAttribute("font-size", String(subFontSize));
    textSub.setAttribute("font-weight", "500");
    textSub.setAttribute("font-family", '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Microsoft YaHei", sans-serif');
    textSub.textContent = "也可点击工具栏「换图」或连接上游 LoadImage 节点";
    textSub.style.pointerEvents = "none";

    svg.append(textMain, textSub);
  }

  if (!showBoxes || !draft || !Array.isArray(draft.items)) return;

  draft.items.forEach((item, index) => {
    const [x1, y1, x2, y2] = item.bbox;
    const color = BOX_COLORS[index % BOX_COLORS.length];
    const isSel = selected === index;
    const group = document.createElementNS(NS, "g");
    group.setAttribute("data-index", index);
    group.style.cursor = "move";

    const bw = Math.max(1, x2 - x1);
    const bh = Math.max(1, y2 - y1);
    const strokeW = isSel ? Math.max(3.5, Math.round(width / 260)) : Math.max(1.8, Math.round(width / 440));

    // Outer subtle contrast halo (crisp solid outline, NO dashed lines, matching KohakuGBC)
    const haloRect = svgRect(NS, x1, y1, bw, bh, {
      fill: "none",
      stroke: "rgba(10, 15, 29, 0.76)",
      "stroke-width": strokeW + Math.max(1.5, Math.round(width / 460)),
    });
    haloRect.style.pointerEvents = "none";
    group.append(haloRect);

    // Main solid color bounding box (solid stroke, pure & clean, subtle glass fill)
    const rect = svgRect(NS, x1, y1, bw, bh, {
      fill: isSel ? color + "2b" : color + "0d",
      stroke: color,
      "stroke-width": strokeW,
    });
    group.append(rect);

    // Adaptive, elegant typography & pill badge (matching KohakuGBC professional aesthetic)
    const fontSize = Math.max(13, Math.round(width / 52));
    const semanticName = item.name || (item.label === "character" ? "人物主体" : (item.label === "text" ? (item.text ? `文字「${item.text.slice(0, 8)}」` : "画面文字") : "场景物体"));
    const badgeText = `${index + 1} ${semanticName}`;

    let textUnits = 0;
    for (const ch of badgeText) {
      textUnits += ch.charCodeAt(0) > 255 ? 1.02 : 0.58;
    }
    const badgeW = Math.min(bw, Math.max(fontSize * 2.8, Math.round(textUnits * fontSize + fontSize * 0.9)));
    const badgeH = Math.round(fontSize * 1.48);

    // Clean, modern, solid-color pill badge pinned at top-left
    const badgeBg = svgRect(NS, x1, y1, badgeW, badgeH, {
      fill: color,
      stroke: "rgba(15, 23, 42, 0.4)",
      "stroke-width": 1,
      rx: 3,
      ry: 3,
    });
    badgeBg.style.pointerEvents = "none";
    group.append(badgeBg);

    const label = document.createElementNS(NS, "text");
    label.setAttribute("x", x1 + Math.round(fontSize * 0.42));
    label.setAttribute("y", y1 + Math.round(fontSize * 1.08));
    label.setAttribute("fill", "#ffffff");
    label.setAttribute("font-size", fontSize);
    label.setAttribute("font-weight", "600");
    label.setAttribute("font-family", '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif');
    label.textContent = badgeText;
    label.style.pointerEvents = "none";
    group.append(label);

    // Only render resize handle when selected to keep canvas ultra-clean
    if (isSel) {
      const hs = Math.max(16, Math.round(width / 60));
      const handle = svgRect(NS, x2 - hs, y2 - hs, hs, hs, {
        fill: color,
        stroke: "#ffffff",
        "stroke-width": 2,
        rx: 3,
        ry: 3,
      });
      handle.setAttribute("data-resize", String(index));
      handle.style.cursor = "nwse-resize";
      group.append(handle);
    }
    svg.append(group);
  });
}

/**
 * Open the Dual-Column Studio Workbench (also backwards-compatible with openLayoutEditor).
 * @param {object} opts
 *   state: current payload (plain object),
 *   mode: caption|layout|hybrid,
 *   imageUrl?: string,
 *   api?: StudioApi,
 *   sessionId?: string,
 *   onSessionChange?: (id: string) => void,
 *   onImageChange?: (dataUrl: string) => void,
 *   onApply: (newState) => void,
 *   onCancel?: () => void
 * @returns {{close: () => void}} handle
 */
export function openLayoutEditor({
  state = {},
  mode = "layout",
  imageUrl = null,
  api: suppliedApi = null,
  sessionId: initialSessionId = null,
  onSessionChange = null,
  onImageChange = null,
  onApply,
  onCancel,
}) {
  const api = suppliedApi || new StudioApi();
  let width = Math.max(16, Number(state.width) || 1024);
  let height = Math.max(16, Number(state.height) || 1024);
  let currentMode = ["caption", "layout", "hybrid"].includes(mode) ? mode : "layout";
  let selectedModes = Array.isArray(state.modes) && state.modes.length
    ? state.modes.filter((m) => ["caption", "layout", "hybrid"].includes(m))
    : [currentMode];
  if (!selectedModes.includes(currentMode)) selectedModes.push(currentMode);
  let currentImageUrl = imageUrl || state.imageDataUrl || null;
  let dimImage = false;
  let drawMode = false;
  let sessionId = initialSessionId || state.sessionId || null;

  // Working copy of draft & caption: 取消 discards it; 应用 commits it.
  const draft = cloneDraft(state, width, height);
  let captionText = String(state.caption || draft.summary?.caption || "");
  if (draft.summary && !draft.summary.caption && captionText) {
    draft.summary.caption = captionText;
  }

  const undoStack = new UndoStack({ limit: 50 });
  // Target for AI edits: "summary" (main prompt / summary.caption) or region index "region:0", etc.
  let activeEditTarget = "summary";
  let activeProposal = null;
  let chatMessages = [];
  let chatIntent = "edit"; // "edit" (auto-diff) | "chat" (Q&A)
  let reverseFormat = "node_mode"; // "node_mode" | "prose" | "tags" | "moss"
  let busy = false;
  let streamController = null;

  const overlay = el("div", "aps-modal-overlay");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  const modal = el("div", "aps-modal aps-workbench-modal");

  // =================================================================== HEADER
  const head = el("div", "aps-modal-head aps-wb-head");
  const titleWrap = el("div", "aps-wb-brand");
  titleWrap.append(
    el("span", "aps-logo", "✳"),
    el("div", "aps-modal-title", currentMode === "caption" ? "编辑反推描述" : "编辑布局"),
  );

  // Mode Segmented Switcher inside Workbench (supports checking 1~3 modes simultaneously)
  const modeSwitch = el("div", "aps-seg-group");
  const modeButtons = {};
  const modeCheckboxes = {};
  function syncModeButtonsUI() {
    for (const [k, btn] of Object.entries(modeButtons)) {
      btn.classList.toggle("is-active", k === currentMode);
      const isChecked = selectedModes.includes(k);
      btn.classList.toggle("is-checked", isChecked);
      if (modeCheckboxes[k]) modeCheckboxes[k].textContent = isChecked ? "☑" : "☐";
    }
  }
  for (const [mKey, mLabel] of [
    ["caption", "📝 Caption 散文"],
    ["layout", "📐 Layout 布局"],
    ["hybrid", "✨ Hybrid 混合"],
  ]) {
    const btn = el("button", "aps-seg-btn aps-mode-multi-btn");
    btn.type = "button";
    btn.title = "点击勾选框 ☑/☐：启用/关闭该输出端口格式（支持 1~3 个同时输出）\n点击文字：切换到该模式预览/编辑";
    const chk = el("span", "aps-mode-check", selectedModes.includes(mKey) ? "☑" : "☐");
    chk.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (selectedModes.includes(mKey)) {
        if (selectedModes.length <= 1) return;
        selectedModes = selectedModes.filter((m) => m !== mKey);
        if (currentMode === mKey) switchMode(selectedModes[0]);
      } else {
        selectedModes = ["caption", "layout", "hybrid"].filter(
          (m) => selectedModes.includes(m) || m === mKey,
        );
      }
      syncModeButtonsUI();
    });
    const lbl = el("span", "aps-mode-label", mLabel);
    btn.append(chk, lbl);
    btn.addEventListener("click", () => {
      if (!selectedModes.includes(mKey)) {
        selectedModes = ["caption", "layout", "hybrid"].filter(
          (m) => selectedModes.includes(m) || m === mKey,
        );
      }
      switchMode(mKey);
    });
    modeButtons[mKey] = btn;
    modeCheckboxes[mKey] = chk;
    modeSwitch.append(btn);
  }
  syncModeButtonsUI();

  const sizeNote = el("span", "aps-modal-note", `${width} × ${height}（16 倍数）`);

  // Aspect ratio / resolution quick preset selector
  const sizeSelect = el("select", "aps-select aps-wb-size-select");
  sizeSelect.title = "切换 MOSS 16 倍数画布尺寸";
  const presets = [
    [`${width}x${height}`, `当前 ${width}×${height}`],
    ["1024x1024", "1:1 · 1024×1024"],
    ["1216x832", "3:2 · 1216×832"],
    ["832x1216", "2:3 · 832×1216"],
    ["1344x768", "16:9 · 1344×768"],
    ["768x1344", "9:16 · 768×1344"],
    ["1152x896", "4:3 · 1152×896"],
    ["896x1152", "3:4 · 896×1152"],
  ];
  const seenSizes = new Set();
  for (const [val, label] of presets) {
    if (seenSizes.has(val)) continue;
    seenSizes.add(val);
    const opt = el("option", "", label);
    opt.value = val;
    sizeSelect.append(opt);
  }
  sizeSelect.value = `${width}x${height}`;
  sizeSelect.addEventListener("change", () => {
    const [nw, nh] = sizeSelect.value.split("x").map(Number);
    if (nw > 0 && nh > 0 && (nw !== width || nh !== height)) {
      const sx = nw / width;
      const sy = nh / height;
      width = nw;
      height = nh;
      draft.width = width;
      draft.height = height;
      draft.items.forEach((it) => {
        it.bbox = [
          clamp(Math.round(it.bbox[0] * sx), 0, width - 2),
          clamp(Math.round(it.bbox[1] * sy), 0, height - 2),
          clamp(Math.round(it.bbox[2] * sx), 2, width),
          clamp(Math.round(it.bbox[3] * sy), 2, height),
        ];
      });
      sizeNote.textContent = `${width} × ${height}（16 倍数）`;
      updateCanvasAspect();
      renderBoxes();
      renderList();
    }
  });

  const undoBtn = el("button", "aps-btn aps-btn-sm", "↩ 撤销");
  undoBtn.type = "button";
  undoBtn.disabled = true;
  const redoBtn = el("button", "aps-btn aps-btn-sm", "↪ 重做");
  redoBtn.type = "button";
  redoBtn.disabled = true;

  const settingsBtn = el("button", "aps-btn aps-btn-sm", "⚙ 设置");
  settingsBtn.type = "button";
  settingsBtn.title = "配置模型网关（Base URL / API Key / 模型选择）与提示词反推规则";
  settingsBtn.addEventListener("click", () => {
    openSettingsModal({
      api,
      onSaved: (cfg) => {
        setStatus(`已更新设置：模型 ${cfg?.model || ""} · 规则 ${cfg?.rule_preset || "moss"}`);
      },
    });
  });

  const headRight = el("div", "aps-wb-head-right");
  headRight.append(modeSwitch, sizeSelect, sizeNote, undoBtn, redoBtn, settingsBtn);
  head.append(titleWrap, headRight);
  modal.append(head);

  // ===================================================================== BODY
  const body = el("div", "aps-modal-body aps-wb-columns");

  // -------------------------------------------------------------- LEFT COLUMN
  const leftCol = el("div", "aps-wb-left");

  // 1) Visual Stage Card (Reference Image + Interactive SVG BBoxes)
  const stageToolbar = el("div", "aps-wb-stage-toolbar");
  const imgBadge = el(
    "span",
    "aps-wb-stage-badge",
    currentImageUrl ? "🖼 已加载参考底图" : "📷 可上传参考图或直接编辑",
  );
  const uploadInput = el("input", "");
  uploadInput.type = "file";
  uploadInput.accept = "image/*";
  uploadInput.hidden = true;
  const uploadBtn = el("button", "aps-btn aps-btn-sm", "📂 上传/换图");
  uploadBtn.type = "button";
  uploadBtn.addEventListener("click", () => uploadInput.click());
  uploadInput.addEventListener("change", async () => {
    const file = uploadInput.files?.[0];
    uploadInput.value = "";
    if (!file) return;
    try {
      const dataUrl = await fileToDataUrl(file);
      currentImageUrl = dataUrl;
      imgBadge.textContent = `🖼 ${file.name}`;
      onImageChange?.(dataUrl);
      updateStageVisibility();
      renderBoxes();
      setStatus(`已载入参考图：${file.name}`);
    } catch (err) {
      setStatus(String(err?.message || err), true);
    }
  });

  const drawBtn = el("button", "aps-btn aps-btn-sm", "➕ 画布拉框");
  drawBtn.type = "button";
  drawBtn.title = "开启后可在图片空白处直接按住鼠标拖拽画出新区域框（或按住 Shift 拖拽）";
  drawBtn.addEventListener("click", () => {
    drawMode = !drawMode;
    drawBtn.classList.toggle("is-active", drawMode);
    svg.style.cursor = drawMode ? "crosshair" : "";
  });

  const dimBtn = el("button", "aps-btn aps-btn-sm", "🌓 压暗底图");
  dimBtn.type = "button";
  dimBtn.title = "降低参考图亮度以便更清晰地查看区域框线";
  dimBtn.addEventListener("click", () => {
    dimImage = !dimImage;
    dimBtn.classList.toggle("is-active", dimImage);
    renderBoxes();
  });

  stageToolbar.append(imgBadge, uploadBtn, drawBtn, dimBtn, uploadInput);

  const canvasWrap = el("div", "aps-layout-canvas-wrap");
  canvasWrap.addEventListener("dragenter", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    canvasWrap.classList.add("is-drag-over");
  });
  canvasWrap.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    canvasWrap.classList.add("is-drag-over");
  });
  canvasWrap.addEventListener("dragleave", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    canvasWrap.classList.remove("is-drag-over");
  });
  canvasWrap.addEventListener("drop", async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    canvasWrap.classList.remove("is-drag-over");
    const file = ev.dataTransfer?.files?.[0];
    if (!file || !String(file.type || "").startsWith("image/")) return;
    try {
      const dataUrl = await fileToDataUrl(file);
      currentImageUrl = dataUrl;
      imgBadge.textContent = `🖼 ${file.name}`;
      onImageChange?.(dataUrl);
      updateStageVisibility();
      renderBoxes();
      setStatus(`已拖入并加载参考图：${file.name}`);
    } catch (err) {
      setStatus(String(err?.message || err), true);
    }
  });
  const svg = createSvg(width, height);
  canvasWrap.append(svg);

  const captionRefWrap = el("div", "aps-wb-caption-ref");
  const captionRefImg = el("img", "aps-wb-caption-ref-img");
  captionRefImg.alt = "参考图片预览";
  captionRefWrap.append(captionRefImg);

  function updateCanvasAspect() {
    canvasWrap.style.aspectRatio = `${width} / ${height}`;
  }
  function updateStageVisibility() {
    const hasLayout = currentMode !== "caption";
    canvasWrap.hidden = !hasLayout;
    captionRefWrap.hidden = hasLayout || !currentImageUrl;
    if (currentImageUrl) captionRefImg.src = currentImageUrl;
    drawBtn.hidden = !hasLayout;
    dimBtn.hidden = !hasLayout || !currentImageUrl;
  }
  updateCanvasAspect();
  updateStageVisibility();

  // 2) Inline Diff Host (shows AI edit proposals right above the editor)
  const diffHost = el("div", "aps-wb-diff-host");

  // 3) Prompt & Region Editor
  const capField = el("label", "aps-modal-field");
  const capFieldHead = el("div", "aps-wb-field-head");
  const capFieldLabel = el(
    "span",
    "aps-wb-field-title",
    currentMode === "caption" ? "描述文本" : "整体描述（summary.caption）",
  );
  const copyPromptBtn = el("button", "aps-btn aps-btn-sm", "📋 复制");
  copyPromptBtn.type = "button";
  copyPromptBtn.addEventListener("click", () => {
    const textToCopy = getCurrentPromptText();
    globalThis.navigator?.clipboard?.writeText?.(textToCopy);
    setStatus("已复制当前提示词到剪贴板。");
  });
  capFieldHead.append(capFieldLabel, copyPromptBtn);

  const capArea = el("textarea", "aps-modal-textarea");
  capArea.value = captionText;
  capArea.rows = currentMode === "caption" ? 6 : 3;
  capArea.placeholder = "在此直接编写或修改英文/中文提示词，或使用右侧 AI 助手反推、扩写与对话微调…";
  capArea.addEventListener("focus", () => {
    setEditTarget("summary");
  });
  capArea.addEventListener("change", () => {
    recordTextChange("summary", captionText, capArea.value, "手动编辑描述");
    captionText = capArea.value;
    if (draft.summary) draft.summary.caption = captionText;
    updateJsonPreview();
  });
  capArea.addEventListener("input", () => {
    captionText = capArea.value;
    if (draft.summary) draft.summary.caption = captionText;
    updateJsonPreview();
  });
  capField.append(capFieldHead, capArea);

  const listHost = el("div", "aps-layout-list");
  listHost.hidden = currentMode === "caption";

  const jsonPreviewWrap = el("details", "aps-wb-json-details");
  jsonPreviewWrap.hidden = currentMode === "caption";
  const jsonSummary = el("summary", "aps-wb-json-summary", "查看 PromptBoard 编译草稿 JSON");
  const jsonPre = el("pre", "aps-wb-json-pre", "");
  jsonPreviewWrap.append(jsonSummary, jsonPre);

  leftCol.append(stageToolbar, canvasWrap, captionRefWrap, diffHost, capField, listHost, jsonPreviewWrap);

  // ------------------------------------------------------------- RIGHT COLUMN
  const rightCol = el("div", "aps-wb-right");

  // 1) Top Reverse-Engineering & One-Click Quick Action Bar
  const quickPanel = el("div", "aps-wb-quick-panel");

  // Reverse-engineering row
  const captionRow = el("div", "aps-wb-caption-row");
  const formatSelect = el("select", "aps-select aps-wb-format-select");
  for (const [fVal, fText] of [
    ["node_mode", "按当前模式反推（自动匹配尺寸+布局/散文）"],
    ["prose", "自然语言长描述 (Prose)"],
    ["tags", "逗号分隔标签 (Danbooru/SD Tags)"],
    ["moss", "MOSS-Image 风格段落"],
  ]) {
    const opt = el("option", "", fText);
    opt.value = fVal;
    formatSelect.append(opt);
  }
  formatSelect.value = reverseFormat;
  formatSelect.addEventListener("change", () => {
    reverseFormat = formatSelect.value;
  });

  const runCaptionBtn = el("button", "aps-btn aps-primary aps-wb-caption-btn", "🖼 反推参考图");
  runCaptionBtn.type = "button";
  runCaptionBtn.title = "读取当前参考图生成提示词/布局，并自动加入下方对话上下文以便继续追问修改";
  runCaptionBtn.addEventListener("click", () => handleRunCaption());
  captionRow.append(formatSelect, runCaptionBtn);

  // Quick AI Refinement Chips
  const chipsRow = el("div", "aps-wb-chips-row");
  for (const action of QUICK_ACTIONS) {
    const chip = el("button", "aps-chip-btn", action.label);
    chip.type = "button";
    chip.title = action.title;
    chip.addEventListener("click", () => runQuickAction(action));
    chipsRow.append(chip);
  }
  quickPanel.append(captionRow, chipsRow);

  // 2) Multi-Turn Conversation Stream
  const chatStream = el("div", "aps-wb-messages");

  // 3) Unified Smart Composer (replaces the split Send vs Generate Edit buttons)
  const composerWrap = el("div", "aps-wb-composer");
  const composerMeta = el("div", "aps-wb-composer-meta");

  const intentToggle = el("div", "aps-intent-group");
  const intentEditBtn = el("button", "aps-intent-btn is-active", "✦ 智能改词 (生成Diff)");
  intentEditBtn.type = "button";
  intentEditBtn.title = "发送后直接针对左侧提示词生成可审阅的局部修改提案，同时在对话中解释修改原因";
  const intentChatBtn = el("button", "aps-intent-btn", "💬 纯问答");
  intentChatBtn.type = "button";
  intentChatBtn.title = "仅在对话区流式回答问题，不自动改动提示词";

  intentEditBtn.addEventListener("click", () => {
    chatIntent = "edit";
    intentEditBtn.classList.add("is-active");
    intentChatBtn.classList.remove("is-active");
    sendBtn.textContent = "发送改词 ✦";
  });
  intentChatBtn.addEventListener("click", () => {
    chatIntent = "chat";
    intentChatBtn.classList.add("is-active");
    intentEditBtn.classList.remove("is-active");
    sendBtn.textContent = "发送提问";
  });
  intentToggle.append(intentEditBtn, intentChatBtn);

  const targetIndicator = el("span", "aps-wb-target-pill", "当前目标：整体描述");
  const clearChatBtn = el("button", "aps-link", "新对话");
  clearChatBtn.type = "button";
  clearChatBtn.addEventListener("click", () => {
    chatMessages = [];
    sessionId = null;
    renderChatMessages();
    setStatus("已开启新对话上下文。");
  });
  composerMeta.append(intentToggle, targetIndicator, clearChatBtn);

  const composerRow = el("div", "aps-wb-composer-row");
  const composerInput = el("textarea", "aps-composer-input aps-wb-composer-input");
  composerInput.rows = 2;
  composerInput.placeholder =
    "直接输入修改指令（如：把背景改成雨夜霓虹 / 给人物加上银色短发 / 翻译成英文）… Ctrl+Enter 发送";
  composerInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey || !ev.shiftKey)) {
      ev.preventDefault();
      handleSendComposer();
    }
  });

  const stopStreamBtn = el("button", "aps-btn", "⏹ 停止");
  stopStreamBtn.type = "button";
  stopStreamBtn.hidden = true;
  stopStreamBtn.addEventListener("click", () => streamController?.abort());

  const sendBtn = el("button", "aps-btn aps-primary aps-wb-send-btn", "发送改词 ✦");
  sendBtn.type = "button";
  sendBtn.addEventListener("click", () => handleSendComposer());

  composerRow.append(composerInput, stopStreamBtn, sendBtn);
  composerWrap.append(composerMeta, composerRow);

  rightCol.append(quickPanel, chatStream, composerWrap);
  body.append(leftCol, rightCol);

  // =================================================================== FOOTER
  const foot = el("div", "aps-modal-foot");
  const status = el("span", "aps-modal-status", "");
  const cancelBtn = el("button", "aps-btn", "取消");
  cancelBtn.type = "button";
  const applyBtn = el("button", "aps-btn aps-primary", "应用");
  applyBtn.type = "button";
  foot.append(status, cancelBtn, applyBtn);

  modal.append(body, foot);
  overlay.append(modal);
  document.body.append(overlay);

  // ========================================================== STATE & HELPERS
  let selected = -1;
  let pointerDrag = null;

  function setStatus(msg, isError = false) {
    status.textContent = msg || "";
    status.dataset.kind = isError ? "error" : "ok";
  }

  function setBusyState(nextBusy, msg = "") {
    busy = nextBusy;
    runCaptionBtn.disabled = nextBusy;
    sendBtn.disabled = nextBusy;
    stopStreamBtn.hidden = !streamController;
    if (msg) setStatus(msg);
  }

  function getCurrentPromptText() {
    if (activeEditTarget.startsWith("region:")) {
      const idx = Number(activeEditTarget.split(":")[1]);
      if (draft.items[idx]) return draft.items[idx].caption || "";
    }
    return capArea.value;
  }

  function setCurrentPromptText(nextText, label = "AI 修改") {
    if (activeEditTarget.startsWith("region:")) {
      const idx = Number(activeEditTarget.split(":")[1]);
      if (draft.items[idx]) {
        const before = draft.items[idx].caption || "";
        recordTextChange(activeEditTarget, before, nextText, label);
        draft.items[idx].caption = nextText;
        renderList();
        updateJsonPreview();
        return;
      }
    }
    const before = capArea.value;
    recordTextChange("summary", before, nextText, label);
    capArea.value = nextText;
    captionText = nextText;
    if (draft.summary) draft.summary.caption = nextText;
    updateJsonPreview();
  }

  function setEditTarget(targetKey) {
    activeEditTarget = targetKey;
    if (targetKey.startsWith("region:")) {
      const idx = Number(targetKey.split(":")[1]);
      const item = draft.items[idx];
      targetIndicator.textContent = item ? `当前目标：区域 #${idx + 1} (${item.label})` : "当前目标：整体描述";
    } else {
      targetIndicator.textContent = currentMode === "caption" ? "当前目标：主提示词" : "当前目标：整体描述 (summary)";
    }
  }

  function recordTextChange(key, before, after, label) {
    if (before === after) return;
    undoStack.record({ key, before, after, label, source: "workbench" });
    updateUndoButtons();
  }

  function updateUndoButtons() {
    undoBtn.disabled = !undoStack.canUndo;
    redoBtn.disabled = !undoStack.canRedo;
  }

  undoBtn.addEventListener("click", () => {
    const entry = undoStack.undo();
    if (!entry) return;
    applyUndoEntry(entry.key, entry.before);
    updateUndoButtons();
    setStatus(`已撤销：${entry.label || "上一步修改"}`);
  });

  redoBtn.addEventListener("click", () => {
    const entry = undoStack.redo();
    if (!entry) return;
    applyUndoEntry(entry.key, entry.after);
    updateUndoButtons();
    setStatus(`已重做：${entry.label || "修改"}`);
  });

  function applyUndoEntry(key, value) {
    if (key.startsWith("region:")) {
      const idx = Number(key.split(":")[1]);
      if (draft.items[idx]) {
        draft.items[idx].caption = value;
        renderList();
      }
    } else {
      capArea.value = value;
      captionText = value;
      if (draft.summary) draft.summary.caption = value;
    }
    updateJsonPreview();
  }

  function switchMode(nextMode) {
    if (!["caption", "layout", "hybrid"].includes(nextMode)) return;
    currentMode = nextMode;
    syncModeButtonsUI();
    const hasLayout = currentMode !== "caption";
    titleWrap.querySelector(".aps-modal-title").textContent =
      currentMode === "caption" ? "编辑反推描述" : "编辑布局";
    capFieldLabel.textContent =
      currentMode === "caption" ? "描述文本" : "整体描述（summary.caption）";
    capArea.rows = currentMode === "caption" ? 6 : 3;
    listHost.hidden = !hasLayout;
    jsonPreviewWrap.hidden = !hasLayout;
    if (!hasLayout) setEditTarget("summary");
    updateStageVisibility();
    renderBoxes();
    renderList();
    updateJsonPreview();
  }

  function updateJsonPreview() {
    if (currentMode === "caption") return;
    const previewDraft = normalizeDraft(
      { ...draft, summary: { ...draft.summary, caption: capArea.value || draft.summary.caption } },
      width,
      height,
    );
    jsonPre.textContent = JSON.stringify(previewDraft, null, 2);
  }

  // ===================================================== SVG & LIST RENDERING
  function renderBoxes() {
    const hasLayout = currentMode !== "caption";
    renderSvgStage(svg, {
      width,
      height,
      draft,
      imageUrl: currentImageUrl,
      selected,
      showBoxes: hasLayout,
      dimImage,
    });
  }

  function renderList() {
    listHost.textContent = "";
    if (currentMode === "caption") return;

    const toolbar = el("div", "aps-layout-toolbar");
    const addBtn = el("button", "aps-btn", "+ 加区域");
    addBtn.type = "button";
    addBtn.addEventListener("click", () => {
      const w = Math.round(width * 0.35);
      const h = Math.round(height * 0.35);
      const offset = (draft.items.length % 4) * 32;
      const x1 = clamp(Math.round(width * 0.25) + offset, 0, width - w);
      const y1 = clamp(Math.round(height * 0.25) + offset, 0, height - h);
      draft.items.push({
        label: "object",
        caption: "New region",
        text: "",
        bbox: [x1, y1, x1 + w, y1 + h],
      });
      selected = draft.items.length - 1;
      setEditTarget(`region:${selected}`);
      renderBoxes();
      renderList();
      updateJsonPreview();
    });
    const regionHint = el(
      "span",
      "aps-hint",
      `共 ${draft.items.length} 个区域（点击区域可在画布高亮并可用右侧 AI 单独微调）`,
    );
    toolbar.append(addBtn, regionHint);
    listHost.append(toolbar);

    draft.items.forEach((item, index) => {
      const isSel = selected === index;
      const row = el("div", "aps-layout-item" + (isSel ? " is-active" : ""));
      const idx = el("span", "aps-layout-index", String(index + 1));
      idx.style.color = BOX_COLORS[index % BOX_COLORS.length];
      row.append(idx);

      const labelSel = el("select", "aps-select");
      for (const name of LABELS) {
        const option = el("option", "", name);
        option.value = name;
        option.title = LABEL_NAMES[name] || name;
        labelSel.append(option);
      }
      labelSel.value = item.label;
      labelSel.addEventListener("change", () => {
        item.label = labelSel.value;
        renderBoxes();
        renderList();
        updateJsonPreview();
      });
      row.append(labelSel);

      const nameInput = el("input", "aps-input aps-layout-name-input");
      nameInput.type = "text";
      nameInput.placeholder = "实体名称（如：光环）";
      nameInput.value = item.name || "";
      nameInput.style.maxWidth = "110px";
      nameInput.title = "实体名称（显示在画框与标签上）";
      nameInput.addEventListener("input", () => {
        item.name = nameInput.value.trim();
        renderBoxes();
        updateJsonPreview();
      });
      row.append(nameInput);

      const captionInput = el("textarea", "aps-modal-textarea aps-layout-caption");
      captionInput.value = item.caption;
      captionInput.rows = 2;
      captionInput.placeholder = `区域 #${index + 1} 的视觉描述…`;
      captionInput.addEventListener("focus", () => {
        selected = index;
        setEditTarget(`region:${index}`);
        renderBoxes();
      });
      captionInput.addEventListener("input", () => {
        item.caption = captionInput.value;
        updateJsonPreview();
      });
      row.append(captionInput);

      if (item.label === "text") {
        const literal = el("input", "aps-input");
        literal.placeholder = "可见文字原文（text）";
        literal.value = item.text || "";
        literal.addEventListener("input", () => {
          item.text = literal.value;
          updateJsonPreview();
        });
        row.append(literal);
      }

      const coords = el("span", "aps-layout-coords", item.bbox.join(", "));
      coords.dataset.coords = String(index);
      row.append(coords);

      const aiFocusBtn = el("button", "aps-btn aps-btn-sm", "✦ 改此区域");
      aiFocusBtn.type = "button";
      aiFocusBtn.title = "将右侧 AI 改词目标切换到此区域";
      aiFocusBtn.addEventListener("click", () => {
        selected = index;
        setEditTarget(`region:${index}`);
        renderBoxes();
        renderList();
        composerInput.focus();
      });
      row.append(aiFocusBtn);

      const del = el("button", "aps-btn", "删除");
      del.type = "button";
      del.addEventListener("click", () => {
        draft.items.splice(index, 1);
        if (selected >= draft.items.length) selected = draft.items.length - 1;
        if (activeEditTarget === `region:${index}`) setEditTarget("summary");
        renderBoxes();
        renderList();
        updateJsonPreview();
      });
      row.append(del);

      row.addEventListener("pointerdown", (ev) => {
        if (ev.target.closest("input, textarea, select, button")) return;
        selected = index;
        setEditTarget(`region:${index}`);
        renderBoxes();
        renderList();
      });
      listHost.append(row);
    });
  }

  // ====================================================== POINTER INTERACTION
  function toCanvasPoint(ev) {
    const rect = svg.getBoundingClientRect();
    const w = rect.width || width;
    const h = rect.height || height;
    return {
      x: clamp(((ev.clientX - rect.left) / w) * width, 0, width),
      y: clamp(((ev.clientY - rect.top) / h) * height, 0, height),
    };
  }

  svg.addEventListener("pointerdown", (ev) => {
    if (currentMode === "caption") return;
    const group = ev.target.closest?.("g[data-index]");
    if (!group) {
      // Draw a new bounding box directly on empty canvas when drawMode or Shift is held
      if (drawMode || ev.shiftKey) {
        const start = toCanvasPoint(ev);
        const sx = clamp(Math.round(start.x), 0, width - 16);
        const sy = clamp(Math.round(start.y), 0, height - 16);
        draft.items.push({
          label: "object",
          caption: `Region ${draft.items.length + 1}`,
          text: "",
          bbox: [sx, sy, Math.min(width, sx + 64), Math.min(height, sy + 64)],
        });
        selected = draft.items.length - 1;
        setEditTarget(`region:${selected}`);
        renderBoxes();
        renderList();
        pointerDrag = {
          index: selected,
          resize: true,
          start,
          bbox: draft.items[selected].bbox.slice(),
        };
        try {
          svg.setPointerCapture(ev.pointerId);
        } catch {
          /* synthetic event */
        }
      }
      return;
    }
    const index = Number(group.dataset.index);
    selected = index;
    setEditTarget(`region:${index}`);
    const item = draft.items[index];
    if (!item) return;
    const resize = ev.target.hasAttribute?.("data-resize");
    pointerDrag = {
      index,
      resize,
      start: toCanvasPoint(ev),
      bbox: item.bbox.slice(),
    };
    try {
      svg.setPointerCapture(ev.pointerId);
    } catch {
      /* synthetic PointerEvents in tests */
    }
    for (const g of svg.querySelectorAll("g[data-index]")) {
      const r = g.querySelector("rect");
      if (r) r.setAttribute("stroke-width", Number(g.dataset.index) === index ? "8" : "4");
    }
    renderList();
  });

  svg.addEventListener("pointermove", (ev) => {
    if (!pointerDrag) return;
    const item = draft.items[pointerDrag.index];
    if (!item) return;
    const point = toCanvasPoint(ev);
    const dx = point.x - pointerDrag.start.x;
    const dy = point.y - pointerDrag.start.y;
    const [x1, y1, x2, y2] = pointerDrag.bbox;
    if (pointerDrag.resize) {
      item.bbox = [
        x1,
        y1,
        clamp(Math.round(x2 + dx), x1 + 2, width),
        clamp(Math.round(y2 + dy), y1 + 2, height),
      ];
    } else {
      const w = x2 - x1;
      const h = y2 - y1;
      const nx1 = clamp(Math.round(x1 + dx), 0, width - w);
      const ny1 = clamp(Math.round(y1 + dy), 0, height - h);
      item.bbox = [nx1, ny1, nx1 + w, ny1 + h];
    }
    const [nx1, ny1, nx2, ny2] = item.bbox;
    const group = svg.querySelector(`g[data-index="${pointerDrag.index}"]`);
    const rect = group?.querySelector("rect");
    if (rect) {
      rect.setAttribute("x", nx1);
      rect.setAttribute("y", ny1);
      rect.setAttribute("width", Math.max(1, nx2 - nx1));
      rect.setAttribute("height", Math.max(1, ny2 - ny1));
    }
    const label = group?.querySelector("text");
    if (label) {
      label.setAttribute("x", nx1 + 10);
      label.setAttribute("y", ny1 + Math.round(Math.max(18, Math.round(width / 42)) * 1.05));
    }
    const handle = group?.querySelector("rect[data-resize]");
    if (handle) {
      const hs = Math.max(20, Math.round(width / 55));
      handle.setAttribute("x", nx2 - hs);
      handle.setAttribute("y", ny2 - hs);
    }
    const coords = listHost.querySelector(`.aps-layout-coords[data-coords="${pointerDrag.index}"]`);
    if (coords) coords.textContent = item.bbox.join(", ");
  });

  const endDrag = () => {
    if (!pointerDrag) return;
    pointerDrag = null;
    if (drawMode) {
      drawMode = false;
      drawBtn.classList.remove("is-active");
      svg.style.cursor = "";
    }
    renderBoxes();
    renderList();
    updateJsonPreview();
  };
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);

  // =================================================== CHAT & DIFF & CAPTION
  function renderChatMessages() {
    chatStream.textContent = "";
    if (!chatMessages.length) {
      const empty = el("div", "aps-empty aps-wb-empty");
      empty.append(
        el("div", "aps-empty-title", "反推 → 对话微调 → 审阅修改 一站闭环"),
        el(
          "div",
          "aps-hint",
          "1. 点击上方「🖼 反推参考图」自动识别画面与布局并载入对话上下文；\n" +
            "2. 点击快捷指令（扩写 / 译为英文 / MOSS 规则优化）或直接输入修改意见；\n" +
            "3. 左侧实时弹出红绿 Diff 预览，确认后应用，随时可撤销。",
        ),
      );
      chatStream.append(empty);
      return;
    }
    for (const msg of chatMessages) {
      const bubble = el("div", `aps-msg ${msg.role}` + (msg.error ? " is-error" : ""));
      bubble.append(
        el("div", "aps-msg-role", msg.role === "user" ? "你" : "AI 助手"),
        el("div", "aps-msg-text", msg.text),
      );
      if (msg.note) {
        bubble.append(el("div", "aps-msg-note", msg.note));
      }
      if (msg.applyText) {
        const useBtn = el("button", "aps-btn aps-btn-sm aps-mt-4", "写入左侧编辑器");
        useBtn.type = "button";
        useBtn.addEventListener("click", () => {
          setCurrentPromptText(msg.applyText, "采纳对话回复");
          setStatus("已将回复内容写入左侧编辑器（可撤销）。");
        });
        bubble.append(useBtn);
      }
      chatStream.append(bubble);
    }
    chatStream.scrollTop = chatStream.scrollHeight;
  }

  function appendChatMessage(role, text, extra = {}) {
    const msg = { role, text, ...extra };
    chatMessages.push(msg);
    renderChatMessages();
    return msg;
  }

  function renderInlineDiff() {
    diffHost.textContent = "";
    if (!activeProposal) return;

    const card = el("div", "aps-diff aps-wb-diff-card");
    const headRow = el("div", "aps-diff-head");
    headRow.append(
      el("span", "", `✦ 建议修改（${targetIndicator.textContent.replace("当前目标：", "")}）`),
      el("span", "aps-diff-stats", describeStats(activeProposal.blocks)),
    );
    card.append(headRow);

    if (activeProposal.reply) {
      card.append(el("div", "aps-diff-reply", activeProposal.reply));
    }

    const blocks = Array.isArray(activeProposal.blocks) ? activeProposal.blocks : [];
    if (blocks.length) {
      const list = el("ul", "aps-blocks");
      for (const block of blocks) {
        if (block.type === "equal") continue;
        if (block.type === "change") {
          const li = el("li", "aps-block is-change");
          li.append(
            el("span", "aps-block-del", block.before),
            el("span", "aps-block-add", block.after),
          );
          list.append(li);
        } else {
          list.append(el("li", `aps-block is-${block.type}`, block.text || ""));
        }
      }
      card.append(list);
    }

    const changes = Array.isArray(activeProposal.changes) ? activeProposal.changes : [];
    const opsBox = el("div", "aps-ops");
    const checkboxes = [];
    changes.forEach((change, idx) => {
      const cb = el("input", "");
      cb.type = "checkbox";
      cb.checked = true;
      cb.dataset.index = String(idx);
      checkboxes.push(cb);
      const label = el("label", "aps-op");
      label.append(cb, el("span", "aps-op-text", describeOp(change)));
      opsBox.append(label);
    });
    if (changes.length) card.append(opsBox);

    const actionsRow = el("div", "aps-diff-actions");
    const applyAllBtn = el("button", "aps-btn aps-primary", "全部应用");
    applyAllBtn.type = "button";
    applyAllBtn.addEventListener("click", () => commitProposal(changes.map((_, i) => i)));

    const applyCheckedBtn = el("button", "aps-btn", "应用勾选");
    applyCheckedBtn.type = "button";
    applyCheckedBtn.hidden = changes.length <= 1;
    applyCheckedBtn.addEventListener("click", () => {
      const indices = checkboxes
        .filter((cb) => cb.checked)
        .map((cb) => Number(cb.dataset.index));
      commitProposal(indices);
    });

    const discardBtn = el("button", "aps-btn", "放弃");
    discardBtn.type = "button";
    discardBtn.addEventListener("click", () => {
      activeProposal = null;
      renderInlineDiff();
      setStatus("已放弃本次修改建议。");
    });

    actionsRow.append(applyAllBtn, applyCheckedBtn, discardBtn);
    card.append(actionsRow);
    diffHost.append(card);
  }

  async function commitProposal(indices) {
    if (!activeProposal || !indices.length) return;
    const ops = selectOps(activeProposal.changes, indices);
    const currentText = getCurrentPromptText();
    setBusyState(true, "正在应用修改…");
    try {
      const res = await api.apply({ text: currentText, ops });
      setCurrentPromptText(res.text, activeProposal.reply || `${ops.length} 处修改`);
      appendChatMessage("assistant", `✓ 已应用 ${ops.length} 处修改到左侧编辑器（可点顶部「↩ 撤销」回退）。`);
      activeProposal = null;
      renderInlineDiff();
      setStatus("修改已应用到编辑器，点右下角「应用」可保存回节点。");
    } catch (err) {
      setStatus(`应用修改失败：${err?.message || err}`, true);
    } finally {
      setBusyState(false);
    }
  }

  async function handleRunCaption() {
    if (busy) return;
    if (!currentImageUrl && !state.image_path) {
      setStatus("请先连接 LoadImage 节点或点击左上角「📂 上传/换图」选择一张参考图。", true);
      return;
    }
    setBusyState(true, "正在反推参考图并载入对话上下文…");
    try {
      if (reverseFormat === "node_mode") {
        const res = await api.captionNode({
          mode: currentMode,
          modes: selectedModes,
          image: currentImageUrl ? { data_url: currentImageUrl } : undefined,
          image_path: state.image_path || "",
          session_id: sessionId || undefined,
          create_session: true,
        });
        if (res.session_id) {
          sessionId = res.session_id;
          onSessionChange?.(sessionId);
        }
        if (res.width && res.height) {
          width = res.width;
          height = res.height;
          draft.width = width;
          draft.height = height;
          sizeNote.textContent = `${width} × ${height}（16 倍数）`;
          updateCanvasAspect();
        }
        if (res.caption) {
          setCurrentPromptText(res.caption, `反推 (${currentMode})`);
        }
        if (res.draft && Array.isArray(res.draft.items)) {
          draft.items = res.draft.items.map((it) => ({
            label: LABELS.includes(it.label) ? it.label : "object",
            caption: String(it.caption || ""),
            text: String(it.text || ""),
            bbox: Array.isArray(it.bbox) ? it.bbox.slice() : [0, 0, width, height],
          }));
        }
        renderBoxes();
        renderList();
        updateJsonPreview();
        appendChatMessage("user", `🖼 反推参考图（模式：${currentMode}）`);
        appendChatMessage(
          "assistant",
          res.caption || "已完成布局反推。",
          {
            note: res.draft?.items?.length
              ? `已生成 ${res.draft.items.length} 个区域框与 ${width}×${height} 画布尺寸，已填入左侧编辑器。现在您可以直接输入修改要求继续微调！`
              : "反推结果已填入左侧编辑器，您可以直接在下方输入修改要求继续迭代！",
          },
        );
        setStatus(`反推完成（${width}×${height}），结果已写入编辑器并进入对话上下文。`);
      } else {
        const res = await api.caption({
          image: { data_url: currentImageUrl },
          format: reverseFormat,
          session_id: sessionId || undefined,
          create_session: true,
        });
        if (res.session_id) {
          sessionId = res.session_id;
          onSessionChange?.(sessionId);
        }
        const text = res.text || "";
        if (text) {
          setEditTarget("summary");
          setCurrentPromptText(text, `反推 (${reverseFormat})`);
          appendChatMessage("user", `🖼 反推参考图（格式：${reverseFormat}）`);
          appendChatMessage("assistant", text, {
            note: "已填入左侧编辑器并保存进会话上下文，可继续追问或点快捷指令改词。",
          });
          setStatus("反推完成，已填入左侧编辑器。");
        }
      }
    } catch (err) {
      appendChatMessage("assistant", `反推失败：${err?.message || err}`, { error: true });
      setStatus(`反推失败：${err?.message || err}`, true);
    } finally {
      setBusyState(false);
    }
  }

  async function runQuickAction(action) {
    if (busy) return;
    await executeEditInstruction(action.instruction, action.label);
  }

  async function executeEditInstruction(instruction, displayLabel = null) {
    const currentText = getCurrentPromptText();
    appendChatMessage("user", displayLabel ? `${displayLabel}：${instruction}` : instruction);
    setBusyState(true, "AI 正在生成修改提案…");
    try {
      const res = await api.edit({
        message: instruction,
        target: {
          title: targetIndicator.textContent,
          widget: activeEditTarget,
          text: currentText,
        },
        images: currentImageUrl ? [{ data_url: currentImageUrl }] : undefined,
        session_id: sessionId || undefined,
        create_session: true,
        allow_empty: true,
      });
      if (res.session_id) {
        sessionId = res.session_id;
        onSessionChange?.(sessionId);
      }
      const proposal = res.proposal;
      if (proposal && proposal.changed) {
        activeProposal = proposal;
        renderInlineDiff();
        appendChatMessage(
          "assistant",
          proposal.reply || "已生成修改建议，请在左侧审阅并点击「全部应用」。",
          { note: `共 ${proposal.changes?.length || 1} 处改动，已在左侧高亮对比。` },
        );
        setStatus("修改提案已生成，请在左侧审阅后点击「全部应用」。");
      } else {
        appendChatMessage("assistant", proposal?.reply || "模型认为当前提示词无需改动。");
        setStatus("模型认为无需修改。");
      }
    } catch (err) {
      appendChatMessage("assistant", `生成修改失败：${err?.message || err}`, { error: true });
      setStatus(`生成修改失败：${err?.message || err}`, true);
    } finally {
      setBusyState(false);
    }
  }

  async function handleSendComposer() {
    if (busy) return;
    const text = composerInput.value.trim();
    if (!text) {
      setStatus("请先输入修改要求或问题。", true);
      return;
    }
    composerInput.value = "";

    if (chatIntent === "edit") {
      await executeEditInstruction(text);
      return;
    }

    // Pure Q&A streaming mode
    appendChatMessage("user", text);
    const assistantMsg = appendChatMessage("assistant", "…");
    const controller = new AbortController();
    streamController = controller;
    setBusyState(true, "AI 正在回复…");
    let streamed = "";
    try {
      await api.chat(
        {
          message: text,
          session_id: sessionId || undefined,
          target: {
            title: targetIndicator.textContent,
            widget: activeEditTarget,
            text: getCurrentPromptText(),
          },
          images: currentImageUrl ? [{ data_url: currentImageUrl }] : undefined,
        },
        (event) => {
          const data = event.data || {};
          if (event.event === "meta" && data.session_id) {
            sessionId = data.session_id;
            onSessionChange?.(sessionId);
          } else if (event.event === "delta") {
            streamed += data.text || "";
            assistantMsg.text = streamed;
            renderChatMessages();
          } else if (event.event === "done") {
            if (typeof data.text === "string" && data.text) {
              streamed = data.text;
            }
            assistantMsg.text = streamed || "（无内容）";
            assistantMsg.applyText = streamed;
            renderChatMessages();
          }
        },
        { signal: controller.signal },
      );
      setStatus("回复完成。");
    } catch (err) {
      if (err?.name === "AbortError") {
        assistantMsg.text = streamed || "（已停止）";
        setStatus("已停止生成。");
      } else {
        assistantMsg.text = streamed || `请求失败：${err?.message || err}`;
        assistantMsg.error = true;
        setStatus(String(err?.message || err), true);
      }
      renderChatMessages();
    } finally {
      streamController = null;
      setBusyState(false);
    }
  }

  // Initial render
  renderBoxes();
  renderList();
  updateJsonPreview();
  renderChatMessages();

  // ======================================================== MODAL LIFECYCLE
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    streamController?.abort();
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  }
  function onKey(ev) {
    if (ev.key === "Escape") {
      onCancel?.();
      close();
    }
  }
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("pointerdown", (ev) => {
    if (ev.target === overlay) {
      onCancel?.();
      close();
    }
  });
  cancelBtn.addEventListener("click", () => {
    onCancel?.();
    close();
  });
  applyBtn.addEventListener("click", () => {
    const next = {
      ...state,
      caption: capArea.value,
      modes: selectedModes,
      width,
      height,
    };
    if (state.mode || currentMode !== mode) {
      next.mode = currentMode;
    }
    if (currentImageUrl) {
      onImageChange?.(currentImageUrl);
    }
    if (sessionId) {
      onSessionChange?.(sessionId);
    }
    if (currentMode !== "caption" || (draft.items && draft.items.length)) {
      draft.summary.caption = capArea.value || draft.summary.caption;
      next.draft = normalizeDraft(draft, width, height);
    }
    try {
      onApply?.(next);
      close();
    } catch (err) {
      setStatus(String(err?.message || err), true);
    }
  });
  return { close };
}

export const RULE_PRESET_OPTIONS = [
  ["moss", "MOSS 散文规则（官方实测无废话规范）"],
  ["moss_cinematic", "MOSS 摄影与电影质感（12 种实测胶片/剧照预设）"],
  ["moss_anime", "MOSS 二次元通道（90s 赛璐璐/黑白漫画/水彩/像素）"],
  ["moss_closed_tags", "MOSS 闭合标签（<|概念|>防多头多肢串色分块）"],
  ["layout", "MOSS 布局规则（空间区域排版规范）"],
  ["pixel_fidelity", "高保真全要素反推（像素级解构·过滤水印·全模型通用）"],
  ["portrait_master", "人像摄影大师（亚洲真实审美·微观肌理与眼眸光彩）"],
  ["character_extractor", "人设三视图提取（剥离背景画风·服饰道具与站姿固化）"],
  ["qwen_edit", "局部图像编辑（Qwen/图生图精准改写指令）"],
  ["video_wan_h3", "视频动态运镜（Wan2.1 / MiniMax H3 官方五段式物理引擎）"],
  ["danbooru", "Danbooru 标签（二次元高审美结构化标签）"],
  ["cinematic", "电影级运镜（景深/光比/冷暖调色电影语言）"],
  ["custom", "自定义规则（仅使用自定义要求）"],
];

export const PRESET_RULE_TEMPLATES = {
  moss: [
    "- 遵循 MOSS-Image (Qwen3.5-9B TE + DiT) 官方编译器 A 级受控实验实测规范：",
    "- 1. 因果注意力语序不可颠倒：光影、色温与摄影媒介词必须置于主体和衣物名词之前，确保 directional key light 能够正确渲染表面色彩，避免后置光影被衰减为局部微弱道具。",
    "- 2. 空间方位与观众视角绝对锚定：偏侧主体、手势（如比耶/OK手势）、关键道具或分屏背景，必须以观众视角（from the viewer's perspective: on the viewer's left side / right side of the frame）显式写明，消除 DiT 模型镜像反转。",
    "- 3. 肢体动作与衣物防多手：半脱衣、掀裙等拉扯动作必须写为完成态静态结果（如 'shirt already pushed up, skirt hem already lifted'），严禁使用拉扯动词占用双手，彻底防止模型凭空多画出第三只手。",
    "- 4. 多人场景因果阻断防双胞胎：主角色排在第 1 段定调；第 2 人及后续角色段落首句必须使用反向因果阻断词（如 'In sharp contrast, the person on the right has NO glasses, contrasting hair and spotless skin...'），阻断人种骨相与服饰串色。",
    "- 5. 暗室与逆光正面防死白：夜间暗室或逆光剪影必须显式写明正面暗部位置（'front of body submerged in deep dark shadows'），同时正文彻底删除 fair skin，负面封杀 flat front lighting，防止人物正面惨白发亮。",
    "- 6. 真实物理光学与微观质感：直接写明镜头光斑、硬直闪投影、微观毛孔、真实发丝与 35mm 胶片颗粒，禁止单独写空洞的相机型号（如单独写 Hasselblad 无效），严禁 (word:1.2) 权重与画质空话。",
    "- 7. 画面文字精准引用：图内文字必须用半角英文双引号 \"text\" 逐字精准包裹，换行处直接换行。",
  ].join("\n"),

  moss_cinematic: [
    "- MOSS-Image 12 种三次元摄影与电影风格实测预设（证据等级 A）：",
    "- 结构要求：[摄影器材与物理光学] -> [机位景别与前景遮挡] -> [主体骨相与真发细节] -> [特定灯具与受光阴影] -> [显影颗粒与肤质锁定]。",
    "- 实测生效风格库（开头词组）：",
    "  • 90s 一次性胶片硬直闪：raw 1990s disposable 35mm film snapshot, harsh direct on-camera flash, hard black drop shadow on the wall, dark vignette, heavy grain, unretouched pores.",
    "  • 暗室单束光伦勃朗切割：dramatic low-key chiaroscuro in pitch-black room, lit only by narrow warm beam, half of face in deep dark shadow, zero front fill light.",
    "  • 王家卫 90s 港片霓虹抽帧：1990s Hong Kong cinema film still, emerald-green and amber tungsten neon, slow-shutter motion blur ghosting trails, glowing red halation.",
    "  • 好莱坞变形宽银幕青橙：cinematic 35mm anamorphic widescreen still, Hollywood teal-and-orange grading, oval vertical bokeh, horizontal blue lens flare.",
    "  • 1994 家用 VHS 录像机：1994 lo-fi home VHS camcorder video tape still, CRT scanlines, RGB chroma bleed, green VCR OSD timestamp.",
    "  • 日系空气感高调胶片：airy Japanese overexposed pastel film photo, high-key diffused soft window light, milky lifted shadows, pale cyan-mint cast.",
    "- 打破摆拍感的关键：在画面一侧加入虚化前景遮挡物（越肩后脑勺/门框/反光玻璃条）以及真实生活道具（凌乱发丝/牙签/告示纸）。",
  ].join("\n"),

  moss_anime: [
    "- MOSS-Image 二次元四大调动通道（证据等级 A，SLG置空/16步即可完美呈现）：",
    "- 核心原则：主体描述必须保持【画风中立】（严禁出现毛孔、闪光灯、照片胶片词），仅靠开头分类词组即可精准切换风格：",
    "  • 1990s 复古赛璐璐 OVA：1990s (style), retro artstyle, anime screencap, cel shading, vintage 1990s OVA anime aesthetic, VHS tape color bleed, hand-painted cel animation.",
    "  • 纯黑白日漫网点纸：manga page, monochrome, greyscale, screentones, inked lineart, bold black ink outlines, pen crosshatching（必须删去正文所有颜色词）。",
    "  • 透明水彩晕染绘本：watercolor (medium), traditional media, ink and wash, soft pastel watercolor bleed on rough textured paper, delicate hand-painted illustration.",
    "  • 高饱和扁平矢量波普：flat color, vector illustration, bold thick colored outlines, vibrant pop art palette, hard geometric cel shading, flat graphic artstyle.",
    "  • 16-bit 像素游戏图：pixel art, 16-bit retro PC-98 Japanese adventure game graphic, crisp visible square pixel grid, checkerboard dithering, limited 16-color palette.",
    "- 严禁写入未经预训练收录的个人画师名（如 ask, ciloranko 等已被 Gemma 4 重打标稀释），严禁使用细碎五官几何词硬凑画风。",
  ].join("\n"),

  moss_closed_tags: [
    "- MOSS-Image 官方 <|概念|>...<|/概念|> 闭合标签结构化写法（证据等级 A）：",
    "- 为什么使用闭合标签：Qwen3.5 底座针对 ChatML 定界符训练，每行一个闭合标签可降低跨区块词语相互污染达 50% 以上，防止多头多肢、景深塌陷与冷暖光互串。",
    "- 标准分行闭合结构：",
    "  <|style_and_camera|>[摄影设备/画种分类], [机位景别], razor-sharp focus, deep depth of field, [角色名], [核心 Tags], uncensored.<|/style_and_camera|>",
    "  <|left_focus|>On the viewer's left: [主体1的骨相、真实发丝、表情、专属受光色温、静态衣物结果与动作]...<|/left_focus|>",
    "  <|right_focus|>In sharp contrast, on the viewer's right: [主体2（含反向因果阻断词与相异发色/肤色）]...<|/right_focus|>",
    "  <|texture_lock|>Unretouched youthful fair skin texture with microscopic pores, real human hair strands in sharp focus, realistic wet specular highlights, organic 35mm film grain.<|/texture_lock|>",
  ].join("\n"),

  layout: [
    "- 遵循 MOSS-Image 官方空间区域排版规范：使用 summary 描述全局视觉构图与画布基础信息。",
    "- 使用 flat items 数组定义关键区域的绝对像素边界框 [x_min, y_min, x_max, y_max]，坐标原点为左上角 (0, 0)。",
    "- 画布宽高尺寸必须为 16 的正整数倍；区域标签仅限 character（角色）、object（物体）、text（文字）。",
    "- 文字区域必须逐字指定半角双引号包围的精准可见文字并保留排版换行。",
    "- 规划清晰的视觉阅读顺序（reading order）、主次对比（prominence）与自然的空间层级。",
  ].join("\n"),

  danbooru: [
    "- 输出规范的 Danbooru 风格英文逗号分隔标签（全部小写，多词短语使用下划线或空格连接）。",
    "- 严格按照层级排序：核心角色与数量（如 1girl, solo）、发型发色与眼瞳特征、面部神态、服装与配饰、动作姿态、背景环境、采光与色调、视角构图、画风媒介。",
    "- 严禁连贯散文长句，严禁 (word:1.2) 权重括号，严禁输出 markdown 代码块或序号。",
    "- 画面中需渲染的具体文字使用 quote 或 text 标签标明。",
  ].join("\n"),

  cinematic: [
    "- 强化电影工业级镜头语言：明确标注摄影景别（极远景 / 全景 / 中景 / 特写）、镜头焦段（如 35mm / 85mm 变形宽银幕电影镜头）与构图视角。",
    "- 景深与空气感：精确描述焦点主体，背景呈现电影级柔和浅景深虚化（cinematic bokeh）、边缘景深衰减与空气透视。",
    "- 专业电影布光：清晰标注主光（Key Light）、辅光（Fill Light）与边缘轮廓光（Rim Light）的方向、色温冷暖与光比层次。",
    "- 色彩影调与氛围：指定电影调色基调（如 Teal and Orange、暖调胶片感、低饱和灰调），描述丁达尔光线、雾气或微尘颗粒质感。",
  ].join("\n"),

  detailed: [
    "- 针对 Flux / SD3 的高密度超精细描述：深度刻画微观材质肌理（皮肤毛孔纹理、织物针织经纬、金属拉丝与微小划痕）。",
    "- 严密的空间景深分层与观众视角方位：分明界定前景（foreground）、中景（midground）与背景（background）的空间拓扑关系；偏侧主体与手势必须明确标明在画面左侧（viewer's left）或右侧（viewer's right），杜绝左右翻转。",
    "- 严格保留可见文字：招牌、印刷品、衣物上的所有文字必须用半角引号 \"text\" 逐字精准记录，绝不漏字改字。",
    "- 真实物理光学与材质反应：强调高光镜面反射、次表面散射（SSS）、环境光遮蔽（AO）与地面接触软阴影。",
  ].join("\n"),

  concise: [
    "- 保持极简紧凑（1~2 句紧凑短句，总字数控制在 40~60 词以内）。",
    "- 仅聚焦画面最核心的主体特征、关键动作、构图比例与标志性光影，剔除所有冗余修饰语与重复描述。",
  ].join("\n"),

  tags: [
    "- 采用逗号分隔的结构化标签短语输出（Danbooru 标签规范）。",
    "- 严格优先级排序：画质媒介基底, 角色核心身份与数量, 发型发色, 面部神态, 服饰穿搭与配件, 动作体态, 背景环境与场景, 采光照明, 构图视角, 艺术风格。",
    "- 所有标签全小写，标签内多词以下划线或空格连接，避免完整自然语言长句，方便直接接入标签生图工作流。",
  ].join("\n"),

  pixel_fidelity: [
    "- 像素级全要素提取：全面客观分析主体、衣饰材质、五官面貌、解剖细节、空间布局与物理光影，每个核心元素保持 3~5 个具象细节特征。",
    "- 拒绝营销空话与模糊词：严禁使用 masterpiece, 8k 等无意义空话，采用精准形态术语与真实物理材质描述。",
    "- 严禁臆造与水印过滤：文字提取仅识别画面内的招牌与服饰字样，自动剔除无关水印与元数据；画面内文字使用半角双引号 \"text\" 标出。",
    "- 双模态融合模式：若有补充修改要求，以补充要求为绝对准则对局部进行定向改写，未修改区域与原图保持严格锚定。",
  ].join("\n"),

  portrait_master: [
    "- 追求亚洲面孔自然审美与真实摄影质感：细腻刻画微观皮肤肌理（真实毛孔、微小皮脂光泽、自然红润），杜绝塑料假面与绿色/僵尸斑驳感。",
    "- 神态与眼眸聚焦：生动刻画视线方向、生动的眼神光斑（catchlight）、轻微微表情与自然唇纹。",
    "- 人像摄影光学参数：模拟 50mm / 85mm 人像定焦镜头大光圈（f/1.4 - f/2.0）浅景深，主体极度锐利，背景呈现奶油般柔美散景虚化（creamy bokeh）。",
    "- 柔和物理光效：侧逆光勾勒发丝轮廓边缘光（rim light），正面柔和反光板补光，明暗过渡平滑自然。",
  ].join("\n"),

  character_extractor: [
    "- 彻底剥离背景与画风：完全忽略原图的画风媒介、原图背景、光影色调及次要无关元素，纯粹聚焦角色人设本体。",
    "- 角色本体特征固化：精准提取性别、年龄段、发型发色、眼型瞳色、五官面貌、解剖体态及标志性特征。",
    "- 服饰与道具全景解析：由内而外详细描述全部衣物层级、布料材质（如皮革/丝绸/粗麻）、装饰配件、徽章符号与专属武器装备。",
    "- 强制站立基准姿态：忽略原图动态，将姿态基准规范为符合角色设定的稳定静态站姿，专为角色三视图与视频动作迁移提供基准。",
  ].join("\n"),

  qwen_edit: [
    "- 遵循 Qwen-Image-Edit 视觉编辑逻辑：精准锁定画面中需要修改的目标主体或区域。",
    "- 明晰修改与保留边界：明确声明原图哪些元素必须绝对保留（如姿势、身份特征、背景结构），哪些必须进行精准替换或重绘。",
    "- 避免误伤未指定区域：指令保持高度具象，不产生附带的多余幻觉修改。",
  ].join("\n"),

  video_wan_h3: [
    "- 严格对齐 Wan 2.1 & MiniMax H3 官方五段式公式：[主体描述] -> [场景描述] -> [运动描述] -> [美学与灯光] -> [风格总结]。",
    "- 完整动作链与次级动力学：详细描述主体起始到结束的完整动作，并刻画动作引发的次级物理运动（发丝飘动、衣摆惯性抖动、重心转移）。",
    "- 明确的电影运镜轨迹：清晰标注平滑推近（push-in）、侧向跟拍（tracking shot）、低角度仰拍或一镜到底连贯调度。",
  ].join("\n"),

  custom: [
    "- 在此输入你的自定义提示词规则（每条以短横线 - 开头，反推与改词将严格遵守）。",
  ].join("\n"),
};

export const OUTPUT_LANGUAGE_OPTIONS = [
  ["en", "英文 English（推荐 · 主流生图模型最佳）"],
  ["zh", "中文 简体中文（适合原生中文生图模型）"],
  ["auto", "自动 Auto（跟随补充要求语言，默认英文）"],
];

export const QUICK_RULE_TEMPLATES = [
  {
    label: "+ 禁用 (word:1.2) 权重括号",
    text: "Never use (word:weight) parentheses syntax or Danbooru quality meta-tags.",
  },
  {
    label: "+ 强制描述物理光影与材质",
    text: "Always specify physical light direction, color temperature, and concrete surface material textures.",
  },
  {
    label: "+ 严格保留画面可见文字",
    text: "Quote any visible text, signage, or typography verbatim inside quotation marks.",
  },
  {
    label: "+ 明确前/中/背景空间层次",
    text: "Clearly distinguish foreground, midground, and background spatial relationships.",
  },
  {
    label: "+ 突出人物神态与服饰细节",
    text: "Describe character facial expression, gaze direction, pose, and garment fabric/silhouette in detail.",
  },
];

/**
 * Open the Model & Prompt Rules Settings Modal.
 * Accessible from both the Node Card and the Dual-Column Workbench.
 */
export function openSettingsModal({
  api: suppliedApi = null,
  nodeOverrides = null,
  onSaved = null,
} = {}) {
  const api = suppliedApi || new StudioApi();
  const overlay = el("div", "aps-modal-overlay aps-settings-overlay notranslate");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("translate", "no");

  const modal = el("div", "aps-modal aps-settings-modal notranslate");
  modal.setAttribute("translate", "no");

  // Header
  const head = el("div", "aps-modal-head aps-wb-head");
  const titleWrap = el("div", "aps-wb-brand");
  titleWrap.append(
    el("span", "aps-logo", "⚙"),
    el("div", "aps-modal-title", "模型配置与提示词规则设置"),
  );
  const closeTopBtn = el("button", "aps-btn aps-btn-sm", "✕ 关闭");
  closeTopBtn.type = "button";
  head.append(titleWrap, closeTopBtn);
  modal.append(head);

  // Body (2-column grid on desktop: Left = Model & Gateway, Right = Prompt Rules & Node Overrides)
  const body = el("div", "aps-settings-body");

  // ---- Left Column: Model & Gateway Config ----
  const modelCol = el("div", "aps-settings-card");
  modelCol.append(
    el("div", "aps-settings-card-title", "🔌 模型与网关配置"),
    el(
      "div",
      "aps-hint",
      "配置 OpenAI 兼容网关（如 Magpie / OpenAI / vLLM / Ollama / NewAPI）。API Key 保存在系统凭据库，前端仅显示掩码。",
    ),
  );

  const baseUrlLabel = el("label", "aps-field-label", "Base URL（接口地址）");
  const baseUrlInput = el("input", "aps-input");
  baseUrlInput.type = "url";
  baseUrlInput.placeholder = "http://127.0.0.1:3425/v1";

  const apiKeyLabel = el("label", "aps-field-label", "API Key（留空保持已保存的密钥）");
  const apiKeyInput = el("input", "aps-input");
  apiKeyInput.type = "password";
  apiKeyInput.autocomplete = "off";
  apiKeyInput.placeholder = "已配置密钥（留空则不修改）";

  const modelLabelRow = el("div", "aps-settings-row-between");
  modelLabelRow.append(el("label", "aps-field-label", "默认模型（Model）"));
  const refreshModelsBtn = el("button", "aps-chip-btn", "🔄 从网关获取模型列表");
  refreshModelsBtn.type = "button";
  modelLabelRow.append(refreshModelsBtn);

  const modelSelect = el("select", "aps-select");
  const defaultModelOpt = el("option", "", "— 从网关下拉选择模型（或直接在下方输入）—");
  defaultModelOpt.value = "";
  modelSelect.append(defaultModelOpt);

  const modelInput = el("input", "aps-input");
  modelInput.type = "text";
  modelInput.placeholder = "例如：gemini-3.8-flash / gpt-4o / qwen-vl-max";

  modelSelect.addEventListener("change", () => {
    if (modelSelect.value) {
      modelInput.value = modelSelect.value;
    }
  });

  const numRow = el("div", "aps-settings-grid-2");
  const timeoutWrap = el("div", "");
  timeoutWrap.append(el("label", "aps-field-label", "请求超时（秒 10~300）"));
  const timeoutInput = el("input", "aps-input");
  timeoutInput.type = "number";
  timeoutInput.min = "10";
  timeoutInput.max = "300";
  timeoutInput.value = "60";
  timeoutWrap.append(timeoutInput);

  const retriesWrap = el("div", "");
  retriesWrap.append(el("label", "aps-field-label", "失败重试次数（0~3）"));
  const retriesInput = el("input", "aps-input");
  retriesInput.type = "number";
  retriesInput.min = "0";
  retriesInput.max = "3";
  retriesInput.value = "2";
  retriesWrap.append(retriesInput);
  numRow.append(timeoutWrap, retriesWrap);

  const probeRow = el("div", "aps-settings-probe-row");
  const probeBtn = el("button", "aps-btn aps-btn-sm", "🔍 探测当前模型能力");
  probeBtn.type = "button";
  const capBadges = el("div", "aps-badges");
  function renderCapBadges(cap) {
    capBadges.textContent = "";
    const items = [
      ["文本", cap?.text],
      ["视觉", cap?.vision],
      ["流式", cap?.streaming],
    ];
    for (const [name, val] of items) {
      const cls = val === true ? "ok" : val === false ? "fail" : "";
      const sym = val === true ? "✓" : val === false ? "✗" : "·";
      capBadges.append(el("span", `aps-badge ${cls}`.trim(), `${name} ${sym}`));
    }
  }
  renderCapBadges(null);
  probeRow.append(probeBtn, capBadges);

  modelCol.append(
    baseUrlLabel,
    baseUrlInput,
    apiKeyLabel,
    apiKeyInput,
    modelLabelRow,
    modelSelect,
    modelInput,
    numRow,
    probeRow,
  );

  // ---- Right Column: Prompt Rules & Node Overrides ----
  const rulesCol = el("div", "aps-settings-card");
  rulesCol.append(
    el("div", "aps-settings-card-title", "📐 提示词规则与反推偏好"),
    el(
      "div",
      "aps-hint",
      "全局提示词规则会自动注入到「图片反推」和「对话改词」中，确保输出风格一致。",
    ),
  );

  const presetLabel = el("label", "aps-field-label", "反推规则预设（Rule Preset）");
  const presetRow = el("div", "aps-preset-row");
  const presetSelect = el("select", "aps-select");
  for (const [val, label] of RULE_PRESET_OPTIONS) {
    const opt = el("option", "", label);
    opt.value = val;
    presetSelect.append(opt);
  }
  const loadPresetBtn = el("button", "aps-btn aps-btn-sm", "📋 载入此预设规则模版");
  loadPresetBtn.type = "button";
  loadPresetBtn.title = "将所选预设的标准规则填入下方编辑框，方便随时增删和修改每一条要求";
  presetRow.append(presetSelect, loadPresetBtn);

  const presetHint = el(
    "div",
    "aps-preset-hint",
    "💡 提示：选择预设后可直接在下方查看、编辑和增删具体每条规则文本；反推与改词将严格按你修改后的规则执行。",
  );

  const langAndRegionsRow = el("div", "aps-settings-grid-2");
  const langWrap = el("div", "");
  langWrap.append(el("label", "aps-field-label", "输出语言偏好"));
  const langSelect = el("select", "aps-select");
  for (const [val, label] of OUTPUT_LANGUAGE_OPTIONS) {
    const opt = el("option", "", label);
    opt.value = val;
    langSelect.append(opt);
  }
  langWrap.append(langSelect);

  const maxRegWrap = el("div", "");
  maxRegWrap.append(el("label", "aps-field-label", "布局最大区域数（1~16）"));
  const maxRegInput = el("input", "aps-input");
  maxRegInput.type = "number";
  maxRegInput.min = "1";
  maxRegInput.max = "16";
  maxRegInput.value = "10";
  maxRegWrap.append(maxRegInput);
  langAndRegionsRow.append(langWrap, maxRegWrap);

  const customRulesLabel = el(
    "label",
    "aps-field-label",
    "全局提示词规则内容（随时修改，反推与改词均会严格遵守）",
  );
  const customRulesArea = el("textarea", "aps-textarea aps-settings-rules-area");
  customRulesArea.rows = 5;
  customRulesArea.placeholder =
    "在此输入你的专属提示词规范，例如：\n- 始终以镜头景别与焦段开头\n- 禁用 (word:1.2) 权重语法\n- 重点描述服装材质与光影方向";

  function isTextMatchingAnyPreset(txt) {
    const trimmed = String(txt || "").trim();
    if (!trimmed) return true;
    return Object.values(PRESET_RULE_TEMPLATES).some((tpl) => tpl.trim() === trimmed);
  }

  function applyPresetTemplate(presetKey, { force = false } = {}) {
    const tpl = PRESET_RULE_TEMPLATES[presetKey] ?? "";
    const cur = customRulesArea.value.trim();
    if (!force && cur && !isTextMatchingAnyPreset(cur)) {
      setStatus(`已切换预设为「${presetKey}」。若想查看并修改该预设的标准规则，请点击「📋 载入此预设规则模版」。`);
      return;
    }
    customRulesArea.value = tpl;
    setStatus(`✓ 已载入「${presetKey}」预设规则模版，可随时在下方自由增删修改。`);
  }

  presetSelect.addEventListener("change", () => {
    applyPresetTemplate(presetSelect.value, { force: false });
  });

  loadPresetBtn.addEventListener("click", () => {
    const cur = customRulesArea.value.trim();
    const tpl = PRESET_RULE_TEMPLATES[presetSelect.value] ?? "";
    if (cur && cur !== tpl && !isTextMatchingAnyPreset(cur)) {
      if (typeof globalThis.confirm === "function") {
        const ok = globalThis.confirm("确定要用当前所选预设的标准模版规则替换下方的规则内容吗？");
        if (!ok) return;
      }
    }
    customRulesArea.value = tpl;
    setStatus(`✓ 已载入「${presetSelect.value}」标准规则模版，可直接在下方自由修改每一条。`);
  });

  const quickChipsWrap = el("div", "aps-quick-chips");
  for (const tpl of QUICK_RULE_TEMPLATES) {
    const chip = el("button", "aps-chip-btn", tpl.label);
    chip.type = "button";
    chip.addEventListener("click", () => {
      const cur = customRulesArea.value.trim();
      if (!cur.includes(tpl.text)) {
        customRulesArea.value = cur ? `${cur}\n- ${tpl.text}` : `- ${tpl.text}`;
      }
    });
    quickChipsWrap.append(chip);
  }
  const clearRulesChip = el("button", "aps-chip-btn", "↺ 清空规则");
  clearRulesChip.type = "button";
  clearRulesChip.addEventListener("click", () => {
    customRulesArea.value = "";
  });
  quickChipsWrap.append(clearRulesChip);

  const userCustomWrap = el("div", "aps-settings-user-custom-wrap");
  const userCustomLabel = el(
    "label",
    "aps-field-label aps-highlight-label",
    "★ 用户自定义要求（自动写进每个规则，始终与选定规则一同交给模型）",
  );
  const userCustomHint = el(
    "div",
    "aps-preset-hint",
    "无论选择哪个预设规则，此处的自定义要求都会自动合并注入并交给模型（如特定画风、背景、人物特征或排除项）。",
  );
  const userCustomArea = el("textarea", "aps-textarea aps-settings-user-custom-area");
  userCustomArea.rows = 3;
  userCustomArea.placeholder =
    "在此输入强制追加的自定义要求，例如：\n- 画面背景始终保持纯白或极简构图\n- 强制体现冷色调赛博霓虹反光\n- 角色神态自然且视线直视镜头";

  const userCustomChipsWrap = el("div", "aps-quick-chips");
  const USER_CUSTOM_QUICK_CHIPS = [
    { label: "+ 纯色极简背景", text: "背景始终保持纯色或极简设计，避免杂乱元素干扰" },
    { label: "+ 强制赛博霓虹反光", text: "强化冷色调赛博朋克光影，表现潮湿地面与金属表面的霓虹反光" },
    { label: "+ 角色直视镜头", text: "人物视线正对镜头，面部神态生动自然，突出眼神光" },
    { label: "+ 严格保留文字", text: "严格精准保留画面中所有英文、标点与数字，不做任何意译篡改" },
    { label: "↺ 清空自定义要求", action: "clear" },
  ];
  for (const chipData of USER_CUSTOM_QUICK_CHIPS) {
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
    });
    userCustomChipsWrap.append(chip);
  }
  userCustomWrap.append(userCustomLabel, userCustomHint, userCustomArea, userCustomChipsWrap);

  rulesCol.append(
    presetLabel,
    presetRow,
    presetHint,
    langAndRegionsRow,
    customRulesLabel,
    customRulesArea,
    quickChipsWrap,
    userCustomWrap,
  );

  // Optional Node-specific overrides section when opened from a node
  let nodeExtraInput = null;
  let nodeModelInput = null;
  if (nodeOverrides && typeof nodeOverrides === "object") {
    const nodeSec = el("div", "aps-settings-node-sec");
    nodeSec.append(
      el("div", "aps-settings-card-title", "🎯 当前节点专属附加设置（随工作流保存）"),
    );
    const neLabel = el("label", "aps-field-label", "当前节点补充要求（extra_instruction）");
    nodeExtraInput = el("input", "aps-input");
    nodeExtraInput.type = "text";
    nodeExtraInput.placeholder = "仅对本节点生效的补充要求，例如：强调赛博朋克霓虹反光";
    nodeExtraInput.value = String(nodeOverrides.extra_instruction || "");

    const nmLabel = el("label", "aps-field-label", "当前节点指定模型覆盖（留空则使用全局默认模型）");
    nodeModelInput = el("input", "aps-input");
    nodeModelInput.type = "text";
    nodeModelInput.placeholder = "留空使用上方全局默认模型";
    nodeModelInput.value = String(nodeOverrides.model || "");

    nodeSec.append(neLabel, nodeExtraInput, nmLabel, nodeModelInput);
    rulesCol.append(nodeSec);
  }

  body.append(modelCol, rulesCol);
  modal.append(body);

  // Footer
  const foot = el("div", "aps-modal-foot");
  const statusEl = el("span", "aps-modal-status", "正在读取当前配置…");
  const footBtns = el("div", "aps-wb-foot-btns");
  const cancelBtn = el("button", "aps-btn", "取消");
  cancelBtn.type = "button";
  const saveBtn = el("button", "aps-btn aps-primary", "✓ 保存设置并生效");
  saveBtn.type = "button";
  footBtns.append(cancelBtn, saveBtn);
  foot.append(statusEl, footBtns);
  modal.append(foot);

  overlay.append(modal);
  document.body.append(overlay);

  function setStatus(msg, isError = false) {
    statusEl.textContent = msg;
    statusEl.className = isError ? "aps-modal-status aps-error-text" : "aps-modal-status";
  }

  async function fetchModelList() {
    refreshModelsBtn.disabled = true;
    refreshModelsBtn.textContent = "⏳ 正在获取…";
    try {
      const res = await api.listModels();
      const list = Array.isArray(res?.models) ? res.models : [];
      const currentVal = modelInput.value.trim();
      modelSelect.textContent = "";
      const headOpt = el(
        "option",
        "",
        list.length ? `— 已获取 ${list.length} 个网关模型（点击选择）—` : "— 网关未返回模型列表，请手动输入 —",
      );
      headOpt.value = "";
      modelSelect.append(headOpt);
      for (const item of list) {
        const id = String(item.id || "").trim();
        if (!id) continue;
        const hasVision = Array.isArray(item.modalities?.input) && item.modalities.input.includes("image");
        const opt = el("option", "", hasVision ? `${id} [支持视觉]` : id);
        opt.value = id;
        if (id === currentVal) opt.selected = true;
        modelSelect.append(opt);
      }
      setStatus(list.length ? `已从网关加载 ${list.length} 个可用模型。` : "网关未返回模型列表，可直接手动输入模型名。");
    } catch (err) {
      setStatus(`获取模型列表失败：${err?.message || err}（可直接在输入框手填模型名）`, true);
    } finally {
      refreshModelsBtn.disabled = false;
      refreshModelsBtn.textContent = "🔄 从网关获取模型列表";
    }
  }

  refreshModelsBtn.addEventListener("click", () => void fetchModelList());

  probeBtn.addEventListener("click", async () => {
    probeBtn.disabled = true;
    setStatus("正在探测模型能力（文本 / 视觉 / 流式）…");
    try {
      const rep = await api.probe({ force: true });
      renderCapBadges(rep);
      setStatus("模型能力探测完成。");
    } catch (err) {
      setStatus(`能力探测失败：${err?.message || err}`, true);
    } finally {
      probeBtn.disabled = false;
    }
  });

  // Load current status on open
  void (async () => {
    try {
      const st = await api.status();
      const cfg = st?.config || {};
      baseUrlInput.value = cfg.base_url || "";
      modelInput.value = cfg.model || "";
      if (cfg.api_key_masked) {
        apiKeyInput.placeholder = `已配置（${cfg.api_key_masked}）· 留空保持不变`;
      }
      if (cfg.timeout_s != null) timeoutInput.value = String(cfg.timeout_s);
      if (cfg.max_retries != null) retriesInput.value = String(cfg.max_retries);
      if (cfg.rule_preset) presetSelect.value = cfg.rule_preset;
      if (cfg.output_language) langSelect.value = cfg.output_language;
      if (cfg.prompt_rules != null && cfg.prompt_rules.trim() !== "") {
        customRulesArea.value = cfg.prompt_rules;
      } else {
        customRulesArea.value = PRESET_RULE_TEMPLATES[cfg.rule_preset || "moss"] || "";
      }
      if (cfg.user_custom_rules != null) {
        userCustomArea.value = cfg.user_custom_rules;
      }
      if (cfg.max_regions != null) maxRegInput.value = String(cfg.max_regions);
      renderCapBadges(st?.capabilities || null);
      setStatus(`当前生效模型：${cfg.model || "未设置"}`);
      void fetchModelList();
    } catch (err) {
      setStatus(`读取配置失败：${err?.message || err}`, true);
    }
  })();

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  }
  function onKey(ev) {
    if (ev.key === "Escape") close();
  }
  document.addEventListener("keydown", onKey);
  closeTopBtn.addEventListener("click", close);
  cancelBtn.addEventListener("click", close);
  overlay.addEventListener("pointerdown", (ev) => {
    if (ev.target === overlay) close();
  });

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    setStatus("正在保存设置…");
    try {
      const payload = {
        base_url: baseUrlInput.value.trim(),
        model: modelInput.value.trim(),
        api_key: apiKeyInput.value.trim() || undefined,
        timeout_s: Number(timeoutInput.value) || 60,
        max_retries: Number(retriesInput.value ?? 2),
        rule_preset: presetSelect.value || "moss",
        output_language: langSelect.value || "en",
        prompt_rules: customRulesArea.value.trim(),
        user_custom_rules: userCustomArea.value.trim(),
        max_regions: clamp(Number(maxRegInput.value) || 10, 1, 16),
      };
      const saved = await api.saveConfig(payload);
      const nodeResult = nodeOverrides
        ? {
            extra_instruction: nodeExtraInput ? nodeExtraInput.value.trim() : "",
            model: nodeModelInput ? nodeModelInput.value.trim() : "",
          }
        : null;
      onSaved?.(saved?.config || payload, nodeResult);
      close();
    } catch (err) {
      setStatus(`保存失败：${err?.message || err}`, true);
    } finally {
      saveBtn.disabled = false;
    }
  });

  return { close };
}

export const openStudioWorkbench = openLayoutEditor;
export const _test = { cloneDraft, clamp };
