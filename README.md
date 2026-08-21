# WeChat AI Bridge

[简体中文](docs/README.zh-CN.md) · [Architecture](docs/ARCHITECTURE.md) · [Deployment](docs/DEPLOYMENT.md) · [Security](SECURITY.md)

An experimental, self-hosted bridge that gives a dedicated personal WeChat account automatic AI replies without placing an OpenAI API key in the service.

- Direct messages can reply automatically.
- New group chats inherit a safe default: reply only after a native WeChat mention.
- Selected groups can be set to reply to every message, mention-only, or disabled.
- When a Mac is online, replies prefer a local Qwen model through Ollama.
- When the Mac is offline, the bridge can fall back to the official Codex CLI signed in with a ChatGPT account.
- Reminders survive restarts, and cloud-to-Mac history sync is encrypted.

> [!WARNING]
> This is not an official WeChat or OpenAI integration. Desktop-client automation can break after a WeChat update and may expose the account to restrictions. Use a dedicated secondary WeChat account, keep the service private, and test with a small allowlist first.

## How it works

```text
WeChat desktop in a private container
             │ loopback API
             ▼
       WeChat AI Bridge
          │       │
 Mac online│       │Mac offline
          ▼       ▼
 local Qwen     Codex CLI
  (Ollama)   (ChatGPT sign-in)
          │       │
          └── reply policy ──► WeChat
```

The bridge keeps all service ports on loopback. An SSH tunnel connects the cloud host to the Mac only while the Mac is online. See [the architecture document](docs/ARCHITECTURE.md) for the trust boundaries and data flow.

## Safety defaults

| Area | Default |
| --- | --- |
| Direct messages | `open`, except official/service sessions |
| New groups | `mention-only` |
| Group overrides | Immutable `...@chatroom` IDs |
| Sender allowlist | Empty means all contacts/members |
| Remote context | Last triggering user message only |
| Codex execution | Ephemeral, read-only sandbox, no shell/browser/apps/plugins |
| Network listeners | Loopback only |
| Emergency stop | Create the configured `PAUSE` file |

Group lists must be disjoint. Ambiguous chat IDs, native-mention state, sender identity, login state, or composer state fail closed rather than sending a reply.

## Requirements

- macOS with Node.js 22+, Docker-compatible runtime, and Ollama
- a dedicated personal WeChat account
- a compatible external `agent-wechat` container image
- optional Linux host with Docker Compose for 24/7 WeChat presence
- optional ChatGPT plan with Codex access for the Mac-off fallback

The project pins the tested `agent-wechat` image by digest. That image is external and is **not** redistributed by this repository. Review [Third-Party Notices](THIRD_PARTY_NOTICES.md) before use.

## Quick start on a Mac

```bash
git clone https://github.com/citrus-13/wechat-ai-bridge.git
cd wechat-ai-bridge
npm ci
npm run init
ollama pull qwen3.5:9b-mlx
bash deploy/start-agent-wechat-local.sh
```

Open `http://127.0.0.1:6174/vnc/`, enter the token stored under `~/Library/Application Support/WeChatAIBridge/agent-wechat-token`, and sign in with the dedicated WeChat account.

Then prepare the optional Codex fallback and verify the environment:

```bash
npm run prepare-local-codex
npx codex login
npm run doctor
npm test
```

Install the two macOS background services only after the checks pass:

```bash
bash deploy/install-mac-local.sh
```

The installer copies a private runtime into `~/Library/Application Support/WeChatAIBridge/runtime` and registers the generic LaunchAgent labels `io.github.wechat-ai-bridge.local` and `io.github.wechat-ai-bridge.agent`.

For a Linux host and persistent WeChat login, follow [Deployment](docs/DEPLOYMENT.md).

## Reply policies

```dotenv
WECHAT_DM_POLICY=open
WECHAT_GROUP_DEFAULT_MODE=mention-only
WECHAT_GROUP_ALL_REPLY_CHAT_IDS=
WECHAT_GROUP_MENTION_ONLY_CHAT_IDS=
WECHAT_GROUP_DISABLED_CHAT_IDS=
WECHAT_ALLOWED_SENDERS=
```

- `open` direct-message mode covers real contacts; service and official-account sessions are excluded.
- `mention-only` requires both WeChat's native mention metadata and the configured AI display name in the message.
- `all` replies to ordinary messages in that group.
- `disabled` advances the cursor without building a future reply backlog.
- Newly discovered groups automatically inherit `WECHAT_GROUP_DEFAULT_MODE`; no per-group setup is required unless an override is wanted.

The bridge isolates every direct chat and group in its own hashed conversation scope. On first discovery it processes only the unread tail, not the entire historical backlog.

## Model routing

Normal messages prefer local Qwen whenever the Mac route is healthy. Prefixes select a Codex tier only when the fallback route is used:

```text
/luna quick question
/terra deep comparison of these options
/sol highest-effort analysis of this long-term decision
```

Model aliases and access depend on the signed-in account and current Codex release. They are configuration values, not compatibility promises.

## Accounts, limits, and cost

This repository intentionally does not configure OpenAI API, Vercel AI Gateway, or GitHub Models credentials. The fallback uses `codex login` with ChatGPT authentication. A ChatGPT subscription is not the same thing as a free or unlimited service: plan availability, limits, and acceptable-use terms still apply. See the official [Codex authentication documentation](https://developers.openai.com/codex/auth) and verify that your deployment complies with the terms attached to your account.

The authors do not operate a hosted service and cannot see or pay your cloud, ChatGPT, network, or electricity costs.

## Privacy and operations

- `.env`, OAuth state, tokens, SSH keys, chat databases, screenshots, and cloud data are ignored and checked before packaging.
- Codex receives only the triggering user message by default (`CLOUD_ALLOW_REMOTE_CONTEXT=false`).
- Codex runs with `--ephemeral`, a read-only sandbox, no approvals, and nonessential tool features disabled.
- Cloud sync and pending reminders use AES-256-GCM payload encryption; acknowledged sync records are removed.
- The WeChat container still holds client login state and message data. Host-disk encryption is not end-to-end encryption.
- Normal container or service restarts preserve login data; do not rotate or delete the token/data volumes unless recovery requires it.

Read [Security](SECURITY.md) before exposing any host, and never publish the VNC or bridge ports to the internet.

## Development

```bash
npm ci
npm run check
npm audit --omit=dev
npm pack --dry-run
```

The test suite covers chat pagination, mention enforcement, group policy inheritance, rate limiting, Codex prompt isolation, encryption, storage, reminders, local model routing, and web-search parsing.

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Original bridge code is released under the [MIT License](LICENSE). Third-party runtimes, models, account services, and trademarks remain under their own terms. This project is independent of Tencent, WeChat, OpenAI, Alibaba, Ollama, and the `agent-wechat` maintainers.
