import crypto from "node:crypto";

const APP_ID = "bot";
// Keep this wire-level client version aligned with Tencent's current
// openclaw-weixin package. The backend can issue a QR for older values while
// the mobile client still rejects that QR as expired.
const ILINK_CLIENT_VERSION = "2.4.6";
const CLIENT_VERSION = String(
  ILINK_CLIENT_VERSION.split(".").reduce(
    (encoded, part, index) => encoded | ((Number.parseInt(part, 10) & 0xff) << (16 - index * 8)),
    0,
  ),
);
const BOT_AGENT = "WeChatAIBridge/0.1.0";

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "https://ilinkai.weixin.qq.com";
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withScheme.endsWith("/") ? withScheme : `${withScheme}/`;
}

function randomWechatUin() {
  const value = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value), "utf8").toString("base64");
}

function commonHeaders() {
  return {
    "iLink-App-Id": APP_ID,
    "iLink-App-ClientVersion": CLIENT_VERSION,
  };
}

function postHeaders(token) {
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    ...commonHeaders(),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function requestJson({ baseUrl, endpoint, method = "POST", token, body, timeoutMs = 15_000, signal }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const url = new URL(endpoint, normalizeBaseUrl(baseUrl));
    const response = await fetch(url, {
      method,
      headers: method === "GET" ? commonHeaders() : postHeaders(token),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${endpoint} ${response.status}: ${text.slice(0, 400)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function baseInfo() {
  return { channel_version: "0.1.0", bot_agent: BOT_AGENT };
}

export async function createLoginQr(baseUrl, localTokens = []) {
  return requestJson({
    baseUrl,
    endpoint: "ilink/bot/get_bot_qrcode?bot_type=3",
    body: { local_token_list: localTokens.slice(-10) },
  });
}

export async function pollLoginQr(baseUrl, qrcode, verifyCode) {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
  try {
    return await requestJson({ baseUrl, endpoint, method: "GET", timeoutMs: 35_000 });
  } catch (error) {
    if (error?.name === "AbortError") return { status: "wait" };
    throw error;
  }
}

export async function getUpdates({ baseUrl, token, cursor, timeoutMs = 35_000, signal }) {
  try {
    return await requestJson({
      baseUrl,
      endpoint: "ilink/bot/getupdates",
      token,
      body: { get_updates_buf: cursor || "", base_info: baseInfo() },
      timeoutMs,
      signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") return { ret: 0, msgs: [], get_updates_buf: cursor || "" };
    throw error;
  }
}

export async function sendText({ baseUrl, token, toUserId, contextToken, text }) {
  const clientId = `wechat-ai-bridge-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
  const payload = await requestJson({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    token,
    body: {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text } }],
        context_token: contextToken || undefined,
      },
      base_info: baseInfo(),
    },
  });
  if (payload?.ret && payload.ret !== 0) {
    throw new Error(`sendmessage ret=${payload.ret}: ${payload.errmsg || "unknown error"}`);
  }
  return clientId;
}

export async function notifyLifecycle({ baseUrl, token, action }) {
  const endpoint = action === "start" ? "ilink/bot/msg/notifystart" : "ilink/bot/msg/notifystop";
  return requestJson({ baseUrl, endpoint, token, body: { base_info: baseInfo() }, timeoutMs: 10_000 });
}

export function normalizeApiBase(value, fallback) {
  return normalizeBaseUrl(value || fallback).slice(0, -1);
}
