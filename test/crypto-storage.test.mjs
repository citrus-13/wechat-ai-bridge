import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { decryptRecord, encryptRecord } from "../src/crypto-sync.mjs";
import { migrateLegacyGroupHistory, openCloudStore, openHistoryStore } from "../src/storage.mjs";

test("encrypted sync records round-trip and reject tampering", () => {
  const key = crypto.randomBytes(32).toString("base64");
  const encrypted = encryptRecord({ text: "私人消息" }, key);
  assert.deepEqual(decryptRecord(encrypted, key), { text: "私人消息" });
  const tampered = { ...encrypted, ciphertext: `${encrypted.ciphertext.slice(0, -2)}AA` };
  assert.throws(() => decryptRecord(tampered, key));
});

test("local history deduplicates messages and keeps chronological context", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-ai-history-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = openHistoryStore(path.join(dir, "history.sqlite3"));
  t.after(() => store.close());
  store.insertMessage({
    id: "1",
    conversationId: "me",
    role: "user",
    content: "第一条",
    modelSource: "wechat",
    createdAt: 1,
  });
  store.insertMessage({
    id: "1",
    conversationId: "me",
    role: "user",
    content: "重复内容不会覆盖",
    modelSource: "wechat",
    createdAt: 2,
  });
  store.insertMessage({
    id: "2",
    conversationId: "me",
    role: "assistant",
    content: "第二条",
    modelSource: "local-qwen",
    createdAt: 3,
  });
  assert.deepEqual(store.getRecent("me", 10).map((row) => row.content), ["第一条", "第二条"]);
});

test("legacy migration copies only the selected group into its physical database", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-ai-migration-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const legacyPath = path.join(dir, "history.sqlite3");
  const targetPath = path.join(dir, "group-memory", "group-a.sqlite3");
  const legacy = openHistoryStore(legacyPath);
  legacy.insertMessage({ id: "a", conversationId: "group-a", role: "user", content: "本群", modelSource: "wechat", createdAt: 1 });
  legacy.insertMessage({ id: "b", conversationId: "group-b", role: "user", content: "其他群", modelSource: "wechat", createdAt: 2 });
  legacy.close();

  assert.deepEqual(migrateLegacyGroupHistory({ legacyPath, targetPath, conversationId: "group-a" }), { migrated: 1 });
  const target = openHistoryStore(targetPath);
  t.after(() => target.close());
  assert.deepEqual(target.getRecent("group-a", 10).map((row) => row.content), ["本群"]);
  assert.deepEqual(target.getRecent("group-b", 10), []);
});

test("cloud queue exposes only encrypted records and acknowledges them", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-ai-cloud-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = openCloudStore(path.join(dir, "queue.sqlite3"));
  t.after(() => store.close());
  store.enqueue({ id: "q1", nonce: "n", ciphertext: "c", tag: "t", createdAt: 1 });
  const pending = store.pending();
  assert.equal(pending.length, 1);
  assert.deepEqual(Object.keys(pending[0]).sort(), ["ciphertext", "created_at", "id", "nonce", "tag"]);
  store.acknowledge(["q1"]);
  assert.equal(store.pending().length, 0);
});
