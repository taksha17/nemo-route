/**
 * Minimal plugin/hook surface for custom routing strategies.
 * Register hooks before the server starts accepting traffic.
 */
import type { AnalysisResult } from "@nemo-route/shared";

export type RouteHookContext = {
  requestedModel: string;
  analysis: AnalysisResult;
  chain: string[];
};

export type RouteHook = (ctx: RouteHookContext) => RouteHookContext | void;

const hooks: RouteHook[] = [];

export function registerRouteHook(hook: RouteHook) {
  hooks.push(hook);
  return () => {
    const i = hooks.indexOf(hook);
    if (i >= 0) hooks.splice(i, 1);
  };
}

export function applyRouteHooks(ctx: RouteHookContext): RouteHookContext {
  let current = ctx;
  for (const hook of hooks) {
    const next = hook(current);
    if (next) current = next;
  }
  return current;
}

export function listRouteHooks() {
  return hooks.length;
}
