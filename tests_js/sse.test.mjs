import test from "node:test";
import assert from "node:assert/strict";

import { createSSEParser, readSSE } from "../web/lib/sse.js";

test("parses events across arbitrary chunk boundaries", () => {
  const parser = createSSEParser();
  const events = [];
  const wire =
    "event: meta\ndata: {\"session_id\":\"s1\"}\n\n" +
    "event: delta\ndata: {\"text\":\"he\"}\n\n" +
    "event: delta\ndata: {\"text\":\"llo\"}\n\n" +
    "event: done\ndata: {\"text\":\"hello\"}\n\n";
  for (const char of wire) events.push(...parser.push(char));
  assert.equal(events.length, 4);
  assert.equal(events[0].event, "meta");
  assert.equal(events[0].data.session_id, "s1");
  assert.deepEqual(events.slice(1, 3).map((e) => e.data.text), ["he", "llo"]);
  assert.equal(events[3].data.text, "hello");
});

test("handles CRLF, comments and multi-line data", () => {
  const parser = createSSEParser();
  const events = parser.push(": keep-alive\r\n" + "event: note\r\n" + "data: line1\r\ndata: line2\r\n\r\n");
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "note");
  assert.equal(events[0].data, "line1\nline2");
});

test("flush dispatches a trailing event without a blank line", () => {
  const parser = createSSEParser();
  assert.equal(parser.push("event: done\ndata: {\"ok\":true}").length, 0);
  const events = parser.flush();
  assert.equal(events.length, 1);
  assert.equal(events[0].data.ok, true);
});

test("plain data that is not JSON stays a string", () => {
  const parser = createSSEParser();
  const events = parser.push("data: [DONE]\n\n");
  assert.equal(events[0].data, "[DONE]");
});

test("readSSE consumes a streaming response", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("event: delta\ndata: {\"text\":\"a\"}\n"));
      controller.enqueue(encoder.encode("\nevent: done\ndata: {\"text\":\"ab\"}\n\n"));
      controller.close();
    },
  });
  const seen = [];
  await readSSE(new Response(stream, { status: 200 }), (event) => seen.push(event));
  assert.deepEqual(seen.map((e) => e.event), ["delta", "done"]);
});

test("readSSE rejects non-OK responses with the body preview", async () => {
  const response = new Response('{"error":{"message":"nope"}}', { status: 422 });
  await assert.rejects(() => readSSE(response, () => {}), /HTTP 422/);
});
