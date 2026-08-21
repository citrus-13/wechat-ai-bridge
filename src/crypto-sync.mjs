import crypto from "node:crypto";

export function decodeSyncKey(encoded) {
  const key = Buffer.from(encoded || "", "base64");
  if (key.length !== 32) throw new Error("SYNC_KEY must be a base64-encoded 32-byte key");
  return key;
}

export function encryptRecord(value, encodedKey) {
  const key = decodeSyncKey(encodedKey);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptRecord(record, encodedKey) {
  const key = decodeSyncKey(encodedKey);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(record.nonce, "base64"));
  decipher.setAuthTag(Buffer.from(record.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}
