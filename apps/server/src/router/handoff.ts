import type { ChatCompletionRequest, ChatMessage } from "../upstream/nimClient.js";

/**
 * Build messages for a mid-stream handoff: full original conversation,
 * any partial assistant draft, and a clear continue instruction.
 */
export function buildHandoffMessages(opts: {
  originalMessages: ChatMessage[];
  partialText: string;
  failedModelId: string;
  reason: string;
}): ChatMessage[] {
  // Keep trailing whitespace — it is often the exact cutoff (indent / open brace)
  const partial = opts.partialText;
  const messages: ChatMessage[] = [...opts.originalMessages];

  if (partial.trim()) {
    messages.push({ role: "assistant", content: partial });
    messages.push({
      role: "user",
      content: [
        `[nemo-route handoff] Model "${opts.failedModelId}" stopped mid-response (${opts.reason}).`,
        "The assistant message above is the incomplete draft so far.",
        "Continue from the exact cutoff. Do not restart, apologize, or repeat completed work.",
        "Preserve prior decisions, code, and formatting. Produce only the continuation.",
      ].join(" "),
    });
  } else {
    messages.push({
      role: "user",
      content: [
        `[nemo-route handoff] Model "${opts.failedModelId}" timed out before usable output (${opts.reason}).`,
        "Answer the original request fully using the conversation above. Do not mention this handoff.",
      ].join(" "),
    });
  }

  return messages;
}

/** Copy generation knobs + tools from the original request onto a handoff call. */
export function buildHandoffRequest(opts: {
  modelId: string;
  originalBody: ChatCompletionRequest;
  messages: ChatMessage[];
}): ChatCompletionRequest {
  const {
    model: _m,
    messages: _msg,
    stream: _s,
    stream_options: _so,
    ...rest
  } = opts.originalBody;

  return {
    ...rest,
    model: opts.modelId,
    messages: opts.messages,
    stream: true,
    stream_options: { include_usage: true },
  };
}
