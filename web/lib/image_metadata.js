/**
 * Prompt metadata recovered from an image's own file bytes (ComfyUI PNG tEXt,
 * A1111 parameters, embedded layout JSON).  The backend does the parsing; this
 * module turns its answer into a dialog summary and merges it into a node
 * payload without touching slots the image does not carry.
 */

import { rescaleLayoutDraft } from "./layout_editor.js?v=20261119_v50";

const SNIPPET_LIMIT = 90;

/**
 * A caption the image actually carries.  The backend fills a missing caption
 * from the layout draft's own summary, so on a layout-only image the two are
 * byte-identical; that is not a written caption and must not replace the
 * node's prose.
 */
function writtenCaption(meta) {
  const caption = String(meta?.prompts?.caption || "").trim();
  if (!caption) return "";
  const draft = meta?.draft;
  const items = Array.isArray(draft?.items) ? draft.items : [];
  const summaryCaption = String(draft?.summary?.caption || "").trim();
  if (items.length && caption === summaryCaption) return "";
  return caption;
}

/** What the picture carries, in words the node card can show. */
export function imageMetadataSummary(meta) {
  const prompts = meta?.prompts || {};
  const items = Array.isArray(meta?.draft?.items) ? meta.draft.items : [];
  const parts = [];
  const caption = writtenCaption(meta);
  if (caption) parts.push("散文提示词");
  if (prompts.layout || items.length) {
    parts.push(items.length ? `布局提示词（${items.length} 个画框）` : "布局提示词");
  }
  if (prompts.danbooru) parts.push("Danbooru 标签");
  return {
    parts,
    captionSnippet: caption.length > SNIPPET_LIMIT ? `${caption.slice(0, SNIPPET_LIMIT)}…` : caption,
    hasLayout: items.length > 0,
    boxCount: items.length,
  };
}

/**
 * Write the metadata into `state` (mutates it).
 * If `overwriteAll` is true (the default when user selects "应用并覆盖"),
 * prompt slots and boxes absent from the incoming image are cleanly cleared,
 * ensuring no leftover boxes or prompts from the previous image linger.
 * Boxes are rescaled once from the draft's own coordinate space to the canvas.
 */
export function mergeImageMetadataIntoState(
  state,
  meta,
  { width, height, overwriteAll = true } = {},
) {
  if (!state || !meta) return { applied: [], boxCount: 0 };
  const prompts = meta.prompts || {};
  const applied = [];

  const caption = writtenCaption(meta);
  if (caption) {
    state.caption = caption;
    state.caption_text = caption;
    applied.push("caption");
  } else if (overwriteAll) {
    state.caption = "";
    state.caption_text = "";
  }

  const danbooru = String(prompts.danbooru || "").trim();
  if (danbooru) {
    state.danbooru = danbooru;
    state.danbooru_prompt = danbooru;
    state.danbooru_text = danbooru;
    state.tags = danbooru;
    applied.push("danbooru");
  } else if (overwriteAll) {
    state.danbooru = "";
    state.danbooru_prompt = "";
    state.danbooru_text = "";
    state.tags = "";
  }

  const layout = String(prompts.layout || "").trim();
  if (layout) {
    state.layout = layout;
    state.layout_prompt = layout;
    state.layout_text = layout;
    applied.push("layout");
  } else if (overwriteAll) {
    state.layout = "";
    state.layout_prompt = "";
    state.layout_text = "";
  }

  const draft = meta.draft;
  const items = Array.isArray(draft?.items) ? draft.items : [];
  let boxCount = 0;
  const w = Number(width) || Number(state.width) || 1024;
  const h = Number(height) || Number(state.height) || 1024;

  if (items.length) {
    const srcW = Number(draft.width) || Number(meta.width) || w;
    const srcH = Number(draft.height) || Number(meta.height) || h;
    const scaled = rescaleLayoutDraft(draft, w, h, srcW, srcH);
    state.draft = scaled;
    state.layout_draft = scaled;
    state.hybrid_draft = {
      ...scaled,
      summary: {
        ...(scaled.summary || {}),
        caption: state.caption_text || state.caption || scaled.summary?.caption || "",
      },
    };
    boxCount = Array.isArray(scaled.items) ? scaled.items.length : 0;
    applied.push("boxes");
  } else if (overwriteAll) {
    const emptyDraft = { width: w, height: h, summary: {}, items: [] };
    state.draft = emptyDraft;
    state.layout_draft = emptyDraft;
    state.hybrid_draft = emptyDraft;
  }

  return { applied, boxCount };
}

/**
 * Ask before replacing the node's prompt slots.  Resolves `true` only when the
 * user presses the apply button; backdrop, Escape and 忽略 all resolve `false`.
 */
export function openImageMetadataDialog({
  summary,
  willOverwrite = false,
  imageName = "",
  width = 0,
  height = 0,
} = {}) {
  if (typeof document === "undefined") return Promise.resolve(false);
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "aps-modal-overlay aps-image-meta-overlay notranslate";
    const card = document.createElement("div");
    card.className = "aps-subdialog-card aps-image-meta-card";

    const title = document.createElement("div");
    title.className = "aps-subdialog-title";
    title.textContent = "这张图自带提示词";
    card.append(title);

    const subject = imageName ? `「${imageName}」` : "这张图";
    const foundLine = document.createElement("div");
    foundLine.className = "aps-subdialog-msg";
    const foundText = summary?.parts?.length ? summary.parts.join(" · ") : "提示词";
    foundLine.textContent = `${subject}识别到：${foundText}`;
    card.append(foundLine);

    if (width > 0 && height > 0) {
      const sizeLine = document.createElement("div");
      sizeLine.className = "aps-subdialog-msg";
      sizeLine.textContent = `图片尺寸：${width} × ${height}`;
      card.append(sizeLine);
    }

    if (summary?.captionSnippet) {
      const snippet = document.createElement("div");
      snippet.className = "aps-image-meta-caption";
      snippet.textContent = summary.captionSnippet;
      card.append(snippet);
    }

    if (willOverwrite) {
      const warn = document.createElement("div");
      warn.className = "aps-subdialog-msg";
      warn.textContent = "应用后会覆盖当前节点里的提示词与画框。";
      card.append(warn);
    }

    const foot = document.createElement("div");
    foot.className = "aps-subdialog-foot";
    const ignoreBtn = document.createElement("button");
    ignoreBtn.type = "button";
    ignoreBtn.className = "aps-btn aps-btn-sm";
    ignoreBtn.textContent = "忽略";
    const applyBtn = document.createElement("button");
    applyBtn.type = "button";
    applyBtn.className = "aps-btn aps-btn-sm aps-primary";
    applyBtn.textContent = willOverwrite ? "应用并覆盖" : "应用提示词";
    foot.append(ignoreBtn, applyBtn);
    card.append(foot);
    overlay.append(card);

    const finish = (ok) => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(ok);
    };
    const onKey = (ev) => {
      if (ev.key === "Escape") finish(false);
    };

    ignoreBtn.addEventListener("click", () => finish(false));
    applyBtn.addEventListener("click", () => finish(true));
    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) finish(false);
    });
    document.addEventListener("keydown", onKey, true);
    document.body.append(overlay);
    applyBtn.focus();
  });
}