import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { env } from "../config/env.js";

const SALT_BYTES = 16;
const BODY_PREFIX = "enc:v1:";

function deriveKey(secret: string, salt: Buffer): Buffer {
  return scryptSync(secret, salt, 32);
}

export function encryptSecret(plaintext: string): {
  ciphertext: string;
  iv: string;
  tag: string;
} {
  const salt = randomBytes(SALT_BYTES);
  const key = deriveKey(env.encryptionSecret, salt);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([salt, encrypted]).toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function decryptSecret(ciphertext: string, iv: string, tag: string): string {
  const payload = Buffer.from(ciphertext, "base64");
  if (payload.length <= SALT_BYTES) {
    throw new Error("ciphertext too short");
  }
  const salt = payload.subarray(0, SALT_BYTES);
  const encrypted = payload.subarray(SALT_BYTES);
  const key = deriveKey(env.encryptionSecret, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}

/** Encrypt a debug body so the SQLite file does not hold the prompt in the clear. */
export function sealText(plaintext: string): string {
  const enc = encryptSecret(plaintext);
  return `${BODY_PREFIX}${enc.ciphertext}:${enc.iv}:${enc.tag}`;
}

export function isSealedText(stored: string): boolean {
  return stored.startsWith(BODY_PREFIX);
}

export function openText(stored: string): string | null {
  if (!stored.startsWith(BODY_PREFIX)) return stored;
  const parts = stored.slice(BODY_PREFIX.length).split(":");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  try {
    return decryptSecret(parts[0], parts[1], parts[2]);
  } catch {
    console.error("Failed to decrypt a stored request body. The ciphertext was discarded.");
    return null;
  }
}

export function safeEqualString(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

export function generateNemoKey(): { raw: string; prefix: string; hash: string } {
  const body = randomBytes(24).toString("base64url");
  const raw = `nemo-sk-${body}`;
  const prefix = raw.slice(0, 16);
  return { raw, prefix, hash: hashApiKey(raw) };
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}
