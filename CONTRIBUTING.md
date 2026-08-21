# Contributing

Thanks for helping improve WeChat AI Bridge.

## Development

Requirements: Node.js 22+, npm, and Git.

```bash
npm ci
npm run check
```

Keep changes focused and include tests for message routing, access control, encryption, reminders, or model selection behavior. New network listeners must bind to loopback by default. New model providers must be opt-in and must not silently enable metered billing.

## Pull requests

- Explain the user-visible behavior and failure mode.
- Include test evidence.
- Do not submit credentials, real chat IDs, private messages, QR codes, screenshots with personal data, or copied upstream source without a compatible license.
- Preserve fail-closed behavior when chat identity, sender identity, mention state, or login state is ambiguous.

Use GitHub security advisories for vulnerabilities; see `SECURITY.md`.
