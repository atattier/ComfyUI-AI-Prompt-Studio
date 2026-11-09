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

