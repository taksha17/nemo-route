import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

describe("selector importance routing", () => {
  beforeAll(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-sel-"));
    process.env.NEMO_DATA_DIR = tmp;
    process.env.NEMO_ENCRYPTION_SECRET = "test-secret-for-selector";
    const { env } = await import("../src/config/env.js");
    env.resetDataDirCache();
    const { closeDb, getDb } = await import("../src/db/client.js");
    closeDb();
    getDb();
    const { seedRegistry, upsertCatalogModel, updateModelEntry } = await import(
      "../src/scout/registry.js"
    );
    seedRegistry();
    const { recordSuccess } = await import("../src/scout/health.js");

    for (const id of [
      "nvidia/nemotron-3.5-bolt-e4b",
      "poolside/laguna-xs-2.1",
      "nvidia/nemotron-3.5-lightning-30b-a3b",
      "meta/muse-glimmer-30b",
      "moonshotai/kimi-k3.1-pro",
      "mistralai/mistral-large-4-1t-a52b",
    ]) {
      upsertCatalogModel(id, id.split("/")[0]!);
      const entry = (await import("../src/scout/registry.js")).getModelEntry(id);
      if (entry) {
        updateModelEntry(id, { ...entry, curated: true });
      }
      const slow = id.includes("kimi") || id.includes("mistral") || id.includes("ultra");
      recordSuccess(id, slow ? 40_000 : id.includes("lightning") ? 3000 : 200, slow ? 40_000 : 200);
    }
  });

  it("routes trivial hi away from kimi/heavy", async () => {
    const { analyzeRequest } = await import("../src/router/analyzer.js");
    const { selectFallbackChain } = await import("../src/router/selector.js");
    const analysis = analyzeRequest({
      messages: [
        { role: "system", content: "agent system with typescript python tools ".repeat(40) },
        { role: "user", content: "hi" },
      ],
      requestedModel: "nemo/auto",
    });
    expect(analysis.importance).toBe("trivial");
    const chain = selectFallbackChain({
      analysis,
      requestedModel: "nemo/auto",
    });
    expect(chain.length).toBeGreaterThan(0);
    expect(chain[0]).not.toMatch(/kimi|mistral-large|ultra/i);
    const top = chain[0]!;
    expect(["nvidia/nemotron-3.5-bolt-e4b", "poolside/laguna-xs-2.1"]).toContain(top);
  });

  it("does not send medium coding work to bolt by default", async () => {
    const { analyzeRequest } = await import("../src/router/analyzer.js");
    const { selectFallbackChain } = await import("../src/router/selector.js");
    const analysis = analyzeRequest({
      messages: [
        {
          role: "user",
          content:
            "Refactor this TypeScript service to use dependency injection and add unit tests:\n```ts\nexport class UserService { getUser(id: string) { return db.find(id) } }\n```",
        },
      ],
      requestedModel: "nemo/auto",
    });
    expect(analysis.taskType).toBe("code");
    expect(analysis.importance).not.toBe("trivial");
    const chain = selectFallbackChain({
      analysis,
      requestedModel: "nemo/auto",
    });
    expect(chain[0]).not.toBe("nvidia/nemotron-3.5-bolt-e4b");
  });
});
