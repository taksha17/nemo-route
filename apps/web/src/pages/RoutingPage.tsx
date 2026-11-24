import { useEffect, useState } from "react";
import { api } from "../lib/api";
import {
  Button,
  Input,
  PageHeader,
  Panel,
  SegmentedControl,
  TextArea,
} from "../components/ui";

type PrefKey = "chat" | "code" | "reasoning" | "vision";

export default function RoutingPage() {
  const [settings, setSettings] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [prefTab, setPrefTab] = useState<PrefKey>("chat");
  const [prefsText, setPrefsText] = useState("");
  const [prefsError, setPrefsError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .settings()
      .then((s) => {
        setSettings(s);
        setPrefsText(JSON.stringify(s.taskPreferences ?? {}, null, 2));
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  if (!settings && !error) {
    return <div className="text-sm text-[var(--muted)]">Loading routing settings…</div>;
  }

  if (!settings) {
    return (
      <Panel tone="warn" className="text-sm">
        {error ?? "Failed to load settings."}
      </Panel>
    );
  }

  async function save() {
    setSaving(true);
    setMsg(null);
    setError(null);
    try {
      let taskPreferences = settings.taskPreferences;
      try {
        taskPreferences = JSON.parse(prefsText);
        setPrefsError(null);
      } catch {
        setPrefsError("Task preferences JSON is invalid — fix it before saving.");
        setSaving(false);
        return;
      }
      const next = { ...settings, taskPreferences };
      await api.saveSettings(next);
      setSettings(next);
      setMsg("Routing settings saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const prefList: string[] = settings.taskPreferences?.[prefTab] ?? [];

  return (
    <div>
      <PageHeader
        title="Routing"
        subtitle="Timeouts, probe budget, partial-stream behavior, and soft model preferences by task type."
        actions={
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        }
      />

      {msg ? (
        <Panel tone="accent" className="mb-4 text-sm">
          {msg}
        </Panel>
      ) : null}
      {error ? (
        <Panel tone="warn" className="mb-4 text-sm">
          {error}
        </Panel>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel>
          <h2 className="mb-1 text-base font-semibold tracking-[-0.02em]">Limits</h2>
          <p className="mb-4 text-sm text-[var(--muted)]">
            Cap live traffic and reserve probe budget for health checks.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field
              label="RPM limit"
              value={settings.rpmLimit}
              onChange={(v) => setSettings({ ...settings, rpmLimit: Number(v) })}
            />
            <Field
              label="Daily request limit"
              value={settings.dailyRequestLimit}
              onChange={(v) => setSettings({ ...settings, dailyRequestLimit: Number(v) })}
            />
            <Field
              label="Probe RPM budget"
              value={settings.probeRpmBudget}
              onChange={(v) => setSettings({ ...settings, probeRpmBudget: Number(v) })}
            />
          </div>
        </Panel>

        <Panel>
          <h2 className="mb-1 text-base font-semibold tracking-[-0.02em]">Stream behavior</h2>
          <p className="mb-4 text-sm text-[var(--muted)]">
            What happens when a model stalls mid-response.
          </p>
          <label className="mb-2 block text-sm font-medium">Partial stream</label>
          <select
            className="field"
            value={settings.partialStreamBehavior}
            onChange={(e) =>
              setSettings({
                ...settings,
                partialStreamBehavior: e.target.value,
              })
            }
          >
            <option value="continue">Continue on next model</option>
            <option value="error">End stream with error</option>
          </select>
          <p className="mt-3 text-xs leading-relaxed text-[var(--muted)]">
            Continue handoff keeps the partial draft and original conversation context for the next
            best-fit model.
          </p>
        </Panel>
      </div>

      <Panel className="mt-4">
        <h2 className="mb-1 text-base font-semibold tracking-[-0.02em]">Timeouts</h2>
        <p className="mb-4 text-sm text-[var(--muted)]">
          Values in milliseconds. Idle covers gaps between streamed chunks.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Field
            label="Light TTFT"
            value={settings.timeouts.lightTtftMs}
            onChange={(v) =>
              setSettings({
                ...settings,
                timeouts: { ...settings.timeouts, lightTtftMs: Number(v) },
              })
            }
          />
          <Field
            label="Medium TTFT"
            value={settings.timeouts.mediumTtftMs}
            onChange={(v) =>
              setSettings({
                ...settings,
                timeouts: { ...settings.timeouts, mediumTtftMs: Number(v) },
              })
            }
          />
          <Field
            label="Heavy TTFT"
            value={settings.timeouts.heavyTtftMs}
            onChange={(v) =>
              setSettings({
                ...settings,
                timeouts: { ...settings.timeouts, heavyTtftMs: Number(v) },
              })
            }
          />
          <Field
            label="Idle between chunks"
            value={settings.timeouts.idleMs}
            onChange={(v) =>
              setSettings({
                ...settings,
                timeouts: { ...settings.timeouts, idleMs: Number(v) },
              })
            }
          />
        </div>
      </Panel>

      <div className="mt-4 grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
        <Panel>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold tracking-[-0.02em]">Preference preview</h2>
              <p className="mt-1 text-sm text-[var(--muted)]">
                Soft ranking hints — never the only signal.
              </p>
            </div>
            <SegmentedControl
              value={prefTab}
              onChange={setPrefTab}
              options={[
                { value: "chat", label: "Chat" },
                { value: "code", label: "Code" },
                { value: "reasoning", label: "Reason" },
                { value: "vision", label: "Vision" },
              ]}
            />
          </div>
          {prefList.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">No models listed for {prefTab}.</p>
          ) : (
            <ol className="space-y-2">
              {prefList.map((id, i) => (
                <li
                  key={`${prefTab}-${id}-${i}`}
                  className="flex items-center gap-3 rounded-[10px] border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
                >
                  <span className="mono text-xs text-[var(--muted)]">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="mono truncate text-xs">{id}</span>
                </li>
              ))}
            </ol>
          )}
        </Panel>

        <Panel>
          <h2 className="mb-1 text-base font-semibold tracking-[-0.02em]">Task preferences JSON</h2>
          <p className="mb-3 text-sm text-[var(--muted)]">
            Edit the ordered model lists directly. Invalid JSON blocks save.
          </p>
          <TextArea
            rows={16}
            value={prefsText}
            onChange={(e) => {
              setPrefsText(e.target.value);
              try {
                const parsed = JSON.parse(e.target.value);
                setSettings({ ...settings, taskPreferences: parsed });
                setPrefsError(null);
              } catch {
                setPrefsError("JSON incomplete or invalid…");
              }
            }}
          />
          {prefsError ? (
            <p className="mt-2 text-xs text-[var(--warn)]">{prefsError}</p>
          ) : (
            <p className="mt-2 text-xs text-[var(--muted)]">Valid JSON</p>
          )}
        </Panel>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="mb-2 block text-sm font-medium">{label}</label>
      <Input value={String(value)} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
