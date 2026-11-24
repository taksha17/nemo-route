import { eq, and } from "drizzle-orm";
import type {
  ModelHealthSnapshot,
  ModelKind,
  ModelRegistryEntry,
  ModelStatus,
  ModelTier,
  TaskType,
} from "@nemo-route/shared";
import { env } from "../config/env.js";
import { getDb } from "../db/client.js";
import { modelHealth, models } from "../db/schema.js";
import seed from "./registry.seed.json" with { type: "json" };

export function seedRegistry(workspaceId = env.workspaceId) {
  const db = getDb();
  const now = Date.now();
  for (const entry of seed as ModelRegistryEntry[]) {
    const existing = db
      .select()
      .from(models)
      .where(and(eq(models.id, entry.id), eq(models.workspaceId, workspaceId)))
      .all()[0];
    // Always refresh curated capability metadata (especially context windows)
    if (existing) {
      db.update(models)
        .set({
          ownedBy: entry.ownedBy,
          displayName: entry.displayName,
          kind: entry.kind,
          inputsJson: JSON.stringify(entry.inputs),
          tools: entry.tools ? 1 : 0,
          contextTokens: entry.contextTokens,
          tier: entry.tier,
          strengthsJson: JSON.stringify(entry.strengths),
          curated: entry.curated ? 1 : 0,
          notes: entry.notes ?? null,
          updatedAt: now,
        })
        .where(eq(models.id, entry.id))
        .run();
    } else {
      db.insert(models)
        .values({
          id: entry.id,
          workspaceId,
          ownedBy: entry.ownedBy,
          displayName: entry.displayName,
          kind: entry.kind,
          inputsJson: JSON.stringify(entry.inputs),
          tools: entry.tools ? 1 : 0,
          contextTokens: entry.contextTokens,
          tier: entry.tier,
          strengthsJson: JSON.stringify(entry.strengths),
          curated: entry.curated ? 1 : 0,
          notes: entry.notes ?? null,
          inCatalog: 1,
          updatedAt: now,
        })
        .run();
    }
    ensureHealthRow(entry.id, workspaceId);
  }
}

function ensureHealthRow(modelId: string, workspaceId = env.workspaceId) {
  const db = getDb();
  const existing = db
    .select()
    .from(modelHealth)
    .where(eq(modelHealth.modelId, modelId))
    .all()[0];
  if (!existing) {
    db.insert(modelHealth)
      .values({
        modelId,
        workspaceId,
        status: "unknown",
        errorRate: 0,
        consecutiveFailures: 0,
        successCount: 0,
        failureCount: 0,
        updatedAt: Date.now(),
      })
      .run();
  }
}

export function upsertCatalogModel(
  id: string,
  ownedBy: string,
  workspaceId = env.workspaceId,
) {
  const db = getDb();
  const now = Date.now();
  const existing = db
    .select()
    .from(models)
    .where(eq(models.id, id))
    .all()[0];
  if (existing) {
    db.update(models)
      .set({ inCatalog: 1, ownedBy, updatedAt: now })
      .where(eq(models.id, id))
      .run();
  } else {
    const guessed = guessCapabilities(id, ownedBy);
    db.insert(models)
      .values({
        id,
        workspaceId,
        ownedBy,
        displayName: id.split("/").pop() ?? id,
        kind: guessed.kind,
        inputsJson: JSON.stringify(guessed.inputs),
        tools: guessed.tools ? 1 : 0,
        contextTokens: guessed.contextTokens,
        tier: guessed.tier,
        strengthsJson: JSON.stringify(guessed.strengths),
        curated: 0,
        notes: "auto-discovered; unclassified until curated",
        inCatalog: 1,
        updatedAt: now,
      })
      .run();
  }
  ensureHealthRow(id, workspaceId);
}

export function markMissingFromCatalog(presentIds: Set<string>, workspaceId = env.workspaceId) {
  const db = getDb();
  const all = db.select().from(models).where(eq(models.workspaceId, workspaceId)).all();
  for (const m of all) {
    const inCatalog = presentIds.has(m.id) ? 1 : 0;
    if (m.inCatalog !== inCatalog) {
      db.update(models).set({ inCatalog, updatedAt: Date.now() }).where(eq(models.id, m.id)).run();
    }
  }
}

export function listRegistry(workspaceId = env.workspaceId): ModelRegistryEntry[] {
  const db = getDb();
  return db
    .select()
    .from(models)
    .where(eq(models.workspaceId, workspaceId))
    .all()
    .map(rowToEntry);
}

export function getModelEntry(id: string): ModelRegistryEntry | null {
  const db = getDb();
  const row = db.select().from(models).where(eq(models.id, id)).all()[0];
  return row ? rowToEntry(row) : null;
}

export function updateModelEntry(
  id: string,
  patch: Partial<ModelRegistryEntry>,
): ModelRegistryEntry | null {
  const db = getDb();
  const existing = getModelEntry(id);
  if (!existing) return null;
  const next = { ...existing, ...patch, id };
  db.update(models)
    .set({
      ownedBy: next.ownedBy,
      displayName: next.displayName,
      kind: next.kind,
      inputsJson: JSON.stringify(next.inputs),
      tools: next.tools ? 1 : 0,
      contextTokens: next.contextTokens,
      tier: next.tier,
      strengthsJson: JSON.stringify(next.strengths),
      curated: next.curated ? 1 : 0,
      notes: next.notes ?? null,
      updatedAt: Date.now(),
    })
    .where(eq(models.id, id))
    .run();
  return next;
}

export function listChatModels(workspaceId = env.workspaceId): ModelRegistryEntry[] {
  return listRegistry(workspaceId).filter((m) => m.kind === "chat");
}

export function getHealth(modelId: string): ModelHealthSnapshot | null {
  const db = getDb();
  const row = db.select().from(modelHealth).where(eq(modelHealth.modelId, modelId)).all()[0];
  if (!row) return null;
  const modelRow = db.select().from(models).where(eq(models.id, modelId)).all()[0];
  return {
    modelId: row.modelId,
    status: row.status as ModelStatus,
    lastSuccessAt: row.lastSuccessAt,
    lastFailureAt: row.lastFailureAt,
    lastProbeAt: row.lastProbeAt,
    avgLatencyMs: row.avgLatencyMs,
    avgTtftMs: row.avgTtftMs,
    errorRate: row.errorRate,
    consecutiveFailures: row.consecutiveFailures,
    circuitOpenUntil: row.circuitOpenUntil,
    inCatalog: Boolean(modelRow?.inCatalog),
  };
}

export function listHealth(workspaceId = env.workspaceId): ModelHealthSnapshot[] {
  const db = getDb();
  const healthRows = db
    .select()
    .from(modelHealth)
    .where(eq(modelHealth.workspaceId, workspaceId))
    .all();
  const modelRows = new Map(
    db
      .select()
      .from(models)
      .where(eq(models.workspaceId, workspaceId))
      .all()
      .map((m) => [m.id, m]),
  );
  return healthRows.map((row) => ({
    modelId: row.modelId,
    status: row.status as ModelStatus,
    lastSuccessAt: row.lastSuccessAt,
    lastFailureAt: row.lastFailureAt,
    lastProbeAt: row.lastProbeAt,
    avgLatencyMs: row.avgLatencyMs,
    avgTtftMs: row.avgTtftMs,
    errorRate: row.errorRate,
    consecutiveFailures: row.consecutiveFailures,
    circuitOpenUntil: row.circuitOpenUntil,
    inCatalog: Boolean(modelRows.get(row.modelId)?.inCatalog),
  }));
}

function rowToEntry(row: typeof models.$inferSelect): ModelRegistryEntry {
  return {
    id: row.id,
    ownedBy: row.ownedBy,
    displayName: row.displayName,
    kind: row.kind as ModelKind,
    inputs: JSON.parse(row.inputsJson) as ModelRegistryEntry["inputs"],
    tools: Boolean(row.tools),
    contextTokens: row.contextTokens,
    tier: row.tier as ModelTier,
    strengths: JSON.parse(row.strengthsJson) as TaskType[],
    curated: Boolean(row.curated),
    notes: row.notes ?? undefined,
  };
}

function guessCapabilities(id: string, ownedBy: string): Omit<ModelRegistryEntry, "id" | "ownedBy" | "displayName" | "curated" | "notes"> {
  const lower = id.toLowerCase();
  if (lower.includes("embed")) {
    return {
      kind: "embed",
      inputs: ["text"],
      tools: false,
      contextTokens: 512,
      tier: "light",
      strengths: ["other"],
    };
  }
  if (lower.includes("guard") || lower.includes("safety") || lower.includes("detector")) {
    return {
      kind: lower.includes("detector") ? "other" : "guard",
      inputs: ["text"],
      tools: false,
      contextTokens: 8192,
      tier: "light",
      strengths: ["other"],
    };
  }
  if (lower.includes("rerank")) {
    return {
      kind: "rerank",
      inputs: ["text"],
      tools: false,
      contextTokens: 512,
      tier: "light",
      strengths: ["other"],
    };
  }
  void ownedBy;
  return {
    kind: "chat",
    inputs: lower.includes("vl") || lower.includes("vision") || lower.includes("omni") ? ["text", "image"] : ["text"],
    tools: true,
    contextTokens: 32768,
    tier: "medium",
    strengths: ["chat"],
  };
}
