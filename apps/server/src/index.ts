import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAdminRouter } from "./admin/api.js";
import { buildPrometheusMetrics } from "./admin/metrics.js";
import { AppContext } from "./appContext.js";
import { env, isLoopbackHost } from "./config/env.js";
import { getDb } from "./db/client.js";
import { createAnthropicRouter } from "./gateway/anthropic.js";
import { createOpenAIRouter } from "./gateway/openai.js";
import { installGatewayCors } from "./http/cors.js";
import { seedRegistry } from "./scout/registry.js";
import { protectStoredBodies } from "./telemetry/recorder.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

getDb();
protectStoredBodies();
seedRegistry();

const ctx = new AppContext();
ctx.start();

const app = new Hono();

installGatewayCors(app);

app.get("/healthz", (c) => c.json({ ok: true, name: "nemo-route" }));

app.get("/metrics", (c) => {
  const gov = ctx.getNimClient()?.getGovernorStats() ?? null;
  return c.body(buildPrometheusMetrics(ctx, gov), 200, {
    "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
  });
});

// Anthropic routes first so /v1/messages is not swallowed by the OpenAI sub-app
app.route("/v1", createAnthropicRouter(() => ctx));
app.route("/v1", createOpenAIRouter(() => ctx));

const exposeAdmin = isLoopbackHost(env.host) || process.env.NEMO_EXPOSE_ADMIN === "1";
if (exposeAdmin) {
  app.route("/admin", createAdminRouter(() => ctx));
} else {
  console.error(
    `[nemo-route] Admin API is not mounted because NEMO_HOST=${env.host} is not loopback. ` +
      "Set NEMO_EXPOSE_ADMIN=1 to expose /admin on this interface.",
  );
}

// Serve dashboard if built
const webDist = path.resolve(__dirname, "../../web/dist");
if (fs.existsSync(webDist)) {
  app.use(
    "/*",
    serveStatic({
      root: webDist,
      rewriteRequestPath: (p) => (p === "/" ? "/index.html" : p),
    }),
  );
  app.get("*", async (c) => {
    const index = path.join(webDist, "index.html");
    if (fs.existsSync(index)) {
      return c.html(fs.readFileSync(index, "utf8"));
    }
    return c.text("Nemo-route API is running. Build the web app for the dashboard.", 200);
  });
} else {
  app.get("/", (c) =>
    c.html(`<!doctype html>
<html><head><title>Nemo-route</title>
<style>
body{font-family:ui-sans-serif,system-ui;background:#0b1220;color:#e8eefc;display:grid;place-items:center;min-height:100vh;margin:0}
card{max-width:640px;padding:2rem}
a{color:#76b900}
code{background:#1a2438;padding:.1rem .35rem;border-radius:4px}
</style></head>
<body><card>
<h1>Nemo-route</h1>
<p>API is up on <code>http://${env.host}:${env.port}</code>.</p>
<p>OpenAI: <code>/v1/chat/completions</code> · Anthropic: <code>/v1/messages</code> · Admin: <code>/admin/overview</code></p>
<p>Run <code>pnpm --filter @nemo-route/web build</code> (or <code>pnpm dev</code>) for the dashboard.</p>
</card></body></html>`),
  );
}

console.log(`Nemo-route listening on http://${env.host}:${env.port}`);
serve({ fetch: app.fetch, hostname: env.host, port: env.port });

process.on("unhandledRejection", (reason) => {
  console.error("[nemo-route] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[nemo-route] uncaughtException:", err);
  const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
  if (code === "EADDRINUSE") process.exit(1);
});

process.on("SIGINT", () => {
  ctx.stop();
  process.exit(0);
});
