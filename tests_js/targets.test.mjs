import test from "node:test";
import assert from "node:assert/strict";

import {
  collectTargets,
  currentTarget,
  findImageNode,
  findTargetByKey,
  imageSource,
  isPromptWidget,
  nodeTitle,
  setWidgetText,
  targetKey,
  targetWire,
} from "../web/lib/targets.js";

function widget(name, value, type = "string") {
  const w = { name, value, type, callback: null };
  return w;
}

function node(id, widgets, extra = {}) {
  return {
    id,
    title: extra.title || `Node ${id}`,
    type: extra.type || "CLIPTextEncode",
    widgets,
    ...extra,
  };
}

function fakeApp(nodes, selected = []) {
  const selectedMap = {};
  for (const n of selected) selectedMap[n.id] = n;
  return {
    graph: { _nodes: nodes, dirty: 0, setDirtyCanvas() { this.dirty += 1; } },
    canvas: { selected_nodes: selectedMap },
  };
}

test("recognises common prompt widgets only", () => {
  assert.equal(isPromptWidget(widget("text", "hi")), true);
  assert.equal(isPromptWidget(widget("prompt", "hi")), true);
  assert.equal(isPromptWidget(widget("positive", "hi")), true);
  assert.equal(isPromptWidget(widget("text", "hi", "customtext")), true);
  assert.equal(isPromptWidget(widget("image", "a.png")), false);
  assert.equal(isPromptWidget(widget("seed", 1, "number")), false);
  assert.equal(isPromptWidget(widget("run", "", "button")), false);
  assert.equal(isPromptWidget(null), false);
});

test("targets list selected nodes first, without duplicates", () => {
  const a = node(1, [widget("text", "alpha")]);
  const b = node(2, [widget("text", "beta")]);
  const app = fakeApp([a, b], [b]);
  const targets = collectTargets(app);
  assert.deepEqual(targets.map((t) => t.text), ["beta", "alpha"]);
  assert.equal(targets[0].key, "node:2:text");
});

test("nodes without prompt widgets are skipped", () => {
  const app = fakeApp([node(1, [widget("seed", 3, "number")]), node(2, [widget("text", "x")])]);
  assert.equal(collectTargets(app).length, 1);
});

test("currentTarget prefers the selection and tolerates ambiguity", () => {
  const a = node(1, [widget("text", "alpha")]);
  const b = node(2, [widget("text", "beta")]);
  assert.equal(currentTarget(fakeApp([a, b], [a])).text, "alpha");
  assert.ok(currentTarget(fakeApp([a, b], [])) === null); // two candidates: no guess
  assert.ok(Boolean(currentTarget(fakeApp([a], []))));
});

test("findTargetByKey resolves a descriptor with a live widget", () => {
  const w = widget("text", "hello");
  const a = node(7, [w]);
  const app = fakeApp([a]);
  const found = findTargetByKey(app, "node:7:text");
  assert.equal(found.widgetRef, w);
  assert.equal(found.text, "hello");
  assert.equal(findTargetByKey(app, "node:7:image"), null);
  assert.equal(findTargetByKey(app, "garbage"), null);
});

test("setWidgetText writes the value, fires callbacks and repaints", () => {
  const calls = [];
  const w = widget("text", "before");
  const a = node(3, [w], {
    onWidgetChanged(name, value, before) {
      calls.push([name, value, before]);
    },
  });
  w.callback = (value) => calls.push(["widget", value]);
  const app = fakeApp([a]);
  const target = findTargetByKey(app, targetKey(a, w));
  const result = setWidgetText(app, target, "after");
  assert.deepEqual(result, { before: "before", changed: true });
  assert.equal(w.value, "after");
  assert.deepEqual(calls, [
    ["widget", "after"],
    ["text", "after", "before"],
  ]);
  assert.equal(app.graph.dirty, 1);
  assert.equal(setWidgetText(app, target, "after").changed, false);
});

test("imageSource reads previews and widget filenames", () => {
  const preview = node(1, [], { imgs: [{ src: "/view?filename=cat.png&type=input" }] });
  assert.deepEqual(imageSource(preview), { url: "/view?filename=cat.png&type=input" });
  const fileName = node(2, [widget("image", "dog.png")]);
  assert.deepEqual(imageSource(fileName), { url: null, filename: "dog.png" });
  assert.equal(imageSource(node(3, [])), null);
  assert.equal(findImageNode(fakeApp([node(3, []), preview], [preview])), preview);
});

test("targetWire drops live references so a real graph can be serialized", () => {
  const w = widget("text", "hello");
  const a = node(5, [w]);
  a.widgets[0].node = a; // circular, as on a real LiteGraph node
  const target = findTargetByKey(fakeApp([a]), targetKey(a, w));
  const wire = targetWire(target);
  assert.deepEqual(wire, { node_id: 5, widget: "text", title: "Node 5", text: "hello" });
  assert.equal(JSON.stringify(wire).includes("widgets"), false);
  assert.doesNotThrow(() => JSON.stringify(wire));
  assert.ok(targetWire(null) === null);
});

test("nodeTitle falls back through the usual fields", () => {
  assert.equal(nodeTitle({ title: "My Node" }), "My Node");
  assert.equal(nodeTitle({ type: "KSampler" }), "KSampler");
  assert.equal(nodeTitle(null), "节点");
});
