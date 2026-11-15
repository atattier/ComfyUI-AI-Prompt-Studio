/** Tests for multi-conversation thread helpers (`web/lib/chat_threads.js`). */

import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_CHAT_THREADS,
  inferThreadTitle,
  ensureChatThreads,
  getActiveThread,
  createChatThread,
  switchChatThread,
  renameChatThread,
  deleteChatThread,
  clearChatThread,
  updateThreadTurns,
  setThreadSessionId,
  maybeAutoTitleThread,
  preserveChatThreads,
  stripChatStateForRollback,
} from "../web/lib/chat_threads.js";

test("ensureChatThreads migrates legacy single chat_log and session_id cleanly", () => {
  const state = {
    session_id: "sess_legacy_01",
    chat_log: [
      { id: "t1", label: "把背景改成赛博霓虹", userText: "把背景改成赛博霓虹", reply: "已修改。" },
    ],
  };

  const res = ensureChatThreads(state);
  assert.equal(res.threads.length, 1);
  assert.equal(res.activeId, "chat_1");
  assert.equal(res.activeThread.session_id, "sess_legacy_01");
  assert.equal(res.activeThread.title, "把背景改成赛博霓虹");
  assert.equal(state.session_id, "sess_legacy_01");
  assert.equal(state.chat_log.length, 1);
  assert.equal(state.chat_seq, 1);
});

test("createChatThread creates isolated new thread and isolates session_id and logs", () => {
  const state = {
    session_id: "sess_1",
    chat_log: [{ id: "t1", label: "第一套构图修改", userText: "第一套构图修改", reply: "完成" }],
  };
  ensureChatThreads(state);

  const created = createChatThread(state);
  assert.equal(created.ok, true);
  assert.equal(created.activeId, "chat_2");
  assert.equal(created.thread.title, "对话 2");
  assert.equal(state.chat_threads.length, 2);
  // Active mirrors switched to the new blank thread so the backend gets no stale session_id
  assert.equal(state.active_chat_id, "chat_2");
  assert.deepEqual(state.chat_log, []);
  assert.equal("session_id" in state, false);

  // Give thread 2 its own session and turns
  updateThreadTurns(
    state,
    "chat_2",
    [{ id: "t2", userText: "尝试电影胶片感调色方案并增强高光层次", reply: "已增强胶片感。" }],
    { sessionId: "sess_2" },
  );
  assert.equal(state.session_id, "sess_2");
  assert.equal(state.chat_threads[1].title.startsWith("尝试电影胶片感"), true);

  // Switching back to chat_1 restores sess_1 and turn 1
  const sw1 = switchChatThread(state, "chat_1");
  assert.equal(sw1.ok, true);
  assert.equal(state.active_chat_id, "chat_1");
  assert.equal(state.session_id, "sess_1");
  assert.equal(state.chat_log.length, 1);
  assert.equal(state.chat_log[0].id, "t1");

  // Switching to invalid id fails gracefully without mutating activeId
  const bad = switchChatThread(state, "does_not_exist");
  assert.equal(bad.ok, false);
  assert.equal(state.active_chat_id, "chat_1");
});

test("renameChatThread preserves custom title even after new turns arrive", () => {
  const state = {};
  ensureChatThreads(state);
  renameChatThread(state, "chat_1", "  铃兰细节   精修线  ");
  assert.equal(getActiveThread(state).title, "铃兰细节 精修线");
  assert.equal(getActiveThread(state).custom_title, true);

  updateThreadTurns(state, "chat_1", [{ id: "t1", userText: "把背景完全换成雪地", reply: "ok" }]);
  assert.equal(getActiveThread(state).title, "铃兰细节 精修线");
});

test("clearChatThread resets only the target thread and respects custom titles", () => {
  const state = {};
  ensureChatThreads(state);
  updateThreadTurns(state, "chat_1", [{ id: "t1", userText: "调整光影方向", reply: "done" }], {
    sessionId: "s1",
  });
  createChatThread(state);
  renameChatThread(state, "chat_2", "人物服装分支");
  updateThreadTurns(state, "chat_2", [{ id: "t2", userText: "换为红色羽织", reply: "done" }], {
    sessionId: "s2",
  });

  clearChatThread(state, "chat_2");
  assert.deepEqual(state.chat_log, []);
  assert.equal("session_id" in state, false);
  assert.equal(getActiveThread(state).title, "人物服装分支");
  // Thread 1 remains untouched
  assert.equal(state.chat_threads[0].session_id, "s1");
  assert.equal(state.chat_threads[0].chat_log.length, 1);

  switchChatThread(state, "chat_1");
  clearChatThread(state, "chat_1");
  assert.equal(getActiveThread(state).title, "对话 1");
});

test("deleteChatThread switches to adjacent thread and resets cleanly on last thread", () => {
  const state = {};
  ensureChatThreads(state); // chat_1
  createChatThread(state); // chat_2
  createChatThread(state); // chat_3
  setThreadSessionId(state, "chat_1", "s1");
  setThreadSessionId(state, "chat_2", "s2");
  setThreadSessionId(state, "chat_3", "s3");

  // Delete middle active thread chat_2 -> should move to chat_3
  switchChatThread(state, "chat_2");
  const del2 = deleteChatThread(state, "chat_2");
  assert.equal(del2.ok, true);
  assert.equal(del2.deleted.id, "chat_2");
  assert.equal(del2.deleted.session_id, "s2");
  assert.equal(state.active_chat_id, "chat_3");
  assert.equal(state.session_id, "s3");

  // Delete remaining two -> recreating default chat_1 cleanly
  deleteChatThread(state, "chat_3");
  assert.equal(state.active_chat_id, "chat_1");
  const delLast = deleteChatThread(state, "chat_1");
  assert.equal(delLast.ok, true);
  assert.equal(delLast.deleted.session_id, "s1");
  assert.equal(state.chat_threads.length, 1);
  assert.equal(state.active_chat_id, "chat_1");
  assert.equal(state.chat_threads[0].session_id, null);
  assert.deepEqual(state.chat_log, []);
});

test("createChatThread enforces MAX_CHAT_THREADS cap and preserveChatThreads transfers state safely", () => {
  const state = {};
  ensureChatThreads(state);
  for (let i = 2; i <= MAX_CHAT_THREADS; i += 1) {
    const r = createChatThread(state);
    assert.equal(r.ok, true);
  }
  const over = createChatThread(state);
  assert.equal(over.ok, false);
  assert.ok(over.error.includes(String(MAX_CHAT_THREADS)));

  const freshCaptionState = { caption: "New caption" };
  preserveChatThreads(freshCaptionState, state);
  assert.equal(freshCaptionState.chat_threads.length, MAX_CHAT_THREADS);
  assert.equal(freshCaptionState.active_chat_id, state.active_chat_id);

  // Mutating freshCaptionState must not mutate source state
  switchChatThread(freshCaptionState, "chat_1");
  assert.notEqual(freshCaptionState.active_chat_id, state.active_chat_id);

  // Rollback stripping removes all chat/session fields
  const stripped = stripChatStateForRollback({ ...freshCaptionState });
  assert.equal("chat_threads" in stripped, false);
  assert.equal("active_chat_id" in stripped, false);
  assert.equal("chat_log" in stripped, false);
  assert.equal("session_id" in stripped, false);
});

test("ensureChatThreads deduplicates colliding thread IDs without hanging", () => {
  const raw = {
    chat_threads: [
      { id: "dup", title: "A", chat_log: [] },
      { id: "dup", title: "B", chat_log: [] },
      { id: "dup", title: "C", chat_log: [] },
    ],
    active_chat_id: "dup",
  };
  const { threads } = ensureChatThreads(raw);
  assert.equal(threads.length, 3);
  const ids = new Set(threads.map((t) => t.id));
  assert.equal(ids.size, 3);
  assert.equal(inferThreadTitle("   \n  ", "默认"), "默认");

  maybeAutoTitleThread(raw, "B", "不应覆盖手改名");
  const s = {};
  ensureChatThreads(s);
  maybeAutoTitleThread(s, "chat_1", "给背景加点赛博霓虹雨夜氛围");
  assert.equal(getActiveThread(s).title.startsWith("给背景加点赛博霓虹"), true);
  renameChatThread(s, "chat_1", "我的自定义标题");
  maybeAutoTitleThread(s, "chat_1", "另一个指令不应覆盖");
  assert.equal(getActiveThread(s).title, "我的自定义标题");
});
