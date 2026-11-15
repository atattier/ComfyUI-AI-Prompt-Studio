import test from "node:test";
import assert from "node:assert/strict";

import {
  formatLoraStackSummary,
  buildLoraSyntaxString,
} from "../web/lib/lora_editor.js";

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
