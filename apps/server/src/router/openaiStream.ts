/**
 * OpenAI-compatible clients (Vercel AI SDK / OpenCode) require a non-null
 * finish_reason before the stream ends. Upstream NIM sometimes drops the
 * connection, and our idle watchdog can cancel mid-generation — both look
 * like a clean EOF without finish_reason. Synthesize the terminal events.
 */

export interface OpenAiStreamTerminalState {
  sawFinishReason: boolean;
  sawDone: boolean;
  lastChunkId: string;
  modelId: string;
}

export function createOpenAiStreamTerminalState(
  modelId: string,
): OpenAiStreamTerminalState {
  return {
    sawFinishReason: false,
    sawDone: false,
    lastChunkId: `chatcmpl-nemo-${Date.now()}`,
    modelId,
  };
}

/** Inspect SSE text as it is forwarded; updates terminal state in place. */
export function observeOpenAiSse(
  sseText: string,
  state: OpenAiStreamTerminalState,
): void {
  for (const line of sseText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data) continue;
    if (data === "[DONE]") {
      state.sawDone = true;
      continue;
    }
    try {
      const parsed = JSON.parse(data) as {
        id?: string;
        model?: string;
        choices?: Array<{ finish_reason?: string | null }>;
      };
      if (parsed.id) state.lastChunkId = parsed.id;
      if (parsed.model) state.modelId = parsed.model;
      const fr = parsed.choices?.[0]?.finish_reason;
      if (fr != null && fr !== "") {
        state.sawFinishReason = true;
      }
    } catch {
      // ignore non-json sse
    }
  }
}

export function buildOpenAiStreamTerminal(
  state: OpenAiStreamTerminalState,
  finishReason: string = "stop",
): string {
  const parts: string[] = [];
  if (!state.sawFinishReason) {
    parts.push(
      `data: ${JSON.stringify({
        id: state.lastChunkId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: state.modelId,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      })}\n\n`,
    );
    state.sawFinishReason = true;
  }
  if (!state.sawDone) {
    parts.push("data: [DONE]\n\n");
    state.sawDone = true;
  }
  return parts.join("");
}
