import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { VIRTUAL_MODELS } from "@nemo-route/shared";
import type { ApiKeyInfo } from "@nemo-route/shared";
import { env } from "../config/env.js";
import { analyzeRequest } from "../router/analyzer.js";
import { executeChat } from "../router/executor.js";
import { runOrchestration, sessionIdFromMessages } from "../router/planner.js";
import { listChatModels, listRegistry } from "../scout/registry.js";
import { recordRequest } from "../telemetry/recorder.js";
import type { AppContext } from "../appContext.js";
import { authenticateApiKey, extractApiKeyFromHeaders } from "./keys.js";
import {
  buildOpenAiStreamTerminal,
  createOpenAiStreamTerminalState,
  observeOpenAiSse,
} from "../router/openaiStream.js";
import type { ChatCompletionRequest } from "../upstream/nimClient.js";
import { NimHttpError } from "../upstream/nimClient.js";

type Vars = { key: ApiKeyInfo; ctx: AppContext };

function requireKey(): (c: any, next: () => Promise<void>) => Promise<Response | void> {
  return async (c, next) => {
    const key = authenticateApiKey(extractApiKeyFromHeaders(c.req.raw.headers));
    if (!key) {
      return c.json({ error: { message: "Invalid or missing API key" } }, 401);
    }
    c.set("key", key);
    c.set("ctx", getCtxFrom(c));
    await next();
  };
}

let _getCtx: () => AppContext = () => {
  throw new Error("AppContext not ready");
};
function getCtxFrom(_c: unknown) {
  return _getCtx();
}

export function createOpenAIRouter(getCtx: () => AppContext) {
  _getCtx = getCtx;
  const app = new Hono<{ Variables: Vars }>();
  const auth = requireKey();

  app.get("/models", auth, (c) => {
    const chat = listChatModels();
    const virtual = VIRTUAL_MODELS.map((id) => ({
      id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "nemo-route",
    }));
    const real = chat.map((m) => ({
      id: m.id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: m.ownedBy,
    }));
    return c.json({ object: "list", data: [...virtual, ...real] });
  });

  app.post("/embeddings", auth, async (c) => {
    const ctx = c.get("ctx");
    const client = ctx.getNimClient();
    if (!client) return c.json({ error: { message: "NIM API key not configured" } }, 503);
    const body = await c.req.json();
    try {
      const res = await client.embeddings(body, "live");
      const json = await res.json();
      return c.json(json);
    } catch (err) {
      if (err instanceof NimHttpError) {
        return c.json({ error: { message: err.message } }, err.status as 400);
      }
      return c.json(
        { error: { message: err instanceof Error ? err.message : String(err) } },
        500,
      );
    }
  });

  app.post("/chat/completions", auth, async (c) => {
    const ctx = c.get("ctx");
    const key = c.get("key");
    const client = ctx.getNimClient();
    if (!client) return c.json({ error: { message: "NIM API key not configured" } }, 503);

    const body = (await c.req.json()) as ChatCompletionRequest;
    const requestedModel = body.model || "nemo/auto";
    const started = Date.now();

    if (requestedModel === "nemo/orchestrate") {
      if (body.tools?.length) {
        // fall through to auto for tool loops
      } else {
        return handleOrchestrate(c, ctx, key, client, body, started);
      }
    }

    const analysis = analyzeRequest({
      messages: body.messages,
      tools: body.tools,
      requestedModel: requestedModel === "nemo/orchestrate" ? "nemo/auto" : requestedModel,
    });
    const sessionId = sessionIdFromMessages(body.messages);

    if (body.stream) {
      return streamSSE(c, async (stream) => {
        let keepaliveCount = 0;
        let streamOpen = true;
        const safeKeepalive = () => {
          if (!streamOpen) return;
          keepaliveCount += 1;
          // Raw SSE comment — avoid Hono writeSSE({comment}) which can throw
          void Promise.resolve(stream.write(`: nemo-keepalive ${keepaliveCount}\n\n`)).catch(
            () => {
              streamOpen = false;
            },
          );
        };
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          const result = await executeChat({
            client,
            body: { ...body, model: requestedModel, stream: true },
            analysis,
            requestedModel:
              requestedModel === "nemo/orchestrate" ? "nemo/auto" : requestedModel,
            sessionId,
            signal: c.req.raw.signal,
            onKeepalive: safeKeepalive,
          });

          reader = result.response.body?.getReader();
          if (!reader) throw new Error("No stream body");
          const decoder = new TextDecoder();
          const terminal = createOpenAiStreamTerminalState(result.chosenModel);
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            observeOpenAiSse(text, terminal);
            await stream.write(text);
          }
          // Belt-and-suspenders: OpenCode/AI SDK require finish_reason before EOF
          const tail = buildOpenAiStreamTerminal(terminal, "stop");
          if (tail) await stream.write(tail);

          recordRequest({
            id: result.requestId,
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
            segments: result.segments,
            createdAt: started,
            promptBody: key.debugBodies ? JSON.stringify(body.messages) : null,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (streamOpen) {
            try {
              await stream.write(
                `data: ${JSON.stringify({ error: { message } })}\n\n`,
              );
              // Belt-and-suspenders: OpenCode/AI SDK require finish_reason before EOF
              const terminal = createOpenAiStreamTerminalState("nemo/auto");
              const tail = buildOpenAiStreamTerminal(terminal, "stop");
              if (tail) await stream.write(tail);
              await stream.write("data: [DONE]\n\n");
            } catch {
              // client already gone
            }
          }
          recordRequest({
            workspaceId: env.workspaceId,
            keyId: key.id,
            requestedModel,
            chosenModel: null,
            taskType: analysis.taskType,
            complexity: analysis.complexity,
            inputTokens: analysis.estimatedInputTokens,
            outputTokens: 0,
            tokensEstimated: true,
            ttftMs: null,
            durationMs: Date.now() - started,
            outcome: "error",
            attempts: [],
            segments: [],
            createdAt: started,
          });
        } finally {
          streamOpen = false;
          void reader?.cancel().catch(() => {});
        }
      });
    }

    try {
      const result = await executeChat({
        client,
        body: { ...body, stream: false },
        analysis,
        requestedModel:
          requestedModel === "nemo/orchestrate" ? "nemo/auto" : requestedModel,
        sessionId,
        signal: c.req.raw.signal,
      });
      const json = await result.response.json();
      recordRequest({
        id: result.requestId,
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
        segments: result.segments,
        createdAt: started,
        promptBody: key.debugBodies ? JSON.stringify(body.messages) : null,
        responseBody: key.debugBodies ? JSON.stringify(json) : null,
      });
      return c.json(json);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = err instanceof NimHttpError ? err.status : 502;
      recordRequest({
        workspaceId: env.workspaceId,
        keyId: key.id,
        requestedModel,
        chosenModel: null,
        taskType: analysis.taskType,
        complexity: analysis.complexity,
        inputTokens: analysis.estimatedInputTokens,
        outputTokens: 0,
        tokensEstimated: true,
        ttftMs: null,
        durationMs: Date.now() - started,
        outcome: "error",
        attempts: [],
        segments: [],
        createdAt: started,
      });
      return c.json({ error: { message } }, status as 502);
    }
  });

  return app;
}

async function handleOrchestrate(
  c: any,
  _ctx: AppContext,
  key: ApiKeyInfo,
  client: NonNullable<ReturnType<AppContext["getNimClient"]>>,
  body: ChatCompletionRequest,
  started: number,
) {
  const prompt = body.messages
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");

  if (body.stream) {
    return streamSSE(c, async (stream) => {
      try {
        const { content, modelsUsed } = await runOrchestration({
          client,
          prompt,
          stream: true,
          signal: c.req.raw.signal,
          onProgress: (event) => {
            void stream.writeSSE({
              event: "nemo.progress",
              data: JSON.stringify(event),
            });
          },
        });
        const id = `chatcmpl-orch-${Date.now()}`;
        await stream.writeSSE({
          data: JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "nemo/orchestrate",
            choices: [
              { index: 0, delta: { role: "assistant", content: "" }, finish_reason: null },
            ],
          }),
        });
        for (const chunk of content.match(/.{1,40}/g) ?? [content]) {
          await stream.writeSSE({
            data: JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "nemo/orchestrate",
              choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
            }),
          });
        }
        await stream.writeSSE({
          data: JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "nemo/orchestrate",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          }),
        });
        await stream.writeSSE({ data: "[DONE]" });
        recordRequest({
          workspaceId: env.workspaceId,
          keyId: key.id,
          requestedModel: "nemo/orchestrate",
          chosenModel: modelsUsed[modelsUsed.length - 1] ?? null,
          taskType: "other",
          complexity: "high",
          inputTokens: Math.ceil(prompt.length / 4),
          outputTokens: Math.ceil(content.length / 4),
          tokensEstimated: true,
          ttftMs: null,
          durationMs: Date.now() - started,
          outcome: "success",
          attempts: modelsUsed.map((m) => ({
            modelId: m,
            startedAt: started,
            endedAt: Date.now(),
            ttftMs: null,
            error: null,
            abandonedReason: null,
          })),
          createdAt: started,
        });
      } catch (err) {
        await stream.writeSSE({
          data: JSON.stringify({
            error: { message: err instanceof Error ? err.message : String(err) },
          }),
        });
      }
    });
  }

  const { content, modelsUsed } = await runOrchestration({
    client,
    prompt,
    stream: false,
    signal: c.req.raw.signal,
  });
  recordRequest({
    workspaceId: env.workspaceId,
    keyId: key.id,
    requestedModel: "nemo/orchestrate",
    chosenModel: modelsUsed[modelsUsed.length - 1] ?? null,
    taskType: "other",
    complexity: "high",
    inputTokens: Math.ceil(prompt.length / 4),
    outputTokens: Math.ceil(content.length / 4),
    tokensEstimated: true,
    ttftMs: null,
    durationMs: Date.now() - started,
    outcome: "success",
    attempts: [],
    createdAt: started,
  });
  return c.json({
    id: `chatcmpl-orch-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "nemo/orchestrate",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: Math.ceil(prompt.length / 4),
      completion_tokens: Math.ceil(content.length / 4),
      total_tokens: Math.ceil((prompt.length + content.length) / 4),
    },
  });
}

// silence unused import in some builds
void listRegistry;
