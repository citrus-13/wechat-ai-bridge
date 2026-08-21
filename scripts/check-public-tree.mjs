#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const listed = spawnSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root, encoding: "utf8" },
);
if (listed.status !== 0) {
  process.stderr.write(listed.stderr || "git ls-files failed\n");
  process.exit(1);
}

const forbiddenPaths = [
  /^\.env(?:\.cloud)?$/u,
  /(?:^|\/)auth\.json$/u,
  /^deploy\/(?:cloud-data|codex-auth|secrets)(?:\/|$)/u,
  /^deploy\/(?:Dockerfile\.agent-wechat|agent-wechat-.*\.patch|a11y-dump-optimized\.py)$/u,
  /^deploy\/com\.citrus\./u,
];
const forbiddenContent = [
  { name: "personal macOS path", pattern: /\/Users\/citrus(?:\/|\b)/u },
  { name: "known deployment IP", pattern: /\b88\.96\.50\.86\b/u },
  { name: "Oracle resource identifier", pattern: /\bocid1\.[a-z0-9.-]+/iu },
  { name: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
  { name: "OpenAI-style secret", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/u },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u },
  { name: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u },
  { name: "Google API key", pattern: /\bAIza[A-Za-z0-9_-]{30,}\b/u },
  { name: "real WeChat room ID", pattern: /\b\d{6,}@chatroom\b/u },
  { name: "non-empty bridge secret", pattern: /^BRIDGE_SHARED_SECRET[ \t]*=[ \t]*[^#\s]+$/mu },
  { name: "non-empty sync key", pattern: /^SYNC_KEY[ \t]*=[ \t]*[^#\s]+$/mu },
];

const files = listed.stdout.split("\0").filter(Boolean);
const findings = [];
for (const relative of files) {
  if (forbiddenPaths.some((pattern) => pattern.test(relative))) {
    findings.push(`${relative}: forbidden public path`);
    continue;
  }
  const absolute = path.join(root, relative);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.size > 1_000_000) continue;
  // This scanner necessarily contains the signatures it searches for.
  if (relative === "scripts/check-public-tree.mjs") continue;
  const content = fs.readFileSync(absolute, "utf8");
  for (const rule of forbiddenContent) {
    if (rule.pattern.test(content)) findings.push(`${relative}: ${rule.name}`);
  }
}

if (findings.length > 0) {
  process.stderr.write(`Public tree check failed:\n${findings.map((item) => `- ${item}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`Public tree check passed (${files.length} files).\n`);
