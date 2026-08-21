import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ensurePrivateDir } from "./util.mjs";

function openDatabase(filePath) {
  ensurePrivateDir(path.dirname(filePath));
  const db = new DatabaseSync(filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort.
  }
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
  return db;
}

function privateCursorKey(chatId) {
  return crypto.createHash("sha256").update(String(chatId)).digest("hex");
}

export function openHistoryStore(filePath) {
  const db = openDatabase(filePath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content TEXT NOT NULL,
      model_source TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      imported_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_conversation_time
      ON messages(conversation_id, created_at);
  `);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO messages
      (id, conversation_id, role, content, model_source, created_at, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const recent = db.prepare(`
    SELECT id, role, content, model_source, created_at
    FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `);
  const byId = db.prepare("SELECT * FROM messages WHERE id = ?");

  return {
    insertMessage(message) {
      insert.run(
        message.id,
        message.conversationId,
        message.role,
        message.content,
        message.modelSource,
        message.createdAt,
        Date.now(),
      );
    },
    getMessage(id) {
      return byId.get(id) || null;
    },
    getRecent(conversationId, limit) {
      return recent.all(conversationId, limit).reverse();
    },
    close() {
      db.close();
    },
  };
}

export function migrateLegacyGroupHistory({ legacyPath, targetPath, conversationId }) {
  if (!conversationId || !legacyPath || !targetPath || legacyPath === targetPath) return { migrated: 0 };
  if (!fs.existsSync(legacyPath)) return { migrated: 0 };
  const legacy = new DatabaseSync(legacyPath, { readOnly: true });
  const target = openHistoryStore(targetPath);
  let migrated = 0;
  try {
    const rows = legacy.prepare(`
      SELECT id, conversation_id, role, content, model_source, created_at
      FROM messages WHERE conversation_id = ? ORDER BY created_at ASC
    `).all(conversationId);
    for (const row of rows) {
      target.insertMessage({
        id: row.id,
        conversationId: row.conversation_id,
        role: row.role,
        content: row.content,
        modelSource: row.model_source,
        createdAt: row.created_at,
      });
      migrated += 1;
    }
  } finally {
    target.close();
    legacy.close();
  }
  return { migrated };
}

export function openCloudStore(filePath) {
  const db = openDatabase(filePath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS encrypted_queue (
      id TEXT PRIMARY KEY,
      nonce TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      tag TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      acked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS processed_messages (
      id TEXT PRIMARY KEY,
      reply TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_cursors (
      chat_id TEXT PRIMARY KEY,
      last_local_id INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      due_at INTEGER NOT NULL,
      next_attempt_at INTEGER NOT NULL,
      nonce TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      tag TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','cancelled')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      sent_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS reminders_due
      ON reminders(status, next_attempt_at, due_at);
  `);
  const enqueue = db.prepare(`
    INSERT OR IGNORE INTO encrypted_queue(id, nonce, ciphertext, tag, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const pending = db.prepare(`
    SELECT id, nonce, ciphertext, tag, created_at
    FROM encrypted_queue
    WHERE acked_at IS NULL
    ORDER BY created_at ASC
    LIMIT ?
  `);
  const ack = db.prepare("UPDATE encrypted_queue SET acked_at = ? WHERE id = ? AND acked_at IS NULL");
  const deleteAcknowledged = db.prepare("DELETE FROM encrypted_queue WHERE id = ?");
  const findProcessed = db.prepare("SELECT id, reply FROM processed_messages WHERE id = ?");
  const markProcessed = db.prepare(`
    INSERT OR REPLACE INTO processed_messages(id, reply, created_at) VALUES (?, ?, ?)
  `);
  const unmarkProcessed = db.prepare("DELETE FROM processed_messages WHERE id = ?");
  const recentGeneratedReply = db.prepare(`
    SELECT id FROM processed_messages
    WHERE reply = ? AND created_at >= ?
    ORDER BY created_at DESC LIMIT 1
  `);
  const findCursor = db.prepare("SELECT last_local_id FROM chat_cursors WHERE chat_id = ?");
  const setCursor = db.prepare(`
    INSERT INTO chat_cursors(chat_id, last_local_id, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      last_local_id = MAX(chat_cursors.last_local_id, excluded.last_local_id),
      updated_at = excluded.updated_at
  `);
  const createReminder = db.prepare(`
    INSERT OR IGNORE INTO reminders
      (id, conversation_id, due_at, next_attempt_at, nonce, ciphertext, tag, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `);
  const listReminders = db.prepare(`
    SELECT id, due_at, nonce, ciphertext, tag
    FROM reminders
    WHERE conversation_id = ? AND status = 'pending'
    ORDER BY due_at ASC
    LIMIT ?
  `);
  const findDueReminders = db.prepare(`
    SELECT id, due_at, nonce, ciphertext, tag, attempts
    FROM reminders
    WHERE conversation_id = ? AND status = 'pending' AND due_at <= ? AND next_attempt_at <= ?
    ORDER BY due_at ASC
    LIMIT ?
  `);
  const claimReminder = db.prepare(`
    UPDATE reminders SET status = 'sending', updated_at = ?
    WHERE id = ? AND status = 'pending'
  `);
  const sentReminder = db.prepare(`
    UPDATE reminders SET
      status = 'sent', sent_at = ?, updated_at = ?, last_error = NULL,
      nonce = '', ciphertext = '', tag = ''
    WHERE id = ? AND status = 'sending'
  `);
  const retryReminder = db.prepare(`
    UPDATE reminders SET
      status = 'pending', attempts = attempts + 1, next_attempt_at = ?, last_error = ?, updated_at = ?
    WHERE id = ? AND status = 'sending'
  `);
  const cancelReminder = db.prepare(`
    UPDATE reminders SET status = 'cancelled', updated_at = ?, nonce = '', ciphertext = '', tag = ''
    WHERE id = ? AND conversation_id = ? AND status = 'pending'
  `);
  const cancelAllReminders = db.prepare(`
    UPDATE reminders SET status = 'cancelled', updated_at = ?, nonce = '', ciphertext = '', tag = ''
    WHERE conversation_id = ? AND status = 'pending'
  `);
  const recoverReminders = db.prepare(`
    UPDATE reminders SET status = 'pending', next_attempt_at = ?, updated_at = ?
    WHERE status = 'sending' AND updated_at < ?
  `);

  recoverReminders.run(Date.now(), Date.now(), Date.now() - 5 * 60_000);

  return {
    enqueue(record) {
      enqueue.run(record.id, record.nonce, record.ciphertext, record.tag, record.createdAt);
    },
    pending(limit = 100) {
      return pending.all(limit);
    },
    acknowledge(ids) {
      const now = Date.now();
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const id of ids) {
          ack.run(now, id);
          deleteAcknowledged.run(id);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    getProcessed(id) {
      return findProcessed.get(id) || null;
    },
    markProcessed(id, reply) {
      markProcessed.run(id, reply, Date.now());
    },
    unmarkProcessed(id) {
      return Number(unmarkProcessed.run(id).changes) > 0;
    },
    hasRecentGeneratedReply(reply, withinMs = 5 * 60_000) {
      return Boolean(recentGeneratedReply.get(reply, Date.now() - withinMs));
    },
    getCursor(chatId) {
      return findCursor.get(privateCursorKey(chatId))?.last_local_id || 0;
    },
    setCursor(chatId, localId) {
      setCursor.run(privateCursorKey(chatId), localId, Date.now());
    },
    createReminder(reminder) {
      const result = createReminder.run(
        reminder.id,
        reminder.conversationId,
        reminder.dueAt,
        reminder.dueAt,
        reminder.nonce,
        reminder.ciphertext,
        reminder.tag,
        reminder.createdAt,
        reminder.createdAt,
      );
      return Number(result.changes) > 0;
    },
    listReminders(conversationId, limit = 20) {
      return listReminders.all(conversationId, limit);
    },
    claimDueReminders(conversationId, now, limit = 10) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const rows = findDueReminders.all(conversationId, now, now, limit);
        const claimed = [];
        for (const row of rows) {
          if (Number(claimReminder.run(now, row.id).changes) > 0) claimed.push(row);
        }
        db.exec("COMMIT");
        return claimed;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    markReminderSent(id, now) {
      sentReminder.run(now, now, id);
    },
    retryReminder(id, error, now) {
      const attempts = Number(db.prepare("SELECT attempts FROM reminders WHERE id = ?").get(id)?.attempts || 0);
      const retryDelay = Math.min(5 * 60_000, 15_000 * (2 ** Math.min(attempts, 5)));
      retryReminder.run(now + retryDelay, error, now, id);
    },
    cancelReminder(id, conversationId) {
      return Number(cancelReminder.run(Date.now(), id, conversationId).changes);
    },
    cancelAllReminders(conversationId) {
      return Number(cancelAllReminders.run(Date.now(), conversationId).changes);
    },
    close() {
      db.close();
    },
  };
}
