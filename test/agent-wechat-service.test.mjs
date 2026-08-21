import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  backfillCachedHistory,
  collectInitialUnreadMessages,
  collectMessagesAfter,
  isServiceChatId,
  listChatsPaginated,
  normalizeAgentWechatMessage,
  persistUniqueGroupNames,
  resolveGroupReplyMode,
  resolveTargetGroup,
  sessionIsUsable,
} from "../src/agent-wechat-service.mjs";
import { decryptRecord } from "../src/crypto-sync.mjs";
import { openCloudStore } from "../src/storage.mjs";

function msg(localId, content, extra = {}) {
  return {
    localId,
    type: 1,
    content,
    timestamp: new Date(localId * 1000).toISOString(),
    sender: "wxid_member",
    senderName: "成员甲",
    ...extra,
  };
}

test("normalization preserves sender context without exposing the real chat ID in record IDs", () => {
  const record = normalizeAgentWechatMessage("secret-room@chatroom", msg(7, "今晚几点？"));
  assert.equal(record.content, "[成员甲] 今晚几点？");
  assert.equal(record.role, "user");
  assert.equal(record.id.includes("secret-room"), false);
});

test("different WeChat groups always receive different local memory namespaces", () => {
  const first = normalizeAgentWechatMessage("first@chatroom", msg(1, "第一群"));
  const second = normalizeAgentWechatMessage("second@chatroom", msg(1, "第二群"));
  assert.notEqual(first.conversationId, second.conversationId);
  assert.match(first.conversationId, /^wechat-group:[0-9a-f]{24}$/u);
  assert.equal(first.conversationId.includes("first@chatroom"), false);
});

test("direct chats use isolated direct namespaces without injecting a fake group sender", () => {
  const direct = normalizeAgentWechatMessage("wxid_friend", msg(1, "你好"));
  const other = normalizeAgentWechatMessage("wxid_other", msg(1, "你好"));
  assert.match(direct.conversationId, /^wechat-direct:[0-9a-f]{24}$/u);
  assert.notEqual(direct.conversationId, other.conversationId);
  assert.equal(direct.content, "你好");
  assert.equal(direct.modelSource, "wechat-direct");
});

test("exact group chat IDs override the default reply mode", () => {
  const agent = {
    groupDefaultMode: "mention-only",
    groupAllReplyChatIds: ["all@chatroom"],
    groupMentionOnlyChatIds: ["mention@chatroom"],
    groupDisabledChatIds: ["off@chatroom"],
  };
  assert.equal(resolveGroupReplyMode(agent, "all@chatroom"), "all");
  assert.equal(resolveGroupReplyMode(agent, "mention@chatroom"), "mention-only");
  assert.equal(resolveGroupReplyMode(agent, "off@chatroom"), "disabled");
  assert.equal(resolveGroupReplyMode(agent, "other@chatroom"), "mention-only");
});

test("official and built-in service sessions are not treated as direct contacts", () => {
  assert.equal(isServiceChatId("gh_official"), true);
  assert.equal(isServiceChatId("filehelper"), true);
  assert.equal(isServiceChatId("wxid_friend"), false);
});

test("readable chats recover from WeChat's stale logged-out accessibility view", async () => {
  const usable = await sessionIsUsable(
    { listChats: async () => [{ username: "wxid_friend" }] },
    { status: "logged_out", loggedInUser: "wxid_saved_account" },
  );
  assert.equal(usable, true);
});

test("stale auth recovery fails closed without an account or readable chats", async () => {
  assert.equal(await sessionIsUsable(
    { listChats: async () => [{ username: "wxid_friend" }] },
    { status: "logged_out" },
  ), false);
  assert.equal(await sessionIsUsable(
    { listChats: async () => { throw new Error("offline"); } },
    { status: "logged_out", loggedInUser: "wxid_saved_account" },
  ), false);
});

test("target resolution fails closed on duplicate group names", async () => {
  const client = {
    findChats: async () => [
      { id: "a", username: "a@chatroom", name: "三人群", isGroup: true },
      { id: "b", username: "b@chatroom", name: "三人群", isGroup: true },
    ],
  };
  await assert.rejects(resolveTargetGroup(client, { targetGroup: "三人群" }), /found 2/u);
});

test("new-message collection paginates backwards and returns only unseen messages oldest first", async () => {
  const pages = [
    [msg(9, "9"), msg(8, "8"), msg(7, "7")],
    [msg(6, "6"), msg(5, "5"), msg(4, "4")],
  ];
  const client = { listMessages: async (_chat, _limit, offset) => pages[offset / 3] || [] };
  const result = await collectMessagesAfter(client, "room@chatroom", 5, 3);
  assert.deepEqual(result.map((message) => message.localId), [6, 7, 8, 9]);
});

test("chat discovery paginates and deduplicates exact chat IDs", async () => {
  const pages = [
    [{ username: "a" }, { username: "b" }],
    [{ username: "b" }, { username: "c" }],
  ];
  const client = { listChats: async (_limit, offset) => pages[offset / 2] || [] };
  const result = await listChatsPaginated(client, 2, 4);
  assert.deepEqual(result.map((chat) => chat.username), ["a", "b", "c"]);
});

test("group-name map includes new unique groups and fails closed on duplicate display names", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-wechat-groups-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "groups.json");
  const groups = persistUniqueGroupNames(file, [
    { username: "new@chatroom", name: "新群", isGroup: true },
    { username: "duplicate-a@chatroom", name: "同名群", isGroup: true },
    { username: "duplicate-b@chatroom", name: "同名群", isGroup: true },
    { username: "wxid_friend", name: "私聊", isGroup: false },
  ]);
  assert.deepEqual(groups, { "new@chatroom": "新群" });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 1, groups });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("first observation processes only the current unread tail, never cached history", async () => {
  const pages = [[msg(5, "5"), msg(4, "4"), msg(3, "3"), msg(2, "2"), msg(1, "1")]];
  const client = { listMessages: async (_chat, _limit, offset) => pages[offset / 10] || [] };
  const result = await collectInitialUnreadMessages(client, "wxid_friend", 2, 10);
  assert.deepEqual(result.map((message) => message.localId), [4, 5]);
});

test("first startup encrypts every cached group message and seeds the no-reply cursor", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-wechat-backfill-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = openCloudStore(path.join(dir, "queue.sqlite3"));
  t.after(() => store.close());
  const key = crypto.randomBytes(32).toString("base64");
  const pages = [
    [msg(3, "第三条", { isMentioned: true }), msg(2, "第二条")],
    [msg(1, "第一条")],
  ];
  const client = { listMessages: async (_chat, _limit, offset) => pages[offset / 2] || [] };
  const config = { syncKey: key, wechat: { agent: { backfillPageSize: 2 } } };
  const result = await backfillCachedHistory(client, config, store, "room@chatroom");

  assert.deepEqual(result, { archived: 3, cursor: 3 });
  assert.equal(store.getCursor("room@chatroom"), 3);
  const decoded = store.pending(10).map((record) => decryptRecord(record, key).messages[0]);
  assert.deepEqual(decoded.map((record) => record.content), ["[成员甲] 第一条", "[成员甲] 第二条", "[成员甲] 第三条"]);
});
