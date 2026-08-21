#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkCodexLogin } from "./codex-model.mjs";
import { assertSecret, loadConfig } from "./config.mjs";
import { AgentWechatClient } from "./agent-wechat-api.mjs";
import { loginWithAgentWechat } from "./agent-wechat-login.mjs";
import { startAgentWechatService } from "./agent-wechat-service.mjs";
import { startCloudService } from "./cloud-service.mjs";
import { startDesktopService } from "./desktop-service.mjs";
import { loginWithQr } from "./login.mjs";
import { startLocalService, syncOnce } from "./local-service.mjs";
import { checkOllama } from "./models.mjs";
import { migrateLegacyGroupHistory, openHistoryStore } from "./storage.mjs";
import { ensurePrivateDir } from "./util.mjs";
import { WeChatDesktopDriver } from "./wechat-desktop.mjs";

const HELP = `wechat-ai-bridge <command>

Commands:
  init                    Create a private local configuration and secrets
  doctor                  Check local model, bridge, WeChat, and Codex status
  configure-group NAME    Lock a group by its exact immutable chat ID
  prepare-cloud           Generate .env.cloud from the private local config
  prepare-local-codex     Configure ChatGPT-authenticated Codex fallback
  login                   Start the selected WeChat login flow
  local                   Run the localhost-only Qwen and history service
  cloud                   Run message polling, routing, reminders, and sync
  sync                    Import encrypted cloud history into local storage
  ui-check                Check the legacy desktop UI integration
  rotate-agent-token      Rotate the agent-wechat access token (requires login)
  help                    Show this help
`;

function ensureAgentWechatToken(dataDir, { rotate = false } = {}) {
  const agentTokenPath = path.join(dataDir, "agent-wechat-token");
  if (rotate || !fs.existsSync(agentTokenPath)) {
    fs.writeFileSync(agentTokenPath, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
    console.log(`${rotate ? "ROTATED" : "CREATED"} ${agentTokenPath}`);
  } else {
    fs.chmodSync(agentTokenPath, 0o600);
    console.log(`EXISTS ${agentTokenPath}`);
  }
  return agentTokenPath;
}

function initialize() {
  const dataDir = path.join(os.homedir(), "Library", "Application Support", "WeChatAIBridge");
  ensurePrivateDir(dataDir);
  ensureAgentWechatToken(dataDir);

  const envPath = path.resolve(".env");
  if (fs.existsSync(envPath)) {
    console.log(`EXISTS ${envPath}`);
    return;
  }
  const sharedSecret = crypto.randomBytes(36).toString("base64url");
  const syncKey = crypto.randomBytes(32).toString("base64");
  const content = [
    `DATA_DIR=${JSON.stringify(dataDir)}`,
    "LOCAL_BIND_HOST=127.0.0.1",
    "LOCAL_PORT=43110",
    "LOCAL_OLLAMA_URL=http://127.0.0.1:11434",
    "LOCAL_OLLAMA_MODEL=qwen3.5:9b-mlx",
    "LOCAL_OLLAMA_KEEP_ALIVE=5m",
    "LOCAL_CONTEXT_MESSAGES=40",
    "LOCAL_CONTEXT_CHARS=24000",
    "LOCAL_WEB_SEARCH_ENABLED=true",
    "LOCAL_WEB_SEARCH_BING_RSS_URL=https://www.bing.com/search",
    "LOCAL_WEB_SEARCH_WEATHER_URL=https://wttr.in",
    "LOCAL_WEB_SEARCH_TIMEOUT_MS=12000",
    "LOCAL_WEB_SEARCH_MAX_RESULTS=5",
    "LOCAL_WEB_SEARCH_MAX_CHARS=6000",
    `BRIDGE_SHARED_SECRET=${sharedSecret}`,
    `SYNC_KEY=${syncKey}`,
    "CLOUD_SYNC_URL=",
    "",
  ].join("\n");
  fs.writeFileSync(envPath, content, { mode: 0o600 });
  console.log(`CREATED ${envPath}`);
}

function upsertEnvFile(filePath, updates) {
  const current = fs.readFileSync(filePath, "utf8");
  const remaining = new Map(Object.entries(updates));
  const lines = current.split(/\r?\n/u).map((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=/u.exec(line);
    if (!match || !remaining.has(match[1])) return line;
    const value = remaining.get(match[1]);
    remaining.delete(match[1]);
    return `${match[1]}=${JSON.stringify(value)}`;
  });
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  for (const [key, value] of remaining) lines.push(`${key}=${JSON.stringify(value)}`);
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function envAssignment(name, value) {
  return `${name}=${JSON.stringify(String(value ?? ""))}`;
}

function prepareCloudEnv(config) {
  assertSecret("BRIDGE_SHARED_SECRET", config.bridgeSecret);
  if (!config.syncKey) throw new Error("SYNC_KEY is required");
  const envPath = path.resolve(".env.cloud");
  const values = {
    DATA_DIR: "/data",
    CLOUD_BIND_HOST: "127.0.0.1",
    CLOUD_PORT: "43111",
    BRIDGE_SHARED_SECRET: config.bridgeSecret,
    SYNC_KEY: config.syncKey,
    MAC_BRIDGE_URL: `http://127.0.0.1:${config.local.port}`,
    CLOUD_MODEL_STYLE: "codex",
    CLOUD_CODEX_BIN: "codex",
    CLOUD_CODEX_HOME: "/codex-auth",
    CLOUD_CODEX_TIMEOUT_MS: "120000",
    CLOUD_CODEX_MAX_OUTPUT_CHARS: "6000",
    CLOUD_CODEX_MODEL_LUNA: "gpt-5.6-luna",
    CLOUD_CODEX_MODEL_TERRA: "gpt-5.6-terra",
    CLOUD_CODEX_MODEL_SOL: "gpt-5.6-sol",
    CLOUD_CODEX_REASONING_LUNA: "low",
    CLOUD_CODEX_REASONING_TERRA: "high",
    CLOUD_CODEX_REASONING_SOL: "xhigh",
    CLOUD_ALLOW_REMOTE_CONTEXT: "false",
    // Subscription-only mode has no API-key model provider fallback.
    REMINDER_TIMEZONE: config.reminders.timeZone,
    WECHAT_MODE: "agent-wechat",
    AGENT_WECHAT_URL: "http://127.0.0.1:6174",
    AGENT_WECHAT_TOKEN_FILE: "/run/secrets/agent-wechat-token",
    WECHAT_TARGET_GROUP: config.wechat.agent.targetGroup,
    WECHAT_TARGET_CHAT_ID: config.wechat.agent.targetChatId,
    WECHAT_AI_NAME: config.wechat.agent.aiName,
    WECHAT_ALLOWED_SENDERS: config.wechat.agent.allowedSenders.join(","),
    WECHAT_DM_POLICY: config.wechat.agent.dmPolicy,
    WECHAT_GROUP_DEFAULT_MODE: config.wechat.agent.groupDefaultMode,
    WECHAT_GROUP_ALL_REPLY_CHAT_IDS: config.wechat.agent.groupAllReplyChatIds.join(","),
    WECHAT_GROUP_MENTION_ONLY_CHAT_IDS: config.wechat.agent.groupMentionOnlyChatIds.join(","),
    WECHAT_GROUP_DISABLED_CHAT_IDS: config.wechat.agent.groupDisabledChatIds.join(","),
    WECHAT_CHAT_PAGE_SIZE: String(config.wechat.agent.chatPageSize),
    WECHAT_MAX_CHATS: String(config.wechat.agent.maxChats),
    WECHAT_POLL_INTERVAL_MS: String(config.wechat.agent.pollIntervalMs),
    WECHAT_POLL_PAGE_SIZE: String(config.wechat.agent.pollPageSize),
    WECHAT_BACKFILL_PAGE_SIZE: String(config.wechat.agent.backfillPageSize),
    WECHAT_CONTEXT_MESSAGES: String(config.wechat.agent.contextMessages),
    WECHAT_CONTEXT_CHARS: String(config.wechat.agent.contextChars),
    WECHAT_MAX_REPLIES_PER_MINUTE: String(config.wechat.agent.maxRepliesPerMinute),
    WECHAT_SENDER_COOLDOWN_SECONDS: String(config.wechat.agent.senderCooldownSeconds),
    WECHAT_MAX_MESSAGE_CHARS: String(config.wechat.agent.maxMessageChars),
    WECHAT_PAUSE_FILE: "/data/PAUSE",
  };
  fs.writeFileSync(envPath, `${Object.entries(values).map(([name, value]) => envAssignment(name, value)).join("\n")}\n`, {
    mode: 0o600,
  });
  fs.chmodSync(envPath, 0o600);
  console.log(`CLOUD_CONFIG_READY ${envPath} mode=0600`);
}

function prepareLocalCodex() {
  const envPath = fs.realpathSync(path.resolve(".env"));
  const bundledCodex = "/Applications/ChatGPT.app/Contents/Resources/codex";
  const codexBin = fs.existsSync(bundledCodex) ? bundledCodex : "codex";
  upsertEnvFile(envPath, {
    CLOUD_MODEL_STYLE: "codex",
    CLOUD_CODEX_BIN: codexBin,
    CLOUD_CODEX_HOME: path.join(os.homedir(), ".codex"),
    CLOUD_CODEX_TIMEOUT_MS: "120000",
    CLOUD_CODEX_MAX_OUTPUT_CHARS: "6000",
    CLOUD_CODEX_MODEL_LUNA: "gpt-5.6-luna",
    CLOUD_CODEX_MODEL_TERRA: "gpt-5.6-terra",
    CLOUD_CODEX_MODEL_SOL: "gpt-5.6-sol",
    CLOUD_CODEX_REASONING_LUNA: "low",
    CLOUD_CODEX_REASONING_TERRA: "high",
    CLOUD_CODEX_REASONING_SOL: "xhigh",
    CLOUD_ALLOW_REMOTE_CONTEXT: "false",
    LOCAL_WEB_SEARCH_ENABLED: "true",
    LOCAL_OLLAMA_KEEP_ALIVE: "5m",
    LOCAL_WEB_SEARCH_BING_RSS_URL: "https://www.bing.com/search",
    LOCAL_WEB_SEARCH_WEATHER_URL: "https://wttr.in",
    LOCAL_WEB_SEARCH_TIMEOUT_MS: "12000",
    LOCAL_WEB_SEARCH_MAX_RESULTS: "5",
    LOCAL_WEB_SEARCH_MAX_CHARS: "6000",
  });
  console.log(`LOCAL_CODEX_READY ${envPath} mode=0600`);
}

async function configureAgentGroup(groupName, aiName) {
  if (!groupName) throw new Error("Usage: configure-group <exact-group-name> [ai-display-name]");
  const config = loadConfig();
  const client = new AgentWechatClient({
    baseUrl: config.wechat.agent.baseUrl,
    token: config.wechat.agent.token,
    timeoutMs: 60_000,
  });
  const matches = (await client.findChats(groupName))
    .filter((chat) => chat.name === groupName)
    .filter((chat) => chat.isGroup || String(chat.username || chat.id).includes("@chatroom"));
  if (matches.length !== 1) {
    throw new Error(`expected exactly one group named ${groupName}; found ${matches.length}`);
  }
  const chatId = String(matches[0].username || matches[0].id);
  const envPath = fs.realpathSync(path.resolve(".env"));
  upsertEnvFile(envPath, {
    WECHAT_MODE: "agent-wechat",
    AGENT_WECHAT_URL: config.wechat.agent.baseUrl,
    WECHAT_TARGET_GROUP: groupName,
    WECHAT_TARGET_CHAT_ID: chatId,
    WECHAT_AI_NAME: aiName || config.wechat.agent.aiName,
    WECHAT_ALLOWED_SENDERS: "",
    MAC_BRIDGE_URL: `http://127.0.0.1:${config.local.port}`,
    CLOUD_BIND_HOST: "127.0.0.1",
    CLOUD_PORT: "43111",
    CLOUD_SYNC_URL: "http://127.0.0.1:43111",
  });
  const idHash = crypto.createHash("sha256").update(chatId).digest("hex").slice(0, 12);
  console.log(`GROUP_CONFIGURED name=${groupName} idHash=${idHash}`);
}

async function doctor(config) {
  const results = [];
  results.push(["Node.js >=22", Number.parseInt(process.versions.node, 10) >= 22]);
  results.push(["bridge secret", Buffer.byteLength(config.bridgeSecret) >= 32]);
  try {
    Buffer.from(config.syncKey, "base64").length === 32 || (() => { throw new Error(); })();
    results.push(["sync encryption key", true]);
  } catch {
    results.push(["sync encryption key", false]);
  }
  results.push(["agent-wechat token", Boolean(config.wechat.agent.token)]);
  if (config.wechat.agent.token) {
    try {
      const status = await new AgentWechatClient({
        baseUrl: config.wechat.agent.baseUrl,
        token: config.wechat.agent.token,
        timeoutMs: 5000,
      }).authStatus();
      results.push(["agent-wechat login", status?.status === "logged_in"]);
    } catch {
      results.push(["agent-wechat login", false]);
    }
  }
  try {
    const status = await checkOllama(config);
    results.push([`Ollama model ${config.local.model}`, status.ok]);
  } catch {
    results.push([`Ollama model ${config.local.model}`, false]);
  }
  if (config.cloud.modelStyle === "codex") {
    try {
      await checkCodexLogin(config);
      results.push(["ChatGPT OAuth for cloud Codex", true]);
    } catch {
      results.push(["ChatGPT OAuth for cloud Codex", false]);
    }
    results.push(["cloud fallback configured", Boolean(
      config.cloud.codexModels.luna
      && config.cloud.codexModels.terra
      && config.cloud.codexModels.sol,
    )]);
  } else {
    results.push(["cloud fallback configured", false]);
  }
  results.push(["cloud sync configured", Boolean(config.cloud.syncUrl)]);
  for (const [name, ok] of results) console.log(`${ok ? "OK" : "MISSING"} ${name}`);
  if (results.some(([, ok]) => !ok)) process.exitCode = 1;
}

const command = process.argv[2] || "doctor";
if (command === "help" || command === "--help" || command === "-h") {
  process.stdout.write(HELP);
} else if (command === "--version" || command === "-v") {
  process.stdout.write(`${loadConfig().version}\n`);
} else if (command === "init") {
  initialize();
} else if (command === "rotate-agent-token") {
  const dataDir = path.join(os.homedir(), "Library", "Application Support", "WeChatAIBridge");
  ensurePrivateDir(dataDir);
  ensureAgentWechatToken(dataDir, { rotate: true });
} else if (command === "configure-group") {
  await configureAgentGroup(String(process.argv[3] || "").trim(), String(process.argv[4] || "").trim());
} else if (command === "prepare-cloud") {
  prepareCloudEnv(loadConfig());
} else if (command === "prepare-local-codex") {
  prepareLocalCodex();
} else {
  const config = loadConfig();
  if (command === "login") {
    if (config.wechat.mode === "agent-wechat") await loginWithAgentWechat(config);
    else await loginWithQr(config);
  } else if (command === "doctor") {
    await doctor(config);
  } else if (command === "local") {
    await startLocalService(config);
  } else if (command === "cloud") {
    if (config.cloud.modelStyle !== "codex") {
      throw new Error("subscription-only cloud mode requires CLOUD_MODEL_STYLE=codex");
    }
    await checkCodexLogin(config);
    if (config.wechat.mode === "agent-wechat") await startAgentWechatService(config);
    else if (config.wechat.mode === "desktop") await startDesktopService(config);
    else if (config.wechat.mode === "ilink") await startCloudService(config);
    else throw new Error(`Unsupported WECHAT_MODE: ${config.wechat.mode}`);
  } else if (command === "sync") {
    migrateLegacyGroupHistory({
      legacyPath: config.legacyDbPath,
      targetPath: config.dbPath,
      conversationId: config.memory.conversationId,
    });
    const store = openHistoryStore(config.dbPath);
    try {
      const result = await syncOnce(config, store);
      console.log(`IMPORTED ${result.imported}`);
    } finally {
      store.close();
    }
  } else if (command === "ui-check") {
    console.log(JSON.stringify(await new WeChatDesktopDriver(config).check(), null, 2));
  } else {
    console.error(`Unknown command: ${command}`);
    process.exitCode = 2;
  }
}
