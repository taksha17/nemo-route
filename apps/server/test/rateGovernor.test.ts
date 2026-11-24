import { describe, expect, it } from "vitest";
import { RateGovernor } from "../src/upstream/rateGovernor.js";

describe("RateGovernor", () => {
  it("prioritizes live over probe", async () => {
    const g = new RateGovernor(100, 10_000, 50);
    const order: string[] = [];
    const tasks = [
      g.schedule("probe", async () => {
        order.push("probe");
        return 1;
      }),
      g.schedule("live", async () => {
        order.push("live");
        return 2;
      }),
      g.schedule("orchestrate", async () => {
        order.push("orchestrate");
        return 3;
      }),
    ];
    await Promise.all(tasks);
    expect(order[0]).toBe("live");
    expect(order.indexOf("orchestrate")).toBeLessThan(order.indexOf("probe"));
  });

  it("tracks rpm usage", async () => {
    const g = new RateGovernor(40, 10_000, 4);
    await g.schedule("live", async () => "ok");
    const stats = g.getStats();
    expect(stats.rpmUsed).toBeGreaterThanOrEqual(1);
    expect(stats.dailyRequests).toBeGreaterThanOrEqual(1);
  });
});
