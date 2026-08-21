import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.mjs";

function withEnvironment(values, callback) {
  const previous = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  try {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    return callback();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("multi-chat policies load with safe defaults and explicit DM open", () => {
  withEnvironment({
    AGENT_WECHAT_TOKEN: "test-token",
    WECHAT_DM_POLICY: "open",
    WECHAT_GROUP_DEFAULT_MODE: undefined,
    WECHAT_GROUP_ALL_REPLY_CHAT_IDS: "all@chatroom",
    WECHAT_GROUP_MENTION_ONLY_CHAT_IDS: "mention@chatroom",
    WECHAT_GROUP_DISABLED_CHAT_IDS: "off@chatroom",
  }, () => {
    const agent = loadConfig().wechat.agent;
    assert.equal(agent.dmPolicy, "open");
    assert.equal(agent.groupDefaultMode, "mention-only");
    assert.deepEqual(agent.groupAllReplyChatIds, ["all@chatroom"]);
  });
});

test("conflicting group reply lists fail closed", () => {
  withEnvironment({
    AGENT_WECHAT_TOKEN: "test-token",
    WECHAT_GROUP_ALL_REPLY_CHAT_IDS: "same@chatroom",
    WECHAT_GROUP_MENTION_ONLY_CHAT_IDS: "same@chatroom",
    WECHAT_GROUP_DISABLED_CHAT_IDS: "",
  }, () => {
    assert.throws(() => loadConfig(), /appears in both/u);
  });
});
