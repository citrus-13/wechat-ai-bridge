import fs from "node:fs";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import QRCode from "qrcode";

import { createLoginQr, normalizeApiBase, pollLoginQr } from "./wechat-api.mjs";
import { ensurePrivateDir, readJson, writePrivateJson } from "./util.mjs";

export async function loginWithQr(config) {
  ensurePrivateDir(config.dataDir);
  const previous = readJson(config.credentialsPath, null);
  const localTokens = previous?.token ? [previous.token] : [];
  let qr = await createLoginQr(config.wechatApiBase, localTokens);
  if (!qr?.qrcode || !qr?.qrcode_img_content) {
    throw new Error("Tencent login endpoint did not return a QR code");
  }
  await QRCode.toFile(config.qrPngPath, qr.qrcode_img_content, {
    width: 640,
    margin: 3,
    errorCorrectionLevel: "M",
  });
  fs.chmodSync(config.qrPngPath, 0o600);
  output.write(`QR_READY ${config.qrPngPath}\n`);
  output.write("请用手机微信扫描二维码并在手机上确认授权。\n");

  const terminal = readline.createInterface({ input, output });
  let pollingBase = config.wechatApiBase;
  let verifyCode = "";
  const deadline = Date.now() + 8 * 60_000;
  try {
    while (Date.now() < deadline) {
      const status = await pollLoginQr(pollingBase, qr.qrcode, verifyCode);
      switch (status?.status) {
        case "wait":
          break;
        case "scaned":
          verifyCode = "";
          output.write("已扫码，请在手机上确认。\n");
          break;
        case "need_verifycode":
          verifyCode = (await terminal.question("请直接在此终端输入手机显示的配对数字：")).trim();
          break;
        case "scaned_but_redirect":
          if (status.redirect_host) pollingBase = normalizeApiBase(status.redirect_host, pollingBase);
          break;
        case "confirmed": {
          if (!status.bot_token || !status.ilink_bot_id || !status.ilink_user_id) {
            throw new Error("WeChat confirmed login but omitted required credentials");
          }
          const credentials = {
            token: status.bot_token,
            accountId: status.ilink_bot_id,
            userId: status.ilink_user_id,
            baseUrl: normalizeApiBase(status.baseurl, pollingBase),
            savedAt: new Date().toISOString(),
          };
          writePrivateJson(config.credentialsPath, credentials);
          writePrivateJson(config.syncCursorPath, { get_updates_buf: "" });
          output.write(`LOGIN_OK account=${credentials.accountId}\n`);
          return credentials;
        }
        case "binded_redirect":
          throw new Error("This WeChat bot is already bound elsewhere; unbind it there before retrying");
        case "expired":
        case "verify_code_blocked":
          qr = await createLoginQr(config.wechatApiBase, localTokens);
          await QRCode.toFile(config.qrPngPath, qr.qrcode_img_content, { width: 640, margin: 3 });
          output.write(`二维码已刷新：${config.qrPngPath}\n`);
          verifyCode = "";
          pollingBase = config.wechatApiBase;
          break;
        default:
          output.write(`等待微信确认：${status?.status || "unknown"}\n`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error("QR login timed out");
  } finally {
    terminal.close();
  }
}
