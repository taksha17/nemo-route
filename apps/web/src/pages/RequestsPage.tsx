import { useEffect, useMemo, useState } from "react";
import { api, getAdminToken } from "../lib/api";
import { Button, EmptyState, Input, PageHeader, Panel, StatusPill } from "../components/ui";
import { Icons } from "../components/icons";

const PAGE = 50;

export default function RequestsPage() {
  const [requests, setRequests] = useState<any[]>([]);
  const [selected, setSelected] = useState<any | null>(null);
  const [model, setModel] = useState("");
  const [taskType, setTaskType] = useState("");
  const [outcome, setOutcome] = useState("");
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);

  async function load(nextOffset = offset) {
    const res = await api.requests(PAGE, {
      offset: nextOffset,
      model: model.trim() || undefined,
      taskType: taskType.trim() || undefined,
      outcome: outcome.trim() || undefined,
      q: q.trim() || undefined,
    });
    setRequests(res.requests);
    setOffset(res.offset ?? nextOffset);
  }

  useEffect(() => {
    void load(0);
    const t = setInterval(() => void load(offset), 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, taskType, outcome, q]);

  const taskOptions = useMemo(
    () => ["", "chat", "code", "reasoning", "vision", "summarize", "rewrite", "extract", "other"],
    [],
  );
  const outcomeOptions = useMemo(
    () => ["", "success", "failover_success", "error", "cancelled"],
    [],
  );

  return (
    <div>
      <PageHeader
        title="Requests"
        subtitle="Live request log with routing traces: classification, chosen model, and failover attempts."
        actions={
          <Button onClick={() => void load(offset)}>
            <Icons.refresh size={15} />
            Refresh
          </Button>
        }
      />

      <Panel className="mb-4 grid grid-cols-1 gap-3 p-4 md:grid-cols-4">
        <Input
          placeholder="Search id / model / task"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Input
          placeholder="Filter model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
        <select
          className="rounded-[10px] border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
          value={taskType}
          onChange={(e) => setTaskType(e.target.value)}
        >
          {taskOptions.map((t) => (
            <option key={t || "any"} value={t}>
              {t ? `Task: ${t}` : "All tasks"}
            </option>
          ))}
        </select>
        <select
          className="rounded-[10px] border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
        >
          {outcomeOptions.map((o) => (
            <option key={o || "any"} value={o}>
              {o ? `Outcome: ${o}` : "All outcomes"}
            </option>
          ))}
        </select>
      </Panel>

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
          <div className="flex items-center justify-between border-t border-[var(--border)] px-3 py-2">
            <Button
              variant="ghost"
              disabled={offset <= 0}
              onClick={() => {
                const next = Math.max(0, offset - PAGE);
                setOffset(next);
                void load(next);
              }}
            >
              Prev
            </Button>
            <span className="text-xs text-[var(--muted)]">offset {offset}</span>
            <Button
              variant="ghost"
              disabled={requests.length < PAGE}
              onClick={() => {
                const next = offset + PAGE;
                setOffset(next);
                void load(next);
              }}
            >
              Next
            </Button>
          </div>
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
              {selected.segments?.length ? (
                <div>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-[0.06em] text-[var(--muted)]">
                    Segments
                  </div>
                  <pre className="mono overflow-auto rounded-[10px] border border-[var(--border)] bg-[var(--bg)] p-3 text-xs leading-relaxed">
                    {JSON.stringify(selected.segments, null, 2)}
                  </pre>
                </div>
              ) : null}
              {!getAdminToken() ? null : null}
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
