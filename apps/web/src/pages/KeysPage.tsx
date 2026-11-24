import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import {
  Button,
  EmptyState,
  Input,
  PageHeader,
  Panel,
  Stat,
} from "../components/ui";
import { Icons } from "../components/icons";

export default function KeysPage() {
  const [keys, setKeys] = useState<any[]>([]);
  const [label, setLabel] = useState("default");
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);

  async function load() {
    try {
      setKeys((await api.keys()).keys);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const stats = useMemo(() => {
    const active = keys.filter((k) => !k.revokedAt).length;
    const revoked = keys.length - active;
    return { total: keys.length, active, revoked };
  }, [keys]);

  async function create() {
    setCreating(true);
    setError(null);
    try {
      const res = await api.createKey(label.trim() || "default");
      setRawKey(res.rawKey);
      setCopied(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function copyRaw() {
    if (!rawKey) return;
    try {
      await navigator.clipboard.writeText(rawKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("Could not copy key to clipboard.");
    }
  }

  return (
    <div>
      <PageHeader
        title="API keys"
        subtitle="Issue nemo-sk keys for Claude Code, OpenCode, and other harnesses. The raw secret is shown once."
        actions={
          <Button variant="ghost" onClick={() => void load()}>
            <Icons.refresh size={15} />
            Refresh
          </Button>
        }
      />

      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Total keys" value={stats.total} />
        <Stat label="Active" value={stats.active} live={stats.active > 0} />
        <Stat label="Revoked" value={stats.revoked} />
      </div>

      {error ? (
        <Panel tone="warn" className="mb-4 text-sm">
          {error}
        </Panel>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
        <Panel tone="accent">
          <h2 className="text-base font-semibold tracking-[-0.02em]">Create key</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Label helps you tell clients apart later.
          </p>
          <div className="mt-4">
            <label className="mb-2 block text-sm font-medium">Label</label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !creating) void create();
              }}
              placeholder="opencode / claude / ci"
            />
          </div>
          <div className="mt-4">
            <Button onClick={() => void create()} disabled={creating}>
              {creating ? "Creating…" : "Create key"}
            </Button>
          </div>

          {rawKey ? (
            <div
              className="mt-5 rounded-[12px] border bg-[var(--bg)] p-3"
              style={{
                borderColor: "color-mix(in srgb, var(--accent) 40%, var(--border))",
              }}
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--muted)]">
                  Copy now — shown once
                </div>
                <Button variant="ghost" onClick={() => void copyRaw()}>
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <code className="mono break-all text-sm leading-relaxed">{rawKey}</code>
            </div>
          ) : null}
        </Panel>

        <Panel className="overflow-auto p-0">
          {keys.length === 0 ? (
            <EmptyState
              title="No harness keys yet"
              body="Create a nemo-sk key to authenticate Claude Code, OpenCode, or any OpenAI-compatible client."
            />
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Prefix</th>
                  <th>Created</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id}>
                    <td className="font-semibold tracking-[-0.015em]">{k.label}</td>
                    <td className="mono text-xs text-[var(--muted)]">{k.prefix}…</td>
                    <td className="text-xs text-[var(--muted)]">
                      {new Date(k.createdAt).toLocaleString()}
                    </td>
                    <td>
                      <span
                        className={`status-pill ${k.revokedAt ? "tone-danger" : "tone-ok"}`}
                      >
                        {k.revokedAt ? "revoked" : "active"}
                      </span>
                    </td>
                    <td className="text-right">
                      {!k.revokedAt ? (
                        <Button
                          variant="danger"
                          onClick={() => void api.revokeKey(k.id).then(load)}
                        >
                          Revoke
                        </Button>
                      ) : (
                        <span className="text-xs text-[var(--muted)]">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  );
}
