import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="page-title text-[1.75rem] font-semibold leading-tight tracking-[-0.03em] sm:text-[2rem]">
          {title}
        </h1>
        {subtitle ? (
          <p className="mt-2 max-w-[62ch] text-[0.95rem] leading-relaxed text-[var(--muted)]">
            {subtitle}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function Panel({
  children,
  className = "",
  tone = "default",
}: {
  children: ReactNode;
  className?: string;
  tone?: "default" | "accent" | "warn";
}) {
  const toneClass =
    tone === "accent"
      ? "panel-accent"
      : tone === "warn"
        ? "panel-warn"
        : "";
  return <section className={`panel ${toneClass} ${className}`}>{children}</section>;
}

export function Stat({
  label,
  value,
  hint,
  progress,
  live,
}: {
  label: string;
  value: string | number;
  hint?: string;
  progress?: number;
  live?: boolean;
}) {
  const pct = progress != null ? Math.max(0, Math.min(100, progress)) : null;
  return (
    <div className="stat-card">
      <div className="flex items-center justify-between gap-2">
        <div className="stat-label">{label}</div>
        {live ? <span className="live-dot" title="Live" /> : null}
      </div>
      <div className="stat-value mono tabular-nums">{value}</div>
      {pct != null ? (
        <div className="stat-meter" aria-hidden>
          <div
            className="stat-meter-fill"
            style={{ transform: `scaleX(${Math.max(0.02, pct / 100)})` }}
          />
        </div>
      ) : null}
      {hint ? <div className="stat-hint">{hint}</div> : null}
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = "primary",
  disabled,
  type = "button",
  className = "",
  ...rest
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost" | "danger";
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const styles =
    variant === "primary"
      ? "btn-primary"
      : variant === "danger"
        ? "btn-danger"
        : "btn-ghost";

  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`btn ${styles} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="tablist">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="tab"
          aria-selected={value === opt.value}
          className={`segmented-item ${value === opt.value ? "is-active" : ""}`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  const tone =
    status === "healthy" || status === "success" || status === "done"
      ? "ok"
      : status === "degraded" || status === "active"
        ? "warn"
        : status === "checking" || status === "not_entitled"
          ? "info"
          : status === "down" || status === "error" || status === "failed"
            ? "danger"
            : "muted";
  return <span className={`status-pill tone-${tone}`}>{status.replaceAll("_", " ")}</span>;
}

export function formatContext(tokens: number) {
  if (!tokens) return "—";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`field ${props.className ?? ""}`} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`field mono ${props.className ?? ""}`} />;
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty-state">
      <div className="empty-title">{title}</div>
      <p className="empty-body">{body}</p>
    </div>
  );
}
