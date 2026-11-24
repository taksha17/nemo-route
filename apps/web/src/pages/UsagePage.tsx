import { useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../lib/api";
import {
  Button,
  EmptyState,
  PageHeader,
  Panel,
  SegmentedControl,
  Stat,
} from "../components/ui";
import { Icons } from "../components/icons";

type RangeDays = "7" | "14" | "30";

function shortDay(day: string) {
  const d = new Date(`${day}T00:00:00`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function shortModel(id: string) {
  const part = id.split("/").pop() ?? id;
  return part.length > 28 ? `${part.slice(0, 26)}…` : part;
}

function formatCount(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; color?: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div
      className="rounded-[10px] border px-3 py-2 text-xs shadow-lg"
      style={{
        background: "var(--bg-elevated)",
        borderColor: "var(--border)",
        color: "var(--text)",
      }}
    >
      <div className="mb-1.5 font-semibold tracking-[-0.02em]">{label}</div>
      <div className="space-y-1">
        {payload.map((p) => (
          <div key={p.name} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-[var(--muted)]">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: p.color }}
              />
              {p.name}
            </span>
            <span className="mono tabular-nums">{formatCount(p.value ?? 0)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function UsagePage() {
  const [usage, setUsage] = useState<any[]>([]);
  const [range, setRange] = useState<RangeDays>("14");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load(days = Number(range)) {
    setLoading(true);
    setError(null);
    try {
      const res = await api.usage(days);
      setUsage(res.usage ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(Number(range));
  }, [range]);

  const byDay = useMemo(() => {
    const map = new Map<
      string,
      { day: string; label: string; requests: number; tokens: number; failovers: number }
    >();
    for (const row of usage) {
      const cur = map.get(row.day) ?? {
        day: row.day,
        label: shortDay(row.day),
        requests: 0,
        tokens: 0,
        failovers: 0,
      };
      cur.requests += row.requests ?? 0;
      cur.tokens += (row.inputTokens ?? 0) + (row.outputTokens ?? 0);
      cur.failovers += row.failovers ?? 0;
      map.set(row.day, cur);
    }
    return [...map.values()].sort((a, b) => a.day.localeCompare(b.day));
  }, [usage]);

  const byModel = useMemo(() => {
    const map = new Map<
      string,
      { model: string; label: string; requests: number; tokens: number; failovers: number }
    >();
    for (const row of usage) {
      const key = row.modelId || "unknown";
      const cur = map.get(key) ?? {
        model: key,
        label: shortModel(key),
        requests: 0,
        tokens: 0,
        failovers: 0,
      };
      cur.requests += row.requests ?? 0;
      cur.tokens += (row.inputTokens ?? 0) + (row.outputTokens ?? 0);
      cur.failovers += row.failovers ?? 0;
      map.set(key, cur);
    }
    return [...map.values()].sort((a, b) => b.requests - a.requests).slice(0, 10);
  }, [usage]);

  const totals = useMemo(() => {
    let requests = 0;
    let tokens = 0;
    let failovers = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    for (const row of usage) {
      requests += row.requests ?? 0;
      inputTokens += row.inputTokens ?? 0;
      outputTokens += row.outputTokens ?? 0;
      tokens += (row.inputTokens ?? 0) + (row.outputTokens ?? 0);
      failovers += row.failovers ?? 0;
    }
    const peak = byDay.reduce((m, d) => Math.max(m, d.requests), 0);
    return { requests, tokens, failovers, inputTokens, outputTokens, peak, models: byModel.length };
  }, [usage, byDay, byModel]);

  const maxModelRequests = byModel[0]?.requests ?? 1;

  return (
    <div>
      <PageHeader
        title="Usage"
        subtitle="Requests, tokens, and failovers across the selected window — by day and by model."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl
              value={range}
              onChange={setRange}
              options={[
                { value: "7", label: "7d" },
                { value: "14", label: "14d" },
                { value: "30", label: "30d" },
              ]}
            />
            <Button onClick={() => void load()} disabled={loading}>
              <Icons.refresh size={15} />
              Refresh
            </Button>
          </div>
        }
      />

      {error ? (
        <Panel tone="warn" className="mb-5 text-sm">
          {error}
        </Panel>
      ) : null}

      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          live={!loading}
          label="Requests"
          value={formatCount(totals.requests)}
          hint={`Peak day ${formatCount(totals.peak)}`}
        />
        <Stat
          label="Tokens"
          value={formatCount(totals.tokens)}
          hint={`${formatCount(totals.inputTokens)} in · ${formatCount(totals.outputTokens)} out`}
        />
        <Stat
          label="Failovers"
          value={formatCount(totals.failovers)}
          hint={
            totals.requests
              ? `${((totals.failovers / totals.requests) * 100).toFixed(1)}% of requests`
              : "no traffic yet"
          }
          progress={
            totals.requests ? Math.min(100, (totals.failovers / totals.requests) * 100) : 0
          }
        />
        <Stat
          label="Models used"
          value={totals.models}
          hint={`Top window · last ${range} days`}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.35fr_1fr]">
        <Panel>
          <div className="mb-4 flex items-end justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold tracking-[-0.02em]">Traffic by day</h2>
              <p className="mt-1 text-sm text-[var(--muted)]">
                Requests and failovers over the selected range.
              </p>
            </div>
          </div>
          {byDay.length === 0 ? (
            <EmptyState
              title="No usage yet"
              body="Once harness traffic flows through the router, daily request volume will show up here."
            />
          ) : (
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={byDay} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="usageRequests" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="usageFailovers" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--warn)" stopOpacity={0.28} />
                      <stop offset="100%" stopColor="var(--warn)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid
                    stroke="color-mix(in srgb, var(--border) 80%, transparent)"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="label"
                    stroke="var(--muted)"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    dy={6}
                  />
                  <YAxis
                    stroke="var(--muted)"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    width={36}
                    tickFormatter={formatCount}
                  />
                  <Tooltip content={<ChartTooltip />} />
                  <Area
                    type="monotone"
                    dataKey="requests"
                    name="Requests"
                    stroke="var(--accent)"
                    fill="url(#usageRequests)"
                    strokeWidth={2.25}
                    activeDot={{ r: 4, strokeWidth: 0 }}
                  />
                  <Area
                    type="monotone"
                    dataKey="failovers"
                    name="Failovers"
                    stroke="var(--warn)"
                    fill="url(#usageFailovers)"
                    strokeWidth={1.75}
                    activeDot={{ r: 3.5, strokeWidth: 0 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>

        <Panel>
          <div className="mb-4">
            <h2 className="text-base font-semibold tracking-[-0.02em]">Token volume</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Combined input + output tokens per day.
            </p>
          </div>
          {byDay.length === 0 ? (
            <EmptyState
              title="No token data"
              body="Token totals appear after successful completions are recorded."
            />
          ) : (
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={byDay} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid
                    stroke="color-mix(in srgb, var(--border) 80%, transparent)"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="label"
                    stroke="var(--muted)"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    dy={6}
                  />
                  <YAxis
                    stroke="var(--muted)"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    width={42}
                    tickFormatter={formatCount}
                  />
                  <Tooltip content={<ChartTooltip />} />
                  <Bar
                    dataKey="tokens"
                    name="Tokens"
                    fill="var(--info)"
                    radius={[6, 6, 0, 0]}
                    maxBarSize={28}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>
      </div>

      <Panel className="mt-4">
        <div className="mb-4 flex items-end justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold tracking-[-0.02em]">Top models</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Ranked by request count in the current window.
            </p>
          </div>
        </div>

        {byModel.length === 0 ? (
          <EmptyState
            title="No model traffic"
            body="Models show up here once requests are routed and logged."
          />
        ) : (
          <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr]">
            <div className="space-y-3">
              {byModel.map((m, i) => {
                const pct = Math.max(4, (m.requests / maxModelRequests) * 100);
                return (
                  <div key={m.model} className="group">
                    <div className="mb-1.5 flex items-baseline justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium tracking-[-0.015em]">
                          <span className="mr-2 mono text-xs text-[var(--muted)]">
                            {String(i + 1).padStart(2, "0")}
                          </span>
                          {m.label}
                        </div>
                        <div className="mono truncate pl-7 text-[11px] text-[var(--muted)]">
                          {m.model}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="mono text-sm tabular-nums">
                          {formatCount(m.requests)}
                        </div>
                        <div className="text-[11px] text-[var(--muted)]">
                          {formatCount(m.tokens)} tok
                          {m.failovers ? ` · ${m.failovers} fo` : ""}
                        </div>
                      </div>
                    </div>
                    <div
                      className="h-1.5 overflow-hidden rounded-full"
                      style={{
                        background: "color-mix(in srgb, var(--border) 70%, transparent)",
                      }}
                    >
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: "100%",
                          transformOrigin: "left center",
                          transform: `scaleX(${pct / 100})`,
                          transition: "transform 500ms cubic-bezier(0.22, 1, 0.36, 1)",
                          background:
                            i === 0
                              ? "linear-gradient(90deg, var(--accent-dim), var(--accent))"
                              : "linear-gradient(90deg, color-mix(in srgb, var(--info) 70%, var(--accent)), var(--info))",
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="min-h-[280px] h-[360px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={byModel}
                  layout="vertical"
                  margin={{ top: 4, right: 12, left: 4, bottom: 4 }}
                >
                  <CartesianGrid
                    stroke="color-mix(in srgb, var(--border) 80%, transparent)"
                    horizontal={false}
                  />
                  <XAxis
                    type="number"
                    stroke="var(--muted)"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={formatCount}
                  />
                  <YAxis
                    type="category"
                    dataKey="label"
                    stroke="var(--muted)"
                    fontSize={11}
                    width={118}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip content={<ChartTooltip />} />
                  <Bar
                    dataKey="requests"
                    name="Requests"
                    fill="var(--accent)"
                    radius={[0, 6, 6, 0]}
                    maxBarSize={18}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}
