import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api, subscribeAdminEvents } from "../lib/api";
import { Button, EmptyState, PageHeader, Panel, StatusPill } from "../components/ui";
import { Icons } from "../components/icons";

const MODEL_COLORS = [
  "var(--accent)",
  "var(--info)",
  "var(--warn)",
  "var(--danger)",
  "#c084fc",
  "#fb7185",
  "#34d399",
  "#60a5fa",
];

function getColor(index: number) {
  return MODEL_COLORS[index % MODEL_COLORS.length];
}

interface TokenSegment {
  modelId: string;
  label?: string;
  role: string;
  inputTokens: number;
  outputTokens: number;
  status: string;
  startedAt: number;
  endedAt: number | null;
  error?: string | null;
}

interface TokenFlowMapProps {
  segments: TokenSegment[];
  width: number;
  height: number;
}

export function TokenFlowMap({ segments, width, height }: TokenFlowMapProps) {
  if (!segments?.length) return null;

  // Build unique models in order of appearance
  const modelOrder: string[] = [];
  for (const seg of segments) {
    if (!modelOrder.includes(seg.modelId)) modelOrder.push(seg.modelId);
  }

  // Build flows between consecutive models
  const flows: { from: string; to: string; tokens: number }[] = [];
  const flowMap = new Map<string, { tokens: number }>();
  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1];
    const curr = segments[i];
    if (prev.modelId === curr.modelId) continue;
    const key = `${prev.modelId}->${curr.modelId}`;
    const existing = flowMap.get(key) ?? { tokens: 0 };
    existing.tokens += curr.inputTokens ?? 0;
    flowMap.set(key, existing);
  }
  flowMap.forEach((v, k) => {
    const [from, to] = k.split("->");
    flows.push({ from, to, tokens: v.tokens });
  });

  // Layout models in horizontal lanes
  const padding = 70;
  const centerY = height / 2;

  const modelX = new Map<string, number>();
  modelOrder.forEach((m, i) => {
    if (modelOrder.length === 1) {
      modelX.set(m, width / 2);
    } else if (i === 0) {
      modelX.set(m, padding);
    } else if (i === modelOrder.length - 1) {
      modelX.set(m, width - padding);
    } else {
      modelX.set(m, padding + (i / (modelOrder.length - 1)) * (width - padding * 2));
    }
  });

  const modelY = new Map<string, number>();
  if (modelOrder.length === 1) {
    modelY.set(modelOrder[0], centerY);
  } else {
    modelOrder.forEach((m, i) => {
      const offset = (i % 2 === 0 ? -1 : 1) * (height / 4);
      modelY.set(m, centerY + offset);
    });
  }

  return (
    <div className="flex flex-col items-center justify-center rounded-[12px] border border-[var(--border)] bg-[var(--bg)] p-4">
      <svg width={width} height={height} style={{ overflow: "visible" }}>
        {/* Defs for glow filters */}
        <defs>
          <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2" result="blur" />
            <feFlood flood-color="#000000" flood-opacity="0.4" />
            <feComposite in2="blur" operator="in" />
            <feOffset dx="1" dy="1" />
            <feMerge>
              <feMergeNode />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Draw flow arrows between models */}
        {flows.map((flow, i) => {
          const x1 = modelX.get(flow.from) ?? width / 2;
          const x2 = modelX.get(flow.to) ?? width / 2;
          const y1 = modelY.get(flow.from) ?? centerY;
          const y2 = modelY.get(flow.to) ?? centerY;

          const cp1x = x1 + (x2 - x1) * 0.35;
          const cp2x = x1 + (x2 - x1) * 0.65;
          const cp1y = y1;
          const cp2y = y2;

          const strokeWidth = Math.max(2, Math.min(6, Math.sqrt(flow.tokens / 8)));
          const color = getColor(i);

          return (
            <g key={`flow-${i}`}>
              {/* Glow shadow behind line */}
              <path
                d={`M ${x1} ${y1} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${x2} ${y2}`}
                stroke={color}
                strokeOpacity={0.3}
                strokeWidth={strokeWidth + 3}
                fill="none"
              />
              {/* Flow line with pulse animation and hover effect */}
              <path
                d={`M ${x1} ${y1} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${x2} ${y2}`}
                stroke={color}
                strokeWidth={strokeWidth}
                fill="none"
                strokeLinecap="round"
                markerEnd={`url(#arrowhead-${i})`}
                className="flow-line-pulse flow-line-hover"
              />
              <title>
                {`${flow.from.split("/").pop()} → ${flow.to.split("/").pop()}: ${flow.tokens} tokens`}
              </title>
              {/* Arrowhead definition */}
              <marker
                id={`arrowhead-${i}`}
                markerWidth="10"
                markerHeight="10"
                refX="9"
                refY="5"
                orient="auto"
                markerUnits="strokeWidth"
              >
                <path d="M 0 0 L 10 5 L 0 10 Z" fill={color} />
              </marker>
              {/* Token label on flow */}
              <text
                x={(x1 + x2) / 2}
                y={(y1 + y2) / 2 - 8}
                fontSize="10"
                fill="var(--muted)"
                textAnchor="middle"
                pointerEvents="none"
                filter="url(#shadow)"
              >
                {flow.tokens} tok
              </text>
            </g>
          );
        })}

        {/* Model nodes */}
        {modelOrder.map((modelId, i) => {
          const segs = segments.filter((s) => s.modelId === modelId);
          const totalIn = segs.reduce((a, s) => a + (s.inputTokens ?? 0), 0);
          const totalOut = segs.reduce((a, s) => a + (s.outputTokens ?? 0), 0);
          const x = modelX.get(modelId) ?? width / 2;
          const y = modelY.get(modelId) ?? height / 2;
          const color = getColor(i);

          const isFirst = i === 0;
          const isLast = i === modelOrder.length - 1;

          return (
            <g key={modelId} transform={`translate(${x}, ${y})`}>
              {/* Connection dots for non-endpoint models */}
              {!isFirst && (
                <line
                  x1={-42}
                  y1={0}
                  x2={-14}
                  y2={0}
                  stroke="var(--muted)"
                  strokeWidth="1.5"
                  strokeDasharray="4"
                />
              )}
              {!isLast && (
                <line
                  x1={42}
                  y1={0}
                  x2={14}
                  y2={0}
                  stroke="var(--muted)"
                  strokeWidth="1.5"
                  strokeDasharray="4"
                />
              )}

              {/* Node outer ring */}
              <circle
                r={22}
                fill="var(--bg)"
                stroke={color}
                strokeWidth="3"
                filter="url(#shadow)"
                className="node-hover"
              />
              <title>
                {`${modelId}: ${totalIn} in → ${totalOut} out`}
              </title>

              {/* Node fill */}
              <circle
                r={16}
                fill={color}
                filter="url(#glow)"
              />

              {/* Node center dot */}
              <circle r={4} fill="var(--bg)" />

              {/* Model short name */}
              <text
                x={0}
                y={30}
                fontSize="11"
                fontFamily="var(--font-mono)"
                fontWeight="600"
                fill="var(--text)"
                textAnchor="middle"
                pointerEvents="none"
                filter="url(#shadow)"
              >
                {modelId.split("/").pop() ?? modelId}
              </text>

              {/* Token stats */}
              <text
                x={0}
                y={46}
                fontSize="9"
                fill="var(--muted)"
                textAnchor="middle"
                pointerEvents="none"
                filter="url(#shadow)"
              >
                {totalIn}→{totalOut}
              </text>
            </g>
          );
        })}
      </svg>

      <div className="mt-4 flex flex-wrap justify-center gap-4 text-xs text-[var(--muted)]">
        {modelOrder.map((m, i) => (
          <span key={m} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: getColor(i) }} />
            {m.split("/").pop() ?? m}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function TokenRoutingPage() {
  const [data, setData] = useState<any>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const res = await api.tokenRouting();
      setData(res);
      setError(null);
      if (!selectedId) {
        const first =
          res.active?.[0]?.requestId ??
          res.recentRequests?.[0]?.requestId ??
          null;
        setSelectedId(first);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 2000);
    const events = new AbortController();
    void subscribeAdminEvents(() => void load(), events.signal);
    return () => {
      clearInterval(t);
      events.abort();
    };
  }, []);

  const sessions = useMemo(() => {
    if (!data) return [];
    const active = (data.active ?? []).map((s: any) => ({
      ...s,
      live: true,
    }));
    const recent = (data.recentRequests ?? []).map((s: any) => ({
      ...s,
      live: false,
    }));
    const seen = new Set<string>();
    const out: any[] = [];
    for (const s of [...active, ...recent]) {
      if (seen.has(s.requestId)) continue;
      seen.add(s.requestId);
      out.push(s);
    }
    return out;
  }, [data]);

  const selected =
    sessions.find((s) => s.requestId === selectedId) ?? sessions[0] ?? null;

  const byModel = useMemo(() => {
    if (!selected?.segments?.length) return [];
    const map = new Map<
      string,
      { model: string; input: number; output: number; total: number }
    >();
    for (const seg of selected.segments) {
      const cur = map.get(seg.modelId) ?? { model: seg.modelId, input: 0, output: 0, total: 0 };
      cur.input += seg.inputTokens || 0;
      cur.output += seg.outputTokens || 0;
      cur.total = cur.input + cur.output;
      map.set(seg.modelId, cur);
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }, [selected]);

  const pieData = byModel.map((m) => ({
    name: m.model.split("/").pop(),
    value: Math.max(1, m.total),
    full: m.model,
  }));

  const timelineStart = selected?.startedAt ?? Date.now();
  const timelineEnd = selected?.endedAt ?? Math.max(Date.now(), ...(selected?.segments ?? []).map((s: any) => s.endedAt ?? s.startedAt ?? Date.now()));
  const span = Math.max(1, timelineEnd - timelineStart);

  return (
    <div>
      <PageHeader
        title="Token routing"
        subtitle="Live topology map showing how tokens flow between models — primary route, retries, failovers, and continuations."
        actions={
          <Button onClick={() => void load()}>
            <Icons.refresh size={15} />
            Refresh
          </Button>
        }
      />
      {error ? (
        <Panel tone="warn" className="mb-4 text-sm">
          {error}
        </Panel>
      ) : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[300px_1fr]">
        {/* Session list */}
        <Panel className="max-h-[78vh] overflow-auto p-0">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
            <div className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--muted)]">
              Sessions
            </div>
            <span className="live-dot" />
          </div>
          {sessions.length === 0 ? (
            <EmptyState
              title="No routed requests yet"
              body="Send a prompt through OpenCode or any harness to see live token topology."
            />
          ) : (
            sessions.map((s) => (
              <button
                key={s.requestId}
                onClick={() => setSelectedId(s.requestId)}
                className={`w-full border-b border-[var(--border)]/60 px-4 py-3 text-left transition hover:bg-[var(--bg-panel)] ${selected?.requestId === s.requestId ? "bg-[var(--accent-soft)]" : ""}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="mono truncate text-xs">{s.requestedModel}</span>
                  {s.live || s.status === "active" ? (
                    <StatusPill status="active" />
                  ) : (
                    <StatusPill status={s.status === "error" ? "failed" : "done"} />
                  )}
                </div>
                <div className="mt-1 text-xs text-[var(--muted)]">
                  {s.taskType}/{s.complexity} ·{" "}
                  {new Date(s.startedAt).toLocaleTimeString()}
                </div>
                <div className="mono mt-0.5 truncate text-[11px] text-[var(--muted)]">
                  {s.chosenModel ?? "routing…"}
                </div>
              </button>
            ))
          )}
        </Panel>

        {/* Right column: topology map + detail + charts */}
        <div className="grid gap-4 min-w-0">
          {!selected ? (
            <Panel>
              <EmptyState
                title="Select a session"
                body="Pick a live or recent request to inspect token flow, failovers, and model share."
              />
            </Panel>
          ) : (
            <>
              {/* Session info bar */}
              <Panel tone="accent">
                <div className="mb-1 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--muted)]">
                      Active prompt route
                    </div>
                    <div className="mono mt-1 text-sm">{selected.requestId}</div>
                    <div className="mt-2 text-sm">
                      Requested <span className="mono">{selected.requestedModel}</span>
                      {selected.chosenModel ? (
                        <>
                          {" "}
                          → chose <span className="mono text-[var(--ok)]">{selected.chosenModel}</span>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <div className="text-right text-xs text-[var(--muted)]">
                    <div>
                      {selected.segments?.length ?? 0} model segment
                      {(selected.segments?.length ?? 0) === 1 ? "" : "s"}
                    </div>
                    <div>
                      {byModel.reduce((a, m) => a + m.input, 0)} in /{" "}
                      {byModel.reduce((a, m) => a + m.output, 0)} out tokens
                    </div>
                  </div>
                </div>
              </Panel>

              {/* Topology Map */}
              <Panel>
                <div className="mb-3">
                  <h2 className="text-base font-semibold tracking-[-0.02em]">
                    Token flow topology
                  </h2>
                  <p className="mt-1 text-sm text-[var(--muted)]">
                    Lines = token handoffs · circles = models
                  </p>
                </div>
                <TokenFlowMap
                  segments={selected.segments ?? []}
                  width={700}
                  height={300}
                />
              </Panel>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Panel>
                  <h2 className="mb-3 text-base font-semibold tracking-[-0.02em]">
                    Tokens by model
                  </h2>
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={byModel}>
                        <CartesianGrid stroke={`var(--muted)`} vertical={false} />
                        <XAxis
                          dataKey="model"
                          stroke={`var(--muted)`}
                          fontSize={10}
                          tickFormatter={(v) => String(v).split("/").pop() ?? v}
                        />
                        <YAxis stroke={`var(--muted)`} fontSize={11} />
                        <Tooltip
                          contentStyle={{
                            background: "var(--bg-elevated)",
                            border: "1px solid var(--border)",
                            borderRadius: 10,
                          }}
                        />
                        <Bar dataKey="input" stackId="t" fill="var(--info)" name="Input" />
                        <Bar
                          dataKey="output"
                          stackId="t"
                          fill="var(--accent)"
                          name="Output"
                          radius={[6, 6, 0, 0]}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </Panel>
                <Panel>
                  <h2 className="mb-3 text-base font-semibold tracking-[-0.02em]">
                    Share of work
                  </h2>
                  <div className="flex h-52 items-center justify-center">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={pieData}
                          dataKey="value"
                          nameKey="name"
                          innerRadius={45}
                          outerRadius={80}
                          paddingAngle={2}
                        >
                          {pieData.map((_, i) => (
                            <Cell key={i} fill={MODEL_COLORS[i % MODEL_COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip
                          contentStyle={{
                            background: "var(--bg-elevated)",
                            border: "1px solid var(--border)",
                            borderRadius: 10,
                          }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="space-y-1 mt-2">
                    {byModel.map((m, i) => (
                      <div key={m.model} className="flex justify-between text-xs mono">
                        <span>
                          <span
                            className="inline-block w-2 h-2 rounded-full mr-2"
                            style={{ background: MODEL_COLORS[i % MODEL_COLORS.length] }}
                          />
                          {m.model}
                        </span>
                        <span className="text-[var(--muted)]">{m.input}+{m.output}</span>
                      </div>
                    ))}
                  </div>
                </Panel>
              </div>

              {/* Model detail */}
              <Panel>
                <h2 className="mb-3 text-base font-semibold tracking-[-0.02em]">
                  Model detail for this prompt
                </h2>
                <div className="space-y-3">
                  {byModel.map((m, i) => {
                    const segs = (selected.segments ?? []).filter((s: any) => s.modelId === m.model);
                    return (
                      <div
                        key={m.model}
                        className="rounded-[12px] border border-[var(--border)] bg-[var(--bg)] p-3"
                      >
                        <div className="mb-2 flex items-center gap-2">
                          <span
                            className="h-2.5 w-2.5 rounded-full"
                            style={{ background: MODEL_COLORS[i % MODEL_COLORS.length] }}
                          />
                          <span className="mono text-sm font-medium">{m.model}</span>
                        </div>
                        <div className="mb-2 grid grid-cols-2 gap-2 text-xs text-[var(--muted)] sm:grid-cols-4">
                          <div>
                            Input: <span className="text-[var(--text)]">{m.input}</span>
                          </div>
                          <div>
                            Output: <span className="text-[var(--text)]">{m.output}</span>
                          </div>
                          <div>
                            Segments: <span className="text-[var(--text)]">{segs.length}</span>
                          </div>
                          <div>
                            Roles:{" "}
                            <span className="text-[var(--text)]">
                              {[...new Set(segs.map((s: any) => s.role))].join(", ")}
                            </span>
                          </div>
                        </div>
                        <ul className="text-xs space-y-1">
                          {segs.map((s: any, idx: number) => (
                            <li key={idx} className="mono">
                              {s.role} · {s.status} · {s.inputTokens}/{s.outputTokens} tok
                              {s.error ? ` · ${s.error}` : ""}
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              </Panel>
            </>
          )}
        </div>
      </div>
    </div>
  );
}