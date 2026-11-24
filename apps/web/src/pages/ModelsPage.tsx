import { useEffect, useState } from "react";
import { api } from "../lib/api";
import {
  Button,
  PageHeader,
  Panel,
  SegmentedControl,
  StatusPill,
  formatContext,
} from "../components/ui";
import { Icons } from "../components/icons";

export default function ModelsPage() {
  const [models, setModels] = useState<any[]>([]);
  const [filter, setFilter] = useState<"all" | "chat" | "other">("chat");

  async function load() {
    const res = await api.models();
    setModels(res.models);
  }

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 8000);
    return () => clearInterval(t);
  }, []);

  const filtered = models.filter((m) => {
    if (filter === "chat") return m.kind === "chat";
    if (filter === "other") return m.kind !== "chat";
    return true;
  });

  return (
    <div>
      <PageHeader
        title="Models"
        subtitle="Live catalog membership, capability tags, and health from traffic plus budgeted probes."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" onClick={() => void api.syncCatalog().then(load)}>
              Sync catalog
            </Button>
            <Button variant="ghost" onClick={() => void api.healthBootstrap().then(load)}>
              Re-check all
            </Button>
            <Button onClick={() => void load()}>
              <Icons.refresh size={15} />
              Refresh
            </Button>
          </div>
        }
      />

      <div className="mb-4 flex items-center justify-between gap-3">
        <SegmentedControl
          value={filter}
          onChange={setFilter}
          options={[
            { value: "chat", label: "Chat" },
            { value: "other", label: "Other" },
            { value: "all", label: "All" },
          ]}
        />
        <div className="text-xs text-[var(--muted)]">{filtered.length} models</div>
      </div>

      <Panel className="overflow-auto p-0">
        <table className="data-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Kind</th>
              <th>Context</th>
              <th>Tier</th>
              <th>Status</th>
              <th>Latency</th>
              <th>Capabilities</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((m) => (
              <tr key={m.id}>
                <td>
                  <div className="font-semibold tracking-[-0.02em]">{m.displayName}</div>
                  <div className="mono mt-0.5 text-xs text-[var(--muted)]">{m.id}</div>
                </td>
                <td className="text-[var(--muted)]">{m.kind}</td>
                <td className="mono text-xs">{formatContext(m.contextTokens)}</td>
                <td>{m.tier}</td>
                <td>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill status={m.health?.status ?? "unknown"} />
                    {!m.health?.inCatalog ? (
                      <span className="text-xs text-[var(--muted)]">out of catalog</span>
                    ) : null}
                  </div>
                </td>
                <td className="mono text-xs text-[var(--muted)]">
                  {m.health?.avgTtftMs != null
                    ? `${Math.round(m.health.avgTtftMs)}ms TTFT`
                    : "—"}
                </td>
                <td className="max-w-[28ch] text-xs leading-relaxed text-[var(--muted)]">
                  {m.inputs?.join(", ")}
                  {m.tools ? " · tools" : ""}
                  {m.strengths?.length ? ` · ${m.strengths.join(", ")}` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
