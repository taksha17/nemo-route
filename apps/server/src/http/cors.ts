import type { Hono } from "hono";
import { cors } from "hono/cors";

/**
 * Wildcard CORS is limited to the inference API. The admin surface is
 * same-origin with the dashboard and must not be readable from other sites.
 */
export function installGatewayCors(app: Hono) {
  app.use(
    "/v1/*",
    cors({
      origin: "*",
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "x-api-key",
        "anthropic-version",
        "anthropic-beta",
      ],
      allowMethods: ["GET", "POST", "OPTIONS"],
    }),
  );
}
