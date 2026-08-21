import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { getUpdates, sendText } from "../src/wechat-api.mjs";

test("WeChat requests carry iLink authentication headers and context token", async (t) => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      url: request.url,
      headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(request.url.endsWith("getupdates")
      ? JSON.stringify({ ret: 0, msgs: [], get_updates_buf: "next" })
      : JSON.stringify({ ret: 0 }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const updates = await getUpdates({ baseUrl, token: "secret-token", cursor: "cursor" });
  assert.equal(updates.get_updates_buf, "next");
  await sendText({
    baseUrl,
    token: "secret-token",
    toUserId: "user-1",
    contextToken: "ctx-1",
    text: "回答",
  });

  assert.equal(requests[0].headers.authorization, "Bearer secret-token");
  assert.equal(requests[0].headers.authorizationtype, "ilink_bot_token");
  assert.equal(requests[0].headers["ilink-app-id"], "bot");
  assert.equal(requests[0].body.get_updates_buf, "cursor");
  assert.equal(requests[1].body.msg.context_token, "ctx-1");
  assert.equal(requests[1].body.msg.item_list[0].text_item.text, "回答");
});
