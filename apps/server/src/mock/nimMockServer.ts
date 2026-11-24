import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export type FaultMode =
  | "ok"
  | "slow_start"
  | "mid_stream_drop"
  | "403"
  | "404"
  | "429"
  | "500"
  | "timeout";

export interface MockModelConfig {
  id: string;
  owned_by?: string;
  fault?: FaultMode;
  delayMs?: number;
  responseText?: string;
}

export class NimMockServer {
  private server: Server | null = null;
  private models = new Map<string, MockModelConfig>();
  private port = 0;
  requestLog: Array<{ path: string; model?: string; at: number }> = [];

  setModels(models: MockModelConfig[]) {
    this.models.clear();
    for (const m of models) this.models.set(m.id, m);
  }

  setFault(modelId: string, fault: FaultMode) {
    const m = this.models.get(modelId);
    if (m) m.fault = fault;
  }

  get baseUrl() {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  async start(port = 0): Promise<string> {
    if (this.server) return this.baseUrl;
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => {
      this.server!.listen(port, "127.0.0.1", () => resolve());
    });
    const addr = this.server.address();
    if (addr && typeof addr === "object") this.port = addr.port;
    return this.baseUrl;
  }

  async stop() {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => (err ? reject(err) : resolve()));
    });
    this.server = null;
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", `http://127.0.0.1`);
    this.requestLog.push({ path: url.pathname, at: Date.now() });

    if (req.method === "GET" && url.pathname === "/v1/models") {
      const data = [...this.models.values()].map((m) => ({
        id: m.id,
        object: "model",
        owned_by: m.owned_by ?? "mock",
      }));
      return json(res, 200, { object: "list", data });
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const raw = await this.readBody(req);
      let body: { model?: string; stream?: boolean; messages?: unknown[] };
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: { message: "invalid json" } });
      }
      const modelId = body.model ?? "";
      this.requestLog[this.requestLog.length - 1]!.model = modelId;
      const cfg = this.models.get(modelId);
      if (!cfg) return json(res, 404, { error: { message: `model ${modelId} not found` } });

      const fault = cfg.fault ?? "ok";
      if (fault === "403") return json(res, 403, { error: { message: "forbidden" } });
      if (fault === "404") return json(res, 404, { error: { message: "not found" } });
      if (fault === "429") return json(res, 429, { error: { message: "rate limited" } });
      if (fault === "500") return json(res, 500, { error: { message: "internal" } });
      if (fault === "timeout") {
        // hang until client aborts
        return;
      }

      const text = cfg.responseText ?? `hello from ${modelId}`;
      const delay = cfg.delayMs ?? (fault === "slow_start" ? 800 : 0);
      if (delay > 0) await sleep(delay);

      if (body.stream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const id = `chatcmpl-mock-${Date.now()}`;
        writeSse(res, {
          id,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: modelId,
          choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
        });
        if (fault === "mid_stream_drop") {
          writeSse(res, {
            id,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: modelId,
            choices: [{ index: 0, delta: { content: text.slice(0, 5) }, finish_reason: null }],
          });
          res.destroy();
          return;
        }
        for (const ch of text.match(/.{1,8}/g) ?? [text]) {
          writeSse(res, {
            id,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: modelId,
            choices: [{ index: 0, delta: { content: ch }, finish_reason: null }],
          });
          await sleep(5);
        }
        writeSse(res, {
          id,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: modelId,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
        });
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      return json(res, 200, {
        id: `chatcmpl-mock-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: modelId,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: text },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
      });
    }

    if (req.method === "POST" && url.pathname === "/v1/embeddings") {
      const raw = await this.readBody(req);
      const body = JSON.parse(raw) as { model: string; input: string | string[] };
      return json(res, 200, {
        object: "list",
        data: [
          {
            object: "embedding",
            index: 0,
            embedding: Array.from({ length: 8 }, (_, i) => i * 0.1),
          },
        ],
        model: body.model,
        usage: { prompt_tokens: 2, total_tokens: 2 },
      });
    }

    json(res, 404, { error: { message: "not found" } });
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function writeSse(res: ServerResponse, data: unknown) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
