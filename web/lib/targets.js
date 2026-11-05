/**
 * Locating prompt / image widgets on the ComfyUI canvas.
 *
 * Everything here is deliberately defensive: custom nodes expose wildly
 * different shapes, so a missing field must never throw inside a sidebar tab.
 */

const PROMPT_NAMES = new Set([
  "text",
  "prompt",
  "positive",
  "negative",
  "string",
  "wildcard",
  "text_g",
  "text_l",
  "clip_l",
  "clip_g",
  "t5xxl",
]);

const IMAGE_NAMES = new Set(["image", "upload", "image_path", "filename"]);
const NON_TEXT_TYPES = new Set(["button", "toggle", "number", "slider", "combo"]);

export function isPromptWidget(widget) {
  if (!widget) return false;
  const name = String(widget.name || "").toLowerCase();
  const type = String(widget.type || "").toLowerCase();
  if (IMAGE_NAMES.has(name)) return false;
  if (type === "customtext") return true;
  if (NON_TEXT_TYPES.has(type)) return false;
  return PROMPT_NAMES.has(name);
}

export function isImageWidget(widget) {
  if (!widget) return false;
  return IMAGE_NAMES.has(String(widget.name || "").toLowerCase());
}

export function widgetText(widget) {
  if (!widget) return "";
  const value = widget.value;
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

export function nodeTitle(node) {
  if (!node) return "节点";
  const title =
    node.title ||
    node.type ||
    node.comfyClass ||
    (node.constructor && node.constructor.title) ||
    "节点";
  return String(title);
}

export function nodeIdOf(node) {
  return node && node.id != null ? node.id : null;
}

export function targetKey(node, widget) {
  return `node:${nodeIdOf(node)}:${widget ? widget.name : ""}`;
}

export function describeTarget(node, widget) {
  return {
    key: targetKey(node, widget),
    node_id: nodeIdOf(node),
    widget: widget ? String(widget.name || "") : "",
    title: nodeTitle(node),
    text: widgetText(widget),
    node,
    widgetRef: widget,
  };
}

/**
 * JSON-safe view of a target for HTTP bodies.
 *
 * `describeTarget` keeps live LiteGraph references so the panel can read and
 * write the widget; those objects are circular, so they must never be handed
 * to `JSON.stringify` (a real graph would throw before the request is even
 * sent).  Only the plain fields the backend understands travel over the wire.
 */
export function targetWire(target) {
  if (!target) return null;
  return {
    node_id: target.node_id ?? null,
    widget: String(target.widget || ""),
    title: String(target.title || ""),
    text: String(target.text ?? ""),
  };
}

export function promptWidgets(node) {
  const widgets = Array.isArray(node && node.widgets) ? node.widgets : [];
  return widgets.filter(isPromptWidget);
}

/** One descriptor per prompt widget, in widget order. */
export function nodeTargets(node) {
  return promptWidgets(node).map((widget) => describeTarget(node, widget));
}

function selectedNodes(app) {
  const canvas = app && app.canvas;
  const selected = canvas && canvas.selected_nodes;
  if (!selected) return [];
  if (Array.isArray(selected)) return selected.filter(Boolean);
  return Object.keys(selected)
    .map((key) => selected[key])
    .filter(Boolean);
}

function allNodes(app) {
  const nodes = app && app.graph && app.graph._nodes;
  return Array.isArray(nodes) ? nodes : [];
}

/**
 * Prompt targets to offer the user: selected nodes first, then the rest of the
 * graph. Duplicate keys are removed; selection never hides other options.
 */
export function collectTargets(app, { limit = 200 } = {}) {
  const out = [];
  const seen = new Set();
  const push = (node) => {
    for (const target of nodeTargets(node)) {
      if (seen.has(target.key)) continue;
      seen.add(target.key);
      out.push(target);
    }
  };
  selectedNodes(app).forEach(push);
  allNodes(app).slice(0, limit).forEach(push);
  return out;
}

/** The target a user most likely means: first prompt widget of the selection. */
export function currentTarget(app) {
  const nodes = selectedNodes(app);
  for (const node of nodes) {
    const widgets = promptWidgets(node);
    if (widgets.length) return describeTarget(node, widgets[0]);
  }
  const nodesWithText = allNodes(app).filter((node) => promptWidgets(node).length);
  if (nodesWithText.length === 1) {
    return nodeTargets(nodesWithText[0])[0];
  }
  return null;
}

export function findTargetByKey(app, key) {
  const match = /^node:([^:]+):(.*)$/.exec(String(key || ""));
  if (!match) return null;
  const [, id, widgetName] = match;
  const node = allNodes(app).find((item) => String(nodeIdOf(item)) === id);
  if (!node) return null;
  const widget = promptWidgets(node).find((item) => item.name === widgetName);
  return widget ? describeTarget(node, widget) : null;
}

export function findImageNode(app) {
  const nodes = selectedNodes(app);
  for (const node of nodes) {
    if (imageSource(node)) return node;
  }
  return null;
}

/** A URL the browser can fetch for a node's preview image, if any. */
export function imageSource(node) {
  if (!node) return null;
  const candidates = [];
  if (Array.isArray(node.imgs)) candidates.push(...node.imgs);
  if (Array.isArray(node.images)) candidates.push(...node.images);
  for (const item of candidates) {
    if (!item) continue;
    if (typeof item === "string") return { url: item };
    if (item.src) return { url: String(item.src) };
    if (item.currentSrc) return { url: String(item.currentSrc) };
  }
  const widgets = Array.isArray(node.widgets) ? node.widgets : [];
  for (const widget of widgets) {
    if (!isImageWidget(widget)) continue;
    const value = widgetText(widget);
    if (value) return { url: null, filename: value };
  }
  return null;
}

/**
 * Write a new value into a widget the way a user edit would: value, callback,
 * node hook, then repaint. Returns the previous value for undo.
 */
export function setWidgetText(app, target, text) {
  if (!target || !target.widgetRef) {
    throw new Error("提示词控件不存在，可能已被删除。");
  }
  const widget = target.widgetRef;
  const before = widget.value;
  if (before === text) return { before, changed: false };
  widget.value = text;
  try {
    widget.callback?.(text, app && app.canvas, target.node, [0, 0], {});
  } catch (error) {
    console.warn("[ai-prompt-studio] widget callback failed", error);
  }
  try {
    target.node?.onWidgetChanged?.(widget.name, text, before, widget);
  } catch (error) {
    console.warn("[ai-prompt-studio] onWidgetChanged failed", error);
  }
  try {
    app?.graph?.setDirtyCanvas?.(true, true);
  } catch {
    /* canvas may be gone */
  }
  return { before, changed: true };
}
