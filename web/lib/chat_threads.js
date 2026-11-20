/**
 * Multi-conversation thread state helpers shared by the In-Node Card
 * (`caption_node.js`) and the Dual-Column Workbench (`layout_editor.js`).
 * Keeps `state.chat_threads`, `state.active_chat_id`, `state.chat_seq`, and
 * the legacy mirror fields (`state.chat_log`, `state.session_id`) consistent.
 */

import { excerpt } from "./diff.js?v=20261120_v51";

export const MAX_CHAT_THREADS = 20;
export const DEFAULT_MAX_TURNS = 20;

const DEFAULT_TITLE_RE = /^(?:默认对话|对话\s*\d+|新对话(?:\s*\d+)?)$/;

export function inferThreadTitle(text, fallback = "对话 1") {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (!flat) return fallback;
  return excerpt(flat, 14) || fallback;
}

function defaultTitleForId(id, indexFallback = 1) {
  const m = String(id || "").match(/(\d+)$/);
  const num = m ? Number(m[1]) : indexFallback;
  return `对话 ${num > 0 ? num : indexFallback}`;
}

export function syncActiveChatMirrors(state) {
  if (!state || typeof state !== "object") return null;
  const threads = Array.isArray(state.chat_threads) ? state.chat_threads : [];
  const active =
    threads.find((t) => t && t.id === state.active_chat_id) ||
    threads[0] ||
    null;
  if (!active) {
    state.active_chat_id = null;
    state.chat_log = [];
    delete state.session_id;
    delete state.sessionId;
    return null;
  }
  state.active_chat_id = active.id;
  state.chat_log = Array.isArray(active.chat_log) ? active.chat_log : [];
  if (active.session_id) {
    state.session_id = active.session_id;
  } else {
    delete state.session_id;
    delete state.sessionId;
  }
  return active;
}

export function ensureChatThreads(state, { maxTurns = DEFAULT_MAX_TURNS } = {}) {
  if (!state || typeof state !== "object") {
    return { threads: [], activeThread: null, activeId: null };
  }
  const now = Date.now();
  const limit = Math.max(1, Number(maxTurns) || DEFAULT_MAX_TURNS);

  if (Array.isArray(state.chat_threads) && state.chat_threads.length > 0) {
    const seenIds = new Set();
    const normalized = [];
    let maxSuffix = 0;

    state.chat_threads.forEach((rawThread, idx) => {
      if (!rawThread || typeof rawThread !== "object") return;
      let tid = String(rawThread.id || "").trim() || `chat_${idx + 1}`;
      let collisionBump = idx + normalized.length + 2;
      while (seenIds.has(tid)) {
        tid = `chat_${collisionBump}`;
        collisionBump += 1;
      }
      seenIds.add(tid);
      const match = tid.match(/(\d+)$/);
      if (match) maxSuffix = Math.max(maxSuffix, Number(match[1]) || 0);

      const turns = Array.isArray(rawThread.chat_log) ? rawThread.chat_log.slice(-limit) : [];
      const fallbackTitle = defaultTitleForId(tid, idx + 1);
      const rawTitle = String(rawThread.title || "").trim();
      const title =
        rawTitle ||
        (turns[0] ? inferThreadTitle(turns[0].label || turns[0].userText, fallbackTitle) : fallbackTitle);
      const sid = rawThread.session_id ? String(rawThread.session_id) : null;

      normalized.push({
        id: tid,
        title,
        session_id: sid,
        chat_log: turns,
        custom_title: Boolean(rawThread.custom_title),
        created_at: Number(rawThread.created_at) || now,
        updated_at: Number(rawThread.updated_at) || now,
      });
    });

    if (normalized.length > 0) {
      state.chat_threads = normalized;
      state.chat_seq = Math.max(Number(state.chat_seq) || 0, normalized.length, maxSuffix);
      const active = syncActiveChatMirrors(state);
      return {
        threads: state.chat_threads,
        activeThread: active,
        activeId: active ? active.id : null,
      };
    }
  }

  const legacyTurns = Array.isArray(state.chat_log) ? state.chat_log.slice(-limit) : [];
  const legacySid = state.session_id || state.sessionId || null;
  const firstTitle = legacyTurns[0]
    ? inferThreadTitle(legacyTurns[0].label || legacyTurns[0].userText, "对话 1")
    : "对话 1";

  state.chat_seq = Math.max(Number(state.chat_seq) || 0, 1);
  state.chat_threads = [
    {
      id: "chat_1",
      title: firstTitle,
      session_id: legacySid ? String(legacySid) : null,
      chat_log: legacyTurns,
      custom_title: false,
      created_at: now,
      updated_at: now,
    },
  ];
  state.active_chat_id = "chat_1";
  const active = syncActiveChatMirrors(state);
  return {
    threads: state.chat_threads,
    activeThread: active,
    activeId: active ? active.id : null,
  };
}

export function getActiveThread(state, opts = {}) {
  return ensureChatThreads(state, opts).activeThread;
}

export function createChatThread(state, { title = "", session_id = null, maxTurns = DEFAULT_MAX_TURNS } = {}) {
  ensureChatThreads(state, { maxTurns });
  if (state.chat_threads.length >= MAX_CHAT_THREADS) {
    return {
      ok: false,
      error: `最多同时保留 ${MAX_CHAT_THREADS} 个对话，请先删除不用的旧对话。`,
      thread: null,
      activeId: state.active_chat_id,
    };
  }
  const existingIds = new Set(state.chat_threads.map((t) => t.id));
  let seq = Math.max(Number(state.chat_seq) || 0, state.chat_threads.length) + 1;
  let id = `chat_${seq}`;
  while (existingIds.has(id)) {
    seq += 1;
    id = `chat_${seq}`;
  }
  const now = Date.now();
  const cleanTitle = String(title || "").trim();
  const thread = {
    id,
    title: cleanTitle || `对话 ${seq}`,
    session_id: session_id ? String(session_id) : null,
    chat_log: [],
    custom_title: Boolean(cleanTitle),
    created_at: now,
    updated_at: now,
  };
  state.chat_seq = seq;
  state.chat_threads.push(thread);
  state.active_chat_id = thread.id;
  syncActiveChatMirrors(state);
  return { ok: true, thread, activeId: thread.id };
}

export function switchChatThread(state, threadId, { maxTurns = DEFAULT_MAX_TURNS } = {}) {
  ensureChatThreads(state, { maxTurns });
  const target = state.chat_threads.find((t) => t && t.id === threadId);
  if (!target) {
    return { ok: false, thread: getActiveThread(state, { maxTurns }), activeId: state.active_chat_id };
  }
  state.active_chat_id = target.id;
  syncActiveChatMirrors(state);
  return { ok: true, thread: target, activeId: target.id };
}

export function renameChatThread(state, threadId, newTitle, { maxTurns = DEFAULT_MAX_TURNS } = {}) {
  ensureChatThreads(state, { maxTurns });
  const target = state.chat_threads.find((t) => t && t.id === threadId);
  if (!target) return { ok: false, thread: null };
  const cleaned = String(newTitle || "").replace(/\s+/g, " ").trim().slice(0, 40);
  if (cleaned) {
    target.title = cleaned;
    target.custom_title = true;
    target.updated_at = Date.now();
  }
  return { ok: true, thread: target };
}

export function deleteChatThread(state, threadId, { maxTurns = DEFAULT_MAX_TURNS } = {}) {
  ensureChatThreads(state, { maxTurns });
  const idx = state.chat_threads.findIndex((t) => t && t.id === threadId);
  if (idx < 0) {
    return {
      ok: false,
      deleted: null,
      activeThread: getActiveThread(state, { maxTurns }),
      activeId: state.active_chat_id,
    };
  }
  const [deleted] = state.chat_threads.splice(idx, 1);
  if (state.chat_threads.length === 0) {
    const now = Date.now();
    state.chat_seq = 1;
    state.chat_threads = [
      {
        id: "chat_1",
        title: "对话 1",
        session_id: null,
        chat_log: [],
        custom_title: false,
        created_at: now,
        updated_at: now,
      },
    ];
    state.active_chat_id = "chat_1";
  } else if (state.active_chat_id === deleted.id) {
    const nextIdx = Math.min(idx, state.chat_threads.length - 1);
    state.active_chat_id = state.chat_threads[nextIdx].id;
  }
  const activeThread = syncActiveChatMirrors(state);
  return {
    ok: true,
    deleted,
    activeThread,
    activeId: activeThread ? activeThread.id : null,
  };
}

export function clearChatThread(state, threadId = null, { maxTurns = DEFAULT_MAX_TURNS } = {}) {
  ensureChatThreads(state, { maxTurns });
  const tid = threadId || state.active_chat_id;
  const target = state.chat_threads.find((t) => t && t.id === tid) || state.chat_threads[0];
  if (!target) return null;
  target.chat_log = [];
  target.session_id = null;
  target.updated_at = Date.now();
  if (!target.custom_title) {
    target.title = defaultTitleForId(target.id, state.chat_threads.indexOf(target) + 1);
  }
  syncActiveChatMirrors(state);
  return target;
}

export function updateThreadTurns(
  state,
  threadId,
  nextLog,
  { sessionId = undefined, maxTurns = DEFAULT_MAX_TURNS } = {},
) {
  ensureChatThreads(state, { maxTurns });
  const tid = threadId || state.active_chat_id;
  const target = state.chat_threads.find((t) => t && t.id === tid) || state.chat_threads[0];
  if (!target) return null;
  const limit = Math.max(1, Number(maxTurns) || DEFAULT_MAX_TURNS);
  target.chat_log = Array.isArray(nextLog) ? nextLog.slice(-limit) : [];
  if (sessionId !== undefined) {
    target.session_id = sessionId ? String(sessionId) : null;
  }
  if (!target.custom_title && (DEFAULT_TITLE_RE.test(target.title || "") || !target.title) && target.chat_log.length > 0) {
    const firstTurn = target.chat_log[0];
    const seed = firstTurn && (firstTurn.label || firstTurn.userText);
    if (seed) {
      target.title = inferThreadTitle(seed, target.title || "对话 1");
    }
  }
  target.updated_at = Date.now();
  syncActiveChatMirrors(state);
  return target;
}

export function setThreadSessionId(state, threadId, sessionId, { maxTurns = DEFAULT_MAX_TURNS } = {}) {
  ensureChatThreads(state, { maxTurns });
  const tid = threadId || state.active_chat_id;
  const target = state.chat_threads.find((t) => t && t.id === tid) || state.chat_threads[0];
  if (!target) return null;
  target.session_id = sessionId ? String(sessionId) : null;
  syncActiveChatMirrors(state);
  return target;
}

export function maybeAutoTitleThread(state, threadId, seedText, { maxTurns = DEFAULT_MAX_TURNS } = {}) {
  ensureChatThreads(state, { maxTurns });
  const tid = threadId || state.active_chat_id;
  const target = state.chat_threads.find((t) => t && t.id === tid) || state.chat_threads[0];
  if (!target || target.custom_title) return target || null;
  if (DEFAULT_TITLE_RE.test(target.title || "") || !target.title) {
    const inferred = inferThreadTitle(seedText, "");
    if (inferred) {
      target.title = inferred;
      target.updated_at = Date.now();
    }
  }
  return target;
}

export function preserveChatThreads(targetState, sourceState, { maxTurns = DEFAULT_MAX_TURNS } = {}) {
  if (!targetState || typeof targetState !== "object" || !sourceState || typeof sourceState !== "object") {
    return targetState;
  }
  if (Array.isArray(sourceState.chat_threads) && sourceState.chat_threads.length > 0) {
    targetState.chat_threads = JSON.parse(JSON.stringify(sourceState.chat_threads));
    targetState.active_chat_id = sourceState.active_chat_id;
    targetState.chat_seq = sourceState.chat_seq;
    ensureChatThreads(targetState, { maxTurns });
  } else {
    if (Array.isArray(sourceState.chat_log) && sourceState.chat_log.length && !Array.isArray(targetState.chat_log)) {
      targetState.chat_log = sourceState.chat_log.slice();
    }
    if ((sourceState.session_id || sourceState.sessionId) && !targetState.session_id) {
      targetState.session_id = sourceState.session_id || sourceState.sessionId;
    }
  }
  return targetState;
}

export function stripChatStateForRollback(state) {
  if (!state || typeof state !== "object") return state;
  delete state.chat_log;
  delete state.chat_threads;
  delete state.active_chat_id;
  delete state.chat_seq;
  delete state.session_id;
  delete state.sessionId;
  return state;
}
