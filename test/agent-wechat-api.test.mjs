import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { AgentWechatClient } from "../src/agent-wechat-api.mjs";

test("agent-wechat client authenticates, paginates, and sends to the selected chat", async (t) => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      method: request.method,
      url: request.url,
      auth: request.headers.authorization,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null,
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(request.url === "/api/messages/send"
      ? JSON.stringify({ success: true, messageId: "m1" })
      : JSON.stringify([]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const client = new AgentWechatClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    token: "private-token",
  });
  await client.listMessages("room@chatroom", 200, 400);
  await client.sendText("room@chatroom", "回答");

  assert.equal(requests[0].auth, "Bearer private-token");
  assert.equal(requests[0].url, "/api/messages/room%40chatroom?limit=200&offset=400");
  assert.deepEqual(requests[1].body, { chatId: "room@chatroom", text: "回答" });
});

test("agent-wechat retries once after an explicit no-action failure", async (t) => {
  let sends = 0;
  const server = http.createServer(async (request, response) => {
    if (request.url === "/api/messages/send") sends += 1;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(request.url === "/api/messages/send"
      ? (sends === 1 ? { success: false, error: "No action selected" } : { success: true })
      : {}));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const client = new AgentWechatClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    token: "private-token",
  });
  await client.sendText("room@chatroom", "回答");
  assert.equal(sends, 2);
});
