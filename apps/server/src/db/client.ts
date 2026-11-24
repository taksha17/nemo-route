import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { env, DEFAULT_SETTINGS } from "../config/env.js";
import * as schema from "./schema.js";
import { encryptSecret } from "../crypto/secrets.js";

let sqlite: Database.Database | null = null;
let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  nim_key_ciphertext TEXT,
  nim_key_iv TEXT,
  nim_key_tag TEXT,
  settings_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  label TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER,
  debug_bodies INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS api_keys_workspace_idx ON api_keys(workspace_id);
CREATE INDEX IF NOT EXISTS api_keys_hash_idx ON api_keys(key_hash);

CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  owned_by TEXT NOT NULL,
  display_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  inputs_json TEXT NOT NULL,
  tools INTEGER NOT NULL DEFAULT 0,
  context_tokens INTEGER NOT NULL DEFAULT 8192,
  tier TEXT NOT NULL DEFAULT 'medium',
  strengths_json TEXT NOT NULL,
  curated INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  in_catalog INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS models_workspace_idx ON models(workspace_id);

CREATE TABLE IF NOT EXISTS model_health (
  model_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  status TEXT NOT NULL DEFAULT 'unknown',
  last_success_at INTEGER,
  last_failure_at INTEGER,
  last_probe_at INTEGER,
  avg_latency_ms REAL,
  avg_ttft_ms REAL,
  error_rate REAL NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  circuit_open_until INTEGER,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS model_health_workspace_idx ON model_health(workspace_id);

CREATE TABLE IF NOT EXISTS health_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  model_id TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  latency_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS health_events_model_idx ON health_events(model_id, created_at);

CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  key_id TEXT,
  requested_model TEXT NOT NULL,
  chosen_model TEXT,
  task_type TEXT,
  complexity TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  tokens_estimated INTEGER NOT NULL DEFAULT 0,
  ttft_ms INTEGER,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL,
  attempts_json TEXT NOT NULL DEFAULT '[]',
  prompt_body TEXT,
  response_body TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS requests_workspace_idx ON requests(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS requests_key_idx ON requests(key_id, created_at);
CREATE INDEX IF NOT EXISTS requests_model_idx ON requests(chosen_model, created_at);

CREATE TABLE IF NOT EXISTS daily_usage (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  day TEXT NOT NULL,
  key_id TEXT,
  model_id TEXT,
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  failovers INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS daily_usage_day_idx ON daily_usage(workspace_id, day);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  sticky_model_id TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_workspace_idx ON sessions(workspace_id);
`;

export function getDb() {
  if (!db) {
    fs.mkdirSync(path.dirname(env.dbPath), { recursive: true });
    sqlite = new Database(env.dbPath);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec(MIGRATION_SQL);
    db = drizzle(sqlite, { schema });
    ensureLocalWorkspace();
  }
  return db;
}

export function getSqlite(): Database.Database {
  getDb();
  return sqlite!;
}

function ensureLocalWorkspace() {
  const existing = getSqlite()
    .prepare("SELECT id FROM workspaces WHERE id = ?")
    .get(env.workspaceId) as { id: string } | undefined;

  if (!existing) {
    const now = Date.now();
    let ciphertext: string | null = null;
    let iv: string | null = null;
    let tag: string | null = null;
    if (env.nimApiKey) {
      const enc = encryptSecret(env.nimApiKey);
      ciphertext = enc.ciphertext;
      iv = enc.iv;
      tag = enc.tag;
    }
    getSqlite()
      .prepare(
        `INSERT INTO workspaces (id, name, created_at, nim_key_ciphertext, nim_key_iv, nim_key_tag, settings_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        env.workspaceId,
        "Local",
        now,
        ciphertext,
        iv,
        tag,
        JSON.stringify(DEFAULT_SETTINGS),
      );
  } else if (env.nimApiKey) {
    const enc = encryptSecret(env.nimApiKey);
    getSqlite()
      .prepare(
        `UPDATE workspaces SET nim_key_ciphertext = ?, nim_key_iv = ?, nim_key_tag = ? WHERE id = ?`,
      )
      .run(enc.ciphertext, enc.iv, enc.tag, env.workspaceId);
  }
}

export function closeDb() {
  if (sqlite) {
    sqlite.close();
    sqlite = null;
    db = null;
  }
}
