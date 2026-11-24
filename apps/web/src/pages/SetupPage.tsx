import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { Button, Input, PageHeader, Panel } from "../components/ui";

export default function SetupPage() {
  const [apiKey, setApiKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [snippets, setSnippets] = useState<any>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    void api
      .overview()
      .then((o) => setHasKey(Boolean(o.hasNimKey)))
      .catch((err) =>
        setError(
          err instanceof Error
            ? `Cannot reach Nemo-route API: ${err.message}`
            : "Cannot reach Nemo-route API",
        ),
      );
    void api.snippets().then(setSnippets).catch(() => undefined);
  }, []);

  async function save() {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setError("Paste a NIM API key first.");
      return;
    }
    setSaving(true);
    setMsg(null);
    setError(null);
    try {
      const res = await api.setNimKey(trimmed);
      setHasKey(true);
      setApiKey("");
      setMsg(
        res.warning
          ? `Key saved, but validation warned: ${res.warning}`
          : "NIM key saved and catalog synced.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function clear() {
    setClearing(true);
    setMsg(null);
    setError(null);
    try {
      await api.clearNimKey();
      setHasKey(false);
      setMsg("NIM key cleared.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setClearing(false);
    }
  }

  async function copySnippet(id: string, lines: string[]) {
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(id);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      setError("Could not copy to clipboard.");
    }
  }

  return (
    <div>
      <PageHeader
        title="Setup"
        subtitle="Connect your NVIDIA NIM key. Nemo-route encrypts it at rest and never exposes it to harness clients."
        actions={
          <Link to="/keys">
            <Button variant="ghost">Manage harness keys</Button>
          </Link>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
        <Panel tone={hasKey ? "accent" : "warn"}>
          <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold tracking-[-0.02em]">NIM credentials</h2>
              <p className="mt-1 text-sm text-[var(--muted)]">
                Used for upstream chat, embeddings, and catalog sync.
              </p>
            </div>
            <span className={`status-pill ${hasKey ? "tone-ok" : "tone-warn"}`}>
              {hasKey ? "configured" : "missing"}
            </span>
          </div>

          <div className="mb-4 rounded-[10px] border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm">
            Status:{" "}
            <span
              className={
                hasKey ? "font-semibold text-[var(--ok)]" : "font-semibold text-[var(--warn)]"
              }
            >
              {hasKey ? "NIM key configured" : "No NIM key yet"}
            </span>
          </div>

          <label className="mb-2 block text-sm font-medium">NVIDIA NIM API key</label>
          <Input
            type="password"
            placeholder="nvapi-..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && apiKey.trim() && !saving) void save();
            }}
          />

          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={() => void save()} disabled={!apiKey.trim() || saving}>
              {saving ? "Saving…" : "Save key"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => void clear()}
              disabled={!hasKey || clearing || saving}
            >
              {clearing ? "Clearing…" : "Clear"}
            </Button>
          </div>

          {msg ? <p className="mt-4 text-sm text-[var(--ok)]">{msg}</p> : null}
          {error ? <p className="mt-4 text-sm text-[var(--danger)]">{error}</p> : null}
        </Panel>

        <Panel>
          <h2 className="text-base font-semibold tracking-[-0.02em]">Quick path</h2>
          <ol className="mt-4 space-y-3 text-sm leading-relaxed text-[var(--muted)]">
            <li>
              <span className="font-semibold text-[var(--text)]">1.</span> Save your{" "}
              <span className="text-[var(--text)]">nvapi</span> key here.
            </li>
            <li>
              <span className="font-semibold text-[var(--text)]">2.</span> Create a{" "}
              <Link to="/keys" className="font-semibold">
                nemo-sk harness key
              </Link>
              .
            </li>
            <li>
              <span className="font-semibold text-[var(--text)]">3.</span> Point OpenCode / Claude Code
              at <span className="mono text-xs text-[var(--text)]">http://127.0.0.1:8788/v1</span>.
            </li>
          </ol>
          <div className="mt-5 rounded-[10px] border border-[var(--border)] bg-[var(--bg)] p-3 text-xs leading-relaxed text-[var(--muted)]">
            Gateway stays local. Harnesses never see your NVIDIA key — only the nemo-sk token.
          </div>
        </Panel>
      </div>

      <Panel className="mt-4">
        <div className="mb-4">
          <h2 className="text-base font-semibold tracking-[-0.02em]">Harness snippets</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Create a Nemo key on the Keys page, then paste these env vars into your client.
          </p>
        </div>

        {snippets ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <SnippetCard
              title="Claude Code"
              lines={snippets.claudeCode?.env ?? []}
              copied={copied === "claude"}
              onCopy={() => void copySnippet("claude", snippets.claudeCode?.env ?? [])}
            />
            <SnippetCard
              title="OpenAI-compatible"
              lines={snippets.openai?.env ?? []}
              copied={copied === "openai"}
              onCopy={() => void copySnippet("openai", snippets.openai?.env ?? [])}
            />
          </div>
        ) : (
          <p className="text-sm text-[var(--muted)]">Loading snippets…</p>
        )}
      </Panel>
    </div>
  );
}

function SnippetCard({
  title,
  lines,
  copied,
  onCopy,
}: {
  title: string;
  lines: string[];
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="rounded-[12px] border border-[var(--border)] bg-[var(--bg)] p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-sm font-semibold tracking-[-0.015em]">{title}</div>
        <Button variant="ghost" onClick={onCopy}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="mono max-h-48 overflow-auto text-xs leading-relaxed text-[var(--muted)]">
        {lines.join("\n")}
      </pre>
    </div>
  );
}
