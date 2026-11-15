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

/**
 * Parse ComfyUI image reference strings (e.g. "foo.png [input]", "sub/bar.png [temp]").
 */
export function parseComfyImageRef(rawVal) {
  if (!rawVal || typeof rawVal !== "string") return null;
  let filename = rawVal.trim();
  let type = "input";
  let subfolder = "";

  if (filename.endsWith(" [output]")) {
    type = "output";
    filename = filename.replace(/ \[output\]$/, "").trim();
  } else if (filename.endsWith(" [input]")) {
    type = "input";
    filename = filename.replace(/ \[input\]$/, "").trim();
  } else if (filename.endsWith(" [temp]")) {
    type = "temp";
    filename = filename.replace(/ \[temp\]$/, "").trim();
  }

  const normalized = filename.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash !== -1) {
    subfolder = normalized.slice(0, lastSlash);
    filename = normalized.slice(lastSlash + 1);
  } else {
    filename = normalized;
  }

  return { filename, type, subfolder };
}

/**
 * Build a valid ComfyUI /view URL from a filename string, handling suffixes and subfolders.
 */
export function buildComfyViewUrl(rawVal) {
  if (!rawVal) return null;
  if (typeof rawVal === "string" && (
    rawVal.startsWith("data:") ||
    rawVal.startsWith("blob:") ||
    rawVal.startsWith("http://") ||
    rawVal.startsWith("https://") ||
    rawVal.startsWith("/view?")
  )) {
    return rawVal;
  }
  const parsed = parseComfyImageRef(rawVal);
  if (!parsed || !parsed.filename) return null;
  const params = new URLSearchParams();
  params.set("filename", parsed.filename);
  if (parsed.type) params.set("type", parsed.type);
  if (parsed.subfolder) params.set("subfolder", parsed.subfolder);
  return `/view?${params.toString()}`;
}

/** Resolve a canvas image source (URL or widget filename) to a data URL. */
export async function sourceToDataUrl(source, options = {}) {
  if (!source) throw new Error("没有可用的图片。");
  if (source.url) return urlToDataUrl(source.url, options);
  if (source.filename) {
    const viewUrl = buildComfyViewUrl(source.filename);
    return urlToDataUrl(viewUrl, options);
  }
  throw new Error("没有可用的图片。");
}

/** Convert a data URL string to a standard File object. */
export function dataUrlToFile(dataUrl, filename = "uploaded_image.png") {
  if (!dataUrl || typeof dataUrl !== "string") {
    throw new Error("无效的图片 Data URL。");
  }
  const parts = dataUrl.split(",");
  const mime = parts[0]?.match(/:(.*?);/)?.[1] || "image/png";
  const bstr = atob(parts[1] || "");
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  return new File([u8arr], filename, { type: mime });
}

/** Upload an image file to ComfyUI's standard /upload/image endpoint and return the saved filename. */
export async function uploadImageFile(file, { subfolder = "", overwrite = true } = {}) {
  if (!file) throw new Error("没有可上传的图片文件。");
  const formData = new FormData();
  formData.append("image", file);
  if (subfolder) formData.append("subfolder", subfolder);
  if (overwrite) formData.append("overwrite", "true");

  const response = await fetch("/upload/image", {
    method: "POST",
    body: formData,
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new Error(`上传图片至 ComfyUI 服务端失败（HTTP ${response.status}）。`);
  }
  const data = await response.json();
  return data.name || data.filename || file.name;
}

/** Largest original image the preset library will keep (base64 must fit the 25 MB request cap). */
export const MAX_PRESET_IMAGE_BYTES = 15 * 1024 * 1024;

/**
 * Fetch a ComfyUI image reference ({filename, subfolder, type}) as an untouched data URL.
 * The bytes are not re-encoded, so PNG metadata (workflow / prompt) is preserved.
 */
export async function fetchComfyImageRef(ref, { maxBytes = MAX_PRESET_IMAGE_BYTES, fetchImpl } = {}) {
  if (!ref || !ref.filename) throw new Error("没有可用的生成图。");
  const params = new URLSearchParams();
  params.set("filename", ref.filename);
  params.set("type", ref.type || "output");
  if (ref.subfolder) params.set("subfolder", ref.subfolder);
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  const response = await doFetch(`/view?${params.toString()}`, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`读取生成图失败（HTTP ${response.status}）。`);
  const blob = await response.blob();
  if (blob.size > maxBytes) {
    throw new Error(`生成图过大（${Math.round(blob.size / 1024 / 1024)} MB），预设库上限 ${Math.round(maxBytes / 1024 / 1024)} MB。`);
  }
  if (!String(blob.type || "").startsWith("image/")) throw new Error("该文件不是图片。");
  return { dataUrl: await blobToDataUrl(blob), bytes: blob.size, mime: blob.type };
}

/** Downscale an image data URL to a small JPEG thumbnail (browser only; metadata is dropped). */
export async function makeThumbnailDataUrl(src, { maxSide = 360, quality = 0.82 } = {}) {
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error("无法解码图片以生成缩略图。"));
    img.src = src;
  });
  const longest = Math.max(img.naturalWidth, img.naturalHeight) || 1;
  const scale = Math.min(1, maxSide / longest);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0b0f14";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

