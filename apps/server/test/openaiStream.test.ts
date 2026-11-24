import { describe, expect, it } from "vitest";
import {
  buildOpenAiStreamTerminal,
  createOpenAiStreamTerminalState,
  observeOpenAiSse,
} from "../src/router/openaiStream.js";

describe("openaiStream terminal synthesis", () => {
  it("synthesizes finish_reason and DONE when upstream omits them", () => {
    const state = createOpenAiStreamTerminalState("nvidia/test-model");
    observeOpenAiSse(
      `data: ${JSON.stringify({
        id: "chatcmpl-abc",
        object: "chat.completion.chunk",
        model: "nvidia/test-model",
        choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
      })}\n\n`,
      state,
    );
    expect(state.sawFinishReason).toBe(false);
    expect(state.sawDone).toBe(false);

    const tail = buildOpenAiStreamTerminal(state, "stop");
    expect(tail).toContain('"finish_reason":"stop"');
    expect(tail).toContain("data: [DONE]");
    expect(state.sawFinishReason).toBe(true);
    expect(state.sawDone).toBe(true);
  });

  it("does not duplicate finish_reason when already present", () => {
    const state = createOpenAiStreamTerminalState("nvidia/test-model");
    observeOpenAiSse(
      `data: ${JSON.stringify({
        id: "chatcmpl-abc",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\ndata: [DONE]\n\n`,
      state,
    );
    expect(state.sawFinishReason).toBe(true);
    expect(state.sawDone).toBe(true);
    expect(buildOpenAiStreamTerminal(state)).toBe("");
  });
});
