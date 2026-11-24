import type { AppContext } from "../appContext.js";
import { listHealth, listChatModels } from "../scout/registry.js";
import { getOverviewStats } from "../telemetry/recorder.js";
import { listLiveRouting } from "../telemetry/liveRouting.js";

export function buildPrometheusMetrics(
  ctx: AppContext,
  gov?: {
    rpmUsed: number;
    rpmLimit: number;
    dailyRequests: number;
    dailyLimit: number;
    queueDepth: number;
    inFlight?: number;
  } | null,
): string {
  const stats = getOverviewStats(gov ?? undefined);
  const health = listHealth();
  const chats = listChatModels();
  const live = listLiveRouting();
  const lines: string[] = [
    "# HELP nemo_up Nemo-route process is up",
    "# TYPE nemo_up gauge",
    "nemo_up 1",
    "# HELP nemo_rpm_used Requests in the current rolling minute",
    "# TYPE nemo_rpm_used gauge",
    `nemo_rpm_used ${gov?.rpmUsed ?? stats.rpmUsed ?? 0}`,
    "# HELP nemo_rpm_limit Configured RPM limit",
    "# TYPE nemo_rpm_limit gauge",
    `nemo_rpm_limit ${gov?.rpmLimit ?? stats.rpmLimit ?? 40}`,
    "# HELP nemo_daily_requests Requests today (UTC)",
    "# TYPE nemo_daily_requests gauge",
    `nemo_daily_requests ${gov?.dailyRequests ?? stats.dailyRequests ?? 0}`,
    "# HELP nemo_queue_depth Rate governor queue depth",
    "# TYPE nemo_queue_depth gauge",
    `nemo_queue_depth ${gov?.queueDepth ?? stats.queueDepth ?? 0}`,
    "# HELP nemo_success_rate_24h Success rate over last 24h",
    "# TYPE nemo_success_rate_24h gauge",
    `nemo_success_rate_24h ${stats.successRate ?? 0}`,
    "# HELP nemo_failovers_24h Failover count over last 24h",
    "# TYPE nemo_failovers_24h counter",
    `nemo_failovers_24h ${stats.failovers ?? 0}`,
    "# HELP nemo_tokens_in_24h Input tokens over last 24h",
    "# TYPE nemo_tokens_in_24h counter",
    `nemo_tokens_in_24h ${stats.tokensIn ?? 0}`,
    "# HELP nemo_tokens_out_24h Output tokens over last 24h",
    "# TYPE nemo_tokens_out_24h counter",
    `nemo_tokens_out_24h ${stats.tokensOut ?? 0}`,
    "# HELP nemo_healthy_chat_models Healthy in-catalog chat models",
    "# TYPE nemo_healthy_chat_models gauge",
    `nemo_healthy_chat_models ${stats.healthyModels ?? 0}`,
    "# HELP nemo_chat_models Total in-catalog chat models",
    "# TYPE nemo_chat_models gauge",
    `nemo_chat_models ${stats.totalChatModels ?? chats.length}`,
    "# HELP nemo_live_routing_active Active live-routing sessions",
    "# TYPE nemo_live_routing_active gauge",
    `nemo_live_routing_active ${live.active.length}`,
    "# HELP nemo_model_status Model health status (1=healthy,0.5=degraded,0=other)",
    "# TYPE nemo_model_status gauge",
  ];

  for (const h of health) {
    if (!h.inCatalog) continue;
    const val =
      h.status === "healthy" ? 1 : h.status === "degraded" ? 0.5 : 0;
    const id = escapeLabel(h.modelId);
    const status = escapeLabel(h.status);
    lines.push(`nemo_model_status{model_id="${id}",status="${status}"} ${val}`);
  }

  void ctx;
  return `${lines.join("\n")}\n`;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}
