# Nemo-route

**Availability-aware model router for NVIDIA NIM**

![Overview](https://img.shields.io/badge/status-active-brightgreen)
![Version](https://img.shields.io/badge/version-0.1.0-orange)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

---

## The Idea

Nemo-route sits between your apps (OpenCode, Claude Code, Pi, OpenAI/Anthropic SDKs) and NVIDIA NIM. It picks the best healthy model for each request, fails over on timeouts/errors, mid-stream hands off stalled generations, and exposes a dashboard for health, usage, and routing traces.

**Virtual models:** `nemo/auto`, `nemo/fast`, `nemo/code`, `nemo/reasoning`, `nemo/vision`, `nemo/orchestrate`

---

## Architecture

```
Apps / CLIs ──► Nemo-route (:8788)
                  ├─ /v1/chat/completions   (OpenAI-compatible)
                  ├─ /v1/messages           (Anthropic-compatible)
                  ├─ /v1/embeddings
                  ├─ /healthz  /metrics
                  └─ /admin/*  + React dashboard
                         │
                         ▼
                   NVIDIA NIM APIs
```

| Component | Role |
|---|---|
| Selector | Ranks models by task, tier, health, latency, preferences, stickiness |
| Executor | Failover + streaming idle handoff with conversation context |
| Rate governor | Live > orchestrate > probe; non-blocking admit under RPM/day caps |
| Health scout | Probes, circuits, half-open recovery, catalog sync |
| Admin API + UI | Setup, models, keys, requests, usage, routing, token routing |
| Plugin hooks | `registerRouteHook()` to reshape the fallback chain |

---

## Quick start

### Prerequisites

- Node.js ≥ 22, pnpm ≥ 9.15
- NVIDIA NIM API key

### 1. Environment

```bash
cp .env.example .env
```

| Variable | Default | Notes |
|---|---|---|
| `NEMO_HOST` / `NEMO_PORT` | `127.0.0.1` / `8788` | Bind address |
| `NEMO_DATA_DIR` | `./data` | SQLite + operator secrets |
| `NEMO_ENCRYPTION_SECRET` | *auto* | Auto-generated into `$NEMO_DATA_DIR/.nemo-operator.json` if unset. Explicit weak values are rejected. |
| `NEMO_ADMIN_TOKEN` | *auto* | Same as encryption secret |
| `NIM_API_KEY` | — | Optional seed; otherwise paste in Setup |
| `NIM_BASE_URL` | `https://integrate.api.nvidia.com/v1` | |
| `NEMO_EXPOSE_ADMIN` | off | Set `1` to mount `/admin` on non-loopback |
| `NEMO_SKIP_BOOTSTRAP` | false | Skip startup health sweep |
| `NEMO_LIGHT_TTFT_MS` / `MEDIUM` / `HEAVY` / `IDLE` / `LIVE_ROUTING_IDLE_MS` | 60s / 120s / 180s / 180s | Timeout overrides (also editable in UI) |

### 2. Install & run (dev)

```bash
pnpm install
pnpm dev                 # server + web
# or
pnpm dev:server
pnpm build:web && pnpm start   # production-style after build
```

Dashboard: `http://127.0.0.1:8788` — unlock with `NEMO_ADMIN_TOKEN` (printed/generated on first boot if unset).

### 3. Create a harness API key

In **Keys**, create a `nemo-sk-…` key. Gateway auth uses **that** key (not the raw NVIDIA key):

```http
Authorization: Bearer nemo-sk-...
```

Also accepted: `x-api-key: nemo-sk-...`

### 4. Docker

```bash
docker compose up --build
# or
pnpm docker:build && docker run --rm -p 8788:8788 \
  -e NIM_API_KEY=nvapi-... -e NEMO_EXPOSE_ADMIN=1 \
  -v nemo-data:/data nemo-route/server:local
```

Persist `/data` so SQLite and auto-generated secrets survive restarts.

---

## Harness tips

| Client | Point at | Auth |
|---|---|---|
| OpenAI SDKs / OpenCode | `http://127.0.0.1:8788/v1` | `nemo-sk-…` |
| Claude Code | `ANTHROPIC_BASE_URL=http://127.0.0.1:8788` | same key as `ANTHROPIC_API_KEY` |
| Pi | provider `nemo-route` → `/v1` | `--api-key nemo-sk-…` |

Run coding agents from a **sandbox cwd** (or disable tools) if you do not want them editing this repo — Pi previously rewrote live gateway code mid-stress.

---

## How routing works

1. Authenticate harness key → analyze task/complexity/vision/tools  
2. Build fallback chain (`selectFallbackChain` + optional route hooks)  
3. Attempt models with TTFT budgets (light/medium/heavy); max **3** upstream attempts  
4. On stream idle timeout: hand off with partial draft **unless** `partialStreamBehavior=error`  
5. Record attempts/segments; live sessions stay open until the SSE pump finishes  
6. Response headers: `X-Nemo-Model`, `X-Nemo-Request-Id`

`nemo/orchestrate` runs the multi-subtask planner (tools are described in-plan when present).

---

## Dashboard

| Page | Capabilities |
|---|---|
| Overview | RPM/daily/tokens/success + **per-model status** table |
| Models | Catalog sync, bootstrap, **per-model probe**, **notes** edit |
| Requests | Search + filter by model/task/outcome + pagination + attempt/segment trace |
| Usage | Charts, **rate-limit status**, **CSV export** |
| Routing | Limits, timeouts, partial-stream mode, preferences; link to live sessions |
| Token Routing | Active/recent **segment-level** routing (not per-token decisions) |
| Keys | Create/revoke `nemo-sk` harness keys + debug body retention |
| Setup | Upstream NIM key + admin unlock |

One **upstream** NIM credential is stored encrypted. Many **harness** keys can be issued.

---

## API

| Method | Path | Auth |
|---|---|---|
| GET | `/healthz` | none |
| GET | `/metrics` | none (Prometheus text) |
| GET | `/v1/models` | harness key |
| POST | `/v1/chat/completions` | harness key |
| POST | `/v1/embeddings` | harness key |
| POST | `/v1/messages` | harness key |
| POST | `/v1/messages/count_tokens` | harness key |
| * | `/admin/*` | `x-nemo-admin-token` |

---

## Scripts

| Script | Description |
|---|---|
| `pnpm dev` / `dev:server` / `dev:web` | Dev watchers |
| `pnpm build` / `build:web` / `build:server` | Production builds |
| `pnpm start` | Run `apps/server/dist` (build first) |
| `pnpm test` / `test:watch` | Vitest (server) |
| `pnpm db:generate` / `db:migrate` | Drizzle |
| `pnpm docker:build` | Local image `nemo-route/server:local` |

Stress suite: `scripts/stress-study/run-stress.ps1 -Suite switch|baseline -Minutes 30`

---

## Testing

```bash
pnpm test
```

Coverage includes rate governor, failover, handoff, selector, Anthropic helpers, stream terminals, security (admin token, CORS, secret validation, encryption).

Not yet covered: full browser UI e2e, every HTTP SSE edge case, K8s smoke.

---

## Project layout

```
packages/shared/     shared types
apps/server/         Hono gateway + admin + scout
apps/web/            React + Vite dashboard
Dockerfile           production image
docker-compose.yml   local compose
```

---

## Roadmap

| Item | Status |
|---|---|
| Virtual models + vision demotion + mid-stream handoff | ✅ |
| `nemo/orchestrate` planner | ✅ |
| Prometheus `/metrics` | ✅ |
| Docker image + Compose | ✅ |
| Route hook registry | ✅ (minimal) |
| OAuth2 for harness auth | 📝 planned |
| Kubernetes operator / CRDs | 📝 planned |
| Richer catalog capability sync from NIM | 📝 planned |

---

## License

MIT — see [LICENSE](LICENSE).
