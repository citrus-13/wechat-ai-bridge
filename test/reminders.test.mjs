import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  deliverDueReminders,
  handleReminderCommand,
  parseReminderCommand,
} from "../src/reminders.mjs";
import { openCloudStore } from "../src/storage.mjs";

function reminderStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-reminders-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = openCloudStore(path.join(dir, "cloud.sqlite3"));
  t.after(() => store.close());
  return store;
}

test("Chinese reminder dates are interpreted in Europe/Paris and require an explicit time", () => {
  const now = Date.parse("2026-07-20T10:00:00Z");
  const command = parseReminderCommand("提醒我明天下午3点开会", { now, timeZone: "Europe/Paris" });
  assert.equal(command.type, "create");
  assert.equal(command.content, "开会");
  assert.equal(new Date(command.dueAt).toISOString(), "2026-07-21T13:00:00.000Z");
  assert.equal(parseReminderCommand("提醒我明天交材料", { now }).type, "error");
});

test("reminder commands create, list, cancel and keep content encrypted at rest", async (t) => {
  const store = reminderStore(t);
  const syncKey = crypto.randomBytes(32).toString("base64");
  const command = {
    type: "create",
    dueAt: Date.now() + 60_000,
    content: "私人提醒内容",
    timeZone: "Europe/Paris",
  };
  const created = await handleReminderCommand({
    command,
    messageId: "wechat:group:42",
    conversationId: "group-a",
    sender: "成员甲",
    store,
    syncKey,
    timeZone: "Europe/Paris",
  });
  assert.match(created.reply, /已设置提醒/u);
  const raw = store.listReminders("group-a", 10)[0];
  assert.equal(JSON.stringify(raw).includes("私人提醒内容"), false);
  const listed = await handleReminderCommand({
    command: { type: "list" }, conversationId: "group-a", store, syncKey, timeZone: "Europe/Paris",
  });
  assert.match(listed.reply, /私人提醒内容/u);
  const id = /R[0-9A-F]{8}/u.exec(created.reply)[0];
  const cancelled = await handleReminderCommand({
    command: { type: "cancel", id }, conversationId: "group-a", store, syncKey, timeZone: "Europe/Paris",
  });
  assert.match(cancelled.reply, /已取消提醒/u);
  assert.equal(store.listReminders("group-a", 10).length, 0);
});

test("due reminders are sent only to their own group and archived", async (t) => {
  const store = reminderStore(t);
  const syncKey = crypto.randomBytes(32).toString("base64");
  const now = Date.now();
  await handleReminderCommand({
    command: { type: "create", dueAt: now - 1000, content: "出门", timeZone: "Europe/Paris" },
    messageId: "m1",
    conversationId: "group-a",
    sender: "成员甲",
    store,
    syncKey,
    timeZone: "Europe/Paris",
  });
  await handleReminderCommand({
    command: { type: "create", dueAt: now - 1000, content: "其他群", timeZone: "Europe/Paris" },
    messageId: "m2",
    conversationId: "group-b",
    sender: "成员乙",
    store,
    syncKey,
    timeZone: "Europe/Paris",
  });
  const sent = [];
  const archived = [];
  const result = await deliverDueReminders({
    client: { sendText: async (chatId, text) => sent.push({ chatId, text }) },
    chatId: "a@chatroom",
    conversationId: "group-a",
    store,
    syncKey,
    timeZone: "Europe/Paris",
    archiveReply: (id, text) => archived.push({ id, text }),
    now,
  });
  assert.deepEqual(result, { sent: 1, attempted: 1 });
  assert.equal(sent[0].chatId, "a@chatroom");
  assert.match(sent[0].text, /出门/u);
  assert.doesNotMatch(sent[0].text, /其他群/u);
  assert.equal(archived.length, 1);
  assert.equal(store.listReminders("group-b", 10).length, 1);
});
