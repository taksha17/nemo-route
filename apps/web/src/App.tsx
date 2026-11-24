import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { useEffect, useState, type ComponentType, type FormEvent } from "react";
import { clearAdminToken, getAdminToken, setAdminToken } from "./lib/api";
import OverviewPage from "./pages/OverviewPage";
import SetupPage from "./pages/SetupPage";
import ModelsPage from "./pages/ModelsPage";
import KeysPage from "./pages/KeysPage";
import RequestsPage from "./pages/RequestsPage";
import UsagePage from "./pages/UsagePage";
import RoutingPage from "./pages/RoutingPage";
import TokenRoutingPage from "./pages/TokenRoutingPage";
import { Button } from "./components/ui";
import { Icons } from "./components/icons";

type NavLinkItem = {
  to: string;
  label: string;
  icon: ComponentType<{ size?: number }>;
};

const allLinks: NavLinkItem[] = [
  { to: "/", label: "Overview", icon: Icons.overview },
  { to: "/setup", label: "Setup", icon: Icons.setup },
  { to: "/models", label: "Models", icon: Icons.models },
  { to: "/keys", label: "Keys", icon: Icons.keys },
  { to: "/requests", label: "Requests", icon: Icons.requests },
  { to: "/usage", label: "Usage", icon: Icons.usage },
  { to: "/routing", label: "Routing", icon: Icons.routing },
  { to: "/token-routing", label: "Token routing", icon: Icons.token },
];

function AdminGate({ onUnlock }: { onUnlock: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const next = token.trim();
    if (!next) {
      setError("Enter the admin token from your .env file.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/admin/overview", {
        headers: { "x-nemo-admin-token": next },
      });
      if (!res.ok) {
        setError("That admin token was rejected.");
        return;
      }
      setAdminToken(next);
      onUnlock();
    } catch {
      setError("Could not reach the Nemo-route server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <form onSubmit={submit} className="panel w-full max-w-md">
        <div className="brand-mark">NVIDIA NIM</div>
        <h1 className="page-title mt-2 text-[1.75rem] font-semibold tracking-[-0.03em]">
          Unlock Nemo-route
        </h1>
        <p className="mt-2 text-[0.95rem] leading-relaxed text-[var(--muted)]">
          Paste the <span className="mono">NEMO_ADMIN_TOKEN</span> from your local{" "}
          <span className="mono">.env</span>. The dashboard does not ship a token of its own.
        </p>
        <label className="mt-5 block text-sm" htmlFor="admin-token">
          Admin token
        </label>
        <input
          id="admin-token"
          className="field mt-2"
          type="password"
          autoComplete="current-password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          required
        />
        {error ? <p className="mt-3 text-sm text-[var(--danger)]">{error}</p> : null}
        <button className="btn btn-primary mt-4" type="submit" disabled={busy}>
          {busy ? "Checking…" : "Unlock"}
        </button>
      </form>
    </div>
  );
}

export default function App() {
  const location = useLocation();
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [authed, setAuthed] = useState(() => Boolean(getAdminToken()));

  useEffect(() => {
    const onUnauthorized = () => setAuthed(false);
    window.addEventListener("nemo-admin-unauthorized", onUnauthorized);
    const token = getAdminToken();
    if (token) {
      void fetch("/admin/overview", { headers: { "x-nemo-admin-token": token } })
        .then((res) => {
          if (res.status === 401) clearAdminToken();
        })
        .catch(() => {});
    }
    return () => window.removeEventListener("nemo-admin-unauthorized", onUnauthorized);
  }, []);

  useEffect(() => {
    const storedTheme = localStorage.getItem("nemo-theme") as "dark" | "light" | null;
    if (storedTheme) setTheme(storedTheme);
    document.documentElement.setAttribute("data-theme", storedTheme ?? "dark");
  }, []);

  useEffect(() => {
    localStorage.setItem("nemo-theme", theme);
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  if (!authed) {
    return <AdminGate onUnlock={() => setAuthed(true)} />;
  }

  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>

      <aside
        className="sidebar"
        style={{ width: sidebarCollapsed ? 72 : 248 }}
      >
        <div className={sidebarCollapsed ? "px-1" : "px-2"}>
          {!sidebarCollapsed ? (
            <>
              <div className="brand-mark">NVIDIA NIM</div>
              <h1 className="brand-title">
                Nemo<span style={{ color: "var(--accent)" }}>-route</span>
              </h1>
              <p className="brand-copy">
                Availability-aware model router for coding harnesses.
              </p>
            </>
          ) : (
            <div className="flex justify-center pt-1">
              <span
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-sm font-bold"
                style={{ background: "var(--accent)", color: "#0a1200" }}
              >
                N
              </span>
            </div>
          )}
        </div>

        <nav className="nav-rail flex gap-1 overflow-x-auto px-1 md:flex-1 md:flex-col md:overflow-visible">
          {allLinks.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              title={label}
              className={({ isActive }) => `nav-link ${isActive ? "is-active" : ""}`}
            >
              <Icon size={18} />
              {!sidebarCollapsed ? <span>{label}</span> : null}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto hidden flex-col gap-2 border-t border-[var(--border)] px-1 pt-3 md:flex">
          <Button
            variant="ghost"
            className="w-full justify-center"
            onClick={() => setSidebarCollapsed((v) => !v)}
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {sidebarCollapsed ? <Icons.chevronRight size={16} /> : <Icons.chevronLeft size={16} />}
            {!sidebarCollapsed ? <span>Collapse</span> : null}
          </Button>
          <Button
            variant="ghost"
            className="w-full justify-center"
            onClick={() => {
              clearAdminToken();
              setAuthed(false);
            }}
            aria-label="Lock dashboard"
          >
            <span>Lock</span>
          </Button>
          <Button
            variant="ghost"
            className="w-full justify-center"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            aria-label="Toggle theme"
          >
            {theme === "dark" ? <Icons.sun size={16} /> : <Icons.moon size={16} />}
            {!sidebarCollapsed ? <span>{theme === "dark" ? "Light" : "Dark"}</span> : null}
          </Button>
        </div>
      </aside>

      <main className="main-pane" id="main-content">
        <div key={location.pathname} className="page-enter">
          <Routes>
            <Route path="/" element={<OverviewPage />} />
            <Route path="/setup" element={<SetupPage />} />
            <Route path="/models" element={<ModelsPage />} />
            <Route path="/keys" element={<KeysPage />} />
            <Route path="/requests" element={<RequestsPage />} />
            <Route path="/usage" element={<UsagePage />} />
            <Route path="/routing" element={<RoutingPage />} />
            <Route path="/token-routing" element={<TokenRoutingPage />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}
