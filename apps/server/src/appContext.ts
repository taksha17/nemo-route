import { CatalogSync } from "./scout/catalogSync.js";
import {
  HealthProbeLoop,
  bootstrapAllChatHealth,
  getBootstrapStatus,
  recordProbe,
} from "./scout/health.js";
import { getNimApiKey, getSettings } from "./db/workspace.js";
import { NimClient } from "./upstream/nimClient.js";
import { env } from "./config/env.js";
import { seedRegistry } from "./scout/registry.js";

export class AppContext {
  catalogSync: CatalogSync;
  probeLoop: HealthProbeLoop;
  private clientCache: { key: string; client: NimClient } | null = null;
  private bootstrapPromise: Promise<unknown> | null = null;

  constructor() {
    this.catalogSync = new CatalogSync(() => this.getNimClient());
    this.probeLoop = new HealthProbeLoop(async (modelId) => {
      const client = this.getNimClient();
      if (!client) return;
      // Skip background probes while bootstrap owns the queue
      if (getBootstrapStatus().running) return;
      const result = await client.probeModel(modelId);
      recordProbe(modelId, result.ok, result.latencyMs, result.status, result.error);
    });
  }

  start() {
    seedRegistry();
    this.catalogSync.start();
    this.probeLoop.start();
    // Eager health sweep as soon as a NIM key exists
    void this.runBootstrap("startup");
  }

  stop() {
    this.catalogSync.stop();
    this.probeLoop.stop();
  }

  getNimClient(): NimClient | null {
    const key = getNimApiKey();
    if (!key) return null;
    const settings = getSettings();
    if (this.clientCache?.key === key) {
      return this.clientCache.client;
    }
    const client = new NimClient({
      apiKey: key,
      baseUrl: env.nimBaseUrl,
      rpmLimit: settings.rpmLimit,
      dailyLimit: settings.dailyRequestLimit,
      // Keep probe budget separate from live RPM so probes cannot starve chat traffic
      probeRpmBudget: settings.probeRpmBudget,
    });
    this.clientCache = { key, client };
    return client;
  }

  invalidateClient() {
    this.clientCache = null;
  }

  async runBootstrap(reason = "manual") {
    const client = this.getNimClient();
    if (!client) return null;
    if (this.bootstrapPromise) return this.bootstrapPromise;
    console.log(`[nemo-route] health bootstrap starting (${reason})`);
    this.bootstrapPromise = (async () => {
      try {
        await this.catalogSync.sync();
        const result = await bootstrapAllChatHealth(client);
        console.log(
          `[nemo-route] health bootstrap done: checked=${result.checked} healthy=${result.healthy} failed=${result.failed}`,
        );
        return result;
      } finally {
        this.bootstrapPromise = null;
      }
    })();
    return this.bootstrapPromise;
  }
}
