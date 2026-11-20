import test from "node:test";
import assert from "node:assert/strict";

import {
  formatLoraStackSummary,
  buildLoraSyntaxString,
  openLoraPresetLightbox,
  openSaveLoraPresetModal,
  openLoraPresetLibraryModal,
} from "../web/lib/lora_editor.js";

test("lora_editor exports required preset and lightbox functions", () => {
  assert.equal(typeof openLoraPresetLightbox, "function");
  assert.equal(typeof openSaveLoraPresetModal, "function");
  assert.equal(typeof openLoraPresetLibraryModal, "function");
});

test("formatLoraStackSummary formats counts correctly", () => {
  assert.equal(formatLoraStackSummary([]), "无 LoRA");
  assert.equal(formatLoraStackSummary(null), "无 LoRA");

  const loras = [
    { name: "lora1.safetensors", enabled: true },
    { name: "lora2.safetensors", enabled: false },
    { name: "lora3.safetensors", enabled: true },
  ];
  assert.equal(formatLoraStackSummary(loras), "2 个 LoRA 堆叠 (共 3 个)");
});

test("buildLoraSyntaxString generates correct <lora:...> tags with scaling", () => {
  const loras = [
    { name: "style_anime", strength_model: 0.8, strength_clip: 0.8, enabled: true },
    { name: "details", strength_model: 0.5, strength_clip: 0.5, enabled: false }, // disabled
    { name: "character", strength_model: 1.0, strength_clip: 1.0, enabled: true },
  ];

  const syntax1 = buildLoraSyntaxString(loras, 1.0, 1.0);
  assert.equal(syntax1, "<lora:style_anime:0.8> <lora:character:1>");

  const syntaxScaled = buildLoraSyntaxString(loras, 1.5, 1.5);
  assert.equal(syntaxScaled, "<lora:style_anime:1.2> <lora:character:1.5>");
});

test("preset hub grid is a real scroll container (CSS regression guard)", async () => {
  const { readFile } = await import("node:fs/promises");
  const url = new URL("../web/style.css", import.meta.url);
  const css = await readFile(url, "utf8");

  const block = (selector) => {
    const i = css.indexOf(`${selector} {`);
    assert.ok(i >= 0, `missing CSS rule ${selector}`);
    return css.slice(i, css.indexOf("}", i));
  };

  const grid = block(".aps-explorer-grid");
  assert.match(grid, /overflow-y:\s*auto/, ".aps-explorer-grid must scroll vertically");
  assert.match(grid, /min-height:\s*0/, ".aps-explorer-grid needs min-height:0 to shrink inside flex");
  assert.match(grid, /flex:\s*1 1 0/, ".aps-explorer-grid must flex-grow to fill the pane");

  const main = block(".aps-explorer-main");
  assert.match(main, /min-height:\s*0/, ".aps-explorer-main needs min-height:0 so children can scroll");

  const body = block(".aps-preset-gallery-body");
  assert.match(body, /min-height:\s*0/);
  assert.match(body, /overflow:\s*hidden/);

  const layout = block(".aps-explorer-layout");
  assert.match(layout, /min-height:\s*0/);
});
