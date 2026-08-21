import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { callCodexSubscription, checkCodexLogin, sanitizeCodexOutput, selectCodexTier } from "../src/codex-model.mjs";
import { routeReply } from "../src/cloud-service.mjs";
import { callCodexModel } from "../src/models.mjs";

function fakeCodex(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-codex-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const binary = path.join(dir, "fake-codex.mjs");
  fs.writeFileSync(binary, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const outputPath = args[args.indexOf("--output-last-message") + 1];
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(`${binary}.args.json`)}, JSON.stringify(args));
  fs.writeFileSync(${JSON.stringify(`${binary}.prompt.txt`)}, prompt);
  fs.writeFileSync(outputPath, "模拟 GPT 回复");
});
`, { mode: 0o700 });
  return {
    binary,
    argsPath: `${binary}.args.json`,
    promptPath: `${binary}.prompt.txt`,
  };
}

function codexConfig(binary, home) {
  return {
    cloud: {
      modelStyle: "codex",
      apiUrl: "",
      apiKey: "",
      allowRemoteContext: false,
      codexBin: binary,
      codexHome: home,
      codexTimeoutMs: 5000,
      codexMaxOutputChars: 6000,
      codexModels: {
        luna: "gpt-5.6-luna",
        terra: "gpt-5.6-terra",
        sol: "gpt-5.6-sol",
      },
      codexReasoning: { luna: "low", terra: "high", sol: "xhigh" },
    },
  };
}

test("Codex tier routing keeps Luna default and reserves Sol for explicit requests", () => {
  assert.deepEqual(selectCodexTier("你好").tier, "luna");
  assert.deepEqual(selectCodexTier("请深度分析这份方案").tier, "terra");
  assert.deepEqual(selectCodexTier("/sol 比较这三个选择").tier, "sol");
  assert.equal(selectCodexTier("/sol 比较这三个选择").text, "比较这三个选择");
  assert.equal(selectCodexTier("查一下今天的新闻").forceCloud, true);
});

test("Codex output removes internal web-search references that WeChat cannot open", () => {
  assert.equal(
    sanitizeCodexOutput("巴黎多云。 [天气信息](turn0forecast0) citeturn0search1"),
    "巴黎多云。 天气信息",
  );
});

test("subscription-only mode rejects Codex API-key authentication", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-codex-login-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const binary = path.join(dir, "codex");
  fs.writeFileSync(binary, "#!/bin/sh\necho 'Logged in using an API key'\n", { mode: 0o700 });
  await assert.rejects(
    checkCodexLogin(codexConfig(binary, dir)),
    /must be signed in with ChatGPT/u,
  );
});

test("Codex subprocess has live web search but no local computer or file tools", async (t) => {
  const fake = fakeCodex(t);
  const result = await callCodexSubscription(
    codexConfig(fake.binary, path.dirname(fake.binary)),
    [{ role: "user", content: "/terra 深度比较" }],
    "系统提示",
  );
  assert.equal(result.content, "模拟 GPT 回复");
  assert.equal(result.model, "gpt-5.6-terra");
  const args = JSON.parse(fs.readFileSync(fake.argsPath, "utf8"));
  assert.ok(args.includes("web_search=\"live\""));
  for (const feature of ["shell_tool", "unified_exec", "computer_use", "browser_use", "plugins", "apps"]) {
    const index = args.indexOf(feature);
    assert.ok(index > 0 && args[index - 1] === "--disable", `${feature} must be disabled`);
  }
  assert.ok(args.includes("--ephemeral"));
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(args.includes("read-only"));
});

test("remote Codex receives only the current mentioned message by default", async (t) => {
  const fake = fakeCodex(t);
  const result = await callCodexModel(codexConfig(fake.binary, path.dirname(fake.binary)), [
    { role: "user", content: "另一个成员的私人旧消息" },
    { role: "assistant", content: "旧回复" },
    { role: "user", content: "查一下巴黎今天的天气" },
  ]);
  assert.equal(result.model, "gpt-5.6-luna");
  const prompt = fs.readFileSync(fake.promptPath, "utf8");
  assert.match(prompt, /巴黎今天的天气/u);
  assert.doesNotMatch(prompt, /私人旧消息/u);
  assert.doesNotMatch(prompt, /旧回复/u);
  assert.match(prompt, /独立微信群/u);
});

test("routing uses Codex directly when Mac is offline", async (t) => {
  const fake = fakeCodex(t);
  const config = codexConfig(fake.binary, path.dirname(fake.binary));
  config.cloud.macBridgeUrl = "";
  const result = await routeReply(config, null, {
    messageId: "m1",
    conversationId: "wechat-group:test",
    text: "现在回答我",
    context: [{ role: "user", content: "不应上传的群历史" }],
    createdAt: Date.now(),
    archiveFallback: false,
  });
  assert.equal(result.reply, "模拟 GPT 回复");
  assert.equal(result.source, "cloud-codex-gpt-5.6-luna");
  const prompt = fs.readFileSync(fake.promptPath, "utf8");
  assert.match(prompt, /现在回答我/u);
  assert.doesNotMatch(prompt, /不应上传的群历史/u);
});

test("routing always prefers the Mac bridge even for live-search questions", async (t) => {
  const server = await import("node:http").then(({ default: http }) => http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume body */ }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ reply: "本地联网 Qwen 回答", source: "local-qwen-web" }));
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const config = codexConfig("/must/not/run/codex", os.tmpdir());
  config.cloud.macBridgeUrl = `http://127.0.0.1:${server.address().port}`;
  const result = await routeReply(config, null, {
    messageId: "m-local",
    conversationId: "wechat-group:test",
    text: "查一下巴黎天气",
    createdAt: Date.now(),
    archiveFallback: false,
  });
  assert.deepEqual(result, { reply: "本地联网 Qwen 回答", source: "local-qwen-web" });
});
