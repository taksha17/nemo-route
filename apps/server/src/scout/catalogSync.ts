import { env } from "../config/env.js";
import { getSettings } from "../db/workspace.js";
import { NimClient } from "../upstream/nimClient.js";
import { globalBus } from "../admin/events.js";
import {
  markMissingFromCatalog,
  seedRegistry,
  upsertCatalogModel,
} from "./registry.js";

export class CatalogSync {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSyncAt: number | null = null;
  private lastError: string | null = null;

  constructor(private getClient: () => NimClient | null) {}

  start() {
    seedRegistry();
    const settings = getSettings();
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.sync(), settings.catalogPollMs);
    void this.sync();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getStatus() {
    return {
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
    };
  }

  async sync() {
    seedRegistry(env.workspaceId);
    const client = this.getClient();
    if (!client) {
      this.lastError = "No NIM API key configured";
      return;
    }
    try {
      const listing = await client.listModels();
      const present = new Set<string>();
      for (const m of listing.data ?? []) {
        present.add(m.id);
        upsertCatalogModel(m.id, m.owned_by ?? m.id.split("/")[0] ?? "unknown");
      }
      markMissingFromCatalog(present);
      this.lastSyncAt = Date.now();
      this.lastError = null;
      globalBus.emit("catalog", {
        at: this.lastSyncAt,
        count: present.size,
      });
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      globalBus.emit("catalog_error", { error: this.lastError });
    }
  }
}
