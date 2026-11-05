import test from "node:test";
import assert from "node:assert/strict";

import { UndoStack } from "../web/lib/undo.js";

const entry = (overrides = {}) => ({
  key: "node:1:text",
  before: "cat",
  after: "dog",
  label: "replace cat",
  ...overrides,
});

test("record then undo returns the previous text", () => {
  const stack = new UndoStack();
  stack.record(entry());
  assert.equal(stack.canUndo, true);
  const undone = stack.undo();
  assert.equal(undone.before, "cat");
  assert.equal(stack.canUndo, false);
  assert.equal(stack.canRedo, true);
  const redone = stack.redo();
  assert.equal(redone.after, "dog");
  assert.equal(stack.canUndo, true);
});

test("a new record clears the redo branch", () => {
  const stack = new UndoStack();
  stack.record(entry());
  stack.undo();
  stack.record(entry({ before: "dog", after: "fox" }));
  assert.equal(stack.canRedo, false);
});

test("no-op entries are ignored", () => {
  const stack = new UndoStack();
  assert.equal(stack.record(entry({ after: "cat" })), null);
  assert.equal(stack.size, 0);
});

test("invalid entries throw", () => {
  const stack = new UndoStack();
  assert.throws(() => stack.record({ before: "a", after: "b" }));
  assert.throws(() => stack.record({ key: "k", before: 1, after: "b" }));
});

test("limit keeps the most recent entries", () => {
  const stack = new UndoStack({ limit: 2 });
  stack.record(entry({ after: "one" }));
  stack.record(entry({ after: "two" }));
  stack.record(entry({ after: "three" }));
  assert.equal(stack.size, 2);
  assert.equal(stack.undo().after, "three");
  assert.equal(stack.undo().after, "two");
  assert.equal(stack.undo(), null);
});

test("undo and redo expose the next entry for tooltips", () => {
  const stack = new UndoStack();
  assert.equal(stack.peekUndo(), null);
  stack.record(entry({ label: "first" }));
  assert.equal(stack.peekUndo().label, "first");
  stack.undo();
  assert.equal(stack.peekRedo().label, "first");
});

test("clear empties both branches", () => {
  const stack = new UndoStack();
  stack.record(entry());
  stack.undo();
  stack.clear();
  assert.equal(stack.canUndo, false);
  assert.equal(stack.canRedo, false);
});
