import type { RequestPriority } from "@nemo-route/shared";

export type GovernorPriority = RequestPriority;

interface QueueItem<T> {
  priority: GovernorPriority;
  enqueuedAt: number;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
  run: () => Promise<T>;
  signal?: AbortSignal;
}

const PRIORITY_ORDER: Record<GovernorPriority, number> = {
  live: 0,
  orchestrate: 1,
  probe: 2,
};

export class RateGovernor {
  private tokens: number;
  private lastRefill: number;
  private queue: QueueItem<unknown>[] = [];
  private processing = false;
  private requestTimestamps: number[] = [];
  private day = todayKey();
  private dayCount = 0;
  private probeTs: number[] = [];
  private inFlight = 0;

  constructor(
    public rpmLimit: number,
    public dailyLimit: number,
    public probeRpmBudget: number,
  ) {
    this.tokens = rpmLimit;
    this.lastRefill = Date.now();
  }

  updateLimits(rpm: number, daily: number, probeRpm: number) {
    this.rpmLimit = rpm;
    this.dailyLimit = daily;
    this.probeRpmBudget = probeRpm;
    this.tokens = Math.min(this.tokens, rpm);
  }

  getStats() {
    this.refill();
    this.pruneWindow();
    return {
      rpmUsed: this.requestTimestamps.length,
      rpmLimit: this.rpmLimit,
      dailyRequests: this.dayCount,
      dailyLimit: this.dailyLimit,
      queueDepth: this.queue.length,
      tokens: this.tokens,
      probeRpmBudget: this.probeRpmBudget,
      inFlight: this.inFlight,
    };
  }

  async schedule<T>(
    priority: GovernorPriority,
    run: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(new Error("client aborted"));
    }
    return new Promise<T>((resolve, reject) => {
      const item: QueueItem<T> = {
        priority,
        enqueuedAt: Date.now(),
        resolve,
        reject,
        run,
        signal,
      };
      this.queue.push(item as QueueItem<unknown>);
      this.queue.sort((a, b) => {
        const p = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
        if (p !== 0) return p;
        return a.enqueuedAt - b.enqueuedAt;
      });
      const onAbort = () => {
        const idx = this.queue.indexOf(item as QueueItem<unknown>);
        if (idx >= 0) {
          this.queue.splice(idx, 1);
          reject(new Error("client aborted"));
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      // Defer so same-tick enqueues can sort before work starts
      queueMicrotask(() => void this.pump());
    });
  }

  private refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    const perMs = this.rpmLimit / 60_000;
    this.tokens = Math.min(this.rpmLimit, this.tokens + elapsed * perMs);
    this.lastRefill = now;

    const key = todayKey();
    if (key !== this.day) {
      this.day = key;
      this.dayCount = 0;
    }
  }

  private pruneWindow() {
    const cutoff = Date.now() - 60_000;
    this.requestTimestamps = this.requestTimestamps.filter((t) => t >= cutoff);
  }

  private canTake(priority: GovernorPriority): boolean {
    this.refill();
    this.pruneWindow();
    if (this.dayCount >= this.dailyLimit) return false;
    if (this.tokens < 1) return false;
    if (this.requestTimestamps.length >= this.rpmLimit) return false;
    if (priority === "probe") {
      if (this.probeTimestamps().length >= this.probeRpmBudget) return false;
      // Leave at least one RPM slot for live traffic when possible
      if (this.requestTimestamps.length >= Math.max(1, this.rpmLimit - 1)) return false;
    }
    return true;
  }

  private probeTimestamps() {
    const cutoff = Date.now() - 60_000;
    this.probeTs = this.probeTs.filter((t) => t >= cutoff);
    return this.probeTs;
  }

  private async pump() {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue[0]!;
        if (next.signal?.aborted) {
          this.queue.shift();
          next.reject(new Error("client aborted"));
          continue;
        }
        if (!this.canTake(next.priority)) {
          // Wait briefly for tokens / window slots, then retry
          await sleep(50);
          // If still blocked and nothing in flight, keep waiting; otherwise
          // yield so completions can re-enter pump.
          if (this.inFlight > 0) break;
          continue;
        }
        this.queue.shift();
        this.tokens -= 1;
        const now = Date.now();
        this.requestTimestamps.push(now);
        this.dayCount += 1;
        if (next.priority === "probe") this.probeTs.push(now);

        // Admit without awaiting completion — avoids head-of-line blocking on slow NIM calls
        this.inFlight += 1;
        void next
          .run()
          .then(
            (result) => next.resolve(result),
            (err) =>
              next.reject(err instanceof Error ? err : new Error(String(err))),
          )
          .finally(() => {
            this.inFlight -= 1;
            queueMicrotask(() => void this.pump());
          });
      }
    } finally {
      this.processing = false;
      if (this.queue.length > 0 && this.inFlight === 0) {
        // Only self-reenter when idle; in-flight completions already re-pump
        queueMicrotask(() => void this.pump());
      } else if (this.queue.length > 0) {
        // Tokens may free up while work is in flight — schedule a wake
        setTimeout(() => void this.pump(), 50);
      }
    }
  }
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const governors = new Map<string, RateGovernor>();

export function getGovernor(
  keyId: string,
  rpm = 40,
  daily = 10_000,
  probeRpm = 4,
): RateGovernor {
  let g = governors.get(keyId);
  if (!g) {
    g = new RateGovernor(rpm, daily, probeRpm);
    governors.set(keyId, g);
  } else {
    g.updateLimits(rpm, daily, probeRpm);
  }
  return g;
}

export function resetGovernors() {
  governors.clear();
}
