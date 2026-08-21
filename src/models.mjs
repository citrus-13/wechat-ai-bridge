import { callCodexSubscription } from "./codex-model.mjs";

const SYSTEM_PROMPT = "你是用户的私人微信 AI 助手。使用简体中文，回答准确、克制、清晰。上下文仅供参考，必须回答消息列表中的最后一条用户消息，不要转而回答较早的问题。不要声称执行了未实际执行的操作；遇到最新事实应联网核实。";

async function fetchJson(url, options, timeoutMs = 120_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`model endpoint ${response.status}: ${text.slice(0, 400)}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

export async function callLocalOllama(config, history, { webContext = "" } = {}) {
  const payload = await fetchJson(`${config.local.ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.local.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...(webContext ? [{ role: "system", content: webContext }] : []),
        ...history,
      ],
      stream: false,
      think: false,
      keep_alive: config.local.keepAlive ?? "5m",
      options: {
        num_ctx: 8192,
        temperature: 0.3,
      },
    }),
  });
  const content = payload?.message?.content?.trim();
  if (!content) throw new Error("local Ollama returned an empty response");
  return content;
}

function cleanHistory(history) {
  return (Array.isArray(history) ? history : [])
    .filter((message) => message?.role === "user" || message?.role === "assistant")
    .map((message) => ({ role: message.role, content: String(message.content || "") }))
    .filter((message) => message.content);
}

function privateRemoteHistory(config, history) {
  const cleaned = cleanHistory(history);
  return config.cloud.allowRemoteContext
    ? cleaned
    : cleaned.filter((message) => message.role === "user").slice(-1);
}

export async function callCodexModel(config, history) {
  const result = await callCodexSubscription(config, privateRemoteHistory(config, cleanHistory(history)), SYSTEM_PROMPT);
  return { reply: result.content, style: "codex", ...result };
}

export async function checkOllama(config) {
  const response = await fetch(`${config.local.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Ollama health check failed: ${response.status}`);
  const payload = await response.json();
  const names = (payload.models || []).map((model) => model.name || model.model);
  return { ok: names.includes(config.local.model), models: names };
}
