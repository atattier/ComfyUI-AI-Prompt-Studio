/**
 * Minimal stand-in for ComfyUI's /scripts/app.js, used only by the local UI
 * harness (scripts/dev_harness.py).  It is never installed into ComfyUI.
 */

function widget(name, value, type = "string") {
  return { name, value, type, options: {}, callback: null };
}

function createNode(init) {
  const node = {
    ...init,
    size: init.size || [300, 180],
    domWidgets: [],
    addWidget(type, name, value, callback, options = {}) {
      const w = { name, value, type, callback, options };
      this.widgets.push(w);
      return w;
    },
    addDOMWidget(name, type, element, options = {}) {
      const w = { name, type, element, options };
      this.domWidgets.push(w);
      this.widgets.push(w);
      return w;
    },
    setSize(size) {
      this.size = size;
    },
  };
  return node;
}

const initialPayload = JSON.stringify({
  schema: "comfyui.ai_prompt_studio.caption_payload.v1",
  mode: "hybrid",
  size: [1024, 1024],
  summary: {
    caption: "海报主视觉，前景发光产品瓶身特写，背景深蓝渐变与金色粒子散景",
  },
  regions: [
    {
      label: "主产品瓶身",
      bbox: [320, 224, 704, 832],
      caption: "通透玻璃瓶身，暖金色高光，边缘清晰",
    },
    {
      label: "标题文字区",
      bbox: [160, 80, 864, 208],
      caption: "留白干净，柔和暗角衬托文字",
    },
  ],
});

const nodes = [
  createNode({
    id: 12,
    title: "AI 提示词反推与布局 (Prompt Studio)",
    type: "AIPromptStudioCaption",
    comfyClass: "AIPromptStudioCaption",
    pos: [40, 40],
    size: [390, 460],
    inputs: [{ name: "image", type: "IMAGE", link: 1 }],
    widgets: [
      widget("mode", "hybrid", "combo"),
      widget("style", "detailed", "combo"),
      widget("focus", "", "string"),
      widget("width", 1024, "number"),
      widget("height", 1024, "number"),
      widget("max_regions", 6, "number"),
      widget("use_cache", true, "toggle"),
      widget("payload", initialPayload, "string"),
    ],
  }),
  createNode({
    id: 6,
    title: "正向提示词",
    type: "CLIPTextEncode",
    comfyClass: "CLIPTextEncode",
    pos: [460, 40],
    widgets: [widget("text", "a cat on a mat, sunny afternoon, 35mm photo")],
  }),
  createNode({
    id: 7,
    title: "负向提示词",
    type: "CLIPTextEncode",
    comfyClass: "CLIPTextEncode",
    pos: [460, 200],
    widgets: [widget("text", "blurry, low quality, watermark")],
  }),
  createNode({
    id: 9,
    title: "参考图",
    type: "LoadImage",
    comfyClass: "LoadImage",
    pos: [460, 340],
    widgets: [widget("image", "poster.png")],
    imgs: [{ src: "/view?filename=poster.png&type=input" }],
  }),
];

const links = {
  1: { id: 1, origin_id: 9, origin_slot: 0, target_id: 12, target_slot: 0 },
};

const byId = new Map(nodes.map((node) => [node.id, node]));
let sidebarTab = null;

function renderCards() {
  const host = document.getElementById("canvas-nodes");
  if (!host) return;
  host.textContent = "";
  for (const node of nodes) {
    const card = document.createElement("div");
    card.className = "node-card";
    if (node.comfyClass === "AIPromptStudioCaption") {
      card.classList.add("node-card-wide");
    }
    card.dataset.id = String(node.id);
    if (app.canvas.selected_nodes[node.id]) card.classList.add("is-selected");
    const title = document.createElement("div");
    title.className = "node-title";
    title.textContent = `${node.title} · #${node.id}`;
    card.append(title);

    if (node.domWidgets && node.domWidgets.length > 0) {
      for (const dw of node.domWidgets) {
        if (dw.element) {
          const wrap = document.createElement("div");
          wrap.className = "node-dom-host";
          wrap.append(dw.element);
          card.append(wrap);
        }
      }
    } else {
      if (node.imgs) {
        const img = document.createElement("img");
        img.src = node.imgs[0].src;
        img.alt = node.widgets[0].value;
        card.append(img);
      }
      const value = document.createElement("div");
      value.className = "node-value";
      value.textContent = node.widgets[0]?.value ?? "";
      card.append(value);
    }

    card.addEventListener("click", (e) => {
      if (e.target.closest("button, input, textarea, select, svg")) return;
      select(node.id);
    });
    card.addEventListener("dblclick", (e) => {
      if (e.target.closest("button, input, textarea, select")) return;
      node.onDblClick?.(e, [0, 40]);
    });
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
    links,
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
      if (typeof extension.beforeRegisterNodeDef === "function") {
        for (const node of nodes) {
          const fakeProto = {};
          const fakeType = { prototype: fakeProto, comfyClass: node.comfyClass };
          extension.beforeRegisterNodeDef(fakeType, { name: node.comfyClass }, app);
          if (typeof fakeProto.onNodeCreated === "function" && !node._apsMounted) {
            node._apsMounted = true;
            Object.assign(node, fakeProto);
            node.onNodeCreated();
          }
        }
        renderCards();
      }
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
