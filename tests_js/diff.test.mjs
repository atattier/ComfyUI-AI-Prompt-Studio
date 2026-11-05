import test from "node:test";
import assert from "node:assert/strict";

import {
  changeCount,
  describeOp,
  describeStats,
  excerpt,
  operationLabel,
  selectOps,
  summarizeBlocks,
} from "../web/lib/diff.js";

const blocks = [
  { type: "equal", text: "a cat," },
  { type: "change", before: "sunny", after: "rainy" },
  { type: "add", text: "35mm" },
];

test("summarises block types", () => {
  assert.deepEqual(summarizeBlocks(blocks), { equal: 1, add: 1, del: 0, change: 1 });
  assert.equal(changeCount(blocks), 2);
  assert.equal(describeStats(blocks), "1 处修改，1 处新增");
  assert.equal(describeStats([]), "没有变化");
});

test("selectOps keeps only checked indices and their order", () => {
  const changes = [{ op: "replace" }, { op: "append" }, { op: "delete" }];
  assert.deepEqual(selectOps(changes, [2, 0]), [{ op: "replace" }, { op: "delete" }]);
  assert.deepEqual(selectOps(changes, []), []);
  assert.deepEqual(selectOps(null, [0]), []);
});

test("operations carry readable labels", () => {
  assert.equal(operationLabel("replace"), "替换");
  assert.equal(operationLabel("weird"), "weird");
  assert.equal(describeOp({ op: "replace", before: "a", after: "b" }), "替换：a → b");
  assert.equal(describeOp({ op: "append", after: "tail" }), "追加：tail");
  assert.equal(describeOp({ op: "delete", before: "gone" }), "删除：gone");
});

test("excerpt flattens whitespace and truncates", () => {
  assert.equal(excerpt("a  b\nc"), "a b c");
  assert.equal(excerpt("x".repeat(80), 10).length, 10);
  assert.ok(excerpt("x".repeat(80), 10).endsWith("…"));
});
