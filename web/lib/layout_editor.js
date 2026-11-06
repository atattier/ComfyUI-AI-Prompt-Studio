/**
 * Layout editor modal for the AI caption graph node.
 *
 * Pure-DOM overlay attached to document.body: works with both LiteGraph and
 * Node 2.0 frontends (no reliance on node canvas drawing hooks).  Boxes are
 * SVG in normalized draft space (absolute pixels relative to width/height),
 * dragged/resized with pointer events, and every edit updates the same draft
 * object that the list and the SVG read from.
 */

const LABELS = ["object", "character", "text"];
const BOX_COLORS = ["#6ea8fe", "#3fb950", "#d29922", "#e879f9", "#f85149", "#22d3ee"];

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
  const draft = state?.draft;
  if (draft && Array.isArray(draft.items) && draft.items.length) {
    return {
      width: draft.width || width,
      height: draft.height || height,
      bbox_coord_space: "abs",
      bbox_format: "xyxy",
      summary: { caption: String(draft.summary?.caption || state?.caption || ""), canvas: "single" },
      items: draft.items.map((it) => ({
        label: LABELS.includes(it.label) ? it.label : "object",
        caption: String(it.caption || ""),
        text: String(it.text || ""),
        bbox: (Array.isArray(it.bbox) && it.bbox.length === 4)
          ? it.bbox.map((v) => Number(v) || 0) : [0, 0, width, height],
      })),
    };
  }
  return {
    width, height,
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
  svg.setAttribute("preserveAspectRatio", "none");
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
 * Open the editor.
 * @param {object} opts
 *   state: current payload (plain object), mode: caption|layout|hybrid,
 *   onApply: (newState) => void, onCancel?: () => void
 * @returns {{close: () => void}} handle
 */
export function openLayoutEditor({ state = {}, mode = "layout", onApply, onCancel }) {
  const width = Math.max(16, Number(state.width) || 1024);
  const height = Math.max(16, Number(state.height) || 1024);
  const hasLayout = mode !== "caption";
  // Working copy: 取消 discards it entirely; 应用 commits it.
  const draft = hasLayout ? cloneDraft(state, width, height) : null;
  const captionText = String(state.caption || "");

  const overlay = el("div", "aps-modal-overlay");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  const modal = el("div", "aps-modal");
  const head = el("div", "aps-modal-head");
  head.append(el("div", "aps-modal-title", mode === "caption" ? "编辑反推描述" : "编辑布局"));
  const sizeNote = el("span", "aps-modal-note", `${width} × ${height}（16 倍数）`);
  head.append(sizeNote);
  modal.append(head);

  const body = el("div", "aps-modal-body");
  const canvasWrap = el("div", "aps-layout-canvas-wrap");
  canvasWrap.hidden = !hasLayout;
  const svg = createSvg(width, height);
  canvasWrap.append(svg);
  body.append(canvasWrap);

  const capField = el("label", "aps-modal-field");
  capField.append(el("span", "", mode === "caption" ? "描述文本" : "整体描述（summary.caption）"));
  const capArea = el("textarea", "aps-modal-textarea");
  capArea.value = captionText;
  capField.append(capArea);
  body.append(capField);

  const listHost = el("div", "aps-layout-list");
  listHost.hidden = !hasLayout;
  body.append(listHost);

  let selected = -1;
  let pointerDrag = null;

  function renderBoxes() {
    svg.textContent = "";
    const NS = "http://www.w3.org/2000/svg";
    svg.append(svgRect(NS, 0, 0, width, height, {
      fill: "#11151b", stroke: "#3a3f45", "stroke-width": 2,
    }));
    if (!draft) return;
    draft.items.forEach((item, index) => {
      const [x1, y1, x2, y2] = item.bbox;
      const color = BOX_COLORS[index % BOX_COLORS.length];
      const group = document.createElementNS(NS, "g");
      group.setAttribute("data-index", index);
      group.style.cursor = "move";
      const rect = svgRect(NS, x1, y1, Math.max(1, x2 - x1), Math.max(1, y2 - y1), {
        fill: color + "22", stroke: color,
        "stroke-width": selected === index ? 8 : 4,
        "stroke-dasharray": selected === index ? "none" : "12 8",
      });
      group.append(rect);
      const label = document.createElementNS(NS, "text");
      label.setAttribute("x", x1 + 12);
      label.setAttribute("y", y1 + Math.min(40, height / 10));
      label.setAttribute("fill", color);
      label.setAttribute("font-size", Math.max(18, Math.round(width / 40)));
      label.textContent = `${index + 1} · ${item.label}`;
      label.style.pointerEvents = "none";
      group.append(label);
      // resize handle (bottom-right)
      const handle = svgRect(NS, x2 - Math.max(20, width / 60), y2 - Math.max(20, width / 60),
        Math.max(20, width / 60), Math.max(20, width / 60), {
          fill: color, stroke: "#10141a", "stroke-width": 2,
        });
      handle.setAttribute("data-resize", String(index));
      handle.style.cursor = "nwse-resize";
      group.append(handle);
      svg.append(group);
    });
  }

  function renderList() {
    listHost.textContent = "";
    if (!draft) return;
    const toolbar = el("div", "aps-layout-toolbar");
    const addBtn = el("button", "aps-btn", "+ 加区域");
    addBtn.type = "button";
    addBtn.addEventListener("click", () => {
      const w = Math.round(width * 0.35);
      const h = Math.round(height * 0.35);
      draft.items.push({
        label: "object", caption: "New region", text: "",
        bbox: [Math.round(width * 0.3), Math.round(height * 0.3),
          Math.round(width * 0.3) + w, Math.round(height * 0.3) + h],
      });
      selected = draft.items.length - 1;
      renderBoxes();
      renderList();
    });
    toolbar.append(addBtn);
    listHost.append(toolbar);
    draft.items.forEach((item, index) => {
      const row = el("div", "aps-layout-item" + (selected === index ? " is-active" : ""));
      const idx = el("span", "aps-layout-index", String(index + 1));
      idx.style.color = BOX_COLORS[index % BOX_COLORS.length];
      row.append(idx);
      const labelSel = el("select", "aps-select");
      for (const name of LABELS) {
        const option = el("option", "", name);
        option.value = name;
        labelSel.append(option);
      }
      labelSel.value = item.label;
      labelSel.addEventListener("change", () => {
        item.label = labelSel.value;
        renderBoxes();
        renderList();
      });
      row.append(labelSel);
      const captionInput = el("textarea", "aps-modal-textarea aps-layout-caption");
      captionInput.value = item.caption;
      captionInput.rows = 2;
      captionInput.addEventListener("input", () => { item.caption = captionInput.value; });
      row.append(captionInput);
      if (item.label === "text") {
        const literal = el("input", "aps-input");
        literal.placeholder = "可见文字原文（text）";
        literal.value = item.text || "";
        literal.addEventListener("input", () => { item.text = literal.value; });
        row.append(literal);
      }
      const coords = el("span", "aps-layout-coords", item.bbox.join(", "));
      coords.dataset.coords = String(index);
      row.append(coords);
      const del = el("button", "aps-btn", "删除");
      del.type = "button";
      del.addEventListener("click", () => {
        draft.items.splice(index, 1);
        if (selected >= draft.items.length) selected = draft.items.length - 1;
        renderBoxes();
        renderList();
      });
      row.append(del);
      row.addEventListener("pointerdown", (ev) => {
        if (ev.target.closest("input, textarea, select, button")) return;
        selected = index;
        renderBoxes();
        renderList();
      });
      listHost.append(row);
    });
  }

  function toCanvasPoint(ev) {
    const rect = svg.getBoundingClientRect();
    return {
      x: clamp((ev.clientX - rect.left) / rect.width * width, 0, width),
      y: clamp((ev.clientY - rect.top) / rect.height * height, 0, height),
    };
  }

  svg.addEventListener("pointerdown", (ev) => {
    if (!draft) return;
    const group = ev.target.closest?.("g[data-index]");
    if (!group) return;
    const index = Number(group.dataset.index);
    selected = index;
    const item = draft.items[index];
    if (!item) return;
    const resize = ev.target.hasAttribute?.("data-resize");
    pointerDrag = {
      index, resize,
      start: toCanvasPoint(ev),
      bbox: item.bbox.slice(),
    };
    try {
      svg.setPointerCapture(ev.pointerId);
    } catch {
      // Synthetic PointerEvents (automation/tests) have no active pointer;
      // drag still works because move/up are handled on the same element.
    }
    // Do NOT re-render the SVG here: replacing the group would detach the
    // element receiving pointermove/up, silently killing the drag.
    for (const g of svg.querySelectorAll("g[data-index]")) {
      const r = g.querySelector("rect");
      if (r) r.setAttribute("stroke-width", Number(g.dataset.index) === index ? "8" : "4");
    }
    renderList();
  });
  svg.addEventListener("pointermove", (ev) => {
    if (!pointerDrag || !draft) return;
    const item = draft.items[pointerDrag.index];
    if (!item) return;
    const point = toCanvasPoint(ev);
    const dx = point.x - pointerDrag.start.x;
    const dy = point.y - pointerDrag.start.y;
    const [x1, y1, x2, y2] = pointerDrag.bbox;
    if (pointerDrag.resize) {
      item.bbox = [x1, y1, clamp(Math.round(x2 + dx), x1 + 2, width),
        clamp(Math.round(y2 + dy), y1 + 2, height)];
    } else {
      const w = x2 - x1;
      const h = y2 - y1;
      const nx1 = clamp(Math.round(x1 + dx), 0, width - w);
      const ny1 = clamp(Math.round(y1 + dy), 0, height - h);
      item.bbox = [nx1, ny1, nx1 + w, ny1 + h];
    }
    const [nx1, ny1, nx2, ny2] = item.bbox;
    // Update attributes in place: a full re-render here would replace the
    // element mid-drag and break subsequent pointermove events.
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
      label.setAttribute("x", nx1 + 12);
      label.setAttribute("y", ny1 + Math.min(40, height / 10));
    }
    const handle = group?.querySelector("rect[data-resize]");
    if (handle) {
      const hs = Math.max(20, width / 60);
      handle.setAttribute("x", nx2 - hs);
      handle.setAttribute("y", ny2 - hs);
    }
    const coords = listHost.querySelector(`.aps-layout-coords[data-coords="${pointerDrag.index}"]`);
    if (coords) coords.textContent = item.bbox.join(", ");
  });
  const endDrag = () => {
    if (!pointerDrag) return;
    pointerDrag = null;
    renderBoxes();
    renderList();
  };
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);

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
  renderBoxes();
  renderList();

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
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
    if (ev.target === overlay) { onCancel?.(); close(); }
  });
  cancelBtn.addEventListener("click", () => { onCancel?.(); close(); });
  applyBtn.addEventListener("click", () => {
    const next = { ...state, caption: capArea.value, width, height };
    if (draft) {
      draft.summary.caption = capArea.value || draft.summary.caption;
      next.draft = normalizeDraft(draft, width, height);
    }
    try {
      onApply?.(next);
      close();
    } catch (err) {
      status.textContent = String(err?.message || err);
    }
  });
  return { close };
}

export const _test = { cloneDraft, clamp };
