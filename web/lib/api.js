/**
 * Thin client for the same-origin workbench routes registered by the Python
 * side.  The API key never reaches the browser: it stays behind these routes.
 */

import { readSSE } from "./sse.js";

export class ApiError extends Error {
  constructor(message, { code = "api_error", status = 0, retryable = false, requestId = "" } = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.requestId = requestId;
  }
}

const DEFAULT_BASE = "/ai_prompt_studio";

export class StudioApi {
  constructor({ base = DEFAULT_BASE, fetchImpl } = {}) {
    this.base = String(base || DEFAULT_BASE).replace(/\/$/, "");
    this.fetchImpl = fetchImpl || ((...args) => globalThis.fetch(...args));
  }

  url(path) {
    return `${this.base}${path}`;
  }

  async request(path, { method = "GET", body, signal } = {}) {
    let response;
    try {
      response = await this.fetchImpl(this.url(path), {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (error && error.name === "AbortError") throw error;
      throw new ApiError("无法连接到 ComfyUI 服务，请确认后台仍在运行。", {
        code: "network_error",
        retryable: true,
      });
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const err = (payload && payload.error) || {};
      throw new ApiError(err.message || `请求失败（HTTP ${response.status}）`, {
        code: err.code || "http_error",
        status: response.status,
        retryable: Boolean(err.retryable),
        requestId: err.request_id || "",
      });
    }
    return payload;
  }

  status() {
    return this.request("/status");
  }

  saveConfig(body = {}) {
    return this.request("/config", { method: "POST", body });
  }

  listModels() {
    return this.request("/models");
  }

  probe({ force = false } = {}) {
    return this.request("/probe", { method: "POST", body: { force } });
  }

  capabilities() {
    return this.request("/capabilities");
  }

  edit({ message, target, model, images, session_id, create_session, allow_empty } = {}) {
    return this.request("/edit", {
      method: "POST",
      body: { message, target, model, images, session_id, create_session, allow_empty },
    });
  }

  apply({ text, ops }) {
    return this.request("/apply", { method: "POST", body: { text, ops } });
  }

  caption({ image, format = "prose", instruction = "", model, session_id, create_session } = {}) {
    return this.request("/caption", {
      method: "POST",
      body: { image, format, instruction, model, session_id, create_session },
    });
  }

  captionNode({ mode = "caption", modes, image, image_path = "", extra_instruction = "", model = "", session_id, create_session } = {}) {
    const body = { mode, image_path, extra_instruction, model, session_id, create_session };
    if (Array.isArray(modes) && modes.length > 0) body.modes = modes;
    if (image) body.image = image;
    return this.request("/caption_node", { method: "POST", body });
  }

  cloudGenerate({ prompt, width = 1024, height = 1024, mode = "caption", model } = {}) {
    return this.request("/cloud_generate", {
      method: "POST",
      body: { prompt, width, height, mode, model },
    });
  }

  addVersion({ target, text, source = "apply", label = "", meta } = {}) {
    return this.request("/versions", { method: "POST", body: { target, text, source, label, meta } });
  }

  listVersions(target, { limit = 50 } = {}) {
    const query = new URLSearchParams({ target, limit: String(limit) });
    return this.request(`/versions?${query.toString()}`);
  }

  getVersion(id) {
    return this.request(`/versions/${encodeURIComponent(id)}`);
  }

  deleteSession(id) {
    return this.request(`/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  getSession(id) {
    return this.request(`/sessions/${encodeURIComponent(id)}`);
  }

  /**
   * Stream a chat turn.  `onEvent` receives `{event, data}` for every SSE
   * event; the returned promise resolves after the stream ends.
   */
  async chat(body, onEvent, { signal } = {}) {
    let response;
    try {
      response = await this.fetchImpl(this.url("/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (error && error.name === "AbortError") throw error;
      throw new ApiError("无法连接到 ComfyUI 服务，请确认后台仍在运行。", {
        code: "network_error",
        retryable: true,
      });
    }
    if (!response.ok) {
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      const err = (payload && payload.error) || {};
      throw new ApiError(err.message || `请求失败（HTTP ${response.status}）`, {
        code: err.code || "http_error",
        status: response.status,
        retryable: Boolean(err.retryable),
      });
    }
    let streamError = null;
    await readSSE(
      response,
      (event) => {
        if (event.event === "error") {
          const data = event.data || {};
          streamError = new ApiError(data.message || "模型请求失败。", {
            code: data.code || "stream_error",
            retryable: Boolean(data.retryable),
            requestId: data.request_id || "",
          });
        }
        onEvent(event);
      },
      { signal },
    );
    if (streamError) throw streamError;
  }
}
