import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Button, EmptyState, PageHeader, Panel, StatusPill } from "../components/ui";
import { Icons } from "../components/icons";

export default function RequestsPage() {
  const [requests, setRequests] = useState<any[]>([]);
  const [selected, setSelected] = useState<any | null>(null);

  async function load() {
    setRequests((await api.requests(150)).requests);
  }

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, []);

  return (
    <div>
      <PageHeader
        title="Requests"
        subtitle="Live request log with routing traces: classification, chosen model, and failover attempts."
        actions={
          <Button onClick={() => void load()}>
            <Icons.refresh size={15} />
            Refresh
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.45fr_1fr]">
        <Panel className="max-h-[72vh] overflow-auto p-0">
          <table className="data-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Requested</th>
                <th>Chosen</th>
                <th>Task</th>
                <th>Tokens</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr
                  key={r.id}
                  className={selected?.id === r.id ? "is-selected" : ""}
                  onClick={() => setSelected(r)}
                  style={{ cursor: "pointer" }}
                >
                  <td className="mono text-xs text-[var(--muted)]">
                    {new Date(r.createdAt).toLocaleTimeString()}
                  </td>
                  <td className="mono text-xs">{r.requestedModel}</td>
                  <td className="mono text-xs">{r.chosenModel ?? "—"}</td>
                  <td className="text-xs text-[var(--muted)]">
                    {r.taskType}/{r.complexity}
                  </td>
                  <td className="mono text-xs">
                    {r.inputTokens}/{r.outputTokens}
                  </td>
                  <td>
                    <StatusPill status={r.outcome ?? "unknown"} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!requests.length ? (
            <EmptyState
              title="No requests yet"
              body="Send traffic through the OpenAI or Anthropic gateway to see routing traces here."
            />
          ) : null}
        </Panel>

        <Panel className="max-h-[72vh] overflow-auto">
          <div className="mb-4 flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold tracking-[-0.02em]">Routing trace</h2>
            {selected ? <span className="live-dot" /> : null}
          </div>
          {selected ? (
            <div className="space-y-4 text-sm">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--muted)]">
                  Request
                </div>
                <div className="mono mt-1 break-all text-xs">{selected.id}</div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--muted)]">
                    Duration
                  </div>
                  <div className="mono mt-1 text-xs">{selected.durationMs}ms</div>
                </div>
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--muted)]">
                    TTFT
                  </div>
                  <div className="mono mt-1 text-xs">
                    {selected.ttftMs != null ? `${selected.ttftMs}ms` : "—"}
                  </div>
                </div>
              </div>
              <div>
                <div className="mb-1 text-xs font-semibold uppercase tracking-[0.06em] text-[var(--muted)]">
                  Attempts
                </div>
                <pre className="mono overflow-auto rounded-[10px] border border-[var(--border)] bg-[var(--bg)] p-3 text-xs leading-relaxed">
                  {JSON.stringify(selected.attempts, null, 2)}
                </pre>
              </div>
            </div>
          ) : (
            <EmptyState
              title="Select a request"
              body="Click a row to inspect classification, chosen model, and failover attempts."
            />
          )}
        </Panel>
      </div>
    </div>
  );
}
