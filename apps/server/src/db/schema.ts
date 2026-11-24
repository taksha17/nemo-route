import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: integer("created_at").notNull(),
  nimKeyCiphertext: text("nim_key_ciphertext"),
  nimKeyIv: text("nim_key_iv"),
  nimKeyTag: text("nim_key_tag"),
  settingsJson: text("settings_json").notNull(),
});

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    label: text("label").notNull(),
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    createdAt: integer("created_at").notNull(),
    revokedAt: integer("revoked_at"),
    lastUsedAt: integer("last_used_at"),
    debugBodies: integer("debug_bodies").notNull().default(0),
  },
  (t) => ({
    workspaceIdx: index("api_keys_workspace_idx").on(t.workspaceId),
    hashIdx: index("api_keys_hash_idx").on(t.keyHash),
  }),
);

export const models = sqliteTable(
  "models",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    ownedBy: text("owned_by").notNull(),
    displayName: text("display_name").notNull(),
    kind: text("kind").notNull(),
    inputsJson: text("inputs_json").notNull(),
    tools: integer("tools").notNull().default(0),
    contextTokens: integer("context_tokens").notNull().default(8192),
    tier: text("tier").notNull().default("medium"),
    strengthsJson: text("strengths_json").notNull(),
    curated: integer("curated").notNull().default(0),
    notes: text("notes"),
    inCatalog: integer("in_catalog").notNull().default(1),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    workspaceIdx: index("models_workspace_idx").on(t.workspaceId),
  }),
);

export const modelHealth = sqliteTable(
  "model_health",
  {
    modelId: text("model_id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    status: text("status").notNull().default("unknown"),
    lastSuccessAt: integer("last_success_at"),
    lastFailureAt: integer("last_failure_at"),
    lastProbeAt: integer("last_probe_at"),
    avgLatencyMs: real("avg_latency_ms"),
    avgTtftMs: real("avg_ttft_ms"),
    errorRate: real("error_rate").notNull().default(0),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    circuitOpenUntil: integer("circuit_open_until"),
    successCount: integer("success_count").notNull().default(0),
    failureCount: integer("failure_count").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    workspaceIdx: index("model_health_workspace_idx").on(t.workspaceId),
  }),
);

export const healthEvents = sqliteTable(
  "health_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    modelId: text("model_id").notNull(),
    status: text("status").notNull(),
    reason: text("reason"),
    latencyMs: integer("latency_ms"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    modelIdx: index("health_events_model_idx").on(t.modelId, t.createdAt),
  }),
);

export const requests = sqliteTable(
  "requests",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    keyId: text("key_id"),
    requestedModel: text("requested_model").notNull(),
    chosenModel: text("chosen_model"),
    taskType: text("task_type"),
    complexity: text("complexity"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    tokensEstimated: integer("tokens_estimated").notNull().default(0),
    ttftMs: integer("ttft_ms"),
    durationMs: integer("duration_ms").notNull().default(0),
    outcome: text("outcome").notNull(),
    attemptsJson: text("attempts_json").notNull().default("[]"),
    promptBody: text("prompt_body"),
    responseBody: text("response_body"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    workspaceIdx: index("requests_workspace_idx").on(t.workspaceId, t.createdAt),
    keyIdx: index("requests_key_idx").on(t.keyId, t.createdAt),
    modelIdx: index("requests_model_idx").on(t.chosenModel, t.createdAt),
  }),
);

export const dailyUsage = sqliteTable(
  "daily_usage",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    day: text("day").notNull(),
    keyId: text("key_id"),
    modelId: text("model_id"),
    requests: integer("requests").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    failovers: integer("failovers").notNull().default(0),
  },
  (t) => ({
    dayIdx: index("daily_usage_day_idx").on(t.workspaceId, t.day),
  }),
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    stickyModelId: text("sticky_model_id"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    workspaceIdx: index("sessions_workspace_idx").on(t.workspaceId),
  }),
);
