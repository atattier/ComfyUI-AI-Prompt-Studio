/**
 * Minimal stand-in for ComfyUI's /scripts/app.js, used only by the local UI
 * harness (scripts/dev_harness.py).  It is never installed into ComfyUI.
 */

function widget(name, value, type = "string") {
  return { name, value, type, options: {}, callback: null };
}

const nodes = [
  {
    id: 6,
    title: "正向提示词",
    type: "CLIPTextEncode",
    pos: [40, 60],
    widgets: [widget("text", "a cat on a mat, sunny afternoon, 35mm photo")],
  },
  {
    id: 7,
    title: "负向提示词",
    type: "CLIPTextEncode",
    pos: [40, 220],
    widgets: [widget("text", "blurry, low quality, watermark")],
  },
  {
    id: 9,
    title: "参考图",
    type: "LoadImage",
    pos: [40, 360],
    widgets: [widget("image", "poster.png")],
    imgs: [{ src: "/view?filename=poster.png&type=input" }],
  },
];

const byId = new Map(nodes.map((node) => [node.id, node]));
let sidebarTab = null;

function renderCards() {
  const host = document.getElementById("canvas-nodes");
  if (!host) return;
  host.textContent = "";
  for (const node of nodes) {
    const card = document.createElement("div");
    card.className = "node-card";
    card.dataset.id = String(node.id);
    if (app.canvas.selected_nodes[node.id]) card.classList.add("is-selected");
    const title = document.createElement("div");
    title.className = "node-title";
    title.textContent = `${node.title} · #${node.id}`;
    card.append(title);
    if (node.imgs) {
      const img = document.createElement("img");
      img.src = node.imgs[0].src;
      img.alt = node.widgets[0].value;
      card.append(img);
    }
    const value = document.createElement("div");
    value.className = "node-value";
    value.textContent = node.widgets[0].value;
    card.append(value);
    card.addEventListener("click", () => select(node.id));
    host.append(card);
  }
}

function select(id) {
  app.canvas.selected_nodes = {};
  const node = byId.get(Number(id));
  if (node) app.canvas.selected_nodes[node.id] = node;
  renderCards();
  document.querySelectorAll(".node-card").forEach((card) => {
    card.classList.toggle("is-selected", Number(card.dataset.id) === Number(id));
  });
}

export const app = {
  canvas: { selected_nodes: {} },
  graph: {
    _nodes: nodes,
    setDirtyCanvas() {
      renderCards();
    },
    getNodeById(id) {
      return byId.get(Number(id)) || null;
    },
  },
  extensionManager: {
    registerSidebarTab(descriptor) {
      sidebarTab = descriptor;
      const host = document.getElementById("aps-host");
      if (host) descriptor.render(host);
    },
  },
  registerExtension(extension) {
    try {
      extension.setup?.();
    } catch (error) {
      console.error("[harness] extension setup failed", error);
    }
  },
};

window.app = app;
window.__harness = {
  select,
  nodes,
  get tab() {
    return sidebarTab;
  },
};

app.canvas.selected_nodes[6] = byId.get(6);
renderCards();
