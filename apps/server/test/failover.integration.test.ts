import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NimMockServer } from "../src/mock/nimMockServer.js";
import { NimClient, NimHttpError } from "../src/upstream/nimClient.js";
import { resetGovernors } from "../src/upstream/rateGovernor.js";

describe("NIM client against mock server", () => {
  const mock = new NimMockServer();
  let client: NimClient;

  beforeAll(async () => {
    resetGovernors();
    await mock.start();
    mock.setModels([
      { id: "good/model", responseText: "ok-good" },
      { id: "bad/forbidden", fault: "403" },
      { id: "bad/server", fault: "500" },
      { id: "slow/model", fault: "slow_start", delayMs: 200, responseText: "ok-slow" },
    ]);
    client = new NimClient({
      apiKey: "nvapi-test",
      baseUrl: mock.baseUrl,
      governorKey: "test-gov",
      rpmLimit: 100,
      dailyLimit: 10_000,
      probeRpmBudget: 20,
    });
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("lists models", async () => {
    const listing = await client.listModels();
    expect(listing.data.some((m) => m.id === "good/model")).toBe(true);
  });

  it("completes successfully", async () => {
    const res = await client.chatCompletions({
      model: "good/model",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
    const json = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(json.choices[0]!.message.content).toContain("ok-good");
  });

  it("surfaces 403", async () => {
    await expect(
      client.chatCompletions({
        model: "bad/forbidden",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toBeInstanceOf(NimHttpError);
  });

  it("surfaces 500", async () => {
    await expect(
      client.chatCompletions({
        model: "bad/server",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toMatchObject({ status: 500 });
  });

  it("streams chunks", async () => {
    const res = await client.chatCompletions({
      model: "good/model",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    const text = await res.text();
    expect(text).toContain("data:");
    expect(text).toContain("[DONE]");
  });

  it("handles slow start", async () => {
    const res = await client.chatCompletions({
      model: "slow/model",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
    const json = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(json.choices[0]!.message.content).toContain("ok-slow");
  });
});

describe("crypto helpers", () => {
  it("encrypts and decrypts secrets in temp env", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-"));
    process.env.NEMO_DATA_DIR = tmp;
    process.env.NEMO_ENCRYPTION_SECRET = "test-secret-for-unit";
    const { encryptSecret, decryptSecret } = await import("../src/crypto/secrets.js");
    const enc = encryptSecret("nvapi-hello");
    expect(decryptSecret(enc.ciphertext, enc.iv, enc.tag)).toBe("nvapi-hello");
  });
});
