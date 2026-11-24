import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ModelRegistryEntry, WorkspaceSettings } from "@nemo-route/shared";
import { env, DEFAULT_SETTINGS } from "../config/env.js";
import { safeEqualString } from "../crypto/secrets.js";
import {
  clearNimApiKey,
  getSettings,
  hasNimApiKey,
  saveSettings,
  setNimApiKey,
} from "../db/workspace.js";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  setKeyDebug,
} from "../gateway/keys.js";
import { listHealth, listRegistry, updateModelEntry } from "../scout/registry.js";
import {
  getOverviewStats,
  listRequests,
  usageByDay,
} from "../telemetry/recorder.js";
import { listLiveRouting, getLiveRouting } from "../telemetry/liveRouting.js";
import { getBootstrapStatus } from "../scout/health.js";
import type { AppContext } from "../appContext.js";
import { globalBus } from "./events.js";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { healthEvents } from "../db/schema.js";

function clampQuery(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function createAdminRouter(getCtx: () => AppContext) {
  const app = new Hono();

  app.use("*", async (c, next) => {
    const provided = c.req.header("x-nemo-admin-token") ?? "";
    let expected = "";
    try {
      expected = env.adminToken;
    } catch {
      return c.json({ error: "Unauthorized" }, 401);
    }
    if (!provided || !safeEqualString(provided, expected)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });

  app.get("/overview", (c) => {
    const ctx = getCtx();
    const client = ctx.getNimClient();
    const gov = client?.getGovernorStats();
    const registry = listRegistry().filter((m) => m.kind === "chat");
    const health = listHealth();
    const healthMap = new Map(health.map((h) => [h.modelId, h]));
    const modelStatus = registry.slice(0, 24).map((m) => ({
      id: m.id,
      displayName: m.displayName,
      tier: m.tier,
      status: healthMap.get(m.id)?.status ?? "unknown",
      avgTtftMs: healthMap.get(m.id)?.avgTtftMs ?? null,
      inCatalog: healthMap.get(m.id)?.inCatalog ?? true,
    }));
    return c.json({
      ...getOverviewStats(gov),
      hasNimKey: hasNimApiKey(),
      catalog: ctx.catalogSync.getStatus(),
      healthBootstrap: getBootstrapStatus(),
      modelStatus,
      governor: gov ?? null,
    });
  });

  app.get("/settings", (c) => c.json(getSettings()));

  app.put("/settings", async (c) => {
    const body = (await c.req.json()) as Partial<WorkspaceSettings>;
    const current = getSettings();
    const next: WorkspaceSettings = {
      ...current,
      ...body,
      workspaceId: env.workspaceId,
      timeouts: { ...current.timeouts, ...(body.timeouts ?? {}) },
      taskPreferences: {
        ...current.taskPreferences,
        ...(body.taskPreferences ?? {}),
      },
    };
    saveSettings(next);
    getCtx().invalidateClient();
    return c.json(next);
  });

  app.post("/setup/nim-key", async (c) => {
    const body = (await c.req.json()) as { apiKey?: string };
    const apiKey = body.apiKey?.trim();
    if (!apiKey) {
      return c.json({ error: "apiKey required" }, 400);
    }
    setNimApiKey(apiKey);
    getCtx().invalidateClient();
    // Validate quickly; do not block the UI on a slow catalog sync
    try {
      const client = getCtx().getNimClient();
      if (!client) {
        return c.json({ ok: false, hasNimKey: true, warning: "Client not ready" });
      }
      await Promise.race([
        client.listModels(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("NIM validation timed out after 15s")), 15_000),
        ),
      ]);
      // Immediate full health sweep — no unknown models after key save
      void getCtx().runBootstrap("nim-key-saved");
      return c.json({ ok: true, hasNimKey: true });
    } catch (err) {
      void getCtx().runBootstrap("nim-key-saved-with-warning");
      return c.json({
        ok: true,
        hasNimKey: true,
        warning: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.delete("/setup/nim-key", (c) => {
    clearNimApiKey();
    getCtx().invalidateClient();
    return c.json({ ok: true });
  });

  app.get("/models", (c) => {
    const registry = listRegistry();
    const health = listHealth();
    const healthMap = new Map(health.map((h) => [h.modelId, h]));
    return c.json({
      models: registry.map((m) => ({
        ...m,
        health: healthMap.get(m.id) ?? null,
      })),
    });
  });

  app.patch("/models/:id", async (c) => {
    const id = c.req.param("id");
    const patch = (await c.req.json()) as Partial<ModelRegistryEntry>;
    const updated = updateModelEntry(id, patch);
    if (!updated) return c.json({ error: "Not found" }, 404);
    return c.json(updated);
  });

  app.post("/models/:id/probe", async (c) => {
    const id = c.req.param("id");
    const ctx = getCtx();
    const client = ctx.getNimClient();
    if (!client) return c.json({ error: "NIM API key not configured" }, 503);
    const { recordProbe } = await import("../scout/health.js");
    try {
      const result = await client.probeModel(id);
      recordProbe(id, result.ok, result.latencyMs, result.status, result.error);
      return c.json({ ...result, ok: result.ok });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordProbe(id, false, 0, undefined, message);
      return c.json({ ok: false, error: message }, 502);
    }
  });

  app.get("/models/:id/events", (c) => {
    const id = c.req.param("id");
    const db = getDb();
    const events = db
      .select()
      .from(healthEvents)
      .where(eq(healthEvents.modelId, id))
      .orderBy(desc(healthEvents.createdAt))
      .limit(100)
      .all();
    return c.json({ events });
  });

  app.post("/catalog/sync", async (c) => {
    await getCtx().catalogSync.sync();
    return c.json(getCtx().catalogSync.getStatus());
  });

  app.post("/health/bootstrap", async (c) => {
    const result = await getCtx().runBootstrap("manual");
    return c.json({ ok: true, result, status: getBootstrapStatus() });
  });

  app.get("/token-routing", (c) => {
    const live = listLiveRouting();
    const recentRequests = listRequests(30).map((r) => ({
      requestId: r.id,
      requestedModel: r.requestedModel,
      chosenModel: r.chosenModel,
      taskType: r.taskType,
      complexity: r.complexity,
      startedAt: r.createdAt,
      endedAt: r.createdAt + r.durationMs,
      status: r.outcome === "error" ? "error" : "done",
      segments:
        r.segments && r.segments.length
          ? r.segments
          : r.attempts.map((a) => ({
              modelId: a.modelId,
              role: a.role ?? "primary",
              inputTokens: a.inputTokens ?? 0,
              outputTokens: a.outputTokens ?? 0,
              startedAt: a.startedAt,
              endedAt: a.endedAt,
              status: a.error ? "failed" : "success",
              label: a.label ?? a.modelId,
              error: a.error,
            })),
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
    }));
    return c.json({
      ...live,
      recentRequests,
    });
  });

  app.get("/token-routing/:id", (c) => {
    const id = c.req.param("id");
    const live = getLiveRouting(id);
    if (live) return c.json({ session: live });
    const req = listRequests(200).find((r) => r.id === id);
    if (!req) return c.json({ error: "Not found" }, 404);
    return c.json({
      session: {
        requestId: req.id,
        requestedModel: req.requestedModel,
        taskType: req.taskType,
        complexity: req.complexity,
        startedAt: req.createdAt,
        endedAt: req.createdAt + req.durationMs,
        status: req.outcome === "error" ? "error" : "done",
        chosenModel: req.chosenModel,
        segments: req.segments ?? [],
      },
    });
  });

  app.get("/keys", (c) => c.json({ keys: listApiKeys() }));

  app.post("/keys", async (c) => {
    const body = (await c.req.json()) as { label?: string };
    const created = createApiKey(body.label || "default");
    return c.json({ key: created.info, rawKey: created.rawKey });
  });

  app.post("/keys/:id/revoke", (c) => {
    revokeApiKey(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/keys/:id/debug", async (c) => {
    const body = (await c.req.json()) as { enabled?: boolean };
    setKeyDebug(c.req.param("id"), Boolean(body.enabled));
    return c.json({ ok: true });
  });

  app.get("/requests", (c) => {
    const limit = clampQuery(c.req.query("limit"), 100, 1, 200);
    const offset = clampQuery(c.req.query("offset"), 0, 0, 10_000);
    const requests = listRequests({
      limit,
      offset,
      model: c.req.query("model") ?? undefined,
      taskType: c.req.query("taskType") ?? undefined,
      outcome: c.req.query("outcome") ?? undefined,
      q: c.req.query("q") ?? undefined,
    });
    return c.json({ requests, limit, offset });
  });

  app.get("/usage", (c) => {
    const days = clampQuery(c.req.query("days"), 14, 1, 366);
    const ctx = getCtx();
    const gov = ctx.getNimClient()?.getGovernorStats() ?? null;
    return c.json({ usage: usageByDay(days), governor: gov });
  });

  app.get("/usage/export", (c) => {
    const days = clampQuery(c.req.query("days"), 14, 1, 366);
    const rows = usageByDay(days);
    const header = "day,workspaceId,requests,inputTokens,outputTokens,failovers\n";
    const body = rows
      .map(
        (r) =>
          `${r.day},${r.workspaceId},${r.requests},${r.inputTokens},${r.outputTokens},${r.failovers ?? 0}`,
      )
      .join("\n");
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header(
      "Content-Disposition",
      `attachment; filename="nemo-usage-${days}d.csv"`,
    );
    return c.body(header + body + (body ? "\n" : ""));
  });

  app.get("/events", (c) => {
    return streamSSE(c, async (stream) => {
      const unsub = globalBus.on("*", (payload) => {
        void stream.writeSSE({
          event: "nemo",
          data: JSON.stringify(payload),
        });
      });
      await stream.writeSSE({
        event: "ready",
        data: JSON.stringify({ ok: true, defaults: DEFAULT_SETTINGS }),
      });
      // keep alive
      const timer = setInterval(() => {
        void stream.writeSSE({ event: "ping", data: "{}" });
      }, 15_000);
      c.req.raw.signal.addEventListener("abort", () => {
        clearInterval(timer);
        unsub();
      });
      // hold until aborted
      await new Promise<void>((resolve) => {
        c.req.raw.signal.addEventListener("abort", () => resolve());
      });
    });
  });

  app.get("/harness-snippets", (c) => {
    const base = `http://${env.host}:${env.port}`;
    return c.json({
      openai: {
        baseUrl: `${base}/v1`,
        env: [
          `OPENAI_BASE_URL=${base}/v1`,
          "OPENAI_API_KEY=nemo-sk-...",
        ],
      },
      claudeCode: {
        baseUrl: base,
        env: [
          `ANTHROPIC_BASE_URL=${base}`,
          "ANTHROPIC_API_KEY=nemo-sk-...",
          "ANTHROPIC_DEFAULT_SONNET_MODEL=nemo/auto",
          "ANTHROPIC_DEFAULT_OPUS_MODEL=nemo/auto",
          "ANTHROPIC_DEFAULT_HAIKU_MODEL=nemo/fast",
        ],
      },
      opencode: {
        baseUrl: `${base}/v1`,
        notes: "Point the OpenAI-compatible provider at Nemo-route /v1",
      },
    });
  });

  return app;
}
