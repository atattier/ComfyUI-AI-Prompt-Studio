import test from "node:test";
import assert from "node:assert/strict";

import {
  changeCount,
  describeOp,
  describeStats,
  excerpt,
  formatBusyStatusText,
  formatFriendlyError,
  formatErrorTechnicalDetail,
  operationLabel,
  selectOps,
  summarizeBlocks,
  wordDiffRanges,
} from "../web/lib/diff.js";

const blocks = [
  { type: "equal", text: "a cat," },
  { type: "change", before: "sunny", after: "rainy" },
  { type: "add", text: "35mm" },
];

test("summarises block types", () => {
  assert.deepEqual(summarizeBlocks(blocks), { equal: 1, add: 1, del: 0, change: 1 });
  assert.equal(changeCount(blocks), 2);
  assert.equal(describeStats(blocks), "1 处修改，1 处新增");
  assert.equal(describeStats([]), "没有变化");
});

test("selectOps keeps only checked indices and their order", () => {
  const changes = [{ op: "replace" }, { op: "append" }, { op: "delete" }];
  assert.deepEqual(selectOps(changes, [2, 0]), [{ op: "replace" }, { op: "delete" }]);
  assert.deepEqual(selectOps(changes, []), []);
  assert.deepEqual(selectOps(null, [0]), []);
});

test("operations carry readable labels", () => {
  assert.equal(operationLabel("replace"), "替换");
  assert.equal(operationLabel("weird"), "weird");
  assert.equal(describeOp({ op: "replace", before: "a", after: "b" }), "替换：a → b");
  assert.equal(describeOp({ op: "append", after: "tail" }), "追加：tail");
  assert.equal(describeOp({ op: "delete", before: "gone" }), "删除：gone");
});

test("excerpt flattens whitespace and truncates", () => {
  assert.equal(excerpt("a  b\nc"), "a b c");
  assert.equal(excerpt("x".repeat(80), 10).length, 10);
  assert.ok(excerpt("x".repeat(80), 10).endsWith("…"));
});

test("wordDiffRanges marks only new or changed words in the after text", () => {
  const before = "A blonde girl with animal ears sitting on a ledge";
  const after = "A blonde girl with fox ears sitting on a wooden ledge";
  const marked = wordDiffRanges(before, after).map(([s, e]) => after.slice(s, e));
  assert.deepEqual(marked, ["fox", "wooden"]);
  assert.deepEqual(wordDiffRanges(before, before), []);
});

test("formatBusyStatusText summarizes long multi-line instructions cleanly without double ellipsis", () => {
  assert.equal(formatBusyStatusText("扩写细节"), "正在执行：扩写细节…");
  assert.equal(formatBusyStatusText(""), "AI 正在处理中…");

  const longPrompt =
    "第一行把画面人物的衣服整体替换为黑色赛博朋克机能风夹克\n" +
    "第二行再增加霓虹雨夜街头倒影、低机位广角透视和电影感冷暖光影对比，保留原有文字招牌";
  const res = formatBusyStatusText(longPrompt);
  assert.ok(res.startsWith("正在执行："), `unexpected prefix: ${res}`);
  assert.ok(!res.includes("\n"), "must flatten newlines");
  assert.ok(!res.endsWith("……"), "must not produce double ellipsis");
  assert.ok(res.length <= 32, `too long (${res.length}): ${res}`);

  const regRes = formatBusyStatusText("已经是很长的区域描述修改请求请帮我全部翻译成英文并保留细节…", {
    regionIndex: 1,
    regionName: "超长名称的红色长发咖啡店女孩区域框",
    maxInstructionChars: 16,
    maxRegionChars: 10,
  });
  assert.ok(regRes.startsWith("正在修改 @画框 #2「"), `unexpected region prefix: ${regRes}`);
  assert.ok(!regRes.endsWith("……"), `double ellipsis in ${regRes}`);
  assert.ok(regRes.length <= 42, `region status too long (${regRes.length}): ${regRes}`);
});

test("formatFriendlyError distinguishes pre-first-token WinError 10054 vs mid-stream drop vs empty 200 stream", () => {
  const preToken = formatFriendlyError(
    {
      code: "stream_interrupted",
      status: 502,
      attempts: 2,
      message: "The connection dropped before any content arrived.",
      detail: "ConnectionResetError: [WinError 10054] An existing connection was forcibly closed by the remote host",
    },
    "AI 改词",
  );
  assert.match(preToken, /首字返回前连接中断/);
  assert.match(preToken, /本地代理或出站 TCP 连接被掐断/);
  assert.match(preToken, /已自动重试 1 次/);

  const techPre = formatErrorTechnicalDetail({
    code: "stream_interrupted",
    status: 502,
    attempts: 2,
    message: "The connection dropped before any content arrived.",
    detail: "ConnectionResetError: [WinError 10054]",
  });
  assert.match(techPre, /错误码: stream_interrupted/);
  assert.match(techPre, /状态码: 本地 HTTP 502/);
  assert.match(techPre, /请求尝试: 共 2 次（含自动重试 1 次）/);
  assert.match(techPre, /WinError 10054/);

  const midStream = formatFriendlyError(
    {
      code: "stream_interrupted",
      status: 502,
      attempts: 2,
      partialText: "A girl in rain...",
      message: "The connection dropped mid-stream.",
      detail: "ChunkedEncodingError: Connection broken: IncompleteRead",
    },
    "AI 对话",
  );
  assert.match(midStream, /在输出中途中断/);
  assert.match(midStream, /已收到 17 字/);
  assert.match(midStream, /已自动重试 1 次/);
  assert.match(midStream, /首字前自动切换备用模型/);

  const techMid = formatErrorTechnicalDetail({
    code: "stream_interrupted",
    partialText: "A girl in rain...",
    message: "The connection dropped mid-stream.",
  });
  assert.match(techMid, /断流前已接收: 17 个字符/);

  const empty200 = formatFriendlyError(
    {
      code: "stream_interrupted",
      status: 502,
      message: "The stream ended before any content arrived.",
      detail: "http_status=200, chunks=0, saw_done=False",
    },
    "AI 反推",
  );
  assert.match(empty200, /返回空流/);
  assert.match(empty200, /200/);
});

test("formatFriendlyError classifies Magpie OAuth transport failure as 5xx proxy drop without mislabeling as 401", () => {
  const oauthDrop = formatFriendlyError(
    {
      code: "upstream_error",
      status: 502,
      upstreamStatus: 502,
      message: "Upstream server error (HTTP 502).",
      detail:
        '{"error":{"message":"Antigravity is signed out: Post \\"https://oauth2.googleapis.com/token\\": wsarecv: An existing connection was forcibly closed by the remote host"}}',
    },
    "读图反推",
  );
  assert.doesNotMatch(oauthDrop, /401|鉴权失败.*API Key/);
  assert.match(oauthDrop, /代理链路中断/);
  assert.match(oauthDrop, /取 Token/);
  assert.match(oauthDrop, /非账号真正掉登录/);
  assert.match(oauthDrop, /502/);

  // Must not false-positive on harmless words containing "eof" or "token"
  const badParam = formatFriendlyError(
    {
      code: "invalid_request",
      status: 400,
      upstreamStatus: 400,
      message: "Provider rejected the request (HTTP 400).",
      detail: '{"error":{"message":"max_tokens and typeface must be valid"}}',
    },
    "请求",
  );
  assert.match(badParam, /请求参数被拒绝 \(上游 400\)/);
  assert.doesNotMatch(badParam, /Token|代理|502/);
});

test("formatFriendlyError handles 502 transport/cooldown, 503, 401, 404, 429, network, and 504 timeout variants", () => {
  const tcp502 = formatFriendlyError({
    code: "upstream_error",
    status: 502,
    detail: "read tcp 127.0.0.1:51234->127.0.0.1:10808: wsarecv: An existing connection was forcibly closed",
  });
  assert.match(tcp502, /本地代理或出站链路在转发时中断/);
  assert.match(tcp502, /TCP Reset/);

  const cooldown502 = formatFriendlyError({
    code: "upstream_error",
    status: 502,
    detail: "no available channels (account paused until 19:12)",
  });
  assert.match(cooldown502, /网关当前无可用模型渠道/);
  assert.match(cooldown502, /account paused until 19:12/);
  assert.match(cooldown502, /自动恢复或切换备用模型/);

  const overload503 = formatFriendlyError({
    code: "upstream_error",
    status: 502,
    upstreamStatus: 503,
    detail: '{"error":{"message":"Model temporarily overloaded"}}',
  });
  assert.match(overload503, /上游模型服务暂时过载/);
  assert.match(overload503, /本地 502 \/ 上游 503/);
  assert.match(overload503, /Model temporarily overloaded/);

  const auth401 = formatFriendlyError({ code: "auth_failed", status: 401 });
  assert.match(auth401, /网关鉴权失败 \(401\)/);

  const localAuth = formatFriendlyError({ code: "server_unauthorized", status: 401, message: "missing token" });
  assert.match(localAuth, /ComfyUI 后端本地鉴权未通过 \(401\)/);

  const session404 = formatFriendlyError({ code: "not_found", status: 404, message: "session not found" });
  assert.match(session404, /对话上下文已失效 \(404\)/);

  const model404 = formatFriendlyError({ code: "not_found", status: 404, detail: "model foo not found" });
  assert.match(model404, /模型或接口不存在 \(404\)/);

  const quota429 = formatFriendlyError({ code: "rate_limited", status: 429, detail: "insufficient_quota" });
  assert.match(quota429, /账户额度不足或已耗尽/);

  const rate429 = formatFriendlyError({ code: "rate_limited", status: 429, detail: "Too many requests" });
  assert.match(rate429, /网关并发或请求频率受限/);

  const refused = formatFriendlyError({
    code: "network_error",
    status: 502,
    detail: "ConnectionRefusedError: [WinError 10061] No connection could be made because the target machine actively refused it",
  });
  assert.match(refused, /AI 网关连接被拒绝/);

  const browserDown = formatFriendlyError(
    Object.assign(new Error("Failed to fetch"), { status: 0 }),
    "对话",
  );
  assert.match(browserDown, /无法连接到 ComfyUI 后台服务/);

  const budget504 = formatFriendlyError(
    {
      code: "upstream_timeout",
      status: 504,
      message: "Streaming response exceeded the 90s total budget before completion.",
    },
    "云端生成",
  );
  assert.match(budget504, /总耗时超出流式上限/);

  const tls504 = formatFriendlyError(
    {
      code: "upstream_timeout",
      status: 504,
      message: "Request timed out",
      detail: "net/http: TLS handshake timeout",
    },
    "反推",
  );
  assert.match(tls504, /TLS 握手超时/);
});

test("formatErrorTechnicalDetail returns empty string for pure local validation errors", () => {
  assert.equal(formatErrorTechnicalDetail(new Error("请先加载参考图")), "");
  assert.equal(formatErrorTechnicalDetail("请输入预设名称"), "");
});
