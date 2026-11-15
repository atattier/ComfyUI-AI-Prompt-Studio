import test from "node:test";
import assert from "node:assert/strict";

import {
  anyStudioModalOpen,
  isDeleteKey,
  isEscapeKey,
  isTypingTarget,
  removeRegion,
  shouldDeleteSelection,
} from "../web/lib/hotkeys.js";

const canvasTarget = { tagName: "DIV" };

test("recognises the delete keys", () => {
  for (const key of ["Delete", "Backspace", "Del"]) {
    assert.equal(isDeleteKey({ key }), true);
  }
  for (const key of ["Enter", "Escape", "d", "Space"]) {
    assert.equal(isDeleteKey({ key }), false);
  }
  assert.equal(isDeleteKey(null), false);
});

test("recognises the escape key", () => {
  assert.equal(isEscapeKey({ key: "Escape" }), true);
  assert.equal(isEscapeKey({ key: "Esc" }), true);
  assert.equal(isEscapeKey({ key: "Delete" }), false);
  assert.equal(isEscapeKey(undefined), false);
});

test("typing targets block the shortcut, canvases do not", () => {
  assert.equal(isTypingTarget({ tagName: "INPUT", type: "text" }), true);
  assert.equal(isTypingTarget({ tagName: "INPUT", type: "search" }), true);
  assert.equal(isTypingTarget({ tagName: "TEXTAREA" }), true);
  assert.equal(isTypingTarget({ tagName: "SELECT" }), true);
  assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: "INPUT", type: "checkbox" }), false);
  assert.equal(isTypingTarget({ tagName: "INPUT", type: "button" }), false);
  assert.equal(isTypingTarget(canvasTarget), false);
  assert.equal(isTypingTarget(null), false);
});

test("delete fires only for a live selection outside text controls", () => {
  assert.equal(shouldDeleteSelection({ key: "Delete", target: canvasTarget }, 0), true);
  assert.equal(shouldDeleteSelection({ key: "Backspace", target: canvasTarget }, 3), true);
  assert.equal(shouldDeleteSelection({ key: "Delete", target: canvasTarget }, -1), false);
  assert.equal(shouldDeleteSelection({ key: "Delete", target: canvasTarget }, 1.5), false);
  assert.equal(
    shouldDeleteSelection({ key: "Delete", target: { tagName: "TEXTAREA" } }, 2),
    false,
  );
  assert.equal(shouldDeleteSelection({ key: "Delete", target: canvasTarget, ctrlKey: true }, 2), false);
  assert.equal(
    shouldDeleteSelection({ key: "Delete", target: canvasTarget, metaKey: true }, 2),
    false,
  );
  assert.equal(
    shouldDeleteSelection({ key: "Delete", target: canvasTarget, isComposing: true }, 2),
    false,
  );
  assert.equal(shouldDeleteSelection({ key: "Enter", target: canvasTarget }, 2), false);
});

test("removeRegion drops the box together with its caption item", () => {
  const items = [
    { name: "顶棚", caption: "Exposed ceiling." },
    { name: "泳圈", caption: "Mint swim ring." },
    { name: "女孩", caption: "Cosplayer kneeling." },
  ];
  const removed = removeRegion(items, 1, 1);
  assert.equal(removed.items.length, 2);
  assert.deepEqual(
    removed.items.map((i) => i.name),
    ["顶棚", "女孩"],
  );
  assert.equal(removed.selectedIndex, 1);
  assert.equal(items.length, 3, "input array must not be mutated");
  assert.equal(items[1].caption, "Mint swim ring.");
});

test("removeRegion keeps selection pointing at a sensible neighbour", () => {
  const items = [{}, {}, {}, {}];
  // deleting before the selection shifts it left by one
  assert.equal(removeRegion(items, 1, 3).selectedIndex, 2);
  // deleting the first entry of a two-item list ends with the survivor
  assert.equal(removeRegion([{}, {}], 0, 0).selectedIndex, 0);
  // deleting the only entry leaves nothing selected
  assert.equal(removeRegion([{}], 0, 0).selectedIndex, -1);
  // deleting the tail while the tail is selected falls back to the new tail
  assert.equal(removeRegion(items, 3, 3).selectedIndex, 2);
  // untouched arrays are safe to hand back
  assert.equal(removeRegion(undefined, 0, 0).selectedIndex, 0);
  assert.equal(removeRegion(items, 9, 0).items.length, 4);
  assert.equal(removeRegion(items, -1, 0).selectedIndex, 0);
});

test("modal guard only trips when a studio overlay is present", () => {
  assert.equal(anyStudioModalOpen({ querySelector: () => ({}) }), true);
  assert.equal(anyStudioModalOpen({ querySelector: () => null }), false);
  assert.equal(anyStudioModalOpen(null), false);
  assert.equal(anyStudioModalOpen({}), false);
});
