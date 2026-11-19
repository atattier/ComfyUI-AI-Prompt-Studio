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

import { StudioApi } from "./api.js?v=20261119_v49";
import {
  describeOp,
  describeStats,
  excerpt,
  formatBusyStatusText,
  formatFriendlyError,
  formatErrorTechnicalDetail,
  selectOps,
} from "./diff.js?v=20261119_v49";
import {
  ensureChatThreads,
  createChatThread,
  switchChatThread,
  renameChatThread,
  deleteChatThread,
  clearChatThread,
  updateThreadTurns,
  setThreadSessionId,
  maybeAutoTitleThread,
} from "./chat_threads.js?v=20261119_v49";
import {
  MAX_PRESET_IMAGE_BYTES,
  blobToDataUrl,
  fetchComfyImageRef,
  fileToDataUrl,
  makeThumbnailDataUrl,
} from "./images.js";
import { UndoStack } from "./undo.js";
import { removeRegion, shouldDeleteSelection } from "./hotkeys.js?v=20261119_v49";

const LABELS = ["object", "character", "text"];
const LABEL_NAMES = {
  object: "object (物体/背景)",
  character: "character (人物/主体)",
  text: "text (画面文字)",
};
export const BOX_COLORS = [
  "#c6613f", // 1 陶土（主色，第一个框默认用它）
  "#5b7fa6", // 2 雾蓝
  "#5f8a70", // 3 苔绿
  "#b07a4a", // 4 沙棕
  "#7c6f96", // 5 灰紫
  "#4f8583", // 6 灰青
  "#a5783f", // 7 暗金
  "#6b7a91", // 8 石板
];

const QUICK_ACTIONS = [
  {
    id: "expand",
    label: "扩写细节",
    title: "补充具象的画面光影、材质纹理、景深与构图描述",
    instruction:
      "Expand and enrich the prompt with concrete visual details (lighting, composition, textures, atmosphere) while preserving the core subject and style. Output in English.",
  },
  {
    id: "translate_en",
    label: "译为英文",
    title: "将中文描述或混合提示词准确翻译为自然、地道的英文提示词",
    instruction:
      "Translate all Chinese parts of the current prompt into natural, idiomatic English image-generation phrasing. Keep existing accurate English terms intact.",
  },
  {
    id: "moss_optimize",
    label: "MOSS 规则优化",
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
    label: "转逗号标签",
    title: "将散文描述提炼为逗号分隔的图像生成标签",
    instruction:
      "Convert the prompt into clean, comma-separated English image generation tags ordered from subject and appearance to environment, lighting, and camera.",
  },
  {
    id: "moss_cinematic",
    label: "电影胶片质感",
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
    const sumOut = {
      caption: String(draft.summary?.caption || state?.caption || ""),
      canvas: draft.summary?.canvas || "single",
    };
    if (Array.isArray(draft.summary?.meta) && draft.summary.meta.length) {
      sumOut.meta = [...draft.summary.meta];
    }
    if (Array.isArray(draft.summary?.palette) && draft.summary.palette.length) {
      sumOut.palette = [...draft.summary.palette];
    }
    return {
      width: draft.width || width,
      height: draft.height || height,
      bbox_coord_space: "abs",
      bbox_format: "xyxy",
      summary: sumOut,
      items: draft.items.map((it) => {
        const itemOut = {
          name: String(it.name || ""),
          parent: String(it.parent || ""),
          label: LABELS.includes(it.label) ? it.label : "object",
          caption: String(it.caption || ""),
          text: String(it.text || ""),
          bbox:
            Array.isArray(it.bbox) && it.bbox.length === 4
              ? it.bbox.map((v) => Number(v) || 0)
              : [0, 0, width, height],
        };
        if (Array.isArray(it.tags) && it.tags.length) itemOut.tags = [...it.tags];
        if (Array.isArray(it.palette) && it.palette.length) itemOut.palette = [...it.palette];
        return itemOut;
      }),
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

export function canvasSizeForImage(nw, nh, budget = 1024) {
  /** 底图尺寸换算成 16 倍数的画布尺寸（约 budget² 的像素预算）。 */
  const scale = Math.sqrt((budget * budget) / (nw * nh));
  return {
    width: Math.max(256, Math.round((nw * scale) / 16) * 16),
    height: Math.max(256, Math.round((nh * scale) / 16) * 16),
  };
}

export function rescaleLayoutDraft(draft, nextWidth, nextHeight, oldWidth, oldHeight) {
  /** 按新旧画布比例缩放所有画框：换尺寸、换底图都走这一份逻辑。 */
  if (!draft || typeof draft !== "object") return draft;
  const sx = nextWidth / (oldWidth || nextWidth);
  const sy = nextHeight / (oldHeight || nextHeight);
  const scaled = {
    ...draft,
    width: nextWidth,
    height: nextHeight,
    items: Array.isArray(draft.items)
      ? draft.items.map((item) => {
        const bbox = Array.isArray(item?.bbox) && item.bbox.length === 4
          ? item.bbox
          : [0, 0, oldWidth, oldHeight];
        return {
          ...item,
          bbox: [
            clamp(Math.round(bbox[0] * sx), 0, nextWidth - 2),
            clamp(Math.round(bbox[1] * sy), 0, nextHeight - 2),
            clamp(Math.round(bbox[2] * sx), 2, nextWidth),
            clamp(Math.round(bbox[3] * sy), 2, nextHeight),
          ],
        };
      })
      : [],
  };
  return normalizeDraft(scaled, nextWidth, nextHeight);
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

  const placedBadges = [];

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

    // Corner decorative tick lines (Game HUD style)
    const tickLen = Math.min(10, Math.round(Math.min(bw, bh) * 0.15));
    if (tickLen >= 4) {
      const ticks = [
        `M ${x1} ${y1 + tickLen} L ${x1} ${y1} L ${x1 + tickLen} ${y1}`,
        `M ${x2 - tickLen} ${y1} L ${x2} ${y1} L ${x2} ${y1 + tickLen}`,
        `M ${x1} ${y2 - tickLen} L ${x1} ${y2} L ${x1 + tickLen} ${y2}`,
        `M ${x2 - tickLen} ${y2} L ${x2} ${y2} L ${x2} ${y2 - tickLen}`,
      ];
      for (const tPath of ticks) {
        const tickEl = document.createElementNS(NS, "path");
        tickEl.setAttribute("d", tPath);
        tickEl.setAttribute("fill", "none");
        tickEl.setAttribute("stroke", color);
        tickEl.setAttribute("stroke-width", String(strokeW + 1));
        tickEl.style.pointerEvents = "none";
        group.append(tickEl);
      }
    }

    // Adaptive typography & pill badge with Collision Avoidance Staggering
    const fontSize = Math.max(13, Math.round(width / 52));
    const semanticName =
      item.name ||
      (item.label === "character"
        ? "人物主体"
        : item.label === "text"
          ? item.text
            ? `文字「${item.text.slice(0, 8)}」`
            : "画面文字"
          : "场景物体");
    const badgeText = `${index + 1} ${semanticName}`;

    let textUnits = 0;
    for (const ch of badgeText) {
      textUnits += ch.charCodeAt(0) > 255 ? 1.02 : 0.58;
    }
    const badgeW = Math.min(bw, Math.max(fontSize * 2.8, Math.round(textUnits * fontSize + fontSize * 0.9)));
    const badgeH = Math.round(fontSize * 1.48);

    // Anti-collision position solver: try candidates so multiple overlapping boxes don't stack badges at (x1, y1)
    const pad = 3;
    const candidates = [
      { x: x1, y: y1 },
      { x: x1, y: y1 + badgeH + pad },
      { x: Math.max(x1, x2 - badgeW), y: y1 },
      { x: x1 + badgeW + pad, y: y1 },
      { x: x1, y: Math.max(y1, y2 - badgeH) },
      { x: Math.max(x1, x2 - badgeW), y: Math.max(y1, y2 - badgeH) },
    ];

    let chosenPos = candidates[0];
    for (const cand of candidates) {
      const cx1 = cand.x;
      const cy1 = cand.y;
      const cx2 = cx1 + badgeW;
      const cy2 = cy1 + badgeH;

      // Must be within canvas bounds
      if (cx1 < 0 || cy1 < 0 || cx2 > width || cy2 > height) continue;

      // Check collision against placed badges
      const collides = placedBadges.some((p) => {
        return !(cx2 <= p.x1 || cx1 >= p.x2 || cy2 <= p.y1 || cy1 >= p.y2);
      });

      if (!collides) {
        chosenPos = cand;
        break;
      }
    }

    // If all candidates collide, stagger downward below the closest colliding badge
    const curX = chosenPos.x;
    let curY = chosenPos.y;
    placedBadges.push({
      x1: curX - 1,
      y1: curY - 1,
      x2: curX + badgeW + 1,
      y2: curY + badgeH + 1,
    });

    // Clean, modern, solid-color pill badge
    const badgeBg = svgRect(NS, curX, curY, badgeW, badgeH, {
      fill: color,
      stroke: isSel ? "#ffffff" : "rgba(15, 23, 42, 0.4)",
      "stroke-width": isSel ? 1.8 : 1,
      rx: 3.5,
      ry: 3.5,
    });
    badgeBg.style.pointerEvents = "none";
    group.append(badgeBg);

    const label = document.createElementNS(NS, "text");
    label.setAttribute("x", curX + Math.round(fontSize * 0.42));
    label.setAttribute("y", curY + Math.round(fontSize * 1.08));
    label.setAttribute("fill", "#ffffff");
    label.setAttribute("font-size", fontSize);
    label.setAttribute("font-weight", "600");
    label.setAttribute("font-family", '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif');
    label.textContent = badgeText;
    label.style.pointerEvents = "none";
    group.append(label);

    // Only render resize handle & HUD target reticle when selected to keep canvas ultra-clean
    if (isSel) {
      const boxW = Math.max(1, x2 - x1);
      const boxH = Math.max(1, y2 - y1);
      const arm = Math.max(10, Math.min(28, Math.round(Math.min(boxW, boxH) * 0.22)));
      const pad = 4;
      const strokeW = Math.max(3, Math.round(width / 220));
      const corners = [
        `M ${x1 - pad} ${y1 - pad + arm} L ${x1 - pad} ${y1 - pad} L ${x1 - pad + arm} ${y1 - pad}`,
        `M ${x2 + pad - arm} ${y1 - pad} L ${x2 + pad} ${y1 - pad} L ${x2 + pad} ${y1 - pad + arm}`,
        `M ${x1 - pad} ${y2 + pad - arm} L ${x1 - pad} ${y2 + pad} L ${x1 - pad + arm} ${y2 + pad}`,
        `M ${x2 + pad - arm} ${y2 + pad} L ${x2 + pad} ${y2 + pad} L ${x2 + pad} ${y2 + pad - arm}`,
      ];
      for (const d of corners) {
        const reticle = document.createElementNS(NS, "path");
        reticle.setAttribute("d", d);
        reticle.setAttribute("fill", "none");
        reticle.setAttribute("stroke", "#ffffff");
        reticle.setAttribute("stroke-width", String(strokeW));
        reticle.style.pointerEvents = "none";
        group.append(reticle);
      }

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
 * Compute adaptive workbench layout configuration based on image dimensions.
 * Portrait images (w/h <= 0.88) use side-by-side [Tall Stage | Editor] so tall images
 * fill the vertical space cleanly instead of shrinking into a tiny strip.
 * Landscape / square images use top-bottom [Wide Stage / Editor].
 */
export function computeAdaptiveLayoutMode(width, height) {
  const w = Math.max(16, Number(width) || 1024);
  const h = Math.max(16, Number(height) || 1024);
  const ratio = w / h;
  if (ratio <= 0.88) {
    return {
      orientation: "portrait",
      stageSplit: "side",
      colRatio: 0.62,
      stageRatio: 0.50,
      stageHeightPx: 540,
    };
  }
  if (ratio >= 1.15) {
    return {
      orientation: "landscape",
      stageSplit: "stack",
      colRatio: 0.58,
      stageRatio: 0.52,
      stageHeightPx: 420,
    };
  }
  return {
    orientation: "square",
    stageSplit: "stack",
    colRatio: 0.56,
    stageRatio: 0.48,
    stageHeightPx: 440,
  };
}

/**
 * Detect whether an edit instruction (or model reply) targets a bounding box for deletion.
 * Returns the index of the box in `items` to delete, or -1 if no box deletion is requested.
 */
export function detectBoxDeletion(instruction, items = [], targetIdx = -1, replyText = "") {
  if (!Array.isArray(items) || !items.length) return -1;
  const ins = String(instruction || "").trim();
  const reply = String(replyText || "").trim();
  const fullText = `${ins} ${reply}`;

  const isDeleteIntent =
    /(?:删(?:除|掉|了)?|移除|去掉|拿掉|不要|清空|\b(?:delete|remove|drop|erase)\b)/i.test(fullText);
  if (!isDeleteIntent) return -1;

  // 1. If a specific box was selected / referenced
  if (targetIdx >= 0 && targetIdx < items.length) {
    if (
      /(?:这个|该|此|当前)?\s*(?:框|画框|区域|box|region)|(?:删(?:除|掉|了)?|移除|去掉|不要)\s*$/i.test(ins) ||
      /^(?:删(?:除|掉|了)?|移除|去掉|不要|delete|remove)/i.test(ins) ||
      /(?:已删除|已移除|已去掉|删了).*(?:画框|区域|此框|该框)/i.test(reply)
    ) {
      return targetIdx;
    }
  }

  // 2. Check for explicit box index: #3, 第3个框, 3号框, 框3, box 3, #3
  const numMatch =
    ins.match(/(?:#|第)\s*(\d+)\s*(?:号)?(?:个)?\s*(?:框|画框|区域)?/i) ||
    ins.match(/(?:框|画框|区域)\s*(?:#|第)?\s*(\d+)/i) ||
    ins.match(/(?:删(?:除|掉|了)?|移除|去掉|不要)\s*(\d+)\s*(?:号)?(?:个)?\s*(?:框|画框|区域)/i) ||
    ins.match(/\b(?:box|region)\s*#?\s*(\d+)\b/i);
  if (numMatch) {
    const idx = parseInt(numMatch[1], 10) - 1;
    if (idx >= 0 && idx < items.length) return idx;
  }

  // 3. Check for matching box name or label keywords in instruction
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const name = String(item.name || "").trim();
    const label = String(item.label || "").trim();
    const labelCn = {
      character: "角色",
      object: "物体",
      text: "文字",
      background: "背景",
      effect: "特效",
      clothing: "服饰",
    }[label] || "";

    const candidates = [name, labelCn].filter(Boolean);
    for (const cand of candidates) {
      if (cand.length >= 2 && ins.includes(cand)) {
        return i;
      }
    }
  }

  // 4. Check if reply mentions removing a specific box
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const name = String(item.name || "").trim();
    if (name.length >= 2 && reply.includes(name) && /(?:已删除|已移除|已去掉|删除了)/.test(reply)) {
      return i;
    }
  }

  return -1;
}

/**
 * Convert a node chat turn object into one or two UI chat messages.
 */
export function turnToMessages(turn) {
  if (!turn || typeof turn !== "object") return [];
  const msgs = [];
  const uText = String(turn.label || turn.userText || "").trim();
  if (uText) {
    msgs.push({
      role: "user",
      text: turn.label && turn.userText && turn.label !== turn.userText ? `${turn.label}：${turn.userText}` : uText,
      regionBadge: turn.regionBadge || null,
      regionColor: turn.regionColor || null,
      turnId: turn.id || null,
    });
  }
  const aText = String(turn.reply || "").trim();
  if (aText || turn.pending) {
    msgs.push({
      role: "assistant",
      text: aText || (turn.pending ? "正在分析提示词与空间画框 ···" : ""),
      error: Boolean(turn.error),
      errorDetail: turn.errorDetail ? String(turn.errorDetail) : "",
      crest: turn.error
        ? "ALERT"
        : turn.changed
          ? turn.rolledBack
            ? "ROLLED BACK"
            : turn.regionBadge
              ? "REGION UPDATED"
              : "DIFF APPLIED"
          : "QUEST / CONFIRM",
      crestKind: turn.error ? "is-err" : turn.changed && !turn.rolledBack ? "is-ok" : "is-warn",
      regionBadge: turn.regionBadge || null,
      regionColor: turn.regionColor || null,
      note: turn.note || null,
      turnId: turn.id || null,
    });
  }
  return msgs;
}

export const MOSS_CANVAS_PRESETS = [
  [1024, 1024, "1:1 · 1024×1024"],
  [832, 1216, "2:3 竖图 · 832×1216"],
  [1216, 832, "3:2 横图 · 1216×832"],
  [896, 1152, "3:4 竖图 · 896×1152"],
  [1152, 896, "4:3 横图 · 1152×896"],
  [768, 1344, "9:16 竖图 · 768×1344"],
  [1344, 768, "16:9 横图 · 1344×768"],
];

const _CJK_CHAR_RE = /[\u3400-\u9fff\uf900-\ufaff]/;
export const DEPTH_TAIL_RE =
  /\s*(?:In front of |Behind |Located in the (?:foreground|middle ground|background)|在「|位于(?:前景|中景|背景))[^.。]*(?:\.|。)\s*$/i;

function _shortRefJs(it, zh) {
  const name = String(it?.name || "").trim();
  if (!name && it?.label === "text" && String(it?.text || "").trim()) {
    const t = String(it.text).trim().split(/\r?\n/)[0].slice(0, 24);
    return zh ? `文字「${t}」` : `the text "${t}"`;
  }
  let src = name || String(it?.caption || "").trim();
  src = src.split(/[，。,.;；:：!?！？\n]/)[0].trim() || src;
  if (zh || _CJK_CHAR_RE.test(src)) {
    return `「${src.slice(0, 16)}」`;
  }
  let words = src.split(/\s+/).filter(Boolean);
  if (words.length && ["a", "an", "the"].includes(words[0].toLowerCase())) {
    words = words.slice(1);
  }
  let ref = words.slice(0, 6).join(" ") || "object";
  if (!name) {
    if (ref.length > 1 && ref.slice(0, 2) !== ref.slice(0, 2).toUpperCase()) {
      ref = ref[0].toLowerCase() + ref.slice(1);
    }
    return `the ${ref}`;
  }
  return ref[0] === ref[0].toLowerCase() ? `the ${ref}` : ref;
}

function _boxAreaJs(b) {
  return Math.max(0, Number(b[2]) - Number(b[0])) * Math.max(0, Number(b[3]) - Number(b[1]));
}

function _boxInterJs(a, b) {
  const w = Math.min(Number(a[2]), Number(b[2])) - Math.max(Number(a[0]), Number(b[0]));
  const h = Math.min(Number(a[3]), Number(b[3])) - Math.max(Number(a[1]), Number(b[1]));
  return w > 0 && h > 0 ? w * h : 0;
}

function computeDepthPhrasesJs(items) {
  const n = items.length;
  return items.map((it, i) => {
    const capRaw = String(it?.caption || "");
    const zh = _CJK_CHAR_RE.test(capRaw);
    if (it?.label === "text") return "";
    const a = Array.isArray(it?.bbox) && it.bbox.length === 4 ? it.bbox : [0, 0, 0, 0];
    const fronts = [];
    const behinds = [];
    for (let j = 0; j < n; j++) {
      if (j === i || items[j]?.label === "text") continue;
      const b = Array.isArray(items[j]?.bbox) && items[j].bbox.length === 4 ? items[j].bbox : [0, 0, 0, 0];
      const inter = _boxInterJs(a, b);
      if (inter <= 0) continue;
      const small = Math.min(_boxAreaJs(a), _boxAreaJs(b)) || 1;
      if (inter / small < 0.05) continue;
      const ref = _shortRefJs(items[j], zh);
      if (j < i) {
        const coversAll = inter / (_boxAreaJs(b) || 1) >= 0.95;
        const txt = zh
          ? `在${ref}前方${coversAll ? "" : "，部分遮挡它"}`
          : `in front of ${ref}${coversAll ? "" : ", partially occluding it"}`;
        fronts.push([inter, txt]);
      } else {
        const inside = inter / (_boxAreaJs(a) || 1) >= 0.95;
        const txt = zh
          ? `在${ref}后方${inside ? "" : "，被它部分遮挡"}`
          : `behind ${ref}${inside ? "" : ", partly hidden by it"}`;
        behinds.push([inter, txt]);
      }
    }
    fronts.sort((x, y) => y[0] - x[0]);
    behinds.sort((x, y) => y[0] - x[0]);
    const parts = [...fronts.slice(0, 2).map((x) => x[1]), ...behinds.slice(0, 2).map((x) => x[1])];
    if (!parts.length) return "";
    const sep = zh ? "；" : "; ";
    const body = parts.join(sep);
    return zh ? `${body}。` : `${body[0].toUpperCase()}${body.slice(1)}.`;
  });
}

function appendDepthSentenceJs(base, extra) {
  let clean = String(base || "").replace(DEPTH_TAIL_RE, "").trim();
  if (!extra) return clean;
  if (!clean) return extra;
  const zh = _CJK_CHAR_RE.test(clean);
  if (zh) {
    if (!/[。！？.!?;；]$/.test(clean)) clean += "。";
    return clean + extra;
  }
  if (!/[.!?;]$/.test(clean)) clean += ".";
  return `${clean} ${extra}`;
}

/** Extract a plain JSON object from raw layout text (supports markdown code fences & surrounding prose). */
export function extractLayoutJsonObject(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) text = fence[1].trim();
  if (!text.startsWith("{")) {
    const start = text.indexOf("{");
    if (start >= 0) text = text.slice(start);
  }
  const end = text.lastIndexOf("}");
  if (end >= 0) text = text.slice(0, end + 1);
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Pick official MOSS-Image 16-multiple resolution closest to aspect ratio & ~1M pixel budget. */
export function matchMossCanvasSizeJs(width, height) {
  const w0 = Math.round(Number(width));
  const h0 = Math.round(Number(height));
  if (!Number.isFinite(w0) || !Number.isFinite(h0) || w0 <= 0 || h0 <= 0) return [1024, 1024];
  const MIN_SIDE = 256;
  const MAX_SIDE = 2048;
  const MULTIPLE = 16;
  const MAX_PIXELS = 2097152;
  const TARGET_PIXELS = 1048576;
  const ratio = w0 / h0;
  let best = null;
  for (let w = MIN_SIDE; w <= MAX_SIDE; w += MULTIPLE) {
    const maxH = Math.min(MAX_SIDE, Math.floor(MAX_PIXELS / w));
    for (let h = MIN_SIDE; h <= maxH; h += MULTIPLE) {
      const err = Math.abs(w / h - ratio) / ratio;
      const areaGap = Math.abs(w * h - TARGET_PIXELS);
      const negArea = -(w * h);
      if (
        !best ||
        err < best.err - 1e-12 ||
        (Math.abs(err - best.err) <= 1e-12 &&
          (areaGap < best.areaGap || (areaGap === best.areaGap && negArea < best.negArea)))
      ) {
        best = { err, areaGap, negArea, w, h };
      }
    }
  }
  return best ? [best.w, best.h] : [1024, 1024];
}

function _extractFourNumbersJs(v) {
  if (Array.isArray(v) && v.length === 4) {
    const nums = v.filter((x) => typeof x !== "boolean").map(Number);
    if (nums.length === 4 && nums.every(Number.isFinite)) return nums;
  }
  if (v && typeof v === "object") {
    for (const ks of [
      ["x1", "y1", "x2", "y2"],
      ["xmin", "ymin", "xmax", "ymax"],
      ["x_min", "y_min", "x_max", "y_max"],
      ["left", "top", "right", "bottom"],
    ]) {
      if (ks.every((k) => k in v && typeof v[k] !== "boolean")) {
        const nums = ks.map((k) => Number(v[k]));
        if (nums.every(Number.isFinite)) return nums;
      }
    }
  }
  return null;
}

function _itemRawBoxJs(it) {
  if (!it || typeof it !== "object") return null;
  for (const [key, order, scale] of [
    ["box_2d", "yx", "1000"],
    ["box_1000", "xy", "1000"],
    ["bbox_1000", "xy", "1000"],
    ["box_norm", "xy", null],
    ["box", "xy", null],
    ["bbox", "xy", null],
    ["bbox_2d", "xy", null],
  ]) {
    if (key in it) {
      const vals = _extractFourNumbersJs(it[key]);
      if (vals) return { vals, yx: order === "yx", scale, key };
    }
  }
  return null;
}

function _isCentralizedLayoutJs(data) {
  if (!data || typeof data !== "object") return false;
  const cs = String(data.bbox_coord_space || "").trim().toLowerCase();
  if (cs === "abs_centralized") return true;
  if (cs) return false;
  const itemsIn = Array.isArray(data.items) ? data.items : Array.isArray(data.objects) ? data.objects : null;
  if (!Array.isArray(itemsIn) || !itemsIn.length) return false;
  const valsAll = [];
  let hasNeg = false;
  for (const it of itemsIn) {
    const found = _itemRawBoxJs(it);
    if (!found) continue;
    if (found.scale === "1000" || ["box_2d", "box_1000", "bbox_1000", "box_norm"].includes(found.key)) continue;
    for (const v of found.vals) {
      valsAll.push(v);
      if (v < -1) hasNeg = true;
    }
  }
  if (!hasNeg || !valsAll.length) return false;
  return Math.max(...valsAll.map((v) => Math.abs(v))) <= 1024;
}

/** Infer valid MOSS 16-multiple canvas dimensions [w, h] from explicit sizes or abs_centralized boxes. */
export function inferCanvasSizeFromLayout(data, fallbackWidth = 1024, fallbackHeight = 1024) {
  const [fw, fh] =
    fallbackWidth > 0 && fallbackHeight > 0 ? matchMossCanvasSizeJs(fallbackWidth, fallbackHeight) : [1024, 1024];
  if (!data || typeof data !== "object") return [fw, fh];

  if (
    typeof data.width === "number" &&
    Number.isFinite(data.width) &&
    data.width > 0 &&
    typeof data.height === "number" &&
    Number.isFinite(data.height) &&
    data.height > 0
  ) {
    return matchMossCanvasSizeJs(Math.round(data.width), Math.round(data.height));
  }

  if (_isCentralizedLayoutJs(data)) {
    const cs = String(data.bbox_coord_space || "").trim().toLowerCase();
    const fmt = String(data.bbox_format || "").trim().toLowerCase();
    const isYxyx = fmt === "yxyx" || (cs === "abs_centralized" && fmt !== "xyxy");
    const itemsIn = Array.isArray(data.items) ? data.items : Array.isArray(data.objects) ? data.objects : [];
    let extX = 0;
    let extY = 0;
    const boxes = [];
    for (const it of itemsIn) {
      const found = _itemRawBoxJs(it);
      if (!found) continue;
      if (found.scale === "1000" || ["box_2d", "box_1000", "bbox_1000", "box_norm"].includes(found.key)) continue;
      const [x1, y1, x2, y2] = isYxyx ? [found.vals[1], found.vals[0], found.vals[3], found.vals[2]] : found.vals;
      extX = Math.max(extX, Math.abs(x1), Math.abs(x2));
      extY = Math.max(extY, Math.abs(y1), Math.abs(y2));
      boxes.push([x1, y1, x2, y2]);
    }
    if (boxes.length) {
      let bestSym = null;
      for (const [x1, y1, x2, y2] of boxes) {
        const rx1 = Math.round(x1);
        const ry1 = Math.round(y1);
        const rx2 = Math.round(x2);
        const ry2 = Math.round(y2);
        if (rx1 !== 0 && ry1 !== 0 && Math.abs(rx1) === Math.abs(rx2) && Math.abs(ry1) === Math.abs(ry2)) {
          const cw = Math.abs(rx1) * 2;
          const ch = Math.abs(ry1) * 2;
          if (
            cw >= 256 &&
            cw <= 2048 &&
            ch >= 256 &&
            ch <= 2048 &&
            cw % 16 === 0 &&
            ch % 16 === 0 &&
            cw * ch <= 2097152 &&
            cw * ch >= 700000 &&
            cw >= extX * 2 - 1e-6 &&
            ch >= extY * 2 - 1e-6
          ) {
            const area = cw * ch;
            if (!bestSym || area > bestSym[0]) bestSym = [area, cw, ch];
          }
        }
      }
      if (bestSym) return [bestSym[1], bestSym[2]];
      if (extX > fw / 2 + 1e-6 || extY > fh / 2 + 1e-6) {
        const estW = Math.max(256, Math.round(extX * 2));
        const estH = Math.max(256, Math.round(extY * 2));
        return matchMossCanvasSizeJs(estW, estH);
      }
    }
  }
  return [fw, fh];
}

export function inferRegionNameJs(item, label, index) {
  const rawName = String(item?.name || item?.title || item?.label_zh || "").trim();
  if (rawName) return rawName.slice(0, 24);
  const cap = String(item?.caption || item?.description || "").toLowerCase();
  const text = String(item?.text || "").trim();
  const parent = String(item?.parent || "").toLowerCase();

  if (label === "text" || text) {
    if (text) {
      if (parent.includes("poster") || parent.includes("海报") || cap.includes("title")) {
        return `海报标题「${text.slice(0, 8)}」`;
      }
      if (parent.includes("flyer") || parent.includes("传单") || parent.includes("brochure")) {
        return `宣传单文字「${text.slice(0, 8)}」`;
      }
      return `文字「${text.slice(0, 10)}」`;
    }
    if (parent.includes("poster") || parent.includes("海报")) return "海报标题";
    if (parent.includes("flyer") || parent.includes("传单")) return "宣传单文字";
    return "画面文字";
  }

  if (/(halo|glowing ring|光环)/.test(cap)) return "光环";
  if (/(shard|light wing|energy wing|碎片翼|光之碎片翼)/.test(cap)) return "光之碎片翼";
  if (/(wing|wings|翅膀|羽翼)/.test(cap)) return "羽翼";
  if (/(horn|horns|角)/.test(cap)) return "角/饰角";
  if (/(poster|海报)/.test(cap)) return /(door poster|门上海报|门上宣传海报)/.test(cap) ? "门上宣传海报" : "宣传海报";
  if (/(flyer|leaflet|brochure|传单)/.test(cap)) {
    if (/(table|desk|counter|桌)/.test(cap)) return "桌上宣传单";
    if (/(bottom|left|corner|左下)/.test(cap)) return "左下宣传单";
    return "宣传单";
  }
  if (/(door|glass door|玻璃门|门)/.test(cap)) return "玻璃门";
  if (/(window|windows|落地窗|窗)/.test(cap)) return "观景窗";
  if (/(arch|column|stone|building|architecture|建筑|石拱)/.test(cap)) return "背景建筑";
  if (/(cafe|coffee|restaurant|interior|room|background|内景|背景)/.test(cap)) {
    return /(cafe|coffee|咖啡)/.test(cap) ? "咖啡厅内景" : "场景内景";
  }
  if (/(coat|overcoat|jacket|大衣|外套)/.test(cap)) return "大衣外套";
  if (/(hoodie|sweater|shirt|连帽衫|卫衣|内搭)/.test(cap)) return "连帽内搭";
  if (/(skirt|pleated|百褶裙|半身裙)/.test(cap)) return "百褶裙";
  if (/(book|paperback|书)/.test(cap)) return "手中书本";
  if (/(bag|backpack|duffle|crossbody|斜挎包|背包)/.test(cap)) return "斜挎包";
  if (/(scarf|plaid|围巾)/.test(cap)) return "格子围巾";
  if (/(girl|woman|nurse|anime girl|少女|女性|女子)/.test(cap)) {
    return /(red hair|red-hair|crimson hair|红发)/.test(cap) ? "红发少女" : "年轻女子";
  }
  if (label === "character") return `人物主体 #${index + 1}`;
  return `物体 #${index + 1}`;
}

/** Extract clean narrative prose while preserving genuine double-quoted text like reading "OPEN". */
export function cleanCaptionPreserveQuotesJs(raw) {
  if (!raw || typeof raw !== "string") return "";
  let t = raw.trim();
  if (!t) return "";
  try {
    const data = JSON.parse(t);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const cap =
        (typeof data.summary?.caption === "string" && data.summary.caption) ||
        (typeof data.summary === "string" && data.summary) ||
        (typeof data.caption === "string" && data.caption);
      if (cap && cap.trim()) return cap.trim();
    }
  } catch {
    /* non-JSON */
  }
  t = t.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "").trim();
  let hadWrapper = false;
  const itemsMatch = t.match(/^(.*?)(?:"?\s*,\s*"(?:items|layout|regions|objects)"\s*:\s*\[)/is);
  if (itemsMatch && itemsMatch[1]) {
    t = itemsMatch[1].trim();
    hadWrapper = true;
  }
  const origForHead = t;
  t = t.replace(/^\s*\{\s*"(?:summary|caption|prompt|result)"\s*:\s*\{\s*"(?:caption|text|prompt)"\s*:\s*["']?/i, "");
  t = t.replace(/^\s*\{\s*"(?:summary|caption|prompt|result|description)"\s*:\s*["']?/i, "");
  if (t !== origForHead) hadWrapper = true;
  if (/"\s*,\s*"canvas"/is.test(t)) {
    t = t.replace(/"\s*,\s*"canvas".*$/is, "");
    hadWrapper = true;
  }
  if (/^\s*$/.test(t)) return "";
  if (hadWrapper) {
    t = t.replace(/["']\s*\}*\s*$/, "");
    t = t.replace(/\s*\}\s*$/, "");
  } else if (t.endsWith("}") && (t.match(/\{/g) || []).length < (t.match(/\}/g) || []).length) {
    t = t.replace(/\s*\}\s*$/, "");
  }
  return t.trim();
}

/** Compile internal abs+xyxy draft into official MOSS-Image abs_centralized+yxyx JSON object. */
export function compileLayoutDraftForMoss(draft, fallbackWidth = 1024, fallbackHeight = 1024) {
  if (!draft || typeof draft !== "object") {
    return {
      summary: { caption: "A composed image.", canvas: "single" },
      items: [],
      bbox_coord_space: "abs_centralized",
      bbox_format: "yxyx",
    };
  }
  const w = Math.max(16, Math.floor((Number(draft.width || fallbackWidth || 1024) || 1024) / 16) * 16);
  const h = Math.max(16, Math.floor((Number(draft.height || fallbackHeight || 1024) || 1024) / 16) * 16);
  const halfW = Math.floor(w / 2);
  const halfH = Math.floor(h / 2);

  const rawSum = draft.summary && typeof draft.summary === "object" ? draft.summary : {};
  const summary = {
    caption: String(rawSum.caption || draft.caption || "A composed image.").trim() || "A composed image.",
    canvas: ["single", "multi_panel", "collage"].includes(rawSum.canvas) ? rawSum.canvas : "single",
  };
  if (Array.isArray(rawSum.meta) && rawSum.meta.length) summary.meta = rawSum.meta.filter(Boolean);
  if (Array.isArray(rawSum.palette) && rawSum.palette.length) summary.palette = rawSum.palette.filter(Boolean);

  const rawItems = Array.isArray(draft.items) ? draft.items.filter((it) => it && typeof it === "object" && !it.hidden) : [];
  const isAlreadyCentralized =
    draft.bbox_coord_space === "abs_centralized" && draft.bbox_format === "yxyx";
  const phrases = isAlreadyCentralized ? rawItems.map(() => "") : computeDepthPhrasesJs(rawItems);

  const items = rawItems.map((it, idx) => {
    const lbl = ["object", "character", "text"].includes(it.label) ? it.label : "object";
    let cap = String(it.caption || "").trim() || `Region ${idx + 1}`;
    if (phrases[idx]) cap = appendDepthSentenceJs(cap, phrases[idx]);

    let cBox;
    const b = Array.isArray(it.bbox) && it.bbox.length === 4 ? it.bbox.map((v) => Number(v) || 0) : [0, 0, w, h];
    if (isAlreadyCentralized) {
      cBox = b.map((v) => Math.round(v));
    } else {
      const [x1, y1, x2, y2] = b;
      cBox = [
        Math.floor(y1) - halfH,
        Math.floor(x1) - halfW,
        Math.ceil(y2) - halfH,
        Math.ceil(x2) - halfW,
      ];
    }
    const outIt = { label: lbl, caption: cap };
    if (lbl === "text") {
      outIt.text = String(it.text || cap).trim();
    } else if (typeof it.text === "string" && it.text.trim()) {
      outIt.text = it.text.trim();
    }
    if (Array.isArray(it.tags) && it.tags.length) outIt.tags = it.tags.filter(Boolean);
    if (Array.isArray(it.palette) && it.palette.length) outIt.palette = it.palette.filter(Boolean);
    outIt.bbox = cBox;
    return outIt;
  });

  return {
    summary,
    items,
    bbox_coord_space: "abs_centralized",
    bbox_format: "yxyx",
  };
}

export function buildLayoutPrompt(draft, fallbackWidth = 1024, fallbackHeight = 1024) {
  return JSON.stringify(compileLayoutDraftForMoss(draft, fallbackWidth, fallbackHeight));
}

/** Convert any layout JSON (abs_centralized yxyx, box_2d, box_1000, norm, abs xyxy) into internal abs+xyxy canvas draft. */
export function decompileMossLayoutToDraft(parsed, width = 1024, height = 1024, prevDraft = null, options = {}) {
  const fbW = Number(width || prevDraft?.width || 1024) || 1024;
  const fbH = Number(height || prevDraft?.height || 1024) || 1024;
  let w = fbW;
  let h = fbH;
  if (!options?.forceSize) {
    const [infW, infH] = inferCanvasSizeFromLayout(parsed, fbW, fbH);
    w = infW;
    h = infH;
  } else {
    const [mw, mh] = matchMossCanvasSizeJs(fbW, fbH);
    w = mw;
    h = mh;
  }
  const halfW = Math.floor(w / 2);
  const halfH = Math.floor(h / 2);
  const centralized = _isCentralizedLayoutJs(parsed);
  const coordSpace = String(parsed?.bbox_coord_space || "").trim().toLowerCase();
  const bboxFormat = String(parsed?.bbox_format || "").trim().toLowerCase();

  const rawItems = Array.isArray(parsed?.items) ? parsed.items : Array.isArray(parsed?.objects) ? parsed.objects : [];
  const rawSum = parsed?.summary && typeof parsed.summary === "object" ? parsed.summary : {};
  let sumCap = String(rawSum.caption || parsed?.caption || "").trim();
  if (!sumCap) {
    const snips = rawItems
      .map((it) => String(it?.caption || it?.description || it?.text || "").trim())
      .filter(Boolean)
      .slice(0, 3);
    sumCap = snips.join("; ") || "A composed image.";
  }
  const summary = {
    caption: sumCap,
    canvas: ["single", "multi_panel", "collage"].includes(rawSum.canvas) ? rawSum.canvas : "single",
  };
  if (Array.isArray(rawSum.meta) && rawSum.meta.length) summary.meta = rawSum.meta.filter(Boolean);
  if (Array.isArray(rawSum.palette) && rawSum.palette.length) summary.palette = rawSum.palette.filter(Boolean);

  const prevItems = Array.isArray(prevDraft?.items) ? prevDraft.items : [];
  const items = rawItems
    .filter((it) => it && typeof it === "object")
    .map((it, idx) => {
      const rawLbl = String(it.label || "").trim().toLowerCase();
      let label = "object";
      if (LABELS.includes(rawLbl)) label = rawLbl;
      else if (["person", "human", "figure", "feature", "accessory"].includes(rawLbl)) label = "character";
      else if (["sign", "title", "typography", "caption_text"].includes(rawLbl)) label = "text";

      const found = _itemRawBoxJs(it);
      let nx1 = 0.1;
      let ny1 = 0.1;
      let nx2 = 0.9;
      let ny2 = 0.9;
      if (found) {
        const { vals, yx, scale, key } = found;
        if (centralized && ["box", "bbox", "bbox_2d"].includes(key)) {
          const isYxyx = bboxFormat === "yxyx" || (coordSpace === "abs_centralized" && bboxFormat !== "xyxy");
          const [bx1, by1, bx2, by2] = isYxyx ? [vals[1], vals[0], vals[3], vals[2]] : vals;
          nx1 = (bx1 + halfW) / w;
          nx2 = (bx2 + halfW) / w;
          ny1 = (by1 + halfH) / h;
          ny2 = (by2 + halfH) / h;
        } else {
          const ordered = yx ? [vals[1], vals[0], vals[3], vals[2]] : vals;
          const mx = Math.max(...ordered.map((v) => Math.abs(v)));
          let sx = 1;
          let sy = 1;
          if (coordSpace === "abs" && ["box", "bbox", "bbox_2d"].includes(key)) {
            sx = w;
            sy = h;
          } else if (mx <= 1 + 1e-6 && scale !== "1000") {
            sx = 1;
            sy = 1;
          } else if ((scale === "1000" || mx <= 1000 + 1e-6) && mx <= 1000 + 1e-6) {
            sx = 1000;
            sy = 1000;
          } else {
            sx = w;
            sy = h;
          }
          nx1 = ordered[0] / sx;
          ny1 = ordered[1] / sy;
          nx2 = ordered[2] / sx;
          ny2 = ordered[3] / sy;
        }
        if (nx2 < nx1) [nx1, nx2] = [nx2, nx1];
        if (ny2 < ny1) [ny1, ny2] = [ny2, ny1];
      }

      const px1 = clamp(Math.round(nx1 * w), 0, w - 2);
      const py1 = clamp(Math.round(ny1 * h), 0, h - 2);
      const px2 = clamp(Math.round(nx2 * w), px1 + 1, w);
      const py2 = clamp(Math.round(ny2 * h), py1 + 1, h);

      const rawCap = String(it.caption || it.description || "");
      const cleanCap = (centralized ? rawCap.replace(DEPTH_TAIL_RE, "").trim() : rawCap.trim()) || rawCap.trim() || `Region ${idx + 1}`;

      // Only inherit prevDraft[idx].name when captions match (editing same layout), never for unrelated pasted layouts!
      const prevIt = prevItems[idx];
      let resolvedName = "";
      if (String(it.name || it.title || it.label_zh || "").trim()) {
        resolvedName = String(it.name || it.title || it.label_zh).trim().slice(0, 24);
      } else if (prevIt?.name) {
        const pCap = String(prevIt.caption || "").trim().toLowerCase().slice(0, 16);
        const cCap = cleanCap.toLowerCase();
        if (pCap && (cCap.startsWith(pCap) || pCap.startsWith(cCap.slice(0, 16)))) {
          resolvedName = String(prevIt.name);
        }
      }
      if (!resolvedName) {
        resolvedName = inferRegionNameJs({ ...it, caption: cleanCap }, label, idx);
      }

      const outIt = {
        name: resolvedName,
        parent: String(it.parent || ""),
        label,
        caption: cleanCap,
        bbox: [px1, py1, px2, py2],
      };
      if (label === "text" || (typeof it.text === "string" && it.text.trim())) {
        outIt.text = String(it.text || cleanCap).trim();
      }
      if (Array.isArray(it.tags) && it.tags.length) outIt.tags = it.tags.filter(Boolean);
      if (Array.isArray(it.palette) && it.palette.length) outIt.palette = it.palette.filter(Boolean);
      return outIt;
    });

  return {
    width: w,
    height: h,
    bbox_coord_space: "abs",
    bbox_format: "xyxy",
    summary,
    items,
  };
}

/** Auto-detect finished prompt format: 'layout' | 'danbooru' | 'caption'. */
export function detectFinishedPromptType(raw, explicitType = "auto") {
  const exp = String(explicitType || "auto").trim().toLowerCase();
  if (["caption", "layout", "danbooru"].includes(exp)) return exp;

  const trimmed = String(raw || "").trim();
  if (!trimmed) return "caption";

  const parsed = extractLayoutJsonObject(trimmed);
  if (parsed) {
    const items = Array.isArray(parsed.items) ? parsed.items : Array.isArray(parsed.objects) ? parsed.objects : null;
    if (Array.isArray(items) && (items.length > 0 || Boolean(parsed.bbox_coord_space) || Boolean(parsed.bbox_format))) {
      return "layout";
    }
  }

  let unwrapped = trimmed;
  const fence = unwrapped.match(/^```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)\s*```$/i);
  if (fence) unwrapped = fence[1].trim();

  if (/<\|[^|\n]+\|>/.test(unwrapped)) return "caption";
  if (_CJK_CHAR_RE.test(unwrapped)) return "caption";

  const flat = unwrapped.replace(/\r/g, "").replace(/\n/g, ",");
  const parts = flat.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const underscoreParts = parts.filter((p) => p.includes("_")).length;
    const weightSyntax = /\([^)]+:\d+(?:\.\d+)?\)/.test(unwrapped);
    const startsDanbooru = /^(?:masterpiece|best[_ ]quality|high[_ ]quality|1girl|1boy|2girls|2boys|multiple_girls|solo|scenery|no_humans)\b/i.test(
      unwrapped,
    );
    const hasSentencePeriod = /[a-zA-Z]{2,}[.!?](?:\s|$)/.test(unwrapped);
    const wordCounts = parts.map((p) => p.split(/\s+/).filter(Boolean).length);
    const avgWords = wordCounts.reduce((a, b) => a + b, 0) / parts.length;
    const maxWords = Math.max(...wordCounts);
    if (parts.length === 2) {
      if (underscoreParts >= 1 && avgWords <= 3.0 && !hasSentencePeriod) return "danbooru";
    } else {
      const strong = underscoreParts >= Math.max(2, Math.floor(parts.length / 3)) || weightSyntax || startsDanbooru;
      if (avgWords <= 4.0 && maxWords <= 7 && (strong || (!hasSentencePeriod && parts.length >= 4))) {
        return "danbooru";
      }
    }
  }
  return "caption";
}

export function inspectFinishedPrompt(raw, explicitType = "auto", fallbackW = 1024, fallbackH = 1024) {
  const trimmed = String(raw || "").trim();
  const detectedType = detectFinishedPromptType(trimmed, "auto");
  const sourceType = detectFinishedPromptType(trimmed, explicitType);
  const parsed = extractLayoutJsonObject(trimmed);
  const items = parsed ? (Array.isArray(parsed.items) ? parsed.items : Array.isArray(parsed.objects) ? parsed.objects : []) : [];
  const inferredSize = parsed ? inferCanvasSizeFromLayout(parsed, fallbackW, fallbackH) : [fallbackW, fallbackH];
  const wordCount = trimmed ? trimmed.split(/\s+/).filter(Boolean).length : 0;
  const tagCount = trimmed
    ? trimmed
        .replace(/\r/g, "")
        .replace(/\n/g, ",")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean).length
    : 0;
  return {
    empty: !trimmed,
    sourceType,
    detectedType,
    hasJsonObject: Boolean(parsed),
    itemCount: items.length,
    inferredSize,
    wordCount,
    tagCount,
  };
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
  imageCandidate = null,
  showBoxes = true,
  onSessionChange = null,
  onChatLogChange = null,
  onChatStateChange = null,
  onImageChange = null,
  onApply,
  onCancel,
}) {
  const api = suppliedApi || new StudioApi();
  let width = Math.max(16, Number(state.width) || 1024);
  let height = Math.max(16, Number(state.height) || 1024);
  const canonicalMode = (m) => (m === "hybrid" ? "danbooru" : m);
  let currentMode = ["caption", "layout", "danbooru"].includes(canonicalMode(mode))
    ? canonicalMode(mode)
    : "layout";
  let selectedModes = Array.isArray(state.modes) && state.modes.length
    ? ["caption", "layout", "danbooru"].filter((m) => state.modes.map(canonicalMode).includes(m))
    : [currentMode];
  if (!selectedModes.length) selectedModes = [currentMode];
  if (!selectedModes.includes(currentMode)) {
    selectedModes = ["caption", "layout", "danbooru"].filter(
      (m) => selectedModes.includes(m) || m === currentMode,
    );
  }
  let currentImageUrl = imageUrl || state.imageDataUrl || null;
  let dimImage = false;
  let drawMode = false;
  let showBoxesOverlay = showBoxes !== false;
  let layoutArrangePolicy = "auto"; // "auto" | "side" | "stack"
  let customColRatio = null;
  let customStageRatio = null;
  let customStageHeightPx = null;

  const { activeThread: initThread, activeId: initThreadId } = ensureChatThreads(state, { maxTurns: 25 });
  if (initialSessionId && initThread && !initThread.session_id) {
    setThreadSessionId(state, initThread.id, initialSessionId, { maxTurns: 25 });
  }
  let activeThreadId = state.active_chat_id || initThreadId;
  let sessionId = (state.chat_threads?.find((t) => t.id === activeThreadId)?.session_id) || initialSessionId || null;

  // Working copy of draft, caption & danbooru tags: 取消 discards it; 应用 commits it.
  const draft = cloneDraft(state, width, height);
  let captionText = String(state.caption_text || state.caption || draft.summary?.caption || "");
  let danbooruText = String(state.danbooru_prompt || state.danbooru_text || state.tags || "");
  if (draft.summary && !draft.summary.caption && captionText) {
    draft.summary.caption = captionText;
  }

  const undoStack = new UndoStack({ limit: 50 });
  // Target for AI edits: "summary" | "danbooru" | "region:0", etc.
  let activeEditTarget = currentMode === "danbooru" ? "danbooru" : "summary";

  // Interconnected multi-thread chat: preserve each thread's bubbles, session_id & pending Diff proposal!
  const threadMessagesMap = new Map();
  const threadProposalsMap = new Map();
  for (const t of state.chat_threads || []) {
    threadMessagesMap.set(
      t.id,
      Array.isArray(t.chat_log) && t.chat_log.length > 0 ? t.chat_log.flatMap(turnToMessages) : [],
    );
    threadProposalsMap.set(t.id, null);
  }
  let activeProposal = threadProposalsMap.get(activeThreadId) || null;
  let chatMessages = threadMessagesMap.get(activeThreadId) || [];
  let editingWbThreadId = null;

  function getActiveWbThread() {
    ensureChatThreads(state, { maxTurns: 25 });
    return (
      state.chat_threads.find((t) => t.id === activeThreadId) ||
      state.chat_threads.find((t) => t.id === state.active_chat_id) ||
      state.chat_threads[0] ||
      null
    );
  }

  function emitWbChatSync() {
    ensureChatThreads(state, { maxTurns: 25 });
    onChatStateChange?.({
      chat_threads: state.chat_threads,
      active_chat_id: state.active_chat_id,
      chat_seq: state.chat_seq,
      chat_log: state.chat_log,
      session_id: state.session_id || null,
    });
  }

  function recordWorkbenchTurn({
    threadId = null,
    userText,
    label = null,
    reply,
    changed = false,
    error = false,
    errorDetail = "",
    blocks = [],
    regionIdx = -1,
    regionBadge = null,
    regionColor = null,
    note = null,
  }) {
    const tid = threadId || activeThreadId;
    ensureChatThreads(state, { maxTurns: 25 });
    const targetThread = state.chat_threads.find((t) => t.id === tid) || getActiveWbThread();
    const resolvedTid = targetThread?.id || tid;
    const baseLog = Array.isArray(targetThread?.chat_log) ? [...targetThread.chat_log] : [];
    const turn = {
      id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      mode: currentMode,
      regionIdx,
      regionBadge,
      regionColor,
      userText,
      label: label || userText,
      reply,
      changed: Boolean(changed),
      blocks: Array.isArray(blocks) ? blocks : [],
      rolledBack: false,
      pending: false,
      error: Boolean(error),
      errorDetail: errorDetail ? String(errorDetail) : "",
      note,
    };
    baseLog.push(turn);
    updateThreadTurns(state, resolvedTid, baseLog, {
      sessionId: targetThread?.session_id ?? undefined,
      maxTurns: 25,
    });
    if (typeof renderWbThreadTabs === "function") renderWbThreadTabs();
    onChatLogChange?.(state.chat_log);
    emitWbChatSync();
    return turn;
  }
  let chatIntent = "edit"; // "edit" (auto-diff) | "chat" (Q&A)
  let reverseFormat = "node_mode"; // "node_mode" | "prose" | "tags" | "moss"
  let busy = false;
  let busyStartMs = 0;
  let busyActionLabel = "";
  let busyActionTooltip = "";
  let busyTimer = null;
  let streamController = null;
  let editController = null;
  const activeController = () => streamController || editController;

  const overlay = el("div", "aps-modal-overlay");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  const modal = el("div", "aps-modal aps-workbench-modal");

  // =================================================================== HEADER
  const head = el("div", "aps-modal-head aps-wb-head");
  const titleWrap = el("div", "aps-wb-brand");
  const initialTitle = currentMode === "caption"
    ? "编辑散文描述"
    : currentMode === "danbooru"
      ? "编辑 Danbooru 标签"
      : "编辑布局";
  titleWrap.append(
    el("span", "aps-logo", ""),
    el("div", "aps-modal-title", initialTitle),
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
    ["caption", "散文"],
    ["layout", "📐 布局"],
    ["danbooru", "Danbooru"],
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
        selectedModes = ["caption", "layout", "danbooru"].filter(
          (m) => selectedModes.includes(m) || m === mKey,
        );
      }
      syncModeButtonsUI();
    });
    const lbl = el("span", "aps-mode-label", mLabel);
    btn.append(chk, lbl);
    btn.addEventListener("click", () => {
      if (!selectedModes.includes(mKey)) {
        selectedModes = ["caption", "layout", "danbooru"].filter(
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
      Object.assign(draft, rescaleLayoutDraft(draft, nw, nh, width, height));
      width = nw;
      height = nh;
      sizeNote.textContent = `${width} × ${height}（16 倍数）`;
      updateCanvasAspect();
      renderBoxes();
      renderList();
    }
  });

  const undoBtn = el("button", "aps-btn aps-btn-sm", "撤销");
  undoBtn.type = "button";
  undoBtn.disabled = true;
  const redoBtn = el("button", "aps-btn aps-btn-sm", "重做");
  redoBtn.type = "button";
  redoBtn.disabled = true;

  const settingsBtn = el("button", "aps-btn aps-btn-sm", "设置");
  settingsBtn.type = "button";
  settingsBtn.title = "配置模型网关（Base URL / API Key / 模型选择）与提示词反推规则";
  settingsBtn.addEventListener("click", () => {
    openSettingsModal({
      api,
      onSaved: (cfg) => {
        setStatus(`已更新设置：模型 ${cfg?.model || ""} · 三模式独立规则已生效`);
      },
    });
  });

  let applyPresetToWorkbench = null;

  const savePresetBtn = el("button", "aps-btn aps-btn-sm", "💾 存为预设");
  savePresetBtn.type = "button";
  savePresetBtn.title = "快捷保存当前构图画框、提示词及尺寸至本地预设库";
  savePresetBtn.addEventListener("click", () => {
    openSavePresetModal({
      api,
      state: {
        ...state,
        width,
        height,
        mode: currentMode,
        modes: selectedModes,
        draft: JSON.parse(JSON.stringify(draft)),
        caption_text: captionText,
        danbooru_prompt: danbooruText,
        layout_prompt: buildLayoutPrompt(draft, width, height),
      },
      prompts: {
        caption: captionText,
        layout: buildLayoutPrompt(draft, width, height),
        danbooru: danbooruText,
      },
      imageCandidate,
      onSaved: (saved) => {
        setStatus(`✓ 构图与提示词已保存至预设库：「${saved.name}」`);
      },
    });
  });

  const presetLibBtn = el("button", "aps-btn aps-btn-sm", "预设库");
  presetLibBtn.type = "button";
  presetLibBtn.title = "浏览所有构图与提示词预设（支持一键应用到当前工作台、导入/导出）";
  presetLibBtn.addEventListener("click", () => {
    openPresetLibraryModal({
      api,
      onApply: (preset) => {
        applyPresetToWorkbench?.(preset);
      },
    });
  });

  const headRight = el("div", "aps-wb-head-right");

  // Header overflow menu: the secondary tools (undo / redo / presets / settings)
  // live behind「⋯」so the bar reads as three controls instead of eight.
  const moreBtn = el("button", "aps-btn aps-btn-sm aps-more-btn", "⋯");
  moreBtn.type = "button";
  moreBtn.title = "更多：撤销/重做、存为预设、预设库、设置";
  const moreMenu = el("div", "aps-menu is-right");
  moreMenu.hidden = true;
  for (const b of [undoBtn, redoBtn, savePresetBtn, presetLibBtn, settingsBtn]) {
    b.classList.add("aps-menu-item");
    moreMenu.append(b);
  }
  const moreWrap = el("span", "aps-menu-wrap");
  moreWrap.append(moreBtn, moreMenu);
  moreBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    moreMenu.hidden = !moreMenu.hidden;
  });
  moreMenu.addEventListener("click", (ev) => {
    if (ev.target.closest("button")) moreMenu.hidden = true;
  });
  modal.addEventListener("pointerdown", (ev) => {
    if (!moreWrap.contains(ev.target)) moreMenu.hidden = true;
  });

  headRight.append(modeSwitch, sizeSelect, sizeNote, moreWrap);
  head.append(titleWrap, headRight);
  modal.append(head);

  // ===================================================================== BODY
  const body = el("div", "aps-modal-body aps-wb-columns");

  // -------------------------------------------------------------- LEFT COLUMN
  const leftCol = el("div", "aps-wb-left");
  const stagePane = el("div", "aps-wb-stage-pane");
  const editorPane = el("div", "aps-wb-editor-pane");

  // 1) Visual Stage Card (Reference Image + Interactive SVG BBoxes)
  const stageToolbar = el("div", "aps-wb-stage-toolbar");
  const imgBadge = el(
    "span",
    "aps-wb-stage-badge",
    currentImageUrl ? `底图 ${width}×${height}` : "可上传参考图或直接编辑",
  );
  const uploadInput = el("input", "");
  uploadInput.type = "file";
  uploadInput.accept = "image/*";
  uploadInput.hidden = true;
  const uploadBtn = el("button", "aps-btn aps-btn-sm", "上传/换图");
  uploadBtn.type = "button";
  uploadBtn.addEventListener("click", () => uploadInput.click());
  uploadInput.addEventListener("change", async () => {
    const file = uploadInput.files?.[0];
    uploadInput.value = "";
    if (!file) return;
    try {
      const dataUrl = await fileToDataUrl(file);
      currentImageUrl = dataUrl;
      imgBadge.textContent = `${file.name}`;
      onImageChange?.(dataUrl);
      probeImageDimensions(dataUrl);
      updateStageVisibility();
      renderBoxes();
      setStatus(`已载入参考图：${file.name}`);
    } catch (err) {
      setStatus(String(err?.message || err), true);
    }
  });

  const toggleBoxesBtn = el("button", "aps-btn aps-btn-sm is-active", "显隐画框");
  toggleBoxesBtn.type = "button";
  toggleBoxesBtn.classList.toggle("is-active", showBoxesOverlay);
  toggleBoxesBtn.textContent = showBoxesOverlay ? "隐藏画框" : "显示画框";
  toggleBoxesBtn.title = "显隐参考图上的布局框（在散文/Danbooru模式下也可点选画框 @引用 局部修改）";
  toggleBoxesBtn.addEventListener("click", () => {
    showBoxesOverlay = !showBoxesOverlay;
    toggleBoxesBtn.classList.toggle("is-active", showBoxesOverlay);
    toggleBoxesBtn.textContent = showBoxesOverlay ? "隐藏画框" : "显示画框";
    renderBoxes();
  });

  const drawBtn = el("button", "aps-btn aps-btn-sm", "➕ 画布拉框");
  drawBtn.type = "button";
  drawBtn.title = "开启后可在图片空白处直接按住鼠标拖拽画出新区域框（或按住 Shift 拖拽）";
  drawBtn.addEventListener("click", () => {
    drawMode = !drawMode;
    drawBtn.classList.toggle("is-active", drawMode);
    svg.style.cursor = drawMode ? "crosshair" : "";
  });

  const dimBtn = el("button", "aps-btn aps-btn-sm", "压暗底图");
  dimBtn.type = "button";
  dimBtn.title = "降低参考图亮度以便更清晰地查看区域框线";
  dimBtn.addEventListener("click", () => {
    dimImage = !dimImage;
    dimBtn.classList.toggle("is-active", dimImage);
    renderBoxes();
  });

  const layoutArrangeBtn = el("button", "aps-btn aps-btn-sm", "📐 布局: 自动");
  layoutArrangeBtn.type = "button";
  layoutArrangeBtn.title = "根据图片长宽比自动切换「画布左右并排（竖图）」或「画布上下分栏（横图）」，点击可手动切换，拖拽分割条可微调尺寸";
  layoutArrangeBtn.addEventListener("click", () => {
    const order = ["auto", "side", "stack"];
    const nextIdx = (order.indexOf(layoutArrangePolicy) + 1) % order.length;
    layoutArrangePolicy = order[nextIdx];
    customStageRatio = null;
    customStageHeightPx = null;
    applyAdaptiveLayout();
  });

  stageToolbar.append(imgBadge, uploadBtn, toggleBoxesBtn, drawBtn, dimBtn, layoutArrangeBtn, uploadInput);

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
      imgBadge.textContent = `${file.name}`;
      onImageChange?.(dataUrl);
      probeImageDimensions(dataUrl);
      updateStageVisibility();
      renderBoxes();
      setStatus(`已拖入并加载参考图：${file.name}`);
    } catch (err) {
      setStatus(String(err?.message || err), true);
    }
  });
  const svg = createSvg(width, height);
  const stageScanOverlay = el("div", "aps-stage-scan-overlay");
  stageScanOverlay.hidden = true;
  stageScanOverlay.append(el("div", "aps-stage-progress"));
  canvasWrap.append(svg, stageScanOverlay);

  const captionRefWrap = el("div", "aps-wb-caption-ref");
  captionRefWrap.hidden = true;
  const captionRefImg = el("img", "aps-wb-caption-ref-img");
  captionRefImg.alt = "参考图片预览";
  captionRefWrap.append(captionRefImg);

  function applyAdaptiveLayout() {
    const adaptive = computeAdaptiveLayoutMode(width, height);
    const effectiveSplit = layoutArrangePolicy === "auto" ? adaptive.stageSplit : layoutArrangePolicy;
    leftCol.dataset.split = effectiveSplit;
    modal.dataset.orientation = adaptive.orientation;

    const colRatio = customColRatio !== null ? customColRatio : adaptive.colRatio;
    const stageRatio = customStageRatio !== null ? customStageRatio : adaptive.stageRatio;
    const stageHeightPx = customStageHeightPx !== null ? customStageHeightPx : adaptive.stageHeightPx;

    body.style.setProperty("--aps-wb-col-ratio", `${Math.round(colRatio * 100)}%`);
    leftCol.style.setProperty("--aps-wb-stage-ratio", `${Math.round(stageRatio * 100)}%`);
    leftCol.style.setProperty("--aps-wb-stage-height", `${stageHeightPx}px`);

    const policyLabels = {
      auto: `📐 自动 (${effectiveSplit === "side" ? "竖图并排" : "横图上下"})`,
      side: "画布左·编辑右",
      stack: "⊟ 画布上·编辑下",
    };
    layoutArrangeBtn.textContent = policyLabels[layoutArrangePolicy] || "📐 自动";
  }

  function probeImageDimensions(dataUrl) {
    if (!dataUrl || typeof Image === "undefined") return;
    const probe = new Image();
    probe.onload = () => {
      const nw = probe.naturalWidth;
      const nh = probe.naturalHeight;
      if (!(nw > 0 && nh > 0)) return;
      // 换底图后画布必须跟着新图走，否则新图被塞进上一张的画框尺寸里。
      // 同比例换图保留用户手选的分辨率，只按 16 倍数修正。
      const sameAspect = Math.abs(nw / nh - width / height) < 0.02;
      if (!sameAspect) {
        const target = canvasSizeForImage(nw, nh);
        Object.assign(draft, rescaleLayoutDraft(draft, target.width, target.height, width, height));
        width = target.width;
        height = target.height;
      }
      sizeNote.textContent = `${width} × ${height}（16 倍数）`;
      imgBadge.textContent = `底图 ${width}×${height}`;
      updateCanvasAspect();
      renderBoxes();
      renderList();
    };
    probe.src = dataUrl;
  }

  function updateCanvasAspect() {
    canvasWrap.style.aspectRatio = `${width} / ${height}`;
    applyAdaptiveLayout();
  }
  function updateStageVisibility() {
    const hasLayout = currentMode === "layout";
    const hasBoxes = Array.isArray(draft.items) && draft.items.length > 0;
    // Always display the large unified SVG stage across all modes!
    canvasWrap.hidden = false;
    captionRefWrap.hidden = true;
    if (currentImageUrl) captionRefImg.src = currentImageUrl;
    drawBtn.hidden = !hasLayout;
    toggleBoxesBtn.hidden = !hasLayout && !hasBoxes;
    dimBtn.hidden = !currentImageUrl;
  }
  updateCanvasAspect();
  updateStageVisibility();
  if (currentImageUrl) {
    probeImageDimensions(currentImageUrl);
  }

  // 2) Inline Diff Host (shows AI edit proposals right above the editor)
  const diffHost = el("div", "aps-wb-diff-host");

  // 3) Prompt & Region Editor
  const capField = el("label", "aps-modal-field");
  const capFieldHead = el("div", "aps-wb-field-head");
  const capFieldLabel = el(
    "span",
    "aps-wb-field-title",
    currentMode === "caption"
      ? "散文描述（caption_prompt）"
      : currentMode === "danbooru"
        ? "Danbooru 标签（danbooru_prompt）"
        : "整体描述（summary.caption）",
  );
  const copyPromptBtn = el("button", "aps-btn aps-btn-sm", "复制");
  copyPromptBtn.type = "button";
  copyPromptBtn.addEventListener("click", () => {
    const textToCopy = getCurrentPromptText();
    globalThis.navigator?.clipboard?.writeText?.(textToCopy);
    setStatus("已复制当前提示词到剪贴板。");
  });
  capFieldHead.append(capFieldLabel, copyPromptBtn);

  const capArea = el("textarea", "aps-modal-textarea");
  capArea.value = currentMode === "danbooru" ? danbooruText : captionText;
  capArea.rows = currentMode === "layout" ? 4 : 8;
  capArea.placeholder = "在此直接编写或修改英文/中文提示词，或使用右侧 AI 助手反推、扩写与对话微调…";
  capArea.addEventListener("focus", () => {
    if (!activeEditTarget.startsWith("region:")) {
      setEditTarget(currentMode === "danbooru" ? "danbooru" : "summary");
    }
  });
  capArea.addEventListener("change", () => {
    if (currentMode === "danbooru") {
      recordTextChange("danbooru", danbooruText, capArea.value, "手动编辑标签");
      danbooruText = capArea.value;
    } else {
      recordTextChange("summary", captionText, capArea.value, "手动编辑描述");
      captionText = capArea.value;
      if (draft.summary) draft.summary.caption = captionText;
      updateJsonPreview();
    }
  });
  capArea.addEventListener("input", () => {
    if (currentMode === "danbooru") {
      danbooruText = capArea.value;
    } else {
      captionText = capArea.value;
      if (draft.summary) draft.summary.caption = captionText;
      updateJsonPreview();
    }
  });
  capField.append(capFieldHead, capArea);

  const listHost = el("div", "aps-layout-list");
  listHost.hidden = currentMode !== "layout";

  const jsonPreviewWrap = el("details", "aps-wb-json-details");
  jsonPreviewWrap.hidden = currentMode !== "layout";
  const jsonSummary = el("summary", "aps-wb-json-summary", "查看 PromptBoard 编译草稿 JSON");
  const jsonPre = el("pre", "aps-wb-json-pre", "");
  jsonPreviewWrap.append(jsonSummary, jsonPre);

  // Draggable Splitter between Stage Pane & Editor Pane inside Left Column
  const stageSplitter = el("div", "aps-wb-stage-splitter");
  stageSplitter.title = "鼠标拖拽调整参考图画布与文本编辑区大小（双击恢复自动最佳比例）";
  stageSplitter.addEventListener("dblclick", () => {
    customStageRatio = null;
    customStageHeightPx = null;
    applyAdaptiveLayout();
    setStatus("已重置画布与编辑区为自适应比例。");
  });
  stageSplitter.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    const isSide = leftCol.dataset.split === "side";
    const leftRect = leftCol.getBoundingClientRect();
    const stageRect = canvasWrap.getBoundingClientRect();
    stageSplitter.classList.add("is-dragging");
    try {
      stageSplitter.setPointerCapture(ev.pointerId);
    } catch {
      /* ignore synthetic */
    }
    const onMove = (moveEv) => {
      if (isSide) {
        const w = Math.max(200, leftRect.width);
        customStageRatio = clamp((moveEv.clientX - leftRect.left) / w, 0.25, 0.76);
      } else {
        customStageHeightPx = clamp(Math.round(moveEv.clientY - stageRect.top), 180, 740);
      }
      applyAdaptiveLayout();
    };
    const onUp = () => {
      stageSplitter.classList.remove("is-dragging");
      stageSplitter.removeEventListener("pointermove", onMove);
      stageSplitter.removeEventListener("pointerup", onUp);
      stageSplitter.removeEventListener("pointercancel", onUp);
    };
    stageSplitter.addEventListener("pointermove", onMove);
    stageSplitter.addEventListener("pointerup", onUp);
    stageSplitter.addEventListener("pointercancel", onUp);
  });

  stagePane.append(stageToolbar, canvasWrap, captionRefWrap);
  editorPane.append(diffHost, capField, listHost, jsonPreviewWrap);
  leftCol.append(stagePane, stageSplitter, editorPane);

  // Draggable Splitter between Left Column & Right Column
  const colSplitter = el("div", "aps-wb-col-splitter");
  colSplitter.title = "鼠标拖拽调整左右工作区宽度比例（双击恢复默认比例）";
  colSplitter.addEventListener("dblclick", () => {
    customColRatio = null;
    applyAdaptiveLayout();
    setStatus("已恢复左右分栏默认宽度比例。");
  });
  colSplitter.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    const bodyRect = body.getBoundingClientRect();
    colSplitter.classList.add("is-dragging");
    try {
      colSplitter.setPointerCapture(ev.pointerId);
    } catch {
      /* ignore synthetic */
    }
    const onMove = (moveEv) => {
      const totalW = Math.max(400, bodyRect.width);
      customColRatio = clamp((moveEv.clientX - bodyRect.left) / totalW, 0.34, 0.78);
      applyAdaptiveLayout();
    };
    const onUp = () => {
      colSplitter.classList.remove("is-dragging");
      colSplitter.removeEventListener("pointermove", onMove);
      colSplitter.removeEventListener("pointerup", onUp);
      colSplitter.removeEventListener("pointercancel", onUp);
    };
    colSplitter.addEventListener("pointermove", onMove);
    colSplitter.addEventListener("pointerup", onUp);
    colSplitter.addEventListener("pointercancel", onUp);
  });

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

  const runCaptionBtn = el("button", "aps-btn aps-primary aps-wb-caption-btn", "反推参考图");
  runCaptionBtn.type = "button";
  runCaptionBtn.title = "读取当前参考图生成提示词/布局，并自动加入下方对话上下文以便继续追问修改";
  runCaptionBtn.addEventListener("click", () => handleRunCaption());
  const importPromptBtn = el("button", "aps-btn aps-wb-import-btn", "导入 / 补全");
  importPromptBtn.type = "button";
  importPromptBtn.title = "填入成品提示词（Layout JSON / 自然语言 / Danbooru），智能补全其他选中格式并生成画框";
  importPromptBtn.addEventListener("click", () => {
    const curText = currentMode === "danbooru" ? danbooruText : captionText || capArea.value;
    openImportPromptModal({
      api,
      initialText: curText || "",
      initialModes: selectedModes,
      initialMode: currentMode,
      initialWidth: width,
      initialHeight: height,
      onApply: (result) => {
        applyCompletedPromptToWorkbench(result);
      },
    });
  });

  captionRow.append(formatSelect, runCaptionBtn, importPromptBtn);

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

  // 1.5) Multi-Conversation Thread Tabs Bar
  const wbThreadsRow = el("div", "aps-wb-threads-row");
  const wbThreadsBar = el("div", "aps-chat-threads-bar");
  const wbNewThreadBtn = el("button", "aps-chip-btn aps-btn-xs aps-chat-new-btn", "＋ 新对话");
  wbNewThreadBtn.type = "button";
  wbNewThreadBtn.title = "新建独立上下文的新对话标签页（可随时对比与切换多路改词思路）";
  wbThreadsRow.append(wbThreadsBar, wbNewThreadBtn);

  // 2) Multi-Turn Conversation Stream
  const chatStream = el("div", "aps-wb-messages");

  // 3) Unified Smart Composer (with Game-HUD Target Lock Bar & Activity Banner)
  const composerWrap = el("div", "aps-wb-composer");
  const hudActivityBanner = el("div", "aps-hud-activity-banner");
  hudActivityBanner.hidden = true;
  const targetLockBar = el("div", "aps-target-lock-bar is-global");
  const composerMeta = el("div", "aps-wb-composer-meta");

  const intentToggle = el("div", "aps-intent-group");
  const intentEditBtn = el("button", "aps-intent-btn is-active", "智能改词 (生成Diff)");
  intentEditBtn.type = "button";
  intentEditBtn.title = "发送后直接针对左侧提示词生成可审阅的局部修改提案，同时在对话中解释修改原因";
  const intentChatBtn = el("button", "aps-intent-btn", "💬 纯问答");
  intentChatBtn.type = "button";
  intentChatBtn.title = "仅在对话区流式回答问题，不自动改动提示词";

  intentEditBtn.addEventListener("click", () => {
    chatIntent = "edit";
    intentEditBtn.classList.add("is-active");
    intentChatBtn.classList.remove("is-active");
    syncComposerTargetUI();
  });
  intentChatBtn.addEventListener("click", () => {
    chatIntent = "chat";
    intentChatBtn.classList.add("is-active");
    intentEditBtn.classList.remove("is-active");
    syncComposerTargetUI();
  });
  intentToggle.append(intentEditBtn, intentChatBtn);

  const targetIndicator = el("span", "aps-wb-target-pill", "当前目标：整体描述");
  const clearChatBtn = el("button", "aps-link", "清空本对话");
  clearChatBtn.type = "button";
  clearChatBtn.title = "仅清空当前选中的对话气泡与上下文（其他对话标签页不受影响）";
  clearChatBtn.addEventListener("click", () => {
    if (busy) return;
    const cur = getActiveWbThread();
    const tid = cur?.id || activeThreadId;
    const oldSid = cur?.session_id || sessionId;
    const oldTitle = cur?.title || "当前对话";
    clearChatThread(state, tid, { maxTurns: 25 });
    sessionId = null;
    chatMessages = [];
    activeProposal = null;
    threadMessagesMap.set(tid, chatMessages);
    threadProposalsMap.set(tid, null);
    if (oldSid) api.deleteSession(oldSid).catch(() => {});
    renderWbThreadTabs();
    renderChatMessages();
    renderInlineDiff();
    onSessionChange?.(null);
    onChatLogChange?.([]);
    emitWbChatSync();
    setStatus(`已清空「${oldTitle}」上下文。`);
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
  stopStreamBtn.addEventListener("click", () => {
    activeController()?.abort();
  });

  const sendBtn = el("button", "aps-btn aps-primary aps-wb-send-btn", "发送改词 ✦");
  sendBtn.type = "button";
  sendBtn.addEventListener("click", () => handleSendComposer());

  composerRow.append(composerInput, stopStreamBtn, sendBtn);
  composerWrap.append(hudActivityBanner, targetLockBar, composerMeta, composerRow);

  rightCol.append(quickPanel, wbThreadsRow, chatStream, composerWrap);
  body.append(leftCol, colSplitter, rightCol);

  // =================================================================== FOOTER
  const foot = el("div", "aps-modal-foot");
  const status = el("span", "aps-modal-status", "");
  const cancelBtn = el("button", "aps-btn", "取消");
  cancelBtn.type = "button";
  const applyBtn = el("button", "aps-btn aps-primary", "应用");
  applyBtn.type = "button";
  foot.append(status, cancelBtn, applyBtn);

  // Corner Mouse Resizer for the Workbench Modal
  const modalResizer = el("div", "aps-wb-modal-resizer");
  modalResizer.title = "拖拽调整工作台窗口尺寸";
  modalResizer.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    const rect = modal.getBoundingClientRect();
    try {
      modalResizer.setPointerCapture(ev.pointerId);
    } catch {
      /* ignore synthetic */
    }
    const onMove = (moveEv) => {
      const nw = clamp(Math.round(moveEv.clientX - rect.left), 780, Math.round((globalThis.innerWidth || 1920) * 0.98));
      const nh = clamp(Math.round(moveEv.clientY - rect.top), 520, Math.round((globalThis.innerHeight || 1080) * 0.96));
      modal.style.width = `${nw}px`;
      modal.style.height = `${nh}px`;
      modal.style.maxHeight = "96vh";
    };
    const onUp = () => {
      modalResizer.removeEventListener("pointermove", onMove);
      modalResizer.removeEventListener("pointerup", onUp);
      modalResizer.removeEventListener("pointercancel", onUp);
    };
    modalResizer.addEventListener("pointermove", onMove);
    modalResizer.addEventListener("pointerup", onUp);
    modalResizer.addEventListener("pointercancel", onUp);
  });

  modal.append(body, foot, modalResizer);
  overlay.append(modal);
  document.body.append(overlay);

  // ========================================================== STATE & HELPERS
  let selected = -1;
  let pointerDrag = null;

  function setStatus(msg, isError = false, titleText = "") {
    const txt = msg || "";
    status.textContent = txt;
    status.title = titleText || txt;
    status.dataset.kind = isError ? "error" : "ok";
  }

  function reportEditorError(err, actionName = "操作") {
    const friendly = formatFriendlyError(err, actionName);
    const tech = formatErrorTechnicalDetail(err);
    const tip = tech ? `${friendly}\n\n${tech}` : friendly;
    setStatus(friendly, true, tip);
    return { friendly, tech, tip };
  }

  function renderHudActivityBanner() {
    const lastTurn = (Array.isArray(state?.chat_log) ? state.chat_log : []).slice(-1)[0];
    // 对话里已有「思考中」就不再重复报一次，进度始终只有一个出口。
    if (!busy || lastTurn?.pending) {
      hudActivityBanner.hidden = true;
      hudActivityBanner.textContent = "";
      return;
    }
    hudActivityBanner.hidden = false;
    hudActivityBanner.textContent = "";
    const elapsedSec = Math.max(0, (Date.now() - busyStartMs) / 1000);
    const dots = el("span", "aps-bouncing-dots");
    for (let i = 0; i < 3; i++) dots.append(el("i", ""));
    const fullTitle = String(busyActionLabel || "处理中").replace(/\s+/g, " ").trim();
    const titleSpan = el("span", "aps-hud-activity-title", excerpt(fullTitle, 44) || "处理中");
    titleSpan.title = busyActionTooltip || fullTitle;
    const timerSpan = el("span", "aps-thinking-timer", `${elapsedSec.toFixed(1)}s`);
    hudActivityBanner.append(dots, titleSpan, timerSpan);
  }

  let lastWbScrolledThreadId = null;

  function renderWbThreadTabs() {
    const { threads, activeId } = ensureChatThreads(state, { maxTurns: 25 });
    activeThreadId = activeId;
    const isRenamingFocused =
      editingWbThreadId &&
      wbThreadsBar.contains(document.activeElement) &&
      document.activeElement?.classList?.contains("aps-chat-thread-rename");
    if (isRenamingFocused) return;

    wbThreadsBar.textContent = "";
    for (const t of threads) {
      const isActive = t.id === activeId;
      const msgList = threadMessagesMap.get(t.id) || [];
      const turnBadgeCount = Array.isArray(t.chat_log) && t.chat_log.length > 0
        ? t.chat_log.length
        : Math.floor(msgList.filter((m) => m && m.role === "user").length);
      const tab = el("div", `aps-chat-thread-tab${isActive ? " is-active" : ""}${busy ? " is-disabled" : ""}`);
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(isActive));
      tab.title = busy
        ? "当前正在生成回复，请等待完成"
        : `${t.title}${turnBadgeCount ? ` (${turnBadgeCount} 轮)` : ""}\n单击切换 · 双击重命名`;

      if (editingWbThreadId === t.id && !busy) {
        const inp = el("input", "aps-chat-thread-rename");
        inp.type = "text";
        inp.maxLength = 40;
        inp.value = t.title;
        let committed = false;
        const finishRename = (save) => {
          if (committed) return;
          committed = true;
          editingWbThreadId = null;
          if (save) {
            const nextVal = inp.value.trim();
            if (nextVal && nextVal !== t.title) {
              renameChatThread(state, t.id, nextVal, { maxTurns: 25 });
              emitWbChatSync();
              setStatus(`已重命名对话为「${nextVal.slice(0, 40)}」。`);
            }
          }
          renderWbThreadTabs();
        };
        for (const evName of ["click", "pointerdown", "mousedown", "dblclick"]) {
          inp.addEventListener(evName, (ev) => ev.stopPropagation());
        }
        inp.addEventListener("keydown", (ev) => {
          ev.stopPropagation();
          if (ev.key === "Enter") {
            ev.preventDefault();
            finishRename(true);
          } else if (ev.key === "Escape") {
            ev.preventDefault();
            finishRename(false);
          }
        });
        inp.addEventListener("blur", () => finishRename(true));
        tab.append(inp);
        setTimeout(() => {
          try {
            inp.focus();
            inp.select();
          } catch {}
        }, 0);
      } else {
        tab.append(el("span", "aps-chat-thread-label", t.title));
        if (turnBadgeCount > 0) {
          tab.append(el("span", "aps-chat-thread-count", String(turnBadgeCount)));
        }
        if (threads.length > 1) {
          const closeBtn = el("button", "aps-chat-thread-close", "×");
          closeBtn.type = "button";
          closeBtn.disabled = busy;
          closeBtn.title = "关闭并删除此对话";
          closeBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            if (busy) return;
            const { deleted, activeThread: nextAct, activeId: nextActId } = deleteChatThread(state, t.id, { maxTurns: 25 });
            if (deleted) {
              threadMessagesMap.delete(deleted.id);
              threadProposalsMap.delete(deleted.id);
              if (deleted.session_id) api.deleteSession(deleted.session_id).catch(() => {});
            }
            activeThreadId = nextActId;
            sessionId = nextAct?.session_id || null;
            if (!threadMessagesMap.has(activeThreadId)) {
              const restored = Array.isArray(nextAct?.chat_log) ? nextAct.chat_log.flatMap(turnToMessages) : [];
              threadMessagesMap.set(activeThreadId, restored);
            }
            chatMessages = threadMessagesMap.get(activeThreadId);
            activeProposal = threadProposalsMap.get(activeThreadId) || null;
            editingWbThreadId = null;
            renderWbThreadTabs();
            renderChatMessages();
            renderInlineDiff();
            onSessionChange?.(sessionId);
            onChatLogChange?.(state.chat_log);
            emitWbChatSync();
            setStatus(`已删除「${deleted?.title || t.title}」，当前对话：${nextAct?.title || "对话 1"}。`);
          });
          tab.append(closeBtn);
        }
        tab.addEventListener("click", () => switchWbThread(t.id));
        tab.addEventListener("dblclick", (ev) => {
          if (busy || ev.target.closest?.(".aps-chat-thread-close")) return;
          ev.stopPropagation();
          editingWbThreadId = t.id;
          renderWbThreadTabs();
        });
      }
      wbThreadsBar.append(tab);
      if (isActive && lastWbScrolledThreadId !== activeId) {
        lastWbScrolledThreadId = activeId;
        setTimeout(() => {
          try {
            tab.scrollIntoView?.({ block: "nearest", inline: "nearest" });
          } catch {}
        }, 0);
      }
    }
  }

  function switchWbThread(targetId) {
    if (busy) {
      setStatus("当前正在生成回复，请等待完成后再切换对话。", true);
      return;
    }
    if (!targetId || targetId === activeThreadId) return;
    threadMessagesMap.set(activeThreadId, chatMessages);
    threadProposalsMap.set(activeThreadId, activeProposal);
    const sw = switchChatThread(state, targetId, { maxTurns: 25 });
    if (!sw.ok) return;
    activeThreadId = sw.activeId;
    sessionId = sw.thread?.session_id || null;
    if (!threadMessagesMap.has(activeThreadId)) {
      const restored = Array.isArray(sw.thread?.chat_log) ? sw.thread.chat_log.flatMap(turnToMessages) : [];
      threadMessagesMap.set(activeThreadId, restored);
    }
    chatMessages = threadMessagesMap.get(activeThreadId);
    activeProposal = threadProposalsMap.get(activeThreadId) || null;
    editingWbThreadId = null;
    renderWbThreadTabs();
    renderChatMessages();
    renderInlineDiff();
    onSessionChange?.(sessionId);
    onChatLogChange?.(state.chat_log);
    emitWbChatSync();
    setStatus(`已切换到「${sw.thread?.title || "对话"}」。`);
  }

  wbNewThreadBtn.addEventListener("click", () => {
    if (busy) return;
    threadMessagesMap.set(activeThreadId, chatMessages);
    threadProposalsMap.set(activeThreadId, activeProposal);
    const created = createChatThread(state, { maxTurns: 25 });
    if (!created.ok) {
      setStatus(created.error, true);
      return;
    }
    activeThreadId = created.activeId;
    sessionId = null;
    chatMessages = [];
    activeProposal = null;
    threadMessagesMap.set(activeThreadId, chatMessages);
    threadProposalsMap.set(activeThreadId, null);
    editingWbThreadId = null;
    renderWbThreadTabs();
    renderChatMessages();
    renderInlineDiff();
    onSessionChange?.(null);
    onChatLogChange?.([]);
    emitWbChatSync();
    setStatus(`✓ 已新建独立对话「${created.thread.title}」。`);
    setTimeout(() => {
      try {
        composerInput.focus();
      } catch {}
    }, 0);
  });

  function setBusyState(nextBusy, msg = "", isCaptionScan = false, fullTooltip = "") {
    busy = nextBusy;
    runCaptionBtn.disabled = nextBusy;
    if (typeof importPromptBtn !== "undefined") importPromptBtn.disabled = nextBusy;
    sendBtn.disabled = nextBusy;
    wbNewThreadBtn.disabled = nextBusy;
    clearChatBtn.disabled = nextBusy;
    stopStreamBtn.hidden = !streamController;
    stageScanOverlay.hidden = !(nextBusy && isCaptionScan);
    renderWbThreadTabs();
    if (busyTimer) {
      clearInterval(busyTimer);
      busyTimer = null;
    }
    if (nextBusy) {
      busyStartMs = Date.now();
      busyActionLabel = excerpt(msg || "AI 正在思考中", 44) || "AI 正在思考中";
      busyActionTooltip = String(fullTooltip || msg || "").replace(/\s+/g, " ").trim();
      renderHudActivityBanner();
      renderChatMessages();
      if (typeof setInterval === "function") {
        busyTimer = setInterval(() => {
          if (!busy) return;
          renderHudActivityBanner();
          const liveTimer = chatStream.querySelector(".aps-thinking-timer");
          if (liveTimer) {
            const sec = Math.max(0, (Date.now() - busyStartMs) / 1000);
            liveTimer.textContent = `${sec.toFixed(1)}s`;
          }
        }, 120);
      }
    } else {
      busyActionLabel = "";
      busyActionTooltip = "";
      renderHudActivityBanner();
      renderChatMessages();
    }
    if (msg) setStatus(excerpt(msg, 64), false, fullTooltip || msg);
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
        syncComposerTargetUI();
        return;
      }
    }
    if (activeEditTarget === "danbooru" || (activeEditTarget !== "summary" && currentMode === "danbooru")) {
      const before = danbooruText;
      recordTextChange("danbooru", before, nextText, label);
      danbooruText = nextText;
      if (currentMode === "danbooru") capArea.value = nextText;
      return;
    }
    const before = captionText;
    recordTextChange("summary", before, nextText, label);
    captionText = nextText;
    if (draft.summary) draft.summary.caption = nextText;
    if (currentMode !== "danbooru") capArea.value = nextText;
    updateJsonPreview();
  }

  function syncComposerTargetUI() {
    targetLockBar.textContent = "";
    if (activeEditTarget.startsWith("region:")) {
      const idx = Number(activeEditTarget.split(":")[1]);
      const item = draft.items[idx];
      if (item) {
        const color = BOX_COLORS[idx % BOX_COLORS.length];
        const displayName = item.name || LABEL_NAMES[item.label] || item.label;
        targetIndicator.textContent = `当前目标：@画框 #${idx + 1} (${displayName})`;
        targetLockBar.className = "aps-target-lock-bar is-locked";
        targetLockBar.style.setProperty("--aps-lock-color", color);

        const badge = el("span", "aps-target-lock-badge", `@画框 #${idx + 1}「${displayName}」`);
        badge.style.backgroundColor = color;
        const snippet = el(
          "span",
          "aps-target-lock-snippet",
          item.caption ? String(item.caption).slice(0, 72) : "（暂无区域描述，可直接输入指令生成）",
        );
        const unquoteBtn = el("button", "aps-target-unlock-btn", "✕ 取消引用 (改全局)");
        unquoteBtn.type = "button";
        unquoteBtn.addEventListener("click", () => {
          selected = -1;
          setEditTarget(currentMode === "danbooru" ? "danbooru" : "summary");
          renderBoxes();
          renderList();
        });
        targetLockBar.append(badge, snippet, unquoteBtn);

        composerInput.placeholder = `已引用 @画框 #${idx + 1}「${displayName}」：输入针对该框的修改要求（如：改成红色机甲 / 加上发光特效）… Ctrl+Enter 发送`;
        sendBtn.textContent = chatIntent === "chat" ? `提问 #${idx + 1}` : `改 #${idx + 1} ✦`;
        return;
      }
    }
    targetLockBar.className = "aps-target-lock-bar is-global";
    targetLockBar.style.removeProperty("--aps-lock-color");
    const globalTitle =
      currentMode === "danbooru"
        ? "Danbooru 标签"
        : currentMode === "caption"
          ? "散文主提示词"
          : "整体描述 (summary)";
    targetIndicator.textContent = `当前目标：${globalTitle}`;
    const globalBadge = el("span", "aps-target-global-badge", `全局模式 · ${globalTitle}`);
    const globalHint = el(
      "span",
      "aps-target-lock-snippet",
      draft.items?.length
        ? "鼠标点击左侧画布上的任意布局框即可 @引用 针对该框修改；不选框则修改全局提示词"
        : "直接输入指令修改全局提示词，或先反推生成区域画框",
    );
    targetLockBar.append(globalBadge, globalHint);
    composerInput.placeholder =
      "直接输入全局修改指令（如：把背景改成雨夜霓虹 / 给人物加上银色短发 / 翻译成英文）… Ctrl+Enter 发送";
    sendBtn.textContent = chatIntent === "chat" ? "发送提问" : "发送改词 ✦";
  }

  function setEditTarget(targetKey) {
    activeEditTarget = targetKey;
    syncComposerTargetUI();
  }
  setEditTarget(activeEditTarget);

  // Delete / Backspace on a selected box removes the region and its caption.
  // Only acts while this overlay is the topmost studio modal, so a stacked
  // preset/settings dialog keeps its own keyboard behaviour.
  function removeRegionAt(index) {
    if (!Number.isInteger(index) || index < 0) return false;
    if (!draft?.items?.[index]) return false;
    const victim = draft.items[index] || {};
    const displayName =
      String(victim.name || victim.caption || "").trim().slice(0, 12) || `#${index + 1}`;
    const result = removeRegion(draft.items, index, selected);
    draft.items = result.items;
    selected = result.selectedIndex;
    if (activeEditTarget.startsWith("region:")) {
      const target = Number(activeEditTarget.split(":")[1]);
      if (target === index) {
        setEditTarget(selected >= 0 ? `region:${selected}` : "summary");
      } else if (Number.isInteger(target) && target > index) {
        setEditTarget(`region:${target - 1}`);
      }
    }
    renderBoxes();
    renderList();
    updateJsonPreview();
    setStatus(`🗑 已删除区域 #${index + 1}「${displayName}」的画框及其描述。`);
    return true;
  }

  function deleteSelectedRegion() {
    return removeRegionAt(selected);
  }

  function onDeleteKey(ev) {
    if (!overlay.isConnected) return;
    const overlays = document.querySelectorAll?.(".aps-modal-overlay");
    if (!overlays || overlays.length === 0) return;
    if (overlays[overlays.length - 1] !== overlay) return;
    if (!shouldDeleteSelection(ev, selected)) return;
    if (!deleteSelectedRegion()) return;
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation?.();
  }
  document.addEventListener("keydown", onDeleteKey, true);

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
    } else if (key === "danbooru") {
      danbooruText = value;
      if (currentMode === "danbooru") capArea.value = value;
    } else {
      captionText = value;
      if (draft.summary) draft.summary.caption = value;
      if (currentMode !== "danbooru") capArea.value = value;
    }
    updateJsonPreview();
    syncComposerTargetUI();
  }

  function switchMode(nextMode) {
    const normalized = nextMode === "hybrid" ? "danbooru" : nextMode;
    if (!["caption", "layout", "danbooru"].includes(normalized)) return;
    if (currentMode === "danbooru") {
      danbooruText = capArea.value;
    } else {
      captionText = capArea.value;
    }
    currentMode = normalized;
    syncModeButtonsUI();
    const hasLayout = currentMode === "layout";
    titleWrap.querySelector(".aps-modal-title").textContent =
      currentMode === "caption"
        ? "编辑散文描述"
        : currentMode === "danbooru"
          ? "编辑 Danbooru 标签"
          : "编辑布局";
    capFieldLabel.textContent =
      currentMode === "caption"
        ? "散文描述（caption_prompt）"
        : currentMode === "danbooru"
          ? "Danbooru 标签（danbooru_prompt）"
          : "整体描述（summary.caption）";
    capArea.rows = hasLayout ? 4 : 8;
    capArea.value = currentMode === "danbooru" ? danbooruText : captionText;
    listHost.hidden = !hasLayout;
    jsonPreviewWrap.hidden = !hasLayout;
    if (activeEditTarget.startsWith("region:")) {
      // Keep region @quote locked across mode switches if region still exists!
      setEditTarget(activeEditTarget);
    } else {
      setEditTarget(currentMode === "danbooru" ? "danbooru" : "summary");
    }
    updateStageVisibility();
    renderBoxes();
    renderList();
    updateJsonPreview();
  }

  function updateJsonPreview() {
    if (currentMode !== "layout") return;
    const previewDraft = normalizeDraft(
      { ...draft, summary: { ...draft.summary, caption: captionText || capArea.value || draft.summary.caption } },
      width,
      height,
    );
    jsonPre.textContent = JSON.stringify(previewDraft, null, 2);
  }

  function ensureSizeSelectOption(nw, nh) {
    const val = `${nw}x${nh}`;
    if (!Array.from(sizeSelect.options).some((o) => o.value === val)) {
      const opt = el("option", "", `${nw}×${nh}`);
      opt.value = val;
      sizeSelect.prepend(opt);
    }
    sizeSelect.value = val;
    sizeNote.textContent = `${nw} × ${nh}（16 倍数）`;
  }

  function applyCompletedPromptToWorkbench(res) {
    const p = res?.payload && typeof res.payload === "object" ? res.payload : {};
    const nw = Math.max(16, Number(res?.width || p.width || width) || width);
    const nh = Math.max(16, Number(res?.height || p.height || height) || height);
    width = nw;
    height = nh;
    draft.width = nw;
    draft.height = nh;

    const incomingDraft = p.layout_draft || p.draft || p.hybrid_draft;
    if (incomingDraft && typeof incomingDraft === "object") {
      const norm = normalizeDraft(incomingDraft, nw, nh);
      draft.items = norm.items;
      draft.summary = norm.summary;
    }

    const nextCap = String(
      p.caption_text ||
        p.caption ||
        res?.outputs?.caption_prompt ||
        incomingDraft?.summary?.caption ||
        "",
    ).trim();
    if (nextCap) {
      captionText = nextCap;
      if (draft.summary) draft.summary.caption = nextCap;
    }

    const nextDan = String(
      p.danbooru_prompt || p.danbooru_text || p.tags || res?.outputs?.danbooru_prompt || "",
    ).trim();
    if (nextDan) {
      danbooruText = nextDan;
    }

    const rawModes = Array.isArray(res?.modes || p.modes) ? res?.modes || p.modes : selectedModes;
    const canonModes = ["caption", "layout", "danbooru"].filter((m) => rawModes.map(canonicalMode).includes(m));
    if (canonModes.length) {
      selectedModes = canonModes;
    }

    let nextActiveMode = currentMode;
    if (res?.detected_source === "layout" && selectedModes.includes("layout") && draft.items.length) {
      nextActiveMode = "layout";
    } else if (!selectedModes.includes(currentMode)) {
      nextActiveMode = selectedModes[0];
    }

    selected = -1;
    // Sync textarea value BEFORE calling switchMode so switchMode doesn't capture stale capArea text
    capArea.value = currentMode === "danbooru" ? danbooruText : captionText;
    syncModeButtonsUI();
    ensureSizeSelectOption(nw, nh);
    switchMode(nextActiveMode);
    updateCanvasAspect();
    renderBoxes();
    renderList();
    updateJsonPreview();

    const srcLabel =
      { layout: "Layout JSON", caption: "自然语言", danbooru: "Danbooru 标签" }[res?.detected_source] ||
      "成品提示词";
    setStatus(
      `✓ 已导入「${srcLabel}」并补全 ${selectedModes.length} 个格式（${nw}×${nh}${
        draft.items.length ? ` · ${draft.items.length} 个画框` : ""
      }）`,
    );
  }

  applyPresetToWorkbench = function (preset) {
    if (!preset) return;
    const nw = Math.max(16, Number(preset.width) || 1024);
    const nh = Math.max(16, Number(preset.height) || 1024);
    width = nw;
    height = nh;
    draft.width = nw;
    draft.height = nh;
    if (preset.draft && typeof preset.draft === "object") {
      const cloned = JSON.parse(JSON.stringify(preset.draft));
      draft.items = Array.isArray(cloned.items) ? cloned.items : [];
      draft.meta = cloned.meta || draft.meta || {};
      draft.summary = cloned.summary || draft.summary || {};
    }
    const prompts = preset.prompts || {};
    if (prompts.caption) {
      captionText = prompts.caption;
      if (draft.summary) draft.summary.caption = captionText;
    }
    if (prompts.danbooru) {
      danbooruText = prompts.danbooru;
    }
    capArea.value = currentMode === "danbooru" ? danbooruText : captionText;
    ensureSizeSelectOption(width, height);
    updateCanvasAspect();
    renderBoxes();
    renderList();
    updateJsonPreview();
    setStatus(`✓ 已应用构图预设：「${preset.name}」（${width}×${height} · ${draft.items.length} 个画框主体）`);
  };

  // ===================================================== SVG & LIST RENDERING
  function renderBoxes() {
    const hasLayout = currentMode === "layout";
    const showBoxes = hasLayout || (showBoxesOverlay && Array.isArray(draft.items) && draft.items.length > 0);
    renderSvgStage(svg, {
      width,
      height,
      draft,
      imageUrl: currentImageUrl,
      selected,
      showBoxes,
      dimImage,
    });
  }

  function renderList() {
    listHost.textContent = "";
    if (currentMode !== "layout") return;

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
      `共 ${draft.items.length} 个区域（点击区域可在画布高亮并可用右侧 AI 单独微调；选中后按 Delete 可删除该框及描述）`,
    );
    toolbar.append(addBtn, regionHint);
    listHost.append(toolbar);

    draft.items.forEach((item, index) => {
      const isSel = selected === index;
      const card = el("div", "aps-layout-item" + (isSel ? " is-active" : ""));

      // Row 1: Header (Index, Category Select, Entity Name, Coords, Actions)
      const head = el("div", "aps-layout-item-head");
      const idx = el("span", "aps-layout-index", `#${index + 1}`);
      idx.style.color = BOX_COLORS[index % BOX_COLORS.length];

      const labelSel = el("select", "aps-select aps-layout-type-select");
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

      const nameInput = el("input", "aps-input aps-layout-name-input");
      nameInput.type = "text";
      nameInput.placeholder = "实体名称（如：光环）";
      nameInput.value = item.name || "";
      nameInput.title = "实体名称（显示在画框与标签上）";
      nameInput.addEventListener("input", () => {
        item.name = nameInput.value.trim();
        renderBoxes();
        updateJsonPreview();
      });

      const coords = el("span", "aps-layout-coords", item.bbox.join(", "));
      coords.dataset.coords = String(index);

      const aiFocusBtn = el("button", "aps-btn aps-btn-sm aps-layout-focus-btn", "改此区域");
      aiFocusBtn.type = "button";
      aiFocusBtn.title = "将右侧 AI 改词目标切换到此区域";
      aiFocusBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        selected = index;
        setEditTarget(`region:${index}`);
        renderBoxes();
        renderList();
        composerInput?.focus();
      });

      const del = el("button", "aps-btn aps-btn-sm aps-layout-del-btn", "删除");
      del.type = "button";
      del.title = "从画面中删除此区域画框（连同该区域的描述文字）";
      del.addEventListener("click", (ev) => {
        ev.stopPropagation();
        removeRegionAt(index);
      });

      const actions = el("div", "aps-layout-item-actions");
      actions.append(aiFocusBtn, del);

      head.append(idx, labelSel, nameInput, coords, actions);

      // Row 2: Full-width Visual Caption & Literal Text
      const body = el("div", "aps-layout-item-body");

      const captionInput = el("textarea", "aps-modal-textarea aps-layout-caption");
      captionInput.value = item.caption || "";
      captionInput.rows = 2;
      captionInput.placeholder = `区域 #${index + 1} 的视觉描述（例如：长发、蓝色发带、坐在椅子上）…`;
      captionInput.addEventListener("focus", () => {
        selected = index;
        setEditTarget(`region:${index}`);
        renderBoxes();
      });
      captionInput.addEventListener("input", () => {
        item.caption = captionInput.value;
        updateJsonPreview();
      });
      body.append(captionInput);

      if (item.label === "text") {
        const literal = el("input", "aps-input aps-layout-text-literal");
        literal.placeholder = "画面可见文字原文（text，如：SALE / 招牌文字）";
        literal.value = item.text || "";
        literal.addEventListener("input", () => {
          item.text = literal.value;
          updateJsonPreview();
        });
        body.append(literal);
      }

      card.append(head, body);

      card.addEventListener("pointerdown", (ev) => {
        if (ev.target.closest("input, textarea, select, button")) return;
        selected = index;
        setEditTarget(`region:${index}`);
        renderBoxes();
        renderList();
      });
      listHost.append(card);
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
    const group = ev.target.closest?.("g[data-index]");
    if (!group) {
      // Draw a new bounding box directly on empty canvas when drawMode or Shift is held in layout mode
      if (currentMode === "layout" && (drawMode || ev.shiftKey)) {
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
        return;
      }
      // Clicking empty canvas space cancels @region lock and returns to global modification
      if (selected !== -1 || activeEditTarget.startsWith("region:")) {
        selected = -1;
        setEditTarget(currentMode === "danbooru" ? "danbooru" : "summary");
        renderBoxes();
        renderList();
      }
      return;
    }
    const index = Number(group.dataset.index);
    selected = index;
    setEditTarget(`region:${index}`);
    const item = draft.items[index];
    if (!item) return;
    if (currentMode !== "layout") {
      renderBoxes();
      renderList();
      return;
    }
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
    renderBoxes();
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
    if (!chatMessages.length && !busy) {
      const actThread = getActiveWbThread();
      const isMulti = Array.isArray(state.chat_threads) && state.chat_threads.length > 1;
      const empty = el("div", "aps-empty aps-wb-empty");
      empty.append(
        el(
          "div",
          "aps-empty-title",
          isMulti
            ? `💬 当前「${actThread?.title || "新对话"}」暂无消息（上下文完全独立）`
            : "🎮 反推 → @点选画框 → AI 对话微调 一站闭环",
        ),
        el(
          "div",
          "aps-hint",
          isMulti
            ? "该对话拥有独立的多轮记忆（Session），与左侧当前画布和提示词实时联动；在下方直接输入要求或切换「纯问答」即可开始，不干扰其他对话分支。"
            : "1. 点击上方「🖼 反推参考图」自动扫描底图生成全局提示词与空间画框；\n" +
              "2. 鼠标点选左侧任意画框即可 @引用 针对该框局部改词，点击画布空白处则恢复改全局；\n" +
              "3. 左侧实时弹出红绿 Diff 预览，确认后应用，随时可撤销。",
        ),
      );
      chatStream.append(empty);
      return;
    }
    for (const msg of chatMessages) {
      const bubble = el("div", `aps-msg ${msg.role}` + (msg.error ? " is-error" : ""));
      const roleRow = el("div", "aps-msg-role");
      roleRow.append(el("span", "", msg.role === "user" ? "🧑‍🎨 你" : "AI 视觉伙伴"));
      if (msg.regionBadge) {
        const tag = el("span", "aps-chat-region-tag", msg.regionBadge);
        if (msg.regionColor) tag.style.setProperty("--aps-tag-color", msg.regionColor);
        roleRow.append(tag);
      }
      if (msg.crest) {
        roleRow.append(el("span", `aps-chat-crest ${msg.crestKind || ""}`, msg.crest));
      }
      bubble.append(roleRow, el("div", "aps-msg-text", msg.text));
      if (msg.note) {
        bubble.append(el("div", "aps-msg-note", msg.note));
      }
      if (msg.error && msg.errorDetail) {
        const errBox = el("details", "aps-chat-diff aps-chat-error-details");
        errBox.append(el("summary", "aps-chat-diff-sum", "查看技术细节（错误码 / 重试 / 报错原文）"));
        errBox.append(el("pre", "aps-chat-error-pre", String(msg.errorDetail)));
        bubble.append(errBox);
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

    // Live Game-HUD Companion Thinking Bubble when busy (and not already streaming delta into last msg)
    const lastMsg = chatMessages[chatMessages.length - 1];
    const isStreamingDelta = lastMsg && lastMsg.role === "assistant" && streamController;
    if (busy && !isStreamingDelta) {
      const elapsedSec = Math.max(0, (Date.now() - busyStartMs) / 1000);
      const thinkBubble = el("div", "aps-msg assistant is-thinking");
      const roleRow = el("div", "aps-msg-role");
      roleRow.append(el("span", "aps-thinking-crest", "AI 视觉伙伴 · 思考中"));
      const dots = el("span", "aps-bouncing-dots");
      for (let i = 0; i < 3; i++) dots.append(el("i", ""));
      const timerSpan = el("span", "aps-thinking-timer", `${elapsedSec.toFixed(1)}s`);
      roleRow.append(dots, timerSpan);

      const labelSpan = el("div", "aps-thinking-label", excerpt(busyActionLabel || "正在解析指令与画面锚点…", 44));
      labelSpan.title = busyActionTooltip || busyActionLabel || "";
      thinkBubble.append(roleRow, labelSpan);
      chatStream.append(thinkBubble);
    }

    chatStream.scrollTop = chatStream.scrollHeight;
  }

  function appendChatMessage(role, text, extra = {}, targetThreadId = activeThreadId) {
    const tid = targetThreadId || activeThreadId;
    let list = threadMessagesMap.get(tid);
    if (!Array.isArray(list)) {
      list = [];
      threadMessagesMap.set(tid, list);
    }
    const msg = { role, text, ...extra };
    list.push(msg);
    if (tid === activeThreadId) {
      chatMessages = list;
      renderChatMessages();
    }
    renderWbThreadTabs();
    return msg;
  }

  function renderInlineDiff() {
    diffHost.textContent = "";
    if (!activeProposal) return;

    const card = el("div", "aps-diff aps-wb-diff-card");
    const headRow = el("div", "aps-diff-head");
    headRow.append(
      el("span", "", `建议修改（${targetIndicator.textContent.replace("当前目标：", "")}）`),
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
      threadProposalsMap.set(activeThreadId, null);
      renderInlineDiff();
      setStatus("已放弃本次修改建议。");
    });

    actionsRow.append(applyAllBtn, applyCheckedBtn, discardBtn);
    card.append(actionsRow);
    diffHost.append(card);
  }

  async function commitProposal(indices) {
    if (!activeProposal || !indices.length) return;
    const targetThreadId = activeThreadId;
    const ops = selectOps(activeProposal.changes, indices);
    const currentText = getCurrentPromptText();
    setBusyState(true, "正在应用修改…");
    try {
      const res = await api.apply({ text: currentText, ops });
      setCurrentPromptText(res.text, activeProposal.reply || `${ops.length} 处修改`);

      // If this proposal deleted a box, remove it from draft.items!
      if (
        typeof activeProposal.deleteBoxIdx === "number" &&
        activeProposal.deleteBoxIdx >= 0 &&
        draft.items[activeProposal.deleteBoxIdx]
      ) {
        const delIdx = activeProposal.deleteBoxIdx;
        draft.items.splice(delIdx, 1);
        normalizeDraft(draft, width, height);
        selected = -1;
        setEditTarget(currentMode === "danbooru" ? "danbooru" : "summary");
        renderBoxes();
        renderList();
        updateJsonPreview();
      }

      appendChatMessage(
        "assistant",
        `✓ 已应用 ${ops.length} 处修改到左侧编辑器（可点顶部「撤销」回退）。`,
        {
          crest: "DIFF APPLIED",
          crestKind: "is-ok",
        },
        targetThreadId,
      );
      recordWorkbenchTurn({
        threadId: targetThreadId,
        userText: activeProposal.userInstruction || "AI 改词",
        label: activeProposal.displayLabel || activeProposal.userInstruction || "AI 改词",
        reply: activeProposal.reply || `✓ 已应用 ${ops.length} 处修改。`,
        changed: true,
        blocks: activeProposal.blocks,
        regionIdx: activeProposal.regionIdx,
        regionBadge: activeProposal.regionBadge,
        regionColor: activeProposal.regionColor,
      });
      threadProposalsMap.set(targetThreadId, null);
      if (targetThreadId === activeThreadId) {
        activeProposal = null;
        renderInlineDiff();
      }
      setStatus("修改已应用到编辑器，点右下角「应用」可保存回节点。");
    } catch (err) {
      reportEditorError(err, "应用修改");
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
    const reqThreadId = activeThreadId;
    const reqSessionId = getActiveWbThread()?.session_id || sessionId || undefined;
    setBusyState(true, "正在扫描参考图并反推视觉结构…", true);
    try {
      if (reverseFormat === "node_mode") {
        const res = await api.captionNode({
          mode: currentMode,
          modes: selectedModes,
          image: currentImageUrl ? { data_url: currentImageUrl } : undefined,
          image_path: state.image_path || "",
          session_id: reqSessionId,
          create_session: true,
        });
        if (res.session_id) {
          setThreadSessionId(state, reqThreadId, res.session_id, { maxTurns: 25 });
          if (reqThreadId === activeThreadId) {
            sessionId = res.session_id;
            onSessionChange?.(sessionId);
          }
          emitWbChatSync();
        }
        if (res.width && res.height) {
          width = res.width;
          height = res.height;
          draft.width = width;
          draft.height = height;
          sizeNote.textContent = `${width} × ${height}（16 倍数）`;
          imgBadge.textContent = `底图 ${width}×${height}`;
          updateCanvasAspect();
        }
        if (res.draft && Array.isArray(res.draft.items)) {
          draft.items = res.draft.items.map((it) => ({
            name: String(it.name || ""),
            label: LABELS.includes(it.label) ? it.label : "object",
            caption: String(it.caption || ""),
            text: String(it.text || ""),
            bbox: Array.isArray(it.bbox) ? it.bbox.slice() : [0, 0, width, height],
          }));
        }
        const prevTarget = activeEditTarget;
        if (res.caption) {
          activeEditTarget = "summary";
          setCurrentPromptText(res.caption, `反推 (${currentMode})`);
        }
        const nextDan = String(res.payload?.danbooru_prompt || "").trim();
        if ((res.modes || selectedModes).includes("danbooru") && nextDan) {
          activeEditTarget = "danbooru";
          setCurrentPromptText(nextDan, "反推 (danbooru)");
        }
        selected = -1;
        setEditTarget(currentMode === "danbooru" ? "danbooru" : (prevTarget.startsWith("region:") ? "summary" : prevTarget));
        updateStageVisibility();
        renderBoxes();
        renderList();
        updateJsonPreview();
        const shownPreview = currentMode === "danbooru"
          ? (nextDan || res.caption || "已完成标签反推。")
          : (res.caption || nextDan || "已完成布局反推。");
        const noteText = res.warning
          ? `${res.warning}${res.draft?.items?.length ? `（已保留 ${res.draft.items.length} 个区域框，${width}×${height}）` : ""}`
          : res.draft?.items?.length
            ? `已生成 ${res.draft.items.length} 个区域框与 ${width}×${height} 画布尺寸。点选画布任意框即可 @引用 局部改词！`
            : "反推结果已填入左侧编辑器，您可以直接在下方输入修改要求继续迭代！";
        appendChatMessage("user", `反推参考图（模式：${(res.modes || selectedModes).join(" + ")}）`, {}, reqThreadId);
        appendChatMessage("assistant", shownPreview, {
          note: noteText,
          crest: res.draft?.items?.length ? `📐 ${res.draft.items.length} BOXES READY` : "CAPTION READY",
          crestKind: "is-ok",
        }, reqThreadId);
        setStatus(
          res.warning
            ? `${res.warning}（其余已就绪：${width}×${height}）`
            : `反推完成（${width}×${height}），结果已写入编辑器并进入对话上下文。`,
        );
      } else {
        const res = await api.caption({
          image: { data_url: currentImageUrl },
          format: reverseFormat,
          session_id: reqSessionId,
          create_session: true,
        });
        if (res.session_id) {
          setThreadSessionId(state, reqThreadId, res.session_id, { maxTurns: 25 });
          if (reqThreadId === activeThreadId) {
            sessionId = res.session_id;
            onSessionChange?.(sessionId);
          }
          emitWbChatSync();
        }
        const text = res.text || "";
        if (text) {
          if (reverseFormat === "tags") {
            setEditTarget("danbooru");
            danbooruText = text;
            if (currentMode !== "danbooru") {
              recordTextChange("summary", captionText, text, `反推 (${reverseFormat})`);
              captionText = text;
              capArea.value = text;
            } else {
              setCurrentPromptText(text, `反推 (${reverseFormat})`);
            }
          } else {
            setEditTarget("summary");
            setCurrentPromptText(text, `反推 (${reverseFormat})`);
          }
          appendChatMessage("user", `反推参考图（格式：${reverseFormat}）`, {}, reqThreadId);
          appendChatMessage("assistant", text, {
            note: "已填入左侧编辑器并保存进会话上下文，可继续追问或点快捷指令改词。",
            crest: "CAPTION READY",
            crestKind: "is-ok",
          }, reqThreadId);
          setStatus("反推完成，已填入左侧编辑器。");
        }
      }
    } catch (err) {
      const { friendly, tech } = reportEditorError(err, "反推");
      appendChatMessage(
        "assistant",
        friendly,
        { error: true, errorDetail: tech || "", crest: "⚠️ ALERT", crestKind: "is-err" },
        reqThreadId,
      );
    } finally {
      setBusyState(false);
    }
  }

  async function runQuickAction(action) {
    if (busy) return;
    await executeEditInstruction(action.instruction, action.label);
  }

  async function executeEditInstruction(instruction, displayLabel = null) {
    const reqThreadId = activeThreadId;
    const reqSessionId = getActiveWbThread()?.session_id || sessionId || undefined;
    const currentText = getCurrentPromptText();
    const isRegionTarget = activeEditTarget.startsWith("region:");
    const regionIdx = isRegionTarget ? Number(activeEditTarget.split(":")[1]) : -1;
    const regionItem = isRegionTarget ? draft.items[regionIdx] : null;
    const isDanbooruTarget =
      activeEditTarget === "danbooru" || (!isRegionTarget && currentMode === "danbooru");
    // Always use "caption" when editing prose summary or an individual region's description!
    const editMode = isDanbooruTarget ? "danbooru" : "caption";

    const regionDisplayName = regionItem
      ? regionItem.name || LABEL_NAMES[regionItem.label] || regionItem.label
      : "";
    const regionBadge = regionItem ? `@画框 #${regionIdx + 1}「${regionDisplayName}」` : null;
    const regionColor = regionItem ? BOX_COLORS[regionIdx % BOX_COLORS.length] : null;

    maybeAutoTitleThread(state, reqThreadId, displayLabel || instruction, { maxTurns: 25 });
    appendChatMessage("user", displayLabel ? `${displayLabel}：${instruction}` : instruction, {
      regionBadge,
      regionColor,
    }, reqThreadId);
    emitWbChatSync();
    const flatLabel = String(displayLabel || instruction || "").replace(/\s+/g, " ").trim();
    const fullBusyLabel = regionItem
      ? `正在修改 @画框 #${regionIdx + 1}「${regionDisplayName}」：${flatLabel}…`
      : `正在执行：${flatLabel}…`;
    setBusyState(
      true,
      formatBusyStatusText(displayLabel || instruction, {
        regionIndex: regionItem ? regionIdx : -1,
        regionName: regionDisplayName,
        maxInstructionChars: regionItem ? 16 : 22,
        maxRegionChars: 10,
      }),
      false,
      fullBusyLabel,
    );
    try {
      const targetTitle = regionItem
        ? `区域画框 #${regionIdx + 1} (${regionDisplayName}, bbox=${JSON.stringify(regionItem.bbox)})`
        : targetIndicator.textContent;
      const effectiveMessage = regionItem && captionText
        ? `[当前针对局部画框 #${regionIdx + 1}「${regionDisplayName}」修改，整体画面背景供参考：${captionText.slice(0, 220)}]\n用户修改要求：${instruction}`
        : instruction;
      const res = await api.edit({
        message: effectiveMessage,
        mode: editMode,
        target: {
          title: targetTitle,
          widget: activeEditTarget,
          text: currentText,
        },
        images: currentImageUrl ? [{ data_url: currentImageUrl }] : undefined,
        session_id: reqSessionId,
        create_session: true,
        allow_empty: true,
        canvas: { width: Number(draft.width) || 1024, height: Number(draft.height) || 1024 },
      });
      if (res.session_id) {
        setThreadSessionId(state, reqThreadId, res.session_id, { maxTurns: 25 });
        if (reqThreadId === activeThreadId) {
          sessionId = res.session_id;
          onSessionChange?.(sessionId);
        }
        emitWbChatSync();
      }
      const proposal = res.proposal;
      const delIdx = detectBoxDeletion(instruction, draft.items, regionIdx, proposal?.reply);
      if (proposal && proposal.changed) {
        proposal.userInstruction = instruction;
        proposal.displayLabel = displayLabel;
        proposal.regionIdx = regionItem ? regionIdx : -1;
        proposal.regionBadge = regionBadge;
        proposal.regionColor = regionColor;

        if (delIdx >= 0 && draft.items[delIdx]) {
          proposal.deleteBoxIdx = delIdx;
          proposal.deletedBoxName = draft.items[delIdx].name || draft.items[delIdx].label || `画框 #${delIdx + 1}`;
          proposal.reply = (proposal.reply ? `${proposal.reply} ` : "") + `（应用后将同时从画面中移除画框 #${delIdx + 1}「${proposal.deletedBoxName}」）`;
        }

        threadProposalsMap.set(reqThreadId, proposal);
        if (reqThreadId === activeThreadId) {
          activeProposal = proposal;
          renderInlineDiff();
        }
        appendChatMessage(
          "assistant",
          proposal.reply || "已生成修改建议，请在左侧审阅并点击「全部应用」。",
          {
            note: `共 ${proposal.changes?.length || 1} 处改动，已在左侧高亮对比。`,
            regionBadge,
            regionColor,
            crest: "DIFF PROPOSAL",
            crestKind: "is-ok",
          },
          reqThreadId,
        );
        setStatus("修改提案已生成，请在左侧审阅后点击「全部应用」。");
      } else {
        if (delIdx >= 0 && draft.items[delIdx]) {
          const deletedItem = draft.items[delIdx];
          const deletedName = deletedItem.name || deletedItem.label || `画框 #${delIdx + 1}`;
          draft.items.splice(delIdx, 1);
          normalizeDraft(draft, width, height);
          selected = -1;
          setEditTarget(currentMode === "danbooru" ? "danbooru" : "summary");
          renderBoxes();
          renderList();
          updateJsonPreview();
          const delReply = `✓ 已从画面中删除画框 #${delIdx + 1}「${deletedName}」。`;
          appendChatMessage("assistant", delReply, {
            crest: "REGION DELETED",
            crestKind: "is-ok",
          }, reqThreadId);
          recordWorkbenchTurn({
            threadId: reqThreadId,
            userText: instruction,
            label: displayLabel || instruction,
            reply: delReply,
            changed: true,
            regionIdx: delIdx,
          });
          setStatus(delReply);
          return;
        }
        appendChatMessage("assistant", proposal?.reply || "模型认为当前提示词无需改动。", {
          regionBadge,
          regionColor,
          crest: "💬 NO CHANGE",
        }, reqThreadId);
        recordWorkbenchTurn({
          threadId: reqThreadId,
          userText: instruction,
          label: displayLabel || instruction,
          reply: proposal?.reply || "模型认为当前提示词无需改动。",
          changed: false,
          regionIdx: regionItem ? regionIdx : -1,
          regionBadge,
          regionColor,
        });
        setStatus("模型认为无需修改。");
      }
    } catch (err) {
      const { friendly, tech } = reportEditorError(err, "生成修改");
      appendChatMessage(
        "assistant",
        friendly,
        {
          error: true,
          errorDetail: tech || "",
          regionBadge,
          regionColor,
          crest: "⚠️ ALERT",
          crestKind: "is-err",
        },
        reqThreadId,
      );
      recordWorkbenchTurn({
        threadId: reqThreadId,
        userText: instruction,
        label: displayLabel || instruction,
        reply: friendly,
        error: true,
        errorDetail: tech || "",
        changed: false,
        regionIdx: regionItem ? regionIdx : -1,
        regionBadge,
        regionColor,
      });
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
    const reqThreadId = activeThreadId;
    const reqSessionId = getActiveWbThread()?.session_id || sessionId || undefined;
    const isRegionTarget = activeEditTarget.startsWith("region:");
    const regionIdx = isRegionTarget ? Number(activeEditTarget.split(":")[1]) : -1;
    const regionItem = isRegionTarget ? draft.items[regionIdx] : null;
    const regionDisplayName = regionItem
      ? regionItem.name || LABEL_NAMES[regionItem.label] || regionItem.label
      : "";
    const regionBadge = regionItem ? `@画框 #${regionIdx + 1}「${regionDisplayName}」` : null;
    const regionColor = regionItem ? BOX_COLORS[regionIdx % BOX_COLORS.length] : null;

    maybeAutoTitleThread(state, reqThreadId, text, { maxTurns: 25 });
    appendChatMessage("user", text, { regionBadge, regionColor }, reqThreadId);
    const assistantMsg = appendChatMessage("assistant", "…", { regionBadge, regionColor }, reqThreadId);
    emitWbChatSync();
    const controller = new AbortController();
    streamController = controller;
    setBusyState(true, "AI 正在回复…");
    let streamed = "";
    try {
      await api.chat(
        {
          message: text,
          session_id: reqSessionId,
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
            setThreadSessionId(state, reqThreadId, data.session_id, { maxTurns: 25 });
            if (reqThreadId === activeThreadId) {
              sessionId = data.session_id;
              onSessionChange?.(sessionId);
            }
            emitWbChatSync();
          } else if (event.event === "delta") {
            streamed += data.text || "";
            assistantMsg.text = streamed;
            if (reqThreadId === activeThreadId) renderChatMessages();
          } else if (event.event === "done") {
            if (typeof data.text === "string" && data.text) {
              streamed = data.text;
            }
            assistantMsg.text = streamed || "（无内容）";
            assistantMsg.applyText = streamed;
            assistantMsg.crest = "💬 REPLY";
            if (reqThreadId === activeThreadId) renderChatMessages();
            recordWorkbenchTurn({
              threadId: reqThreadId,
              userText: text,
              reply: streamed || "（无内容）",
              changed: false,
              regionIdx: regionItem ? regionIdx : -1,
              regionBadge,
              regionColor,
            });
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
        const { friendly, tech } = reportEditorError(err, "对话请求");
        assistantMsg.text = streamed ? `${streamed}\n\n---\n${friendly}` : friendly;
        assistantMsg.error = true;
        assistantMsg.errorDetail = tech || "";
        assistantMsg.crest = "⚠️ ALERT";
        assistantMsg.crestKind = "is-err";
        recordWorkbenchTurn({
          threadId: reqThreadId,
          userText: text,
          reply: assistantMsg.text,
          error: true,
          errorDetail: tech || "",
          changed: false,
          regionIdx: regionItem ? regionIdx : -1,
          regionBadge,
          regionColor,
        });
      }
      if (reqThreadId === activeThreadId) renderChatMessages();
    } finally {
      streamController = null;
      setBusyState(false);
    }
  }

  // Initial render
  renderBoxes();
  renderList();
  updateJsonPreview();
  renderWbThreadTabs();
  renderChatMessages();

  // ======================================================== MODAL LIFECYCLE
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    if (busyTimer) {
      clearInterval(busyTimer);
      busyTimer = null;
    }
    streamController?.abort();
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("keydown", onDeleteKey, true);
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
    if (currentMode === "danbooru") {
      danbooruText = String(capArea.value || "").trim();
    } else {
      captionText = String(capArea.value || "").trim();
    }
    const cleanCaption = captionText.trim();
    const cleanDanbooru = danbooruText.trim();
    ensureChatThreads(state, { maxTurns: 25 });
    const actWbThread = getActiveWbThread();
    const next = {
      ...state,
      caption: cleanCaption,
      caption_text: cleanCaption,
      danbooru_prompt: cleanDanbooru,
      danbooru_text: cleanDanbooru,
      tags: cleanDanbooru,
      modes: selectedModes,
      width,
      height,
      chat_threads: JSON.parse(JSON.stringify(state.chat_threads || [])),
      active_chat_id: state.active_chat_id || activeThreadId,
      chat_seq: state.chat_seq || 1,
      chat_log: state.chat_log,
      session_id: actWbThread?.session_id || sessionId || null,
      stage_boxes_visible: showBoxesOverlay,
    };
    if (state.mode || currentMode !== mode) {
      next.mode = currentMode;
    }
    if (currentImageUrl) {
      onImageChange?.(currentImageUrl);
    }
    if (next.session_id) {
      onSessionChange?.(next.session_id);
    }
    if (currentMode === "layout" || (draft.items && draft.items.length) || (state.draft?.items && state.draft.items.length)) {
      if (draft.summary) {
        draft.summary.caption = cleanCaption || draft.summary.caption || "";
      }
      const normDraft = normalizeDraft(draft, width, height);
      next.draft = normDraft;
      next.layout_draft = normDraft;
      next.hybrid_draft = {
        ...normDraft,
        summary: {
          ...(normDraft.summary || {}),
          caption: cleanCaption || normDraft.summary?.caption || "",
        },
      };
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

export const MODE_RULE_TABS = [
  ["caption", "散文规则 (Caption)", "caption_rules", "用于「散文」反推与改词；且「布局」反推时会先用散文反推打底再合并入框。"],
  ["layout", "布局规则 (Layout)", "layout_rules", "用于「布局」JSON 结构反推与分框改词（与散文/标签规则严格隔离）。"],
  ["danbooru", "Danbooru 规则 (Tags)", "danbooru_rules", "用于「Danbooru」逗号标签反推与改词，与散文/布局互不串台。"],
];

export const DEFAULT_MODE_RULE_TEXTS = {
  caption: [
    "1. Shot Framing & Subject: start with shot scale and camera angle (e.g. close-up, waist-up, full-body), subject appearance, facial features, eye gaze, and exact hairstyle.",
    "2. Attire, Objects & Actions: describe visible clothing layers, fabric textures, accessories, pose, and held objects faithfully.",
    "3. Spatial Grounding: anchor asymmetrical subjects, hands, and foreground/background elements using viewer's left / viewer's right.",
    "4. Objective Style Fidelity: describe visible lighting, color palette, and setting objectively without injecting extra photographic film/camera style assumptions—downstream LoRA controls rendering style.",
    "5. Clean Plain Output: quote exact visible text inside double quotes \"text\"; do NOT wrap in JSON and do NOT use (word:1.2) weights or markdown fences.",
  ].join("\n"),
  layout: [
    "1. Summary & Metadata: write a coherent global caption in summary.caption (reusing the prose description when supplied), plus canvas, meta tags, and color palette.",
    "2. Depth-Ordered Regions: list visible regions in items ordered from background (furthest) to foreground (nearest).",
    "3. Labels & Quoted Text: label must be character, object, or text; copy legible visible text verbatim inside text items' text field.",
    "4. Tight Decoupled Boxes: separate background, characters, outer/inner garment layers, and held props into tight visible boxes.",
    "5. Strict JSON Output: output a single valid JSON object only, without markdown code fences.",
  ].join("\n"),
  danbooru: [
    "1. Clean Tags Format: output one lowercase English line of comma-separated Danbooru tags, using underscores inside multi-word tags.",
    "2. Canonical Order: order by character count (e.g. 1girl, solo), distinctive features/hair/eyes, expression, layered clothing & accessories, pose/action, background/props, lighting/framing, medium.",
    "3. Objective LoRA-Friendly Fidelity: record only genuinely visible attributes without adding unprompted style bias.",
    "4. Text & Prohibitions: denote legible visible text cleanly; forbid narrative sentences, (word:1.2) weights, markdown, or numbering.",
  ].join("\n"),
};

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

  const themedEl = typeof document !== "undefined" ? document.querySelector?.("[data-theme]") : null;
  const isLight =
    document.body.classList.contains("light") ||
    document.body.classList.contains("comfy-theme-light") ||
    document.documentElement.dataset.theme === "light" ||
    themedEl?.dataset?.theme === "light";
  if (isLight) {
    overlay.dataset.theme = "light";
  }

  const modal = el("div", "aps-modal aps-settings-modal notranslate");
  modal.setAttribute("translate", "no");

  // Header
  const head = el("div", "aps-modal-head aps-wb-head");
  const titleWrap = el("div", "aps-wb-brand");
  titleWrap.append(
    el("span", "aps-logo", ""),
    el("div", "aps-modal-title", "设置"),
  );
  const closeTopBtn = el("button", "aps-btn aps-btn-sm", "✕ 关闭");
  closeTopBtn.type = "button";
  head.append(titleWrap, closeTopBtn);
  modal.append(head);

  // Tab Navigation Bar (3 Clean Partitions: Gateway & Keys | Model & Diagnostics | Prompt Rules & Preferences)
  const tabsBar = el("div", "aps-settings-tabs");
  const TABS = [
    { key: "gateway", icon: "🌐", label: "模型接口" },
    { key: "model", icon: "🤖", label: "模型体检" },
    { key: "rules", icon: "📐", label: "提示词规则" },
  ];
  let activeTabKey = "gateway";
  const tabBtns = {};

  const body = el("div", "aps-settings-body-tabbed");
  const panels = {};
  for (const t of TABS) {
    const p = el("div", `aps-settings-panel aps-panel-${t.key}`);
    p.hidden = t.key !== activeTabKey;
    panels[t.key] = p;
    body.append(p);
  }

  for (const t of TABS) {
    const b = el("button", `aps-settings-tab${t.key === activeTabKey ? " is-active" : ""}`);
    b.type = "button";
    b.append(el("span", "aps-settings-tab-icon", t.icon), el("span", "", t.label));
    b.addEventListener("click", () => {
      activeTabKey = t.key;
      for (const [k, btn] of Object.entries(tabBtns)) {
        btn.classList.toggle("is-active", k === activeTabKey);
      }
      for (const [k, pnl] of Object.entries(panels)) {
        pnl.hidden = k !== activeTabKey;
      }
    });
    tabBtns[t.key] = b;
    tabsBar.append(b);
  }
  modal.append(tabsBar, body);

  // =========================================================================
  // Panel 1: 🌐 接口与密钥 (Gateway & Keys)
  // =========================================================================
  const pGateway = panels.gateway;

  // 1. One flat form (address + key + model); saved gateways live in a compact
  //    dropdown so switching stays one click without cluttering the form.
  const gwCard = el("div", "aps-settings-card");
  const gwFormTitle = el("div", "aps-settings-card-title", "模型接口（OpenAI 兼容）");
  gwCard.append(gwFormTitle);

  const gwSwitchRow = el("div", "aps-gw-switch-row");
  const gwSwitchLabel = el("label", "aps-field-label", "已保存的网关");
  const gwSelect = el("select", "aps-select aps-gw-select");
  gwSelect.addEventListener("change", () => {
    const gw = gatewayCache.find((item) => item.id === gwSelect.value);
    if (gw) void selectGateway(gw);
  });
  const gwStoreBtn = el("button", "aps-chip-btn aps-btn-xs", "存为网关");
  gwStoreBtn.type = "button";
  gwStoreBtn.title = "把当前的地址 + 密钥 + 模型存成一条网关，以后从下拉框一键切回";
  gwStoreBtn.addEventListener("click", () => void saveCurrentAsGateway());
  gwSwitchRow.append(gwSwitchLabel, gwSelect, gwStoreBtn);
  gwCard.append(gwSwitchRow);

  const KNOWN_URL_ID = "aps-known-gateway-urls";
  const knownUrlList = el("datalist");
  knownUrlList.id = KNOWN_URL_ID;
  for (const [name, url] of [
    ["本地 Magpie", "http://127.0.0.1:3425/v1"],
    ["Ollama", "http://127.0.0.1:11434/v1"],
    ["vLLM", "http://127.0.0.1:8000/v1"],
    ["魔搭 ModelScope", "https://api-inference.modelscope.cn/v1"],
    ["DeepSeek 官方", "https://api.deepseek.com/v1"],
    ["OpenAI 官方", "https://api.openai.com/v1"],
    ["Gemini 官方", "https://generativelanguage.googleapis.com/v1beta/openai"],
  ]) {
    const opt = el("option");
    opt.value = url;
    opt.label = name;
    knownUrlList.append(opt);
  }

  const baseUrlWrap = el("div", "aps-field-group");
  baseUrlWrap.append(el("label", "aps-field-label", "接口地址"));
  const baseUrlInput = el("input", "aps-input");
  baseUrlInput.type = "url";
  baseUrlInput.placeholder = "https://你的网关地址/v1";
  baseUrlInput.setAttribute("list", KNOWN_URL_ID);
  baseUrlInput.autocomplete = "off";
  baseUrlWrap.append(baseUrlInput, knownUrlList);
  gwCard.append(baseUrlWrap);

  const gwKeyWrap = el("div", "aps-field-group");
  gwKeyWrap.append(el("label", "aps-field-label", "API Key"));
  const gwKeyRow = el("div", "aps-key-new-row");
  const gwKeyInput = el("input", "aps-input aps-key-new-secret is-masked");
  gwKeyInput.type = "text";
  gwKeyInput.placeholder = "留空 = 保持不变";
  gwKeyInput.setAttribute("autocomplete", "off");
  gwKeyInput.setAttribute("data-lpignore", "true");
  gwKeyInput.setAttribute("data-1p-ignore", "true");
  gwKeyInput.name = "aps-gateway-secret";
  const gwKeyToggle = el("button", "aps-chip-btn aps-btn-xs", "明文");
  gwKeyToggle.type = "button";
  gwKeyToggle.addEventListener("click", () => {
    const hidden = gwKeyInput.classList.contains("is-masked");
    gwKeyInput.classList.toggle("is-masked", !hidden);
    gwKeyToggle.textContent = hidden ? "隐藏" : "明文";
  });
  const gwKeyState = el("span", "aps-hint aps-gw-key-state", "");
  const clearKeyBtn = el("button", "aps-chip-btn aps-btn-xs", "清除");
  clearKeyBtn.type = "button";
  clearKeyBtn.title = "删除当前生效的 API Key（凭据管理器中的条目）";
  clearKeyBtn.addEventListener("click", () => void clearActiveKey());
  const gwKeyHint = el("div", "aps-hint", "Key 只保存在本机系统凭据中，界面永远拿不到明文。");
  gwKeyRow.append(gwKeyInput, gwKeyToggle, gwKeyState, clearKeyBtn);
  gwKeyWrap.append(gwKeyRow, gwKeyHint);
  gwCard.append(gwKeyWrap);

  const refreshModelsBtn = el("button", "aps-btn aps-btn-sm", "拉取模型列表");
  refreshModelsBtn.type = "button";
  refreshModelsBtn.title = "先应用当前地址，再从该网关读取模型列表";
  const testConnBtn = el("button", "aps-btn aps-btn-sm", "测试连接");
  testConnBtn.type = "button";
  testConnBtn.title = "应用当前地址与密钥，然后测试连通性、文本、视觉与流式能力";
  testConnBtn.addEventListener("click", () => {
    tabBtns.model.click();
    probeBtn.click();
  });
  const MODEL_LIST_ID = "aps-gateway-model-list";
  const modelList = el("datalist");
  modelList.id = MODEL_LIST_ID;
  const modelInput = el("input", "aps-input");
  modelInput.type = "text";
  modelInput.placeholder = "模型 ID，如 gemini-3.8-flash / qwen2.5vl:latest";
  modelInput.setAttribute("list", MODEL_LIST_ID);
  modelInput.autocomplete = "off";
  modelInput.setAttribute("data-lpignore", "true");
  modelInput.setAttribute("data-1p-ignore", "true");
  modelInput.name = "aps-model-id";
  const modelVisionMap = new Map();
  const modelChipsEl = el("div", "aps-model-chips");
  const modelWrap = el("div", "aps-field-group");
  const modelHeadRow = el("div", "aps-settings-row-between");
  const modelBtnGroup = el("div", "aps-gw-model-actions");
  modelBtnGroup.append(testConnBtn, refreshModelsBtn);
  modelHeadRow.append(el("label", "aps-field-label", "主模型"), modelBtnGroup);
  modelWrap.append(modelHeadRow, modelInput, modelList);
  gwCard.append(modelWrap);

  // 2. API Key Management Card
  const keyCard = el("div", "aps-settings-card");
  const keyHeadRow = el("div", "aps-settings-row-between");
  keyHeadRow.append(el("div", "aps-settings-card-title", "API 密钥（API Key）"));
  const keyRefreshBtn = el("button", "aps-chip-btn aps-btn-xs", "刷新列表");
  keyRefreshBtn.type = "button";
  keyRefreshBtn.title = "重新读取已保存的密钥";
  keyHeadRow.append(keyRefreshBtn);

  const keyListEl = el("div", "aps-key-list");

  const newKeyRow = el("div", "aps-key-new-row");
  const newKeyInput = el("input", "aps-input aps-key-new-secret");
  newKeyInput.type = "text";
  newKeyInput.classList.add("is-masked");
  newKeyInput.setAttribute("autocomplete", "off");
  newKeyInput.setAttribute("data-lpignore", "true");
  newKeyInput.setAttribute("data-1p-ignore", "true");
  newKeyInput.setAttribute("data-bwignore", "true");
  newKeyInput.name = "aps-api-secret";
  newKeyInput.placeholder = "粘贴 API Key（保存设置时自动生效）";

  const newKeyLabelInput = el("input", "aps-input aps-key-new-label");
  newKeyLabelInput.type = "text";
  newKeyLabelInput.placeholder = "备注名（可选）";
  newKeyLabelInput.setAttribute("autocomplete", "off");
  newKeyLabelInput.setAttribute("data-lpignore", "true");
  newKeyLabelInput.setAttribute("data-1p-ignore", "true");
  newKeyLabelInput.name = "aps-key-note";

  const toggleKeyBtn = el("button", "aps-chip-btn aps-btn-xs", "明文");
  toggleKeyBtn.type = "button";
  toggleKeyBtn.title = "显示 / 隐藏密钥";
  const addKeyBtn = el("button", "aps-btn aps-btn-sm aps-primary", "保存密钥");
  addKeyBtn.type = "button";
  addKeyBtn.title = "立即保存到系统凭据管理器并激活";

  toggleKeyBtn.addEventListener("click", () => {
    const hidden = newKeyInput.classList.contains("is-masked");
    newKeyInput.classList.toggle("is-masked", !hidden);
    toggleKeyBtn.textContent = hidden ? "隐藏" : "明文";
  });
  newKeyRow.append(newKeyInput, newKeyLabelInput, toggleKeyBtn, addKeyBtn);
  addKeyBtn.addEventListener("click", () => void addKeyFromInputs());
  newKeyInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      void addKeyFromInputs();
    }
  });

  const keyStateHint = el("div", "aps-hint", "密钥安全存入系统凭据管理器，界面只显示掩码。");

  let currentActiveKeyId = "";

  function renderKeys(keys, activeId) {
    keyListEl.textContent = "";
    const list = Array.isArray(keys) ? keys : [];
    const activeKey = list.find((k) => k.active || k.id === activeId);
    currentActiveKeyId = activeKey ? String(activeKey.id || "") : String(activeId || "");
    gwKeyState.textContent = activeKey
      ? `已保存：${activeKey.label || activeKey.id || "密钥"} (${activeKey.masked || "••••"})`
      : "";
    clearKeyBtn.disabled = !activeKey;
    keyStateHint.textContent = list.length
      ? `已存 ${list.length} 条密钥 · 当前生效：${activeKey ? `${activeKey.label || activeKey.id} (${activeKey.masked || "已掩码"})` : "未选择"}`
      : "尚未保存密钥 —— 请在上方粘贴后点击「保存密钥」（或直接点击底部「保存设置并生效」自动存入）。";
    if (!list.length) {
      keyListEl.append(
        el("div", "aps-key-empty", "暂无保存的密钥。如网关需要鉴权，请在上方填入密钥。"),
      );
      return;
    }
    for (const key of list) {
      const isActive = Boolean(key.active) || key.id === activeId;
      const row = el("div", isActive ? "aps-key-row is-active" : "aps-key-row");
      row.append(el("span", "aps-key-dot", isActive ? "●" : "○"));
      row.append(el("span", "aps-key-name", String(key.label || key.id || "密钥")));
      row.append(el("span", "aps-key-mask", String(key.masked || "（明文存储）")));

      const useBtn = el("button", "aps-chip-btn aps-btn-xs", isActive ? "使用中" : "使用这条");
      useBtn.type = "button";
      useBtn.disabled = isActive;
      useBtn.addEventListener("click", () => void useKey(key.id));
      row.append(useBtn);

      const delBtn = el("button", "aps-chip-btn aps-btn-xs aps-key-del", "🗑");
      delBtn.type = "button";
      delBtn.title = "从凭据管理器删除这条密钥";
      let armed = false;
      let timer = null;
      delBtn.addEventListener("click", () => {
        if (!armed) {
          armed = true;
          delBtn.textContent = "确认删除?";
          delBtn.classList.add("is-accent");
          timer = setTimeout(() => {
            armed = false;
            delBtn.textContent = "🗑";
            delBtn.classList.remove("is-accent");
          }, 3000);
          return;
        }
        clearTimeout(timer);
        void removeKey(key.id);
      });
      row.append(delBtn);

      keyListEl.append(row);
    }
  }

  async function refreshKeys({ silent = false } = {}) {
    keyRefreshBtn.disabled = true;
    try {
      const res = await api.listKeys();
      renderKeys(res?.keys || [], res?.active_key_id || "");
      if (!silent) {
        const n = (res?.keys || []).length;
        setStatus(`已读取 ${n} 条密钥（当前生效：${res?.active_key_id || "—"}）。`);
      }
    } catch (err) {
      if (!silent) reportModalError(err, "读取密钥列表");
    } finally {
      keyRefreshBtn.disabled = false;
    }
  }

  async function addKeyFromInputs() {
    const secret = newKeyInput.value.trim();
    if (!secret) {
      setStatus("请先粘贴一条 API Key 再点「保存密钥」。", true);
      newKeyInput.focus();
      return;
    }
    addKeyBtn.disabled = true;
    setStatus("正在写入系统凭据保险箱…");
    try {
      const res = await api.addKey({
        api_key: secret,
        label: newKeyLabelInput.value.trim(),
        activate: true,
      });
      newKeyInput.value = "";
      newKeyLabelInput.value = "";
      newKeyInput.classList.add("is-masked");
      toggleKeyBtn.textContent = "明文";
      renderKeys(res?.keys || [], res?.active_key_id || "");
      void refreshGateways({ silent: true });
      setStatus(`已新建并切换为当前生效密钥（${res?.api_key_masked || "已保存"}）。`);
    } catch (err) {
      reportModalError(err, "新建密钥");
    } finally {
      addKeyBtn.disabled = false;
    }
  }

  async function useKey(keyId) {
    if (!keyId) return;
    setStatus("正在切换生效密钥…");
    try {
      const res = await api.activateKey(keyId);
      renderKeys(res?.keys || [], res?.active_key_id || "");
      void refreshGateways({ silent: true });
      setStatus(`已切换生效密钥（${res?.api_key_masked || keyId}）。`);
    } catch (err) {
      reportModalError(err, "切换密钥");
    }
  }

  async function removeKey(keyId) {
    setStatus("正在删除密钥…");
    try {
      const res = await api.deleteKey(keyId);
      renderKeys(res?.keys || [], res?.active_key_id || "");
      void refreshGateways({ silent: true });
      setStatus(`已删除该密钥（剩余 ${(res?.keys || []).length} 条）。`);
    } catch (err) {
      reportModalError(err, "删除密钥");
    }
  }

  keyRefreshBtn.addEventListener("click", () => void refreshKeys());

  keyCard.append(keyHeadRow, newKeyRow, keyStateHint, keyListEl);

  // 3. Saved-gateway dropdown + flat form save logic.
  let gatewayCache = [];
  let currentActiveGatewayId = "";
  let gatewayModelIds = [];

  function gatewayLabel(gw) {
    return String(gw?.label || gw?.base_url || "网关");
  }

  function renderModelChips(ids) {
    gatewayModelIds = Array.isArray(ids) ? ids : [];
  }

  function setGatewayForm(profile, { fallbackConfig = null } = {}) {
    const cfg = fallbackConfig || {};
    baseUrlInput.value = profile?.base_url || cfg.base_url || "";
    modelInput.value = profile?.model || cfg.model || "";
    gwKeyInput.value = "";
    gwKeyInput.classList.add("is-masked");
    gwKeyToggle.textContent = "明文";
    if (profile?.key_missing) {
      gwKeyInput.placeholder = "绑定的密钥已丢失，请重新粘贴一条";
    } else {
      gwKeyInput.placeholder = "留空 = 保持不变";
    }
    updateHeroModel(modelNodeValue() || modelInput.value.trim(), null, modelNodeValue());
  }

  function renderGatewaySelect(list, activeId) {
    gatewayCache = Array.isArray(list) ? list : [];
    currentActiveGatewayId = String(activeId || "");
    gwSelect.textContent = "";
    if (!gatewayCache.length) {
      const empty = el("option", "", "（尚未保存网关）");
      empty.value = "";
      gwSelect.append(empty);
    }
    for (const gw of gatewayCache) {
      const opt = el("option", "", gatewayLabel(gw));
      opt.value = gw.id;
      opt.title = `${gw.base_url || ""}\n${gw.model || ""}`;
      gwSelect.append(opt);
    }
    if (!currentActiveGatewayId && gatewayCache.length) {
      const manual = el("option", "", "当前手动配置");
      manual.value = "";
      gwSelect.append(manual);
    }
    gwSelect.value = currentActiveGatewayId;
  }

  function applyGatewayResult(res) {
    const cfg = res?.config || {};
    if (cfg.base_url != null) baseUrlInput.value = cfg.base_url;
    if (cfg.model != null) modelInput.value = cfg.model;
    renderKeys(res?.keys || cfg.api_keys || [], res?.active_key_id || cfg.active_key_id || "");
    updateHeroModel(modelNodeValue() || modelInput.value.trim(), null, modelNodeValue());
    onSaved?.(cfg, null);
  }

  async function selectGateway(gw) {
    if (!gw?.id || gw.id === currentActiveGatewayId) return;
    setStatus(`正在切换到「${gatewayLabel(gw)}」…`);
    try {
      const res = await api.activateGateway(gw.id);
      applyGatewayResult(res);
      setGatewayForm(res?.gateway || gw);
      renderGatewaySelect(res?.gateways || [], res?.active_gateway_id || gw.id);
      setStatus(`已切换到「${gatewayLabel(gw)}」（立即生效）。`);
    } catch (err) {
      gwSelect.value = currentActiveGatewayId;
      reportModalError(err, "切换网关");
    }
  }

  async function saveCurrentAsGateway() {
    const base = baseUrlInput.value.trim();
    const model = modelInput.value.trim();
    if (!base) {
      setStatus("请先填写接口地址。", true);
      baseUrlInput.focus();
      return;
    }
    if (!model) {
      setStatus("请先填写主模型。", true);
      modelInput.focus();
      return;
    }
    gwStoreBtn.disabled = true;
    setStatus("正在保存网关…");
    try {
      let keyId = currentActiveKeyId;
      const secret = gwKeyInput.value.trim();
      if (secret) {
        const keyRes = await api.addKey({ api_key: secret, label: "网关密钥", activate: true });
        keyId = keyRes?.active_key_id || keyId;
        renderKeys(keyRes?.keys || [], keyId);
        gwKeyInput.value = "";
        gwKeyInput.classList.add("is-masked");
        gwKeyToggle.textContent = "明文";
      }
      const res = await api.saveGateway({ base_url: base, model, key_id: keyId, activate: true });
      renderGatewaySelect(res?.gateways || [], res?.active_gateway_id || res?.gateway?.id || "");
      applyGatewayResult(res);
      setStatus(`✓ 已存为网关「${gatewayLabel(res?.gateway)}」。`);
    } catch (err) {
      reportModalError(err, "保存网关");
    } finally {
      gwStoreBtn.disabled = false;
    }
  }

  async function refreshGateways({ silent = false } = {}) {
    try {
      const res = await api.listGateways();
      renderGatewaySelect(res?.gateways || [], res?.active_gateway_id || "");
      if (!silent) setStatus(`已读取 ${(res?.gateways || []).length} 条网关配置。`);
    } catch (err) {
      if (!silent) reportModalError(err, "读取网关列表");
    }
  }

  async function clearActiveKey() {
    if (!currentActiveKeyId) {
      setStatus("当前没有已保存的 API Key。", true);
      return;
    }
    setStatus("正在清除 API Key…");
    try {
      const res = await api.deleteKey(currentActiveKeyId);
      renderKeys(res?.keys || [], res?.active_key_id || "");
      setStatus("已清除该 API Key。");
    } catch (err) {
      reportModalError(err, "清除密钥");
    }
  }

  gwKeyInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      void saveCurrentAsGateway();
    }
  });

  // 4. Advanced (collapsed): key list, timeouts, delete gateway.
  const advNetCard = el("div", "aps-settings-card");
  const advancedBox = el("details", "aps-adv");
  advancedBox.append(el("summary", "", "高级设置：密钥列表 / 超时与重试 / 删除网关"));

  const numRow = el("div", "aps-settings-grid-2");
  const timeoutWrap = el("div", "aps-field-group");
  timeoutWrap.append(el("label", "aps-field-label", "请求超时（秒，10~300）"));
  const timeoutInput = el("input", "aps-input");
  timeoutInput.type = "number";
  timeoutInput.min = "10";
  timeoutInput.max = "300";
  timeoutInput.value = "120";
  timeoutWrap.append(timeoutInput);

  const retriesWrap = el("div", "aps-field-group");
  retriesWrap.append(el("label", "aps-field-label", "失败重试次数（0~3）"));
  const retriesInput = el("input", "aps-input");
  retriesInput.type = "number";
  retriesInput.min = "0";
  retriesInput.max = "3";
  retriesInput.value = "2";
  retriesWrap.append(retriesInput);
  numRow.append(timeoutWrap, retriesWrap);

  const delGwRow = el("div", "aps-settings-row-between");
  const delGwBtn = el("button", "aps-btn aps-btn-sm", "删除当前网关");
  delGwBtn.type = "button";
  delGwBtn.title = "只删除网关配置，已保存的密钥仍留在凭据库中";
  let delGwArmed = false;
  let delGwTimer = null;
  delGwBtn.addEventListener("click", () => {
    if (!currentActiveGatewayId) {
      setStatus("当前没有选中的网关。", true);
      return;
    }
    if (!delGwArmed) {
      delGwArmed = true;
      delGwBtn.textContent = "确认删除?";
      delGwBtn.classList.add("is-accent");
      delGwTimer = setTimeout(() => {
        delGwArmed = false;
        delGwBtn.textContent = "删除当前网关";
        delGwBtn.classList.remove("is-accent");
      }, 3000);
      return;
    }
    clearTimeout(delGwTimer);
    void deleteCurrentGateway();
  });
  const delGwHint = el("span", "aps-hint", "删除后地址/模型配置消失，密钥本身保留。");
  delGwRow.append(delGwBtn, delGwHint);

  advancedBox.append(keyCard, numRow, delGwRow);
  advNetCard.append(advancedBox);

  pGateway.append(gwCard, advNetCard);

  async function deleteCurrentGateway() {
    if (!currentActiveGatewayId) return;
    setStatus("正在删除网关…");
    try {
      const res = await api.deleteGateway(currentActiveGatewayId);
      renderGatewaySelect(res?.gateways || [], res?.active_gateway_id || "");
      setStatus("已删除该网关（密钥本身保留）。");
    } catch (err) {
      reportModalError(err, "删除网关");
    }
  }

  // =========================================================================
  // Panel 2: 🤖 模型与体检 (Model & Diagnostics)
  // =========================================================================
  const pModel = panels.model;

  // 1. Active Model Hero Card
  const heroCard = el("div", "aps-hero-model-card");
  const heroLabel = el("div", "aps-hero-model-label", "当前生效模型");
  const heroName = el("div", "aps-hero-model-name", "—");
  const heroBadges = el("div", "aps-hero-model-badges");
  heroCard.append(heroLabel, heroName, heroBadges);

  // 2. Node-level model override (the global model lives in the gateway form).
  let nodeModelInput = null;
  function modelNodeValue() {
    return String((nodeModelInput && nodeModelInput.value) || "").trim();
  }

  function heroSource(nodeModel) {
    if (String(nodeModel || "").trim()) return "节点覆盖";
    return modelInput.value.trim() ? "全局" : "网关默认";
  }

  function updateHeroModel(name, hasVision = null, nodeModel = "") {
    const source = heroSource(nodeModel);
    const known = modelVisionMap.has(String(name || "").trim())
      ? modelVisionMap.get(String(name || "").trim())
      : hasVision;
    heroName.textContent = name || "未指定模型（将由网关默认配置处理）";
    heroBadges.textContent = "";
    heroBadges.append(el("span", "aps-badge", `来源：${source}`));
    if (name) {
      if (known === true) {
        heroBadges.append(el("span", "aps-badge ok", "支持多模态视觉 (Vision)"));
      } else if (known === false) {
        heroBadges.append(el("span", "aps-badge fail", "⚠️ 仅文本模型 (Text Only)"));
      }
    }
    if (nodeModel) {
      heroBadges.append(
        el("span", "aps-badge", `全局值：${modelInput.value.trim() || "未填"}（被节点覆盖）`),
      );
    }
  }

  modelInput.addEventListener("input", () => {
    updateHeroModel(modelNodeValue() || modelInput.value.trim(), null, modelNodeValue());
  });

  let nodeModelCard = null;
  if (nodeOverrides && typeof nodeOverrides === "object") {
    nodeModelCard = el("div", "aps-settings-card aps-settings-node-sec");
    nodeModelCard.append(
      el("div", "aps-settings-card-title", "当前节点覆盖模型（只对这个节点生效）"),
      el("div", "aps-hint", "留空 = 使用网关里的默认模型。覆盖后上方看板会标明「来源：节点覆盖」。"),
    );
    nodeModelInput = el("input", "aps-input");
    nodeModelInput.type = "text";
    nodeModelInput.placeholder = "留空使用网关默认模型";
    nodeModelInput.value = String(nodeOverrides.model || "");
    nodeModelInput.addEventListener("input", () => {
      const v = modelNodeValue();
      updateHeroModel(v || modelInput.value.trim(), null, v);
    });
    nodeModelCard.append(nodeModelInput);
  }

  // 3. Capability Diagnostics & Speed Test Card
  const capCard = el("div", "aps-settings-card");
  const capHeadRow = el("div", "aps-settings-row-between");
  const capTitleWrap = el("div", "aps-cap-title-wrap");
  capTitleWrap.append(el("div", "aps-settings-card-title", "模型体检与测速"));

  const capMetaWrap = el("div", "aps-cap-meta-wrap");
  const testedModelLabel = el("span", "aps-cap-checked-time", "");
  const checkedAtLabel = el("span", "aps-cap-checked-time", "尚未测试");
  const probeBtn = el("button", "aps-btn aps-primary aps-btn-sm", "测试当前模型");
  probeBtn.type = "button";
  capMetaWrap.append(testedModelLabel, checkedAtLabel, probeBtn);
  capHeadRow.append(capTitleWrap, capMetaWrap);

  const probeError = el("div", "aps-probe-error");
  probeError.hidden = true;

  const capGrid = el("div", "aps-cap-grid");

  function makeCapCard(icon, title, desc) {
    const card = el("div", "aps-cap-card");
    const top = el("div", "aps-cap-card-top");
    const ic = el("span", "aps-cap-card-icon", icon);
    const ttl = el("span", "aps-cap-card-title", title);
    const badge = el("span", "aps-badge", "· 待检测");
    top.append(ic, ttl, badge);

    const lat = el("div", "aps-cap-card-latency", "—");
    const dsc = el("div", "aps-cap-card-desc", desc);
    card.append(top, lat, dsc);
    return { card, badge, lat, dsc };
  }

  const cPing = makeCapCard("🌐", "网关连接", "验证 Base URL 接口连通性与 API Key 有效性");
  const cText = makeCapCard("💬", "文本生成", "单字极速推理与提示词扩写基底能力");
  const cVision = makeCapCard("🖼️", "多模态视觉", "双盲图像识别测试，确保图片反推与画框空间识图正常");
  const cStream = makeCapCard("⚡", "流式输出 (SSE)", "增量分块推流，用于 AI 对话改词的打字机反馈");

  capGrid.append(cPing.card, cText.card, cVision.card, cStream.card);

  const adviceBox = el("div", "aps-cap-advice-box");
  adviceBox.hidden = true;

  capCard.append(capHeadRow, probeError, capGrid, adviceBox);

  function renderFullCapabilities(report) {
    if (!report) return;
    probeError.hidden = true;
    probeError.textContent = "";
    checkedAtLabel.textContent = report.checked_at ? `最后检测时间：${report.checked_at}` : "已完成测速";
    const nodeM = modelNodeValue();
    testedModelLabel.textContent = `本次体检模型：${report.model || "未设置"}` +
      (nodeM && nodeM !== report.model ? `（节点覆盖 ${nodeM} 未参与体检）` : "");

    // 1. Ping / Base
    cPing.badge.className = "aps-badge ok";
    cPing.badge.textContent = "✓ 连通正常";
    cPing.lat.textContent = report.base_url || "已连接";

    // 2. Text
    if (report.text === true) {
      cText.badge.className = "aps-badge ok";
      cText.badge.textContent = "✓ 正常支持";
      const lms = report.details?.text?.latency_ms;
      cText.lat.textContent = lms ? `测速耗时: ${Math.round(lms)} ms` : "响应正常";
    } else if (report.text === false) {
      cText.badge.className = "aps-badge fail";
      cText.badge.textContent = "✗ 响应失败";
      cText.lat.textContent = report.details?.text?.error || "错误";
    }

    // 3. Vision
    if (report.vision === true) {
      cVision.badge.className = "aps-badge ok";
      cVision.badge.textContent = "✓ 支持多模态";
      const trials = report.details?.vision?.passed ?? 2;
      cVision.lat.textContent = `双盲图像检测通过 (${trials}/2)`;
    } else if (report.vision === false) {
      cVision.badge.className = "aps-badge fail";
      cVision.badge.textContent = "✗ 不支持视觉";
      cVision.lat.textContent = "未能识别测试图片色彩";
    } else {
      cVision.badge.className = "aps-badge";
      cVision.badge.textContent = "· 未检测";
      cVision.lat.textContent = "—";
    }

    // 4. Streaming
    if (report.streaming === true) {
      cStream.badge.className = "aps-badge ok";
      cStream.badge.textContent = "✓ 支持流式";
      const d = report.details?.streaming?.deltas;
      cStream.lat.textContent = d ? `分块数: ${d} | 首包正常` : "增量推流正常";
    } else if (report.streaming === false) {
      cStream.badge.className = "aps-badge fail";
      cStream.badge.textContent = "✗ 不支持流式";
      cStream.lat.textContent = "仅支持一次性全量输出";
    }

    // Advice Box
    adviceBox.hidden = false;
    adviceBox.textContent = "";
    if (report.vision === false) {
      adviceBox.className = "aps-cap-advice-box is-warning";
      adviceBox.append(
        el("strong", "", "⚠️ 视觉能力提醒："),
        document.createTextNode(
          "当前模型未能通过图像视觉测试。若要反推图片或使用画框识图，请在上方切换为支持多模态视觉的模型（如 qwen-vl、gemini-flash、gpt-4o 等）。仅生成与编辑纯文本提示词则不受影响。",
        ),
      );
    } else if (report.text === false) {
      adviceBox.className = "aps-cap-advice-box is-error";
      adviceBox.append(
        el("strong", "", "❌ 网关调用异常："),
        document.createTextNode(
          `模型 ${report.model || "（未设置）"} 无法生成文本，请检查 Base URL 与 API Key 是否填写正确。错误原因：${report.details?.text?.message || report.details?.text?.error || "未知异常"}`,
        ),
      );
    } else {
      adviceBox.className = "aps-cap-advice-box is-ok";
      adviceBox.append(
        el("strong", "", "✅ 诊断就绪："),
        document.createTextNode("该模型具备完善的文本与多模态视觉处理能力，可完美支撑反推、画框定位、空间理解及多轮改词。"),
      );
    }
  }

  pModel.append(heroCard, ...(nodeModelCard ? [nodeModelCard] : []), capCard);

  // =========================================================================
  // Panel 3: 📐 提示词规则偏好 (Prompt Rules & Preferences)
  // =========================================================================
  const pRules = panels.rules;
  const rulesHead = el("div", "aps-settings-section-head");
  rulesHead.append(
    el("h4", "aps-settings-section-title", "三模式独立规则与生成偏好"),
    el(
      "p",
      "aps-settings-section-desc",
      "散文 (Caption)、布局 (Layout)、Danbooru (Booru Tags) 各自独立生效；默认规则保持客观描述，风格交由下游 LoRA 控制。",
    ),
  );
  pRules.append(rulesHead);

  const rulesCard = el("div", "aps-settings-card");

  let defaultModeRules = { ...DEFAULT_MODE_RULE_TEXTS };
  const modeRuleBuffers = {
    caption: DEFAULT_MODE_RULE_TEXTS.caption,
    layout: DEFAULT_MODE_RULE_TEXTS.layout,
    danbooru: DEFAULT_MODE_RULE_TEXTS.danbooru,
  };
  let activeRuleTab = "caption";

  const modeTabsRow = el("div", "aps-mode-rule-tabs");
  const modeTabBtns = {};
  for (const [mKey, mLabel] of MODE_RULE_TABS) {
    const btn = el("button", `aps-mode-rule-tab${mKey === activeRuleTab ? " is-active" : ""}`, mLabel);
    btn.type = "button";
    btn.addEventListener("click", () => {
      modeRuleBuffers[activeRuleTab] = customRulesArea.value;
      activeRuleTab = mKey;
      syncRuleTabUi();
    });
    modeTabBtns[mKey] = btn;
    modeTabsRow.append(btn);
  }

  const resetModeBtn = el("button", "aps-chip-btn aps-btn-xs", "↺ 恢复当前模式默认");
  resetModeBtn.type = "button";
  resetModeBtn.title = "将当前模式规则重置为客观 LoRA 友好默认规则";

  const tabMetaRow = el("div", "aps-settings-row-between");
  const presetHint = el("div", "aps-preset-hint", MODE_RULE_TABS[0][3]);
  tabMetaRow.append(presetHint, resetModeBtn);

  const customRulesLabel = el("label", "aps-field-label", "当前模式规则内容（反推与对应模式 AI 改词时生效）");
  const customRulesArea = el("textarea", "aps-textarea aps-settings-rules-area");
  customRulesArea.rows = 4;
  customRulesArea.placeholder = "在此编辑当前模式的专属提示词规则（留空则按默认规则执行）…";
  customRulesArea.value = modeRuleBuffers[activeRuleTab];
  customRulesArea.addEventListener("input", () => {
    modeRuleBuffers[activeRuleTab] = customRulesArea.value;
  });

  function syncRuleTabUi() {
    const meta = MODE_RULE_TABS.find(([k]) => k === activeRuleTab) || MODE_RULE_TABS[0];
    for (const [k, btn] of Object.entries(modeTabBtns)) {
      btn.classList.toggle("is-active", k === activeRuleTab);
    }
    presetHint.textContent = meta[3];
    customRulesLabel.textContent = `${meta[1]}（仅对「${meta[1].replace(/^.+?\s/, "")}」生效）`;
    customRulesArea.value = modeRuleBuffers[activeRuleTab] ?? "";
  }

  resetModeBtn.addEventListener("click", () => {
    const defText = defaultModeRules[activeRuleTab] || DEFAULT_MODE_RULE_TEXTS[activeRuleTab] || "";
    modeRuleBuffers[activeRuleTab] = defText;
    customRulesArea.value = defText;
    setStatus(`✓ 已恢复「${activeRuleTab}」默认规则。`);
  });

  rulesCard.append(modeTabsRow, tabMetaRow, customRulesLabel, customRulesArea);

  // Generation options card
  const genPrefCard = el("div", "aps-settings-card");
  genPrefCard.append(el("div", "aps-settings-card-title", "生成偏好与布局参数"));

  const langAndRegionsRow = el("div", "aps-settings-grid-2");
  const langWrap = el("div", "aps-field-group");
  langWrap.append(el("label", "aps-field-label", "输出语言偏好"));
  const langSelect = el("select", "aps-select");
  for (const [val, label] of OUTPUT_LANGUAGE_OPTIONS) {
    const opt = el("option", "", label);
    opt.value = val;
    langSelect.append(opt);
  }
  langWrap.append(langSelect);

  const maxRegWrap = el("div", "aps-field-group");
  maxRegWrap.append(el("label", "aps-field-label", "布局最大区域数（1~16）"));
  const maxRegInput = el("input", "aps-input");
  maxRegInput.type = "number";
  maxRegInput.min = "1";
  maxRegInput.max = "16";
  maxRegInput.value = "10";
  maxRegWrap.append(maxRegInput);
  langAndRegionsRow.append(langWrap, maxRegWrap);

  const userCustomWrap = el("div", "aps-settings-user-custom-wrap");
  const userCustomLabel = el(
    "label",
    "aps-field-label aps-highlight-label",
    "★ 共享附加要求（可选 · 追加到以上 3 个模式末尾）",
  );
  const userCustomArea = el("textarea", "aps-textarea aps-settings-user-custom-area");
  userCustomArea.rows = 2;
  userCustomArea.placeholder = "例如：保留画面中所有可见文字；背景保持简洁…";
  userCustomWrap.append(userCustomLabel, userCustomArea);

  genPrefCard.append(langAndRegionsRow, userCustomWrap);

  let nodeExtraInput = null;
  if (nodeOverrides && typeof nodeOverrides === "object") {
    const nodeExtraSec = el("div", "aps-settings-card aps-settings-node-sec");
    nodeExtraSec.append(el("div", "aps-settings-card-title", "当前节点专属补充要求（随工作流保存）"));
    const neLabel = el("label", "aps-field-label", "补充要求（extra_instruction）");
    nodeExtraInput = el("input", "aps-input");
    nodeExtraInput.type = "text";
    nodeExtraInput.placeholder = "仅对本节点生效的补充要求，例如：强调赛博朋克霓虹反光";
    nodeExtraInput.value = String(nodeOverrides.extra_instruction || "");
    nodeExtraSec.append(neLabel, nodeExtraInput);
    pRules.append(rulesCard, genPrefCard, nodeExtraSec);
  } else {
    pRules.append(rulesCard, genPrefCard);
  }

  // =========================================================================
  // Footer & Logic
  // =========================================================================
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

  function setStatus(msg, isError = false, titleText = "") {
    const txt = msg || "";
    statusEl.textContent = txt;
    statusEl.title = titleText || txt;
    statusEl.className = isError ? "aps-modal-status aps-error-text" : "aps-modal-status";
    statusEl.dataset.kind = isError ? "error" : "ok";
  }

  function reportModalError(err, actionName, suffix = "") {
    const friendly = formatFriendlyError(err, actionName);
    const tech = formatErrorTechnicalDetail(err);
    const tip = tech ? `${friendly}\n\n${tech}` : friendly;
    setStatus(`${friendly}${suffix}`, true, tip);
  }

  /**
 * Persist the address/model currently typed in the form before any request that
 * runs on the backend.  Otherwise "拉取模型列表 / 测试当前模型" would silently
 * query the *previous* gateway until the user remembers to press 保存.
 */
  async function applyGatewayForm() {
    const base = baseUrlInput.value.trim();
    const model = modelInput.value.trim();
    if (!base) throw new Error("请先填写接口地址。");
    if (!model) throw new Error("请先填写主模型。");
    const secret = gwKeyInput.value.trim();
    if (secret) {
      const keyRes = await api.addKey({ api_key: secret, label: "网关密钥", activate: true });
      renderKeys(keyRes?.keys || [], keyRes?.active_key_id || "");
      gwKeyInput.value = "";
      gwKeyInput.classList.add("is-masked");
      gwKeyToggle.textContent = "明文";
    }
    const saved = await api.saveConfig({ base_url: base, model });
    const cfg = saved?.config || {};
    if (cfg.base_url) {
      baseUrlInput.value = cfg.base_url;
    }
    renderKeys(cfg.api_keys || [], cfg.active_key_id || "");
    void refreshGateways({ silent: true });
    return cfg;
  }

  async function fetchModelList() {
    refreshModelsBtn.disabled = true;
    refreshModelsBtn.textContent = "⏳ 正在获取…";
    try {
      await applyGatewayForm();
      const res = await api.listModels();
      const list = Array.isArray(res?.models) ? res.models : [];
      modelList.textContent = "";
      modelVisionMap.clear();
      const ids = [];
      for (const item of list) {
        const id = String(item.id || "").trim();
        if (!id) continue;
        const hasVision = Array.isArray(item.modalities?.input) && item.modalities.input.includes("image");
        const opt = el("option");
        opt.value = id;
        opt.label = hasVision ? `${id}（支持视觉）` : id;
        modelVisionMap.set(id, hasVision);
        modelList.append(opt);
        ids.push(id);
      }
      renderModelChips(ids, modelInput.value.trim());
      updateHeroModel(modelNodeValue() || modelInput.value.trim(), null, modelNodeValue());
      setStatus(
        list.length
          ? `已从网关加载 ${list.length} 个模型，点输入框即可联想选择。`
          : "网关未返回模型列表，直接手填模型名即可。",
      );
    } catch (err) {
      reportModalError(err, "获取模型列表", "（可直接在输入框手填模型名）");
    } finally {
      refreshModelsBtn.disabled = false;
      refreshModelsBtn.textContent = "拉取模型列表";
    }
  }

  refreshModelsBtn.addEventListener("click", () => void fetchModelList());

  probeBtn.addEventListener("click", async () => {
    probeBtn.disabled = true;
    probeBtn.textContent = "正在测试…";
    probeError.hidden = true;
    probeError.textContent = "";
    adviceBox.hidden = true;
    for (const c of [cPing, cText, cVision, cStream]) {
      c.badge.className = "aps-badge";
      c.badge.textContent = "… 检测中";
      c.lat.textContent = "…";
    }
    testedModelLabel.textContent = `正在测试：${modelNodeValue() || modelInput.value.trim() || "网关默认模型"}`;
    setStatus("正在应用当前地址并测试模型（连通 / 文本 / 视觉 / 流式），可能需要十几秒…");
    try {
      await applyGatewayForm();
      const rep = await api.probe({ force: true });
      renderFullCapabilities(rep);
      setStatus("✓ 测试完成。");
    } catch (err) {
      const msg = (err && (err.message || err.error || String(err))) || "未知错误";
      probeError.hidden = false;
      probeError.textContent = `测试失败：${msg}`;
      testedModelLabel.textContent = "";
      for (const c of [cPing, cText, cVision, cStream]) {
        c.badge.className = "aps-badge fail";
        c.badge.textContent = "✗ 未通过";
        c.lat.textContent = "—";
      }
      setStatus(`测试失败：${msg}`, true);
    } finally {
      probeBtn.disabled = false;
      probeBtn.textContent = "测试当前模型";
    }
  });

  // Load current status on open
  void (async () => {
    try {
      const st = await api.status();
      const cfg = st?.config || {};
      setGatewayForm(null, { fallbackConfig: cfg });
      if (Array.isArray(cfg.api_keys) && cfg.api_keys.length) {
        renderKeys(cfg.api_keys, cfg.active_key_id || "");
      } else {
        renderKeys([], "");
      }
      await refreshGateways();
      if (cfg.timeout_s != null) timeoutInput.value = String(cfg.timeout_s);
      if (cfg.max_retries != null) retriesInput.value = String(cfg.max_retries);
      if (cfg.default_mode_rules && typeof cfg.default_mode_rules === "object") {
        defaultModeRules = { ...DEFAULT_MODE_RULE_TEXTS, ...cfg.default_mode_rules };
      }
      modeRuleBuffers.caption = (cfg.caption_rules || "").trim() || defaultModeRules.caption;
      modeRuleBuffers.layout = (cfg.layout_rules || "").trim() || defaultModeRules.layout;
      modeRuleBuffers.danbooru = (cfg.danbooru_rules || "").trim() || defaultModeRules.danbooru;
      if (cfg.output_language) langSelect.value = cfg.output_language;
      if (cfg.user_custom_rules != null) {
        userCustomArea.value = cfg.user_custom_rules;
      }
      if (cfg.max_regions != null) maxRegInput.value = String(cfg.max_regions);
      syncRuleTabUi();
      setStatus(`当前生效模型：${modelNodeValue() || cfg.model || "未设置"}`);
    } catch (err) {
      reportModalError(err, "读取配置");
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
      // 0. A key typed in the interface form is saved before the config so the
      //    footer save never drops it silently.
      const typedGatewayKey = gwKeyInput.value.trim();
      if (typedGatewayKey) {
        setStatus("正在保存 API Key…");
        try {
          const keyRes = await api.addKey({
            api_key: typedGatewayKey,
            label: "网关密钥",
            activate: true,
          });
          renderKeys(keyRes?.keys || [], keyRes?.active_key_id || "");
          gwKeyInput.value = "";
          gwKeyInput.classList.add("is-masked");
          gwKeyToggle.textContent = "明文";
        } catch (keyErr) {
          reportModalError(keyErr, "保存 API Key");
          saveBtn.disabled = false;
          return;
        }
      }

      // 1. If user typed an unsaved API Key in newKeyInput, auto-save and activate it!
      const newSecret = newKeyInput.value.trim();
      if (newSecret) {
        setStatus("正在自动保存并激活新填写的 API Key…");
        try {
          await api.addKey({
            api_key: newSecret,
            label: newKeyLabelInput.value.trim(),
            activate: true,
          });
          newKeyInput.value = "";
          newKeyLabelInput.value = "";
          newKeyInput.classList.add("is-masked");
          toggleKeyBtn.textContent = "明文";
        } catch (keyErr) {
          reportModalError(keyErr, "保存 API Key");
          saveBtn.disabled = false;
          return;
        }
      }

      modeRuleBuffers[activeRuleTab] = customRulesArea.value;
      const payload = {
        base_url: baseUrlInput.value.trim(),
        model: modelInput.value.trim(),
        timeout_s: Number(timeoutInput.value) || 120,
        max_retries: Number(retriesInput.value ?? 2),
        caption_rules: (modeRuleBuffers.caption || "").trim(),
        layout_rules: (modeRuleBuffers.layout || "").trim(),
        danbooru_rules: (modeRuleBuffers.danbooru || "").trim(),
        output_language: langSelect.value || "en",
        user_custom_rules: userCustomArea.value.trim(),
        max_regions: clamp(Number(maxRegInput.value) || 10, 1, 16),
      };
      const saved = await api.saveConfig(payload);
      void refreshGateways({ silent: true });
      const nodeResult = nodeOverrides
        ? {
            extra_instruction: nodeExtraInput ? nodeExtraInput.value.trim() : "",
            model: nodeModelInput ? nodeModelInput.value.trim() : "",
          }
        : null;
      onSaved?.(saved?.config || payload, nodeResult);
      close();
    } catch (err) {
      reportModalError(err, "保存设置");
    } finally {
      saveBtn.disabled = false;
    }
  });

  return { close };
}

/**
 * Normalised (0–1000) rectangle of a preset item.  Presets come in two shapes:
 * built-ins use `box_2d: [ymin, xmin, ymax, xmax]` (0–1000), boxes captured from a
 * live node use `bbox: [x1, y1, x2, y2]` in absolute pixels of `draft.width × draft.height`.
 */
export function presetBoxNorm(item, draft = {}, fallbackW = 1024, fallbackH = 1024) {
  const full = { x0: 0, y0: 0, x1: 1000, y1: 1000 };
  const fit = (x0, y0, x1, y1) => {
    const nums = [x0, y0, x1, y1].map(Number);
    if (nums.some((v) => !Number.isFinite(v))) return full;
    const cx0 = clamp(Math.min(nums[0], nums[2]), 0, 1000);
    const cy0 = clamp(Math.min(nums[1], nums[3]), 0, 1000);
    const cx1 = clamp(Math.max(nums[0], nums[2]), 0, 1000);
    const cy1 = clamp(Math.max(nums[1], nums[3]), 0, 1000);
    return { x0: cx0, y0: cy0, x1: Math.max(cx1, cx0 + 1), y1: Math.max(cy1, cy0 + 1) };
  };
  if (Array.isArray(item?.bbox) && item.bbox.length === 4) {
    const dw = Number(draft?.width) || Number(fallbackW) || 1024;
    const dh = Number(draft?.height) || Number(fallbackH) || 1024;
    const [x1, y1, x2, y2] = item.bbox.map(Number);
    return fit((x1 / dw) * 1000, (y1 / dh) * 1000, (x2 / dw) * 1000, (y2 / dh) * 1000);
  }
  if (Array.isArray(item?.box_2d) && item.box_2d.length === 4) {
    const [ymin, xmin, ymax, xmax] = item.box_2d;
    return fit(xmin, ymin, xmax, ymax);
  }
  return full;
}

/**
 * Convert a stored preset (built-in `box_2d` items or captured `bbox` items) into the
 * layout draft the node/workbench edits: absolute `bbox`, canonical label, caption.
 */
export function presetToLayoutDraft(preset) {
  const src = preset?.draft;
  if (!src || !Array.isArray(src.items) || !src.items.length) return null;
  const w = Number(preset.width) || Number(src.width) || 1024;
  const h = Number(preset.height) || Number(src.height) || 1024;
  const items = src.items.map((it) => {
    const n = presetBoxNorm(it, src, w, h);
    const rawLabel = String(it?.label || "");
    const canonical = LABELS.includes(rawLabel);
    const name = String(it?.name || (canonical ? "" : rawLabel));
    const looksLikeCharacter = /人|角色|主角|主体|character|person|girl|boy/i.test(name);
    return {
      name,
      parent: String(it?.parent || ""),
      label: canonical ? rawLabel : looksLikeCharacter ? "character" : "object",
      caption: String(it?.caption || it?.description || ""),
      text: String(it?.text || ""),
      bbox: [
        Math.round((n.x0 * w) / 1000),
        Math.round((n.y0 * h) / 1000),
        Math.round((n.x1 * w) / 1000),
        Math.round((n.y1 * h) / 1000),
      ],
    };
  });
  return normalizeDraft(
    {
      width: w,
      height: h,
      summary: {
        caption: String(src.summary?.caption || preset.prompts?.caption || ""),
        canvas: src.summary?.canvas || "single",
        ...(Array.isArray(src.summary?.meta) ? { meta: src.summary.meta } : {}),
        ...(Array.isArray(src.summary?.palette) ? { palette: src.summary.palette } : {}),
      },
      items,
    },
    w,
    h,
  );
}

export function renderPresetThumbnailSvg(preset) {
  const items = Array.isArray(preset?.draft?.items) ? preset.draft.items : [];
  const pw = Number(preset?.width) || Number(preset?.draft?.width) || 1024;
  const ph = Number(preset?.height) || Number(preset?.draft?.height) || 1024;
  // Real aspect ratio: the longest side maps to 1000 so boxes are not stretched to a square.
  const ratio = pw / ph;
  const VW = ratio >= 1 ? 1000 : Math.round(1000 * ratio);
  const VH = ratio >= 1 ? Math.round(1000 / ratio) : 1000;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${VW} ${VH}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  // SVGElement.className is a read-only SVGAnimatedString: set the attribute instead.
  svg.setAttribute("class", "aps-preset-svg-stage");
  svg.style.width = "100%";
  svg.style.height = "100%";
  svg.style.display = "block";
  svg.style.borderRadius = "6px";
  svg.style.background = "#090d16";

  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  const pattern = document.createElementNS("http://www.w3.org/2000/svg", "pattern");
  pattern.setAttribute("id", `grid-${Math.random().toString(36).slice(2, 8)}`);
  pattern.setAttribute("width", "125");
  pattern.setAttribute("height", "125");
  pattern.setAttribute("patternUnits", "userSpaceOnUse");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M 125 0 L 0 0 0 125");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "rgba(255, 255, 255, 0.08)");
  path.setAttribute("stroke-width", "1.5");
  pattern.append(path);
  defs.append(pattern);
  svg.append(defs);

  const bgRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bgRect.setAttribute("width", String(VW));
  bgRect.setAttribute("height", String(VH));
  bgRect.setAttribute("fill", `url(#${pattern.getAttribute("id")})`);
  svg.append(bgRect);

  // Reference image captured with the preset (small JPEG thumbnail) sits under the boxes.
  const hasThumb = typeof preset?.thumbnail === "string" && preset.thumbnail.startsWith("data:image/");
  if (hasThumb) {
    const thumb = document.createElementNS("http://www.w3.org/2000/svg", "image");
    thumb.setAttribute("href", preset.thumbnail);
    thumb.setAttribute("x", "0");
    thumb.setAttribute("y", "0");
    thumb.setAttribute("width", String(VW));
    thumb.setAttribute("height", String(VH));
    thumb.setAttribute("preserveAspectRatio", "none");
    svg.append(thumb);
  }

  const aspectRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  aspectRect.setAttribute("x", "2");
  aspectRect.setAttribute("y", "2");
  aspectRect.setAttribute("width", String(VW - 4));
  aspectRect.setAttribute("height", String(VH - 4));
  aspectRect.setAttribute("fill", "none");
  aspectRect.setAttribute("stroke", "rgba(148, 163, 184, 0.35)");
  aspectRect.setAttribute("stroke-width", "4");
  svg.append(aspectRect);

  // Subtle rule-of-thirds composition guide lines
  for (const frac of [1 / 3, 2 / 3]) {
    const vx = document.createElementNS("http://www.w3.org/2000/svg", "line");
    vx.setAttribute("x1", String(Math.round(VW * frac)));
    vx.setAttribute("y1", "0");
    vx.setAttribute("x2", String(Math.round(VW * frac)));
    vx.setAttribute("y2", String(VH));
    vx.setAttribute("stroke", "rgba(56, 189, 248, 0.14)");
    vx.setAttribute("stroke-width", "2");
    vx.setAttribute("stroke-dasharray", "12 10");
    svg.append(vx);

    const hz = document.createElementNS("http://www.w3.org/2000/svg", "line");
    hz.setAttribute("x1", "0");
    hz.setAttribute("y1", String(Math.round(VH * frac)));
    hz.setAttribute("x2", String(VW));
    hz.setAttribute("y2", String(Math.round(VH * frac)));
    hz.setAttribute("stroke", "rgba(56, 189, 248, 0.14)");
    hz.setAttribute("stroke-width", "2");
    hz.setAttribute("stroke-dasharray", "12 10");
    svg.append(hz);
  }

  // If preset has no image AND no layout boxes (pure text/caption preset), draw clean framing watermark
  if (!hasThumb && items.length === 0) {
    const cx = Math.round(VW / 2);
    const cy = Math.round(VH / 2);
    const centerText = document.createElementNS("http://www.w3.org/2000/svg", "text");
    centerText.setAttribute("x", String(cx));
    centerText.setAttribute("y", String(cy - 10));
    centerText.setAttribute("text-anchor", "middle");
    centerText.setAttribute("fill", "rgba(148, 163, 184, 0.55)");
    centerText.setAttribute("font-size", "42");
    centerText.setAttribute("font-weight", "700");
    centerText.setAttribute("font-family", "system-ui, -apple-system, sans-serif");
    centerText.textContent = `${pw} × ${ph}`;
    svg.append(centerText);

    const subText = document.createElementNS("http://www.w3.org/2000/svg", "text");
    subText.setAttribute("x", String(cx));
    subText.setAttribute("y", String(cy + 36));
    subText.setAttribute("text-anchor", "middle");
    subText.setAttribute("fill", "rgba(100, 116, 139, 0.7)");
    subText.setAttribute("font-size", "26");
    subText.setAttribute("font-family", "system-ui, -apple-system, sans-serif");
    subText.textContent = "纯文本提示词预设（点此预览或上传封面图）";
    svg.append(subText);
  }

  // Draw composition boxes (both `box_2d` and `bbox` items, mapped onto the real aspect ratio)
  items.forEach((item, idx) => {
    const n = presetBoxNorm(item, preset?.draft, pw, ph);
    if (items.length > 1 && n.x1 - n.x0 >= 990 && n.y1 - n.y0 >= 990) {
      return;
    }
    const xmin = (n.x0 / 1000) * VW;
    const ymin = (n.y0 / 1000) * VH;
    const bw = Math.max(4, ((n.x1 - n.x0) / 1000) * VW);
    const bh = Math.max(4, ((n.y1 - n.y0) / 1000) * VH);

    const color = BOX_COLORS[idx % BOX_COLORS.length];
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");

    const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    r.setAttribute("x", String(xmin));
    r.setAttribute("y", String(ymin));
    r.setAttribute("width", String(bw));
    r.setAttribute("height", String(bh));
    r.setAttribute("fill", color);
    r.setAttribute("fill-opacity", hasThumb ? "0.12" : "0.26");
    r.setAttribute("stroke", color);
    r.setAttribute("stroke-width", "6");
    r.setAttribute("rx", "10");
    g.append(r);

    const canonicalLabels = new Set(LABELS);
    const rawLabel = String(item.label || "");
    const label = String(item.name || (canonicalLabels.has(rawLabel) ? "" : rawLabel) || `主体 ${idx + 1}`);
    const tagBg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    const tagW = Math.min(bw, Math.max(90, label.length * 30 + 36));
    const tagH = 46;
    tagBg.setAttribute("x", String(xmin));
    tagBg.setAttribute("y", String(ymin));
    tagBg.setAttribute("width", String(tagW));
    tagBg.setAttribute("height", String(tagH));
    tagBg.setAttribute("fill", color);
    tagBg.setAttribute("rx", "6");
    g.append(tagBg);

    const txt = document.createElementNS("http://www.w3.org/2000/svg", "text");
    txt.setAttribute("x", String(xmin + 12));
    txt.setAttribute("y", String(ymin + 32));
    txt.setAttribute("fill", "#ffffff");
    txt.setAttribute("font-size", "28");
    txt.setAttribute("font-weight", "bold");
    txt.setAttribute("font-family", "system-ui, -apple-system, sans-serif");
    txt.textContent = label.slice(0, 8);
    g.append(txt);

    svg.append(g);
  });

  return svg;
}

export function openSavePresetModal({
  api: suppliedApi = null,
  state = {},
  prompts: suppliedPrompts = null,
  imageCandidate = null,
  onSaved = null,
} = {}) {
  const api = suppliedApi || new StudioApi();
  // Prompts of the three output formats as the node currently emits them.
  const prompts = {
    caption: String(suppliedPrompts?.caption ?? state.caption_text ?? state.caption ?? ""),
    layout: String(suppliedPrompts?.layout ?? state.layout_prompt ?? ""),
    danbooru: String(suppliedPrompts?.danbooru ?? state.danbooru_prompt ?? state.danbooru ?? ""),
  };
  const overlay = el("div", "aps-modal-overlay aps-preset-modal-overlay notranslate");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

  const modal = el("div", "aps-modal aps-preset-save-modal notranslate");
  modal.style.width = "min(680px, 94vw)";
  modal.style.maxWidth = "680px";
  modal.style.height = "min(88vh, 760px)";
  modal.style.maxHeight = "88vh";
  modal.style.display = "flex";
  modal.style.flexDirection = "column";
  modal.style.overflow = "hidden";
  modal.style.boxSizing = "border-box";
  modal.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

  // Header
  const head = el("div", "aps-modal-head aps-wb-head");
  head.style.flexShrink = "0";
  const titleWrap = el("div", "aps-wb-brand");
  titleWrap.append(
    el("span", "aps-logo", "💾"),
    el("div", "aps-modal-title", "保存构图与提示词到预设库"),
  );
  const closeTopBtn = el("button", "aps-btn aps-btn-sm", "✕ 关闭");
  closeTopBtn.type = "button";
  head.append(titleWrap, closeTopBtn);
  modal.append(head);

  // Body
  const body = el("div", "aps-modal-body aps-preset-modal-body");
  body.style.flex = "1 1 auto";
  body.style.minHeight = "0";
  body.style.overflowY = "auto";
  body.style.overflowX = "hidden";
  body.style.paddingRight = "6px";

  // Info card: composition & prompt summary
  const summaryCard = el("div", "aps-preset-summary-card");
  const curWidth = Number(state.width) || 1024;
  const curHeight = Number(state.height) || 1024;
  const ratio = (curWidth / curHeight).toFixed(2);
  const numBoxes = Array.isArray(state.draft?.items) ? state.draft.items.length : 0;
  const captionPreview = prompts.caption.trim() || prompts.danbooru.trim() || "（暂无提示词）";

  const badgesRow = el("div", "aps-preset-badges-row");
  badgesRow.append(
    el("span", "aps-preset-badge aps-preset-badge-blue", `📐 尺寸：${curWidth}×${curHeight} (${ratio}:1)`),
    el("span", "aps-preset-badge aps-preset-badge-green", `画框数量：${numBoxes} 个主体区域`),
  );
  if (state.mode) {
    badgesRow.append(el("span", "aps-preset-badge aps-preset-badge-purple", `模式：${state.mode}`));
  }

  const promptTextWrap = el("div", "aps-preset-prompt-snippet");
  promptTextWrap.append(
    el("div", "aps-preset-snippet-label", "提示词摘录："),
    el("div", "aps-preset-snippet-content", captionPreview.slice(0, 160) + (captionPreview.length > 160 ? "…" : "")),
  );
  summaryCard.append(badgesRow, promptTextWrap);
  body.append(summaryCard);

  // Form Fields
  const formGroup = el("div", "aps-preset-form");

  // 1. Preset Name
  const nameRow = el("div", "aps-preset-form-row");
  const nameLabelWrap = el("div", "aps-preset-name-label-wrap");
  const nameLabel = el("label", "aps-preset-form-label", "预设名称 *");
  const autoSummarizeBtn = el("button", "aps-btn aps-btn-sm aps-preset-summarize-btn", "智能精炼标题");
  autoSummarizeBtn.type = "button";
  autoSummarizeBtn.title = "根据提示词自动提取 4~10 个汉字的简明画面标题";
  nameLabelWrap.append(nameLabel, autoSummarizeBtn);
  nameRow.append(nameLabelWrap);

  const nameInput = el("input", "aps-input aps-preset-name-input");
  nameInput.type = "text";
  const now = new Date();
  const timeStr = `${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
  nameInput.value = `构图预设_${timeStr}`;
  nameRow.append(nameInput);
  formGroup.append(nameRow);

  async function triggerAutoTitle(quiet = false) {
    autoSummarizeBtn.disabled = true;
    autoSummarizeBtn.textContent = "⏳ 精炼中…";
    try {
      const p = prompts.caption || prompts.danbooru || "";
      const res = await api.summarizePresetTitle({ prompt: p, draft: state.draft });
      if (res && res.title && res.title.trim()) {
        nameInput.value = res.title.trim();
        nameInput.select();
        setStatus(`✓ 已自动精炼标题：「${res.title.trim()}」`);
      }
    } catch (err) {
      if (!quiet) {
        const friendly = formatFriendlyError(err, "精炼标题");
        const tech = formatErrorTechnicalDetail(err);
        setStatus(friendly, true, tech ? `${friendly}\n\n${tech}` : friendly);
      }
    } finally {
      autoSummarizeBtn.disabled = false;
      autoSummarizeBtn.textContent = "智能精炼标题";
    }
  }

  autoSummarizeBtn.addEventListener("click", () => triggerAutoTitle(false));
  setTimeout(() => {
    if (nameInput.value.startsWith("构图预设_")) {
      void triggerAutoTitle(true);
    }
  }, 100);

  // 2. Category (existing directories + user-created ones)
  const catRow = el("div", "aps-preset-form-row");
  catRow.append(el("label", "aps-preset-form-label", "保存到目录"));
  const catInputWrap = el("div", "aps-preset-cat-wrap");
  const catSelect = el("select", "aps-select aps-preset-cat-select");
  const NEW_CAT_VALUE = "__new_category__";
  const customCatInput = el("input", "aps-input aps-preset-cat-input");
  customCatInput.placeholder = "输入新目录名（支持 / 多级目录，如 人物/单人特写）";
  customCatInput.maxLength = 120;
  customCatInput.hidden = true;

  function fillCategoryOptions(names, selectValue) {
    catSelect.textContent = "";
    for (const c of names) {
      const opt = el("option", "", c);
      opt.value = c;
      catSelect.append(opt);
    }
    const newOpt = el("option", "", "＋ 新建目录…");
    newOpt.value = NEW_CAT_VALUE;
    catSelect.append(newOpt);
    catSelect.value = names.includes(selectValue) ? selectValue : names[0] || NEW_CAT_VALUE;
    customCatInput.hidden = catSelect.value !== NEW_CAT_VALUE;
  }
  fillCategoryOptions(["通用"], "通用");
  catSelect.addEventListener("change", () => {
    customCatInput.hidden = catSelect.value !== NEW_CAT_VALUE;
    if (!customCatInput.hidden) customCatInput.focus();
  });
  void api
    .listPresetCategories()
    .then((res) => {
      const names = Array.isArray(res?.categories) && res.categories.length ? res.categories : ["通用"];
      fillCategoryOptions(names, catSelect.value === NEW_CAT_VALUE ? "通用" : catSelect.value);
    })
    .catch(() => {});
  catInputWrap.append(catSelect, customCatInput);
  catRow.append(catInputWrap);
  formGroup.append(catRow);

  // 3. Tags
  const tagsRow = el("div", "aps-preset-form-row");
  tagsRow.append(el("label", "aps-preset-form-label", "搜索标签 (可选，逗号分隔)"));
  const tagsInput = el("input", "aps-input aps-preset-tags-input");
  tagsInput.placeholder = "例如：电影感, 宽幅, 逆光, 双人";
  tagsRow.append(tagsInput);
  formGroup.append(tagsRow);

  // 4. Attached image: the picture this prompt produced, kept byte-for-byte so the
  //    embedded ComfyUI metadata (workflow / prompt) survives.
  const imageRow = el("div", "aps-preset-form-row aps-preset-image-row");
  const imageHead = el("label", "aps-preset-form-label", "附带生成图（含 ComfyUI 元数据）");
  const imageBox = el("div", "aps-preset-image-box");
  const imagePreview = el("img", "aps-preset-image-preview");
  imagePreview.alt = "";
  imagePreview.hidden = true;
  const imageInfo = el("div", "aps-preset-image-info", "");
  const imageBtns = el("div", "aps-preset-image-btns");
  const pickImageBtn = el("button", "aps-chip-btn aps-btn-xs", "📁 选择图片…");
  pickImageBtn.type = "button";
  const dropImageBtn = el("button", "aps-chip-btn aps-btn-xs", "✕ 不附带");
  dropImageBtn.type = "button";
  dropImageBtn.hidden = true;
  const imageFileInput = el("input");
  imageFileInput.type = "file";
  imageFileInput.accept = "image/png,image/jpeg,image/webp";
  imageFileInput.style.display = "none";
  imageBtns.append(pickImageBtn, dropImageBtn, imageFileInput);
  const imageSide = el("div", "aps-preset-image-side");
  imageSide.append(imageInfo, imageBtns);
  imageBox.append(imagePreview, imageSide);
  imageRow.append(imageHead, imageBox);
  formGroup.append(imageRow);

  /** @type {{dataUrl: string, bytes: number, label: string} | null} */
  let attached = null;

  function showAttached(next, message) {
    attached = next;
    if (next) {
      imagePreview.src = next.dataUrl;
      imagePreview.hidden = false;
      imageInfo.textContent = `${next.label} · ${(next.bytes / 1024 / 1024).toFixed(2)} MB`;
      imageInfo.classList.remove("is-warn");
    } else {
      imagePreview.removeAttribute("src");
      imagePreview.hidden = true;
      imageInfo.textContent = message || "未附带图片。";
      imageInfo.classList.toggle("is-warn", Boolean(message));
    }
    dropImageBtn.hidden = !next;
  }
  showAttached(null, "");

  async function loadCandidateImage() {
    let ref = null;
    try {
      ref = typeof imageCandidate === "function" ? imageCandidate() : null;
    } catch {
      ref = null;
    }
    if (!ref) {
      showAttached(null, "没找到本节点下游已生成的图片。先运行一次工作流再保存，或点「选择图片」手动指定。");
      return;
    }
    imageInfo.textContent = `正在读取最近生成图：${ref.filename} …`;
    try {
      const got = await fetchComfyImageRef(ref);
      showAttached({ dataUrl: got.dataUrl, bytes: got.bytes, label: ref.filename });
    } catch (err) {
      showAttached(null, `${err?.message || err} 可点「选择图片」手动指定。`);
    }
  }
  void loadCandidateImage();

  pickImageBtn.addEventListener("click", () => imageFileInput.click());
  dropImageBtn.addEventListener("click", () => showAttached(null, ""));
  imageFileInput.addEventListener("change", async () => {
    const file = imageFileInput.files?.[0];
    imageFileInput.value = "";
    if (!file) return;
    try {
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
        throw new Error("仅支持 PNG / JPEG / WEBP 图片。");
      }
      if (file.size > MAX_PRESET_IMAGE_BYTES) {
        throw new Error(`图片过大（${Math.round(file.size / 1024 / 1024)} MB），预设库上限 ${Math.round(MAX_PRESET_IMAGE_BYTES / 1024 / 1024)} MB。`);
      }
      showAttached({ dataUrl: await blobToDataUrl(file), bytes: file.size, label: file.name });
    } catch (err) {
      showAttached(null, String(err?.message || err));
    }
  });

  body.append(formGroup);
  modal.append(body);

  // Footer
  const foot = el("div", "aps-modal-foot");
  foot.style.flexShrink = "0";
  foot.style.marginTop = "auto";
  foot.style.paddingTop = "10px";
  foot.style.borderTop = "1px solid var(--aps-border)";
  foot.style.background = "var(--aps-bg)";
  const statusEl = el("span", "aps-modal-status", "");
  const footBtns = el("div", "aps-wb-foot-btns");
  const cancelBtn = el("button", "aps-btn", "取消");
  cancelBtn.type = "button";
  const saveBtn = el("button", "aps-btn aps-primary", "💾 保存到预设库");
  saveBtn.type = "button";
  footBtns.append(cancelBtn, saveBtn);
  foot.append(statusEl, footBtns);
  modal.append(foot);

  overlay.append(modal);
  document.body.append(overlay);

  function setStatus(msg, isError = false, titleText = "") {
    const txt = msg || "";
    statusEl.textContent = txt;
    statusEl.title = titleText || txt;
    statusEl.className = isError ? "aps-modal-status aps-error-text" : "aps-modal-status";
    statusEl.dataset.kind = isError ? "error" : "ok";
  }

  function close() {
    overlay.remove();
  }

  closeTopBtn.addEventListener("click", close);
  cancelBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  saveBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) {
      setStatus("请输入预设名称", true);
      nameInput.focus();
      return;
    }
    const creatingCategory = catSelect.value === NEW_CAT_VALUE;
    const category = creatingCategory
      ? customCatInput.value.replace(/\\/g, "/").replace(/\s+/g, " ").trim()
      : catSelect.value || "通用";
    if (!category) {
      setStatus("请输入新目录的名称，或从列表里选择一个目录。", true);
      customCatInput.focus();
      return;
    }
    const tags = tagsInput.value
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean);

    saveBtn.disabled = true;
    setStatus("正在保存到构图预设库…");

    const payload = {
      name,
      category,
      tags,
      width: curWidth,
      height: curHeight,
      prompts: { ...prompts },
      draft: state.draft || state.layout_draft || {},
      thumbnail: null,
    };

    try {
      if (attached) {
        payload.image_data = attached.dataUrl;
        try {
          payload.thumbnail = await makeThumbnailDataUrl(attached.dataUrl);
        } catch (thumbErr) {
          console.warn("[ai-prompt-studio] thumbnail generation failed", thumbErr);
        }
      }
      if (creatingCategory) {
        await api.addPresetCategory(category);
      }
      const saved = await api.savePreset(payload);
      onSaved?.(saved);
      close();
    } catch (err) {
      const friendly = formatFriendlyError(err, "保存预设");
      const tech = formatErrorTechnicalDetail(err);
      setStatus(friendly, true, tech ? `${friendly}\n\n${tech}` : friendly);
      saveBtn.disabled = false;
    }
  });

  nameInput.focus();
  nameInput.select();

  return { close };
}

export function openPresetLibraryModal({
  api: suppliedApi = null,
  onApply = null,
} = {}) {
  const api = suppliedApi || new StudioApi();
  const overlay = el("div", "aps-modal-overlay aps-preset-gallery-overlay notranslate");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");

  const modal = el("div", "aps-modal aps-preset-gallery-modal notranslate");

  // Header
  const head = el("div", "aps-modal-head aps-wb-head");
  const titleWrap = el("div", "aps-wb-brand");
  titleWrap.append(
    el("span", "aps-logo", ""),
    el("div", "aps-modal-title", "构图与提示词预设库 (Composition & Prompt Hub)"),
  );
  const closeTopBtn = el("button", "aps-btn aps-btn-sm", "✕ 关闭");
  closeTopBtn.type = "button";
  head.append(titleWrap, closeTopBtn);
  modal.append(head);

  // Body (Windows Explorer Layout)
  const body = el("div", "aps-modal-body aps-preset-gallery-body");

  const explorerLayout = el("div", "aps-explorer-layout");

  // 1. Left Explorer Sidebar (Tree & Navigation)
  const sidebar = el("div", "aps-explorer-sidebar");
  const sidebarHead = el("div", "aps-explorer-sidebar-head");
  sidebarHead.append(el("span", "aps-explorer-sidebar-title", "📁 目录树"));

  const newTopFolderBtn = el("button", "aps-btn aps-btn-xs aps-primary aps-explorer-new-top-btn", "＋ 新建大类");
  newTopFolderBtn.type = "button";
  newTopFolderBtn.title = "新建一个顶级大类目录";
  sidebarHead.append(newTopFolderBtn);

  const treeContainer = el("div", "aps-explorer-tree");
  sidebar.append(sidebarHead, treeContainer);

  const sidebarFoot = el("div", "aps-explorer-sidebar-foot");
  const resetBuiltinsBtn = el("button", "aps-btn aps-btn-xs aps-explorer-reset-btn", "↺ 恢复官方预设");
  resetBuiltinsBtn.type = "button";
  resetBuiltinsBtn.title = "重新导入所有官方默认预设（如果曾经删除过）";
  sidebarFoot.append(resetBuiltinsBtn);
  sidebar.append(sidebarFoot);

  // 2. Right Explorer Main (Path bar, search, drag & drop grid)
  const mainPane = el("div", "aps-explorer-main");

  // Top Bar: Breadcrumb + Search + Quick Actions
  const topBar = el("div", "aps-explorer-topbar");
  const breadcrumbWrap = el("div", "aps-explorer-breadcrumbs");

  const topActionsWrap = el("div", "aps-explorer-top-actions");
  const searchInput = el("input", "aps-input aps-preset-search-input");
  searchInput.placeholder = "搜索名称/标签/提示词…";

  const importImgBtn = el("button", "aps-btn aps-btn-sm aps-accent aps-explorer-import-img-btn", "导入图片预设");
  importImgBtn.type = "button";
  importImgBtn.title = "选择包含 ComfyUI 生成元数据的图片，自动提取提示词与画框存为预设";

  const importJsonBtn = el("button", "aps-btn aps-btn-sm", "📥 导入 JSON");
  importJsonBtn.type = "button";
  importJsonBtn.title = "导入预设 JSON 文件";

  const exportBtn = el("button", "aps-btn aps-btn-sm", "📤 导出");
  exportBtn.type = "button";
  exportBtn.title = "导出全部预设为 JSON 文件";

  topActionsWrap.append(searchInput, importImgBtn, importJsonBtn, exportBtn);
  topBar.append(breadcrumbWrap, topActionsWrap);
  mainPane.append(topBar);

  // Cards Grid & Drop Zone
  const gridContainer = el("div", "aps-preset-grid");
  const dropOverlay = el("div", "aps-explorer-drop-overlay");
  const dropTitle = el("div", "", "📥 松开鼠标立即导入图片预设");
  const dropSub = el("div", "aps-explorer-drop-sub", "自动提取 ComfyUI 工作流 / 提示词 / 画框并生成封面图");
  dropOverlay.append(dropTitle, dropSub);
  dropOverlay.hidden = true;

  mainPane.append(gridContainer, dropOverlay);
  explorerLayout.append(sidebar, mainPane);
  body.append(explorerLayout);

  // Hidden File inputs
  const jsonFileInput = el("input");
  jsonFileInput.type = "file";
  jsonFileInput.accept = ".json,application/json";
  jsonFileInput.style.display = "none";
  body.append(jsonFileInput);

  const imgFileInput = el("input");
  imgFileInput.type = "file";
  imgFileInput.multiple = true;
  imgFileInput.accept = "image/png,image/jpeg,image/webp";
  imgFileInput.style.display = "none";
  body.append(imgFileInput);

  const coverFileInput = el("input");
  coverFileInput.type = "file";
  coverFileInput.accept = "image/png,image/jpeg,image/webp";
  coverFileInput.style.display = "none";
  body.append(coverFileInput);
  let pendingCoverPreset = null;
  let pendingCoverDone = null;

  modal.append(body);

  // Footer
  const foot = el("div", "aps-modal-foot");
  const statusEl = el("span", "aps-modal-status", "正在加载预设库…");
  foot.append(statusEl);
  modal.append(foot);

  overlay.append(modal);
  document.body.append(overlay);

  // In-DOM themed mini dialog helpers (never block on native window.prompt/confirm in Electron)
  function openInlinePromptDialog({ title, message = "", initialValue = "", placeholder = "", confirmLabel = "确定" }) {
    return new Promise((resolve) => {
      const sub = el("div", "aps-subdialog-overlay notranslate");
      const card = el("div", "aps-subdialog-card");
      card.append(el("div", "aps-subdialog-title", title));
      if (message) card.append(el("div", "aps-subdialog-msg", message));
      const inp = el("input", "aps-input");
      inp.type = "text";
      inp.value = initialValue;
      inp.placeholder = placeholder;
      const footBar = el("div", "aps-subdialog-foot");
      const btnCancel = el("button", "aps-btn aps-btn-sm", "取消");
      btnCancel.type = "button";
      const btnOk = el("button", "aps-btn aps-btn-sm aps-primary", confirmLabel);
      btnOk.type = "button";
      footBar.append(btnCancel, btnOk);
      card.append(inp, footBar);
      sub.append(card);
      overlay.append(sub);

      const finish = (val) => {
        sub.remove();
        resolve(val);
      };
      btnCancel.addEventListener("click", () => finish(null));
      sub.addEventListener("click", (e) => {
        if (e.target === sub) finish(null);
      });
      btnOk.addEventListener("click", () => finish(inp.value));
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(inp.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(null);
        }
      });
      setTimeout(() => {
        inp.focus();
        inp.select();
      }, 20);
    });
  }

  function openInlineConfirmDialog({ title, message, confirmLabel = "确定", danger = false }) {
    return new Promise((resolve) => {
      const sub = el("div", "aps-subdialog-overlay notranslate");
      const card = el("div", "aps-subdialog-card");
      card.append(el("div", "aps-subdialog-title", title));
      card.append(el("div", "aps-subdialog-msg", message));
      const footBar = el("div", "aps-subdialog-foot");
      const btnCancel = el("button", "aps-btn aps-btn-sm", "取消");
      btnCancel.type = "button";
      const btnOk = el("button", `aps-btn aps-btn-sm ${danger ? "aps-preset-del-btn" : "aps-primary"}`, confirmLabel);
      btnOk.type = "button";
      footBar.append(btnCancel, btnOk);
      card.append(footBar);
      sub.append(card);
      overlay.append(sub);

      const finish = (ok) => {
        sub.remove();
        resolve(ok);
      };
      btnCancel.addEventListener("click", () => finish(false));
      sub.addEventListener("click", (e) => {
        if (e.target === sub) finish(false);
      });
      btnOk.addEventListener("click", () => finish(true));
      btnOk.focus();
    });
  }

  function hideDropOverlay() {
    dragCounter = 0;
    dropOverlay.classList.remove("is-visible");
    dropOverlay.hidden = true;
  }

  const onWindowDragEnd = () => hideDropOverlay();
  globalThis.addEventListener?.("dragend", onWindowDragEnd);
  globalThis.addEventListener?.("drop", onWindowDragEnd);
  globalThis.addEventListener?.("blur", onWindowDragEnd);

  function close() {
    globalThis.removeEventListener?.("dragend", onWindowDragEnd);
    globalThis.removeEventListener?.("drop", onWindowDragEnd);
    globalThis.removeEventListener?.("blur", onWindowDragEnd);
    overlay.remove();
  }

  closeTopBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  let currentCategory = "全部";
  let presetsList = [];
  let allCategories = ["通用"];
  let customCategories = [];
  const expandedPaths = new Set(["全部", "通用"]);

  function setStatus(msg, isError = false, titleText = "") {
    const txt = msg || "";
    statusEl.textContent = txt;
    statusEl.title = titleText || txt;
    statusEl.className = isError ? "aps-modal-status aps-error-text" : "aps-modal-status";
    statusEl.dataset.kind = isError ? "error" : "ok";
  }

  function reportLibError(err, actionName = "预设库操作") {
    const friendly = formatFriendlyError(err, actionName);
    const tech = formatErrorTechnicalDetail(err);
    setStatus(friendly, true, tech ? `${friendly}\n\n${tech}` : friendly);
  }

  function buildTreeData(categories, presets) {
    const counts = new Map();
    for (const p of presets) {
      const cat = p.category || "通用";
      const parts = cat.split("/");
      let acc = "";
      for (const pt of parts) {
        acc = acc ? `${acc}/${pt}` : pt;
        counts.set(acc, (counts.get(acc) || 0) + 1);
      }
    }

    const root = { name: "root", path: "", children: new Map(), count: presets.length };
    const sortedCats = Array.from(new Set(["通用", ...categories])).sort();

    for (const cat of sortedCats) {
      if (!cat) continue;
      const parts = cat.split("/");
      let cur = root;
      let acc = "";
      for (const pt of parts) {
        acc = acc ? `${acc}/${pt}` : pt;
        if (!cur.children.has(pt)) {
          cur.children.set(pt, {
            name: pt,
            path: acc,
            children: new Map(),
            count: counts.get(acc) || 0,
          });
        }
        cur = cur.children.get(pt);
      }
    }
    return root;
  }

  function bindFolderCardDrop(row, targetFolder) {
    row.addEventListener("dragover", (ev) => {
      if (Array.from(ev.dataTransfer?.types || []).includes("text/aps-preset-id")) {
        ev.preventDefault();
        ev.stopPropagation();
        row.classList.add("is-drop-target");
      }
    });
    row.addEventListener("dragleave", () => {
      row.classList.remove("is-drop-target");
    });
    row.addEventListener("drop", (ev) => {
      row.classList.remove("is-drop-target");
      const pid = ev.dataTransfer?.getData("text/aps-preset-id");
      if (!pid) return;
      ev.preventDefault();
      ev.stopPropagation();
      const targetPreset = presetsList.find((x) => x.id === pid);
      if (targetPreset && targetPreset.category !== targetFolder) {
        void movePreset(targetPreset, targetFolder);
      }
    });
  }

  function renderTree() {
    treeContainer.textContent = "";

    // 1. "全部预设" row
    const allRow = el(
      "div",
      `aps-tree-item ${currentCategory === "全部" ? "is-active" : ""}`,
    );
    const allLeft = el("div", "aps-tree-item-left");
    allLeft.append(
      el("span", "aps-tree-chevron-space", ""),
      el("span", "aps-tree-icon", currentCategory === "全部" ? "" : "📁"),
      el("span", "aps-tree-title", "全部预设"),
    );
    const allRight = el("div", "aps-tree-item-right");
    allRight.append(el("span", "aps-tree-count-badge", String(presetsList.length)));
    allRow.append(allLeft, allRight);
    allRow.addEventListener("click", () => {
      currentCategory = "全部";
      renderTree();
      updateBreadcrumbs();
      filterAndRenderCards();
    });
    treeContainer.append(allRow);

    // 2. Recursive hierarchical folders
    const root = buildTreeData(allCategories, presetsList);

    function renderNode(node, depth = 0) {
      const isSelected = currentCategory === node.path;
      const hasChildren = node.children.size > 0;
      const isExpanded = expandedPaths.has(node.path);

      const itemWrap = el("div", "aps-tree-node-wrap");
      const row = el("div", `aps-tree-item ${isSelected ? "is-active" : ""}`);
      row.style.paddingLeft = `${depth * 14 + 6}px`;
      bindFolderCardDrop(row, node.path);

      const left = el("div", "aps-tree-item-left");
      const chevron = el("span", "aps-tree-chevron", hasChildren ? (isExpanded ? "" : "") : "");
      chevron.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (!hasChildren) return;
        if (expandedPaths.has(node.path)) expandedPaths.delete(node.path);
        else expandedPaths.add(node.path);
        renderTree();
      });

      const icon = el("span", "aps-tree-icon", isSelected || isExpanded ? "" : "📁");
      const title = el("span", "aps-tree-title", node.name);
      title.title = node.path;
      left.append(chevron, icon, title);

      const right = el("div", "aps-tree-item-right");
      if (node.count > 0) {
        right.append(el("span", "aps-tree-count-badge", String(node.count)));
      }

      const actions = el("span", "aps-tree-actions");
      // [+] Add child subcategory
      const addSubBtn = el("button", "aps-tree-act-btn", "＋");
      addSubBtn.type = "button";
      addSubBtn.title = `在「${node.name}」下新建子目录`;
      addSubBtn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const subName = await openInlinePromptDialog({
          title: "新建子目录",
          message: `将在「${node.path}」下创建子分类目录：`,
          placeholder: "输入子目录名称（支持多级 如 少女/日系）",
          confirmLabel: "创建",
        });
        if (!subName || !subName.trim()) return;
        const newPath = `${node.path}/${subName.trim().replace(/^\/+|\/+$/g, "")}`;
        try {
          await api.addPresetCategory(newPath);
          expandedPaths.add(node.path);
          expandedPaths.add(newPath);
          currentCategory = newPath;
          setStatus(`已创建子目录「${newPath}」。`);
          await loadCategories();
          await loadPresets();
        } catch (err) {
          reportLibError(err, "创建子目录");
        }
      });
      actions.append(addSubBtn);

      if (node.path !== "通用") {
        // [✏] Rename
        const renBtn = el("button", "aps-tree-act-btn", "");
        renBtn.type = "button";
        renBtn.title = `重命名目录「${node.name}」`;
        renBtn.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          const newName = await openInlinePromptDialog({
            title: "重命名目录",
            message: `修改「${node.path}」末尾文件夹名称：`,
            initialValue: node.name,
            confirmLabel: "保存名称",
          });
          if (!newName || !newName.trim() || newName.trim() === node.name) return;
          const parts = node.path.split("/");
          parts[parts.length - 1] = newName.trim().replace(/[\\/]+/g, "_");
          const newPath = parts.join("/");
          try {
            await api.renamePresetCategory(node.path, newPath);
            if (currentCategory === node.path || currentCategory.startsWith(node.path + "/")) {
              currentCategory = newPath;
            }
            setStatus(`已重命名目录为「${newPath}」。`);
            await loadCategories();
            await loadPresets();
          } catch (err) {
            reportLibError(err, "重命名目录");
          }
        });
        actions.append(renBtn);

        // [🗑] Delete
        const delBtn = el("button", "aps-tree-act-btn aps-tree-act-del", "🗑");
        delBtn.type = "button";
        delBtn.title = `删除目录「${node.path}」`;
        delBtn.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          const inside = presetsList.filter(
            (p) => p.category === node.path || p.category.startsWith(node.path + "/"),
          ).length;
          const note = inside ? `其中 ${inside} 个预设将自动迁移到父级或通用目录。` : "此目录为空，不会丢失任何预设。";
          const ok = await openInlineConfirmDialog({
            title: `删除目录「${node.name}」`,
            message: `确定要删除目录「${node.path}」及其下空子目录吗？\n${note}`,
            confirmLabel: "确认删除",
            danger: true,
          });
          if (!ok) return;
          try {
            await api.deletePresetCategory(node.path);
            if (currentCategory === node.path || currentCategory.startsWith(node.path + "/")) {
              currentCategory = "全部";
            }
            setStatus(`已删除目录「${node.path}」。`);
            await loadCategories();
            await loadPresets();
          } catch (err) {
            reportLibError(err, "删除目录");
          }
        });
        actions.append(delBtn);
      }

      right.append(actions);
      row.append(left, right);

      row.addEventListener("click", () => {
        currentCategory = node.path;
        expandedPaths.add(node.path);
        renderTree();
        updateBreadcrumbs();
        filterAndRenderCards();
      });

      itemWrap.append(row);

      if (hasChildren && isExpanded) {
        const childWrap = el("div", "aps-tree-children");
        for (const child of node.children.values()) {
          childWrap.append(renderNode(child, depth + 1));
        }
        itemWrap.append(childWrap);
      }

      return itemWrap;
    }

    for (const child of root.children.values()) {
      treeContainer.append(renderNode(child, 0));
    }
  }

  function updateBreadcrumbs() {
    breadcrumbWrap.textContent = "";
    const rootPill = el("span", "aps-crumb-item", "📁 全部预设");
    rootPill.addEventListener("click", () => {
      currentCategory = "全部";
      renderTree();
      updateBreadcrumbs();
      filterAndRenderCards();
    });
    breadcrumbWrap.append(rootPill);

    if (currentCategory !== "全部") {
      const parts = currentCategory.split("/");
      let acc = "";
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        acc = acc ? `${acc}/${p}` : p;
        const targetPath = acc;
        breadcrumbWrap.append(el("span", "aps-crumb-sep", "/"));
        const pill = el("span", `aps-crumb-item ${i === parts.length - 1 ? "is-current" : ""}`, p);
        pill.addEventListener("click", () => {
          currentCategory = targetPath;
          renderTree();
          updateBreadcrumbs();
          filterAndRenderCards();
        });
        breadcrumbWrap.append(pill);
      }
    }
  }

  newTopFolderBtn.addEventListener("click", async () => {
    const name = await openInlinePromptDialog({
      title: "新建分类目录",
      message: "支持用斜杠「/」直接建立子分类层级（例如：人物/单人特写）：",
      placeholder: "输入大类名称（例如：人物、场景/室内）",
      confirmLabel: "新建",
    });
    if (!name || !name.trim()) return;
    const cleaned = name.trim().replace(/^\/+|\/+$/g, "");
    if (!cleaned) return;
    try {
      await api.addPresetCategory(cleaned);
      currentCategory = cleaned;
      const parts = cleaned.split("/");
      let acc = "";
      for (const pt of parts) {
        acc = acc ? `${acc}/${pt}` : pt;
        expandedPaths.add(acc);
      }
      setStatus(`已创建目录「${cleaned}」。`);
      await loadCategories();
      await loadPresets();
    } catch (err) {
      reportLibError(err, "新建分类目录");
    }
  });

  resetBuiltinsBtn.addEventListener("click", async () => {
    const ok = await openInlineConfirmDialog({
      title: "恢复官方默认预设",
      message: "确定要重新导入之前删掉的官方内置构图预设吗？不会覆盖您的自定义预设。",
      confirmLabel: "恢复官方预设",
    });
    if (!ok) return;
    try {
      await api.resetBuiltinPresets();
      setStatus("✓ 官方默认预设已全部恢复。");
      await loadCategories();
      await loadPresets();
    } catch (err) {
      reportLibError(err, "恢复官方预设");
    }
  });

  async function importImageFiles(files) {
    const targetCat = currentCategory === "全部" ? "通用" : currentCategory;
    setStatus(`正在解析并导入 ${files.length} 张图片到目录「${targetCat}」…`);
    let successCount = 0;
    let failCount = 0;
    let lastErr = null;
    for (const f of files) {
      try {
        const dataUrl = await blobToDataUrl(f);
        await api.importPresetImage({ dataUrl, filename: f.name, category: targetCat });
        successCount++;
      } catch (err) {
        console.warn("[ai-prompt-studio] import failed for file", f.name, err);
        lastErr = err;
        failCount++;
      }
    }
    await loadCategories();
    await loadPresets();
    if (failCount === 0) {
      setStatus(`✓ 成功导入 ${successCount} 个预设（已自动提取 ComfyUI 元数据与生成尺寸）`);
    } else {
      const friendly = formatFriendlyError(lastErr, "图片预设导入");
      const tech = formatErrorTechnicalDetail(lastErr);
      const summary =
        failCount === 1 && successCount === 0
          ? friendly
          : `导入完成：成功 ${successCount} 个，失败 ${failCount} 个（${friendly}）`;
      setStatus(summary, true, tech ? `${summary}\n\n${tech}` : summary);
    }
  }

  async function attachCoverImageToPreset(preset, file) {
    if (!file || !["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setStatus("仅支持 PNG / JPEG / WEBP 图片。", true);
      return null;
    }
    if (file.size > MAX_PRESET_IMAGE_BYTES) {
      setStatus(`图片过大，不能超过 ${Math.round(MAX_PRESET_IMAGE_BYTES / 1024 / 1024)} MB`, true);
      return null;
    }
    setStatus(`正在为「${preset.name}」保存高清封面图…`);
    const dataUrl = await blobToDataUrl(file);
    let thumb = null;
    try {
      thumb = await makeThumbnailDataUrl(dataUrl);
    } catch {
      thumb = null;
    }
    const saved = await api.savePreset({
      id: preset.id,
      name: preset.name,
      category: preset.category || "通用",
      tags: preset.tags || [],
      width: preset.width,
      height: preset.height,
      prompts: preset.prompts || {},
      draft: preset.draft || {},
      thumbnail: thumb,
      image_data: dataUrl,
    });
    setStatus(`✓ 已为「${preset.name}」更换预览封面图`);
    await loadPresets();
    return saved;
  }

  coverFileInput.addEventListener("change", async () => {
    const file = coverFileInput.files?.[0];
    coverFileInput.value = "";
    const target = pendingCoverPreset;
    const cb = pendingCoverDone;
    pendingCoverPreset = null;
    pendingCoverDone = null;
    if (!file || !target) return;
    try {
      const updated = await attachCoverImageToPreset(target, file);
      if (updated) cb?.(updated);
    } catch (err) {
      reportLibError(err, "更换封面");
    }
  });

  // Drag & drop external image files ONLY on main pane
  let dragCounter = 0;
  function hasExternalFiles(ev) {
    const types = Array.from(ev.dataTransfer?.types || []);
    return types.includes("Files") && !types.includes("text/aps-preset-id");
  }

  mainPane.addEventListener("dragenter", (ev) => {
    if (!hasExternalFiles(ev)) return;
    ev.preventDefault();
    dragCounter++;
    const destCat = currentCategory === "全部" ? "通用" : currentCategory;
    dropTitle.textContent = `📥 松开鼠标立即导入图片预设至「${destCat}」`;
    dropOverlay.hidden = false;
    dropOverlay.classList.add("is-visible");
  });
  mainPane.addEventListener("dragover", (ev) => {
    if (!hasExternalFiles(ev)) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
  });
  mainPane.addEventListener("dragleave", (ev) => {
    if (!dropOverlay.classList.contains("is-visible")) return;
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0 || (ev.relatedTarget && !mainPane.contains(ev.relatedTarget))) {
      hideDropOverlay();
    }
  });
  mainPane.addEventListener("drop", async (ev) => {
    if (!hasExternalFiles(ev)) return;
    ev.preventDefault();
    hideDropOverlay();
    const files = Array.from(ev.dataTransfer?.files || []).filter((f) =>
      ["image/png", "image/jpeg", "image/webp"].includes(f.type),
    );
    if (!files.length) {
      setStatus("仅支持拖入 PNG / JPEG / WEBP 图片文件。", true);
      return;
    }
    await importImageFiles(files);
  });

  importImgBtn.addEventListener("click", () => imgFileInput.click());
  imgFileInput.addEventListener("change", async () => {
    const files = Array.from(imgFileInput.files || []);
    imgFileInput.value = "";
    if (files.length) await importImageFiles(files);
  });

  async function loadCategories() {
    try {
      const res = await api.listPresetCategories();
      allCategories = Array.isArray(res?.categories) && res.categories.length ? res.categories : ["通用"];
      customCategories = Array.isArray(res?.custom) ? res.custom : [];
    } catch {
      // keep existing
    }
    if (currentCategory !== "全部" && !allCategories.includes(currentCategory)) {
      const match = allCategories.find((c) => c === currentCategory || c.startsWith(currentCategory + "/"));
      if (!match) currentCategory = "全部";
    }
    renderTree();
    updateBreadcrumbs();
  }

  async function loadPresets() {
    setStatus("正在获取预设…");
    try {
      const res = await api.listPresets();
      presetsList = Array.isArray(res?.presets) ? res.presets : [];
      setStatus(`共加载 ${presetsList.length} 个构图提示词预设 · 支持拖入生成图直接导入 · 支持拖动卡片到左侧目录归类`);
      renderTree();
      filterAndRenderCards();
    } catch (err) {
      reportLibError(err, "加载预设");
    }
  }

  async function movePreset(preset, category) {
    try {
      await api.savePreset({
        id: preset.id,
        name: preset.name,
        category,
        tags: preset.tags,
        width: preset.width,
        height: preset.height,
        prompts: preset.prompts,
        draft: preset.draft,
        thumbnail: preset.thumbnail,
      });
      setStatus(`已把「${preset.name}」移到目录「${category}」。`);
      await loadCategories();
      await loadPresets();
    } catch (err) {
      reportLibError(err, "移动预设");
      await loadPresets();
    }
  }

  function getPresetPromptSegments(preset) {
    const p = preset?.prompts || {};
    const stages = Array.isArray(p.stages) ? p.stages : [];
    const segs = [];

    if (stages.length > 0) {
      for (const st of stages) {
        const idx = st.index || segs.length + 1;
        const title = String(st.title || `第 ${idx} 段`).trim();
        const dan = String(st.danbooru || "").trim();
        const cap = String(st.caption || "").trim();
        const raw = String(st.raw_text || "").trim();

        let tabLabel = stages.length === 1 ? "" : `${idx}️⃣ `;
        let bodyText = "";
        let copyText = "";

        if (st.format === "danbooru" || (dan && !cap)) {
          tabLabel += stages.length === 1 ? "标签词" : `第${idx}段·标签`;
          bodyText = dan || raw;
          copyText = dan || raw;
        } else if (st.format === "hybrid" && cap && dan) {
          if (stages.length === 1) {
            segs.push({
              tabLabel: "标签词",
              fullTitle: `标签提示词 (Danbooru) · ${title}`,
              text: dan,
              previewText: dan,
              kind: "danbooru",
              nodeTitle: title,
            });
            segs.push({
              tabLabel: "描述词",
              fullTitle: `自然语言描述 (Caption) · ${title}`,
              text: cap,
              previewText: cap,
              kind: "caption",
              nodeTitle: title,
            });
            continue;
          } else {
            const firstDan = String(stages[0]?.danbooru || "").replace(/^@[^,]+,\s*/, "");
            const hasNewTags = dan && (!firstDan || !firstDan.includes(dan.slice(0, 60)));
            tabLabel += `第${idx}段·描述`;
            bodyText = cap;
            copyText = hasNewTags ? `${cap}\n\n[附带标签词]\n${dan}` : cap;
          }
        } else {
          tabLabel += stages.length === 1 ? "描述词" : `第${idx}段·描述`;
          bodyText = cap || dan || raw;
          copyText = cap || dan || raw;
        }

        if (bodyText) {
          segs.push({
            tabLabel,
            fullTitle: stages.length > 1 ? `第 ${idx} 段 · ${title}` : `${tabLabel} · ${title}`,
            text: copyText || bodyText,
            previewText: bodyText,
            kind: st.format || "caption",
            nodeTitle: title,
          });
        }
      }
    }

    if (segs.length === 0) {
      if (p.danbooru) {
        segs.push({
          tabLabel: "标签词",
          fullTitle: "标签提示词 (Danbooru)",
          text: String(p.danbooru),
          previewText: String(p.danbooru),
          kind: "danbooru",
        });
      }
      if (p.caption) {
        segs.push({
          tabLabel: "描述词",
          fullTitle: "自然语言描述 (Caption)",
          text: String(p.caption),
          previewText: String(p.caption),
          kind: "caption",
        });
      }
    }

    return segs;
  }

  function downloadPresetImage(preset) {
    const a = document.createElement("a");
    a.href = api.presetImageUrl(preset.id);
    a.download = `${String(preset.name || "preset").replace(/[\\/:*?"<>|]+/g, "_")}.png`;
    document.body.append(a);
    a.click();
    a.remove();
  }

  function openPresetLightbox(preset) {
    const lb = el("div", "aps-lightbox-overlay notranslate");
    const card = el("div", "aps-lightbox-card");

    const topHead = el("div", "aps-lightbox-head");
    const titleSpan = el("div", "aps-modal-title", `${preset.name} (${preset.width || 1024}×${preset.height || 1024})`);
    const closeLbBtn = el("button", "aps-btn aps-btn-sm", "✕ 关闭");
    closeLbBtn.type = "button";
    topHead.append(titleSpan, closeLbBtn);

    const media = el("div", "aps-lightbox-media");
    function renderMedia(curPreset) {
      media.textContent = "";
      const hasImg = Boolean(curPreset.has_image || curPreset.thumbnail);
      if (hasImg) {
        const bigImg = el("img", "");
        bigImg.src = curPreset.has_image ? api.presetImageUrl(curPreset.id) : curPreset.thumbnail;
        bigImg.alt = curPreset.name;
        bigImg.onerror = () => {
          media.textContent = "";
          media.append(renderPresetThumbnailSvg(curPreset));
        };
        media.append(bigImg);
      } else {
        media.append(renderPresetThumbnailSvg(curPreset));
      }
    }
    renderMedia(preset);

    const infoBody = el("div", "aps-lightbox-body");

    function renderLightboxPrompts(curPreset) {
      infoBody.textContent = "";
      const segs = getPresetPromptSegments(curPreset);

      for (const seg of segs) {
        const sec = el("div", "aps-lightbox-prompt-section");
        const secHead = el("div", "aps-lightbox-sec-head");
        secHead.append(el("span", "aps-lightbox-sec-title", seg.fullTitle));
        const copySegBtn = el("button", "aps-btn aps-btn-xs", "复制本段");
        copySegBtn.type = "button";
        copySegBtn.addEventListener("click", async () => {
          await navigator.clipboard.writeText(seg.text);
          copySegBtn.textContent = "✓ 已复制";
          setTimeout(() => (copySegBtn.textContent = "复制本段"), 1500);
        });
        secHead.append(copySegBtn);
        const box = el("div", "aps-lightbox-prompt", seg.text);
        sec.append(secHead, box);
        infoBody.append(sec);
      }

      if (curPreset.prompts?.layout) {
        const laySec = el("div", "aps-lightbox-prompt-section");
        const secHead = el("div", "aps-lightbox-sec-head");
        secHead.append(el("span", "aps-lightbox-sec-title", "📐 结构化构图 JSON (Layout)"));
        const copyLayBtn = el("button", "aps-btn aps-btn-xs", "复制构图 JSON");
        copyLayBtn.type = "button";
        copyLayBtn.addEventListener("click", async () => {
          await navigator.clipboard.writeText(curPreset.prompts.layout);
          copyLayBtn.textContent = "✓ 已复制";
          setTimeout(() => (copyLayBtn.textContent = "复制构图 JSON"), 1500);
        });
        secHead.append(copyLayBtn);
        const layBox = el("div", "aps-lightbox-prompt", curPreset.prompts.layout);
        laySec.append(secHead, layBox);
        infoBody.append(laySec);
      }

      if (segs.length === 0 && !curPreset.prompts?.layout) {
        infoBody.append(el("div", "aps-lightbox-prompt", "（无文本提示词）"));
      }
    }
    renderLightboxPrompts(preset);

    const footBar = el("div", "aps-lightbox-foot");
    const uploadCoverBtn = el("button", "aps-btn aps-btn-sm", "上传/更换预览图");
    uploadCoverBtn.type = "button";
    uploadCoverBtn.addEventListener("click", () => {
      pendingCoverPreset = preset;
      pendingCoverDone = (updated) => renderMedia(updated);
      coverFileInput.click();
    });
    footBar.append(uploadCoverBtn);

    const refineTitleBtn = el("button", "aps-btn aps-btn-sm", "精炼标题");
    refineTitleBtn.type = "button";
    refineTitleBtn.title = "自动从提示词提炼 4~10 字的高级画面中文标题";
    refineTitleBtn.addEventListener("click", async () => {
      refineTitleBtn.disabled = true;
      refineTitleBtn.textContent = "⏳ 精炼中…";
      try {
        const res = await api.summarizePresetTitle({ presetId: preset.id });
        if (res && res.title) {
          preset.name = res.title;
          titleSpan.textContent = `${preset.name} (${preset.width || 1024}×${preset.height || 1024})`;
          filterAndRenderCards();
          setStatus(`✓ 已将标题精炼为：「${res.title}」`);
        }
      } catch (e) {
        reportLibError(e, "精炼标题");
      } finally {
        refineTitleBtn.disabled = false;
        refineTitleBtn.textContent = "精炼标题";
      }
    });
    footBar.append(refineTitleBtn);

    if (preset.has_image) {
      const reloadMetaBtn = el("button", "aps-btn aps-btn-sm aps-accent", "重新提取原图元数据");
      reloadMetaBtn.type = "button";
      reloadMetaBtn.title = "精准回溯原图内嵌的 ComfyUI 执行链路，100% 还原真实出图提示词与构图画框";
      reloadMetaBtn.addEventListener("click", async () => {
        reloadMetaBtn.disabled = true;
        reloadMetaBtn.textContent = "⏳ 正在提取…";
        setStatus(`正在从「${preset.name}」原图精准回溯解析元数据…`);
        try {
          const res = await api.reloadPresetMetadata(preset.id);
          if (res && res.preset) {
            Object.assign(preset, res.preset);
            titleSpan.textContent = `${preset.name} (${preset.width || 1024}×${preset.height || 1024})`;
            renderLightboxPrompts(preset);
            renderMedia(preset);
            filterAndRenderCards();
            setStatus(`✓ 已精准提取原图元数据并更新：「${preset.name}」`);
          }
        } catch (e) {
          reportLibError(e, "提取原图元数据");
        } finally {
          reloadMetaBtn.disabled = false;
          reloadMetaBtn.textContent = "重新提取原图元数据";
        }
      });
      footBar.append(reloadMetaBtn);

      const dlBtn = el("button", "aps-btn aps-btn-sm", "📥 下载原图（含元数据）");
      dlBtn.type = "button";
      dlBtn.addEventListener("click", () => downloadPresetImage(preset));
      footBar.append(dlBtn);
    }

    const applyNowBtn = el("button", "aps-btn aps-btn-sm aps-primary", "一键应用此预设");
    applyNowBtn.type = "button";
    applyNowBtn.addEventListener("click", () => {
      lb.remove();
      onApply?.(preset);
      close();
    });
    footBar.append(applyNowBtn);

    card.append(topHead, media, infoBody, footBar);
    lb.append(card);
    overlay.append(lb);

    closeLbBtn.addEventListener("click", () => lb.remove());
    lb.addEventListener("click", (e) => {
      if (e.target === lb) lb.remove();
    });
  }

  function filterAndRenderCards() {
    gridContainer.textContent = "";
    const kw = searchInput.value.trim().toLowerCase();

    const filtered = presetsList.filter((p) => {
      if (currentCategory !== "全部") {
        const cat = p.category || "通用";
        if (cat !== currentCategory && !cat.startsWith(currentCategory + "/")) {
          return false;
        }
      }
      if (kw) {
        const textToSearch = [
          p.name,
          p.category,
          Array.isArray(p.tags) ? p.tags.join(" ") : "",
          p.prompts?.caption || "",
          p.prompts?.danbooru || "",
        ]
          .join(" ")
          .toLowerCase();
        if (!textToSearch.includes(kw)) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      const emptyEl = el(
        "div",
        "aps-preset-empty",
        currentCategory === "全部"
          ? "未找到匹配的构图预设。可点上方「🖼 导入图片预设」或直接将生成图拖进此处。"
          : `目录「${currentCategory}」下暂无预设。可将生成的图片拖入此处立即自动创建预设。`,
      );
      gridContainer.append(emptyEl);
      return;
    }

    const buildCard = (preset) => {
      const card = el("div", "aps-preset-card");
      card.draggable = true;
      card.addEventListener("dragstart", (ev) => {
        if (ev.dataTransfer) {
          ev.dataTransfer.setData("text/aps-preset-id", preset.id);
          ev.dataTransfer.effectAllowed = "move";
        }
      });

      // 1. Thumbnail Stage (Visual image preview if exists, or stylized composition SVG)
      const stageWrap = el("div", "aps-preset-stage-wrap");
      const hasImg = Boolean(preset.thumbnail || preset.has_image);
      if (hasImg) {
        stageWrap.classList.add("has-image");
        const img = el("img", "aps-preset-card-img");
        img.src = preset.thumbnail || api.presetImageUrl(preset.id);
        img.alt = preset.name;
        img.loading = "lazy";
        img.onerror = () => {
          img.remove();
          stageWrap.append(renderPresetThumbnailSvg(preset));
        };
        stageWrap.append(img);
        stageWrap.append(el("span", "aps-preset-image-flag", "含原图"));
      } else {
        const svg = renderPresetThumbnailSvg(preset);
        stageWrap.append(svg);
      }
      stageWrap.title = "点击查看大图预览 / 更换封面图";
      stageWrap.addEventListener("click", () => openPresetLightbox(preset));

      // Ratio badge on top of stage
      const w = Number(preset.width) || 1024;
      const h = Number(preset.height) || 1024;
      const ratio = (w / h).toFixed(2);
      const ratioBadge = el("span", "aps-preset-ratio-badge", `${w}×${h} · ${ratio}:1`);
      stageWrap.append(ratioBadge);
      card.append(stageWrap);

      // 2. Info area
      const infoWrap = el("div", "aps-preset-info-wrap");

      const titleRow = el("div", "aps-preset-title-row");
      const titleEl = el("div", "aps-preset-title", preset.name);
      titleEl.title = preset.name;
      titleRow.append(titleEl);

      const refineBtn = el("button", "aps-btn aps-btn-xs aps-preset-title-refine-btn", "");
      refineBtn.type = "button";
      refineBtn.title = "自动从提示词精炼中文标题";
      refineBtn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        refineBtn.disabled = true;
        refineBtn.textContent = "⏳";
        try {
          const res = await api.summarizePresetTitle({ presetId: preset.id });
          if (res && res.title) {
            preset.name = res.title;
            titleEl.textContent = res.title;
            titleEl.title = res.title;
            setStatus(`✓ 已将标题精炼为：「${res.title}」`);
          }
        } catch (e) {
          reportLibError(e, "精炼标题");
        } finally {
          refineBtn.disabled = false;
          refineBtn.textContent = "";
        }
      });
      titleRow.append(refineBtn);

      if (preset.is_builtin) {
        titleRow.append(el("span", "aps-preset-builtin-badge", "★ 官方经典"));
      }
      infoWrap.append(titleRow);

      // Category & Tags
      const segs = getPresetPromptSegments(preset);
      const tagsRow = el("div", "aps-preset-tags-row");
      tagsRow.append(el("span", "aps-preset-cat-tag", preset.category || "通用"));
      if (segs.length >= 3) {
        tagsRow.append(el("span", "aps-preset-mini-tag", `#${segs.length}段提示词`));
      } else if (segs.length === 2) {
        tagsRow.append(el("span", "aps-preset-mini-tag", "#双模提示词"));
      } else if (preset.prompts?.danbooru) {
        tagsRow.append(el("span", "aps-preset-mini-tag", "#Danbooru"));
      } else if (preset.prompts?.caption) {
        tagsRow.append(el("span", "aps-preset-mini-tag", "#自然语言"));
      }
      if (Array.isArray(preset.tags)) {
        for (const t of preset.tags.slice(0, 3)) {
          tagsRow.append(el("span", "aps-preset-mini-tag", `#${t}`));
        }
      }
      infoWrap.append(tagsRow);

      // Prompt preview (adaptive 1 / 2 / 3+ segments)
      const promptBox = el("div", "aps-preset-card-snippet-box");
      if (segs.length >= 2) {
        const tabRow = el("div", "aps-preset-card-prompt-tabs");
        const tabBtns = [];
        const firstPreview = segs[0].previewText || segs[0].text;
        const promptSnippet = el("div", "aps-preset-card-snippet", firstPreview);
        promptBox.title = firstPreview;

        segs.forEach((seg, idx) => {
          const btn = el("button", `aps-preset-card-prompt-tab${idx === 0 ? " active" : ""}`, seg.tabLabel);
          btn.type = "button";
          btn.title = seg.fullTitle || seg.tabLabel;
          btn.addEventListener("click", (e) => {
            e.stopPropagation();
            for (const b of tabBtns) b.classList.remove("active");
            btn.classList.add("active");
            const txt = seg.previewText || seg.text;
            promptSnippet.textContent = txt;
            promptBox.title = txt;
          });
          tabBtns.push(btn);
          tabRow.append(btn);
        });

        promptBox.append(tabRow, promptSnippet);
      } else {
        const capText = segs.length === 1 ? (segs[0].previewText || segs[0].text) : "（无文本提示词）";
        const promptSnippet = el("div", "aps-preset-card-snippet", capText);
        promptBox.title = capText;
        promptBox.append(promptSnippet);
      }
      infoWrap.append(promptBox);

      card.append(infoWrap);

      // 3. Action bar
      const cardActions = el("div", "aps-preset-card-actions");

      const applyBtn = el("button", "aps-btn aps-primary aps-preset-apply-btn", "应用");
      applyBtn.type = "button";
      applyBtn.title = "将此构图画框、提示词与推荐尺寸应用到当前节点";
      applyBtn.addEventListener("click", () => {
        onApply?.(preset);
        close();
      });

      const copyBtn = el("button", "aps-btn aps-btn-sm aps-preset-copy-btn", "");
      copyBtn.type = "button";
      copyBtn.title = "复制提示词到剪贴板";
      copyBtn.addEventListener("click", async () => {
        let textToCopy = "";
        if (segs.length >= 2) {
          textToCopy = segs.map((s) => `【${s.fullTitle}】\n${s.text}`).join("\n\n");
        } else if (segs.length === 1) {
          textToCopy = segs[0].text;
        }
        if (textToCopy) {
          try {
            await navigator.clipboard.writeText(textToCopy);
            copyBtn.textContent = "✓";
            setTimeout(() => (copyBtn.textContent = ""), 1500);
          } catch {
            await openInlinePromptDialog({
              title: "复制提示词",
              message: "请按 Ctrl+C 复制下面提示词：",
              initialValue: textToCopy,
              confirmLabel: "完成",
            });
          }
        }
      });

      cardActions.append(applyBtn, copyBtn);

      if (preset.has_image) {
        const reloadMetaBtn = el("button", "aps-btn aps-btn-sm aps-preset-recap-card-btn", "");
        reloadMetaBtn.type = "button";
        reloadMetaBtn.title = "重新从原图元数据中精准提取真实提示词与构图";
        reloadMetaBtn.addEventListener("click", async () => {
          reloadMetaBtn.disabled = true;
          reloadMetaBtn.textContent = "⏳";
          setStatus(`正在从「${preset.name}」原图精准提取元数据…`);
          try {
            const res = await api.reloadPresetMetadata(preset.id);
            if (res && res.preset) {
              Object.assign(preset, res.preset);
              setStatus(`✓ 已精准还原原图元数据：「${preset.name}」`);
              filterAndRenderCards();
            }
          } catch (e) {
            reportLibError(e, "提取元数据");
          } finally {
            reloadMetaBtn.disabled = false;
            reloadMetaBtn.textContent = "";
          }
        });
        cardActions.append(reloadMetaBtn);

        const imgBtn = el("button", "aps-btn aps-btn-sm aps-preset-img-btn", "📥");
        imgBtn.type = "button";
        imgBtn.title = "下载含完整 ComfyUI 元数据的原图";
        imgBtn.addEventListener("click", () => downloadPresetImage(preset));
        cardActions.append(imgBtn);
      } else {
        const addCoverBtn = el("button", "aps-btn aps-btn-sm aps-preset-img-btn", "");
        addCoverBtn.type = "button";
        addCoverBtn.title = "上传一张图片作为此预设的封面图";
        addCoverBtn.addEventListener("click", () => {
          pendingCoverPreset = preset;
          pendingCoverDone = null;
          coverFileInput.click();
        });
        cardActions.append(addCoverBtn);
      }

      // Move category selector
      const moveSel = el("select", "aps-select aps-preset-move-select");
      moveSel.title = "移动到其他目录";
      for (const c of allCategories) {
        const opt = el("option", "", `📁 ${c}`);
        opt.value = c;
        if (c === preset.category) opt.selected = true;
        moveSel.append(opt);
      }
      moveSel.addEventListener("change", () => {
        if (moveSel.value && moveSel.value !== preset.category) {
          void movePreset(preset, moveSel.value);
        }
      });
      cardActions.append(moveSel);

      // Delete button: Available for ALL presets!
      const delBtn = el("button", "aps-btn aps-btn-sm aps-preset-del-btn", "🗑");
      delBtn.type = "button";
      delBtn.title = `删除预设「${preset.name}」`;
      delBtn.addEventListener("click", async () => {
        const isBuiltin = preset.is_builtin;
        const msg = isBuiltin
          ? `确定要删除官方预设「${preset.name}」吗？（可在左侧下方点击「↺ 恢复官方预设」重新恢复）`
          : `确定要删除预设「${preset.name}」吗？`;
        const ok = await openInlineConfirmDialog({
          title: "删除预设",
          message: msg,
          confirmLabel: "删除",
          danger: true,
        });
        if (!ok) return;
        try {
          await api.deletePreset(preset.id);
          setStatus(`已删除预设「${preset.name}」。`);
          await loadPresets();
        } catch (err) {
          reportLibError(err, "删除预设");
        }
      });
      cardActions.append(delBtn);

      card.append(cardActions);
      return card;
    };

    for (const preset of filtered) {
      try {
        gridContainer.append(buildCard(preset));
      } catch (cardErr) {
        console.warn("[ai-prompt-studio] failed to render preset", preset?.id, cardErr);
        const broken = el("div", "aps-preset-card aps-preset-card-broken");
        broken.append(
          el(
            "div",
            "aps-preset-info-wrap",
            `预设「${preset?.name || preset?.id || "?"}」无法显示：${cardErr?.message || cardErr}`,
          ),
        );
        gridContainer.append(broken);
      }
    }
  }

  searchInput.addEventListener("input", filterAndRenderCards);

  // Export JSON
  exportBtn.addEventListener("click", async () => {
    try {
      const res = await api.exportPresets();
      const list = res?.presets || [];
      const blob = new Blob([JSON.stringify(list, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = el("a");
      a.href = url;
      a.download = `comfyui_prompt_presets_${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setStatus(`已成功导出 ${list.length} 个预设到 JSON 文件`);
    } catch (err) {
      reportLibError(err, "导出预设");
    }
  });

  // Import JSON
  importJsonBtn.addEventListener("click", () => jsonFileInput.click());
  jsonFileInput.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const items = Array.isArray(json) ? json : json.presets;
      if (!Array.isArray(items)) {
        throw new Error("JSON 格式不正确，缺少预设数组。");
      }
      setStatus(`正在导入 ${items.length} 个预设…`);
      const res = await api.importPresets(items);
      setStatus(`✓ 成功导入 ${res.imported} 个预设！`);
      await loadCategories();
      await loadPresets();
    } catch (err) {
      reportLibError(err, "导入 JSON");
    } finally {
      jsonFileInput.value = "";
    }
  });

  loadCategories();
  loadPresets();

  return { close };
}

/**
 * Modal for importing any finished prompt (MOSS Layout JSON, natural prose / <|...|> blocks, or Danbooru tags)
 * and automatically completing all selected output formats (prose caption, layout JSON + SVG boxes, danbooru tags).
 */
export function openImportPromptModal({
  api: suppliedApi = null,
  initialText = "",
  initialModes = ["caption", "layout", "danbooru"],
  initialMode = "layout",
  initialWidth = 1024,
  initialHeight = 1024,
  model = "",
  extraInstruction = "",
  onApply = null,
} = {}) {
  const api = suppliedApi || new StudioApi();
  const overlay = el("div", "aps-modal-overlay aps-import-modal-overlay notranslate");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("translate", "no");
  const themedEl = typeof document !== "undefined" ? document.querySelector?.("[data-theme]") : null;
  if (themedEl?.dataset?.theme === "light") {
    overlay.dataset.theme = "light";
  }

  const modal = el("div", "aps-modal aps-import-prompt-modal notranslate");
  modal.setAttribute("translate", "no");

  // Header
  const head = el("div", "aps-modal-head aps-wb-head");
  const titleWrap = el("div", "aps-wb-brand");
  titleWrap.append(
    el("span", "aps-logo", ""),
    el("div", "aps-modal-title", "导入成品提示词并智能补全"),
  );
  const closeTopBtn = el("button", "aps-btn aps-btn-sm", "✕ 关闭");
  closeTopBtn.type = "button";
  head.append(titleWrap, closeTopBtn);
  modal.append(head);

  // Body
  const body = el("div", "aps-import-body");

  const inputField = el("div", "aps-import-field");
  const inputHead = el("div", "aps-import-label-row");
  inputHead.append(
    el("span", "aps-import-label", "粘贴你已有的成品提示词（Layout JSON / 自然语言 / MOSS 分块 / Danbooru 标签）"),
  );
  const detectBadge = el("span", "aps-import-detect-badge", "等待输入");
  inputHead.append(detectBadge);

  const textarea = el("textarea", "aps-modal-textarea aps-import-textarea");
  textarea.rows = 7;
  textarea.value = String(initialText || "");
  textarea.placeholder = [
    "示例 1（MOSS Layout JSON / abs_centralized yxyx）：",
    '{"summary":{"caption":"..."},"items":[{"label":"character","caption":"...","bbox":[-480,-360,520,280]}],"bbox_coord_space":"abs_centralized","bbox_format":"yxyx"}',
    "",
    "示例 2（自然语言 / MOSS 分块）：A candid 35mm film portrait of a young woman... 或 中文画面描述",
    "示例 3（Danbooru 标签）：1girl, solo, silver_hair, blue_eyes, neon_city, rain",
  ].join("\n");
  inputField.append(inputHead, textarea);
  body.append(inputField);

  // Source format selector
  const ALL = ["caption", "layout", "danbooru"];
  const canon = (m) => (m === "hybrid" ? "danbooru" : m);
  let explicitSource = "auto";
  const initialSet = new Set(
    (Array.isArray(initialModes) && initialModes.length ? initialModes : [initialMode])
      .map(canon)
      .filter((m) => ALL.includes(m)),
  );
  if (!initialSet.size) initialSet.add("caption");
  let targetModes = ALL.filter((m) => initialSet.has(m));

  const controlsGrid = el("div", "aps-import-controls");

  // Row 1: Source Type override
  const srcGroup = el("div", "aps-import-control-group");
  srcGroup.append(el("div", "aps-import-control-label", "输入格式识别"));
  const srcBtnsWrap = el("div", "aps-seg-group aps-import-src-group");
  const srcBtns = {};
  for (const [sVal, sLabel] of [
    ["auto", "🤖 自动识别"],
    ["layout", "📐 Layout JSON"],
    ["caption", "自然语言"],
    ["danbooru", "🔖 Danbooru"],
  ]) {
    const b = el("button", `aps-seg-btn${sVal === "auto" ? " is-active" : ""}`, sLabel);
    b.type = "button";
    b.addEventListener("click", () => {
      explicitSource = sVal;
      for (const [k, btn] of Object.entries(srcBtns)) {
        btn.classList.toggle("is-active", k === explicitSource);
      }
      refreshInspector();
    });
    srcBtns[sVal] = b;
    srcBtnsWrap.append(b);
  }
  srcGroup.append(srcBtnsWrap);
  controlsGrid.append(srcGroup);

  // Row 2: Target Formats checkboxes
  const tgtGroup = el("div", "aps-import-control-group");
  tgtGroup.append(el("div", "aps-import-control-label", "要补全并输出到节点的格式（多选）"));
  const tgtRow = el("div", "aps-import-targets-row");
  const tgtChecks = {};
  for (const [mKey, mLabel] of [
    ["caption", "散文 (caption_prompt)"],
    ["layout", "📐 布局 + 画框 (layout_prompt)"],
    ["danbooru", "🔖 Danbooru (danbooru_prompt)"],
  ]) {
    const lbl = el("label", "aps-import-check-pill");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = targetModes.includes(mKey);
    lbl.classList.toggle("is-checked", cb.checked);
    cb.addEventListener("change", () => {
      const checked = ALL.filter((k) => tgtChecks[k].checked);
      if (!checked.length) {
        cb.checked = true;
        return;
      }
      targetModes = checked;
      for (const k of ALL) {
        tgtChecks[k].parentElement.classList.toggle("is-checked", tgtChecks[k].checked);
      }
      refreshInspector();
    });
    lbl.append(cb, el("span", "", mLabel));
    tgtChecks[mKey] = cb;
    tgtRow.append(lbl);
  }
  tgtGroup.append(tgtRow);
  controlsGrid.append(tgtGroup);

  // Row 3: Canvas Size Policy
  const sizeGroup = el("div", "aps-import-control-group");
  sizeGroup.append(el("div", "aps-import-control-label", "画布尺寸（MOSS 16 倍数）"));
  const sizeSelect = el("select", "aps-select aps-import-size-select");
  const initW = Math.max(256, Number(initialWidth) || 1024);
  const initH = Math.max(256, Number(initialHeight) || 1024);
  const autoOpt = el("option", "", `自动（Layout 按坐标推断 / 否则沿用 ${initW}×${initH}）`);
  autoOpt.value = "auto";
  sizeSelect.append(autoOpt);
  const sizeKeys = new Set();
  for (const [pw, ph, pLabel] of [[initW, initH, `当前节点 · ${initW}×${initH}`], ...MOSS_CANVAS_PRESETS]) {
    const key = `${pw}x${ph}`;
    if (sizeKeys.has(key)) continue;
    sizeKeys.add(key);
    const opt = el("option", "", pLabel);
    opt.value = key;
    sizeSelect.append(opt);
  }
  sizeSelect.value = "auto";
  sizeSelect.addEventListener("change", refreshInspector);
  sizeGroup.append(sizeSelect);
  controlsGrid.append(sizeGroup);

  body.append(controlsGrid);

  const hintBox = el("div", "aps-import-hint", "");
  body.append(hintBox);
  modal.append(body);

  // Footer
  const foot = el("div", "aps-modal-foot");
  foot.style.flexShrink = "0";
  foot.style.marginTop = "auto";
  foot.style.paddingTop = "10px";
  foot.style.borderTop = "1px solid var(--aps-border)";
  foot.style.background = "var(--aps-bg)";
  const statusEl = el("span", "aps-modal-status", "");
  const cancelBtn = el("button", "aps-btn", "取消");
  cancelBtn.type = "button";
  const localBtn = el("button", "aps-btn", "仅本地快速解析填入");
  localBtn.type = "button";
  localBtn.title = "不调用大模型，直接将当前输入解析填入对应格式（Layout JSON 可直接出画框）";
  const completeBtn = el("button", "aps-btn aps-primary", "补全选中格式并应用");
  completeBtn.type = "button";
  foot.append(statusEl, cancelBtn, localBtn, completeBtn);
  modal.append(foot);

  overlay.append(modal);
  document.body.append(overlay);

  let busy = false;
  let closed = false;

  function setStatus(msg, isError = false, titleText = "") {
    const txt = msg || "";
    statusEl.textContent = txt;
    statusEl.title = titleText || txt;
    statusEl.className = isError ? "aps-modal-status aps-error-text" : "aps-modal-status";
    statusEl.dataset.kind = isError ? "error" : (txt ? "ok" : "");
  }

  function resolveRequestedDimensions(info) {
    if (sizeSelect.value !== "auto" && sizeSelect.value.includes("x")) {
      const [ew, eh] = sizeSelect.value.split("x").map(Number);
      return { width: ew || initW, height: eh || initH, sizeMode: "explicit" };
    }
    if (info.sourceType === "layout" && info.hasJsonObject) {
      return { width: info.inferredSize[0], height: info.inferredSize[1], sizeMode: "auto" };
    }
    return { width: initW, height: initH, sizeMode: "auto" };
  }

  function refreshInspector() {
    const info = inspectFinishedPrompt(textarea.value, explicitSource, initW, initH);
    const sourceNames = {
      layout: "MOSS Layout JSON",
      caption: "自然语言 / MOSS 分块",
      danbooru: "Danbooru 标签",
    };

    if (info.empty) {
      detectBadge.textContent = "等待输入";
      detectBadge.dataset.kind = "";
      localBtn.disabled = true;
      hintBox.textContent =
        "填入你已有的成品提示词后：将原样保留你的源提示词，仅使用 AI 自动补全勾选的其余格式（并自动生成可拖拽画框）。";
      return info;
    }

    const srcLabel = sourceNames[info.sourceType] || info.sourceType;
    if (info.sourceType === "layout") {
      if (info.hasJsonObject) {
        detectBadge.textContent = `${explicitSource === "auto" ? "自动识别" : "指定"}：${srcLabel}（${info.itemCount} 框 · 推断 ${info.inferredSize[0]}×${info.inferredSize[1]}）`;
        detectBadge.dataset.kind = "ok";
      } else {
        detectBadge.textContent = "JSON 结构尚未闭合或语法有误";
        detectBadge.dataset.kind = "warn";
      }
    } else if (info.sourceType === "danbooru") {
      detectBadge.textContent = `${explicitSource === "auto" ? "自动识别" : "指定"}：${srcLabel}（${info.tagCount} 个标签）`;
      detectBadge.dataset.kind = "ok";
    } else {
      detectBadge.textContent = `${explicitSource === "auto" ? "自动识别" : "指定"}：${srcLabel}（约 ${info.wordCount} 词）`;
      detectBadge.dataset.kind = "ok";
    }

    localBtn.disabled = busy || (info.sourceType === "layout" && !info.hasJsonObject);

    const missing = targetModes.filter((m) => m !== info.sourceType);
    const modeTitle = { caption: "散文", layout: "布局+画框", danbooru: "Danbooru 标签" };
    if (missing.length === 0) {
      hintBox.textContent = `当前只勾选了与输入相同的「${modeTitle[info.sourceType]}」格式：无需调用 AI（0 次请求），点击即可直接解析并应用！`;
      completeBtn.textContent = "直接解析并应用（0 AI 消耗）";
    } else {
      const missingText = missing.map((m) => modeTitle[m]).join(" + ");
      hintBox.textContent = `将完整保留你的「${srcLabel}」，并调用 AI 自动补全：${missingText}。`;
      completeBtn.textContent = "补全选中格式并应用";
    }
    return info;
  }

  function buildLocalResult(rawText, info) {
    const { width: reqW, height: reqH, sizeMode } = resolveRequestedDimensions(info);
    if (info.sourceType === "layout") {
      const parsed = extractLayoutJsonObject(rawText);
      if (!parsed) {
        throw new Error("Layout JSON 解析失败：请检查花括号与引号语法是否正确。");
      }
      const internalDraft = decompileMossLayoutToDraft(parsed, reqW, reqH, null, {
        forceSize: sizeMode === "explicit",
      });
      const rw = internalDraft.width;
      const rh = internalDraft.height;
      const compiledObj = compileLayoutDraftForMoss(internalDraft, rw, rh);
      const layoutOut = JSON.stringify(compiledObj);
      const sumCap = cleanCaptionPreserveQuotesJs(String(internalDraft.summary?.caption || ""));
      const localModes = targetModes.includes("layout") ? targetModes : ["layout", ...targetModes];
      return {
        detected_source: "layout",
        width: rw,
        height: rh,
        modes: localModes,
        payload: {
          source: "imported_prompt",
          detected_source: "layout",
          mode: "layout",
          modes: localModes,
          width: rw,
          height: rh,
          caption: sumCap,
          caption_text: sumCap,
          draft: internalDraft,
          layout_draft: internalDraft,
          hybrid_draft: internalDraft,
          compiled_layout_prompt: layoutOut,
          layout_prompt: layoutOut,
        },
        outputs: {
          caption_prompt: sumCap,
          layout_prompt: layoutOut,
          danbooru_prompt: "",
        },
      };
    }

    let cleaned = rawText.trim();
    const fence = cleaned.match(/^```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)\s*```$/);
    if (fence) cleaned = fence[1].trim();

    if (info.sourceType === "danbooru") {
      const tags = cleaned
        .replace(/\r/g, "")
        .replace(/\n/g, ",")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .join(", ");
      const localModes = targetModes.includes("danbooru") ? targetModes : ["danbooru", ...targetModes];
      return {
        detected_source: "danbooru",
        width: reqW,
        height: reqH,
        modes: localModes,
        payload: {
          source: "imported_prompt",
          detected_source: "danbooru",
          mode: "danbooru",
          modes: localModes,
          width: reqW,
          height: reqH,
          danbooru_prompt: tags,
          danbooru_text: tags,
          tags,
        },
        outputs: {
          caption_prompt: "",
          layout_prompt: "",
          danbooru_prompt: tags,
        },
      };
    }

    const localModes = targetModes.includes("caption") ? targetModes : ["caption", ...targetModes];
    return {
      detected_source: "caption",
      width: reqW,
      height: reqH,
      modes: localModes,
      payload: {
        source: "imported_prompt",
        detected_source: "caption",
        mode: "caption",
        modes: localModes,
        width: reqW,
        height: reqH,
        caption: cleaned,
        caption_text: cleaned,
      },
      outputs: {
        caption_prompt: cleaned,
        layout_prompt: "",
        danbooru_prompt: "",
      },
    };
  }

  function setBusy(nextBusy, msg = "") {
    busy = nextBusy;
    textarea.disabled = nextBusy;
    sizeSelect.disabled = nextBusy;
    completeBtn.disabled = nextBusy;
    localBtn.disabled = nextBusy;
    for (const k of Object.keys(tgtChecks)) tgtChecks[k].disabled = nextBusy;
    for (const k of Object.keys(srcBtns)) srcBtns[k].disabled = nextBusy;
    if (msg) setStatus(msg);
  }

  async function handleSubmit({ localOnly = false } = {}) {
    if (busy) return;
    const rawText = textarea.value.trim();
    if (!rawText) {
      setStatus("请先填入成品提示词。", true);
      return;
    }
    const info = refreshInspector();
    if (info.sourceType === "layout" && !info.hasJsonObject) {
      setStatus("Layout JSON 无法解析，请检查 JSON 括号与引号是否完整。", true);
      return;
    }

    const missing = targetModes.filter((m) => m !== info.sourceType);
    if (localOnly || missing.length === 0) {
      try {
        const localRes = buildLocalResult(rawText, info);
        onApply?.(localRes);
        close();
      } catch (err) {
        setStatus(String(err?.message || err), true);
      }
      return;
    }

    const { width: reqW, height: reqH, sizeMode } = resolveRequestedDimensions(info);
    setBusy(true, `正在保留源提示词并调用 AI 补全选中格式（${targetModes.join(" + ")}）…`);
    try {
      const reqBody = {
        prompt: rawText,
        source_mode: explicitSource,
        modes: targetModes,
        width: reqW,
        height: reqH,
        size_mode: sizeMode,
        model,
        extra_instruction: extraInstruction,
      };
      const res =
        typeof api.completeFromPrompt === "function"
          ? await api.completeFromPrompt(reqBody)
          : await api.request("/complete_from_prompt", { method: "POST", body: reqBody });
      onApply?.(res);
      close();
    } catch (err) {
      const friendly = formatFriendlyError(err, "智能补全");
      const tech = formatErrorTechnicalDetail(err);
      setStatus(friendly, true, tech ? `${friendly}\n\n${tech}` : friendly);
    } finally {
      if (!closed) {
        setBusy(false);
        refreshInspector();
      }
    }
  }

  textarea.addEventListener("input", refreshInspector);
  localBtn.addEventListener("click", () => void handleSubmit({ localOnly: true }));
  completeBtn.addEventListener("click", () => void handleSubmit({ localOnly: false }));

  function close() {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  }
  function onKey(ev) {
    if (ev.key === "Escape" && !busy) {
      close();
    }
  }
  document.addEventListener("keydown", onKey);
  closeTopBtn.addEventListener("click", () => { if (!busy) close(); });
  cancelBtn.addEventListener("click", () => { if (!busy) close(); });
  overlay.addEventListener("pointerdown", (ev) => {
    if (ev.target === overlay && !busy) close();
  });

  refreshInspector();
  setTimeout(() => textarea.focus(), 20);
  return { close };
}

export const openStudioWorkbench = openLayoutEditor;
export const _test = {
  cloneDraft,
  clamp,
  computeAdaptiveLayoutMode,
  detectBoxDeletion,
  turnToMessages,
  extractLayoutJsonObject,
  matchMossCanvasSizeJs,
  inferCanvasSizeFromLayout,
  inferRegionNameJs,
  compileLayoutDraftForMoss,
  buildLayoutPrompt,
  decompileMossLayoutToDraft,
  detectFinishedPromptType,
  inspectFinishedPrompt,
  cleanCaptionPreserveQuotesJs,
};
