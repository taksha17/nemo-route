import { describe, expect, it } from "vitest";
import { analyzeRequest, isTrivialPrompt } from "../src/router/analyzer.js";

describe("analyzer", () => {
  it("detects code tasks from the latest user turn", () => {
    const result = analyzeRequest({
      messages: [
        {
          role: "system",
          content: "You are a long system prompt with typescript python javascript words ".repeat(50),
        },
        {
          role: "user",
          content: "Fix this TypeScript bug:\n```ts\nconst x: number = 'a'\n```",
        },
      ],
    });
    expect(result.taskType).toBe("code");
  });

  it("treats hi/how are you as trivial low chat", () => {
    for (const prompt of ["hi", "hello!", "how are you?", "thanks"]) {
      const result = analyzeRequest({
        messages: [
          { role: "system", content: "huge agent system prompt with code tools ".repeat(80) },
          { role: "user", content: prompt },
        ],
        requestedModel: "nemo/auto",
      });
      expect(result.importance).toBe("trivial");
      expect(result.complexity).toBe("low");
      expect(result.taskType).toBe("chat");
    }
  });

  it("does not let system prompt turn a greeting into code", () => {
    const result = analyzeRequest({
      messages: [
        {
          role: "system",
          content: "Use tools. Write typescript python functions. refactor compile bug.",
        },
        { role: "user", content: "hi" },
      ],
      requestedModel: "nemo/auto",
    });
    expect(result.taskType).toBe("chat");
    expect(result.importance).toBe("trivial");
  });

  it("detects vision requirements", () => {
    const result = analyzeRequest({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is in this image?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,xx" } },
          ],
        },
      ],
    });
    expect(result.requiresVision).toBe(true);
    expect(result.taskType).toBe("vision");
  });

  it("detects OpenCode file image parts", () => {
    const result = analyzeRequest({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "read this screenshot" },
            { type: "file", mediaType: "image/png", data: "abc" },
          ],
        },
      ],
    });
    expect(result.requiresVision).toBe(true);
  });

  it("honors virtual model force", () => {
    const result = analyzeRequest({
      messages: [{ role: "user", content: "hello" }],
      requestedModel: "nemo/reasoning",
    });
    expect(result.taskType).toBe("reasoning");
    expect(result.method).toBe("forced");
  });

  it("marks tool loops", () => {
    const result = analyzeRequest({
      messages: [
        { role: "user", content: "run ls" },
        { role: "assistant", content: null, tool_calls: [{ id: "1" }] },
        { role: "tool", content: "ok" },
      ],
      tools: [{ type: "function" }],
    });
    expect(result.requiresTools).toBe(true);
  });

  it("isTrivialPrompt matches greetings", () => {
    expect(isTrivialPrompt("hi")).toBe(true);
    expect(isTrivialPrompt("how are you?")).toBe(true);
    expect(isTrivialPrompt("implement a rust async runtime")).toBe(false);
  });
});
