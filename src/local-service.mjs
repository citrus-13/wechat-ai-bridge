import http from "node:http";

import { decryptRecord } from "./crypto-sync.mjs";
import { callLocalOllama } from "./models.mjs";
import { needsWebSearch, searchWeb } from "./web-search.mjs";
import { migrateLegacyGroupHistory, openHistoryStore } from "./storage.mjs";
import { assertSecret } from "./config.mjs";
import { readRequestJson, safeEqual, sendJson } from "./util.mjs";

function authorized(request, secret) {
  const header = request.headers.authorization || "";
  return safeEqual(header, `Bearer ${secret}`);
}

function boundedHistory(messages, maxMessages, maxChars) {
  const selected = [];
  let chars = 0;
  for (let index = messages.length - 1; index >= 0 && selected.length < maxMessages; index -= 1) {
    const message = messages[index];
    const size = message.content.length;
    if (selected.length > 0 && chars + size > maxChars) break;
    selected.push(message);
    chars += size;
  }
  return selected.reverse();
}

export async function syncOnce(config, store) {
  if (!config.cloud.syncUrl) return { imported: 0 };
  assertSecret("BRIDGE_SHARED_SECRET", config.bridgeSecret);
  const response = await fetch(`${config.cloud.syncUrl}/v1/sync/pull`, {
    headers: { Authorization: `Bearer ${config.bridgeSecret}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`cloud sync pull failed: ${response.status}`);
  const payload = await response.json();
  const ids = [];
  let imported = 0;
  for (const record of payload.records || []) {
    const decoded = decryptRecord(record, config.syncKey);
    for (const message of decoded.messages || []) {
      store.insertMessage(message);
      imported += 1;
    }
    ids.push(record.id);
  }
  if (ids.length > 0) {
    const ack = await fetch(`${config.cloud.syncUrl}/v1/sync/ack`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.bridgeSecret}`,
      },
      body: JSON.stringify({ ids }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!ack.ok) throw new Error(`cloud sync acknowledgement failed: ${ack.status}`);
  }
  return { imported };
}

export async function startLocalService(config) {
  assertSecret("BRIDGE_SHARED_SECRET", config.bridgeSecret);
  const migration = migrateLegacyGroupHistory({
    legacyPath: config.legacyDbPath,
    targetPath: config.dbPath,
    conversationId: config.memory.conversationId,
  });
  if (migration.migrated > 0) console.log(`[memory] migrated ${migration.migrated} group messages from legacy history`);
  const store = openHistoryStore(config.dbPath);

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, { ok: true, role: "local" });
      }
      if (!authorized(request, config.bridgeSecret)) {
        return sendJson(response, 401, { error: "unauthorized" });
      }
      if (request.method === "POST" && url.pathname === "/v1/respond") {
        const body = await readRequestJson(request);
        const messageId = String(body.messageId || "").trim();
        const conversationId = String(body.conversationId || "").trim();
        const text = String(body.text || "").trim();
        if (!messageId || !conversationId || !text || text.length > 16_000) {
          return sendJson(response, 400, { error: "messageId, conversationId and text are required" });
        }
        const replyId = `${messageId}:reply`;
        const cached = store.getMessage(replyId);
        if (cached) return sendJson(response, 200, { reply: cached.content, source: "local", cached: true });

        const createdAt = Number.isFinite(body.createdAt) ? body.createdAt : Date.now();
        const rawContext = Array.isArray(body.context) ? body.context : [];
        const suppliedContext = rawContext
          .filter((message) => message?.role === "user" || message?.role === "assistant")
          .map((message, index) => ({
            id: String(message.id || `${messageId}:context:${index}`),
            conversationId,
            role: message.role,
            content: String(message.content || "").slice(0, 16_000),
            modelSource: String(message.modelSource || "wechat-context"),
            createdAt: Number.isFinite(message.createdAt) ? message.createdAt : createdAt - rawContext.length + index,
          }))
          .filter((message) => message.content);
        for (const message of suppliedContext) store.insertMessage(message);
        store.insertMessage({
          id: messageId,
          conversationId,
          role: "user",
          content: String(body.historyContent || text),
          modelSource: "wechat",
          createdAt,
        });
        const immediateHistory = suppliedContext.length > 0
          ? [...suppliedContext, { role: "user", content: text }]
          : store.getRecent(conversationId, config.local.contextMessages)
            .map((message) => ({ role: message.role, content: message.content }));
        const history = boundedHistory(
          immediateHistory.map((message) => ({ role: message.role, content: message.content })),
          config.local.contextMessages,
          config.local.contextChars,
        );
        let webContext = "";
        let usedWebSearch = false;
        if (config.local.webSearch.enabled && needsWebSearch(text)) {
          try {
            webContext = await searchWeb(config, text);
            usedWebSearch = true;
          } catch (error) {
            console.warn(`[local-search] ${error.message}`);
            webContext = "本次联网搜索暂时失败。不要猜测实时事实，请明确告诉用户目前无法核实。";
          }
        }
        const reply = await callLocalOllama(config, history, { webContext });
        store.insertMessage({
          id: replyId,
          conversationId,
          role: "assistant",
          content: reply,
          modelSource: usedWebSearch ? "local-qwen-web" : "local-qwen",
          createdAt: Date.now(),
        });
        return sendJson(response, 200, { reply, source: usedWebSearch ? "local-qwen-web" : "local-qwen" });
      }
      return sendJson(response, 404, { error: "not found" });
    } catch (error) {
      console.error(`[local] ${error.message}`);
      return sendJson(response, 500, { error: "local service error" });
    }
  });

  server.listen(config.local.port, config.local.bindHost, () => {
    console.log(`[local] listening on http://${config.local.bindHost}:${config.local.port}`);
  });

  let syncTimer;
  if (config.cloud.syncUrl) {
    const runSync = () => syncOnce(config, store)
      .then(({ imported }) => imported && console.log(`[sync] imported ${imported} messages`))
      .catch((error) => console.error(`[sync] ${error.message}`));
    await runSync();
    syncTimer = setInterval(runSync, 60_000);
    syncTimer.unref();
  }

  const stop = () => {
    if (syncTimer) clearInterval(syncTimer);
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return { server, store };
}
