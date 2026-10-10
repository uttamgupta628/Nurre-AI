// lib/security/field-crypto.ts
// SERVER ONLY. AES-256-GCM field encryption with a versioned key prefix so
// keys can be rotated ("enc:v1:" → "enc:v2:").
//
// Env: DATA_ENCRYPTION_KEY = 32 random bytes, base64.
//   generate:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const PREFIX = "enc:v1:";

function key(): Buffer {
  const b64 = process.env.DATA_ENCRYPTION_KEY;
  if (!b64) throw new Error("DATA_ENCRYPTION_KEY is not set");
  const k = Buffer.from(b64, "base64");
  if (k.length !== 32) throw new Error("DATA_ENCRYPTION_KEY must be 32 bytes (base64)");
  return k;
}

export function isEncrypted(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export function encryptField(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptField(value: string): string {
  if (!isEncrypted(value)) return value; // legacy plaintext
  const raw = Buffer.from(value.slice(PREFIX.length), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/**
 * Encrypts the stored calibration path when ENCRYPT_CALIBRATION_PATH=true.
 * Off by default: it requires the `path` column to accept a string
 * (e.g. jsonb or text) — enable only after checking the column type.
 */
export function protectPath(path: unknown): unknown {
  if (process.env.ENCRYPT_CALIBRATION_PATH !== "true") return path;
  return encryptField(JSON.stringify(path));
}