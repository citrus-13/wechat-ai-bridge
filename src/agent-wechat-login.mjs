import fs from "node:fs";
import path from "node:path";

import { AgentWechatClient } from "./agent-wechat-api.mjs";
import { ensurePrivateDir } from "./util.mjs";

function writeQrDataUrl(dataUrl, filePath) {
  const match = /^data:image\/png;base64,(.+)$/u.exec(String(dataUrl || ""));
  if (!match) return false;
  ensurePrivateDir(path.dirname(filePath));
  fs.writeFileSync(filePath, Buffer.from(match[1], "base64"), { mode: 0o600 });
  return true;
}

export async function loginWithAgentWechat(config) {
  const agent = config.wechat.agent;
  const client = new AgentWechatClient({ baseUrl: agent.baseUrl, token: agent.token });
  const existing = await client.authStatus();
  if (existing?.status === "logged_in") {
    console.log(`LOGIN_OK user=${existing.loggedInUser || "wechat"}`);
    return existing;
  }

  const event = await client.loginSubscribe({
    timeoutMs: 8 * 60_000,
    onEvent(loginEvent) {
      if (loginEvent.type === "qr" && writeQrDataUrl(loginEvent.qrDataUrl, config.qrPngPath)) {
        console.log(`QR_READY ${config.qrPngPath}`);
        console.log("请用专用微信账号扫码并在手机上确认登录。");
      } else if (loginEvent.type === "phone_confirm") {
        console.log("请在手机微信上确认登录。");
      } else if (loginEvent.type === "status" && loginEvent.message) {
        console.log(`LOGIN_STATUS ${loginEvent.message}`);
      }
    },
  });
  const status = await client.authStatus();
  console.log(`LOGIN_OK user=${status.loggedInUser || event.userId || "wechat"}`);
  return status;
}
