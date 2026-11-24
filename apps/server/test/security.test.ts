import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import type { AppContext } from "../src/appContext.js";
import { createAdminRouter } from "../src/admin/api.js";
import { env } from "../src/config/env.js";
import { decryptSecret, encryptSecret, openText } from "../src/crypto/secrets.js";
import { closeDb, getDb, getSqlite } from "../src/db/client.js";
import { installGatewayCors } from "../src/http/cors.js";
import {
  protectStoredBodies,
  recordRequest,
  usageByDay,
} from "../src/telemetry/recorder.js";

const token = process.env.NEMO_ADMIN_TOKEN ?? "";

function adminApp() {
  const app = new Hono();
  installGatewayCors(app);
  const ctx = {
    getNimClient: () => null,
    invalidateClient() {},
    catalogSync: { getStatus: () => ({ phase: "idle" }) },
    runBootstrap: async () => ({}),
  } as unknown as AppContext;
  app.route("/admin", createAdminRouter(() => ctx));
  app.get("/v1/models", (c) => c.json({ ok: true }));
  return app;
}

describe("admin authentication and secret storage", () => {
  afterAll(() => {
    closeDb();
  });

  it("rejects a missing admin token and does not emit wildcard CORS", async () => {
    getDb();
    const res = await adminApp().request("http://127.0.0.1/admin/overview", {
      headers: { Origin: "https://evil.example" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects a wrong token and a token supplied in the query string", async () => {
    const app = adminApp();
    const wrong = await app.request("http://127.0.0.1/admin/overview", {
      headers: { "x-nemo-admin-token": "not-the-admin-token" },
    });
    expect(wrong.status).toBe(401);

    const queried = await app.request(
      `http://127.0.0.1/admin/overview?token=${encodeURIComponent(token)}`,
    );
    expect(queried.status).toBe(401);
  });

  it("accepts the header token and allows wildcard CORS only on /v1", async () => {
    const app = adminApp();
    const ok = await app.request("http://127.0.0.1/admin/overview", {
      headers: { "x-nemo-admin-token": token },
    });
    expect(ok.status).toBe(200);

    const gateway = await app.request("http://127.0.0.1/v1/models", {
      headers: { Origin: "https://example.test" },
    });
    expect(gateway.headers.get("access-control-allow-origin")).toBe("*");

    const preflight = await app.request("http://127.0.0.1/admin/keys", {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "x-nemo-admin-token",
      },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("clamps invalid admin query parameters instead of throwing", async () => {
    const app = adminApp();
    const headers = { "x-nemo-admin-token": token };
    const usage = await app.request("http://127.0.0.1/admin/usage?days=NaN", { headers });
    expect(usage.status).toBe(200);
    const requests = await app.request("http://127.0.0.1/admin/requests?limit=999999", {
      headers,
    });
    expect(requests.status).toBe(200);
    expect(() => usageByDay(Number.NaN)).not.toThrow();
  });

  it("seals secrets with a fresh salt and refuses the old fixed-salt format", () => {
    const first = encryptSecret("nvapi-test-value");
    const second = encryptSecret("nvapi-test-value");
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(decryptSecret(first.ciphertext, first.iv, first.tag)).toBe("nvapi-test-value");

    const legacyKey = scryptSync(env.encryptionSecret, "nemo-route-v1", 32);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", legacyKey, iv);
    const encrypted = Buffer.concat([
      cipher.update("nvapi-legacy", "utf8"),
      cipher.final(),
    ]);
    expect(() =>
      decryptSecret(encrypted.toString("base64"), iv.toString("base64"), cipher.getAuthTag().toString("base64")),
    ).toThrow();
  });

  it("refuses shipped default secrets when explicitly set", () => {
    const previousEncryption = process.env.NEMO_ENCRYPTION_SECRET;
    const previousAdmin = process.env.NEMO_ADMIN_TOKEN;
    process.env.NEMO_ENCRYPTION_SECRET = "dev-local-nemo-route-secret-change-in-prod";
    process.env.NEMO_ADMIN_TOKEN = "local-admin-token";
    expect(() => env.encryptionSecret).toThrow(/NEMO_ENCRYPTION_SECRET/);
    expect(() => env.adminToken).toThrow(/NEMO_ADMIN_TOKEN/);
    process.env.NEMO_ENCRYPTION_SECRET = previousEncryption;
    process.env.NEMO_ADMIN_TOKEN = previousAdmin;
  });

  it("auto-generates secrets when env vars are unset", () => {
    const previousEncryption = process.env.NEMO_ENCRYPTION_SECRET;
    const previousAdmin = process.env.NEMO_ADMIN_TOKEN;
    const previousData = process.env.NEMO_DATA_DIR;
    const dir = path.join(os.tmpdir(), `nemo-secret-test-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    process.env.NEMO_DATA_DIR = dir;
    delete process.env.NEMO_ENCRYPTION_SECRET;
    delete process.env.NEMO_ADMIN_TOKEN;
    env.resetDataDirCache();
    const enc = env.encryptionSecret;
    const admin = env.adminToken;
    expect(enc.length).toBeGreaterThanOrEqual(16);
    expect(admin.length).toBeGreaterThanOrEqual(16);
    expect(fs.existsSync(path.join(dir, ".nemo-operator.json"))).toBe(true);
    // Stable across reads
    expect(env.encryptionSecret).toBe(enc);
    expect(env.adminToken).toBe(admin);
    process.env.NEMO_ENCRYPTION_SECRET = previousEncryption;
    process.env.NEMO_ADMIN_TOKEN = previousAdmin;
    if (previousData == null) delete process.env.NEMO_DATA_DIR;
    else process.env.NEMO_DATA_DIR = previousData;
    env.resetDataDirCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("stores debug bodies encrypted and drops rows past the retention window", () => {
    getDb();
    const saved = recordRequest({
      workspaceId: env.workspaceId,
      keyId: null,
      requestedModel: "nemo/auto",
      chosenModel: "test/model",
      taskType: "chat",
      complexity: "low",
      inputTokens: 4,
      outputTokens: 4,
      tokensEstimated: true,
      ttftMs: 10,
      durationMs: 20,
      outcome: "success",
      attempts: [],
      createdAt: Date.now(),
      promptBody: "super-secret-prompt",
      responseBody: "super-secret-response",
    });
    const fresh = getSqlite()
      .prepare("SELECT prompt_body, response_body FROM requests WHERE id = ?")
      .get(saved.id) as { prompt_body: string; response_body: string };
    expect(fresh.prompt_body.startsWith("enc:v1:")).toBe(true);
    expect(fresh.prompt_body).not.toContain("super-secret-prompt");
    expect(fresh.response_body).not.toContain("super-secret-response");
    expect(openText(fresh.prompt_body)).toBe("super-secret-prompt");

    getSqlite()
      .prepare("UPDATE requests SET prompt_body = ? WHERE id = ?")
      .run("plaintext-marker", saved.id);
    protectStoredBodies();
    const resealed = getSqlite()
      .prepare("SELECT prompt_body FROM requests WHERE id = ?")
      .get(saved.id) as { prompt_body: string };
    expect(resealed.prompt_body.startsWith("enc:v1:")).toBe(true);
    expect(resealed.prompt_body).not.toContain("plaintext-marker");

    const stale = recordRequest({
      workspaceId: env.workspaceId,
      keyId: null,
      requestedModel: "nemo/auto",
      chosenModel: "test/model",
      taskType: "chat",
      complexity: "low",
      inputTokens: 1,
      outputTokens: 1,
      tokensEstimated: true,
      ttftMs: 1,
      durationMs: 1,
      outcome: "success",
      attempts: [],
      createdAt: Date.now() - 40 * 24 * 60 * 60 * 1000,
      promptBody: "expired-prompt",
    });
    const gone = getSqlite().prepare("SELECT id FROM requests WHERE id = ?").get(stale.id);
    expect(gone).toBeUndefined();
  });
});

describe("failover amplification cap", () => {
  let mock: import("../src/mock/nimMockServer.js").NimMockServer;

  afterAll(async () => {
    await mock?.stop();
  });

  it("stops mid-stream handoff within three upstream calls", async () => {
    const mockMod = await import("../src/mock/nimMockServer.js");
    mock = new mockMod.NimMockServer();
    await mock.start();
    const ids = Array.from({ length: 8 }, (_, i) => `drop/model-${i}`);
    mock.setModels(ids.map((id) => ({ id, fault: "mid_stream_drop" as const, responseText: "partial" })));

    const { upsertCatalogModel, updateModelEntry } = await import("../src/scout/registry.js");
    const { recordSuccess } = await import("../src/scout/health.js");
    for (const id of ids) {
      upsertCatalogModel(id, "drop");
      updateModelEntry(id, {
        kind: "chat",
        tools: true,
        inputs: ["text"],
        tier: "light",
        strengths: ["chat"],
        curated: true,
        displayName: id,
        ownedBy: "drop",
        contextTokens: 8192,
      });
      recordSuccess(id, 20, 20);
    }

    const { executeChat } = await import("../src/router/executor.js");
    const { NimClient } = await import("../src/upstream/nimClient.js");
    const { resetGovernors } = await import("../src/upstream/rateGovernor.js");
    resetGovernors();
    mock.requestLog.length = 0;

    const client = new NimClient({
      apiKey: "nvapi-test",
      baseUrl: mock.baseUrl,
      governorKey: "amplification-cap",
      rpmLimit: 100,
      probeRpmBudget: 20,
    });
    try {
      const result = await executeChat({
        client,
        body: {
          model: ids[0]!,
          messages: [{ role: "user", content: "hello" }],
          stream: true,
          max_tokens: 32,
        },
        analysis: {
          taskType: "chat",
          complexity: "low",
          requiresTools: false,
          requiresVision: false,
          estimatedInputTokens: 4,
          confidence: 1,
          method: "forced",
        },
        requestedModel: ids[0]!,
        trackLive: false,
      });
      await result.response.text();
    } catch {
      // Every mock model drops the socket, so the capped chain ends in an error.
    }

    const calls = mock.requestLog.filter((entry) => entry.path === "/v1/chat/completions");
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.length).toBeLessThanOrEqual(3);
  });
});
