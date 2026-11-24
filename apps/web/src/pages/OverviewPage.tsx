import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { Button, PageHeader, Panel, Stat } from "../components/ui";
import { Icons } from "../components/icons";

export default function OverviewPage() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  async function load() {
    try {
      setData(await api.overview());
      setError(null);
      setTick((t) => t + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, []);

  const rpmUsed = data?.rpmUsed ?? 0;
  const rpmLimit = data?.rpmLimit ?? 40;
  const dailyUsed = data?.dailyRequests ?? 0;
  const dailyLimit = data?.dailyLimit ?? 10000;
  const healthy = data?.healthyModels ?? 0;
  const total = data?.totalChatModels ?? 0;

  return (
    <div>
      <PageHeader
        title="Overview"
        subtitle="Live RPM budget, token usage, model health, and failover activity across the router."
        actions={
          <Button onClick={() => void load()}>
            <Icons.refresh size={15} />
            Refresh
          </Button>
        }
      />

      {error ? (
        <Panel tone="warn" className="mb-5 text-sm">
          {error}. Is the server running on :8788?
        </Panel>
      ) : null}

      {!data?.hasNimKey ? (
        <Panel tone="warn" className="mb-5 text-sm">
          No NIM API key configured.{" "}
          <Link to="/setup" className="font-semibold">
            Add one in Setup
          </Link>
          .
        </Panel>
      ) : null}

      <div className="mb-3 flex items-center gap-2 text-xs text-[var(--muted)]">
        <span className="live-dot" />
        Live metrics · refreshed {tick > 0 ? "just now" : "…"}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <Stat
          live
          label="RPM used"
          value={`${rpmUsed}/${rpmLimit}`}
          hint={`Queue depth ${data?.queueDepth ?? 0}`}
          progress={rpmLimit ? (rpmUsed / rpmLimit) * 100 : 0}
        />
        <Stat
          live
          label="Daily requests"
          value={`${dailyUsed}/${dailyLimit}`}
          progress={dailyLimit ? (dailyUsed / dailyLimit) * 100 : 0}
        />
        <Stat
          live
          label="Tokens (24h)"
          value={`${data?.tokensIn ?? 0} → ${data?.tokensOut ?? 0}`}
          hint="input → output"
        />
        <Stat
          live
          label="Success rate"
          value={`${Math.round((data?.successRate ?? 1) * 100)}%`}
          hint={`${data?.failovers ?? 0} failovers`}
          progress={Math.round((data?.successRate ?? 1) * 100)}
        />
        <Stat
          live
          label="Healthy chat models"
          value={`${healthy}/${total}`}
          progress={total ? (healthy / total) * 100 : 0}
        />
        <Stat
          label="Catalog sync"
          value={
            data?.catalog?.lastSyncAt
              ? new Date(data.catalog.lastSyncAt).toLocaleTimeString()
              : "never"
          }
          hint={data?.catalog?.lastError ?? "ok"}
        />
      </div>
    </div>
  );
}
