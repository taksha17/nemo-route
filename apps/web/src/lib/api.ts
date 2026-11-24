const STORAGE_KEY = "nemo-admin-token";

function browserStorage(): Storage | null {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}

export function getAdminToken(): string {
  return browserStorage()?.getItem(STORAGE_KEY)?.trim() ?? "";
}

export function setAdminToken(token: string) {
  browserStorage()?.setItem(STORAGE_KEY, token.trim());
}

export function clearAdminToken() {
  browserStorage()?.removeItem(STORAGE_KEY);
  window.dispatchEvent(new Event("nemo-admin-unauthorized"));
}

async function adminFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getAdminToken();
  const res = await fetch(`/admin${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "x-nemo-admin-token": token } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401) {
    clearAdminToken();
    throw new Error("Admin token rejected");
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  return res.json() as Promise<T>;
}

export async function subscribeAdminEvents(onEvent: () => void, signal: AbortSignal) {
  const token = getAdminToken();
  if (!token) return;
  while (!signal.aborted) {
    try {
      const res = await fetch("/admin/events", {
        headers: {
          Accept: "text/event-stream",
          "x-nemo-admin-token": token,
        },
        signal,
      });
      if (res.status === 401) {
        clearAdminToken();
        return;
      }
      if (!res.ok || !res.body) {
        await delay(2000, signal);
        continue;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (chunk.includes("event: nemo") || chunk.includes("event: ready")) onEvent();
      }
    } catch {
      if (signal.aborted) return;
      await delay(2000, signal);
    }
  }
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export const api = {
  overview: () => adminFetch<any>("/overview"),
  settings: () => adminFetch<any>("/settings"),
  saveSettings: (body: unknown) =>
    adminFetch("/settings", { method: "PUT", body: JSON.stringify(body) }),
  setNimKey: (apiKey: string) =>
    adminFetch<{ ok: boolean; hasNimKey?: boolean; warning?: string }>("/setup/nim-key", {
      method: "POST",
      body: JSON.stringify({ apiKey }),
    }),
  clearNimKey: () => adminFetch<{ ok: boolean }>("/setup/nim-key", { method: "DELETE" }),
  models: () => adminFetch<{ models: any[] }>("/models"),
  patchModel: (id: string, patch: unknown) =>
    adminFetch(`/models/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  modelEvents: (id: string) =>
    adminFetch<{ events: any[] }>(`/models/${encodeURIComponent(id)}/events`),
  syncCatalog: () => adminFetch("/catalog/sync", { method: "POST" }),
  keys: () => adminFetch<{ keys: any[] }>("/keys"),
  createKey: (label: string) =>
    adminFetch<{ key: any; rawKey: string }>("/keys", {
      method: "POST",
      body: JSON.stringify({ label }),
    }),
  revokeKey: (id: string) =>
    adminFetch(`/keys/${id}/revoke`, { method: "POST" }),
  requests: (limit = 100) =>
    adminFetch<{ requests: any[] }>(`/requests?limit=${limit}`),
  usage: (days = 14) => adminFetch<{ usage: any[] }>(`/usage?days=${days}`),
  snippets: () => adminFetch<any>("/harness-snippets"),
  tokenRouting: () => adminFetch<any>("/token-routing"),
  tokenRoutingOne: (id: string) =>
    adminFetch<any>(`/token-routing/${encodeURIComponent(id)}`),
  healthBootstrap: () =>
    adminFetch<any>("/health/bootstrap", { method: "POST" }),
};
