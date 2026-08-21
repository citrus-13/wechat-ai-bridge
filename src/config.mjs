import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DATA_DIR = path.join(os.homedir(), "Library", "Application Support", "WeChatAIBridge");

function integerEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function cleanUrl(value, fallback = "") {
  const chosen = (value || fallback).trim();
  return chosen.endsWith("/") ? chosen.slice(0, -1) : chosen;
}

function listEnv(name) {
  return (process.env[name] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function enumEnv(name, fallback, allowed) {
  const value = String(process.env[name] || fallback).trim().toLowerCase();
  if (!allowed.includes(value)) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function assertDisjointChatLists(entries) {
  const owners = new Map();
  for (const [name, values] of entries) {
    for (const value of values) {
      const previous = owners.get(value);
      if (previous) throw new Error(`${value} appears in both ${previous} and ${name}`);
      owners.set(value, name);
    }
  }
}

function booleanEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  if (/^(1|true|yes|on)$/iu.test(raw.trim())) return true;
  if (/^(0|false|no|off)$/iu.test(raw.trim())) return false;
  throw new Error(`${name} must be true or false`);
}

function secretFromEnvOrFile(envName, fileName, fallbackPath = "") {
  const direct = String(process.env[envName] || "").trim();
  if (direct) return direct;
  const filePath = String(process.env[fileName] || fallbackPath).trim();
  if (!filePath) return "";
  try {
    return fs.readFileSync(path.resolve(filePath), "utf8").trim();
  } catch (error) {
    throw new Error(`${fileName} could not be read: ${error.message}`);
  }
}

const DEFAULT_UI_DRIVER = fileURLToPath(new URL("../scripts/wechat_ui_driver.py", import.meta.url));

export function loadConfig() {
  const dataDir = path.resolve(process.env.DATA_DIR || DEFAULT_DATA_DIR);
  const targetChatId = String(process.env.WECHAT_TARGET_CHAT_ID || "").trim();
  const groupMemoryScope = targetChatId
    ? crypto.createHash("sha256").update(targetChatId).digest("hex").slice(0, 24)
    : "unconfigured";
  const groupAllReplyChatIds = listEnv("WECHAT_GROUP_ALL_REPLY_CHAT_IDS");
  const groupMentionOnlyChatIds = listEnv("WECHAT_GROUP_MENTION_ONLY_CHAT_IDS");
  const groupDisabledChatIds = listEnv("WECHAT_GROUP_DISABLED_CHAT_IDS");
  assertDisjointChatLists([
    ["WECHAT_GROUP_ALL_REPLY_CHAT_IDS", groupAllReplyChatIds],
    ["WECHAT_GROUP_MENTION_ONLY_CHAT_IDS", groupMentionOnlyChatIds],
    ["WECHAT_GROUP_DISABLED_CHAT_IDS", groupDisabledChatIds],
  ]);
  return {
    version: "0.3.0",
    dataDir,
    dbPath: path.join(dataDir, "group-memory", `${groupMemoryScope}.sqlite3`),
    legacyDbPath: path.join(dataDir, "history.sqlite3"),
    memory: {
      groupScope: targetChatId ? groupMemoryScope : "",
      conversationId: targetChatId ? `wechat-group:${groupMemoryScope}` : "",
    },
    cloudDbPath: path.join(dataDir, "cloud-queue.sqlite3"),
    credentialsPath: path.join(dataDir, "wechat-credentials.json"),
    syncCursorPath: path.join(dataDir, "wechat-sync.json"),
    qrPngPath: path.join(dataDir, "wechat-login.png"),
    wechatApiBase: cleanUrl(process.env.WECHAT_API_BASE, "https://ilinkai.weixin.qq.com"),
    local: {
      bindHost: process.env.LOCAL_BIND_HOST || "127.0.0.1",
      port: integerEnv("LOCAL_PORT", 43110, { min: 1024, max: 65535 }),
      ollamaUrl: cleanUrl(process.env.LOCAL_OLLAMA_URL, "http://127.0.0.1:11434"),
      model: process.env.LOCAL_OLLAMA_MODEL || "qwen3.5:9b-mlx",
      keepAlive: process.env.LOCAL_OLLAMA_KEEP_ALIVE || "5m",
      contextMessages: integerEnv("LOCAL_CONTEXT_MESSAGES", 40, { min: 2, max: 100 }),
      contextChars: integerEnv("LOCAL_CONTEXT_CHARS", 24_000, { min: 1000, max: 100_000 }),
      webSearch: {
        enabled: booleanEnv("LOCAL_WEB_SEARCH_ENABLED", true),
        bingRssUrl: cleanUrl(process.env.LOCAL_WEB_SEARCH_BING_RSS_URL, "https://www.bing.com/search"),
        weatherUrl: cleanUrl(process.env.LOCAL_WEB_SEARCH_WEATHER_URL, "https://wttr.in"),
        timeoutMs: integerEnv("LOCAL_WEB_SEARCH_TIMEOUT_MS", 12_000, { min: 3000, max: 30_000 }),
        maxResults: integerEnv("LOCAL_WEB_SEARCH_MAX_RESULTS", 5, { min: 1, max: 10 }),
        maxChars: integerEnv("LOCAL_WEB_SEARCH_MAX_CHARS", 6000, { min: 1000, max: 12_000 }),
      },
    },
    cloud: {
      bindHost: process.env.CLOUD_BIND_HOST || "127.0.0.1",
      port: integerEnv("CLOUD_PORT", 43111, { min: 1024, max: 65535 }),
      macBridgeUrl: cleanUrl(process.env.MAC_BRIDGE_URL),
      syncUrl: cleanUrl(process.env.CLOUD_SYNC_URL),
      modelStyle: (process.env.CLOUD_MODEL_STYLE || "codex").toLowerCase(),
      allowRemoteContext: booleanEnv("CLOUD_ALLOW_REMOTE_CONTEXT", false),
      codexBin: process.env.CLOUD_CODEX_BIN || "codex",
      codexHome: path.resolve(process.env.CLOUD_CODEX_HOME || path.join(dataDir, "codex-auth")),
      codexTimeoutMs: integerEnv("CLOUD_CODEX_TIMEOUT_MS", 120_000, { min: 10_000, max: 600_000 }),
      codexMaxOutputChars: integerEnv("CLOUD_CODEX_MAX_OUTPUT_CHARS", 6000, { min: 100, max: 16_000 }),
      codexModels: {
        luna: process.env.CLOUD_CODEX_MODEL_LUNA || "gpt-5.6-luna",
        terra: process.env.CLOUD_CODEX_MODEL_TERRA || "gpt-5.6-terra",
        sol: process.env.CLOUD_CODEX_MODEL_SOL || "gpt-5.6-sol",
      },
      codexReasoning: {
        luna: process.env.CLOUD_CODEX_REASONING_LUNA || "low",
        terra: process.env.CLOUD_CODEX_REASONING_TERRA || "high",
        sol: process.env.CLOUD_CODEX_REASONING_SOL || "xhigh",
      },
    },
    reminders: {
      timeZone: process.env.REMINDER_TIMEZONE || "Europe/Paris",
    },
    wechat: {
      mode: (process.env.WECHAT_MODE || "agent-wechat").toLowerCase(),
      agent: {
        baseUrl: cleanUrl(process.env.AGENT_WECHAT_URL, "http://127.0.0.1:6174"),
        token: secretFromEnvOrFile(
          "AGENT_WECHAT_TOKEN",
          "AGENT_WECHAT_TOKEN_FILE",
          path.join(dataDir, "agent-wechat-token"),
        ),
        targetGroup: (process.env.WECHAT_TARGET_GROUP || "").trim(),
        targetChatId: (process.env.WECHAT_TARGET_CHAT_ID || "").trim(),
        aiName: (process.env.WECHAT_AI_NAME || "AI").trim(),
        allowedSenders: listEnv("WECHAT_ALLOWED_SENDERS"),
        dmPolicy: enumEnv("WECHAT_DM_POLICY", "disabled", ["open", "disabled"]),
        groupDefaultMode: enumEnv(
          "WECHAT_GROUP_DEFAULT_MODE",
          "mention-only",
          ["all", "mention-only", "disabled"],
        ),
        groupAllReplyChatIds,
        groupMentionOnlyChatIds,
        groupDisabledChatIds,
        chatPageSize: integerEnv("WECHAT_CHAT_PAGE_SIZE", 100, { min: 20, max: 100 }),
        maxChats: integerEnv("WECHAT_MAX_CHATS", 500, { min: 20, max: 2000 }),
        pollIntervalMs: integerEnv("WECHAT_POLL_INTERVAL_MS", 1500, { min: 500, max: 60_000 }),
        pollPageSize: integerEnv("WECHAT_POLL_PAGE_SIZE", 200, { min: 20, max: 1000 }),
        backfillPageSize: integerEnv("WECHAT_BACKFILL_PAGE_SIZE", 500, { min: 50, max: 2000 }),
        contextMessages: integerEnv("WECHAT_CONTEXT_MESSAGES", 80, { min: 2, max: 500 }),
        contextChars: integerEnv("WECHAT_CONTEXT_CHARS", 24_000, { min: 1000, max: 100_000 }),
        maxRepliesPerMinute: integerEnv("WECHAT_MAX_REPLIES_PER_MINUTE", 4, { min: 1, max: 30 }),
        senderCooldownSeconds: integerEnv("WECHAT_SENDER_COOLDOWN_SECONDS", 8, { min: 1, max: 600 }),
        maxMessageChars: integerEnv("WECHAT_MAX_MESSAGE_CHARS", 4000, { min: 100, max: 16_000 }),
        pauseFile: path.resolve(process.env.WECHAT_PAUSE_FILE || path.join(dataDir, "PAUSE")),
      },
      desktop: {
        python: process.env.WECHAT_UI_PYTHON || "/usr/bin/python3",
        driverPath: path.resolve(process.env.WECHAT_UI_DRIVER || DEFAULT_UI_DRIVER),
        display: process.env.WECHAT_DISPLAY || ":99",
        windowTitle: process.env.WECHAT_WINDOW_TITLE || "微信",
        targetGroup: (process.env.WECHAT_TARGET_GROUP || "").trim(),
        aiName: (process.env.WECHAT_AI_NAME || "AI").trim(),
        allowedSenders: listEnv("WECHAT_ALLOWED_SENDERS"),
        pollIntervalMs: integerEnv("WECHAT_POLL_INTERVAL_MS", 4000, { min: 1000, max: 60_000 }),
        maxRepliesPerMinute: integerEnv("WECHAT_MAX_REPLIES_PER_MINUTE", 4, { min: 1, max: 30 }),
        senderCooldownSeconds: integerEnv("WECHAT_SENDER_COOLDOWN_SECONDS", 8, { min: 1, max: 600 }),
        maxMessageChars: integerEnv("WECHAT_MAX_MESSAGE_CHARS", 4000, { min: 100, max: 16_000 }),
        pauseFile: path.resolve(process.env.WECHAT_PAUSE_FILE || path.join(dataDir, "PAUSE")),
        statePath: path.resolve(process.env.WECHAT_UI_STATE || path.join(dataDir, "wechat-ui-state.json")),
        screenshotPath: path.resolve(process.env.WECHAT_UI_SCREENSHOT || path.join(dataDir, "wechat-last.png")),
      },
    },
    bridgeSecret: process.env.BRIDGE_SHARED_SECRET || "",
    syncKey: process.env.SYNC_KEY || "",
  };
}

export function assertSecret(name, value, minimumBytes = 32) {
  if (!value || Buffer.byteLength(value, "utf8") < minimumBytes) {
    throw new Error(`${name} is missing or shorter than ${minimumBytes} bytes; run npm run init`);
  }
}
