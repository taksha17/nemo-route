import type { RequestPriority } from "@nemo-route/shared";
import { env } from "../config/env.js";
import { getGovernor, type GovernorPriority } from "./rateGovernor.js";

export class NimHttpError extends Error {
  constructor(
    public status: number,
    public body: string,
    public modelId?: string,
  ) {
    super(`NIM HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = "NimHttpError";
  }
}

export interface ChatMessage {
  role: string;
  content: unknown;
  name?: string;
  tool_calls?: unknown;
  tool_call_id?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  stop?: string | string[];
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  user?: string;
  stream_options?: { include_usage?: boolean };
  [key: string]: unknown;
}

export interface EmbeddingRequest {
  model: string;
  input: string | string[];
  encoding_format?: string;
  [key: string]: unknown;
}

export interface NimClientOptions {
  apiKey: string;
  baseUrl?: string;
  governorKey?: string;
  rpmLimit?: number;
  dailyLimit?: number;
  probeRpmBudget?: number;
}

export class NimClient {
  readonly baseUrl: string;
  readonly apiKey: string;
  private governorKey: string;

  constructor(private opts: NimClientOptions) {
    this.baseUrl = (opts.baseUrl ?? env.nimBaseUrl).replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.governorKey = opts.governorKey ?? opts.apiKey.slice(0, 16);
  }

  private governor() {
    return getGovernor(
      this.governorKey,
      this.opts.rpmLimit ?? 40,
      this.opts.dailyLimit ?? 10_000,
      this.opts.probeRpmBudget ?? 4,
    );
  }

  getGovernorStats() {
    return this.governor().getStats();
  }

  async listModels(): Promise<{ data: Array<{ id: string; owned_by?: string }> }> {
    // Catalog listing is free / unauthenticated on NIM; don't burn RPM
    const res = await fetch(`${this.baseUrl}/models`, {
      method: "GET",
      headers: this.apiKey
        ? { Authorization: `Bearer ${this.apiKey}` }
        : undefined,
    });
    if (!res.ok) {
      throw new NimHttpError(res.status, await res.text());
    }
    return (await res.json()) as { data: Array<{ id: string; owned_by?: string }> };
  }

  async chatCompletions(
    body: ChatCompletionRequest,
    priority: GovernorPriority = "live",
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.governor().schedule(
      priority,
      async () => {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            Accept: body.stream ? "text/event-stream" : "application/json",
          },
          body: JSON.stringify(body),
          signal,
        });
        if (!res.ok) {
          const text = await res.text();
          throw new NimHttpError(res.status, text, body.model);
        }
        return res;
      },
      signal,
    );
  }

  async embeddings(
    body: EmbeddingRequest,
    priority: GovernorPriority = "live",
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.governor().schedule(
      priority,
      async () => {
        const res = await fetch(`${this.baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal,
        });
        if (!res.ok) {
          const text = await res.text();
          throw new NimHttpError(res.status, text, body.model);
        }
        return res;
      },
      signal,
    );
  }

  async probeModel(
    modelId: string,
    signal?: AbortSignal,
    timeoutMs = 20_000,
  ): Promise<{
    ok: boolean;
    latencyMs: number;
    status?: number;
    error?: string;
  }> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onOuter = () => controller.abort();
    signal?.addEventListener("abort", onOuter);
    try {
      const res = await this.chatCompletions(
        {
          model: modelId,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          stream: false,
        },
        "probe",
        controller.signal,
      );
      await res.json();
      return { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      const latencyMs = Date.now() - started;
      if (err instanceof NimHttpError) {
        return { ok: false, latencyMs, status: err.status, error: err.message };
      }
      const message = err instanceof Error ? err.message : String(err);
      if (controller.signal.aborted && !signal?.aborted) {
        return { ok: false, latencyMs, error: `probe timeout after ${timeoutMs}ms` };
      }
      return { ok: false, latencyMs, error: message };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onOuter);
    }
  }
}

export function classifyNimError(status: number | undefined, message: string): {
  kind: "not_entitled" | "removed" | "rate_limited" | "transient" | "unknown";
  againstModel: boolean;
} {
  if (status === 401 || status === 403) {
    return { kind: "not_entitled", againstModel: true };
  }
  if (status === 404) {
    return { kind: "removed", againstModel: true };
  }
  if (status === 429) {
    return { kind: "rate_limited", againstModel: false };
  }
  if (status && status >= 500) {
    return { kind: "transient", againstModel: true };
  }
  // Client disconnect / caller abort must not trip model circuits
  if (/client aborted|client disconnect|request aborted by client/i.test(message)) {
    return { kind: "transient", againstModel: false };
  }
  if (/timeout|aborted|network|ECONNRESET|ETIMEDOUT/i.test(message)) {
    return { kind: "transient", againstModel: true };
  }
  return { kind: "unknown", againstModel: true };
}
