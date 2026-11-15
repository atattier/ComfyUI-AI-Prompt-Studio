import test from "node:test";
import assert from "node:assert/strict";
import {
  imageMetadataSummary,
  mergeImageMetadataIntoState,
} from "../web/lib/image_metadata.js";

test("summary lists prompt types and box count", () => {
  const summary = imageMetadataSummary({
    prompts: { caption: "A".repeat(120), layout: "{}", danbooru: "1girl, solo" },
    draft: { items: [{}, {}, {}] },
  });
  assert.deepEqual(summary.parts, ["散文提示词", "布局提示词（3 个画框）", "Danbooru 标签"]);
  assert.equal(summary.hasLayout, true);
  assert.equal(summary.boxCount, 3);
  assert.equal(summary.captionSnippet.length, 91); // 90 chars + "…"
});

test("merge only writes slots present in metadata", () => {
  const state = { width: 1024, height: 1024, caption_text: "旧散文", layout_prompt: "旧布局" };
  const result = mergeImageMetadataIntoState(state, {
    width: 800,
    height: 600,
    prompts: { caption: "新散文" },
    draft: { width: 800, height: 600, items: [] },
  });
  assert.deepEqual(result.applied, ["caption"]);
  assert.equal(state.caption_text, "新散文");
  assert.equal(state.layout_prompt, "旧布局");
  assert.equal(state.draft, undefined);
});

test("merge scales boxes once from draft coords to canvas", () => {
  const state = { width: 1024, height: 1024 };
  const meta = {
    width: 512,
    height: 512,
    prompts: { caption: "c", danbooru: "d", layout: "l" },
    draft: {
      width: 512,
      height: 512,
      summary: { caption: "c" },
      items: [{ label: "object", caption: "x", bbox: [100, 100, 400, 400] }],
    },
  };
  const result = mergeImageMetadataIntoState(state, meta, { width: 1024, height: 1024 });
  assert.equal(result.boxCount, 1);
  assert.ok(result.applied.includes("boxes"));
  assert.deepEqual(state.draft.items[0].bbox, [200, 200, 800, 800]);
  assert.equal(state.layout_draft, state.draft);
  assert.equal(state.hybrid_draft.summary.caption, "c");
  assert.equal(state.width, 1024); // 画布尺寸不由合并函数改动
});

test("merge without items leaves existing draft untouched", () => {
  const old = { width: 1024, height: 1024, items: [{ bbox: [1, 2, 3, 4] }] };
  const state = { width: 1024, height: 1024, draft: old, layout_prompt: "旧布局" };
  const result = mergeImageMetadataIntoState(state, {
    width: 1024,
    height: 1024,
    prompts: {},
    draft: { width: 1024, height: 1024, items: [] },
  });
  assert.equal(state.draft, old);
  assert.equal(state.layout_prompt, "旧布局");
  assert.deepEqual(result.applied, []);
});