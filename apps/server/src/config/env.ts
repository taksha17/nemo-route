import { config as loadDotenv } from "dotenv";
import path from "node:path";
import fs from "node:fs";
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

export const DEFAULT_SETTINGS: WorkspaceSettings = {
  workspaceId: "local",
  rpmLimit: 40,
  dailyRequestLimit: 10_000,
  probeRpmBudget: 4,
  catalogPollMs: 5 * 60_000,
  timeouts: {
    lightTtftMs: 60_000,
    mediumTtftMs: 120_000,
    heavyTtftMs: 180_000,
    // Heavy NIM models can pause >60s between tokens; 60s looked like clean EOF
    // and OpenCode then failed with "stream ended without finish_reason".
    idleMs: 180_000,
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

function requireOperatorSecret(
  name: string,
  value: string | undefined,
  blocked: Set<string>,
): string {
  const secret = value?.trim() ?? "";
  if (secret.length < 16 || blocked.has(secret)) {
    throw new Error(
      `${name} must be a unique random value of at least 16 characters. ` +
        "Generate one with: node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64url'))\"",
    );
  }
  return secret;
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
    return requireOperatorSecret(
      "NEMO_ENCRYPTION_SECRET",
      process.env.NEMO_ENCRYPTION_SECRET,
      BLOCKED_ENCRYPTION_SECRETS,
    );
  },
  get adminToken() {
    return requireOperatorSecret(
      "NEMO_ADMIN_TOKEN",
      process.env.NEMO_ADMIN_TOKEN,
      BLOCKED_ADMIN_TOKENS,
    );
  },
  get nimBaseUrl() {
    return process.env.NIM_BASE_URL ?? "https://integrate.api.nvidia.com/v1";
  },
  get nimApiKey() {
    return process.env.NIM_API_KEY ?? "";
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
