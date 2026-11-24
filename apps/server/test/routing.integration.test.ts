import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("routing failover integration", () => {
  let mock: import("../src/mock/nimMockServer.js").NimMockServer;
  let executeChat: typeof import("../src/router/executor.js").executeChat;
  let NimClient: typeof import("../src/upstream/nimClient.js").NimClient;
  let closeDb: typeof import("../src/db/client.js").closeDb;
  let seedRegistry: typeof import("../src/scout/registry.js").seedRegistry;
  let upsertCatalogModel: typeof import("../src/scout/registry.js").upsertCatalogModel;
  let updateModelEntry: typeof import("../src/scout/registry.js").updateModelEntry;
  let recordSuccess: typeof import("../src/scout/health.js").recordSuccess;
  let tmp: string;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-route-"));
    process.env.NEMO_DATA_DIR = tmp;
    process.env.NEMO_ENCRYPTION_SECRET = "test-secret-for-routing";
    process.env.NIM_BASE_URL = "http://127.0.0.1:9/v1";

    // Re-import modules after env is set
    const clientMod = await import("../src/db/client.js");
    closeDb = clientMod.closeDb;
    closeDb();
    clientMod.getDb();

    const registry = await import("../src/scout/registry.js");
    seedRegistry = registry.seedRegistry;
    upsertCatalogModel = registry.upsertCatalogModel;
    updateModelEntry = registry.updateModelEntry;
    seedRegistry();

    const health = await import("../src/scout/health.js");
    recordSuccess = health.recordSuccess;

    const mockMod = await import("../src/mock/nimMockServer.js");
    mock = new mockMod.NimMockServer();
    await mock.start();
    mock.setModels([
      { id: "good/model-a", responseText: "from-a", owned_by: "good" },
      { id: "bad/model-b", fault: "403", owned_by: "bad" },
      { id: "good/model-c", responseText: "from-c", owned_by: "good" },
    ]);

    for (const id of ["good/model-a", "bad/model-b", "good/model-c"]) {
      upsertCatalogModel(id, id.split("/")[0]!);
      updateModelEntry(id, {
        kind: "chat",
        tools: true,
        inputs: ["text"],
        tier: "light",
        strengths: ["chat", "code"],
        curated: true,
        displayName: id,
        ownedBy: id.split("/")[0]!,
        contextTokens: 8192,
      });
      recordSuccess(id, 100, 50);
    }

    const execMod = await import("../src/router/executor.js");
    executeChat = execMod.executeChat;
    const nimMod = await import("../src/upstream/nimClient.js");
    NimClient = nimMod.NimClient;
    const { resetGovernors } = await import("../src/upstream/rateGovernor.js");
    resetGovernors();
  });

  afterAll(async () => {
    await mock.stop();
    closeDb();
  });

  it("fails over from 403 model to next available", async () => {
    const client = new NimClient({
      apiKey: "nvapi-test",
      baseUrl: mock.baseUrl,
      governorKey: "failover-test",
      rpmLimit: 100,
      probeRpmBudget: 20,
    });

    const result = await executeChat({
      client,
      body: {
        model: "bad/model-b",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
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
      requestedModel: "bad/model-b",
    });

    expect(result.chosenModel).not.toBe("bad/model-b");
    expect(["good/model-a", "good/model-c"]).toContain(result.chosenModel);
    const json = (await result.response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(json.choices[0]!.message.content).toMatch(/from-/);
    expect(result.attempts.length).toBeGreaterThanOrEqual(1);
  });
});
