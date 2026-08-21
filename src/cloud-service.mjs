import http from "node:http";

import { assertSecret } from "./config.mjs";
import { encryptRecord } from "./crypto-sync.mjs";
import { callCodexModel } from "./models.mjs";
import { openCloudStore } from "./storage.mjs";
import { getUpdates, notifyLifecycle, sendText } from "./wechat-api.mjs";
import { readJson, readRequestJson, safeEqual, sendJson, sleep, writePrivateJson } from "./util.mjs";

function authorized(request, secret) {
  return safeEqual(request.headers.authorization || "", `Bearer ${secret}`);
}

function messageText(message) {
  return (message.item_list || [])
    .filter((item) => item.type === 1 && item.text_item?.text)
    .map((item) => item.text_item.text)
    .join("\n")
    .trim();
}

async function callMac(config, payload) {
  if (!config.cloud.macBridgeUrl) throw new Error("MAC_BRIDGE_URL is not configured");
  const response = await fetch(`${config.cloud.macBridgeUrl}/v1/respond`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.bridgeSecret}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new Error(`Mac bridge unavailable: ${response.status}`);
  const result = await response.json();
  if (!result.reply) throw new Error("Mac bridge returned no reply");
  return result;
}

export function startSyncServer(config, store) {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, { ok: true, role: "cloud" });
      }
      if (!authorized(request, config.bridgeSecret)) {
        return sendJson(response, 401, { error: "unauthorized" });
      }
      if (request.method === "GET" && url.pathname === "/v1/sync/pull") {
        return sendJson(response, 200, { records: store.pending(100) });
      }
      if (request.method === "POST" && url.pathname === "/v1/sync/ack") {
        const body = await readRequestJson(request);
        const ids = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 100) : [];
        store.acknowledge(ids);
        return sendJson(response, 200, { acknowledged: ids.length });
      }
      return sendJson(response, 404, { error: "not found" });
    } catch (error) {
      console.error(`[cloud-http] ${error.message}`);
      return sendJson(response, 500, { error: "cloud service error" });
    }
  });
  server.listen(config.cloud.port, config.cloud.bindHost, () => {
    console.log(`[cloud] sync API listening on http://${config.cloud.bindHost}:${config.cloud.port}`);
  });
  return server;
}

export async function routeReply(config, store, payload) {
  let reply;
  let source;
  try {
    const local = await callMac(config, payload);
    return { reply: local.reply, source: local.source || "local-qwen" };
  } catch (localError) {
    console.warn(`[route] Mac offline: ${localError.message}`);
  }

  const context = Array.isArray(payload.context)
    ? payload.context.map((message) => ({ role: message.role, content: message.content }))
    : [];
  const cloudHistory = [
    ...context,
    { role: "user", content: payload.text },
  ];
  try {
    const result = await callCodexModel(config, cloudHistory);
    reply = result.reply;
    source = `cloud-codex-${result.model}`;
  } catch (codexError) {
    console.error(`[route] Codex fallback failed: ${codexError.message}`);
    reply = "Mac 当前离线，Codex 备用线路也暂时不可用。请稍后再试。";
    source = "cloud-unavailable";
  }
  if (payload.archiveFallback !== false) {
    const encrypted = encryptRecord({
      messages: [
        {
          id: payload.messageId,
          conversationId: payload.conversationId,
          role: "user",
          content: payload.historyContent || payload.text,
          modelSource: "wechat",
          createdAt: payload.createdAt,
        },
        {
          id: `${payload.messageId}:reply`,
          conversationId: payload.conversationId,
          role: "assistant",
          content: reply,
          modelSource: source,
          createdAt: Date.now(),
        },
      ],
    }, config.syncKey);
    store.enqueue({ id: payload.messageId, ...encrypted, createdAt: Date.now() });
  }
  return { reply, source };
}

async function processMessage(config, credentials, store, message) {
  if (message.message_type !== 1 || message.group_id) return;
  if (!message.from_user_id || message.from_user_id !== credentials.userId) return;
  const text = messageText(message);
  if (!text) return;
  const messageId = String(message.message_id || message.client_id || message.seq || "");
  if (!messageId || store.getProcessed(messageId)) return;

  const payload = {
    messageId,
    conversationId: credentials.userId,
    text,
    createdAt: message.create_time_ms || Date.now(),
  };
  const { reply, source } = await routeReply(config, store, payload);

  await sendText({
    baseUrl: credentials.baseUrl,
    token: credentials.token,
    toUserId: credentials.userId,
    contextToken: message.context_token,
    text: reply,
  });
  store.markProcessed(messageId, reply);
  console.log(`[wechat] replied via ${source} message=${messageId}`);
}

export async function startCloudService(config) {
  assertSecret("BRIDGE_SHARED_SECRET", config.bridgeSecret);
  if (!config.syncKey) throw new Error("SYNC_KEY is required in cloud mode");
  const credentials = readJson(config.credentialsPath, null);
  if (!credentials?.token || !credentials?.userId || !credentials?.baseUrl) {
    throw new Error(`WeChat credentials missing at ${config.credentialsPath}`);
  }
  const store = openCloudStore(config.cloudDbPath);
  const server = startSyncServer(config, store);
  const controller = new AbortController();
  let cursor = readJson(config.syncCursorPath, { get_updates_buf: "" })?.get_updates_buf || "";
  let nextTimeout = 35_000;

  await notifyLifecycle({ baseUrl: credentials.baseUrl, token: credentials.token, action: "start" })
    .catch((error) => console.warn(`[wechat] start notification failed: ${error.message}`));

  const stop = async () => {
    controller.abort();
    await notifyLifecycle({ baseUrl: credentials.baseUrl, token: credentials.token, action: "stop" })
      .catch(() => {});
    server.close();
    store.close();
  };
  process.once("SIGINT", () => stop().finally(() => process.exit(0)));
  process.once("SIGTERM", () => stop().finally(() => process.exit(0)));

  console.log(`[wechat] polling account=${credentials.accountId}`);
  while (!controller.signal.aborted) {
    try {
      const response = await getUpdates({
        baseUrl: credentials.baseUrl,
        token: credentials.token,
        cursor,
        timeoutMs: nextTimeout,
        signal: controller.signal,
      });
      if ((response.ret && response.ret !== 0) || (response.errcode && response.errcode !== 0)) {
        throw new Error(`getupdates ret=${response.ret} errcode=${response.errcode} ${response.errmsg || ""}`);
      }
      if (response.longpolling_timeout_ms > 0) nextTimeout = response.longpolling_timeout_ms;
      for (const message of response.msgs || []) {
        await processMessage(config, credentials, store, message);
      }
      if (response.get_updates_buf) {
        cursor = response.get_updates_buf;
        writePrivateJson(config.syncCursorPath, { get_updates_buf: cursor });
      }
    } catch (error) {
      if (controller.signal.aborted) break;
      console.error(`[wechat] poll failed: ${error.message}`);
      await sleep(3000, controller.signal).catch(() => {});
    }
  }
}
