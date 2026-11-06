/**
 * Frontend extension for the AIPromptStudioCaption graph node.
 *
 * Adds 「反推」and「编辑…」buttons, resolves the upstream LoadImage filename to
 * a data URL (the HTTP route cannot see the execution context's IMAGE tensor),
 * and persists the whole result in the ``payload`` widget so it survives
 * workflow save/reload.  Manual edits are never silently overwritten: 反推
 * asks for confirmation when the payload has been edited by the user.
 */

import { app } from "../../scripts/app.js";

import { StudioApi } from "./lib/api.js";
import { blobToDataUrl } from "./lib/images.js";
import { openLayoutEditor } from "./lib/layout_editor.js";

const NODE_TYPE = "AIPromptStudioCaption";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const api = new StudioApi();

function widget(node, name) {
  return node.widgets?.find((w) => w.name === name) || null;
}

function setPayload(node, state) {
  const w = widget(node, "payload");
  if (!w) throw new Error("节点缺少 payload 控件。");
  w.value = JSON.stringify(state);
  node._apsDirty = false;
  node.setDirtyCanvas?.(true, true);
}

function readPayload(node) {
  const w = widget(node, "payload");
  try {
    const parsed = JSON.parse(w?.value || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function currentMode(node) {
  return widget(node, "mode")?.value || "caption";
}

/** Find the LoadImage node feeding our IMAGE input and read its filename widget. */
function upstreamImageFile(node) {
  const link = node.inputs?.find((i) => i.name === "image" && i.link != null);
  if (!link) return null;
  const graph = node.graph;
  const sourceLink = graph?.links?.get
    ? graph.links.get(link.link)
    : (graph?.links || []).find?.((l) => l && (l.id === link.link));
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
  if (!filename) return null;
  // ComfyUI's /view serves input images same-origin; never hand the model a
  // LAN-only URL. Convert to a data URL and send it in the request body.
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
  return blobToDataUrl(blob);
}

async function runCaption(node, statusEl) {
  const mode = currentMode(node);
  const pathWidget = widget(node, "image_path");
  const imagePath = String(pathWidget?.value || "").trim();
  const existing = readPayload(node);
  // 编辑保护：用户手改过内容时，不静默覆盖。
  if (node._apsDirty && (existing.caption || existing.draft)) {
    if (!globalThis.confirm?.("已手动编辑过反推结果，重新反推会覆盖修改。继续吗？")) return;
  }
  statusEl.textContent = "正在反推图片…";
  try {
    const imageData = await fetchImageDataUrl(node);
    if (!imageData && !imagePath) {
      throw new Error("请连接一个 LoadImage 节点的 IMAGE 输出，或填写本地 image_path。");
    }
    const body = {
      mode,
      image_path: imagePath,
      extra_instruction: String(widget(node, "extra_instruction")?.value || ""),
      model: String(widget(node, "model")?.value || ""),
    };
    // image 优先：有上游图片数据时仍传 image_path 供后端记录，但后端只用 data URL。
    if (imageData) body.image = { data_url: imageData };
    const result = await api.request("/caption_node", { method: "POST", body });
    const state = result.payload || {};
    state.mode = mode;
    setPayload(node, state);
    statusEl.textContent = `反推完成：${result.width}×${result.height}（原图 ${result.source_width}×${result.source_height}）`;
    node.setDirtyCanvas?.(true, true);
  } catch (err) {
    statusEl.textContent = `反推失败：${err?.message || err}`;
  }
}

function openEditor(node, statusEl) {
  const mode = currentMode(node);
  const state = readPayload(node);
  if (!state.width || !state.height) {
    // No result yet: show a blank editor at 1024x1024 so the user can still
    // draw boxes before ever calling the model.
    state.width = 1024;
    state.height = 1024;
    state.caption = state.caption || "";
  }
  openLayoutEditor({
    state,
    mode,
    onApply: (next) => {
      next.mode = mode;
      if (mode === "caption") delete next.draft;
      setPayload(node, next);
      node._apsDirty = true;  // manual edit: 反推 will ask before overwriting
      statusEl.textContent = "编辑已应用，已写入节点（随工作流保存）。";
      node.setDirtyCanvas?.(true, true);
    },
    onCancel: () => { statusEl.textContent = "已取消编辑，修改未应用。"; },
  });
}

function addButtons(node) {
  if (node._apsButtonsAdded) return;
  node._apsButtonsAdded = true;
  const statusEl = { textContent: "" };
  const run = node.addWidget("button", "反推", null, () => runCaption(node, statusEl), {
    serialize: false,
  });
  const edit = node.addWidget("button", "编辑…", null, () => openEditor(node, statusEl), {
    serialize: false,
  });
  node._apsStatus = statusEl;
  run.options = { ...(run.options || {}), serialize: false };
  edit.options = { ...(edit.options || {}), serialize: false };
}

function onNodeCreated(node) {
  if (node.comfyClass !== NODE_TYPE && node.type !== NODE_TYPE) return;
  addButtons(node);
  // Node title double-click opens the editor, as agreed.
  const original = node.onDblClick;
  node.onDblClick = function (...args) {
    openEditor(node, node._apsStatus || { textContent: "" });
    return original?.apply(this, args);
  };
}

export const extension = {
  name: "AI Prompt Studio.CaptionNode",
  async setup() {
    // Nodes already on the graph (workflow loaded before this extension ran).
    for (const node of app?.graph?._nodes || []) onNodeCreated(node);
  },
  async nodeCreated(node) {
    onNodeCreated(node);
  },
};

app.registerExtension(extension);

export const _test = { upstreamImageFile, readPayload, setPayload, currentMode };
