import { config as loadDotenv } from "dotenv";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import type { WorkspaceSettings } from "@nemo-route/shared";

loadDotenv({ path: path.resolve(process.cwd(), "../../.env") });
loadDotenv();

function resolveDataDir(): string {
  const raw = process.env.NEMO_DATA_DIR;
  let preferred: string;
  if (raw) {
    preferred = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  } else {
    // Prefer repo-root data when running from apps/server
    preferred = path.resolve(process.cwd(), "../../data");
  }
  fs.mkdirSync(preferred, { recursive: true });
  return preferred;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

const lightTtftMs = envInt("NEMO_LIGHT_TTFT_MS", 60_000);
const mediumTtftMs = envInt("NEMO_MEDIUM_TTFT_MS", 120_000);
const heavyTtftMs = envInt("NEMO_HEAVY_TTFT_MS", 180_000);
const idleMs = envInt(
  "NEMO_IDLE_MS",
  envInt("NEMO_LIVE_ROUTING_IDLE_MS", 180_000),
);

export const DEFAULT_SETTINGS: WorkspaceSettings = {
  workspaceId: "local",
  rpmLimit: 40,
  dailyRequestLimit: 10_000,
  probeRpmBudget: 4,
  catalogPollMs: 5 * 60_000,
  timeouts: {
    lightTtftMs,
    mediumTtftMs,
    heavyTtftMs,
    // Heavy NIM models can pause >60s between tokens; 60s looked like clean EOF
    // and OpenCode then failed with "stream ended without finish_reason".
    idleMs,
  },
  partialStreamBehavior: "continue",
  taskPreferences: {
    code: [
      "poolside/laguna-xs-2.1",
      "z-ai/glm-5.3-flash",
      "nvidia/nemotron-3.5-lightning-30b-a3b",
      "google/gemma-4-31b-it",
      "moonshotai/kimi-k3.1-pro",
    ],
    reasoning: [
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
      "nvidia/nemotron-3.5-lightning-30b-a3b",
      "stepfun-ai/step-5-preview",
      "nvidia/nemotron-3-ultra-550b-a55b",
      "mistralai/mistral-large-4-1t-a52b",
    ],
    chat: [
      "nvidia/nemotron-3.5-lightning-30b-a3b",
      "meta/muse-glimmer-30b",
      "minimaxai/minimax-m3.1-flash",
      "z-ai/glm-5.3-flash",
      "google/gemma-4-31b-it",
      "nvidia/nemotron-3.5-bolt-e4b",
    ],
    // Hosted NIM only enables multimodal on true VL/omni profiles — not Gemma chat.
    vision: [
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
      "nvidia/nemotron-3.5-super-vl-120b-a12b",
      "nvidia/cosmos-reason2-8b",
    ],
  },
};

let cachedDataDir: string | null = null;

const BLOCKED_ENCRYPTION_SECRETS = new Set([
  "dev-only-change-me-nemo-route-secret",
  "dev-local-nemo-route-secret-change-in-prod",
  "change-me-to-a-long-random-string",
  "nemo-route-v1",
]);

const BLOCKED_ADMIN_TOKENS = new Set([
  "local-admin-token",
  "change-me",
  "admin",
  "password",
]);

interface OperatorSecretsFile {
  encryptionSecret?: string;
  adminToken?: string;
}

function secretsFilePath(dataDir: string) {
  return path.join(dataDir, ".nemo-operator.json");
}

function readPersistedSecrets(dataDir: string): OperatorSecretsFile {
  const file = secretsFilePath(dataDir);
  try {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, "utf8")) as OperatorSecretsFile;
  } catch {
    return {};
  }
}

function writePersistedSecrets(dataDir: string, next: OperatorSecretsFile) {
  const file = secretsFilePath(dataDir);
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

function generateSecret(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * Resolve an operator secret:
 * 1) Use env when set to a strong unique value
 * 2) Else reuse persisted auto-generated value in dataDir
 * 3) Else generate, persist, and log
 *
 * Explicitly setting a blocked/short env value still throws (security).
 */
function resolveOperatorSecret(
  name: "NEMO_ENCRYPTION_SECRET" | "NEMO_ADMIN_TOKEN",
  envValue: string | undefined,
  blocked: Set<string>,
  persistKey: keyof OperatorSecretsFile,
): string {
  const fromEnv = envValue?.trim() ?? "";
  if (fromEnv) {
    if (fromEnv.length < 16 || blocked.has(fromEnv)) {
      throw new Error(
        `${name} must be a unique random value of at least 16 characters. ` +
          "Generate one with: node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64url'))\"",
      );
    }
    return fromEnv;
  }

  const dataDir = cachedDataDir ?? resolveDataDir();
  cachedDataDir = dataDir;
  const persisted = readPersistedSecrets(dataDir);
  const existing = persisted[persistKey]?.trim() ?? "";
  if (existing.length >= 16 && !blocked.has(existing)) {
    return existing;
  }

  const generated = generateSecret();
  writePersistedSecrets(dataDir, { ...persisted, [persistKey]: generated });
  console.warn(
    `[nemo-route] ${name} was unset — generated and saved to ${secretsFilePath(dataDir)}. ` +
      "Set it in .env for production so it survives data-dir wipes.",
  );
  return generated;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

export const env = {
  host: process.env.NEMO_HOST ?? "127.0.0.1",
  port: Number(process.env.NEMO_PORT ?? 8788),
  get dataDir() {
    if (!cachedDataDir) cachedDataDir = resolveDataDir();
    return cachedDataDir;
  },
  get encryptionSecret() {
    return resolveOperatorSecret(
      "NEMO_ENCRYPTION_SECRET",
      process.env.NEMO_ENCRYPTION_SECRET,
      BLOCKED_ENCRYPTION_SECRETS,
      "encryptionSecret",
    );
  },
  get adminToken() {
    return resolveOperatorSecret(
      "NEMO_ADMIN_TOKEN",
      process.env.NEMO_ADMIN_TOKEN,
      BLOCKED_ADMIN_TOKENS,
      "adminToken",
    );
  },
  get nimBaseUrl() {
    return process.env.NIM_BASE_URL ?? "https://integrate.api.nvidia.com/v1";
  },
  get nimApiKey() {
    return process.env.NIM_API_KEY ?? "";
  },
  get skipBootstrap() {
    const v = (process.env.NEMO_SKIP_BOOTSTRAP ?? "").trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes";
  },
  workspaceId: "local",
  get dbPath() {
    return path.join(this.dataDir, "nemo.db");
  },
  /** Test helper: clear cached paths after changing NEMO_DATA_DIR */
  resetDataDirCache() {
    cachedDataDir = null;
  },
};
