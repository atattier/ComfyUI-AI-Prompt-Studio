/**
 * Thin client for the same-origin workbench routes registered by the Python
 * side.  The API key never reaches the browser: it stays behind these routes.
 */

import { readSSE } from "./sse.js";

export class ApiError extends Error {
  constructor(
    message,
    {
      code = "api_error",
      status = 0,
      retryable = false,
      requestId = "",
      detail = "",
      upstreamStatus = null,
      attempts = 1,
      partialText = "",
    } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.requestId = requestId;
    this.detail = detail ? String(detail) : "";
    this.upstreamStatus =
      upstreamStatus != null && Number.isFinite(Number(upstreamStatus)) ? Number(upstreamStatus) : null;
    this.attempts = Number.isFinite(Number(attempts)) && Number(attempts) > 0 ? Number(attempts) : 1;
    this.partialText = partialText ? String(partialText) : "";
  }
}

function errorDetailString(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  const name = error.name ? String(error.name) : "Error";
  const msg = error.message ? String(error.message) : String(error);
  return msg.startsWith(`${name}:`) ? msg : `${name}: ${msg}`;
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
        detail: errorDetailString(error),
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
        detail: err.detail || "",
        upstreamStatus: err.upstream_status ?? null,
        attempts: err.attempts ?? 1,
        partialText: err.partial_text || "",
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

  /** Stored keys for the current Base URL: `{ keys: [{id,label,masked,active}], active_key_id }`. */
  listKeys() {
    return this.request("/keys");
  }

  addKey({ api_key, label = "", activate = true } = {}) {
    return this.request("/keys", { method: "POST", body: { api_key, label, activate } });
  }

  activateKey(id) {
    return this.request(`/keys/${encodeURIComponent(id)}/activate`, { method: "POST", body: {} });
  }

  deleteKey(id) {
    return this.request(`/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  /** Saved gateway profiles: label + Base URL + model + bound key, switched in one call. */
  listGateways() {
    return this.request("/gateways");
  }

  saveGateway({ label = "", base_url, model, key_id = "", activate = true } = {}) {
    return this.request("/gateways", {
      method: "POST",
      body: { label, base_url, model, key_id, activate },
    });
  }

  activateGateway(id) {
    return this.request(`/gateways/${encodeURIComponent(id)}/activate`, {
      method: "POST",
      body: {},
    });
  }

  deleteGateway(id) {
    return this.request(`/gateways/${encodeURIComponent(id)}`, { method: "DELETE" });
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

  edit({ message, target, mode, model, images, session_id, create_session, allow_empty, canvas } = {}, { signal } = {}) {
    return this.request("/edit", {
      method: "POST",
      body: { message, target, mode, model, images, session_id, create_session, allow_empty, canvas },
      signal,
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

  completeFromPrompt({
    prompt,
    source_mode = "auto",
    modes,
    width = 1024,
    height = 1024,
    size_mode = "auto",
    model = "",
    extra_instruction = "",
  } = {}) {
    const body = { prompt, source_mode, width, height, size_mode, model, extra_instruction };
    if (Array.isArray(modes) && modes.length > 0) body.modes = modes;
    return this.request("/complete_from_prompt", { method: "POST", body });
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
        detail: errorDetailString(error),
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
        requestId: err.request_id || "",
        detail: err.detail || "",
        upstreamStatus: err.upstream_status ?? null,
        attempts: err.attempts ?? 1,
        partialText: err.partial_text || "",
      });
    }
    let streamError = null;
    try {
      await readSSE(
        response,
        (event) => {
          if (event.event === "error") {
            const data = event.data || {};
            streamError = new ApiError(data.message || "模型请求失败。", {
              code: data.code || "stream_error",
              status: Number(data.http_status || data.status || 0) || 0,
              retryable: Boolean(data.retryable),
              requestId: data.request_id || "",
              detail: data.detail || "",
              upstreamStatus: data.upstream_status ?? null,
              attempts: data.attempts ?? 1,
              partialText: data.partial_text || "",
            });
          }
          onEvent(event);
        },
        { signal },
      );
    } catch (error) {
      if (error && error.name === "AbortError") throw error;
      if (error instanceof ApiError) throw error;
      throw new ApiError("流式响应读取中断，请重试。", {
        code: "stream_interrupted",
        retryable: true,
        detail: errorDetailString(error),
      });
    }
    if (streamError) throw streamError;
  }

  listPresets({ category, search } = {}) {
    const params = new URLSearchParams();
    if (category) params.set("category", category);
    if (search) params.set("search", search);
    const qs = params.toString();
    return this.request(`/presets${qs ? `?${qs}` : ""}`);
  }

  listPresetCategories() {
    return this.request("/presets/categories");
  }

  addPresetCategory(name) {
    return this.request("/presets/categories", { method: "POST", body: { name } });
  }

  deletePresetCategory(name) {
    return this.request(`/presets/categories/${encodeURIComponent(name)}`, { method: "DELETE" });
  }

  renamePresetCategory(oldName, newName) {
    return this.request(`/presets/categories/${encodeURIComponent(oldName)}`, {
      method: "PUT",
      body: { new_name: newName },
    });
  }

  /** Read prompt/layout metadata out of an image without creating a preset. */
  inspectImage({ dataUrl, filename = "", signal } = {}) {
    return this.request("/inspect_image", {
      method: "POST",
      body: { image_data: dataUrl, filename },
      signal,
    });
  }

  importPresetImage({ dataUrl, filename, category } = {}) {
    return this.request("/presets/import_image", {
      method: "POST",
      body: { image_data: dataUrl, filename, category },
    });
  }

  resetBuiltinPresets() {
    return this.request("/presets/reset_builtins", { method: "POST" });
  }

  /** URL of the original image (with embedded ComfyUI metadata) attached to a preset. */
  presetImageUrl(id) {
    return this.url(`/presets/${encodeURIComponent(id)}/image`);
  }

  getPreset(id) {
    return this.request(`/presets/${encodeURIComponent(id)}`);
  }

  savePreset(body = {}) {
    return this.request("/presets", { method: "POST", body });
  }

  deletePreset(id) {
    return this.request(`/presets/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  importPresets(presets = []) {
    return this.request("/presets/import", { method: "POST", body: { presets } });
  }

  exportPresets() {
    return this.request("/presets/export");
  }

  summarizePresetTitle({ presetId, prompt, draft, model } = {}) {
    return this.request("/presets/summarize_title", {
      method: "POST",
      body: { preset_id: presetId, prompt, draft, model },
    });
  }

  reCaptionPreset(presetId, { model } = {}) {
    return this.request(`/presets/${encodeURIComponent(presetId)}/re_caption`, {
      method: "POST",
      body: { model },
    });
  }

  reloadPresetMetadata(presetId) {
    return this.request(`/presets/${encodeURIComponent(presetId)}/reload_metadata`, {
      method: "POST",
    });
  }

  // ------------------------------------------------------------- LoRA Presets
  _notifyLoraPresetsChanged(detail = {}) {
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      try {
        window.dispatchEvent(new CustomEvent("aps:lora-presets-updated", { detail }));
      } catch {}
    }
  }

  listLoraPresets({ category = "", search = "", modelType = "" } = {}) {
    const query = new URLSearchParams();
    if (category && category !== "全部") query.set("category", category);
    if (search) query.set("search", search);
    if (modelType && modelType !== "全部") query.set("model_type", modelType);
    const qs = query.toString();
    return this.request(`/lora_presets${qs ? "?" + qs : ""}`);
  }

  listLoraModelTypes() {
    return this.request("/lora_presets/model_types");
  }

  getAvailableLoras() {
    return this.request("/lora_presets/available_loras");
  }

  getLoraPreset(id) {
    return this.request(`/lora_presets/${encodeURIComponent(id)}`);
  }

  saveLoraPreset(body = {}) {
    return this.request("/lora_presets", { method: "POST", body }).then((res) => {
      this._notifyLoraPresetsChanged({ action: "save", result: res, body });
      return res;
    });
  }

  deleteLoraPreset(id) {
    return this.request(`/lora_presets/${encodeURIComponent(id)}`, { method: "DELETE" }).then((res) => {
      this._notifyLoraPresetsChanged({ action: "delete", id });
      return res;
    });
  }

  listLoraPresetCategories() {
    return this.request("/lora_presets/categories");
  }

  addLoraPresetCategory(name) {
    return this.request("/lora_presets/categories", {
      method: "POST",
      body: { name },
    });
  }

  deleteLoraPresetCategory(name) {
    return this.request(`/lora_presets/categories/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  }

  renameLoraPresetCategory(oldName, newName) {
    return this.request(`/lora_presets/categories/${encodeURIComponent(oldName)}`, {
      method: "PUT",
      body: { new_name: newName },
    });
  }

  resetBuiltinLoraPresets() {
    return this.request("/lora_presets/reset_builtins", { method: "POST" }).then((res) => {
      this._notifyLoraPresetsChanged({ action: "reset", result: res });
      return res;
    });
  }

  loraPresetImageUrl(id) {
    return this.url(`/lora_presets/${encodeURIComponent(id)}/image`);
  }

  /** URL for local LoRA preview cover image by its filename or relative path. */
  loraPreviewImageUrl(name) {
    if (!name) return "";
    return this.url(`/lora_presets/preview_image?name=${encodeURIComponent(name)}`);
  }

  importLoraPresets(presets = []) {
    return this.request("/lora_presets/import", { method: "POST", body: { presets } }).then((res) => {
      this._notifyLoraPresetsChanged({ action: "import", result: res });
      return res;
    });
  }

  inspectImageLoras({ image_data, filename = "" } = {}) {
    return this.request("/lora_presets/inspect_image_loras", {
      method: "POST",
      body: { image_data, filename },
    });
  }

  exportLoraPresets() {
    return this.request("/lora_presets/export");
  }
}
