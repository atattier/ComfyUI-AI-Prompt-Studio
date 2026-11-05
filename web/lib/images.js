/**
 * Image helpers for the workbench.
 *
 * The backend accepts a data URL, an http(s) URL or a plain base64 string.
 * Canvas previews are same-origin ComfyUI `/view?...` URLs, so they are fetched
 * and re-encoded here: the model provider must never be asked to fetch an
 * address that only exists inside the user's LAN.
 */

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  const mime = blob.type || "image/png";
  return `data:${mime};base64,${bytesToBase64(new Uint8Array(buffer))}`;
}

export async function fileToDataUrl(file, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!file) throw new Error("没有选择图片。");
  if (!String(file.type || "").startsWith("image/")) {
    throw new Error("请选择图片文件。");
  }
  if (file.size > maxBytes) {
    throw new Error(`图片过大（${Math.round(file.size / 1024 / 1024)} MB），上限 ${Math.round(maxBytes / 1024 / 1024)} MB。`);
  }
  return blobToDataUrl(file);
}

export async function urlToDataUrl(url, { maxBytes = DEFAULT_MAX_BYTES, fetchImpl } = {}) {
  if (!url) throw new Error("没有可用的图片。");
  if (String(url).startsWith("data:")) return String(url);
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  const response = await doFetch(url, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`读取图片失败（HTTP ${response.status}）。`);
  const blob = await response.blob();
  if (blob.size > maxBytes) {
    throw new Error(`图片过大（${Math.round(blob.size / 1024 / 1024)} MB），上限 ${Math.round(maxBytes / 1024 / 1024)} MB。`);
  }
  if (!String(blob.type || "").startsWith("image/")) {
    throw new Error("所选节点的预览不是图片。");
  }
  return blobToDataUrl(blob);
}

/** Resolve a canvas image source (URL or widget filename) to a data URL. */
export async function sourceToDataUrl(source, options = {}) {
  if (!source) throw new Error("没有可用的图片。");
  if (source.url) return urlToDataUrl(source.url, options);
  if (source.filename) {
    const query = new URLSearchParams({ filename: source.filename, type: "input" });
    return urlToDataUrl(`/view?${query.toString()}`, options);
  }
  throw new Error("没有可用的图片。");
}
