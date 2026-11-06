/**
 * ComfyUI AI Prompt Studio — sidebar workbench (M1).
 *
 * Read a prompt from a selected node, discuss it, caption a reference image,
 * then apply a validated diff with undo and version history.  The API key
 * never touches this file: every model call goes through the same-origin
 * routes registered in `prompt_studio.aiohttp_api`.
 */

import { app } from "../../scripts/app.js";

import { StudioApi, ApiError } from "./lib/api.js";
import {
  collectTargets,
  currentTarget,
  findImageNode,
  findTargetByKey,
  imageSource,
  nodeTitle,
  setWidgetText,
  targetWire,
} from "./lib/targets.js";
import { changeCount, describeOp, describeStats, excerpt, selectOps } from "./lib/diff.js";
import { UndoStack } from "./lib/undo.js";
import { fileToDataUrl, sourceToDataUrl } from "./lib/images.js";

const EXTENSION_NAME = "ComfyUI-AI-Prompt-Studio";
const TAB_ID = "ai-prompt-studio";
const SESSION_KEY = "aps.sessions.v1";

const state = {
  api: new StudioApi(),
  app: null,
  targetKey: null,
  targets: [],
  tab: "chat",
  status: null,
  capability: null,
  setupError: null,
  proposal: null,
  proposalTargetKey: null,
  streaming: null,
  busy: false,
  caption: { image: null, sourceLabel: "", text: "", busy: false },
  versions: [],
  versionDetail: null,
  undo: new UndoStack({ limit: 50 }),
  conversations: new Map(),
};

const ui = {};

// --------------------------------------------------------------------- dom
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2), value);
    } else if (value === true) node.setAttribute(key, "");
    else if (value !== false && value != null) node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function iconButton(label, title, onClick, className = "") {
  return el(
    "button",
    { class: `aps-btn ${className}`.trim(), type: "button", title, onclick: onClick },
    label,
  );
}

function mountStyles() {
  if (document.querySelector('link[data-aps-style="1"]')) return;
  const link = el("link", {
    rel: "stylesheet",
    href: new URL("./style.css", import.meta.url).href,
    "data-aps-style": "1",
  });
  document.head.append(link);
}

// ------------------------------------------------------------------- state
function graphApp() {
  return state.app || app;
}

function currentConversation() {
  const key = state.targetKey || "unbound";
  if (!state.conversations.has(key)) {
    state.conversations.set(key, { sessionId: null, messages: [] });
  }
  return state.conversations.get(key);
}

function readSessionMap() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function saveSessionId(key, sessionId) {
  const map = readSessionMap();
  if (sessionId) map[key] = sessionId;
  else delete map[key];
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(map));
  } catch {
    /* storage may be disabled */
  }
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === "text")
      .map((part) => part.text || "")
      .join("\n");
  }
  return "";
}

function setStatus(message, kind = "info") {
  if (!ui.status) return;
  ui.status.textContent = message || "";
  ui.status.dataset.kind = kind;
  if (message) console.info(`[ai-prompt-studio] ${message}`);
}

function setBusy(busy, message = "") {
  state.busy = busy;
  document.querySelectorAll(".aps-root").forEach((root) => {
    root.classList.toggle("is-busy", busy);
  });
  if (message) setStatus(message, "info");
  updateButtons();
  updateDiffButtons();
}

// ------------------------------------------------------------------- mount
function buildPanel(root) {
  mountStyles();
  root.textContent = "";
  const panel = el("div", { class: "aps-root" });

  // Header ---------------------------------------------------------------
  ui.capText = el("span", { class: "aps-badge", "data-state": "unknown" }, "文本 ?");
  ui.capVision = el("span", { class: "aps-badge", "data-state": "unknown" }, "视觉 ?");
  ui.capStream = el("span", { class: "aps-badge", "data-state": "unknown" }, "流式 ?");
  ui.capProbe = el(
    "button",
    { class: "aps-icon", type: "button", title: "探测当前模型能力", onclick: () => probeCapabilities() },
    "↻",
  );
  const header = el("header", { class: "aps-header" }, [
    el("div", { class: "aps-brand" }, [
      el("span", { class: "aps-logo" }, "✳"),
      el("span", { class: "aps-title" }, "AI 提示词工作台"),
      el("span", { class: "aps-version" }, "M1"),
    ]),
    el("div", { class: "aps-badges" }, [ui.capText, ui.capVision, ui.capStream, ui.capProbe]),
  ]);

  // Target ---------------------------------------------------------------
  ui.targetSelect = el("select", {
    class: "aps-target-select",
    title: "选择要操作的提示词控件",
    onchange: () => selectTarget(ui.targetSelect.value),
  });
  ui.targetRefresh = el(
    "button",
    { class: "aps-link", type: "button", title: "重新扫描画布节点", onclick: () => refreshTargets({ force: true }) },
    "刷新",
  );
  ui.targetHint = el("div", { class: "aps-target-hint", hidden: true });
  ui.prompt = el("textarea", {
    class: "aps-prompt",
    readonly: true,
    spellcheck: "false",
    rows: 3,
    title: "当前提示词（在画布上直接编辑也可以，这里会自动同步）",
  });
  const targetSection = el("section", { class: "aps-target" }, [
    el("div", { class: "aps-target-row" }, [ui.targetSelect, ui.targetRefresh]),
    ui.targetHint,
    ui.prompt,
  ]);

  // Tabs -----------------------------------------------------------------
  ui.tabButtons = {};
  const tabs = el("nav", { class: "aps-tabs", role: "tablist" });
  for (const [id, label] of [
    ["chat", "对话"],
    ["caption", "反推"],
    ["history", "历史"],
  ]) {
    const button = el("button", {
      class: "aps-tab",
      type: "button",
      role: "tab",
      onclick: () => switchTab(id),
    }, label);
    ui.tabButtons[id] = button;
    tabs.append(button);
  }

  // Chat -----------------------------------------------------------------
  ui.messages = el("div", { class: "aps-messages", "aria-live": "polite" });
  ui.diffHost = el("div", { class: "aps-diff-host" });
  ui.composer = el("textarea", {
    class: "aps-composer-input",
    rows: 2,
    placeholder: "描述想要的变化，或直接提问。Ctrl+Enter 发送。",
    onkeydown: (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        sendChat();
      }
    },
  });
  ui.attachInput = el("input", {
    type: "file",
    accept: "image/*",
    hidden: true,
    onchange: async () => {
      const file = ui.attachInput.files && ui.attachInput.files[0];
      ui.attachInput.value = "";
      if (!file) return;
      try {
        const dataUrl = await fileToDataUrl(file);
        ui.attachNote.textContent = `已附加：${file.name}`;
        ui.attachNote.hidden = false;
        ui.attachNote.dataset.dataUrl = dataUrl;
      } catch (error) {
        setStatus(error.message, "error");
      }
    },
  });
  ui.attachNote = el("div", { class: "aps-attach-note", hidden: true });
  ui.sendButton = el(
    "button",
    { class: "aps-btn aps-primary", type: "button", onclick: () => sendChat() },
    "发送",
  );
  ui.stopButton = el(
    "button",
    { class: "aps-btn", type: "button", hidden: true, onclick: () => stopStreaming() },
    "停止",
  );
  ui.editButton = el(
    "button",
    { class: "aps-btn aps-accent", type: "button", title: "让模型给出可审阅的修改", onclick: () => requestEdit() },
    "生成修改",
  );
  ui.attachButton = iconButton("图片", "附加参考图片", () => ui.attachInput.click());
  ui.newChatButton = iconButton("新对话", "开始新的对话（不会删除历史版本）", () => resetConversation());
  const chatPanel = el("section", { class: "aps-panel", "data-panel": "chat" }, [
    ui.messages,
    ui.diffHost,
    el("div", { class: "aps-composer" }, [
      ui.attachNote,
      ui.composer,
      el("div", { class: "aps-composer-actions" }, [
        el("div", { class: "aps-left" }, [ui.attachButton, ui.newChatButton]),
        el("div", { class: "aps-right" }, [ui.stopButton, ui.sendButton, ui.editButton]),
      ]),
      ui.attachInput,
    ]),
  ]);

  // Caption --------------------------------------------------------------
  ui.captionPreview = el("div", { class: "aps-caption-preview" }, [
    el("div", { class: "aps-placeholder" }, "还没有选择参考图片"),
  ]);
  // One checkbox per format: tick any combination of 1-3, one reverse run
  // returns every ticked format as its own editable result.
  ui.captionFormatBoxes = {};
  const formatBox = (value, label, title) => {
    const box = el("input", { type: "checkbox", value, checked: value === "prose" });
    box.addEventListener("change", updateCaptionFormatButtons);
    ui.captionFormatBoxes[value] = box;
    return el("label", { class: "aps-check", title }, [box, el("span", {}, label)]);
  };
  ui.captionFormatRow = el("div", { class: "aps-row aps-format-row" }, [
    formatBox("prose", "自然语言", "自然语言描述（2-4 句英文）"),
    formatBox("tags", "逗号标签", "逗号分隔的图像生成标签"),
    formatBox("moss", "MOSS 风格", "MOSS-Image 风格的紧凑段落"),
  ]);
  ui.captionInstruction = el("input", {
    class: "aps-input",
    type: "text",
    placeholder: "额外要求（可选），例如：只描述人物服饰",
  });
  ui.captionNodeButton = iconButton("用所选节点图片", "读取画布上所选图片 / 加载节点的预览", () => useNodeImage());
  ui.captionUploadButton = iconButton("上传图片", "从本机选择一张图片", () => ui.captionFile.click());
  ui.captionFile = el("input", {
    type: "file",
    accept: "image/*",
    hidden: true,
    onchange: async () => {
      const file = ui.captionFile.files && ui.captionFile.files[0];
      ui.captionFile.value = "";
      if (!file) return;
      try {
        const dataUrl = await fileToDataUrl(file);
        state.caption.image = dataUrl;
        state.caption.sourceLabel = file.name;
        renderCaptionPreview();
      } catch (error) {
        setStatus(error.message, "error");
      }
    },
  });
  ui.captionRun = el(
    "button",
    { class: "aps-btn aps-primary", type: "button", onclick: () => runCaption() },
    "开始反推",
  );
  ui.captionNotice = el("div", { class: "aps-notice", hidden: true });
  // Per-format result blocks; each is independently editable and writable.
  ui.captionResults = el("div", { class: "aps-caption-results" });
  ui.captionResultBoxes = {};
  for (const [value, label] of [
    ["prose", "自然语言描述"],
    ["tags", "逗号分隔标签"],
    ["moss", "MOSS 图像风格"],
  ]) {
    const textarea = el("textarea", {
      class: "aps-caption-result",
      rows: 4,
      "data-format": value,
      placeholder: `${label}的结果会出现在这里，可以先修改再写入。`,
      hidden: true,
    });
    textarea.addEventListener("input", updateCaptionWriteTargets);
    ui.captionResultBoxes[value] = textarea;
    ui.captionResults.append(textarea);
  }
  ui.captionReplace = iconButton("替换提示词", "用当前编辑的格式结果替换提示词（可撤销）", () =>
    insertCaption("replace"),
  );
  ui.captionAppend = iconButton("追加到末尾", "把当前编辑的格式结果追加到提示词后面（可撤销）", () =>
    insertCaption("append"),
  );
  ui.captionActiveFormat = null;
  const captionPanel = el("section", { class: "aps-panel", "data-panel": "caption", hidden: true }, [
    ui.captionNotice,
    ui.captionPreview,
    el("div", { class: "aps-caption-controls" }, [
      el("div", { class: "aps-field aps-field-wide" }, [el("span", {}, "输出格式（可多选）"), ui.captionFormatRow]),
      el("label", { class: "aps-field" }, [el("span", {}, "额外要求"), ui.captionInstruction]),
    ]),
    el("div", { class: "aps-row" }, [ui.captionNodeButton, ui.captionUploadButton, ui.captionRun]),
    ui.captionFile,
    ui.captionResults,
    el("div", { class: "aps-row" }, [ui.captionReplace, ui.captionAppend]),
    el("p", { class: "aps-hint" }, "图片中的文字只作为画面内容处理，不会被当作指令执行。勾选多种格式时每种都会单独请求一次。"),
  ]);

  // History --------------------------------------------------------------
  ui.historyList = el("div", { class: "aps-history-list" });
  ui.historyDetail = el("div", { class: "aps-history-detail", hidden: true });
  ui.historyRefresh = iconButton("刷新", "重新读取版本记录", () => loadVersions());
  const historyPanel = el("section", { class: "aps-panel", "data-panel": "history", hidden: true }, [
    el("div", { class: "aps-row aps-row-between" }, [
      el("span", { class: "aps-hint" }, "每个提示词控件最多保留最近 100 个版本"),
      ui.historyRefresh,
    ]),
    ui.historyList,
    ui.historyDetail,
  ]);

  // Footer ---------------------------------------------------------------
  ui.undoButton = el(
    "button",
    { class: "aps-btn", type: "button", title: "撤销上一次写入", onclick: () => undoLast() },
    "撤销",
  );
  ui.redoButton = el(
    "button",
    { class: "aps-btn", type: "button", title: "重做刚撤销的写入", onclick: () => redoLast() },
    "重做",
  );
  ui.status = el("span", { class: "aps-status", role: "status" });
  ui.modelNote = el("button", {
    class: "aps-model-note aps-link",
    type: "button",
    title: "点击配置 Base URL / 模型（API Key 在后端设置）",
    onclick: () => showSetup(null, state.status),
  });
  const footer = el("footer", { class: "aps-footer" }, [
    el("div", { class: "aps-row" }, [ui.undoButton, ui.redoButton]),
    ui.status,
    ui.modelNote,
  ]);

  ui.setup = el("div", { class: "aps-setup", hidden: true });

  panel.append(header, ui.setup, targetSection, tabs, chatPanel, captionPanel, historyPanel, footer);
  root.append(panel);

  ui.panel = panel;
  ui.panels = {
    chat: chatPanel,
    caption: captionPanel,
    history: historyPanel,
  };
  return panel;
}

// ------------------------------------------------------------------ setup
function showSetup(error, status = null) {
  state.setupError = error;
  ui.setup.hidden = false;
  ui.setup.textContent = "";
  const config = status?.config || state.status?.config || {};
  const baseField = el("input", { class: "aps-input", type: "url", value: config.base_url || "http://127.0.0.1:3425/v1" });
  const modelField = el("input", { class: "aps-input", value: config.model || "auto/glm-5.3-flash" });
  const form = el("div", { class: "aps-setup-form" }, [
    el("label", {}, "Base URL", baseField),
    el("label", {}, "模型", modelField),
  ]);
  const feedback = el("span", { class: "aps-hint" }, "API Key 不进入网页；请用下方命令在 ComfyUI 的 Python 环境写入 Windows 凭据管理器。");
  const save = iconButton("保存 URL / 模型", "写入本机凭据并立即更新后端", async () => {
    save.disabled = true;
    feedback.textContent = "正在保存配置…";
    try {
      const body = await state.api.request("/config", { method: "POST", body: {
        base_url: baseField.value.trim(),
        model: modelField.value.trim(),
      } });
      state.status = { ...(state.status || {}), config: body.config };
      setStatus("URL 和模型已保存。", "ok");
      feedback.textContent = body.message || "配置已保存。";
      await loadStatus();
    } catch (err) {
      feedback.textContent = `保存失败：${err?.message || err}`;
      save.disabled = false;
    }
  });
  save.classList?.add("aps-primary");
  ui.setup.append(
    el("div", { class: "aps-setup-title" }, "配置模型 / URL（API Key 在后端设置）"),
    el("p", {}, error && error.message ? error.message : "URL 和模型保存在本机后端；API Key 需用下方命令写入系统凭据。"),
    form,
    el("div", { class: "aps-row" }, [save, feedback]),
    el("p", { class: "aps-hint" }, "也可以使用 ComfyUI 的 Python 环境运行："),
    el("code", { class: "aps-code" }, "python -m prompt_studio.credentials set"),
    iconButton("重新检查", "重新读取配置", () => loadStatus()),
  );
}

// ------------------------------------------------------------------ status
async function loadStatus() {
  try {
    const body = await state.api.status();
    state.status = body;
    state.capability = body.capabilities || null;
    if (ui.setup) ui.setup.hidden = true;
    state.setupError = null;
    updateCapabilityBadges();
    if (ui.modelNote) {
      ui.modelNote.textContent = body.config?.model ? `模型：${body.config.model} ⚙` : "配置模型 ⚙";
      ui.modelNote.title = `点击配置；当前：\n${body.config?.base_url || ""}\n${body.config?.api_key_masked || ""}`;
    }
    updateButtons();
  } catch (error) {
    if (error instanceof ApiError && error.code === "config_error") {
      if (ui.setup) showSetup(error);
    } else {
      setStatus(error.message || String(error), "error");
    }
  }
}

function badgeState(value) {
  if (value === true) return "ok";
  if (value === false) return "bad";
  return "unknown";
}

function updateCapabilityBadges() {
  const report = state.capability;
  if (!ui.capText) return;
  const marks = { ok: "✓", bad: "✗", unknown: "?" };
  const assign = (node, label, value) => {
    const status = badgeState(value);
    node.textContent = `${label} ${marks[status]}`;
    node.dataset.state = status;
    node.title =
      status === "ok"
        ? `${label}：探测通过`
        : status === "bad"
          ? `${label}：探测未通过`
          : `${label}：尚未探测`;
  };
  assign(ui.capText, "文本", report ? report.text : null);
  assign(ui.capVision, "视觉", report ? report.vision : null);
  assign(ui.capStream, "流式", report ? report.streaming : null);
  ui.capVision.title += "（点击 ↻ 重新探测）";

  const vision = report ? report.vision : null;
  const reason = report?.details?.vision?.reason || "";
  if (vision === false) {
    ui.captionNotice.hidden = false;
    ui.captionNotice.dataset.kind = "warn";
    ui.captionNotice.textContent =
      `当前模型不支持图片输入（${reason || "探测未通过"}），反推已禁用。可以在配置中换成视觉模型后重新探测。`;
  } else if (vision === null && report) {
    ui.captionNotice.hidden = false;
    ui.captionNotice.dataset.kind = "info";
    ui.captionNotice.textContent = "视觉能力探测没有拿到明确结果，反推仍可尝试，失败时会给出错误说明。";
  } else {
    ui.captionNotice.hidden = true;
  }
  updateButtons();
}

async function probeCapabilities() {
  if (state.busy) return;
  setBusy(true, "正在探测模型能力（文本 / 视觉 / 流式）…");
  try {
    state.capability = await state.api.probe();
    updateCapabilityBadges();
    setStatus("能力探测完成。", "ok");
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    setBusy(false);
  }
}

// ----------------------------------------------------------------- targets
function selectTarget(key) {
  if (!key) return;
  state.targetKey = key;
  const conversation = currentConversation();
  if (!conversation.sessionId) {
    conversation.sessionId = readSessionMap()[key] || null;
    if (conversation.sessionId) void restoreSession(conversation);
  }
  state.proposal = null;
  state.proposalTargetKey = null;
  renderDiff();
  renderMessages();
  renderPrompt();
  updateHistoryTarget();
  if (state.tab === "history") void loadVersions();
}

async function restoreSession(conversation) {
  try {
    const body = await state.api.getSession(conversation.sessionId);
    if (Array.isArray(body.messages)) {
      conversation.messages = body.messages
        .filter((message) => message.role === "user" || message.role === "assistant")
        .map((message) => ({ role: message.role, text: contentText(message.content) }))
        .filter((message) => message.text);
      if (state.conversations.get(state.targetKey) === conversation) renderMessages();
    }
  } catch {
    conversation.sessionId = null;
    saveSessionId(state.targetKey, null);
  }
}

function refreshTargets({ force = false } = {}) {
  const canvasApp = graphApp();
  if (!canvasApp) return;
  const targets = collectTargets(canvasApp);
  state.targets = targets;

  if (!targets.length) {
    state.targetKey = null;
    ui.targetSelect.textContent = "";
    ui.targetSelect.append(el("option", { value: "" }, "画布上没有可用的提示词节点"));
    ui.targetSelect.disabled = true;
    ui.prompt.value = "";
    ui.targetHint.hidden = false;
    ui.targetHint.textContent = "在画布上选择一个带文本输入控件的节点（例如 CLIP Text Encode），或先添加一个。";
    updateButtons();
    return;
  }

  const keys = new Set(targets.map((target) => target.key));
  if (force || !state.targetKey || !keys.has(state.targetKey)) {
    const preferred = currentTarget(canvasApp);
    selectTarget(preferred && keys.has(preferred.key) ? preferred.key : targets[0].key);
  }

  const selected = currentTarget(canvasApp);
  if (selected && keys.has(selected.key) && selected.key !== state.targetKey) {
    selectTarget(selected.key);
  }

  ui.targetSelect.disabled = false;
  // Compare the rendered options with the targets themselves: a re-render can
  // leave the placeholder option behind while the counts still look equal.
  const optionKeys = new Set(
    [...ui.targetSelect.options].map((option) => option.value).filter(Boolean),
  );
  if (optionKeys.size !== targets.length || targets.some((target) => !optionKeys.has(target.key))) {
    ui.targetSelect.textContent = "";
    for (const target of targets) {
      const option = el("option", { value: target.key }, `${target.title} · ${target.widget}（#${target.node_id}）`);
      ui.targetSelect.append(option);
    }
  }
  ui.targetSelect.value = state.targetKey || "";
  ui.targetHint.hidden = true;
  renderPrompt();
  updateButtons();
}

function activeTarget() {
  if (!state.targetKey) return null;
  return findTargetByKey(graphApp(), state.targetKey);
}

function renderPrompt() {
  const target = activeTarget();
  if (!target) {
    if (ui.prompt) ui.prompt.value = "";
    return;
  }
  if (document.activeElement !== ui.prompt) ui.prompt.value = target.text;
  const option = [...ui.targetSelect.options].find((item) => item.value === target.key);
  if (option) {
    option.textContent = `${target.title} · ${target.widget}（#${target.node_id}）`;
  }
}

function updateButtons() {
  if (!ui.sendButton) return;
  const configured = !state.setupError;
  const hasTarget = Boolean(state.targetKey);
  const streaming = Boolean(state.streaming);
  ui.sendButton.disabled = !configured || !hasTarget || state.busy || streaming;
  ui.editButton.disabled = !configured || !hasTarget || state.busy || streaming;
  ui.stopButton.hidden = !streaming;
  ui.captionRun.disabled =
    !configured || state.caption.busy || state.busy || !state.caption.image || state.capability?.vision === false ||
    !Object.values(ui.captionFormatBoxes || {}).some((box) => box.checked);
  ui.captionReplace.disabled = !activeCaptionResult() || !hasTarget;
  ui.captionAppend.disabled = !activeCaptionResult() || !hasTarget;
  ui.undoButton.disabled = !state.undo.canUndo || state.busy;
  ui.redoButton.disabled = !state.undo.canRedo || state.busy;
  const undo = state.undo.peekUndo();
  const redo = state.undo.peekRedo();
  ui.undoButton.title = undo ? `撤销：${undo.label || undo.source}` : "没有可撤销的写入";
  ui.redoButton.title = redo ? `重做：${redo.label || redo.source}` : "没有可重做的写入";
}

// -------------------------------------------------------------------- chat
function bubbleFor(message) {
  return el("div", { class: `aps-msg ${message.role}` }, [
    el("div", { class: "aps-msg-role" }, message.role === "user" ? "你" : "模型"),
    el("div", { class: "aps-msg-text" }, message.text),
    message.note ? el("div", { class: "aps-msg-note" }, message.note) : null,
  ]);
}

function renderMessages() {
  if (!ui.messages) return;
  const conversation = currentConversation();
  ui.messages.textContent = "";
  if (!conversation.messages.length) {
    ui.messages.append(
      el("div", { class: "aps-empty" }, [
        el("div", { class: "aps-empty-title" }, "先看看这段提示词"),
        el("div", { class: "aps-hint" }, "可以直接提问，例如“这段提示词哪里可以更具体？”；也可以点“生成修改”让模型给出可审阅的改动。"),
      ]),
    );
    return;
  }
  for (const message of conversation.messages) ui.messages.append(bubbleFor(message));
  ui.messages.scrollTop = ui.messages.scrollHeight;
}

function addMessage(role, text, note) {
  const conversation = currentConversation();
  const message = { role, text, note };
  conversation.messages.push(message);
  if (ui.messages) {
    const empty = ui.messages.querySelector(".aps-empty");
    if (empty) empty.remove();
    const bubble = bubbleFor(message);
    ui.messages.append(bubble);
    ui.messages.scrollTop = ui.messages.scrollHeight;
    return bubble;
  }
  return null;
}

async function sendChat() {
  if (state.busy || state.streaming) return;
  const text = ui.composer.value.trim();
  if (!text) {
    setStatus("先写点什么再发送。", "warn");
    return;
  }
  const target = activeTarget();
  if (!target) {
    setStatus("先在画布上选择一个带提示词的节点。", "warn");
    return;
  }
  const conversation = currentConversation();
  addMessage("user", text);
  ui.composer.value = "";
  const attachment = ui.attachNote.hidden ? null : ui.attachNote.dataset.dataUrl;
  ui.attachNote.hidden = true;
  delete ui.attachNote.dataset.dataUrl;

  const bubble = addMessage("assistant", "");
  const bubbleText = bubble.querySelector(".aps-msg-text");
  bubble.classList.add("is-streaming");
  bubbleText.textContent = "…";

  const controller = new AbortController();
  state.streaming = controller;
  updateButtons();
  let streamed = "";
  try {
    await state.api.chat(
      {
        message: text,
        session_id: conversation.sessionId || undefined,
        target: targetWire(target),
        images: attachment ? [{ data_url: attachment }] : undefined,
      },
      (event) => {
        const data = event.data || {};
        if (event.event === "meta" && data.session_id) {
          conversation.sessionId = data.session_id;
          saveSessionId(state.targetKey, data.session_id);
        } else if (event.event === "delta") {
          streamed += data.text || "";
          bubbleText.textContent = streamed;
          ui.messages.scrollTop = ui.messages.scrollHeight;
        } else if (event.event === "reasoning") {
          bubble.dataset.reasoning = "1";
        } else if (event.event === "done") {
          if (typeof data.text === "string" && data.text) bubbleText.textContent = data.text;
          conversation.messages[conversation.messages.length - 1].text = bubbleText.textContent;
          if (data.ttft_ms != null) {
            bubble.dataset.meta = `${data.ttft_ms} ms 首字`;
          }
        } else if (event.event === "error") {
          throw new ApiError(data.message || "模型请求失败。", {
            code: data.code,
            retryable: data.retryable,
            requestId: data.request_id,
          });
        }
      },
      { signal: controller.signal },
    );
    if (!bubbleText.textContent.trim()) bubbleText.textContent = "（模型没有返回内容）";
    conversation.messages[conversation.messages.length - 1].text = bubbleText.textContent;
  } catch (error) {
    if (error && error.name === "AbortError") {
      bubbleText.textContent = streamed || "（已停止）";
      conversation.messages[conversation.messages.length - 1].text = bubbleText.textContent;
      setStatus("已停止生成。", "info");
    } else {
      bubble.classList.add("is-error");
      const message = error.message || String(error);
      bubbleText.textContent = streamed || "";
      const note = el("div", { class: "aps-msg-note is-error" }, message);
      bubble.append(note);
      conversation.messages[conversation.messages.length - 1].text = bubbleText.textContent || "（失败）";
      conversation.messages[conversation.messages.length - 1].note = message;
      setStatus(message, "error");
    }
  } finally {
    bubble.classList.remove("is-streaming");
    state.streaming = null;
    updateButtons();
  }
}

function stopStreaming() {
  state.streaming?.abort();
}

async function resetConversation() {
  const conversation = currentConversation();
  const previous = conversation.sessionId;
  conversation.sessionId = null;
  conversation.messages = [];
  saveSessionId(state.targetKey, null);
  renderMessages();
  if (previous) {
    try {
      await state.api.deleteSession(previous);
    } catch {
      /* already gone */
    }
  }
  setStatus("已开始新对话。", "info");
}

function switchTab(tab) {
  state.tab = tab;
  for (const [id, button] of Object.entries(ui.tabButtons)) {
    button.classList.toggle("is-active", id === tab);
    button.setAttribute("aria-selected", id === tab ? "true" : "false");
  }
  for (const [id, panel] of Object.entries(ui.panels)) {
    panel.hidden = id !== tab;
  }
  if (tab === "history") void loadVersions();
  if (tab === "caption") renderCaptionPreview();
}

// -------------------------------------------------------------------- edit
async function requestEdit() {
  if (state.busy || state.streaming) return;
  const target = activeTarget();
  if (!target) {
    setStatus("先在画布上选择一个带提示词的节点。", "warn");
    return;
  }
  const conversation = currentConversation();
  const instruction = ui.composer.value.trim() || [...conversation.messages].reverse().find((m) => m.role === "user")?.text || "";
  if (!instruction) {
    setStatus("先写下想要的修改，例如“把晴天改成雨夜”。", "warn");
    return;
  }
  setBusy(true, "模型正在准备修改…");
  try {
    const body = await state.api.edit({ message: instruction, target: targetWire(target) });
    state.proposal = body.proposal;
    state.proposalTargetKey = target.key;
    renderDiff();
    setStatus(
      body.proposal.changed ? "修改已生成，请审阅后再应用。" : "模型认为不需要修改。",
      "ok",
    );
  } catch (error) {
    setStatus(error.message || String(error), "error");
    renderDiffError(error);
  } finally {
    setBusy(false);
  }
}

function renderDiffError(error) {
  if (!ui.diffHost) return;
  ui.diffHost.textContent = "";
  ui.diffHost.append(
    el("div", { class: "aps-diff is-error" }, [
      el("div", { class: "aps-diff-head" }, "没有生成可应用的修改"),
      el("div", { class: "aps-diff-error" }, error.message || String(error)),
      el("div", { class: "aps-diff-actions" }, [
        el("button", { class: "aps-btn", type: "button", onclick: clearDiff }, "关闭"),
      ]),
    ]),
  );
}

function clearDiff() {
  state.proposal = null;
  state.proposalTargetKey = null;
  renderDiff();
}

function renderDiff() {
  if (!ui.diffHost) return;
  ui.diffHost.textContent = "";
  const proposal = state.proposal;
  // A proposal takes over the panel: reviewing the diff matters more than the
  // chat transcript, which comes back as soon as the card is applied/closed.
  if (ui.panels && ui.panels.chat) ui.panels.chat.dataset.diff = proposal ? "1" : "0";
  if (!proposal) return;

  const card = el("div", { class: "aps-diff" });
  const title = el("div", { class: "aps-diff-head" }, [
    el("span", {}, "建议修改"),
    el("span", { class: "aps-diff-stats" }, describeStats(proposal.blocks)),
  ]);
  card.append(title);

  if (proposal.reply) {
    card.append(el("div", { class: "aps-diff-reply" }, proposal.reply));
  }

  const blocks = Array.isArray(proposal.blocks) ? proposal.blocks : [];
  if (blocks.length) {
    const list = el("ul", { class: "aps-blocks" });
    for (const block of blocks) {
      if (block.type === "equal") continue;
      if (block.type === "change") {
        list.append(
          el("li", { class: "aps-block is-change" }, [
            el("span", { class: "aps-block-del" }, block.before),
            el("span", { class: "aps-block-add" }, block.after),
          ]),
        );
      } else {
        list.append(
          el("li", { class: `aps-block is-${block.type}` }, block.text || ""),
        );
      }
    }
    card.append(list);
  }

  const changes = Array.isArray(proposal.changes) ? proposal.changes : [];
  const opsBox = el("div", { class: "aps-ops" });
  changes.forEach((change, index) => {
    const checkbox = el("input", { type: "checkbox", checked: true, "data-index": index });
    checkbox.addEventListener("change", updateDiffButtons);
    opsBox.append(
      el("label", { class: "aps-op" }, [
        checkbox,
        el("span", { class: "aps-op-text" }, describeOp(change)),
      ]),
    );
  });
  // The ops box carries the per-change checkbox that enables the apply
  // buttons, so it must be present even for a single change.
  if (changes.length) card.append(opsBox);

  const applyAll = el(
    "button",
    { class: "aps-btn aps-primary", type: "button", onclick: () => applyProposal("all") },
    "全部应用",
  );
  const applyChecked = el(
    "button",
    { class: "aps-btn", type: "button", onclick: () => applyProposal("checked") },
    "应用勾选",
  );
  const discard = el("button", { class: "aps-btn", type: "button", onclick: clearDiff }, "放弃");
  applyChecked.hidden = changes.length <= 1;
  card.append(el("div", { class: "aps-diff-actions" }, [applyAll, applyChecked, discard]));
  card.dataset.applyAll = "1";
  ui.diffHost.append(card);
  ui.diffApplyAll = applyAll;
  ui.diffApplyChecked = applyChecked;
  ui.diffCard = card;
  updateDiffButtons();
}

function updateDiffButtons() {
  if (!ui.diffCard) return;
  const hasChecked = [...ui.diffCard.querySelectorAll("input[type=checkbox]")].some((box) => box.checked);
  if (ui.diffApplyAll) ui.diffApplyAll.disabled = !hasChecked || state.busy;
  if (ui.diffApplyChecked) ui.diffApplyChecked.disabled = !hasChecked || state.busy;
}

function checkedOpIndices() {
  if (!ui.diffCard) return [];
  return [...ui.diffCard.querySelectorAll("input[type=checkbox][data-index]")]
    .filter((box) => box.checked)
    .map((box) => Number(box.dataset.index));
}

async function applyProposal(mode) {
  const proposal = state.proposal;
  const key = state.proposalTargetKey;
  if (!proposal || !key || state.busy) return;
  const indices = mode === "all" ? proposal.changes.map((_, index) => index) : checkedOpIndices();
  const ops = selectOps(proposal.changes, indices);
  if (!ops.length) {
    setStatus("请至少勾选一条修改。", "warn");
    return;
  }
  const target = findTargetByKey(graphApp(), key);
  if (!target) {
    setStatus("目标节点已不在画布上，无法应用。", "error");
    return;
  }
  setBusy(true, "正在校验并应用修改…");
  try {
    const preview = await state.api.apply({ text: target.text, ops });
    const result = await applyText(preview.text, {
      key,
      source: "apply",
      label: proposal.reply ? excerpt(proposal.reply, 40) : `${ops.length} 处修改`,
    });
    if (result.applied) {
      addMessage("assistant", `已应用 ${ops.length} 处修改。`, "可点底部“撤销”恢复。");
      markDiffApplied();
      setStatus("已写入节点，可撤销。", "ok");
    } else {
      setStatus("提示词已经是目标内容，没有写入。", "info");
    }
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    setBusy(false);
    updateDiffButtons();
  }
}

function markDiffApplied() {
  if (!ui.diffCard) return;
  ui.diffCard.classList.add("is-applied");
  const actions = ui.diffCard.querySelector(".aps-diff-actions");
  if (actions) {
    actions.textContent = "";
    actions.append(
      el("span", { class: "aps-applied-note" }, "已应用"),
      el("button", { class: "aps-btn", type: "button", onclick: () => undoLast() }, "撤销"),
      el("button", { class: "aps-btn", type: "button", onclick: clearDiff }, "关闭"),
    );
  }
  ui.diffApplyAll = null;
  ui.diffApplyChecked = null;
}

// -------------------------------------------------------- apply / undo / io
async function applyText(text, { key, source = "apply", label = "", meta } = {}) {
  const target = findTargetByKey(graphApp(), key || state.targetKey);
  if (!target) throw new Error("目标节点已不存在，无法写入。");
  const result = setWidgetText(graphApp(), target, text);
  if (!result.changed) return { applied: false, target };
  state.undo.record({ key: target.key, before: result.before, after: text, label, source });
  renderPrompt();
  updateButtons();
  try {
    await state.api.addVersion({ target: target.key, text, source, label, meta });
  } catch (error) {
    console.warn("[ai-prompt-studio] version record failed", error);
  }
  return { applied: true, target };
}

async function undoLast() {
  const entry = state.undo.undo();
  if (!entry) return;
  const target = findTargetByKey(graphApp(), entry.key);
  if (!target) {
    state.undo.redo();
    setStatus("撤销失败：目标节点已不存在。", "error");
    return;
  }
  setWidgetText(graphApp(), target, entry.before);
  renderPrompt();
  updateButtons();
  setStatus(`已撤销：${entry.label || entry.source}`, "ok");
  try {
    await state.api.addVersion({
      target: entry.key,
      text: entry.before,
      source: "undo",
      label: `撤销 ${entry.label || ""}`.trim(),
    });
  } catch {
    /* history is best-effort */
  }
  if (state.tab === "history") void loadVersions();
}

async function redoLast() {
  const entry = state.undo.redo();
  if (!entry) return;
  const target = findTargetByKey(graphApp(), entry.key);
  if (!target) {
    state.undo.undo();
    setStatus("重做失败：目标节点已不存在。", "error");
    return;
  }
  setWidgetText(graphApp(), target, entry.after);
  renderPrompt();
  updateButtons();
  setStatus(`已重做：${entry.label || entry.source}`, "ok");
  try {
    await state.api.addVersion({
      target: entry.key,
      text: entry.after,
      source: "redo",
      label: `重做 ${entry.label || ""}`.trim(),
    });
  } catch {
    /* best-effort */
  }
  if (state.tab === "history") void loadVersions();
}

// ----------------------------------------------------------------- caption
async function useNodeImage() {
  const node = findImageNode(graphApp());
  const source = node ? imageSource(node) : null;
  if (!source) {
    setStatus("所选节点没有可用图片。请选中 Load Image 之类的节点，或直接上传。", "warn");
    return;
  }
  try {
    state.caption.image = await sourceToDataUrl(source);
    state.caption.sourceLabel = `${nodeTitle(node)} 的预览图`;
    renderCaptionPreview();
    setStatus("已读取节点图片。", "ok");
  } catch (error) {
    setStatus(error.message || String(error), "error");
  }
}

function renderCaptionPreview() {
  if (!ui.captionPreview) return;
  ui.captionPreview.textContent = "";
  if (!state.caption.image) {
    ui.captionPreview.append(el("div", { class: "aps-placeholder" }, "还没有选择参考图片"));
  } else {
    ui.captionPreview.append(
      el("img", { src: state.caption.image, alt: "参考图片预览", class: "aps-caption-image" }),
      el("div", { class: "aps-caption-source" }, state.caption.sourceLabel || "上传的图片"),
    );
  }
  updateButtons();
}

async function runCaption() {
  if (state.caption.busy || !state.caption.image) return;
  if (state.capability?.vision === false) {
    setStatus("当前模型不支持图片输入，反推不可用。", "warn");
    return;
  }
  const formats = Object.entries(ui.captionFormatBoxes)
    .filter(([, box]) => box.checked)
    .map(([value]) => value);
  if (!formats.length) {
    setStatus("请至少勾选一种输出格式。", "warn");
    return;
  }
  state.caption.busy = true;
  updateButtons();
  setStatus(
    formats.length > 1
      ? `正在反推图片（${formats.length} 种格式，逐个请求）…`
      : "正在反推图片…",
    "info",
  );
  for (const box of Object.values(ui.captionResultBoxes)) {
    box.value = "";
    box.hidden = true;
  }
  state.caption.text = "";
  ui.captionActiveFormat = null;
  try {
    const body = await state.api.caption({
      image: { data_url: state.caption.image },
      format: formats,
      instruction: ui.captionInstruction.value.trim(),
    });
    const results = body.multi ? body.results : { [body.format || formats[0]]: body };
    const names = { prose: "自然语言", tags: "逗号标签", moss: "MOSS 风格" };
    let filled = 0;
    for (const [format, result] of Object.entries(results)) {
      const box = ui.captionResultBoxes[format];
      if (!box || !result || !result.text) continue;
      box.value = result.text;
      box.hidden = false;
      if (!ui.captionActiveFormat) ui.captionActiveFormat = format;
      filled += 1;
    }
    if (!filled) {
      setStatus("模型没有返回内容。", "warn");
    } else {
      const got = Object.keys(results).filter((f) => ui.captionResultBoxes[f]?.value).map((f) => names[f] || f);
      setStatus(`反推完成：${got.join("、")}。`, "ok");
    }
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    state.caption.busy = false;
    updateButtons();
    updateCaptionWriteTargets();
  }
}

/** The write buttons act on the format block the user last edited or picked. */
function activeCaptionResult() {
  if (ui.captionActiveFormat) {
    const box = ui.captionResultBoxes[ui.captionActiveFormat];
    if (box && !box.hidden && box.value.trim()) return box;
  }
  for (const box of Object.values(ui.captionResultBoxes)) {
    if (!box.hidden && box.value.trim()) {
      ui.captionActiveFormat = box.dataset.format;
      return box;
    }
  }
  return null;
}

function updateCaptionWriteTargets() {
  // Highlight the block the write buttons will use; per-format labels keep
  // the user oriented when several blocks are on screen at once.
  const any = activeCaptionResult();
  for (const box of Object.values(ui.captionResultBoxes)) {
    box.classList.toggle(
      "is-active",
      box === any && Object.values(ui.captionResultBoxes).some((b) => !b.hidden),
    );
  }
  if (ui.captionReplace) ui.captionReplace.disabled = !any;
  if (ui.captionAppend) ui.captionAppend.disabled = !any;
}

function updateCaptionFormatButtons() {
  const any = Object.values(ui.captionFormatBoxes).some((box) => box.checked);
  if (ui.captionRun) ui.captionRun.disabled = !any || !state.caption.image;
}

async function insertCaption(mode) {
  const box = activeCaptionResult();
  const text = box ? box.value.trim() : "";
  if (!text) {
    setStatus("先反推，或在结果框里编辑出内容。", "warn");
    return;
  }
  const target = activeTarget();
  if (!target) {
    setStatus("先在画布上选择一个带提示词的节点。", "warn");
    return;
  }
  const formatLabel = { prose: "自然语言", tags: "逗号标签", moss: "MOSS 风格" }[box.dataset.format] || box.dataset.format;
  let next = text;
  if (mode === "append" && target.text.trim()) {
    const separator = /[\s,，]$/.test(target.text) ? " " : ", ";
    next = `${target.text.replace(/\s+$/, "")}${separator}${text}`;
  }
  try {
    await applyText(next, {
      key: target.key,
      source: mode === "append" ? "caption-append" : "caption",
      label: `反推写入（${formatLabel}）`,
    });
    switchTab("chat");
    addMessage("assistant", mode === "append" ? `已把${formatLabel}结果追加到提示词末尾。` : `已用${formatLabel}结果替换提示词。`, "可点底部“撤销”恢复。");
    setStatus("反推结果已写入，可撤销。", "ok");
  } catch (error) {
    setStatus(error.message || String(error), "error");
  }
}

// ----------------------------------------------------------------- history
function formatTime(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp * 1000);
  if (Number.isNaN(date.getTime())) return String(timestamp);
  return date.toLocaleString();
}

async function loadVersions() {
  if (!ui.historyList) return;
  if (!state.targetKey) {
    ui.historyList.textContent = "";
    ui.historyList.append(el("div", { class: "aps-placeholder" }, "先选择一个提示词节点。"));
    return;
  }
  ui.historyList.textContent = "";
  ui.historyList.append(el("div", { class: "aps-placeholder" }, "正在读取…"));
  try {
    const body = await state.api.listVersions(state.targetKey);
    state.versions = Array.isArray(body.versions) ? body.versions : [];
    renderVersions();
  } catch (error) {
    ui.historyList.textContent = "";
    ui.historyList.append(el("div", { class: "aps-placeholder is-error" }, error.message || String(error)));
  }
}

function renderVersions() {
  ui.historyList.textContent = "";
  ui.historyDetail.hidden = true;
  if (!state.versions.length) {
    ui.historyList.append(el("div", { class: "aps-placeholder" }, "还没有版本记录。应用或撤销修改后会自动记录。"));
    return;
  }
  for (const version of state.versions) {
    const item = el(
      "button",
      {
        class: "aps-version",
        type: "button",
        title: "查看这个版本",
        onclick: () => showVersion(version),
      },
      [
        el("span", { class: "aps-version-source" }, version.source || "apply"),
        el("span", { class: "aps-version-text" }, excerpt(version.text, 60)),
        el("span", { class: "aps-version-time" }, formatTime(version.created_at)),
      ],
    );
    ui.historyList.append(item);
  }
}

async function showVersion(version) {
  state.versionDetail = version;
  ui.historyDetail.hidden = false;
  ui.historyDetail.textContent = "";
  let full = version;
  if (!version.text) {
    try {
      full = await state.api.getVersion(version.id);
    } catch (error) {
      setStatus(error.message || String(error), "error");
      return;
    }
  }
  const text = el("textarea", { class: "aps-caption-result", rows: 6, readonly: true });
  text.value = full.text || "";
  ui.historyDetail.append(
    el("div", { class: "aps-row aps-row-between" }, [
      el("span", { class: "aps-hint" }, `${full.source || ""} · ${formatTime(full.created_at)}`),
      el("button", { class: "aps-link", type: "button", onclick: () => { ui.historyDetail.hidden = true; } }, "关闭"),
    ]),
    text,
    el("div", { class: "aps-row" }, [
      el(
        "button",
        { class: "aps-btn aps-primary", type: "button", onclick: () => restoreVersion(full) },
        "恢复这个版本",
      ),
    ]),
  );
}

async function restoreVersion(version) {
  if (state.busy) return;
  setBusy(true, "正在恢复版本…");
  try {
    const result = await applyText(version.text, {
      key: state.targetKey,
      source: "restore",
      label: `恢复 ${formatTime(version.created_at)}`,
    });
    if (result.applied) {
      switchTab("chat");
      addMessage("assistant", "已恢复这个版本。", "可点底部“撤销”回到恢复前的文本。");
      setStatus("版本已恢复，可撤销。", "ok");
    } else {
      setStatus("当前提示词已经和这个版本一致。", "info");
    }
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    setBusy(false);
  }
}

function updateHistoryTarget() {
  state.versions = [];
  if (ui.historyDetail) ui.historyDetail.hidden = true;
  if (state.tab === "history") void loadVersions();
}

// ------------------------------------------------------------------- mount
function mount(root, canvasApp) {
  state.app = canvasApp || app;
  // Node 2.0 re-runs the tab render when the sidebar container updates (for
  // example on every canvas selection).  Rebuilding would wipe the target
  // options and the draft, so reuse the panel already attached to this root.
  const alreadyMounted = Boolean(ui.panel && ui.panel.parentElement === root);
  if (!alreadyMounted) {
    buildPanel(root);
    mountStyles();
    ui.panel.dataset.panelState = "ready";
    ui.targetSelect.textContent = "";
    ui.targetSelect.append(el("option", { value: "" }, "正在扫描画布…"));
    switchTab(state.tab);
    renderMessages();
    renderCaptionPreview();
    updateCapabilityBadges();
    void loadStatus();
  }
  const panel = ui.panel;

  refreshTargets({ force: true });
  updateButtons();
  if (state.capability) updateCapabilityBadges();

  // Keep the panel in sync with canvas selection without polling the model.
  if (!state.syncTimer) {
    state.syncTimer = setInterval(() => {
      if (!panel.isConnected || state.busy || state.streaming) return;
      if (ui.targetSelect && ui.targetSelect.options.length) {
        const before = state.targetKey;
        refreshTargets();
        if (before !== state.targetKey) renderPrompt();
        else renderPrompt();
      }
    }, 800);
  }
}

// ------------------------------------------------------------- registration
function register() {
  const manager = app && app.extensionManager;
  if (!manager || typeof manager.registerSidebarTab !== "function") {
    console.warn(`[${EXTENSION_NAME}] 当前前端没有侧边栏 API，工作台不会显示。`);
    return false;
  }
  manager.registerSidebarTab({
    id: TAB_ID,
    icon: "pi pi-sparkles",
    title: "AI 提示词",
    tooltip: "AI 提示词工作台：反推、对话修改、差异审阅、撤销",
    type: "custom",
    render: (element) => {
      try {
        mount(element, app);
      } catch (error) {
        console.error("[ai-prompt-studio] panel failed", error);
        element.textContent = `AI 提示词工作台加载失败：${error && error.message ? error.message : error}`;
      }
    },
  });
  return true;
}

app.registerExtension({
  name: EXTENSION_NAME,
  setup() {
    mountStyles();
    register();
  },
});
