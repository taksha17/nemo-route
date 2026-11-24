import { eq } from "drizzle-orm";
import type { WorkspaceSettings } from "@nemo-route/shared";
import { DEFAULT_SETTINGS, env } from "../config/env.js";
import { decryptSecret, encryptSecret } from "../crypto/secrets.js";
import { getDb } from "./client.js";
import { workspaces } from "./schema.js";

export function getWorkspace(workspaceId = env.workspaceId) {
  const db = getDb();
  const rows = db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).all();
  return rows[0] ?? null;
}

export function getSettings(workspaceId = env.workspaceId): WorkspaceSettings {
  const ws = getWorkspace(workspaceId);
  if (!ws) return { ...DEFAULT_SETTINGS, workspaceId };
  try {
    const stored = JSON.parse(ws.settingsJson) as Partial<WorkspaceSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      workspaceId,
      timeouts: {
        ...DEFAULT_SETTINGS.timeouts,
        ...(stored.timeouts ?? {}),
        // Prefer explicit saved idle; otherwise env/default. Floor at 60s so tiny
        // legacy values don't truncate long NIM streams.
        idleMs: Math.max(
          60_000,
          stored.timeouts?.idleMs ?? DEFAULT_SETTINGS.timeouts.idleMs,
        ),
      },
      // Always prefer the latest curated routing preferences (light models first for chat)
      taskPreferences: {
        ...DEFAULT_SETTINGS.taskPreferences,
        ...(stored.taskPreferences ?? {}),
        // Force chat/code defaults if stored still prefer heavies for chat
        chat: DEFAULT_SETTINGS.taskPreferences.chat,
        code: DEFAULT_SETTINGS.taskPreferences.code,
        reasoning: DEFAULT_SETTINGS.taskPreferences.reasoning,
        vision: DEFAULT_SETTINGS.taskPreferences.vision,
      },
    };
  } catch {
    return { ...DEFAULT_SETTINGS, workspaceId };
  }
}

export function saveSettings(settings: WorkspaceSettings) {
  const db = getDb();
  db.update(workspaces)
    .set({ settingsJson: JSON.stringify(settings) })
    .where(eq(workspaces.id, settings.workspaceId))
    .run();
}

let loggedNimDecryptFailure = false;

export function getNimApiKey(workspaceId = env.workspaceId): string | null {
  const ws = getWorkspace(workspaceId);
  if (!ws?.nimKeyCiphertext || !ws.nimKeyIv || !ws.nimKeyTag) return null;
  try {
    return decryptSecret(ws.nimKeyCiphertext, ws.nimKeyIv, ws.nimKeyTag);
  } catch (err) {
    if (!loggedNimDecryptFailure) {
      loggedNimDecryptFailure = true;
      console.error(
        "Failed to decrypt the stored NIM API key. The data encryption key does not match " +
          "this install (the database was copied, or NEMO_ENCRYPTION_SECRET changed). " +
          "Re-enter the NIM key on the setup page so it is sealed under the current secret.",
        err instanceof Error ? err.message : "",
      );
    }
    return null;
  }
}

export function setNimApiKey(rawKey: string, workspaceId = env.workspaceId) {
  const enc = encryptSecret(rawKey);
  const db = getDb();
  db.update(workspaces)
    .set({
      nimKeyCiphertext: enc.ciphertext,
      nimKeyIv: enc.iv,
      nimKeyTag: enc.tag,
    })
    .where(eq(workspaces.id, workspaceId))
    .run();
}

export function clearNimApiKey(workspaceId = env.workspaceId) {
  const db = getDb();
  db.update(workspaces)
    .set({
      nimKeyCiphertext: null,
      nimKeyIv: null,
      nimKeyTag: null,
    })
    .where(eq(workspaces.id, workspaceId))
    .run();
}

export function hasNimApiKey(workspaceId = env.workspaceId): boolean {
  const ws = getWorkspace(workspaceId);
  return Boolean(ws?.nimKeyCiphertext);
}
