import crypto from "node:crypto";
import fs from "node:fs";

import { routeReply, startSyncServer } from "./cloud-service.mjs";
import { assertSecret } from "./config.mjs";
import { MessagePolicy } from "./message-policy.mjs";
import { openCloudStore } from "./storage.mjs";
import { sleep } from "./util.mjs";
import { WeChatDesktopDriver } from "./wechat-desktop.mjs";

function conversationId(group) {
  return `wechat-group:${crypto.createHash("sha256").update(group).digest("hex").slice(0, 24)}`;
}

function validateDesktopConfig(config) {
  const desktop = config.wechat.desktop;
  if (!desktop.targetGroup) throw new Error("WECHAT_TARGET_GROUP is required in desktop mode");
  if (!desktop.aiName) throw new Error("WECHAT_AI_NAME is required in desktop mode");
  if (desktop.allowedSenders.length === 0) {
    throw new Error("WECHAT_ALLOWED_SENDERS must contain the exact display names allowed to trigger AI");
  }
}

export async function startDesktopService(config) {
  validateDesktopConfig(config);
  assertSecret("BRIDGE_SHARED_SECRET", config.bridgeSecret);
  if (!config.syncKey) throw new Error("SYNC_KEY is required in cloud mode");

  const desktop = config.wechat.desktop;
  const store = openCloudStore(config.cloudDbPath);
  const server = startSyncServer(config, store);
  const driver = new WeChatDesktopDriver(config);
  const policy = new MessagePolicy(desktop);
  const controller = new AbortController();
  const groupConversationId = conversationId(desktop.targetGroup);

  const status = await driver.check();
  if (!status.ok) {
    server.close();
    store.close();
    throw new Error(`WeChat desktop is not ready: ${(status.errors || []).join("; ")}`);
  }

  const stop = () => {
    controller.abort();
    server.close();
    store.close();
  };
  process.once("SIGINT", () => { stop(); process.exit(0); });
  process.once("SIGTERM", () => { stop(); process.exit(0); });

  console.log("[wechat-ui] desktop polling started");
  while (!controller.signal.aborted) {
    try {
      if (fs.existsSync(desktop.pauseFile)) {
        await sleep(desktop.pollIntervalMs, controller.signal);
        continue;
      }
      const result = await driver.poll();
      for (const event of result.events || []) {
        const messageId = String(event.id || "").trim();
        if (!messageId || store.getProcessed(messageId)) continue;
        const decision = policy.evaluate(event);
        if (!decision.accepted) continue;
        const payload = {
          messageId,
          conversationId: groupConversationId,
          text: decision.text,
          createdAt: Number.isFinite(event.createdAt) ? event.createdAt : Date.now(),
        };
        const { reply, source } = await routeReply(config, store, payload);
        if (fs.existsSync(desktop.pauseFile)) break;
        await driver.send(reply.slice(0, 6000));
        store.markProcessed(messageId, reply);
        policy.recordReply(decision.sender);
        console.log(`[wechat-ui] replied via ${source} message=${messageId}`);
      }
    } catch (error) {
      if (controller.signal.aborted) break;
      console.error(`[wechat-ui] poll failed: ${error.message}`);
    }
    await sleep(desktop.pollIntervalMs, controller.signal).catch(() => {});
  }
}
