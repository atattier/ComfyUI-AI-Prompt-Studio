/**
 * Undo / redo for prompt widgets.
 *
 * Each entry stores the exact before/after text plus the target key, so an
 * undo always writes back to the widget it came from and never to whichever
 * node happens to be selected later.
 */

export class UndoStack {
  constructor({ limit = 50 } = {}) {
    this.limit = Math.max(1, limit);
    this.undoEntries = [];
    this.redoEntries = [];
  }

  /** Record an applied change. Clears the redo branch, like a text editor. */
  record(entry) {
    if (!entry || !entry.key || typeof entry.before !== "string" || typeof entry.after !== "string") {
      throw new Error("undo entries need key, before and after");
    }
    if (entry.before === entry.after) return null;
    this.undoEntries.push({
      key: entry.key,
      before: entry.before,
      after: entry.after,
      label: entry.label || "",
      source: entry.source || "apply",
      at: Date.now(),
    });
    if (this.undoEntries.length > this.limit) this.undoEntries.shift();
    this.redoEntries = [];
    return this.peekUndo();
  }

  peekUndo() {
    return this.undoEntries[this.undoEntries.length - 1] || null;
  }

  peekRedo() {
    return this.redoEntries[this.redoEntries.length - 1] || null;
  }

  /** Pop the latest change and make it available for redo. */
  undo() {
    const entry = this.undoEntries.pop();
    if (!entry) return null;
    this.redoEntries.push(entry);
    return entry;
  }

  /** Pop the latest undone change and make it available for undo again. */
  redo() {
    const entry = this.redoEntries.pop();
    if (!entry) return null;
    this.undoEntries.push(entry);
    return entry;
  }

  clear() {
    this.undoEntries = [];
    this.redoEntries = [];
  }

  get canUndo() {
    return this.undoEntries.length > 0;
  }

  get canRedo() {
    return this.redoEntries.length > 0;
  }

  get size() {
    return this.undoEntries.length;
  }
}
