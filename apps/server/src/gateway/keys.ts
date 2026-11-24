import { and, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { ApiKeyInfo } from "@nemo-route/shared";
import { generateNemoKey, hashApiKey } from "../crypto/secrets.js";
import { env } from "../config/env.js";
import { getDb } from "../db/client.js";
import { apiKeys } from "../db/schema.js";

export function createApiKey(label: string, workspaceId = env.workspaceId): {
  info: ApiKeyInfo;
  rawKey: string;
} {
  const generated = generateNemoKey();
  const id = nanoid();
  const createdAt = Date.now();
  const db = getDb();
  db.insert(apiKeys)
    .values({
      id,
      workspaceId,
      label,
      prefix: generated.prefix,
      keyHash: generated.hash,
      createdAt,
      revokedAt: null,
      lastUsedAt: null,
      debugBodies: 0,
    })
    .run();
  return {
    rawKey: generated.raw,
    info: {
      id,
      workspaceId,
      label,
      prefix: generated.prefix,
      createdAt,
      revokedAt: null,
      lastUsedAt: null,
      debugBodies: false,
    },
  };
}

export function listApiKeys(workspaceId = env.workspaceId): ApiKeyInfo[] {
  const db = getDb();
  return db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.workspaceId, workspaceId))
    .all()
    .map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      label: row.label,
      prefix: row.prefix,
      createdAt: row.createdAt,
      revokedAt: row.revokedAt,
      lastUsedAt: row.lastUsedAt,
      debugBodies: Boolean(row.debugBodies),
    }));
}

export function revokeApiKey(id: string) {
  const db = getDb();
  db.update(apiKeys)
    .set({ revokedAt: Date.now() })
    .where(eq(apiKeys.id, id))
    .run();
}

export function setKeyDebug(id: string, enabled: boolean) {
  const db = getDb();
  db.update(apiKeys)
    .set({ debugBodies: enabled ? 1 : 0 })
    .where(eq(apiKeys.id, id))
    .run();
}

export function authenticateApiKey(rawKey: string | undefined | null): ApiKeyInfo | null {
  if (!rawKey) return null;
  const cleaned = rawKey.replace(/^Bearer\s+/i, "").trim();
  if (!cleaned.startsWith("nemo-sk-")) return null;
  const hash = hashApiKey(cleaned);
  const db = getDb();
  const row = db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt)))
    .all()[0];
  if (!row) return null;
  db.update(apiKeys)
    .set({ lastUsedAt: Date.now() })
    .where(eq(apiKeys.id, row.id))
    .run();
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    label: row.label,
    prefix: row.prefix,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
    lastUsedAt: Date.now(),
    debugBodies: Boolean(row.debugBodies),
  };
}

export function extractApiKeyFromHeaders(headers: Headers): string | null {
  const auth = headers.get("authorization");
  if (auth) return auth;
  return headers.get("x-api-key");
}
