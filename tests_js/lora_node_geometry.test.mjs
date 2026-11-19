import test from "node:test";
import assert from "node:assert/strict";

/**
 * The LoRA node derives its card height from the DOM widget box. These tests
 * pin the arithmetic that decides how tall it is, because the old formula
 * silently clamped to the floor and the node never grew.
 */

const MIN_CARD_HEIGHT = 340;

/** Mirror of nodeDerivedHeight() in web/lora_node.js. */
function nodeDerivedHeight(nodeH, offset) {
  const safeOffset = Number.isFinite(offset) && offset >= 0 && offset < nodeH ? offset : 0;
  return Math.max(MIN_CARD_HEIGHT, Math.round(nodeH - safeOffset - 12));
}

test("card height grows when the node is dragged taller", () => {
  const small = nodeDerivedHeight(490, 0);
  const tall = nodeDerivedHeight(900, 0);
  assert.equal(small, 478);
  assert.equal(tall, 888);
  assert.ok(tall > small, "taller node must yield a taller card");
});

test("card height never collapses below the minimum", () => {
  // A tiny node would otherwise produce a negative or unusable height.
  assert.equal(nodeDerivedHeight(200, 0), MIN_CARD_HEIGHT);
  assert.equal(nodeDerivedHeight(340, 0), MIN_CARD_HEIGHT);
});

test("out-of-range canvas-space offsets are ignored, not subtracted", () => {
  // This is the regression: domWidget.y used to be canvas-space, so it could
  // exceed the node height and make the result permanently hit the floor.
  const withBadOffset = nodeDerivedHeight(900, 1450);
  const clean = nodeDerivedHeight(900, 0);
  assert.equal(withBadOffset, clean, "an offset >= nodeH must be treated as 0");
});

test("negative or non-numeric offsets fall back to zero", () => {
  for (const bad of [-40, NaN, undefined, null, "abc"]) {
    assert.equal(nodeDerivedHeight(600, bad), 588);
  }
});

test("a plausible within-node offset is still respected", () => {
  // A real title-bar inset should reduce the available body height.
  assert.equal(nodeDerivedHeight(900, 60), 828);
});

test("height scales monotonically across a drag", () => {
  const heights = [490, 600, 700, 800, 1000].map((h) => nodeDerivedHeight(h, 40));
  for (let i = 1; i < heights.length; i++) {
    assert.ok(heights[i] > heights[i - 1], `step ${i} did not increase`);
  }
});