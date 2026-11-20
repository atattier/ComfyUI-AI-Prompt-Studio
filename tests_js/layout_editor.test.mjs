/** Tests for the caption node's payload persistence and layout draft helpers. */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MODE_RULE_TEXTS,
  MODE_RULE_TABS,
  OUTPUT_LANGUAGE_OPTIONS,
  PRESET_RULE_TEMPLATES,
  QUICK_RULE_TEMPLATES,
  RULE_PRESET_OPTIONS,
  MOSS_CANVAS_PRESETS,
  normalizeDraft,
  canvasSizeForImage,
  rescaleLayoutDraft,
  renderSvgStage,
  computeAdaptiveLayoutMode,
  detectBoxDeletion,
  turnToMessages,
  inferCanvasSizeFromLayout,
  compileLayoutDraftForMoss,
  buildLayoutPrompt,
  decompileMossLayoutToDraft,
  detectFinishedPromptType,
  inspectFinishedPrompt,
  cleanCaptionPreserveQuotesJs,
  _test as editorInternals,
} from "../web/lib/layout_editor.js";
import { parseComfyImageRef, buildComfyViewUrl, fetchComfyImageRef } from "../web/lib/images.js";

const { cloneDraft, clamp, detachImageInPayload } = editorInternals;

test("detachImageInPayload drops the reference image and blocks reuse", () => {
  const state = {
    caption: "keep me",
    last_image_file: "ref_1.png",
    last_image_data: "data:image/png;base64,AAA",
    source: "imagine",
    draft: { items: [{ label: "object", caption: "x", bbox: [0, 0, 10, 10] }] },
  };
  const next = detachImageInPayload(state);
  assert.equal(next.image_detached, true);
  assert.equal(next.detached_from_file, "ref_1.png");
  assert.equal(next.last_image_file, undefined);
  assert.equal(next.last_image_data, undefined);
  assert.equal(next.source, undefined);
  // 提示词与画框必须原样保留：解除底图只断图片，不动内容。
  assert.equal(next.caption, "keep me");
  assert.equal(next.draft.items.length, 1);
  // 原对象不能被就地改写。
  assert.equal(state.last_image_file, "ref_1.png");
});

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

test("MODE_RULE_TABS and DEFAULT_MODE_RULE_TEXTS isolate caption, layout, danbooru rules", () => {
  const keys = MODE_RULE_TABS.map(([k]) => k);
  assert.deepEqual(keys, ["caption", "layout", "danbooru"]);
  for (const key of keys) {
    assert.equal(typeof DEFAULT_MODE_RULE_TEXTS[key], "string");
    assert.ok(DEFAULT_MODE_RULE_TEXTS[key].trim().length > 20);
  }
});

test("computeAdaptiveLayoutMode chooses side-by-side for portrait and stacked for landscape/square", () => {
  assert.equal(computeAdaptiveLayoutMode(832, 1248).stageSplit, "side");
  assert.equal(computeAdaptiveLayoutMode(832, 1248).orientation, "portrait");
  assert.equal(computeAdaptiveLayoutMode(768, 1344).stageSplit, "side");
  assert.equal(computeAdaptiveLayoutMode(1248, 832).stageSplit, "stack");
  assert.equal(computeAdaptiveLayoutMode(1248, 832).orientation, "landscape");
  assert.equal(computeAdaptiveLayoutMode(1024, 1024).stageSplit, "stack");
  assert.equal(computeAdaptiveLayoutMode(1024, 1024).orientation, "square");
});

test("detectBoxDeletion detects deletion intent by reference, index, or name", () => {
  const items = [
    { name: "女孩", label: "character", caption: "Young girl" },
    { name: "课椅", label: "object", caption: "Wooden chair" },
    { name: "黑色斗篷", label: "clothing", caption: "Black cloak" },
    { name: "魔女帽", label: "object", caption: "Witch hat" },
    { name: "课桌", label: "object", caption: "Classroom desk" },
    { name: "水印文字", label: "text", caption: "Watermark" },
  ];

  // 1. Quoted reference target
  assert.equal(detectBoxDeletion("删除这个框", items, 3), 3);
  assert.equal(detectBoxDeletion("把此画框删掉", items, 1), 1);
  assert.equal(detectBoxDeletion("delete region", items, 0), 0);

  // 2. Named box deletion in global mode
  assert.equal(detectBoxDeletion("把魔女帽框删了", items, -1), 3);
  assert.equal(detectBoxDeletion("删除水印文字", items, -1), 5);
  assert.equal(detectBoxDeletion("去掉课桌框", items, -1), 4);

  // 3. Numbered box deletion
  assert.equal(detectBoxDeletion("删除第2个框", items, -1), 1);
  assert.equal(detectBoxDeletion("删除框#6", items, -1), 5);
  assert.equal(detectBoxDeletion("删掉4号框", items, -1), 3);

  // 4. Non-deletion requests
  assert.equal(detectBoxDeletion("把背景颜色改成雨夜霓虹", items, -1), -1);
  assert.equal(detectBoxDeletion("给魔女帽加上蕾丝花边", items, 3), -1);
  assert.equal(detectBoxDeletion("扩写细节", items, 2), -1);
});

test("turnToMessages converts node chat turns into UI messages with badges and crests", () => {
  const turn = {
    id: "turn-1",
    userText: "把魔女帽改成粉色丝带",
    reply: "已修改魔女帽丝带颜色。",
    changed: true,
    regionBadge: "🎯 @画框 #4「魔女帽」",
    regionColor: "#f43f5e",
  };
  const msgs = turnToMessages(turn);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, "user");
  assert.equal(msgs[0].text, "把魔女帽改成粉色丝带");
  assert.equal(msgs[0].regionBadge, "🎯 @画框 #4「魔女帽」");
  assert.equal(msgs[1].role, "assistant");
  assert.equal(msgs[1].text, "已修改魔女帽丝带颜色。");
  assert.equal(msgs[1].crest, "REGION UPDATED");
});

test("parseComfyImageRef and buildComfyViewUrl parse suffixes, subfolders, and build valid URLs", () => {
  // Simple input
  assert.deepEqual(parseComfyImageRef("SleepyRabbit.png"), {
    filename: "SleepyRabbit.png",
    type: "input",
    subfolder: "",
  });

  // ComfyUI [input] suffix
  assert.deepEqual(parseComfyImageRef("SleepyRabbit.png [input]"), {
    filename: "SleepyRabbit.png",
    type: "input",
    subfolder: "",
  });

  // Subfolder + [output]
  assert.deepEqual(parseComfyImageRef("gallery/render_01.png [output]"), {
    filename: "render_01.png",
    type: "output",
    subfolder: "gallery",
  });

  // Windows backslash path + [temp]
  assert.deepEqual(parseComfyImageRef("cache\\previews\\thumb.webp [temp]"), {
    filename: "thumb.webp",
    type: "temp",
    subfolder: "cache/previews",
  });

  // buildComfyViewUrl
  assert.equal(
    buildComfyViewUrl("SleepyRabbit.png [input]"),
    "/view?filename=SleepyRabbit.png&type=input",
  );
  assert.equal(
    buildComfyViewUrl("gallery/render_01.png [output]"),
    "/view?filename=render_01.png&type=output&subfolder=gallery",
  );
  assert.equal(
    buildComfyViewUrl("data:image/png;base64,mockData"),
    "data:image/png;base64,mockData",
  );
  assert.equal(buildComfyViewUrl(null), null);
});

test("fetchComfyImageRef queries /view and returns dataUrl without re-encoding", async () => {
  let calledUrl = null;
  const mockFetch = async (url) => {
    calledUrl = url;
    return {
      ok: true,
      blob: async () => new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" }),
    };
  };

  const res = await fetchComfyImageRef(
    { filename: "out_001.png", subfolder: "my_folder", type: "output" },
    { fetchImpl: mockFetch },
  );
  assert.equal(calledUrl, "/view?filename=out_001.png&type=output&subfolder=my_folder");
  assert.ok(res.dataUrl.startsWith("data:image/png;base64,"));
  assert.equal(res.bytes, 8);
});

test("inferCanvasSizeFromLayout detects 832x1216, 1216x832, explicit sizes, and fallback", () => {
  const portrait = {
    summary: { caption: "Portrait" },
    items: [
      { label: "object", caption: "bg", bbox: [-608, -416, 608, 416] },
      { label: "character", caption: "hero", bbox: [-400, -200, 500, 200] },
    ],
    bbox_coord_space: "abs_centralized",
    bbox_format: "yxyx",
  };
  assert.deepEqual(inferCanvasSizeFromLayout(portrait, 1024, 1024), [832, 1216]);

  const landscape = {
    summary: { caption: "Landscape" },
    items: [{ label: "object", caption: "sky", bbox: [-416, -608, 416, 608] }],
    bbox_coord_space: "abs_centralized",
    bbox_format: "yxyx",
  };
  assert.deepEqual(inferCanvasSizeFromLayout(landscape, 1024, 1024), [1216, 832]);
  assert.deepEqual(inferCanvasSizeFromLayout({ width: 1500, height: 1000, items: [] }, 1024, 1024), [1248, 832]);
  assert.deepEqual(inferCanvasSizeFromLayout({ items: [] }, 1024, 1024), [1024, 1024]);
  assert.ok(Array.isArray(MOSS_CANVAS_PRESETS) && MOSS_CANVAS_PRESETS.length >= 7);
});

test("compileLayoutDraftForMoss and decompileMossLayoutToDraft round-trip cleanly without name bleed", () => {
  const draft = {
    width: 832,
    height: 1216,
    summary: { caption: "Cafe dusk scene", canvas: "single" },
    items: [
      { name: "背景墙", label: "object", caption: "Warm brick wall", bbox: [0, 0, 832, 1216] },
      { name: "少女", label: "character", caption: "Girl smiling", bbox: [200, 200, 600, 1000] },
      { name: "招牌文字", label: "text", caption: "Shop sign", text: "OPEN", bbox: [80, 90, 320, 210] },
    ],
  };
  const compiled = compileLayoutDraftForMoss(draft, 832, 1216);
  assert.equal(compiled.bbox_coord_space, "abs_centralized");
  assert.equal(compiled.bbox_format, "yxyx");
  assert.deepEqual(compiled.items[0].bbox, [-608, -416, 608, 416]);
  const builtStr = buildLayoutPrompt(draft, 832, 1216);
  assert.equal(typeof builtStr, "string");
  assert.equal(JSON.parse(builtStr).bbox_coord_space, "abs_centralized");

  // Inject Chinese depth tail as well to confirm both CN and EN depth tails strip on decompile
  const withCnTail = JSON.parse(builtStr);
  withCnTail.items[1].caption = "红发少女站在门口。在「背景墙」前方，部分遮挡它。";

  // Unrelated prevDraft at index 1 must NOT bleed old name onto pasted layout!
  const unrelatedPrev = {
    width: 832,
    height: 1216,
    items: [
      { name: "旧背景", caption: "Completely different desert canyon" },
      { name: "旧机器人", caption: "Ancient mecha robot in ruins" },
    ],
  };
  const decompiled = decompileMossLayoutToDraft(withCnTail, 1024, 1024, unrelatedPrev);
  assert.equal(decompiled.width, 832);
  assert.equal(decompiled.height, 1216);
  assert.deepEqual(decompiled.items[0].bbox, [0, 0, 832, 1216]);
  assert.deepEqual(decompiled.items[1].bbox, [200, 200, 600, 1000]);
  assert.equal(decompiled.items[0].caption, "Warm brick wall.");
  assert.equal(decompiled.items[1].caption, "红发少女站在门口。");
  assert.notEqual(decompiled.items[1].name, "旧机器人");
  assert.equal(decompiled.items[2].text, "OPEN");

  // Matching prevDraft caption DOES preserve custom region name
  const matchingPrev = {
    width: 832,
    height: 1216,
    items: [
      { name: "自定义砖墙", caption: "Warm brick wall" },
    ],
  };
  const decompiledSame = decompileMossLayoutToDraft(withCnTail, 832, 1216, matchingPrev);
  assert.equal(decompiledSame.items[0].name, "自定义砖墙");
});

test("detectFinishedPromptType, inspectFinishedPrompt, and cleanCaptionPreserveQuotesJs work reliably", () => {
  const layoutJson = JSON.stringify({
    summary: { caption: "Scene" },
    items: [{ label: "character", caption: "Hero", bbox: [-408, -216, 408, 216] }],
    bbox_coord_space: "abs_centralized",
    bbox_format: "yxyx",
  });
  assert.equal(detectFinishedPromptType(layoutJson), "layout");
  assert.equal(detectFinishedPromptType("```json\n" + layoutJson + "\n```"), "layout");
  assert.equal(detectFinishedPromptType("1girl, solo, silver_hair, blue_eyes, neon_city"), "danbooru");
  assert.equal(detectFinishedPromptType("<|人物|> 一名银发少女\n<|场景|> 赛博街道"), "caption");
  assert.equal(detectFinishedPromptType("A candid 35mm portrait, warm sunbeams, crisp shadows."), "caption");
  assert.equal(detectFinishedPromptType("anything", "danbooru"), "danbooru");

  const infoOk = inspectFinishedPrompt(layoutJson, "auto", 1024, 1024);
  assert.equal(infoOk.sourceType, "layout");
  assert.equal(infoOk.hasJsonObject, true);
  assert.equal(infoOk.itemCount, 1);

  const infoBroken = inspectFinishedPrompt('{"items": [', "layout", 1024, 1024);
  assert.equal(infoBroken.sourceType, "layout");
  assert.equal(infoBroken.hasJsonObject, false);

  assert.equal(
    cleanCaptionPreserveQuotesJs('```text\nA girl holds a glowing sign reading "OPEN"\n```'),
    'A girl holds a glowing sign reading "OPEN"',
  );
  assert.equal(
    cleanCaptionPreserveQuotesJs('{"summary":{"caption":"Inside sign reading \\"OPEN\\""}}'),
    'Inside sign reading "OPEN"',
  );
});





// ---- 画布跟随底图（换图不再沿用上一张尺寸） ----

test("canvasSizeForImage keeps the image aspect and snaps to 16", () => {
  const portrait = canvasSizeForImage(1024, 1536);
  assert.equal(portrait.width % 16, 0);
  assert.equal(portrait.height % 16, 0);
  assert.ok(portrait.height > portrait.width, "竖图必须还是竖的");
  assert.ok(Math.abs(portrait.width / portrait.height - 1024 / 1536) < 0.02);

  const wide = canvasSizeForImage(1920, 1080);
  assert.ok(wide.width > wide.height, "横图必须还是横的");
  assert.ok(wide.width * wide.height <= 1024 * 1024 * 1.05, "像素预算约 1024²");
});

test("rescaleLayoutDraft moves boxes with the canvas instead of clamping them", () => {
  const draft = {
    width: 1344,
    height: 768,
    summary: { caption: "Two panels." },
    items: [
      { label: "character", caption: "Left panel", bbox: [0, 0, 672, 768] },
      { label: "text", caption: "Right panel", text: "HI", bbox: [672, 0, 1344, 768] },
    ],
  };
  const next = rescaleLayoutDraft(draft, 1024, 1536, 1344, 768);
  assert.equal(next.width, 1024);
  assert.equal(next.height, 1536);
  const scaleX = 1024 / 1344;
  const scaleY = 1536 / 768;
  assert.equal(next.items[0].bbox[0], 0);
  assert.equal(next.items[0].bbox[2], Math.round(672 * scaleX));
  assert.equal(next.items[1].bbox[3], 1536);
  assert.equal(next.items[1].text, "HI", "非几何字段不能丢");
  for (const item of next.items) {
    assert.ok(item.bbox[2] <= 1024 && item.bbox[3] <= 1536, "缩放后不能出画布");
  }
});
