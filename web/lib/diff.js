/**
 * Client-side helpers for the diff card.  The authoritative diff and the
 * validation of edit operations live on the server (`prompt_studio.diff`);
 * nothing here decides what may be applied.
 */

export const OPERATION_LABELS = {
  replace: "替换",
  delete: "删除",
  insert_after: "插入",
  append: "追加",
};

export const BLOCK_LABELS = {
  equal: "未变",
  add: "新增",
  del: "删除",
  change: "修改",
};

export function operationLabel(op) {
  return OPERATION_LABELS[String(op || "").toLowerCase()] || String(op || "修改");
}

export function blockLabel(type) {
  return BLOCK_LABELS[type] || "";
}

export function summarizeBlocks(blocks) {
  const counts = { equal: 0, add: 0, del: 0, change: 0 };
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const type = block && block.type;
    if (type in counts) counts[type] += 1;
  }
  return counts;
}

export function changeCount(blocks) {
  const counts = summarizeBlocks(blocks);
  return counts.add + counts.del + counts.change;
}

export function describeStats(blocks) {
  const counts = summarizeBlocks(blocks);
  const parts = [];
  if (counts.change) parts.push(`${counts.change} 处修改`);
  if (counts.add) parts.push(`${counts.add} 处新增`);
  if (counts.del) parts.push(`${counts.del} 处删除`);
  return parts.length ? parts.join("，") : "没有变化";
}

/**
 * Pick the operations the user checked.  Indices refer to the proposal's
 * `changes` array; invalid or unchecked indices are dropped.
 */
export function selectOps(changes, selected) {
  const list = Array.isArray(changes) ? changes : [];
  const keep = new Set(Array.isArray(selected) ? selected : []);
  return list.filter((_, index) => keep.has(index));
}

export function describeOp(op) {
  const label = operationLabel(op && op.op);
  const before = op && typeof op.before === "string" ? op.before : "";
  const after = op && typeof op.after === "string" ? op.after : "";
  if (!before) return `${label}：${after}`;
  if (!after) return `${label}：${before}`;
  return `${label}：${before} → ${after}`;
}

/** Short single-line excerpt used in history lists. */
export function excerpt(text, limit = 48) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit - 1)}…`;
}
