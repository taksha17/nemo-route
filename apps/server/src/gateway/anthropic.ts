import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ApiKeyInfo } from "@nemo-route/shared";
import { env } from "../config/env.js";
import { analyzeRequest } from "../router/analyzer.js";
import { executeChat } from "../router/executor.js";
import { sessionIdFromMessages } from "../router/planner.js";
import { recordRequest } from "../telemetry/recorder.js";
import type { AppContext } from "../appContext.js";
import { authenticateApiKey, extractApiKeyFromHeaders } from "./keys.js";
import type { ChatCompletionRequest, ChatMessage } from "../upstream/nimClient.js";
import { estimateTokens } from "../crypto/secrets.js";

type Vars = { key: ApiKeyInfo; ctx: AppContext };

interface AnthropicContentBlock {
  type: string;
  text?: string;
  source?: { type: string; media_type?: string; data?: string };
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  max_tokens: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  tools?: Array<{
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
  }>;
  tool_choice?: unknown;
}

export function createAnthropicRouter(getCtx: () => AppContext) {
  const app = new Hono<{ Variables: Vars }>();

  const auth = async (c: any, next: () => Promise<void>) => {
    const key = authenticateApiKey(extractApiKeyFromHeaders(c.req.raw.headers));
    if (!key) {
      return c.json(
        {
          type: "error",
          error: { type: "authentication_error", message: "Invalid API key" },
        },
        401,
      );
    }
    c.set("key", key);
    c.set("ctx", getCtx());
    await next();
  };

  app.post("/messages/count_tokens", auth, async (c) => {
    const body = (await c.req.json()) as AnthropicRequest;
    const openai = anthropicToOpenAI(body);
    const text = JSON.stringify(openai.messages);
    return c.json({ input_tokens: estimateTokens(text) });
  });

  app.post("/messages", auth, async (c) => {
    const ctx = c.get("ctx");
    const key = c.get("key");
    const client = ctx.getNimClient();
    if (!client) {
      return c.json(
        {
          type: "error",
          error: { type: "api_error", message: "NIM API key not configured" },
        },
        503,
      );
    }

    const body = (await c.req.json()) as AnthropicRequest;
    const requestedModel = body.model || "nemo/auto";
    const openaiBody = anthropicToOpenAI(body);
    const analysis = analyzeRequest({
      messages: openaiBody.messages,
      tools: openaiBody.tools,
      requestedModel,
    });
    const sessionId = sessionIdFromMessages(openaiBody.messages);
    const started = Date.now();

    if (body.stream) {
      return streamSSE(c, async (stream) => {
        const msgId = `msg_${Date.now()}`;
        let keepalive = 0;
        let streamOpen = true;
        const safePing = () => {
          if (!streamOpen) return;
          keepalive += 1;
          void Promise.resolve(
            stream.writeSSE({
              event: "ping",
              data: JSON.stringify({ type: "ping", keepalive }),
            }),
          ).catch(() => {
            streamOpen = false;
          });
        };
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          await stream.writeSSE({
            event: "message_start",
            data: JSON.stringify({
              type: "message_start",
              message: {
                id: msgId,
                type: "message",
                role: "assistant",
                content: [],
                model: requestedModel,
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: analysis.estimatedInputTokens, output_tokens: 0 },
              },
            }),
          });
          await stream.writeSSE({
            event: "content_block_start",
            data: JSON.stringify({
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            }),
          });
          await stream.writeSSE({
            event: "ping",
            data: JSON.stringify({ type: "ping" }),
          });

          const result = await executeChat({
            client,
            body: { ...openaiBody, stream: true },
            analysis,
            requestedModel,
            sessionId,
            signal: c.req.raw.signal,
            onKeepalive: safePing,
          });

          reader = result.response.body?.getReader();
          if (!reader) throw new Error("No stream");
          const decoder = new TextDecoder();
          let buffer = "";
          let outputTokens = 0;
          let textLen = 0;
          const toolStates = new Map<
            number,
            { id: string; name: string; args: string; anthropicIndex: number; started: boolean }
          >();
          let nextBlockIndex = 1;

          const flushTool = async (idx: number) => {
            const st = toolStates.get(idx);
            if (!st?.started) return;
            await stream.writeSSE({
              event: "content_block_delta",
              data: JSON.stringify({
                type: "content_block_delta",
                index: st.anthropicIndex,
                delta: { type: "input_json_delta", partial_json: st.args },
              }),
            });
            await stream.writeSSE({
              event: "content_block_stop",
              data: JSON.stringify({ type: "content_block_stop", index: st.anthropicIndex }),
            });
          };

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data:")) continue;
              const data = trimmed.slice(5).trim();
              if (!data || data === "[DONE]") continue;
              let parsed: {
                choices?: Array<{
                  delta?: {
                    content?: string;
                    tool_calls?: Array<{
                      index?: number;
                      id?: string;
                      function?: { name?: string; arguments?: string };
                    }>;
                  };
                  finish_reason?: string | null;
                }>;
                usage?: { completion_tokens?: number };
              };
              try {
                parsed = JSON.parse(data);
              } catch {
                continue;
              }
              if (parsed.usage?.completion_tokens) {
                outputTokens = parsed.usage.completion_tokens;
              }
              const delta = parsed.choices?.[0]?.delta;
              if (delta?.content) {
                textLen += delta.content.length;
                await stream.writeSSE({
                  event: "content_block_delta",
                  data: JSON.stringify({
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text: delta.content },
                  }),
                });
              }
              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  let st = toolStates.get(idx);
                  if (!st) {
                    st = {
                      id: tc.id ?? `toolu_${idx}`,
                      name: tc.function?.name ?? "",
                      args: "",
                      anthropicIndex: nextBlockIndex++,
                      started: false,
                    };
                    toolStates.set(idx, st);
                  }
                  if (tc.id) st.id = tc.id;
                  if (tc.function?.name) st.name = tc.function.name;
                  if (tc.function?.arguments) st.args += tc.function.arguments;
                  if (!st.started && st.name) {
                    st.started = true;
                    await stream.writeSSE({
                      event: "content_block_start",
                      data: JSON.stringify({
                        type: "content_block_start",
                        index: st.anthropicIndex,
                        content_block: {
                          type: "tool_use",
                          id: st.id,
                          name: st.name,
                          input: {},
                        },
                      }),
                    });
                  }
                }
              }
              const fr = parsed.choices?.[0]?.finish_reason;
              if (fr === "tool_calls" || fr === "stop") {
                for (const idx of toolStates.keys()) await flushTool(idx);
              }
            }
          }

          await stream.writeSSE({
            event: "content_block_stop",
            data: JSON.stringify({ type: "content_block_stop", index: 0 }),
          });
          const stopReason = toolStates.size > 0 ? "tool_use" : "end_turn";
          await stream.writeSSE({
            event: "message_delta",
            data: JSON.stringify({
              type: "message_delta",
              delta: { stop_reason: stopReason, stop_sequence: null },
              usage: {
                output_tokens: outputTokens || estimateTokens("x".repeat(textLen)),
              },
            }),
          });
          await stream.writeSSE({
            event: "message_stop",
            data: JSON.stringify({ type: "message_stop" }),
          });

          recordRequest({
            workspaceId: env.workspaceId,
            keyId: key.id,
            requestedModel,
            chosenModel: result.chosenModel,
            taskType: analysis.taskType,
            complexity: analysis.complexity,
            inputTokens: result.inputTokens || analysis.estimatedInputTokens,
            outputTokens: outputTokens || estimateTokens("x".repeat(textLen)),
            tokensEstimated: result.tokensEstimated,
            ttftMs: result.ttftMs,
            durationMs: Date.now() - started,
            outcome: result.outcome,
            attempts: result.attempts,
            createdAt: started,
          });
        } catch (err) {
          if (streamOpen) {
            try {
              await stream.writeSSE({
                event: "error",
                data: JSON.stringify({
                  type: "error",
                  error: {
                    type: "api_error",
                    message: err instanceof Error ? err.message : String(err),
                  },
                }),
              });
            } catch {
              // client already gone
            }
          }
        } finally {
          streamOpen = false;
          void reader?.cancel().catch(() => {});
        }
      });
    }

    try {
      const result = await executeChat({
        client,
        body: { ...openaiBody, stream: false },
        analysis,
        requestedModel,
        sessionId,
        signal: c.req.raw.signal,
      });
      const json = (await result.response.json()) as {
        choices?: Array<{
          message?: {
            content?: string;
            tool_calls?: Array<{
              id: string;
              function: { name: string; arguments: string };
            }>;
          };
          finish_reason?: string;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const anthropic = openAIToAnthropicMessage(json, requestedModel);
      recordRequest({
        workspaceId: env.workspaceId,
        keyId: key.id,
        requestedModel,
        chosenModel: result.chosenModel,
        taskType: analysis.taskType,
        complexity: analysis.complexity,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        tokensEstimated: result.tokensEstimated,
        ttftMs: result.ttftMs,
        durationMs: Date.now() - started,
        outcome: result.outcome,
        attempts: result.attempts,
        createdAt: started,
      });
      return c.json(anthropic);
    } catch (err) {
      return c.json(
        {
          type: "error",
          error: {
            type: "api_error",
            message: err instanceof Error ? err.message : String(err),
          },
        },
        502,
      );
    }
  });

  return app;
}

export function anthropicToOpenAI(body: AnthropicRequest): ChatCompletionRequest {
  const messages: ChatMessage[] = [];
  if (body.system) {
    const sys =
      typeof body.system === "string"
        ? body.system
        : body.system.map((b) => b.text ?? "").join("\n");
    if (sys) messages.push({ role: "system", content: sys });
  }

  for (const msg of body.messages) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }
    const toolResults = msg.content.filter((b) => b.type === "tool_result");
    const toolUses = msg.content.filter((b) => b.type === "tool_use");
    const texts = msg.content.filter((b) => b.type === "text" || b.type === "image");

    for (const tr of toolResults) {
      messages.push({
        role: "tool",
        tool_call_id: tr.tool_use_id,
        content:
          typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content ?? ""),
      });
    }

    if (toolUses.length) {
      messages.push({
        role: "assistant",
        content: texts
          .map((b) => (b.type === "text" ? b.text ?? "" : ""))
          .join("") || null,
        tool_calls: toolUses.map((tu) => ({
          id: tu.id,
          type: "function",
          function: {
            name: tu.name,
            arguments: JSON.stringify(tu.input ?? {}),
          },
        })),
      } as ChatMessage);
      continue;
    }

    if (texts.length) {
      const content = texts.map((b) => {
        if (b.type === "text") return { type: "text", text: b.text ?? "" };
        if (b.type === "image" && b.source) {
          return {
            type: "image_url",
            image_url: {
              url: `data:${b.source.media_type};base64,${b.source.data}`,
            },
          };
        }
        return { type: "text", text: "" };
      });
      messages.push({ role: msg.role, content });
    }
  }

  const tools = body.tools?.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));

  return {
    model: body.model,
    messages,
    stream: body.stream,
    temperature: body.temperature,
    max_tokens: body.max_tokens,
    top_p: body.top_p,
    stop: body.stop_sequences,
    tools,
    tool_choice: body.tool_choice,
  };
}

export function openAIToAnthropicMessage(
  json: {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          id: string;
          function: { name: string; arguments: string };
        }>;
      };
      finish_reason?: string;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  },
  model: string,
) {
  const msg = json.choices?.[0]?.message;
  const content: AnthropicContentBlock[] = [];
  if (msg?.content) content.push({ type: "text", text: msg.content });
  for (const tc of msg?.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(tc.function.arguments || "{}");
    } catch {
      input = { raw: tc.function.arguments };
    }
    content.push({
      type: "tool_use",
      id: tc.id,
      name: tc.function.name,
      input,
    });
  }
  const stopReason =
    json.choices?.[0]?.finish_reason === "tool_calls" ? "tool_use" : "end_turn";
  return {
    id: `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: json.usage?.prompt_tokens ?? 0,
      output_tokens: json.usage?.completion_tokens ?? 0,
    },
  };
}
