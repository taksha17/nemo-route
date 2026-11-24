import { describe, expect, it } from "vitest";
import {
  anthropicToOpenAI,
  openAIToAnthropicMessage,
} from "../src/gateway/anthropic.js";

describe("anthropic translation", () => {
  it("converts system + text messages", () => {
    const openai = anthropicToOpenAI({
      model: "nemo/auto",
      max_tokens: 100,
      system: "be helpful",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(openai.messages[0]).toEqual({ role: "system", content: "be helpful" });
    expect(openai.messages[1]).toEqual({ role: "user", content: "hi" });
  });

  it("converts tool_use and tool_result", () => {
    const openai = anthropicToOpenAI({
      model: "nemo/auto",
      max_tokens: 100,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_1", name: "bash", input: { cmd: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "file.txt",
            },
          ],
        },
      ],
      tools: [
        {
          name: "bash",
          description: "run bash",
          input_schema: { type: "object", properties: { cmd: { type: "string" } } },
        },
      ],
    });
    expect(openai.tools?.[0]).toMatchObject({
      type: "function",
      function: { name: "bash" },
    });
    expect(openai.messages.some((m) => m.role === "tool")).toBe(true);
    expect(openai.messages.some((m) => m.role === "assistant" && m.tool_calls)).toBe(
      true,
    );
  });

  it("converts openai response back", () => {
    const msg = openAIToAnthropicMessage(
      {
        choices: [
          {
            message: {
              content: "hello",
              tool_calls: [
                {
                  id: "call_1",
                  function: { name: "bash", arguments: "{\"cmd\":\"ls\"}" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
      "nemo/auto",
    );
    expect(msg.stop_reason).toBe("tool_use");
    expect(msg.content.some((b) => b.type === "tool_use")).toBe(true);
  });
});
