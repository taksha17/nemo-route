import { nanoid } from "nanoid";
import type {
  AnalysisResult,
  RequestOutcome,
  RoutingAttempt,
  RoutingRole,
  TokenRoutingSegment,
} from "@nemo-route/shared";
import { estimateTokens } from "../crypto/secrets.js";
import { getSettings } from "../db/workspace.js";
import { recordFailure, recordSuccess } from "../scout/health.js";
import { getModelEntry, updateModelEntry } from "../scout/registry.js";
import {
  beginLiveRouting,
  finishLiveRouting,
  upsertLiveSegment,
} from "../telemetry/liveRouting.js";
import {
  NimClient,
  NimHttpError,
  type ChatCompletionRequest,
} from "../upstream/nimClient.js";
import {
  flattenMessages,
  hasMultimodalContent,
  isMultimodalUpstreamError,
  stripMultimodalContent,
} from "./analyzer.js";
import { buildHandoffMessages, buildHandoffRequest } from "./handoff.js";
import {
  buildOpenAiStreamTerminal,
  createOpenAiStreamTerminalState,
  observeOpenAiSse,
} from "./openaiStream.js";
import { applyRouteHooks } from "./hooks.js";
import { rememberStickyModel, selectFallbackChain } from "./selector.js";

/**
 * Maximum upstream model attempts (primary + retries + failovers) for a single
 * client request. `selectFallbackChain()` returns every routable chat model in
 * the catalog, so without this bound one request can fan out to one call per
 * model — a cheap client-side amplification of the operator's NIM quota.
 */
const MAX_MODEL_ATTEMPTS = 3;

export interface ExecuteChatOptions {
  client: NimClient;
  body: ChatCompletionRequest;
  analysis: AnalysisResult;
  requestedModel: string;
  sessionId?: string | null;
  signal?: AbortSignal;
  onKeepalive?: () => void;
  requestId?: string;
  trackLive?: boolean;
}

export interface ExecuteChatResult {
  response: Response;
  chosenModel: string;
  attempts: RoutingAttempt[];
  segments: TokenRoutingSegment[];
  outcome: RequestOutcome;
  ttftMs: number | null;
  inputTokens: number;
  outputTokens: number;
  tokensEstimated: boolean;
  requestId: string;
}

export async function executeChat(
  opts: ExecuteChatOptions,
): Promise<ExecuteChatResult> {
  const settings = getSettings();
  const requestId = opts.requestId ?? nanoid();
  const trackLive = opts.trackLive !== false;

  // OpenCode often embeds screenshots / Read(image) as image_url parts. Hosted NIM
  // text models reject those with "--enable-multimodal". Force VL routing.
  if (
    hasMultimodalContent(
      opts.body.messages as unknown as Array<{
        content: unknown;
        [key: string]: unknown;
      }>,
    )
  ) {
    opts.analysis.requiresVision = true;
    if (opts.analysis.taskType === "chat") opts.analysis.taskType = "vision";
  }

  let requestBody = opts.body;
  let chain = selectFallbackChain({
    analysis: opts.analysis,
    requestedModel: opts.requestedModel,
    sessionId: opts.sessionId,
  });

  // Last resort: no healthy VL model → strip media so coding can continue on text models
  if (chain.length === 0 && opts.analysis.requiresVision) {
    requestBody = {
      ...opts.body,
      messages: stripMultimodalContent(opts.body.messages),
    };
    opts.analysis.requiresVision = false;
    chain = selectFallbackChain({
      analysis: opts.analysis,
      requestedModel: opts.requestedModel,
      sessionId: opts.sessionId,
    });
  }

  const hooked = applyRouteHooks({
    requestedModel: opts.requestedModel,
    analysis: opts.analysis,
    chain,
  });
  chain = hooked.chain;
  opts.analysis = hooked.analysis;

  if (chain.length === 0) {
    throw new Error("No available models match this request");
  }

  const attempts: RoutingAttempt[] = [];
  const segments: TokenRoutingSegment[] = [];
  let lastError: Error | null = null;
  const inputText = flattenMessages(requestBody.messages);
  const estimatedIn = estimateTokens(inputText);

  if (trackLive) {
    beginLiveRouting({
      requestId,
      requestedModel: opts.requestedModel,
      taskType: opts.analysis.taskType,
      complexity: opts.analysis.complexity,
      startedAt: Date.now(),
    });
  }

  const pushSegment = (segment: TokenRoutingSegment) => {
    segments.push(segment);
    if (trackLive) upsertLiveSegment(requestId, segment);
  };

  outer: for (let i = 0; i < chain.length; i++) {
    const modelId = chain[i]!;
    const entry = getModelEntry(modelId);

    // Bound the fallback chain per request. `chain` is seeded from every chat
    // model the catalog knows about, and the multimodal-error branch below
    // appends a freshly selected chain, so without a cap a single client
    // request can attempt every chat model in the registry (two upstream calls
    // each), burning the operator's NIM quota for one prompt.
    if (attempts.length >= MAX_MODEL_ATTEMPTS) break;

    // Hard skip: never send image/audio/video payloads to text-only NIM profiles
    if (
      opts.analysis.requiresVision &&
      entry &&
      !entry.inputs.includes("image") &&
      !entry.inputs.includes("video")
    ) {
      continue;
    }

    const ttftBudget =
      entry?.tier === "heavy"
        ? settings.timeouts.heavyTtftMs
        : entry?.tier === "light"
          ? settings.timeouts.lightTtftMs
          : settings.timeouts.mediumTtftMs;

    for (let retry = 0; retry < 2; retry++) {
      if (opts.signal?.aborted) {
        lastError = new Error("client aborted");
        break outer;
      }
      if (attempts.length >= MAX_MODEL_ATTEMPTS) break outer;
      const startedAt = Date.now();
      const role: RoutingRole =
        attempts.length === 0 ? "primary" : retry > 0 ? "retry" : "failover";
      pushSegment({
        modelId,
        role,
        inputTokens: estimatedIn,
        outputTokens: 0,
        startedAt,
        endedAt: null,
        status: "active",
        label: `${role} → ${modelId}`,
      });
      const keepaliveTimer =
        requestBody.stream && opts.onKeepalive
          ? setInterval(() => {
              try {
                opts.onKeepalive?.();
              } catch {
                // never let keepalive take down the process
              }
            }, 10_000)
          : null;
      if (keepaliveTimer) keepaliveTimer.unref?.();
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      // If the client already disconnected, abort immediately (addEventListener won't re-fire)
      if (opts.signal?.aborted) controller.abort();
      else opts.signal?.addEventListener("abort", onAbort);
      const clearKeepalive = () => {
        if (keepaliveTimer) clearInterval(keepaliveTimer);
      };
      // Cover governor wait + upstream headers (not only post-headers body read)
      const headerTimer = setTimeout(() => controller.abort(), ttftBudget);

      try {
        const upstreamBody: ChatCompletionRequest = {
          ...requestBody,
          model: modelId,
          stream_options: requestBody.stream
            ? { include_usage: true, ...(requestBody.stream_options ?? {}) }
            : requestBody.stream_options,
        };

        const res = await opts.client.chatCompletions(
          upstreamBody,
          "live",
          controller.signal,
        );
        clearTimeout(headerTimer);

        if (!requestBody.stream) {
          clearKeepalive();
          opts.signal?.removeEventListener("abort", onAbort);
          // Non-stream body can be long; allow up to idle budget after headers
          const bodyBudget = Math.max(ttftBudget, settings.timeouts.idleMs);
          const json = (await withTimeout(
            res.json(),
            bodyBudget,
            controller,
          )) as {
            id?: string;
            choices?: Array<{ message?: { content?: string } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          const content = json.choices?.[0]?.message?.content ?? "";
          const latency = Date.now() - startedAt;
          const outTok = json.usage?.completion_tokens ?? estimateTokens(content);
          const inTok = json.usage?.prompt_tokens ?? estimatedIn;
          recordSuccess(modelId, latency, latency);
          rememberStickyModel(opts.sessionId, modelId, opts.analysis);
          attempts.push({
            modelId,
            startedAt,
            endedAt: Date.now(),
            ttftMs: latency,
            error: null,
            abandonedReason: null,
            role,
            inputTokens: inTok,
            outputTokens: outTok,
            label: `${role} → ${modelId}`,
          });
          const doneSeg: TokenRoutingSegment = {
            modelId,
            role,
            inputTokens: inTok,
            outputTokens: outTok,
            startedAt,
            endedAt: Date.now(),
            status: "success",
            label: `${role} → ${modelId}`,
          };
          segments[segments.length - 1] = doneSeg;
          if (trackLive) upsertLiveSegment(requestId, doneSeg);
          const result = {
            response: new Response(
              JSON.stringify({
                ...json,
                model: modelId,
                id: json.id ?? `chatcmpl-${requestId}`,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
            chosenModel: modelId,
            attempts,
            segments,
            outcome: (attempts.length > 1 ? "failover_success" : "success") as RequestOutcome,
            ttftMs: latency,
            inputTokens: inTok,
            outputTokens: outTok,
            tokensEstimated: !json.usage,
            requestId,
          };
          if (trackLive) {
            finishLiveRouting(requestId, {
              status: "done",
              chosenModel: modelId,
              segments,
            });
          }
          return result;
        }

        // Streaming: wait for first bytes before committing (invisible failover)
        const reader = res.body?.getReader();
        if (!reader) throw new Error("No response body");

        const first = await readFirstChunk(reader, ttftBudget, controller);
        clearKeepalive();
        opts.signal?.removeEventListener("abort", onAbort);

        if (!first.ok) {
          recordFailure(modelId, undefined, first.error, Date.now() - startedAt);
          attempts.push({
            modelId,
            startedAt,
            endedAt: Date.now(),
            ttftMs: null,
            error: first.error,
            abandonedReason: "ttft_timeout_or_error",
            role,
            inputTokens: estimatedIn,
            outputTokens: 0,
          });
          const failSeg: TokenRoutingSegment = {
            modelId,
            role,
            inputTokens: estimatedIn,
            outputTokens: 0,
            startedAt,
            endedAt: Date.now(),
            status: "failed",
            label: `${role} → ${modelId}`,
            error: first.error,
          };
          segments[segments.length - 1] = failSeg;
          if (trackLive) upsertLiveSegment(requestId, failSeg);
          lastError = new Error(first.error);
          continue;
        }

        const ttftMs = Date.now() - startedAt;
        recordSuccess(modelId, ttftMs, ttftMs);
        rememberStickyModel(opts.sessionId, modelId, opts.analysis);
        attempts.push({
          modelId,
          startedAt,
          endedAt: Date.now(),
          ttftMs,
          error: null,
          abandonedReason: null,
          role,
          inputTokens: estimatedIn,
          outputTokens: 0,
        });
        const okSeg: TokenRoutingSegment = {
          modelId,
          role,
          inputTokens: estimatedIn,
          outputTokens: 0,
          startedAt,
          endedAt: Date.now(),
          status: "success",
          label: `${role} → ${modelId}`,
        };
        segments[segments.length - 1] = okSeg;
        if (trackLive) upsertLiveSegment(requestId, okSeg);

        const usage = { prompt: 0, completion: 0, estimated: true, text: "" };
        const stream = makeContinuableStream({
          firstChunk: first.chunk!,
          reader,
          modelId,
          idleMs: settings.timeouts.idleMs,
          signal: opts.signal,
          originalBody: requestBody,
          analysis: opts.analysis,
          requestedModel: opts.requestedModel,
          client: opts.client,
          remainingChain: chain.slice(i + 1),
          sessionId: opts.sessionId,
          onKeepalive: opts.onKeepalive,
          usage,
          attempts,
          pushSegment,
          partialStreamBehavior: settings.partialStreamBehavior,
          onStreamComplete: trackLive
            ? (finalSegments, chosen) => {
                finishLiveRouting(requestId, {
                  status: "done",
                  chosenModel: chosen,
                  segments: finalSegments,
                });
              }
            : undefined,
        });

        // Keep live session active until the SSE pump finishes (see onStreamComplete)
        return {
          response: new Response(stream, {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "X-Nemo-Model": modelId,
              "X-Nemo-Request-Id": requestId,
            },
          }),
          chosenModel: modelId,
          attempts,
          segments,
          outcome: (attempts.length > 1 ? "failover_success" : "success") as RequestOutcome,
          ttftMs,
          inputTokens: estimatedIn,
          outputTokens: 0,
          tokensEstimated: true,
          requestId,
        };
      } catch (err) {
        clearTimeout(headerTimer);
        clearKeepalive();
        opts.signal?.removeEventListener("abort", onAbort);
        const message = err instanceof Error ? err.message : String(err);
        const status = err instanceof NimHttpError ? err.status : undefined;
        const clientGone =
          opts.signal?.aborted ||
          /client aborted|request aborted by client/i.test(message);

        if (clientGone) {
          // Do not punish model health or burn failover RPM after the client left
          lastError = new Error("client aborted");
          const failSeg: TokenRoutingSegment = {
            modelId,
            role,
            inputTokens: estimatedIn,
            outputTokens: 0,
            startedAt,
            endedAt: Date.now(),
            status: "failed",
            label: `${role} → ${modelId}`,
            error: "client aborted",
          };
          segments[segments.length - 1] = failSeg;
          if (trackLive) upsertLiveSegment(requestId, failSeg);
          attempts.push({
            modelId,
            startedAt,
            endedAt: Date.now(),
            ttftMs: null,
            error: "client aborted",
            abandonedReason: "client_abort",
            role,
            inputTokens: estimatedIn,
            outputTokens: 0,
          });
          break outer;
        }

        recordFailure(modelId, status, message, Date.now() - startedAt);
        attempts.push({
          modelId,
          startedAt,
          endedAt: Date.now(),
          ttftMs: null,
          error: message,
          abandonedReason: isMultimodalUpstreamError(err)
            ? "multimodal_unsupported"
            : status === 429
              ? "rate_limited"
              : "upstream_error",
          role,
          inputTokens: estimatedIn,
          outputTokens: 0,
        });
        const failSeg: TokenRoutingSegment = {
          modelId,
          role,
          inputTokens: estimatedIn,
          outputTokens: 0,
          startedAt,
          endedAt: Date.now(),
          status: "failed",
          label: `${role} → ${modelId}`,
          error: message,
        };
        segments[segments.length - 1] = failSeg;
        if (trackLive) upsertLiveSegment(requestId, failSeg);
        lastError = err instanceof Error ? err : new Error(message);

        // Hosted NIM text profiles reject media — demote + force VL chain for remaining tries
        if (isMultimodalUpstreamError(err)) {
          opts.analysis.requiresVision = true;
          if (opts.analysis.taskType === "chat") opts.analysis.taskType = "vision";
          const cur = getModelEntry(modelId);
          if (cur?.inputs.some((x) => x === "image" || x === "video")) {
            updateModelEntry(modelId, {
              ...cur,
              inputs: cur.inputs.filter((x) => x !== "image" && x !== "video"),
              notes: `${cur.notes ?? ""} Hosted NIM rejected multimodal.`.trim(),
            });
          }
          const visionChain = selectFallbackChain({
            analysis: opts.analysis,
            requestedModel: opts.requestedModel,
            sessionId: opts.sessionId,
            excludeModels: [...failedAttemptIds(attempts), modelId],
          });
          for (const id of visionChain) {
            if (!chain.includes(id)) chain.push(id);
          }
          break; // next model in outer loop
        }

        if (status === 401 || status === 403 || status === 404) break;
      }
    }
  }

  // Final multimodal escape hatch: strip media and retry text models once
  if (
    lastError &&
    isMultimodalUpstreamError(lastError) &&
    hasMultimodalContent(
      requestBody.messages as unknown as Array<{
        content: unknown;
        [key: string]: unknown;
      }>,
    )
  ) {
    const stripped = {
      ...requestBody,
      messages: stripMultimodalContent(requestBody.messages),
    };
    opts.analysis.requiresVision = false;
    return executeChat({
      ...opts,
      body: stripped,
      requestId,
      trackLive: false,
    });
  }

  if (trackLive) {
    finishLiveRouting(requestId, {
      status: "error",
      chosenModel: null,
      segments,
    });
  }
  throw lastError ?? new Error("All models failed");
}

function failedAttemptIds(attempts: RoutingAttempt[]): string[] {
  return [...new Set(attempts.map((a) => a.modelId))];
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  controller: AbortController,
): Promise<T> {
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await promise;
  } finally {
    clearTimeout(timer);
  }
}

async function readFirstChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  controller: AbortController,
): Promise<{ ok: true; chunk: Uint8Array } | { ok: false; error: string }> {
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await reader.read();
    clearTimeout(timer);
    if (result.done || !result.value) {
      return { ok: false, error: "empty stream" };
    }
    return { ok: true, chunk: result.value };
  } catch (err) {
    clearTimeout(timer);
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function makeContinuableStream(opts: {
  firstChunk: Uint8Array;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  modelId: string;
  idleMs: number;
  signal?: AbortSignal;
  originalBody: ChatCompletionRequest;
  analysis: AnalysisResult;
  requestedModel: string;
  client: NimClient;
  remainingChain: string[];
  sessionId?: string | null;
  onKeepalive?: () => void;
  usage: { prompt: number; completion: number; estimated: boolean; text: string };
  attempts: RoutingAttempt[];
  pushSegment?: (segment: TokenRoutingSegment) => void;
  partialStreamBehavior?: "continue" | "error";
  onStreamComplete?: (
    segments: TokenRoutingSegment[],
    chosenModel: string,
  ) => void;
}): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const collectedSegments: TokenRoutingSegment[] = [];
  let finalChosen = opts.modelId;

  const trackSegment: typeof opts.pushSegment = (segment) => {
    const idx = collectedSegments.findIndex(
      (s) =>
        s.modelId === segment.modelId &&
        s.startedAt === segment.startedAt &&
        s.role === segment.role,
    );
    if (idx >= 0) collectedSegments[idx] = segment;
    else collectedSegments.push(segment);
    opts.pushSegment?.(segment);
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const terminal = createOpenAiStreamTerminalState(opts.modelId);
      const failedModels = new Set<string>([opts.modelId]);

      const enqueueTerminal = (finishReason: string = "stop") => {
        const tail = buildOpenAiStreamTerminal(terminal, finishReason);
        if (tail) controller.enqueue(encoder.encode(tail));
      };

      const pumpReader = async (
        reader: ReadableStreamDefaultReader<Uint8Array>,
        modelId: string,
        trackPartial: boolean,
      ): Promise<{ idleTimedOut: boolean }> => {
        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        let idleTimedOut = false;
        const clearIdle = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = null;
        };
        const resetIdle = () => {
          clearIdle();
          idleTimer = setTimeout(() => {
            idleTimedOut = true;
            void reader.cancel("idle timeout");
          }, opts.idleMs);
        };

        try {
          resetIdle();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            resetIdle();
            if (!value) continue;
            const text = decoder.decode(value, { stream: true }).replace(
              /"model"\s*:\s*"[^"]*"/g,
              `"model":"${modelId}"`,
            );
            if (trackPartial) extractPartial(text, opts.usage);
            observeOpenAiSse(text, terminal);
            controller.enqueue(encoder.encode(text));
          }
          return { idleTimedOut };
        } finally {
          clearIdle();
        }
      };

      const resolveHandoffChain = (exclude: Set<string>): string[] => {
        const fromRemainder = opts.remainingChain.filter((id) => !exclude.has(id));
        if (fromRemainder.length > 0) return fromRemainder;
        return selectFallbackChain({
          analysis: opts.analysis,
          requestedModel: opts.requestedModel,
          sessionId: opts.sessionId,
          excludeModels: [...exclude],
        });
      };

      const handoffToNextModels = async (reason: string, fromModelId: string) => {
        let handoffReason = reason;
        let prevModel = fromModelId;

        // Cap mid-stream handoffs the same way the initial failover loop is
        // capped: every model in the chain can drop mid-response, and without a
        // bound one client request fans out to one upstream call per chat model
        // (plus a full continuation each time). A client can trigger this
        // deliberately by disconnecting after the first byte.
        let handoffs = 0;

        while (true) {
          // A disconnected client must not keep spending upstream calls.
          const clientGone = opts.signal?.aborted === true;
          if (clientGone || opts.attempts.length + handoffs >= MAX_MODEL_ATTEMPTS) {
            try {
              enqueueTerminal(
                !clientGone && handoffReason.includes("idle") ? "length" : "stop",
              );
              controller.close();
            } catch {
              // The consumer already went away.
            }
            return;
          }
          const candidates = resolveHandoffChain(failedModels);
          const nextModel = candidates[0];
          if (!nextModel) {
            enqueueTerminal(handoffReason.includes("idle") ? "length" : "stop");
            controller.close();
            return;
          }

          failedModels.add(nextModel);
          handoffs += 1;
          opts.onKeepalive?.();
          const contStarted = Date.now();
          trackSegment({
            modelId: nextModel,
            role: "continue",
            inputTokens: estimateTokens(
              opts.usage.text || flattenMessages(opts.originalBody.messages),
            ),
            outputTokens: 0,
            startedAt: contStarted,
            endedAt: null,
            status: "active",
            label: `handoff (${handoffReason}) → ${nextModel}`,
          });

          try {
            const handoffMessages = buildHandoffMessages({
              originalMessages: opts.originalBody.messages,
              partialText: opts.usage.text,
              failedModelId: prevModel,
              reason: handoffReason,
            });
            const cont = await opts.client.chatCompletions(
              buildHandoffRequest({
                modelId: nextModel,
                originalBody: opts.originalBody,
                messages: handoffMessages,
              }),
              "live",
              opts.signal,
            );
            const contReader = cont.body?.getReader();
            if (!contReader) throw new Error("No continuation body");

            rememberStickyModel(opts.sessionId, nextModel, opts.analysis);
            terminal.modelId = nextModel;
            // Reset finish markers so the new model can emit its own terminal
            terminal.sawFinishReason = false;
            terminal.sawDone = false;

            const pumped = await pumpReader(contReader, nextModel, true);
            if (pumped.idleTimedOut) {
              recordFailure(nextModel, undefined, "idle timeout", Date.now() - contStarted);
              opts.attempts.push({
                modelId: nextModel,
                startedAt: contStarted,
                endedAt: Date.now(),
                ttftMs: null,
                error: "idle timeout",
                abandonedReason: "idle_timeout_handoff",
                role: "continue",
              });
              trackSegment({
                modelId: nextModel,
                role: "continue",
                inputTokens: estimateTokens(opts.usage.text),
                outputTokens: 0,
                startedAt: contStarted,
                endedAt: Date.now(),
                status: "failed",
                label: `handoff timeout → ${nextModel}`,
                error: "idle timeout",
              });
              handoffReason = "idle timeout";
              prevModel = nextModel;
              continue;
            }

            recordSuccess(nextModel, Date.now() - contStarted, Date.now() - contStarted);
            opts.attempts.push({
              modelId: nextModel,
              startedAt: contStarted,
              endedAt: Date.now(),
              ttftMs: null,
              error: null,
              abandonedReason: "midstream_continue",
              role: "continue",
            });
            trackSegment({
              modelId: nextModel,
              role: "continue",
              inputTokens: estimateTokens(opts.usage.text),
              outputTokens: estimateTokens(opts.usage.text),
              startedAt: contStarted,
              endedAt: Date.now(),
              status: "success",
              label: `handoff → ${nextModel}`,
            });
            finalChosen = nextModel;
            enqueueTerminal("stop");
            controller.close();
            return;
          } catch (contErr) {
            const msg = contErr instanceof Error ? contErr.message : String(contErr);
            recordFailure(nextModel, undefined, msg, Date.now() - contStarted);
            opts.attempts.push({
              modelId: nextModel,
              startedAt: contStarted,
              endedAt: Date.now(),
              ttftMs: null,
              error: msg,
              abandonedReason: "handoff_failed",
              role: "continue",
            });
            trackSegment({
              modelId: nextModel,
              role: "continue",
              inputTokens: estimateTokens(opts.usage.text),
              outputTokens: 0,
              startedAt: contStarted,
              endedAt: Date.now(),
              status: "failed",
              label: `handoff failed → ${nextModel}`,
              error: msg,
            });
            handoffReason = msg;
            prevModel = nextModel;
          }
        }
      };

      try {
        // First chunk already buffered before commit
        {
          const text = decoder.decode(opts.firstChunk, { stream: true }).replace(
            /"model"\s*:\s*"[^"]*"/g,
            `"model":"${opts.modelId}"`,
          );
          extractPartial(text, opts.usage);
          observeOpenAiSse(text, terminal);
          controller.enqueue(encoder.encode(text));
        }

        const pumped = await pumpReader(opts.reader, opts.modelId, true);
        if (pumped.idleTimedOut) {
          recordFailure(opts.modelId, undefined, "idle timeout");
          if (opts.partialStreamBehavior === "error") {
            enqueueTerminal("length");
            controller.close();
            return;
          }
          await handoffToNextModels("idle timeout", opts.modelId);
          return;
        }
        enqueueTerminal("stop");
        controller.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        recordFailure(opts.modelId, undefined, message);
        if (opts.partialStreamBehavior === "error") {
          try {
            enqueueTerminal("stop");
            controller.close();
          } catch {
            // consumer gone
          }
          return;
        }
        await handoffToNextModels(message, opts.modelId);
      } finally {
        opts.onStreamComplete?.(collectedSegments, finalChosen);
      }
    },
  });
}

function extractPartial(
  sseText: string,
  usage: { prompt: number; completion: number; estimated: boolean; text: string },
) {
  for (const line of sseText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      if (parsed.choices?.[0]?.delta?.content) {
        usage.text += parsed.choices[0].delta.content;
      }
      if (parsed.usage) {
        usage.estimated = false;
        usage.prompt = parsed.usage.prompt_tokens ?? usage.prompt;
        usage.completion = parsed.usage.completion_tokens ?? usage.completion;
      }
    } catch {
      // ignore non-json sse
    }
  }
}
