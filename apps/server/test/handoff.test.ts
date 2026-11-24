import { describe, expect, it } from "vitest";
import { buildHandoffMessages, buildHandoffRequest } from "../src/router/handoff.js";

describe("handoff context", () => {
  it("includes original messages, partial draft, and continue instruction", () => {
    const msgs = buildHandoffMessages({
      originalMessages: [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Write a function" },
      ],
      partialText: "function foo() {\n  ",
      failedModelId: "nvidia/slow-model",
      reason: "idle timeout",
    });
    expect(msgs).toHaveLength(4);
    expect(msgs[2]).toMatchObject({
      role: "assistant",
      content: "function foo() {\n  ",
    });
    expect(String(msgs[3]!.content)).toContain("nemo-route handoff");
    expect(String(msgs[3]!.content)).toContain("idle timeout");
    expect(String(msgs[3]!.content)).toContain("Continue from the exact cutoff");
  });

  it("retries original ask when there is no partial draft", () => {
    const msgs = buildHandoffMessages({
      originalMessages: [{ role: "user", content: "hi" }],
      partialText: "",
      failedModelId: "a/b",
      reason: "idle timeout",
    });
    expect(msgs).toHaveLength(2);
    expect(String(msgs[1]!.content)).toContain("timed out before usable output");
  });

  it("preserves tools and sampling knobs on handoff request", () => {
    const req = buildHandoffRequest({
      modelId: "next/model",
      originalBody: {
        model: "old/model",
        messages: [{ role: "user", content: "x" }],
        tools: [{ type: "function", function: { name: "bash" } }],
        temperature: 0.2,
        max_tokens: 4096,
        stream: true,
      },
      messages: [{ role: "user", content: "handoff" }],
    });
    expect(req.model).toBe("next/model");
    expect(req.tools).toHaveLength(1);
    expect(req.temperature).toBe(0.2);
    expect(req.max_tokens).toBe(4096);
    expect(req.stream).toBe(true);
  });
});
