# Security policy

## Reporting a vulnerability

Please use a private GitHub security advisory instead of opening a public issue:

https://github.com/citrus-13/wechat-ai-bridge/security/advisories/new

Include the affected version, deployment mode, impact, and a minimal reproduction. Do not include real WeChat messages, contact IDs, QR codes, access tokens, `auth.json`, or cloud credentials.

## Security boundary

This project is designed for a dedicated secondary WeChat account and a private, self-hosted environment. It is not a multi-tenant service and must not be exposed as a public Codex execution endpoint.

- Ports `6174`, `43110`, and `43111` bind to loopback by default. Keep them private and use SSH tunnels for remote access.
- Treat the agent-wechat token, `BRIDGE_SHARED_SECRET`, `SYNC_KEY`, and every file under `CODEX_HOME` as passwords.
- ChatGPT-authenticated Codex credentials may be stored in `auth.json`. Never commit, paste, log, or share that file.
- Keep group replies in `mention-only` mode unless every member expects automatic replies.
- Use sender allowlists and rate limits for accounts that receive messages from untrusted contacts.
- The bridge invokes Codex with an ephemeral session, a read-only sandbox, no approvals, and local computer/file tools disabled. Do not weaken these defaults without a separate threat review.
- Use the `PAUSE` file to stop new replies immediately during an incident.

WeChat desktop automation and upstream UI behavior can change without notice. A successful test run does not remove the risk of account restrictions, missed messages, or duplicate delivery.
