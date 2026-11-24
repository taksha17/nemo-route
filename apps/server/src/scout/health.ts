import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { ModelStatus } from "@nemo-route/shared";
import { env } from "../config/env.js";
import { getDb } from "../db/client.js";
import { healthEvents, modelHealth } from "../db/schema.js";
import { classifyNimError } from "../upstream/nimClient.js";
import { getModelEntry, listChatModels, listHealth } from "./registry.js";
import type { EventBus } from "../admin/events.js";
import { globalBus } from "../admin/events.js";
import type { NimClient } from "../upstream/nimClient.js";

const EMA_ALPHA = 0.3;
let bootstrapRunning = false;
let lastBootstrapAt: number | null = null;

export function recordSuccess(
  modelId: string,
  latencyMs: number,
  ttftMs: number | null,
  workspaceId = env.workspaceId,
) {
  const db = getDb();
  const row = db.select().from(modelHealth).where(eq(modelHealth.modelId, modelId)).all()[0];
  if (!row) return;
  const successCount = row.successCount + 1;
  const failureCount = row.failureCount;
  const total = successCount + failureCount;
  const avgLatencyMs =
    row.avgLatencyMs == null ? latencyMs : row.avgLatencyMs * (1 - EMA_ALPHA) + latencyMs * EMA_ALPHA;
  const avgTtftMs =
    ttftMs == null
      ? row.avgTtftMs
      : row.avgTtftMs == null
        ? ttftMs
        : row.avgTtftMs * (1 - EMA_ALPHA) + ttftMs * EMA_ALPHA;
  const status: ModelStatus = "healthy";
  db.update(modelHealth)
    .set({
      status,
      lastSuccessAt: Date.now(),
      avgLatencyMs,
      avgTtftMs,
      errorRate: failureCount / total,
      consecutiveFailures: 0,
      circuitOpenUntil: null,
      successCount,
      updatedAt: Date.now(),
    })
    .where(eq(modelHealth.modelId, modelId))
    .run();
  appendHealthEvent(workspaceId, modelId, status, "success", latencyMs);
}

export function recordFailure(
  modelId: string,
  statusCode: number | undefined,
  message: string,
  latencyMs?: number,
  workspaceId = env.workspaceId,
) {
  const classified = classifyNimError(statusCode, message);
  if (!classified.againstModel) {
    // rate limit — do not punish the model
    return;
  }
  const db = getDb();
  const row = db.select().from(modelHealth).where(eq(modelHealth.modelId, modelId)).all()[0];
  if (!row) return;
  const successCount = row.successCount;
  const failureCount = row.failureCount + 1;
  const total = successCount + failureCount;
  const consecutiveFailures = row.consecutiveFailures + 1;
  let status: ModelStatus = consecutiveFailures >= 3 ? "down" : "degraded";
  let circuitOpenUntil: number | null = row.circuitOpenUntil;
  if (classified.kind === "not_entitled") {
    status = "not_entitled";
    circuitOpenUntil = Date.now() + 6 * 60 * 60_000;
  } else if (classified.kind === "removed") {
    status = "down";
    circuitOpenUntil = Date.now() + 60 * 60_000;
  } else if (status === "down") {
    const backoff = Math.min(30 * 60_000, 5_000 * 2 ** Math.min(consecutiveFailures, 6));
    circuitOpenUntil = Date.now() + backoff;
  }
  db.update(modelHealth)
    .set({
      status,
      lastFailureAt: Date.now(),
      errorRate: failureCount / total,
      consecutiveFailures,
      circuitOpenUntil,
      failureCount,
      updatedAt: Date.now(),
    })
    .where(eq(modelHealth.modelId, modelId))
    .run();
  appendHealthEvent(workspaceId, modelId, status, message, latencyMs);
}

export function recordProbe(
  modelId: string,
  ok: boolean,
  latencyMs: number,
  statusCode?: number,
  error?: string,
  workspaceId = env.workspaceId,
) {
  const db = getDb();
  db.update(modelHealth)
    .set({ lastProbeAt: Date.now(), updatedAt: Date.now() })
    .where(eq(modelHealth.modelId, modelId))
    .run();
  if (ok) recordSuccess(modelId, latencyMs, latencyMs, workspaceId);
  else recordFailure(modelId, statusCode, error ?? "probe failed", latencyMs, workspaceId);
}

export function isModelRoutable(modelId: string, now = Date.now()): boolean {
  const db = getDb();
  const row = db.select().from(modelHealth).where(eq(modelHealth.modelId, modelId)).all()[0];
  const entry = getModelEntry(modelId);
  if (!entry || entry.kind !== "chat") return false;
  if (!row) return false;
  if (row.status === "not_entitled") return false;
  // checking/unknown are transient — skip until probe finishes
  if (row.status === "checking" || row.status === "unknown") return false;
  // Hard open circuit still blocks
  if (row.circuitOpenUntil && row.circuitOpenUntil > now) return false;
  // Half-open: after circuit expiry, allow one live attempt even if status is still "down"
  if (row.status === "down") return true;
  const health = listHealth().find((h) => h.modelId === modelId);
  if (health && !health.inCatalog) return false;
  return true;
}

export function markChecking(modelId: string, workspaceId = env.workspaceId) {
  const db = getDb();
  const row = db.select().from(modelHealth).where(eq(modelHealth.modelId, modelId)).all()[0];
  if (!row) return;
  db.update(modelHealth)
    .set({ status: "checking", updatedAt: Date.now() })
    .where(eq(modelHealth.modelId, modelId))
    .run();
  appendHealthEvent(workspaceId, modelId, "checking", "startup health check");
}

export function getBootstrapStatus() {
  return {
    running: bootstrapRunning,
    lastBootstrapAt,
  };
}

/** Probe every in-catalog chat model immediately. No unknown left behind. */
export async function bootstrapAllChatHealth(client: NimClient): Promise<{
  checked: number;
  healthy: number;
  failed: number;
}> {
  if (bootstrapRunning) {
    return { checked: 0, healthy: 0, failed: 0 };
  }
  bootstrapRunning = true;
  globalBus.emit("health_bootstrap", { type: "start", at: Date.now() });

  const chats = listChatModels().filter((m) => {
    const h = listHealth().find((x) => x.modelId === m.id);
    return h?.inCatalog !== false;
  });

  // Clear any stuck "checking" rows from interrupted prior boots
  const db = getDb();
  for (const h of listHealth()) {
    if (h.status === "checking") {
      db.update(modelHealth)
        .set({ status: "unknown", updatedAt: Date.now() })
        .where(eq(modelHealth.modelId, h.modelId))
        .run();
    }
  }

  let healthy = 0;
  let failed = 0;
  // Serialize through rate governor; probe one-by-one (keep prior status until each is checked)
  for (const m of chats) {
    markChecking(m.id);
    globalBus.emit("health", { at: Date.now(), models: listHealth() });
    try {
      const result = await client.probeModel(m.id);
      recordProbe(m.id, result.ok, result.latencyMs, result.status, result.error);
      if (result.ok) healthy += 1;
      else failed += 1;
    } catch (err) {
      failed += 1;
      recordFailure(
        m.id,
        undefined,
        err instanceof Error ? err.message : String(err),
      );
    }
    globalBus.emit("health_bootstrap", {
      type: "progress",
      modelId: m.id,
      checked: healthy + failed,
      total: chats.length,
    });
    globalBus.emit("health", { at: Date.now(), models: listHealth() });
  }

  // Anything still unknown after sweep → mark down (never leave unknown)
  for (const h of listHealth()) {
    const entry = listChatModels().find((m) => m.id === h.modelId);
    if (!entry) continue;
    if (h.status === "checking" || h.status === "unknown") {
      recordFailure(h.modelId, undefined, "health check incomplete");
      failed += 1;
    }
  }

  lastBootstrapAt = Date.now();
  bootstrapRunning = false;
  const summary = { checked: chats.length, healthy, failed };
  globalBus.emit("health_bootstrap", { type: "done", ...summary, at: lastBootstrapAt });
  return summary;
}

function appendHealthEvent(
  workspaceId: string,
  modelId: string,
  status: ModelStatus,
  reason: string,
  latencyMs?: number,
) {
  const db = getDb();
  db.insert(healthEvents)
    .values({
      id: nanoid(),
      workspaceId,
      modelId,
      status,
      reason,
      latencyMs: latencyMs ?? null,
      createdAt: Date.now(),
    })
    .run();
}

export function modelsNeedingProbe(limit = 3, staleMs = 10 * 60_000): string[] {
  const now = Date.now();
  const chats = listChatModels();
  const health = new Map(listHealth().map((h) => [h.modelId, h]));
  return chats
    .filter((m) => {
      const h = health.get(m.id);
      if (!h?.inCatalog) return false;
      if (h.status === "not_entitled") return false;
      if (h.circuitOpenUntil && h.circuitOpenUntil > now) return false;
      // Immediately re-probe down models once their circuit expires (half-open recovery)
      if (h.status === "down") return true;
      const lastActivity = Math.max(h.lastSuccessAt ?? 0, h.lastFailureAt ?? 0, h.lastProbeAt ?? 0);
      return now - lastActivity > staleMs || h.status === "unknown";
    })
    .sort((a, b) => {
      const ha = health.get(a.id);
      const hb = health.get(b.id);
      // Prefer recovering down models first
      const da = ha?.status === "down" ? 0 : 1;
      const db = hb?.status === "down" ? 0 : 1;
      if (da !== db) return da - db;
      const ta = Math.max(ha?.lastProbeAt ?? 0, ha?.lastSuccessAt ?? 0);
      const tb = Math.max(hb?.lastProbeAt ?? 0, hb?.lastSuccessAt ?? 0);
      return ta - tb;
    })
    .slice(0, limit)
    .map((m) => m.id);
}

export class HealthProbeLoop {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private probeFn: (modelId: string) => Promise<void>,
    private intervalMs = 30_000,
  ) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick() {
    const needed = modelsNeedingProbe(1);
    for (const id of needed) {
      try {
        await this.probeFn(id);
      } catch {
        // ignore probe loop errors
      }
    }
  }
}

export function emitHealthUpdate(bus: EventBus | null) {
  bus?.emit("health", { at: Date.now(), models: listHealth() });
}
