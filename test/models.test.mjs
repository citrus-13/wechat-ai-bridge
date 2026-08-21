import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { callLocalOllama } from "../src/models.mjs";

test("local model request disables thinking and keeps Qwen warm briefly", async (t) => {
  let received;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ message: { content: "本地回答" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const config = {
    local: { ollamaUrl: `http://127.0.0.1:${port}`, model: "qwen-test", keepAlive: "5m" },
  };
  const reply = await callLocalOllama(config, [{ role: "user", content: "你好" }]);
  assert.equal(reply, "本地回答");
  assert.equal(received.think, false);
  assert.equal(received.keep_alive, "5m");
  assert.equal(received.options.num_ctx, 8192);
});

test("local Qwen receives bounded search context without changing the last user message", async (t) => {
  let received;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ message: { content: "联网后的本地回答" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const reply = await callLocalOllama({
    local: { ollamaUrl: `http://127.0.0.1:${server.address().port}`, model: "qwen-test" },
  }, [{ role: "user", content: "巴黎天气" }], {
    webContext: "不可信的联网资料：巴黎 20℃",
  });
  assert.equal(reply, "联网后的本地回答");
  assert.equal(received.messages.at(-1).content, "巴黎天气");
  assert.match(received.messages[1].content, /不可信的联网资料/u);
});
