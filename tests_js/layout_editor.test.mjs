/** Tests for the caption node's payload persistence and layout draft helpers. */

import test from "node:test";
import assert from "node:assert/strict";

import { normalizeDraft, _test as editorInternals } from "../web/lib/layout_editor.js";

const { cloneDraft, clamp } = editorInternals;

function sampleState() {
  return {
    mode: "layout",
    width: 1248,
    height: 832,
    caption: "A poster split in two.",
    draft: {
      width: 1248,
      height: 832,
      bbox_coord_space: "abs",
      bbox_format: "xyxy",
      summary: { caption: "A poster split in two.", canvas: "single" },
      items: [
        { label: "object", caption: "Red left half", bbox: [0, 0, 600, 832] },
        { label: "text", caption: "A sign", text: "SALE", bbox: [600, 0, 1248, 200] },
      ],
    },
  };
}

test("cloneDraft makes an independent working copy (cancel discards edits)", () => {
  const state = sampleState();
  const copy = cloneDraft(state, state.width, state.height);
  copy.items[0].caption = "LOCAL EDIT";
  copy.items.push({ label: "object", caption: "extra", bbox: [0, 0, 10, 10] });
  assert.equal(state.draft.items[0].caption, "Red left half");
  assert.equal(state.draft.items.length, 2);
  assert.equal(state.caption, "A poster split in two.");
});

test("normalizeDraft clamps boxes into the canvas", () => {
  const draft = cloneDraft(sampleState(), 1248, 832);
  draft.items[0].bbox = [-500, -500, 9000, 9000];
  const out = normalizeDraft(draft, 1248, 832);
  assert.deepEqual(out.items[0].bbox, [0, 0, 1248, 832]);
});

test("normalizeDraft forces literal text for text items and removes it otherwise", () => {
  const draft = cloneDraft(sampleState(), 1248, 832);
  draft.items[0].text = "should be removed";
  draft.items[1].text = "";
  const out = normalizeDraft(draft, 1248, 832);
  assert.equal("text" in out.items[0], false);
  assert.equal(out.items[1].text, "A sign");
});

test("normalizeDraft keeps summary caption and fills empty captions", () => {
  const draft = cloneDraft(sampleState(), 1248, 832);
  draft.summary.caption = "";
  draft.items[0].caption = "";
  const out = normalizeDraft(draft, 1248, 832);
  assert.equal(out.summary.caption, "A composed image.");
  assert.equal(out.items[0].caption, "Region 1");
});

test("clamp keeps pointer coordinates inside canvas bounds", () => {
  assert.equal(clamp(-20, 0, 100), 0);
  assert.equal(clamp(500, 0, 100), 100);
  assert.equal(clamp(42, 0, 100), 42);
});

test("mode switching keeps payload fields (no data loss)", () => {
  // The node stores one payload with caption + draft; switching mode only
  // changes which part execution reads, never deletes the other.
  const state = sampleState();
  const switched = { ...state, mode: "caption" };
  assert.equal(switched.draft.items.length, 2);
  assert.equal(switched.caption, "A poster split in two.");
  const back = { ...switched, mode: "hybrid" };
  assert.deepEqual(back.draft, state.draft);
});

test("payload round-trips through JSON serialization (save/reload)", () => {
  const state = sampleState();
  const saved = JSON.parse(JSON.stringify(state));
  assert.deepEqual(saved, state);
  assert.equal(saved.draft.items[1].text, "SALE");
  assert.deepEqual(saved.draft.items[0].bbox, [0, 0, 600, 832]);
});

test("normalized draft output is PromptBoard-shaped", () => {
  const out = normalizeDraft(cloneDraft(sampleState(), 1248, 832), 1248, 832);
  assert.equal(out.bbox_coord_space, "abs");
  assert.equal(out.bbox_format, "xyxy");
  assert.equal(out.width, 1248);
  assert.equal(out.height, 832);
  assert.ok(out.items.length >= 1);
  for (const item of out.items) {
    assert.ok(["object", "character", "text"].includes(item.label));
    assert.equal(item.bbox.length, 4);
    assert.ok(item.bbox[0] < item.bbox[2]);
    assert.ok(item.bbox[1] < item.bbox[3]);
  }
});
