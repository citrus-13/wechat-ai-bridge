import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { AgentWechatClient } from "./agent-wechat-api.mjs";
import { routeReply, startSyncServer } from "./cloud-service.mjs";
import { assertSecret } from "./config.mjs";
import { encryptRecord } from "./crypto-sync.mjs";
import { MessagePolicy } from "./message-policy.mjs";
import {
  deliverDueReminders,
  handleReminderCommand,
  parseReminderCommand,
} from "./reminders.mjs";
import { openCloudStore } from "./storage.mjs";
import { sleep } from "./util.mjs";

function hashId(value, length = 24) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

function messageBody(message) {
  const content = String(message.content || "").trim();
  if (content) return content;
  switch (Number(message.type) & 0x7fffffff) {
    case 3: return "[图片]";
    case 34: return "[语音]";
    case 43: return "[视频]";
    case 47: return "[表情]";
    case 49: return "[文件或链接]";
    case 10000: return "[系统消息]";
    default: return `[消息类型 ${Number(message.type) || 0}]`;
  }
}

function createdAt(message) {
  const parsed = Date.parse(message.timestamp || "");
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function chatIdOf(chat) {
  return String(chat?.username || chat?.id || "").trim();
}

function isGroupChat(chatOrId) {
  if (typeof chatOrId === "object" && chatOrId?.isGroup === true) return true;
  return chatIdOf(typeof chatOrId === "object" ? chatOrId : { id: chatOrId }).includes("@chatroom");
}

function conversationIdForChat(chatId, group = isGroupChat(chatId)) {
  return `wechat-${group ? "group" : "direct"}:${hashId(chatId)}`;
}

const BUILTIN_SERVICE_CHAT_IDS = new Set([
  "brandsessionholder", "filehelper", "fmessage", "medianote", "newsapp",
  "notification_messages", "qqmail", "weixin",
]);

export function isServiceChatId(value) {
  const chatId = String(value || "").trim().toLowerCase();
  return !chatId || chatId.startsWith("gh_") || BUILTIN_SERVICE_CHAT_IDS.has(chatId);
}

export function resolveGroupReplyMode(agent, chatId) {
  if (agent.groupDisabledChatIds.includes(chatId)) return "disabled";
  if (agent.groupAllReplyChatIds.includes(chatId)) return "all";
  if (agent.groupMentionOnlyChatIds.includes(chatId)) return "mention-only";
  return agent.groupDefaultMode;
}

export function normalizeAgentWechatMessage(chatId, message) {
  const group = isGroupChat(chatId);
  const sender = String(message.senderName || message.sender || (message.isSelf ? "AI" : "群成员")).trim();
  const body = messageBody(message);
  const id = `wechat:${hashId(chatId)}:${message.localId}`;
  return {
    id,
    conversationId: conversationIdForChat(chatId, group),
    role: message.isSelf ? "assistant" : "user",
    content: message.isSelf || !group ? body : `[${sender}] ${body}`,
    modelSource: message.isSelf ? "wechat-self" : (group ? "wechat-group" : "wechat-direct"),
    createdAt: createdAt(message),
    sender,
    rawText: body,
  };
}

export async function listChatsPaginated(client, pageSize = 100, maxChats = 200) {
  const chats = [];
  for (let offset = 0; offset < maxChats; offset += pageSize) {
    const page = await client.listChats(Math.min(pageSize, maxChats - offset), offset);
    if (!Array.isArray(page) || page.length === 0) break;
    chats.push(...page);
    if (page.length < pageSize) break;
  }
  const unique = new Map(chats.map((chat) => [chatIdOf(chat), chat]));
  unique.delete("");
  return [...unique.values()];
}

export function persistUniqueGroupNames(filePath, chats) {
  const groups = chats
    .filter((chat) => isGroupChat(chat))
    .map((chat) => ({ id: chatIdOf(chat), name: String(chat?.name || "").trim() }))
    .filter((chat) => chat.id && chat.name);
  const counts = new Map();
  for (const group of groups) counts.set(group.name, (counts.get(group.name) || 0) + 1);
  const uniqueGroups = Object.fromEntries(
    groups.filter((group) => counts.get(group.name) === 1).map((group) => [group.id, group.name]),
  );
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify({ version: 1, groups: uniqueGroups })}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
  return uniqueGroups;
}

export async function collectInitialUnreadMessages(client, chatId, unreadCount, pageSize = 200) {
  const wanted = Math.max(0, Number(unreadCount) || 0);
  if (wanted === 0) return [];
  const collected = [];
  for (let offset = 0; collected.length < wanted; offset += pageSize) {
    const page = await client.listMessages(chatId, pageSize, offset);
    if (!Array.isArray(page) || page.length === 0) break;
    collected.push(...page);
    if (page.length < pageSize) break;
  }
  const unique = new Map(collected.map((message) => [Number(message.localId), message]));
  return [...unique.values()]
    .sort((a, b) => Number(a.localId) - Number(b.localId))
    .slice(-wanted);
}

function queueEncryptedMessage(config, store, record) {
  const encrypted = encryptRecord({ messages: [record] }, config.syncKey);
  store.enqueue({ id: record.id, ...encrypted, createdAt: record.createdAt });
}

export async function resolveTargetGroup(client, { targetChatId, targetGroup }) {
  if (targetChatId) {
    const chat = await client.getChat(targetChatId);
    if (!chat) throw new Error(`target WeChat chat ID was not found: ${targetChatId}`);
    if (!chat.isGroup && !String(chat.username || chat.id).includes("@chatroom")) {
      throw new Error("WECHAT_TARGET_CHAT_ID is not a group chat");
    }
    if (targetGroup && chat.name !== targetGroup) {
      throw new Error(`target group name mismatch: expected ${targetGroup}, got ${chat.name}`);
    }
    return chat;
  }
  if (!targetGroup) throw new Error("WECHAT_TARGET_GROUP or WECHAT_TARGET_CHAT_ID is required");
  const matches = (await client.findChats(targetGroup))
    .filter((chat) => chat.name === targetGroup)
    .filter((chat) => chat.isGroup || String(chat.username || chat.id).includes("@chatroom"));
  if (matches.length !== 1) {
    throw new Error(`expected exactly one group named ${targetGroup}; found ${matches.length}. Set WECHAT_TARGET_CHAT_ID.`);
  }
  return matches[0];
}

export async function collectMessagesAfter(client, chatId, lastLocalId, pageSize = 200) {
  const collected = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await client.listMessages(chatId, pageSize, offset);
    if (!Array.isArray(page) || page.length === 0) break;
    for (const message of page) {
      if (Number(message.localId) > lastLocalId) collected.push(message);
    }
    const oldest = Math.min(...page.map((message) => Number(message.localId) || 0));
    if (page.length < pageSize || oldest <= lastLocalId) break;
  }
  const unique = new Map(collected.map((message) => [Number(message.localId), message]));
  return [...unique.values()].sort((a, b) => Number(a.localId) - Number(b.localId));
}

export async function backfillCachedHistory(client, config, store, chatId) {
  if (store.getCursor(chatId) > 0) return { archived: 0, cursor: store.getCursor(chatId) };
  const pageSize = config.wechat.agent.backfillPageSize;
  let archived = 0;
  let maxLocalId = 0;
  for (let offset = 0; ; offset += pageSize) {
    const page = await client.listMessages(chatId, pageSize, offset);
    if (!Array.isArray(page) || page.length === 0) break;
    for (const message of [...page].sort((a, b) => Number(a.localId) - Number(b.localId))) {
      const record = normalizeAgentWechatMessage(chatId, message);
      queueEncryptedMessage(config, store, record);
      archived += 1;
      maxLocalId = Math.max(maxLocalId, Number(message.localId) || 0);
    }
    if (page.length < pageSize) break;
  }
  if (maxLocalId > 0) store.setCursor(chatId, maxLocalId);
  return { archived, cursor: maxLocalId };
}

function trimContext(records, maxMessages, maxChars) {
  const selected = [];
  let chars = 0;
  for (let index = records.length - 1; index >= 0 && selected.length < maxMessages; index -= 1) {
    const record = records[index];
    const size = record.content.length;
    if (selected.length > 0 && chars + size > maxChars) break;
    selected.push(record);
    chars += size;
  }
  return selected.reverse();
}

async function loadContext(client, config, chatId, currentLocalId) {
  const maxMessages = config.wechat.agent.contextMessages;
  const recent = await client.listMessages(chatId, maxMessages + 20, 0);
  const records = recent
    .filter((message) => Number(message.localId) < Number(currentLocalId))
    .sort((a, b) => Number(a.localId) - Number(b.localId))
    .map((message) => normalizeAgentWechatMessage(chatId, message));
  return trimContext(records, maxMessages, config.wechat.agent.contextChars);
}

function validateAgentConfig(config) {
  const agent = config.wechat.agent;
  if (!agent.token) throw new Error("AGENT_WECHAT_TOKEN or AGENT_WECHAT_TOKEN_FILE is required");
  if (!agent.aiName) throw new Error("WECHAT_AI_NAME is required");
}

function chatPolicy(agent, chat) {
  const chatId = chatIdOf(chat);
  if (isGroupChat(chat)) return { enabled: resolveGroupReplyMode(agent, chatId) !== "disabled", mode: resolveGroupReplyMode(agent, chatId) };
  return { enabled: agent.dmPolicy === "open" && !isServiceChatId(chatId), mode: "all" };
}

export async function sessionIsUsable(client, auth) {
  if (auth?.status === "logged_in") return true;
  // WeChat 4.1.1.8 can leave the accessibility view at LoginLoading even
  // after the saved account has entered the main window.  In that state the
  // authenticated chat API is a stronger readiness signal than the stale UI
  // label.  Requiring both a known account and readable chats avoids treating
  // the account-picker screen as logged in.
  if (!String(auth?.loggedInUser || "").trim()) return false;
  try {
    const chats = await client.listChats(1, 0);
    return Array.isArray(chats) && chats.length > 0;
  } catch {
    return false;
  }
}

async function waitForLogin(client, pollIntervalMs) {
  let announced = false;
  for (;;) {
    try {
      const auth = await client.authStatus();
      if (await sessionIsUsable(client, auth)) {
        if (auth?.status !== "logged_in") {
          console.warn(`[agent-wechat] continuing with readable chat API despite stale auth view (status=${auth?.status || "unknown"})`);
        }
        return auth;
      }
      if (!announced) {
        console.warn(`[agent-wechat] waiting for WeChat login confirmation (status=${auth?.status || "unknown"})`);
        announced = true;
      }
    } catch (error) {
      if (!announced) {
        console.warn(`[agent-wechat] waiting for API/login recovery: ${error.message}`);
        announced = true;
      }
    }
    await sleep(Math.max(5000, pollIntervalMs));
  }
}

export async function startAgentWechatService(config) {
  validateAgentConfig(config);
  assertSecret("BRIDGE_SHARED_SECRET", config.bridgeSecret);
  if (!config.syncKey) throw new Error("SYNC_KEY is required in cloud mode");

  const agent = config.wechat.agent;
  const client = new AgentWechatClient({ baseUrl: agent.baseUrl, token: agent.token });
  await waitForLogin(client, agent.pollIntervalMs);
  const store = openCloudStore(config.cloudDbPath);
  const syncServer = startSyncServer(config, store);
  const policy = new MessagePolicy({
    targetGroup: "",
    aiName: agent.aiName,
    allowedSenders: agent.allowedSenders,
    maxRepliesPerMinute: agent.maxRepliesPerMinute,
    senderCooldownSeconds: agent.senderCooldownSeconds,
    maxMessageChars: agent.maxMessageChars,
  });
  const controller = new AbortController();
  let lastReminderSweep = 0;

  console.log(`[agent-wechat] multi-chat polling dm=${agent.dmPolicy} group-default=${agent.groupDefaultMode}`);

  const stop = () => {
    controller.abort();
    syncServer.close();
    store.close();
  };
  process.once("SIGINT", () => { stop(); process.exit(0); });
  process.once("SIGTERM", () => { stop(); process.exit(0); });

  while (!controller.signal.aborted) {
    try {
      if (fs.existsSync(agent.pauseFile)) {
        await sleep(agent.pollIntervalMs, controller.signal);
        continue;
      }
      const chats = await listChatsPaginated(client, agent.chatPageSize, agent.maxChats);
      try {
        persistUniqueGroupNames(path.join(path.dirname(config.cloudDbPath), "agent-wechat-chat-names.json"), chats);
      } catch (error) {
        console.warn(`[agent-wechat] could not refresh exact group-name map: ${error.message}`);
      }
      // Disabled chats must not build a reply backlog. Advancing their cursor
      // means enabling them later starts with messages received after enablement.
      for (const chat of chats.filter((entry) => !chatPolicy(agent, entry).enabled)) {
        const ignoredLastLocalId = Number(chat.lastMsgLocalId) || 0;
        if (ignoredLastLocalId > 0) store.setCursor(chatIdOf(chat), ignoredLastLocalId);
      }
      const enabledChats = chats.filter((chat) => chatPolicy(agent, chat).enabled);

      if (Date.now() - lastReminderSweep >= 30_000) {
        lastReminderSweep = Date.now();
        for (const chat of enabledChats) {
          try {
            const reminderChatId = chatIdOf(chat);
            const reminderConversationId = conversationIdForChat(reminderChatId, isGroupChat(chat));
            await deliverDueReminders({
              client,
              chatId: reminderChatId,
              conversationId: reminderConversationId,
              store,
              syncKey: config.syncKey,
              timeZone: config.reminders.timeZone,
              archiveReply: (id, content, timestamp) => queueEncryptedMessage(config, store, {
                id: `reminder:${id}:delivery`,
                conversationId: reminderConversationId,
                role: "assistant",
                content,
                modelSource: "reminder",
                createdAt: timestamp,
              }),
            });
          } catch (error) {
            console.error(`[agent-wechat] reminder delivery failed chat=${hashId(chatIdOf(chat), 12)}: ${error.message}`);
          }
        }
      }

      for (const chat of enabledChats) {
        try {
        const chatId = chatIdOf(chat);
        const group = isGroupChat(chat);
        const replyMode = chatPolicy(agent, chat).mode;
        const cursor = store.getCursor(chatId);
        const lastLocalId = Number(chat.lastMsgLocalId) || 0;
        const unreadCount = Number(chat.unreadCount) || 0;
        if (cursor === 0 && unreadCount === 0) {
          if (lastLocalId > 0) store.setCursor(chatId, lastLocalId);
          continue;
        }
        if (cursor > 0 && unreadCount === 0 && lastLocalId <= cursor) continue;

        // Reading and replying do not require clearing WeChat's visual unread
        // badge. Opening every unread chat drives the desktop UI and can take
        // longer than the API timeout, which must not block message polling.
        // The per-chat cursor and processed-message reservation below provide
        // the actual duplicate protection.
        const messages = cursor > 0
          ? await collectMessagesAfter(client, chatId, cursor, agent.pollPageSize)
          : await collectInitialUnreadMessages(client, chatId, unreadCount, agent.pollPageSize);
        for (const message of messages) {
        const record = normalizeAgentWechatMessage(chatId, message);
        const body = record.rawText;

        // Generated replies are already stored under the triggering message's
        // reply ID, so do not duplicate them when WeChat echoes them back.
        if (!(message.isSelf && store.hasRecentGeneratedReply(body))) {
          queueEncryptedMessage(config, store, record);
        }

        const decision = policy.evaluate({
          chatType: group ? "group" : "direct",
          replyMode,
          group: chat.name,
          sender: record.sender,
          senderKey: String(message.sender || chatId),
          text: body,
          isSelf: message.isSelf === true,
          isMentioned: message.isMentioned === true,
        });
        if (!decision.accepted) {
          store.setCursor(chatId, Number(message.localId));
          continue;
        }

        if (store.getProcessed(record.id)) {
          store.setCursor(chatId, Number(message.localId));
          continue;
        }
        const reminderCommand = parseReminderCommand(decision.text, {
          now: Date.now(),
          timeZone: config.reminders.timeZone,
        });
        const reminderResult = await handleReminderCommand({
          command: reminderCommand,
          messageId: record.id,
          conversationId: record.conversationId,
          sender: record.sender,
          store,
          syncKey: config.syncKey,
          timeZone: config.reminders.timeZone,
        });
        let reply;
        let source;
        if (reminderResult) {
          ({ reply, source } = reminderResult);
        } else {
          const context = await loadContext(client, config, chatId, message.localId);
          const payload = {
            messageId: record.id,
            conversationId: record.conversationId,
            text: decision.text,
            historyContent: record.content,
            context,
            createdAt: record.createdAt,
            archiveFallback: false,
          };
          ({ reply, source } = await routeReply(config, store, payload));
        }
        if (fs.existsSync(agent.pauseFile)) break;
        // Reserve before sending. If the process dies after WeChat accepts the
        // message, restart logic will not send a dangerous duplicate.
        store.markProcessed(record.id, reply);
        try {
          await client.sendText(chatId, reply.slice(0, 6000));
        } catch (error) {
          // Only undo the reservation when agent-wechat explicitly confirms
          // that no message was sent. Timeouts remain reserved because their
          // delivery outcome is ambiguous and a retry could duplicate it.
          if (error?.definitive === true) store.unmarkProcessed(record.id);
          throw error;
        }
        const replyRecord = {
          id: `${record.id}:reply`,
          conversationId: record.conversationId,
          role: "assistant",
          content: reply,
          modelSource: source,
          createdAt: Date.now(),
        };
        queueEncryptedMessage(config, store, replyRecord);
        policy.recordReply(decision.senderKey);
        store.setCursor(chatId, Number(message.localId));
        console.log(`[agent-wechat] replied via ${source} message=${record.id}`);
        }
        } catch (error) {
          console.error(`[agent-wechat] chat processing failed chat=${hashId(chatIdOf(chat), 12)}: ${error.message}`);
        }
      }
    } catch (error) {
      if (controller.signal.aborted) break;
      console.error(`[agent-wechat] poll failed: ${error.message}`);
    }
    await sleep(agent.pollIntervalMs, controller.signal).catch(() => {});
  }
}
