import test from "node:test";
import assert from "node:assert/strict";

import { ApiError, StudioApi } from "../web/lib/api.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("request joins the base path and parses JSON", async () => {
  const calls = [];
  const api = new StudioApi({
    fetchImpl: async (url, init) => {
      calls.push([url, init]);
      return jsonResponse({ ok: true });
    },
  });
  const body = await api.status();
  assert.deepEqual(body, { ok: true });
  assert.equal(calls[0][0], "/ai_prompt_studio/status");
});

test("error payloads become ApiError with code and status", async () => {
  const api = new StudioApi({
    fetchImpl: async () =>
      jsonResponse(
        { error: { code: "invalid_edit", message: "Change 1 is ambiguous.", retryable: false, request_id: "r1" } },
        422,
      ),
  });
  await assert.rejects(
    () => api.edit({ message: "x", target: {} }),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, "invalid_edit");
      assert.equal(error.status, 422);
      assert.equal(error.requestId, "r1");
      assert.match(error.message, /ambiguous/);
      return true;
    },
  );
});

test("network failures are reported as retryable network errors", async () => {
  const api = new StudioApi({
    fetchImpl: async () => {
      throw new TypeError("Failed to fetch");
    },
  });
  await assert.rejects(
    () => api.status(),
    (error) => error instanceof ApiError && error.code === "network_error" && error.retryable === true,
  );
});

test("chat streams events and resolves after done", async () => {
  const encoder = new TextEncoder();
  const wire =
    'event: meta\ndata: {"session_id":"s1"}\n\n' +
    'event: delta\ndata: {"text":"hi"}\n\n' +
    'event: done\ndata: {"text":"hi","session_id":"s1"}\n\n';
  const api = new StudioApi({
    fetchImpl: async (url, init) => {
      assert.equal(url, "/ai_prompt_studio/chat");
      const sent = JSON.parse(init.body);
      assert.equal(sent.message, "hello");
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(wire.slice(0, 30)));
          controller.enqueue(encoder.encode(wire.slice(30)));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    },
  });
  const events = [];
  await api.chat({ message: "hello" }, (event) => events.push(event));
  assert.deepEqual(events.map((e) => e.event), ["meta", "delta", "done"]);
});

test("an SSE error event rejects the chat promise", async () => {
  const wire = 'event: error\ndata: {"code":"rate_limited","message":"slow down","retryable":true}\n\n';
  const api = new StudioApi({
    fetchImpl: async () => new Response(wire, { status: 200 }),
  });
  await assert.rejects(
    () => api.chat({ message: "x" }, () => {}),
    (error) => error instanceof ApiError && error.code === "rate_limited" && error.retryable === true,
  );
});

test("chat surfaces pre-stream JSON validation errors", async () => {
  const api = new StudioApi({
    fetchImpl: async () =>
      jsonResponse({ error: { code: "invalid_request", message: "message must be non-empty." } }, 400),
  });
  await assert.rejects(
    () => api.chat({ message: "" }, () => {}),
    (error) => error instanceof ApiError && error.status === 400 && error.code === "invalid_request",
  );
});

test("cloudGenerate calls POST /cloud_generate with parameters", async () => {
  let calledUrl = null;
  let calledBody = null;
  const api = new StudioApi({
    fetchImpl: async (url, init) => {
      calledUrl = url;
      calledBody = JSON.parse(init.body);
      return jsonResponse({ payload: { caption: "A test prompt" }, width: 1024, height: 1024 });
    },
  });
  const res = await api.cloudGenerate({ prompt: "A test prompt", width: 1024, height: 1024, mode: "caption" });
  assert.equal(calledUrl, "/ai_prompt_studio/cloud_generate");
  assert.equal(calledBody.prompt, "A test prompt");
  assert.equal(calledBody.mode, "caption");
  assert.equal(res.payload.caption, "A test prompt");
});

test("edit forwards optional mode to /edit", async () => {
  let calledUrl = null;
  let calledBody = null;
  const api = new StudioApi({
    fetchImpl: async (url, init) => {
      calledUrl = url;
      calledBody = JSON.parse(init.body);
      return jsonResponse({ proposal: { reply: "已修改", changes: [], changed: false, text: "{}" } });
    },
  });
  const res = await api.edit({
    message: "调整光照",
    mode: "layout",
    target: { node_id: 1, text: "{}" },
  });
  assert.equal(calledUrl, "/ai_prompt_studio/edit");
  assert.equal(calledBody.mode, "layout");
  assert.equal(res.proposal.reply, "已修改");
});

test("presets api calls support list, save, and delete", async () => {
  const calls = [];
  const api = new StudioApi({
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init?.method || "GET", body: init?.body ? JSON.parse(init.body) : null });
      return jsonResponse({ ok: true });
    },
  });

  await api.listPresets({ category: "双人", search: "电影" });
  assert.equal(calls[0].url, "/ai_prompt_studio/presets?category=%E5%8F%8C%E4%BA%BA&search=%E7%94%B5%E5%BD%B1");

  await api.savePreset({ name: "测试" });
  assert.equal(calls[1].url, "/ai_prompt_studio/presets");
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].body.name, "测试");

  await api.deletePreset("preset_123");
  assert.equal(calls[2].url, "/ai_prompt_studio/presets/preset_123");
  assert.equal(calls[2].method, "DELETE");

  await api.listPresetCategories();
  assert.equal(calls[3].url, "/ai_prompt_studio/presets/categories");

  await api.addPresetCategory("国风水墨");
  assert.equal(calls[4].url, "/ai_prompt_studio/presets/categories");
  assert.equal(calls[4].method, "POST");
  assert.equal(calls[4].body.name, "国风水墨");

  await api.deletePresetCategory("国风水墨");
  assert.equal(calls[5].url, "/ai_prompt_studio/presets/categories/%E5%9B%BD%E9%A3%8E%E6%B0%B4%E5%A2%A8");
  assert.equal(calls[5].method, "DELETE");

  await api.renamePresetCategory("人物/特写", "人物/单人特写");
  assert.equal(calls[6].url, "/ai_prompt_studio/presets/categories/%E4%BA%BA%E7%89%A9%2F%E7%89%B9%E5%86%99");
  assert.equal(calls[6].method, "PUT");
  assert.equal(calls[6].body.new_name, "人物/单人特写");

  await api.importPresetImage({ dataUrl: "data:image/png;base64,AAAA", filename: "test.png", category: "场景" });
  assert.equal(calls[7].url, "/ai_prompt_studio/presets/import_image");
  assert.equal(calls[7].method, "POST");
  assert.equal(calls[7].body.filename, "test.png");
  assert.equal(calls[7].body.category, "场景");

  await api.resetBuiltinPresets();
  assert.equal(calls[8].url, "/ai_prompt_studio/presets/reset_builtins");
  assert.equal(calls[8].method, "POST");

  assert.equal(api.presetImageUrl("p_1"), "/ai_prompt_studio/presets/p_1/image");
});

test("lora presets api calls support list, save, delete, and available loras", async () => {
  const calls = [];
  const api = new StudioApi({
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init?.method || "GET", body: init?.body ? JSON.parse(init.body) : null });
      return jsonResponse({ ok: true });
    },
  });

  await api.listLoraPresets({ category: "画风", search: "米山" });
  assert.equal(calls[0].url, "/ai_prompt_studio/lora_presets?category=%E7%94%BB%E9%A3%8E&search=%E7%B1%B3%E5%B1%B1");

  await api.saveLoraPreset({ name: "测试LoRA预设", loras: [{ name: "test.safetensors", strength_model: 0.8 }] });
  assert.equal(calls[1].url, "/ai_prompt_studio/lora_presets");
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].body.name, "测试LoRA预设");

  await api.deleteLoraPreset("lora_123");
  assert.equal(calls[2].url, "/ai_prompt_studio/lora_presets/lora_123");
  assert.equal(calls[2].method, "DELETE");

  await api.getAvailableLoras();
  assert.equal(calls[3].url, "/ai_prompt_studio/lora_presets/available_loras");

  await api.listLoraPresetCategories();
  assert.equal(calls[4].url, "/ai_prompt_studio/lora_presets/categories");

  await api.addLoraPresetCategory("服饰/机能");
  assert.equal(calls[5].url, "/ai_prompt_studio/lora_presets/categories");
  assert.equal(calls[5].method, "POST");

  assert.equal(api.loraPresetImageUrl("lp_1"), "/ai_prompt_studio/lora_presets/lp_1/image");
  assert.equal(api.loraPreviewImageUrl("model_a.safetensors"), "/ai_prompt_studio/lora_presets/preview_image?name=model_a.safetensors");
  assert.equal(api.loraPreviewImageUrl(""), "");
});

test("completeFromPrompt calls POST /complete_from_prompt with finished prompt params", async () => {
  let calledUrl = null;
  let calledBody = null;
  const api = new StudioApi({
    fetchImpl: async (url, init) => {
      calledUrl = url;
      calledBody = JSON.parse(init.body);
      return jsonResponse({
        detected_source: "layout",
        width: 832,
        height: 1216,
        modes: ["caption", "layout", "danbooru"],
        payload: { width: 832, height: 1216, caption: "A girl." },
        outputs: { caption_prompt: "A girl.", layout_prompt: "{}", danbooru_prompt: "1girl" },
      });
    },
  });
  const res = await api.completeFromPrompt({
    prompt: '{"items":[]}',
    source_mode: "auto",
    modes: ["caption", "layout", "danbooru"],
    width: 832,
    height: 1216,
    size_mode: "auto",
  });
  assert.equal(calledUrl, "/ai_prompt_studio/complete_from_prompt");
  assert.equal(calledBody.source_mode, "auto");
  assert.deepEqual(calledBody.modes, ["caption", "layout", "danbooru"]);
  assert.equal(res.width, 832);
  assert.equal(res.height, 1216);
  assert.equal(res.outputs.danbooru_prompt, "1girl");
});

test("presets api supports summarizePresetTitle and reCaptionPreset", async () => {
  const calls = [];
  const api = new StudioApi({
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init?.method || "GET", body: init?.body ? JSON.parse(init.body) : null });
      return jsonResponse({ status: "ok", title: "测试标题", preset: { id: "p1", name: "测试标题" } });
    },
  });

  const res1 = await api.summarizePresetTitle({ prompt: "A low-angle shot of Suzuran from Arknights" });
  assert.equal(calls[0].url, "/ai_prompt_studio/presets/summarize_title");
  assert.equal(calls[0].method, "POST");
  assert.equal(res1.title, "测试标题");

  const res2 = await api.reCaptionPreset("p1");
  assert.equal(calls[1].url, "/ai_prompt_studio/presets/p1/re_caption");
  assert.equal(calls[1].method, "POST");
  assert.equal(res2.preset.name, "测试标题");

  const res3 = await api.reloadPresetMetadata("p1");
  assert.equal(calls[2].url, "/ai_prompt_studio/presets/p1/reload_metadata");
  assert.equal(calls[2].method, "POST");
  assert.equal(res3.preset.name, "测试标题");
});

test("HTTP JSON error preserves detail, upstreamStatus, and attempts on ApiError", async () => {
  const api = new StudioApi({
    fetchImpl: async () =>
      jsonResponse(
        {
          error: {
            code: "upstream_error",
            message: "Upstream server error (HTTP 502).",
            detail: '{"error":{"message":"Post oauth2.googleapis.com/token: wsarecv forcibly closed"}}',
            upstream_status: 502,
            attempts: 3,
            partial_text: "",
            request_id: "req_502",
            retryable: true,
          },
        },
        502,
      ),
  });
  await assert.rejects(
    () => api.caption({ image: { data_url: "data:image/png;base64,AA==" } }),
    (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.code, "upstream_error");
      assert.equal(err.status, 502);
      assert.equal(err.upstreamStatus, 502);
      assert.equal(err.attempts, 3);
      assert.equal(err.requestId, "req_502");
      assert.match(err.detail, /forcibly closed/);
      return true;
    },
  );
});

test("gateway api lists, saves, activates, and deletes profiles", async () => {
  const calls = [];
  const api = new StudioApi({
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init?.method || "GET", body: init?.body ? JSON.parse(init.body) : null });
      return jsonResponse({ gateways: [], active_gateway_id: "" });
    },
  });

  await api.listGateways();
  assert.equal(calls[0].url, "/ai_prompt_studio/gateways");
  assert.equal(calls[0].method, "GET");

  const saved = await api.saveGateway({
    label: "本地 Magpie",
    base_url: "http://127.0.0.1:3425/v1",
    model: "magpie-1",
    key_id: "k1",
  });
  assert.equal(calls[1].url, "/ai_prompt_studio/gateways");
  assert.equal(calls[1].method, "POST");
  assert.deepEqual(calls[1].body, {
    label: "本地 Magpie",
    base_url: "http://127.0.0.1:3425/v1",
    model: "magpie-1",
    key_id: "k1",
    activate: true,
  });
  assert.deepEqual(saved, { gateways: [], active_gateway_id: "" });

  await api.activateGateway("gw/a b");
  assert.equal(calls[2].url, "/ai_prompt_studio/gateways/gw%2Fa%20b/activate");
  assert.equal(calls[2].method, "POST");
  assert.deepEqual(calls[2].body, {});

  await api.deleteGateway("gw_1");
  assert.equal(calls[3].url, "/ai_prompt_studio/gateways/gw_1");
  assert.equal(calls[3].method, "DELETE");
});

test("SSE error event preserves detail, http_status, partial_text, and attempts", async () => {
  const wire =
    'event: error\ndata: {"code":"stream_interrupted","http_status":502,"message":"The connection dropped mid-stream.","detail":"ConnectionResetError: [WinError 10054]","partial_text":"partial output","attempts":2,"request_id":"sse_1"}\n\n';
  const api = new StudioApi({
    fetchImpl: async () => new Response(wire, { status: 200 }),
  });
  await assert.rejects(
    () => api.chat({ message: "hi" }, () => {}),
    (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.code, "stream_interrupted");
      assert.equal(err.status, 502);
      assert.equal(err.attempts, 2);
      assert.equal(err.partialText, "partial output");
      assert.equal(err.requestId, "sse_1");
      assert.match(err.detail, /10054/);
      return true;
    },
  );
});


test("inspectImage posts the data URL to the inspect route", async () => {
  const calls = [];
  const api = new StudioApi({
    fetchImpl: async (url, init) => {
      calls.push([url, init]);
      return jsonResponse({ found: true, prompts: {}, draft: { items: [] } });
    },
  });
  const out = await api.inspectImage({ dataUrl: "data:image/png;base64,AA==", filename: "a.png" });
  assert.equal(out.found, true);
  assert.equal(calls[0][0], "/ai_prompt_studio/inspect_image");
  assert.equal(calls[0][1].method, "POST");
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    image_data: "data:image/png;base64,AA==",
    filename: "a.png",
  });
});

test("inspectImage passes an abort signal through to fetch", async () => {
  const controller = new AbortController();
  let received = null;
  const api = new StudioApi({
    fetchImpl: async (_url, init) => {
      received = init.signal;
      return jsonResponse({ found: false });
    },
  });
  await api.inspectImage({ dataUrl: "data:image/png;base64,AA==", signal: controller.signal });
  assert.equal(received, controller.signal);
});
