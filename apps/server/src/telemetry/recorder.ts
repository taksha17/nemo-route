import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type {
  OverviewStats,
  RequestOutcome,
  RequestTrace,
  RoutingAttempt,
  TokenRoutingSegment,
} from "@nemo-route/shared";
import { env } from "../config/env.js";
import { isSealedText, openText, sealText } from "../crypto/secrets.js";
import { getDb } from "../db/client.js";
import { dailyUsage, modelHealth, models, requests } from "../db/schema.js";
import { getSettings } from "../db/workspace.js";
import { globalBus } from "../admin/events.js";

const REQUEST_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_REQUEST_PAGE = 200;
const MAX_USAGE_DAYS = 366;

function clampInt(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function sealOptional(value: string | null | undefined): string | null {
  if (value == null || value === "") return null;
  return sealText(value);
}

export function recordRequest(trace: Omit<RequestTrace, "id"> & { id?: string; promptBody?: string | null; responseBody?: string | null }) {
  const db = getDb();
  const id = trace.id ?? nanoid();
  db.insert(requests)
    .values({
      id,
      workspaceId: trace.workspaceId,
      keyId: trace.keyId,
      requestedModel: trace.requestedModel,
      chosenModel: trace.chosenModel,
      taskType: trace.taskType,
      complexity: trace.complexity,
      inputTokens: trace.inputTokens,
      outputTokens: trace.outputTokens,
      tokensEstimated: trace.tokensEstimated ? 1 : 0,
      ttftMs: trace.ttftMs,
      durationMs: trace.durationMs,
      outcome: trace.outcome,
      attemptsJson: JSON.stringify({
        attempts: trace.attempts,
        segments: trace.segments ?? [],
      }),
      promptBody: sealOptional(trace.promptBody),
      responseBody: sealOptional(trace.responseBody),
      createdAt: trace.createdAt,
    })
    .run();

  pruneRequests();

  bumpDailyUsage({
    workspaceId: trace.workspaceId,
    keyId: trace.keyId,
    modelId: trace.chosenModel,
    inputTokens: trace.inputTokens,
    outputTokens: trace.outputTokens,
    failover: trace.outcome === "failover_success" || trace.attempts.length > 1,
  });

  const full: RequestTrace = { ...trace, id, attempts: trace.attempts };
  globalBus.emit("request", full);
  return full;
}

function bumpDailyUsage(opts: {
  workspaceId: string;
  keyId: string | null;
  modelId: string | null;
  inputTokens: number;
  outputTokens: number;
  failover: boolean;
}) {
  const db = getDb();
  const day = new Date().toISOString().slice(0, 10);
  const id = `${opts.workspaceId}:${day}:${opts.keyId ?? "-"}:${opts.modelId ?? "-"}`;
  const existing = db.select().from(dailyUsage).where(eq(dailyUsage.id, id)).all()[0];
  if (existing) {
    db.update(dailyUsage)
      .set({
        requests: existing.requests + 1,
        inputTokens: existing.inputTokens + opts.inputTokens,
        outputTokens: existing.outputTokens + opts.outputTokens,
        failovers: existing.failovers + (opts.failover ? 1 : 0),
      })
      .where(eq(dailyUsage.id, id))
      .run();
  } else {
    db.insert(dailyUsage)
      .values({
        id,
        workspaceId: opts.workspaceId,
        day,
        keyId: opts.keyId,
        modelId: opts.modelId,
        requests: 1,
        inputTokens: opts.inputTokens,
        outputTokens: opts.outputTokens,
        failovers: opts.failover ? 1 : 0,
      })
      .run();
  }
}

export function pruneRequests(retentionMs = REQUEST_RETENTION_MS) {
  const cutoff = Date.now() - retentionMs;
  if (!Number.isFinite(cutoff)) return;
  getDb().delete(requests).where(lt(requests.createdAt, cutoff)).run();
}

/** Encrypt any legacy plaintext prompt/response bodies already in the database. */
export function protectStoredBodies() {
  const db = getDb();
  const rows = db
    .select({
      id: requests.id,
      promptBody: requests.promptBody,
      responseBody: requests.responseBody,
    })
    .from(requests)
    .all();
  for (const row of rows) {
    const promptBody = reseal(row.promptBody);
    const responseBody = reseal(row.responseBody);
    if (promptBody === row.promptBody && responseBody === row.responseBody) continue;
    db.update(requests)
      .set({ promptBody, responseBody })
      .where(eq(requests.id, row.id))
      .run();
  }
  pruneRequests();
}

function reseal(value: string | null): string | null {
  if (value == null || value === "") return null;
  if (!isSealedText(value)) return sealText(value);
  return openText(value) == null ? null : value;
}

export interface ListRequestsFilter {
  limit?: number;
  offset?: number;
  model?: string;
  taskType?: string;
  outcome?: string;
  q?: string;
  workspaceId?: string;
}

export function listRequests(
  limitOrFilter: number | ListRequestsFilter = 100,
  workspaceIdArg = env.workspaceId,
): RequestTrace[] {
  const filter: ListRequestsFilter =
    typeof limitOrFilter === "number"
      ? { limit: limitOrFilter, workspaceId: workspaceIdArg }
      : limitOrFilter;
  const workspaceId = filter.workspaceId ?? workspaceIdArg;
  const db = getDb();
  const bounded = clampInt(filter.limit ?? 100, 100, 1, MAX_REQUEST_PAGE);
  const offset = clampInt(filter.offset ?? 0, 0, 0, 10_000);
  // Fetch a wider window then filter in memory — SQLite LIKE across JSON is awkward
  // and request volume is bounded by retention.
  const fetchN = Math.min(MAX_REQUEST_PAGE * 5, Math.max(bounded + offset, bounded * 3));
  let rows = db
    .select()
    .from(requests)
    .where(eq(requests.workspaceId, workspaceId))
    .orderBy(desc(requests.createdAt))
    .limit(fetchN)
    .all();

  if (filter.model) {
    const m = filter.model.toLowerCase();
    rows = rows.filter(
      (r) =>
        r.requestedModel.toLowerCase().includes(m) ||
        (r.chosenModel ?? "").toLowerCase().includes(m),
    );
  }
  if (filter.taskType) {
    const t = filter.taskType.toLowerCase();
    rows = rows.filter((r) => (r.taskType ?? "").toLowerCase() === t);
  }
  if (filter.outcome) {
    const o = filter.outcome.toLowerCase();
    rows = rows.filter((r) => (r.outcome ?? "").toLowerCase() === o);
  }
  if (filter.q) {
    const q = filter.q.toLowerCase();
    rows = rows.filter(
      (r) =>
        r.id.toLowerCase().includes(q) ||
        r.requestedModel.toLowerCase().includes(q) ||
        (r.chosenModel ?? "").toLowerCase().includes(q) ||
        (r.taskType ?? "").toLowerCase().includes(q) ||
        (r.outcome ?? "").toLowerCase().includes(q),
    );
  }

  return rows.slice(offset, offset + bounded).map((row) => ({
    id: row.id,
    workspaceId: row.workspaceId,
    keyId: row.keyId,
    requestedModel: row.requestedModel,
    chosenModel: row.chosenModel,
    taskType: row.taskType as RequestTrace["taskType"],
    complexity: row.complexity as RequestTrace["complexity"],
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    tokensEstimated: Boolean(row.tokensEstimated),
    ttftMs: row.ttftMs,
    durationMs: row.durationMs,
    outcome: row.outcome as RequestOutcome,
    ...parseAttempts(row.attemptsJson),
    createdAt: row.createdAt,
  }));
}

function parseAttempts(raw: string): {
  attempts: RoutingAttempt[];
  segments: TokenRoutingSegment[];
} {
  try {
    const parsed = JSON.parse(raw) as
      | RoutingAttempt[]
      | { attempts?: RoutingAttempt[]; segments?: TokenRoutingSegment[] };
    if (Array.isArray(parsed)) return { attempts: parsed, segments: [] };
    return {
      attempts: parsed.attempts ?? [],
      segments: parsed.segments ?? [],
    };
  } catch {
    return { attempts: [], segments: [] };
  }
}

export function usageByDay(days = 14, workspaceId = env.workspaceId) {
  const db = getDb();
  const windowDays = clampInt(days, 14, 1, MAX_USAGE_DAYS);
  const sinceDate = new Date(Date.now() - windowDays * 86_400_000);
  if (Number.isNaN(sinceDate.getTime())) return [];
  const since = sinceDate.toISOString().slice(0, 10);
  return db
    .select()
    .from(dailyUsage)
    .where(and(eq(dailyUsage.workspaceId, workspaceId), gte(dailyUsage.day, since)))
    .all();
}

export function getOverviewStats(governorStats?: {
  rpmUsed: number;
  rpmLimit: number;
  dailyRequests: number;
  dailyLimit: number;
  queueDepth: number;
}): OverviewStats {
  const db = getDb();
  const settings = getSettings();
  const since = Date.now() - 24 * 60 * 60_000;
  const recent = db
    .select()
    .from(requests)
    .where(and(eq(requests.workspaceId, env.workspaceId), gte(requests.createdAt, since)))
    .all();
  const success = recent.filter((r) =>
    r.outcome === "success" || r.outcome === "failover_success",
  ).length;
  const failovers = recent.filter((r) => {
    if (r.outcome === "failover_success") return true;
    try {
      const parsed = JSON.parse(r.attemptsJson) as
        | unknown[]
        | { attempts?: unknown[] };
      const attempts = Array.isArray(parsed) ? parsed : parsed.attempts ?? [];
      return attempts.length > 1;
    } catch {
      return false;
    }
  }).length;
  const tokensIn = recent.reduce((a, r) => a + r.inputTokens, 0);
  const tokensOut = recent.reduce((a, r) => a + r.outputTokens, 0);
  const chatModels = db
    .select({ c: sql<number>`count(*)` })
    .from(models)
    .where(and(eq(models.workspaceId, env.workspaceId), eq(models.kind, "chat"), eq(models.inCatalog, 1)))
    .all()[0]?.c ?? 0;
  const healthy = db
    .select({ c: sql<number>`count(*)` })
    .from(modelHealth)
    .where(and(eq(modelHealth.workspaceId, env.workspaceId), eq(modelHealth.status, "healthy")))
    .all()[0]?.c ?? 0;

  return {
    rpmUsed: governorStats?.rpmUsed ?? 0,
    rpmLimit: governorStats?.rpmLimit ?? settings.rpmLimit,
    dailyRequests: governorStats?.dailyRequests ?? recent.length,
    dailyLimit: governorStats?.dailyLimit ?? settings.dailyRequestLimit,
    tokensIn,
    tokensOut,
    successRate: recent.length ? success / recent.length : 1,
    failovers,
    queueDepth: governorStats?.queueDepth ?? 0,
    healthyModels: Number(healthy),
    totalChatModels: Number(chatModels),
  };
}
