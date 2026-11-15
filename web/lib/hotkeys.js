/**
 * Keyboard helpers shared by the in-node layout stage and the studio layout
 * editor modal.
 *
 * Dependency-free and side-effect-free, so the rules can be unit tested under
 * `node --test` without a DOM.
 */

const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "email",
  "number",
  "password",
  "tel",
  "url",
  "date",
  "time",
  "datetime-local",
  "month",
  "week",
]);

/** True when the event target is a control that consumes typing keys itself. */
export function isTypingTarget(target) {
  if (!target || typeof target !== "object") return false;
  if (target.isContentEditable) return true;
  const tag = String(target.tagName || "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = String(target.type || "text").toLowerCase();
    return TEXT_INPUT_TYPES.has(type);
  }
  return false;
}

export function isDeleteKey(event) {
  if (!event) return false;
  const key = String(event.key || "");
  return key === "Delete" || key === "Backspace" || key === "Del";
}

export function isEscapeKey(event) {
  if (!event) return false;
  const key = String(event.key || "");
  return key === "Escape" || key === "Esc";
}

/**
 * Decide whether a Delete/Backspace press should remove the selected region.
 *
 * Only fires with a live selection, outside text controls, and without
 * modifiers, so browser/system shortcuts keep working untouched.
 */
export function shouldDeleteSelection(event, selectedIndex) {
  if (!event || !isDeleteKey(event)) return false;
  if (event.isComposing || event.keyCode === 229) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0) return false;
  return !isTypingTarget(event.target);
}

/**
 * Remove one region and report which index should stay selected.
 *
 * The box geometry and its caption / name / visible text all live on the same
 * item object, so dropping the item drops the description with it. Out-of-range
 * indexes are ignored instead of throwing.
 */
export function removeRegion(items, index, selectedIndex = index) {
  const list = Array.isArray(items) ? items.slice() : [];
  if (!Number.isInteger(index) || index < 0 || index >= list.length) {
    return { items: list, selectedIndex };
  }
  list.splice(index, 1);
  let nextSelected = selectedIndex;
  if (selectedIndex === index) {
    nextSelected = Math.min(index, list.length - 1);
  } else if (Number.isInteger(selectedIndex) && selectedIndex > index) {
    nextSelected = selectedIndex - 1;
  }
  return { items: list, selectedIndex: nextSelected };
}

/** Keydown should be ignored while a studio modal owns the screen. */
export function anyStudioModalOpen(root) {
  if (!root || typeof root.querySelector !== "function") return false;
  return root.querySelector(".aps-modal-overlay") != null;
}
