import crypto from "node:crypto";

import * as chrono from "chrono-node";
import { DateTime } from "luxon";

import { decryptRecord, encryptRecord } from "./crypto-sync.mjs";

const LIST_PATTERN = /^\s*(?:查看|列出|显示)?\s*(?:我的|全部)?\s*提醒(?:列表|事项)?\s*[。.!！?？]*\s*$/iu;
const CANCEL_PATTERN = /^\s*(?:取消|删除)\s*(?:(全部)\s*提醒|提醒\s*(全部|[Rr][0-9A-Fa-f]{8}))\s*[。.!！?？]*\s*$/u;
const CREATE_HINT = /(?:提醒我|提醒|定时)/u;

function reminderId(messageId) {
  return `R${crypto.createHash("sha256").update(String(messageId)).digest("hex").slice(0, 8).toUpperCase()}`;
}

function timezoneReference(now, timeZone) {
  const reference = DateTime.fromMillis(now, { zone: timeZone });
  if (!reference.isValid) throw new Error(`invalid reminder timezone: ${timeZone}`);
  return { instant: new Date(now), timezone: reference.offset };
}

function parsedDateInZone(result, timeZone) {
  const start = result.start;
  const value = DateTime.fromObject({
    year: start.get("year"),
    month: start.get("month"),
    day: start.get("day"),
    hour: start.get("hour"),
    minute: start.get("minute"),
    second: start.get("second"),
    millisecond: start.get("millisecond"),
  }, { zone: timeZone });
  if (!value.isValid) throw new Error(`无法识别提醒时间：${value.invalidExplanation || "日期无效"}`);
  return value.toMillis();
}

function extractReminderContent(text, result) {
  const withoutDate = `${text.slice(0, result.index)} ${text.slice(result.index + result.text.length)}`;
  return withoutDate
    .replace(/(?:请|麻烦|帮我|到时候|记得)?\s*(?:提醒我|提醒一下我|提醒一下|提醒|定时提醒|定时)/giu, " ")
    .replace(/^[\s，,。.!！?？:：;；、-]+|[\s，,。.!！?？:：;；、-]+$/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function parseReminderCommand(value, {
  now = Date.now(),
  timeZone = "Europe/Paris",
} = {}) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (LIST_PATTERN.test(text)) return { type: "list" };
  const cancel = CANCEL_PATTERN.exec(text);
  if (cancel) return { type: "cancel", id: String(cancel[1] || cancel[2]).toUpperCase() };
  if (!CREATE_HINT.test(text)) return null;
  if (/(?:每天|每周|每月|每年|工作日|循环提醒|重复提醒)/u.test(text)) {
    return { type: "error", message: "目前只支持单次提醒；请先给出下一次的具体日期和时间。" };
  }

  const results = chrono.zh.hans.parse(
    text,
    timezoneReference(now, timeZone),
    { forwardDate: true },
  );
  const result = results[0];
  if (!result) return { type: "error", message: "没有识别到提醒日期。请例如说：提醒我明天下午3点开会。" };
  if (!result.start.isCertain("hour")) {
    return { type: "error", message: "识别到了日期，但没有明确时间。请补充几点几分。" };
  }
  const dueAt = parsedDateInZone(result, timeZone);
  if (dueAt <= now + 1000) return { type: "error", message: "提醒时间必须晚于现在。" };
  const content = extractReminderContent(text, result);
  if (!content) return { type: "error", message: "请补充需要提醒的内容。" };
  return { type: "create", dueAt, content, timeZone };
}

export function formatReminderTime(timestamp, timeZone = "Europe/Paris") {
  return DateTime.fromMillis(timestamp, { zone: timeZone })
    .setLocale("zh-CN")
    .toFormat("yyyy-LL-dd HH:mm");
}

function decryptReminder(row, syncKey) {
  return { ...row, ...decryptRecord(row, syncKey) };
}

export async function handleReminderCommand({
  command,
  messageId,
  conversationId,
  sender,
  store,
  syncKey,
  timeZone,
}) {
  if (!command) return null;
  if (command.type === "error") return { reply: command.message, source: "reminder-error" };

  if (command.type === "create") {
    const id = reminderId(messageId);
    const encrypted = encryptRecord({ content: command.content, sender }, syncKey);
    store.createReminder({
      id,
      conversationId,
      dueAt: command.dueAt,
      ...encrypted,
      createdAt: Date.now(),
    });
    return {
      reply: `⏰ 已设置提醒\n时间：${formatReminderTime(command.dueAt, timeZone)}（${timeZone}）\n内容：${command.content}\n编号：${id}`,
      source: "reminder-created",
    };
  }

  if (command.type === "list") {
    const rows = store.listReminders(conversationId, 20)
      .map((row) => decryptReminder(row, syncKey));
    if (rows.length === 0) return { reply: "目前没有待发送的提醒。", source: "reminder-list" };
    const lines = rows.map((row) => `${row.id}｜${formatReminderTime(row.due_at, timeZone)}｜${row.content}`);
    return { reply: `待发送提醒：\n${lines.join("\n")}`, source: "reminder-list" };
  }

  if (command.type === "cancel") {
    const count = command.id === "全部"
      ? store.cancelAllReminders(conversationId)
      : store.cancelReminder(command.id, conversationId);
    const reply = count > 0
      ? `已取消${command.id === "全部" ? ` ${count} 个提醒` : `提醒 ${command.id}`}`
      : "没有找到对应的待发送提醒。";
    return { reply, source: "reminder-cancelled" };
  }

  return null;
}

export async function deliverDueReminders({
  client,
  chatId,
  conversationId,
  store,
  syncKey,
  timeZone,
  archiveReply,
  now = Date.now(),
}) {
  const due = store.claimDueReminders(conversationId, now, 10);
  let sent = 0;
  for (const row of due) {
    try {
      const reminder = decryptReminder(row, syncKey);
      const text = `⏰ ${reminder.sender}，提醒你：${reminder.content}\n原定时间：${formatReminderTime(row.due_at, timeZone)}｜${row.id}`;
      await client.sendText(chatId, text);
      store.markReminderSent(row.id, Date.now());
      store.markProcessed(`reminder:${row.id}`, text);
      if (archiveReply) archiveReply(row.id, text, Date.now());
      sent += 1;
    } catch (error) {
      store.retryReminder(row.id, String(error.message || error).slice(0, 200), Date.now());
    }
  }
  return { sent, attempted: due.length };
}
