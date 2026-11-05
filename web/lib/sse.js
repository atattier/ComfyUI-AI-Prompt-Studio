/**
 * Minimal Server-Sent Events parser for the workbench.
 *
 * It is chunk-safe (a network chunk may split a line or a `data:` payload),
 * ignores comment lines, joins multi-line `data:` fields and parses JSON
 * payloads when possible.  No EventSource: the chat request is a POST with a
 * body, which EventSource cannot send.
 */

export function createSSEParser() {
  let buffer = "";
  let eventName = "message";
  let dataLines = [];

  function dispatch(out) {
    if (dataLines.length) {
      const raw = dataLines.join("\n");
      let data = raw;
      if (raw.trim() !== "") {
        try {
          data = JSON.parse(raw);
        } catch {
          data = raw;
        }
      }
      out.push({ event: eventName, data });
    }
    eventName = "message";
    dataLines = [];
  }

  function handleLine(line, out) {
    if (line === "") {
      dispatch(out);
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value || "message";
    else if (field === "data") dataLines.push(value);
    // `id` and `retry` are irrelevant for a single request/response stream.
  }

  return {
    push(chunk) {
      buffer += chunk;
      const out = [];
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        let line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        handleLine(line, out);
      }
      return out;
    },
    flush() {
      const out = [];
      if (buffer.length) {
        const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
        buffer = "";
        handleLine(line, out);
      }
      dispatch(out);
      return out;
    },
  };
}

/**
 * Read a fetch Response as SSE, calling `onEvent({event, data})` per event.
 * Returns when the stream ends; aborting the passed signal cancels the read.
 */
export async function readSSE(response, onEvent, { signal } = {}) {
  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      /* body may be empty */
    }
    throw new Error(
      `HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
    );
  }
  if (!response.body) throw new Error("浏览器不支持流式读取响应。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSSEParser();
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      for (const event of parser.push(text)) onEvent(event);
    }
    for (const event of parser.flush()) onEvent(event);
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}
