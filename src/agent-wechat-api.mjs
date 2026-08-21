function normalizeBaseUrl(value) {
  const raw = String(value || "http://127.0.0.1:6174").trim();
  const withScheme = /^https?:\/\//iu.test(raw) ? raw : `http://${raw}`;
  return withScheme.replace(/\/+$/u, "");
}

function query(params) {
  const values = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") values.set(key, String(value));
  }
  const encoded = values.toString();
  return encoded ? `?${encoded}` : "";
}

export class AgentWechatClient {
  constructor({ baseUrl, token, fetchImpl = fetch, timeoutMs = 30_000 }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.token = String(token || "").trim();
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(path, { method = "GET", body, timeoutMs = this.timeoutMs } = {}) {
    if (!this.token) throw new Error("AGENT_WECHAT_TOKEN is required");
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`agent-wechat ${method} ${path} ${response.status}: ${text.slice(0, 400)}`);
    return text ? JSON.parse(text) : null;
  }

  authStatus() {
    return this.request("/api/status/auth");
  }

  loginSnapshot() {
    return this.request("/api/status/login", { method: "POST" });
  }

  loginSubscribe({ timeoutMs = 8 * 60_000, newAccount = false, onEvent = () => {} } = {}) {
    const url = new URL(this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/api/ws/login";
    url.search = "";
    url.searchParams.set("timeoutMs", String(timeoutMs));
    url.searchParams.set("newAccount", String(newAccount));
    url.searchParams.set("token", this.token);

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("agent-wechat login timed out"));
      }, timeoutMs + 5000);
      let settled = false;
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
        socket.close();
      };
      socket.addEventListener("message", (message) => {
        try {
          const event = JSON.parse(String(message.data));
          onEvent(event);
          if (event.type === "login_success") finish(() => resolve(event));
          else if (event.type === "login_timeout") finish(() => reject(new Error("agent-wechat login timed out")));
          else if (event.type === "error") finish(() => reject(new Error(event.message || "agent-wechat login failed")));
        } catch (error) {
          finish(() => reject(error));
        }
      });
      socket.addEventListener("error", () => finish(() => reject(new Error("agent-wechat login WebSocket failed"))));
      socket.addEventListener("close", () => {
        if (!settled) finish(() => reject(new Error("agent-wechat login WebSocket closed unexpectedly")));
      });
    });
  }

  listChats(limit = 100, offset = 0) {
    return this.request(`/api/chats${query({ limit, offset })}`);
  }

  getChat(chatId) {
    return this.request(`/api/chats/${encodeURIComponent(chatId)}`);
  }

  findChats(name) {
    return this.request(`/api/chats/find${query({ name })}`);
  }

  openChat(chatId, clearUnreads = true) {
    return this.request(`/api/chats/${encodeURIComponent(chatId)}/open${query({ clearUnreads })}`, {
      method: "POST",
    });
  }

  listMessages(chatId, limit = 100, offset = 0) {
    return this.request(`/api/messages/${encodeURIComponent(chatId)}${query({ limit, offset })}`);
  }

  async sendText(chatId, text) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await this.request("/api/messages/send", {
        method: "POST",
        body: { chatId, text },
        timeoutMs: 60_000,
      });
      if (result?.success) return result;
      if (attempt === 0 && result?.error === "No action selected") {
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      const error = new Error(`agent-wechat send failed: ${result?.error || "unknown error"}`);
      // The API returned an explicit negative result, so retrying cannot
      // duplicate a message that WeChat may already have accepted.
      error.definitive = true;
      throw error;
    }
    throw new Error("agent-wechat send failed after retry");
  }
}
