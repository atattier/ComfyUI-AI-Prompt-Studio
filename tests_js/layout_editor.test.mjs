/** Tests for the caption node's payload persistence and layout draft helpers. */

import test from "node:test";
import assert from "node:assert/strict";

import {
  OUTPUT_LANGUAGE_OPTIONS,
  PRESET_RULE_TEMPLATES,
  QUICK_RULE_TEMPLATES,
  RULE_PRESET_OPTIONS,
  normalizeDraft,
  renderSvgStage,
  _test as editorInternals,
} from "../web/lib/layout_editor.js";

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

test("renderSvgStage renders background reference image and region bounding boxes", () => {
  function fakeEl(tag) {
    return {
      tag,
      attrs: {},
      style: {},
      children: [],
      textContent: "",
      setAttribute(k, v) {
        this.attrs[k] = String(v);
      },
      append(...nodes) {
        this.children.push(...nodes);
      },
    };
  }
  const prevDoc = globalThis.document;
  globalThis.document = {
    createElementNS(_ns, tag) {
      return fakeEl(tag);
    },
  };
  try {
    const svg = fakeEl("svg");
    const state = sampleState();
    renderSvgStage(svg, {
      width: 1248,
      height: 832,
      draft: state.draft,
      imageUrl: "data:image/png;base64,AA==",
      selected: 0,
      showBoxes: true,
      dimImage: true,
    });
    assert.equal(svg.attrs.viewBox, "0 0 1248 832");
    const tags = svg.children.map((c) => c.tag);
    assert.deepEqual(tags, ["rect", "image", "g", "g"]);
    assert.equal(svg.children[1].attrs.href, "data:image/png;base64,AA==");
    assert.equal(svg.children[1].attrs.opacity, "0.52");
  } finally {
    globalThis.document = prevDoc;
  }
});

test("RULE_PRESET_OPTIONS and PRESET_RULE_TEMPLATES cover all preset keys with non-empty templates", () => {
  const presetKeys = RULE_PRESET_OPTIONS.map(([key]) => key);
  assert.ok(presetKeys.includes("moss"));
  assert.ok(presetKeys.includes("layout"));
  assert.ok(presetKeys.includes("danbooru"));
  assert.ok(presetKeys.includes("custom"));

  for (const key of ["moss", "layout", "danbooru", "tags"]) {
    const tpl = PRESET_RULE_TEMPLATES[key];
    assert.equal(typeof tpl, "string", `Template for ${key} must be a string`);
    assert.ok(tpl.trim().length > 0, `Template for ${key} must not be empty`);
    assert.ok(tpl.includes("- "), `Template for ${key} must contain bulleted rules`);
  }
});

test("QUICK_RULE_TEMPLATES and OUTPUT_LANGUAGE_OPTIONS integrity", () => {
  assert.ok(Array.isArray(QUICK_RULE_TEMPLATES) && QUICK_RULE_TEMPLATES.length >= 5);
  for (const item of QUICK_RULE_TEMPLATES) {
    assert.ok(item.label && item.text);
  }
  const langKeys = OUTPUT_LANGUAGE_OPTIONS.map(([k]) => k);
  assert.deepEqual(langKeys, ["en", "zh", "auto"]);
});
