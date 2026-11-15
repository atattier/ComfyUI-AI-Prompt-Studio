/**
 * Client-side helpers for the diff card.  The authoritative diff and the
 * validation of edit operations live on the server (`prompt_studio.diff`);
 * nothing here decides what may be applied.
 */

export const OPERATION_LABELS = {
  replace: "替换",
  delete: "删除",
  insert_after: "插入",
  append: "追加",
};

export const BLOCK_LABELS = {
  equal: "未变",
  add: "新增",
  del: "删除",
  change: "修改",
};

export function operationLabel(op) {
  return OPERATION_LABELS[String(op || "").toLowerCase()] || String(op || "修改");
}

export function blockLabel(type) {
  return BLOCK_LABELS[type] || "";
}

export function summarizeBlocks(blocks) {
  const counts = { equal: 0, add: 0, del: 0, change: 0 };
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const type = block && block.type;
    if (type in counts) counts[type] += 1;
  }
  return counts;
}

export function changeCount(blocks) {
  const counts = summarizeBlocks(blocks);
  return counts.add + counts.del + counts.change;
}

export function describeStats(blocks) {
  const counts = summarizeBlocks(blocks);
  const parts = [];
  if (counts.change) parts.push(`${counts.change} 处修改`);
  if (counts.add) parts.push(`${counts.add} 处新增`);
  if (counts.del) parts.push(`${counts.del} 处删除`);
  return parts.length ? parts.join("，") : "没有变化";
}

/**
 * Pick the operations the user checked.  Indices refer to the proposal's
 * `changes` array; invalid or unchecked indices are dropped.
 */
export function selectOps(changes, selected) {
  const list = Array.isArray(changes) ? changes : [];
  const keep = new Set(Array.isArray(selected) ? selected : []);
  return list.filter((_, index) => keep.has(index));
}

export function describeOp(op) {
  const label = operationLabel(op && op.op);
  const before = op && typeof op.before === "string" ? op.before : "";
  const after = op && typeof op.after === "string" ? op.after : "";
  if (!before) return `${label}：${after}`;
  if (!after) return `${label}：${before}`;
  return `${label}：${before} → ${after}`;
}

/** Short single-line excerpt used in history lists. */
export function excerpt(text, limit = 48) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit - 1)}…`;
}

/**
 * Format a concise single-line HUD execution status label so long dialog
 * inputs or multi-line instructions never bloat HUD banners or status bars.
 */
export function formatBusyStatusText(
  instructionOrLabel,
  { regionIndex = -1, regionName = "", maxInstructionChars = 22, maxRegionChars = 10 } = {},
) {
  const raw = String(instructionOrLabel || "").replace(/\s+/g, " ").trim();
  const cleanNoEllipsis = raw.replace(/[.…]+$/g, "").trim();
  const source = cleanNoEllipsis || raw;
  const limit = Math.max(4, Number(maxInstructionChars) || 24);
  const preview = excerpt(source, limit);
  const suffix = preview && !preview.endsWith("…") ? "…" : "";

  if (regionIndex >= 0) {
    const regPreview = excerpt(regionName || "", Math.max(2, Number(maxRegionChars) || 12));
    const namePart = regPreview ? `「${regPreview}」` : "";
    if (!preview) {
      return `正在修改 @画框 #${regionIndex + 1}${namePart}…`;
    }
    return `正在修改 @画框 #${regionIndex + 1}${namePart}：${preview}${suffix}`;
  }
  if (!preview) {
    return "AI 正在处理中…";
  }
  return `正在执行：${preview}${suffix}`;
}

/**
 * Word-level diff: return merged [start, end) ranges of fter that are new or
 * changed relative to efore.  Used to mark edited spots inside the prompt text.
 */
export function wordDiffRanges(before, after, { maxTokens = 1500 } = {}) {
  const tokenize = (text) => {
    const out = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(text))) out.push({ w: m[0], s: m.index, e: m.index + m[0].length });
    return out;
  };
  const a = tokenize(String(before || ""));
  const b = tokenize(String(after || ""));
 if (!b.length || a.length > maxTokens || b.length > maxTokens) return [];
 const n = a.length;
 const m = b.length;
 const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
 for (let i = n - 1; i >= 0; i--) {
 for (let j = m - 1; j >= 0; j--) {
 dp[i][j] = a[i].w === b[j].w ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
 }
 }
 const changed = new Array(m).fill(true);
 let i = 0;
 let j = 0;
 while (i < n && j < m) {
 if (a[i].w === b[j].w) {
 changed[j] = false;
 i++;
 j++;
 } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
 else j++;
 }
 const ranges = [];
 for (let k = 0; k < m; k++) {
 if (!changed[k]) continue;
 const last = ranges[ranges.length - 1];
 if (last && last.k === k - 1) {
 last.e = b[k].e;
 last.k = k;
 } else ranges.push({ s: b[k].s, e: b[k].e, k });
 }
 return ranges.map((r) => [r.s, r.e]);
}

function parseUpstreamDetailMessage(rawDetail) {
  const raw = String(rawDetail || "").trim();
  if (!raw) return "";
  if (raw.startsWith("{")) {
    try {
      const obj = JSON.parse(raw);
      const nested =
        obj?.error?.message ||
        obj?.error?.detail ||
        obj?.message ||
        obj?.detail ||
        (typeof obj?.error === "string" ? obj.error : "");
      if (typeof nested === "string" && nested.trim()) {
        return nested.trim();
      }
    } catch {
      const m = raw.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (m && m[1]) {
        return m[1].replace(/\\"/g, '"').replace(/\\n/g, " ").trim();
      }
    }
  }
  return raw;
}

function stripUpstreamWrapper(msg) {
  return String(msg || "")
    .replace(
      /^(?:Upstream server error|Unexpected upstream response|Provider rejected the request|Rate limited by the provider|Endpoint or model not found|Access denied by the provider|Authentication failed)\s*\(HTTP \d+\)\.\s*/i,
      "",
    )
    .trim();
}

function formatHttpLabel(status, upstreamStatus) {
  const s = Number(status) || 0;
  const u =
    upstreamStatus != null && Number.isFinite(Number(upstreamStatus)) ? Number(upstreamStatus) : 0;
  if (s > 0 && u > 0 && s !== u) return `本地 ${s} / 上游 ${u}`;
  if (u > 0) return `上游 ${u}`;
  if (s > 0) return String(s);
  return "";
}

function normalizeErrorFields(err) {
  if (typeof err === "string") {
    return {
      code: "",
      status: 0,
      upstreamStatus: null,
      attempts: 1,
      requestId: "",
      partialText: "",
      message: err,
      detail: "",
    };
  }
  const src = err && typeof err === "object" ? err : {};
  return {
    code: String(src.code || ""),
    status: Number(src.status || src.http_status || 0) || 0,
    upstreamStatus:
      src.upstreamStatus != null && Number.isFinite(Number(src.upstreamStatus))
        ? Number(src.upstreamStatus)
        : src.upstream_status != null && Number.isFinite(Number(src.upstream_status))
          ? Number(src.upstream_status)
          : null,
    attempts: Math.max(1, Number(src.attempts) || 1),
    requestId: String(src.requestId || src.request_id || ""),
    partialText: String(src.partialText || src.partial_text || ""),
    message: String(src.message || (src instanceof Error ? src.toString() : "") || "").trim(),
    detail: String(src.detail || "").trim(),
  };
}

/**
 * Format an API, stream, gateway, or network error into a clear, actionable
 * Chinese explanation instead of a coarse "502 Gateway Unavailable".
 */
export function formatFriendlyError(err, actionName = "操作") {
  const {
    code,
    status,
    upstreamStatus,
    attempts,
    partialText,
    message: rawMsg,
    detail: rawDetail,
  } = normalizeErrorFields(err);

  const msg = rawMsg || "未知错误";
  const parsedDetail = parseUpstreamDetailMessage(rawDetail);
  const strippedMsg = stripUpstreamWrapper(msg);
  const readableUpstream = parsedDetail || strippedMsg;
  const haystack = `${msg}\n${parsedDetail}\n${rawDetail}`;
  const retryPart = attempts > 1 ? `，已自动重试 ${attempts - 1} 次` : "";
  const statusLabel = formatHttpLabel(status, upstreamStatus);

  // 1. Outdated ComfyUI Python module in memory
  if (
    msg.includes("mode must be one of caption, layout, hybrid") ||
    /unknown mode:\s*danbooru/i.test(msg)
  ) {
    return "⚠️ 检测到 ComfyUI 正在运行旧版内核内存：请在秋叶启动器中点击一次【一键启动 / 重启内核】，重新加载 Danbooru 模式与新端口即可！";
  }

  // 2. Content filter
  if (/content_filter|安全策略拦截/i.test(haystack)) {
    return msg.startsWith("🛡") ? msg : `🛡 触发上游内容安全策略拦截 (content_filter)：${excerpt(readableUpstream || msg, 120)}`;
  }

  // 3. Config / Capability / Diff validation
  if (code === "config_error") {
    return "插件尚未完成配置：请点击「设置」填写 Base URL、API Key 与默认模型。";
  }
  if (code === "capability_unsupported") {
    return `❌ 当前模型不支持此能力：${excerpt(readableUpstream || msg, 120)}，请在「设置」更换支持视觉或对话的模型。`;
  }
  if (code === "invalid_edit") {
    return `❌ AI 生成的改词指令未通过校验：${excerpt(msg, 130)}，请重试或换个说法描述需求。`;
  }

  // 4. Stream interrupted (pre-first-token reset vs mid-stream partial loss)
  const isStreamDrop =
    code === "stream_interrupted" ||
    /dropped mid-stream|before any content|stream ended before|流式响应读取中断|timed out before completion/i.test(msg);
  if (isStreamDrop) {
    const isTcpReset = /10054|forcibly closed|wsarecv|connection reset|broken pipe|强迫关闭/i.test(haystack);
    const isTlsDrop = /TLS|SSL|handshake|certificate/i.test(haystack);
    const isTimeoutDrop = /timed out|timeout|超时/i.test(haystack);
    const isEarlyClose = /RemoteDisconnected|IncompleteRead|closed connection without response/i.test(haystack);

    const dropCause = isTcpReset
      ? "本地代理或出站 TCP 连接被掐断"
      : isTlsDrop
        ? "TLS 安全链路异常断开"
        : isTimeoutDrop
          ? "流式读取等待超时"
          : isEarlyClose
            ? "上游或网关提前关闭响应流"
            : "传输流意外断开";

    if (partialText || /mid-stream/i.test(msg)) {
      const charNote = partialText ? `已收到 ${partialText.length} 字` : "已输出部分内容";
      return `❌ ${actionName}在输出中途中断（${dropCause}，${charNote}${retryPart}）：当前网关仅支持在首字前自动切换备用模型，吐字一半断开需点击重试。`;
    }
    if (/stream ended before any content/i.test(msg)) {
      return `❌ ${actionName}返回空流（网关返回 200 但未输出任何内容${retryPart}）：请检查当前模型渠道状态或切换模型后重试。`;
    }
    return `❌ ${actionName}在首字返回前连接中断（${dropCause}${retryPart}）：未收到模型输出，多由代理节点抖动或出口连接被重置所致，请直接重试。`;
  }

  // 5. Timeouts (first-token timeout / streaming total budget / TLS handshake timeout)
  if (
    code === "upstream_timeout" ||
    status === 504 ||
    upstreamStatus === 504 ||
    /exceeded the .*budget|did not respond|timed out|TLS handshake timeout/i.test(msg)
  ) {
    if (/TLS handshake timeout/i.test(haystack)) {
      return `⏱️ ${actionName} TLS 握手超时（代理/出站链路无响应${retryPart}）：本地代理发往上游的加密握手超时，请检查代理节点稳定性后重试。`;
    }
    if (/exceeded the .*budget/i.test(msg)) {
      return `⏱️ ${actionName}总耗时超出流式上限（${msg}${retryPart}）：请在「设置」中调大请求超时（建议 120~180 秒）或改用更快的模型。`;
    }
    return `⏱️ ${actionName}等待模型首字响应超时（${msg}${retryPart}）：Thinking 模型思考或大图解析耗时较长，可在「设置」将超时调大至 120~180 秒后重试。`;
  }

  // 6. Network errors (browser <-> ComfyUI vs ComfyUI <-> gateway)
  if (
    code === "network_error" ||
    (status === 0 && /Failed to fetch|NetworkError|Load failed|无法连接到 ComfyUI/i.test(haystack))
  ) {
    if (status === 0 && /Failed to fetch|NetworkError|Load failed|无法连接到 ComfyUI/i.test(haystack)) {
      return "❌ 无法连接到 ComfyUI 后台服务：请确认 ComfyUI 进程仍在运行（未崩溃或重启）。";
    }
    if (/10061|ConnectionRefusedError|actively refused|积极拒绝/i.test(haystack)) {
      return `❌ AI 网关连接被拒绝（本地端口未开启${retryPart}）：请确认本地网关（如 Magpie）已启动，且与「设置」中的 Base URL 端口一致。`;
    }
    if (/10054|forcibly closed|wsarecv|connection reset|强迫关闭/i.test(haystack)) {
      return `❌ 到 AI 网关或代理的连接被强制关闭（TCP Reset${retryPart}）：多为代理端口重启或出站链路中断所致，请重试。`;
    }
    if (/TLS|SSL|certificate|handshake/i.test(haystack)) {
      return `❌ AI 网关 TLS/SSL 握手失败（${excerpt(readableUpstream || msg, 85)}${retryPart}）：请检查 Base URL 协议或代理证书配置。`;
    }
    if (/getaddrinfo|NameResolution|nodename|resolve/i.test(haystack)) {
      return `❌ AI 网关域名无法解析（${excerpt(readableUpstream || msg, 85)}）：请检查「设置」中的 Base URL 或本机 DNS / 代理。`;
    }
    return `❌ 无法连接到 AI 网关（${excerpt(readableUpstream || msg, 85)}${retryPart}）：请检查「设置」中的 Base URL 与本地网关/代理是否正常开启。`;
  }

  // 7. Auth (401) — evaluated before 5xx so 502 wrapping OAuth transport failures doesn't pretend to be 401
  if (
    code === "auth_failed" ||
    code === "server_unauthorized" ||
    status === 401 ||
    upstreamStatus === 401
  ) {
    if (code === "server_unauthorized") {
      return `❌ ComfyUI 后端本地鉴权未通过 (401)：${excerpt(msg, 120)}`;
    }
    return "❌ 网关鉴权失败 (401)：API Key 无效、已过期或未填写，请点击「设置」配置有效密钥。";
  }

  // 8. Access Denied (403)
  if (code === "access_denied" || status === 403 || upstreamStatus === 403) {
    return `❌ 网关拒绝访问 (403)：${excerpt(readableUpstream || "当前密钥无权访问该模型或账号受限", 110)}`;
  }

  // 9. Not Found (404)
  if (
    code === "not_found" ||
    code === "model_not_found" ||
    status === 404 ||
    upstreamStatus === 404
  ) {
    if (/session not found/i.test(haystack)) {
      return "❌ 对话上下文已失效 (404)：后台找不到该会话 ID（可能刚重启过 ComfyUI），请点「清空」或「＋ 新对话」后重试。";
    }
    if (/preset .* not found|预设.*没有附带原图/i.test(haystack)) {
      return `❌ 预设资源不存在 (404)：${excerpt(msg, 120)}`;
    }
    return `❌ 模型或接口不存在 (404)：${excerpt(readableUpstream || "当前网关未找到该模型或路径，请在「设置」重新探测", 110)}`;
  }

  // 10. Rate limit / Quota (429)
  if (
    code === "rate_limited" ||
    status === 429 ||
    upstreamStatus === 429 ||
    /rate_limit|too many requests|quota exceeded/i.test(haystack)
  ) {
    if (/insufficient_quota|quota|credit|balance/i.test(haystack)) {
      return `❌ 账户额度不足或已耗尽 (429${retryPart})：请检查网关账户余额或切换备用模型渠道。`;
    }
    return `⏳ 网关并发或请求频率受限 (429${retryPart})：${excerpt(readableUpstream || "请稍等几秒后重试", 100)}`;
  }

  // 11. Upstream / Gateway 5xx errors (e.g. Magpie 502 wrapping proxy RST, OAuth token timeout, cooldown)
  const effective5xx =
    code === "upstream_error" ||
    status >= 500 ||
    (upstreamStatus != null && upstreamStatus >= 500);
  if (effective5xx) {
    const tag = statusLabel || "502";
    const isTransportReset = /10054|forcibly closed|wsarecv|connection reset|broken pipe|\beof\b|强迫关闭/i.test(haystack);
    const isTlsFailure = /TLS handshake|x509|certificate/i.test(haystack);

    if (/oauth2\.googleapis\.com|signed out|取\s*token|oauth.*token/i.test(haystack) && (isTransportReset || isTlsFailure || /timeout/i.test(haystack))) {
      return `❌ 代理链路中断导致网关鉴权/发请求失败 (${tag}${retryPart})：网关发往 Google 取 Token 或建连时被本地代理/出口掐断（非账号真正掉登录），请检查代理节点稳定性后重试。`;
    }
    if (isTransportReset) {
      return `❌ 本地代理或出站链路在转发时中断 (${tag}${retryPart})：网关发往上游的 TCP 连接被强制关闭（TCP Reset），请检查代理节点状态后重试。`;
    }
    if (isTlsFailure) {
      return `❌ 网关与上游服务器 TLS 握手失败 (${tag}${retryPart})：安全连接建立受阻，请检查本地代理链路后重试。`;
    }
    if (/signed out|paused|cooldown|暂停|放假|no available|all channels|circuit|unhealthy/i.test(haystack)) {
      return `❌ 网关当前无可用模型渠道 (${tag}${retryPart})：${excerpt(readableUpstream || "该模型所属渠道可能处于暂停冷却状态", 110)}；可稍候等待自动恢复或切换备用模型。`;
    }
    if (status === 503 || upstreamStatus === 503) {
      return `⚠️ 上游模型服务暂时过载或维护中 (${tag}${retryPart})：${excerpt(readableUpstream || "请稍后重试或切换其他模型", 110)}`;
    }
    if (readableUpstream && !/^Upstream server error/i.test(readableUpstream)) {
      return `❌ 网关转发出错 (${tag}${retryPart})：${excerpt(readableUpstream, 130)}`;
    }
    return `❌ 网关服务异常 (${tag}${retryPart})：AI 上游网关未返回可用响应，请查看网关日志或稍后重试。`;
  }

  // 12. Request validation / payload size (400 / 413 / 422)
  if (code === "body_too_large" || status === 413 || upstreamStatus === 413) {
    return "❌ 请求或参考图体积过大 (413)：请换一张较小分辨率或较小体积的图片后再试。";
  }
  if (
    code === "invalid_request" ||
    status === 400 ||
    status === 422 ||
    upstreamStatus === 400 ||
    upstreamStatus === 422
  ) {
    const tag = statusLabel || "400";
    return `❌ 请求参数被拒绝 (${tag})：${excerpt(readableUpstream || msg, 140)}`;
  }
  if (code === "no_response") {
    return `❌ 模型本次未返回任何文本内容${retryPart ? `（${retryPart.slice(1)}）` : ""}：请重试或换用其他模型。`;
  }

  // 13. Fallback
  const fallbackTag = statusLabel || (code && code !== "api_error" && code !== "Error" ? code : "");
  const badge = fallbackTag || retryPart ? ` (${[fallbackTag, retryPart.replace(/^，/, "")].filter(Boolean).join("，")})` : "";
  return `❌ ${actionName}失败${badge}：${excerpt(readableUpstream || msg, 160)}`;
}

/**
 * Build a multi-line technical diagnostics string for collapsible UI error
 * details and status tooltips.  Returns "" for trivial local validation errors.
 */
export function formatErrorTechnicalDetail(err) {
  const {
    code,
    status,
    upstreamStatus,
    attempts,
    requestId,
    partialText,
    message,
    detail,
  } = normalizeErrorFields(err);

  const hasBackendMeta =
    Boolean(detail) ||
    Boolean(requestId) ||
    Boolean(partialText) ||
    status > 0 ||
    (upstreamStatus != null && upstreamStatus > 0) ||
    attempts > 1 ||
    (code && code !== "api_error" && code !== "Error");

  if (!hasBackendMeta) return "";

  const lines = [];
  if (code) lines.push(`错误码: ${code}`);
  if (status > 0 || (upstreamStatus != null && upstreamStatus > 0)) {
    const parts = [];
    if (status > 0) parts.push(`本地 HTTP ${status}`);
    if (upstreamStatus != null && upstreamStatus > 0) parts.push(`上游 HTTP ${upstreamStatus}`);
    lines.push(`状态码: ${parts.join(" · ")}`);
  }
  if (attempts > 1) {
    lines.push(`请求尝试: 共 ${attempts} 次（含自动重试 ${attempts - 1} 次）`);
  }
  if (requestId) lines.push(`请求 ID: ${requestId}`);
  if (partialText) lines.push(`断流前已接收: ${partialText.length} 个字符`);
  if (message) lines.push(`后端摘要: ${message}`);

  if (detail) {
    const parsed = parseUpstreamDetailMessage(detail);
    if (parsed && parsed !== detail && parsed !== message) {
      lines.push(`解析原因: ${parsed}`);
    }
    lines.push(`原始详情:\n${detail}`);
  }
  return lines.join("\n");
}
