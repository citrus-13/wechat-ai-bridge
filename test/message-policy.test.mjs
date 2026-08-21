import assert from "node:assert/strict";
import test from "node:test";

import { MessagePolicy } from "../src/message-policy.mjs";

function policy(overrides = {}, clock = () => 100_000) {
  return new MessagePolicy({
    targetGroup: "家庭 AI 测试群",
    aiName: "AI",
    allowedSenders: ["小明", "小红"],
    maxRepliesPerMinute: 2,
    senderCooldownSeconds: 8,
    maxMessageChars: 100,
    ...overrides,
  }, clock);
}

test("desktop policy fails closed outside the exact group and sender allowlist", () => {
  const instance = policy();
  assert.equal(instance.evaluate({ group: "别的群", sender: "小明", text: "@AI 你好" }).reason, "wrong-group");
  assert.equal(instance.evaluate({ group: "家庭 AI 测试群", sender: "陌生人", text: "@AI 你好" }).reason, "sender-not-allowed");
});

test("desktop policy requires an explicit mention and strips it before routing", () => {
  const instance = policy();
  assert.equal(instance.evaluate({ group: "家庭 AI 测试群", sender: "小明", text: "@AI 这只是手打文字", isMentioned: false }).reason, "not-mentioned");
  assert.equal(instance.evaluate({ group: "家庭 AI 测试群", sender: "小明", text: "普通消息", isMentioned: true }).reason, "mention-name-mismatch");
  assert.equal(instance.evaluate({ group: "家庭 AI 测试群", sender: "小明", text: "@旧名字 你好", isMentioned: true }).reason, "mention-name-mismatch");
  assert.deepEqual(
    instance.evaluate({ group: "家庭 AI 测试群", sender: "小明", text: "＠ AI，帮我总结", isMentioned: true }),
    { accepted: true, sender: "小明", senderKey: "小明", text: "帮我总结" },
  );
});

test("direct messages and all-reply groups do not require a mention", () => {
  const instance = policy({ allowedSenders: [] });
  assert.deepEqual(
    instance.evaluate({ chatType: "direct", sender: "联系人", senderKey: "wxid_contact", text: "你好" }),
    { accepted: true, sender: "联系人", senderKey: "wxid_contact", text: "你好" },
  );
  assert.deepEqual(
    instance.evaluate({ chatType: "group", replyMode: "all", group: "家庭 AI 测试群", sender: "成员", text: "大家好" }),
    { accepted: true, sender: "成员", senderKey: "成员", text: "大家好" },
  );
});

test("disabled and invalid group modes fail closed", () => {
  const instance = policy({ allowedSenders: [] });
  assert.equal(instance.evaluate({ chatType: "group", replyMode: "disabled", group: "家庭 AI 测试群", sender: "成员", text: "你好" }).reason, "chat-disabled");
  assert.equal(instance.evaluate({ chatType: "group", replyMode: "sometimes", group: "家庭 AI 测试群", sender: "成员", text: "你好" }).reason, "invalid-reply-mode");
});

test("an empty sender allowlist lets any member of the exact group mention the AI", () => {
  const instance = policy({ allowedSenders: [] });
  assert.equal(instance.evaluate({
    group: "家庭 AI 测试群",
    sender: "新成员",
    text: "@AI\u2005你好",
    isMentioned: true,
  }).accepted, true);
});

test("desktop policy applies sender cooldown and global rate limit", () => {
  let now = 100_000;
  const instance = policy({}, () => now);
  const event = { group: "家庭 AI 测试群", sender: "小明", text: "@AI 问题一", isMentioned: true };
  assert.equal(instance.evaluate(event).accepted, true);
  instance.recordReply("小明");
  now += 1000;
  assert.equal(instance.evaluate(event).reason, "sender-cooldown");
  now += 8000;
  assert.equal(instance.evaluate(event).accepted, true);
  instance.recordReply("小明");
  now += 9000;
  assert.equal(instance.evaluate(event).reason, "global-rate-limit");
});
