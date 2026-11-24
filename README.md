# Nemo-route

**Availability-aware model router for NVIDIA NIM**

![Overview](https://img.shields.io/badge/status-active-brightgreen)
![Version](https://img.shields.io/badge/version-0.1.0-orange)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

---

## The Idea

Nemo-route is a smart model router that sits between your application and NVIDIA NIM endpoints. It dynamically selects the best available model for each request based on health, performance, cost, and task requirements — with real-time failover when a model becomes unavailable.

**The core problem it solves**: When you have multiple NIM models with different tiers (light/medium/heavy), varying latency, and rate limits, you need a system that:

- **Routes intelligently**: Matches each request to the optimal model based on task type, complexity, and model capabilities
- **Handles failover**: Automatically switches to backup models when primary models fail or time out
- **Respects quotas**: Rate-limits live traffic while still allowing health probes and orchestration
- **Provides visibility**: Dashboard shows real-time model health, usage metrics, and routing decisions
- **Supports virtual models**: `nemo/auto`, `nemo/fast`, `nemo/code`, `nemo/reasoning`, `nemo/vision` orchestrate across real models

The result: You get optimal model performance without manual intervention, your NIM quotas last longer, and you have full observability into what's running where.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    Nemo-route Server                            │
│  (Hono server, port 8788)                                       │
├─────────────────────┬─────────────────────┬─────────────────────┤
│                     │                     │                     │
│   /v1/chat/completions  ←─→  Router (selector)  ─→  NIM Clients  │
│   /v1/messages              │                     │                     │
│   /healthz                  │                     │                     │
├─────────────────────┬─────────────────────┬─────────────────────┤
│                     │                     │                     │
│   Dashboard (React)  ←─→  API Routes  ←─→  Registry & Health  │
│   Setup, Models, Keys,   │     Telemetry       │     Live Routing    │
│   Requests, Usage,      │                     │                     │
│   Routing, Token Routing │                     │                     │
└─────────────────────┴─────────────────────┴─────────────────────┘
```

### Key Components

| Component | Purpose |
|---|---|
| **Router/Selector** (`apps/server/src/router/selector.ts`) | Ranks available models by task fit, tier match, health status, and latency. Supports pinned models, preference lists, and stickiness. |
| **Live Routing** (`apps/server/src/telemetry/liveRouting.ts`) | Mid-stream model handoff: if a model stalls or degrades, seamlessly continues with another model, preserving conversation context. |
| **Rate Governor** (`apps/server/src/upstream/rateGovernor.ts`) | Prioritizes live traffic over probes and orchestration. Guarantees live requests get through before probe/RPM budget is exhausted. |
| **Health Probes** (`apps/server/src/scout/health.ts`) | Periodic model health checks. Maintains real-time status (healthy/degraded/down) and TTFT metrics. |
| **Catalog Sync** (`apps/server/src/scout/catalogSync.ts`) | Periodically syncs model registry from NIM API, updating capabilities, tiers, and notes. |
| **Admin API** (`apps/server/src/admin/api.ts`) | Token management, model registration, and operational controls. |
| **Frontend** (`apps/web/`) | React dashboard with Overview, Models, Keys, Requests, Usage, Routing, and Token Routing pages. |

### Model Tiers & Task Types

- **Tiers**: `light`, `medium`, `heavy` — determines cost/latency tradeoffs
- **Task types**: `chat`, `code`, `reasoning`, `summarize`, `rewrite`, `extract`, `vision`
- **Virtual models**: `nemo/auto` (auto-route), `nemo/orchestrate` (multi-model), `nemo/fast`, `nemo/code`, `nemo/reasoning`, `nemo/vision`

---

## Setup

### Prerequisites

- Node.js >= 22
- pnpm >= 9.15.0
- NVIDIA NIM API key (`NIM_API_KEY`)
- Optional: NIM base URL (`NIM_BASE_URL`, defaults to `https://integrate.api.nvidia.com/v1`)

### 1. Environment

Copy `.env.example` to `.env` and configure:

```env
# Required
NIM_API_KEY=your_nvidia_api_key_here

# Optional (all have defaults)
NEMO_HOST=127.0.0.1
NEMO_PORT=8788
NEMO_ENCRYPTION_SECRET=  # Generated automatically if missing
NEMO_ADMIN_TOKEN=        # Generated automatically if missing
NIM_BASE_URL=https://integrate.api.nvidia.com/v1
NEMO_DATA_DIR=./data     # Directory for DB and cached state
```

**Generate secrets**: The server will auto-generate `NEMO_ENCRYPTION_SECRET` and `NEMO_ADMIN_TOKEN` if they're too short or blocked. Or run:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

### 2. Install dependencies

```bash
pnpm install
```

### 3. Build the web dashboard

```bash
pnpm --filter @nemo-route/web build
```

### 4. Start the server

```bash
pnpm --filter @nemo-route/server dev
```

Or start in production mode:

```bash
pnpm --filter @nemo-route/server start
```

The server will be available at `http://127.0.0.1:8788` (or custom host/port via env vars).

### 5. Access the dashboard

Open `http://127.0.0.1:8788` in your browser. On first use, you'll need to unlock the dashboard with your `NEMO_ADMIN_TOKEN`.

---

## Three Harness Setups

Nemo-route is designed to work with three deployment "harnesses":

### Harness 1: Local Development (Default)

```
Your app → Nemoroute (localhost:8788) → NIM APIs
```

- Best for: Development, testing, local prototypes
- Set `NEMO_HOST=127.0.0.1`, `NEMO_PORT=8788`
- Admin token auto-generated; set `NEMO_EXPOSE_ADMIN=1` to expose dashboard on non-loopback interfaces

### Harness 2: Behind a Reverse Proxy (Production)

```
Your app → Reverse Proxy (nginx/Caddy) → Nemoroute → NIM APIs
```

- Best for: Production deployments
- Configure `NEMO_HOST` with your public hostname
- Set `NEMO_EXPOSE_ADMIN=1` if you need admin access from external networks
- The reverse proxy handles TLS termination, rate limiting, and load balancing

### Harness 3: Containerized / Kubernetes

```
          +-----------------+
          |   Ingress/SB    |
          +--------+--------+
                   |
          +--------v--------+
          |   Nemoroute     |
          |   Deployment    |
          +--------+--------+
                   |
   +-----------v-----------+
   |   NIM Runtime / API   |
   +-----------------------+
```

- Best for: Kubernetes, Docker, serverless
- Deploy the server container with env vars
- Persist `NEMO_DATA_DIR` volume for DB state
- Use `nemo-route/server` Docker image (or build from this repo)
- Health checks can use `/healthz` endpoint

---

## How It Works

### Request Flow

1. **Incoming request** reaches `/v1/chat/completions` or `/v1/messages`
2. **Authentication**: API key validated (header `Authorization: Bearer ...` or `x-nemo-api-key`)
3. **Request analysis**: Task type, complexity, required inputs (text/image/video/tools), token count estimated
4. **Model fallback chain** generated via `selectFallbackChain()`:
   - Filters by required capabilities (vision, tools)
   - Excludes models with insufficient context
   - Ranks by: task strength fit, preference lists, tier match, health status, latency, error rate
   - Applies stickiness (session-to-model persistence)
5. **Primary model attempted** first, with retries and failovers (max 3 attempts per request)
6. **Mid-stream handoff**: If TTFT exceeds budget or errors occur, hands off to next model in chain
7. **Result**: Chosen model, routing segments, and telemetry recorded

### Failover Strategy

- **Primary → Retry → Failover**: Up to 2 retries per model, then moves to next model
- **TTFT budget**: Hard timeout per model tier (light: 60s, medium: 120s, heavy: 180s)
- **Error categorization**: Rate limited (429), unauthorized (401/403), upstream errors, multimodal unsupported
- **Vision demotion**: If hosted NIM rejects multimodal, strips media and retries on text-only models

### Live Routing (Mid-stream Handoff)

- If a model produces no tokens for `idleMs` (default 3min), automatically hands off to next model
- Conversation context preserved via handoff messages
- Each handoff tracked in telemetry with `role: "continue"`
- Configurable via `NEMO_LIVE_ROUTING_IDLE_MS` env var

---

## Dashboard Features

### Overview

- RPM usage vs limits
- Daily request counters
- Token counts (in/out)
- Success rate and failover count
- Healthy model count / total
- Quick status of each registered model

### Models

- List all registered NIM models
- View capabilities: tier, inputs (text/image/video/tools), status
- Manual health probe trigger
- Update model notes and credentials

### Requests

- Recent request history
- Filter by model, task type, outcome
- View routing segments (which models were tried)
- Search and pagination

### Usage

- Detailed token usage breakdown
- Per-model consumption
- Rate limit status
- Export options

### Routing

- Live routing session viewer
- See handoffs in real-time
- Toggle live routing on/off per request
- Track model performance over time

### Token Routing

- Per-token-level routing decisions
- See which model handles each token segment
- Useful for understanding complex multi-model workflows

### Setup

- Admin token entry
- Add/remove NIM API keys
- Configure model preferences (task-type → model priority lists)
- Edit runtime settings (RPM limits, timeout values, probe budgets)

---

## Development

### Project Structure

```
nemo-route/
├─ packages/
│  └─ shared/           # Shared types, interfaces, constants
├─ apps/
│  ├─ server/           # Hono + Express backend
│  └─ web/              # React + Vite dashboard
├─ .env                 # Environment variables (create from .env.example)
├─ package.json         # Workspace root scripts
└─ tsconfig.json        # TypeScript config
```

### Available Scripts

| Script | Description |
|---|---|
| `pnpm dev` | Start all services (server + web) in parallel |
| `pnpm dev:server` | Start only the backend |
| `pnpm dev:web` | Start only the frontend (Vite dev server) |
| `pnpm build` | Build all packages |
| `pnpm build:web` | Build the React dashboard |
| `pnpm test` | Run server tests |
| `pnpm test:watch` | Watch mode for vitest |
| `pnpm db:generate` | Generate Drizzle ORM migrations |
| `pnpm db:migrate` | Run database migrations |
| `pnpm start` | Start production server |

### Adding a New Model

1. Add model entry to `apps/server/src/scout/registry.ts` (or let catalog sync populate it from NIM API)
2. Ensure model `inputs` field covers required types (text/image/video/tools)
3. Set initial tier and note any special capabilities
4. The router will automatically consider it in fallback chains

### Customizing Model Preferences

Edit `packages/shared/src/index.ts` `DEFAULT_SETTINGS.taskPreferences`:

```typescript
taskPreferences: {
  code: ["nvidia/nemotron-3.5-lightning-30b-a3b", "z-ai/glm-5.3-flash"],
  chat: ["nvidia/nemotron-3.5-lightning-30b-a3b"],
  reasoning: ["nvidia/nemotron-3-ultra-550b-a55b"],
  vision: ["nvidia/cosmos-reason2-8b"],
},
```

Preferences are soft hints — the router still ranks by health and latency, but gives a small bonus to preferred models.

---

## API Reference

### Authentication

Requests to `/v1/*` require an API key. Pass one of:

- `Authorization: Bearer <nim_api_key>` 
- `x-nemo-api-key: <key_id>`
- `x-nemo-admin-token: <admin_token>` (admin routes only)

### Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/healthz` | Health check, always returns `{ok: true}` |
| `GET` | `/v1/models` | List available models (virtual + real) |
| `POST` | `/v1/chat/completions` | Chat completions with routing |
| `POST` | `/v1/embeddings` | Embedding calls |
| `GET` | `/admin/overview` | Admin dashboard data (requires admin token) |

### Request Body (Chat Completions)

Standard OpenAI-format body, with these Nemo-route extensions:

- `model`: Use `nemo/auto` for auto-routing, or specific model IDs
- `messages`: Conversation history
- `stream`: Set to `true` for SSE streaming
- `tools`: Tool calls (passed through to selected model)

### Response

OpenAI-compatible response with these additions:

- `choices[0].message.content`: Assistant response
- `usage.prompt_tokens`, `usage.completion_tokens`: Token counts
- `x-nemo-model`: The actual model that served the request
- `x-nemo-request-id`: Unique request trace ID

---

## Configuration Deep Dive

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `NEMO_HOST` | `127.0.0.1` | Server bind host |
| `NEMO_PORT` | `8788` | Server bind port |
| `NIM_API_KEY` | _(required)_ | NVIDIA API key |
| `NIM_BASE_URL` | `https://integrate.api.nvidia.com/v1` | NIM API base URL |
| `NEMO_ENCRYPTION_SECRET` | _(auto-generated)_ | Disk encryption secret |
| `NEMO_ADMIN_TOKEN` | _(auto-generated)_ | Admin dashboard password |
| `NEMO_DATA_DIR` | `./data` | Persistent data directory |
| `NEMO_EXPOSE_ADMIN` | _(empty)_ | Set to `1` to expose admin on any interface |
| `NEMO_LIVE_ROUTING_IDLE_MS` | `180000` | Idle timeout before live routing handoff |
| `NEMO_SKIP_BOOTSTRAP` | `_empty_` | Set to `true` to skip health bootstrap on start |

### Rate Governor

```
RateGovernor(liveRpm, dailyRpm, probeRpmBudget)
```

- `liveRpm`: RPM limit for live requests (default 40 from config)
- `dailyRpm`: Daily request limit (default 10,000)
- `probeRpmBudget`: RPM budget for health probes (default 4)

The governor ensures: `live requests always take priority over probes`. If live traffic is using 35 RPM and a probe tries to run, the probe waits until live RPM drops.

### Timeouts

| Variable | Description |
|---|---|
| `NEMO_LIGHT_TTFT_MS` | Light model TTFT budget (60s default) |
| `NEMO_MEDIUM_TTFT_MS` | Medium model TTFT budget (120s default) |
| `NEMO_HEAVY_TTFT_MS` | Heavy model TTFT budget (180s default) |
| `NEMO_IDLE_MS` | Idle timeout for streaming (180s default) |

---

## Testing

Run the test suite:

```bash
pnpm test
```

Key test files:

- `apps/server/test/rateGovernor.test.ts` — Rate governor prioritization
- `apps/server/test/failover.integration.test.ts` — NIM client against mock server, including crypto helpers
- `apps/server/test/anthropic.test.ts` — Anthropic API compatibility
- `apps/server/test/anthropic.test.ts` — Anthropic API compatibility tests

### Mock Server

The test suite includes `NimMockServer` (`apps/server/src/mock/nimMockServer.ts`) that simulates various NIM behaviors:

- `ok`: Normal response
- `403`, `404`, `429`: HTTP error codes
- `500`: Server error
- `slow_start`: Delayed first token
- `mid_stream_drop`: Drops mid-stream

---

## Roadmap

| Feature | Status | Description |
|---|---|---|
| `nemo/orchestrate` multi-model support | ✅ | Already implemented — dispatches to multiple models for tool use loops |
| Vision multimodal routing | ✅ | Vision models selected based on input presence; demotion on error |
| Plugin system | 📝 | Hook framework for custom routing strategies |
| Prometheus metrics endpoint | 📝 | `/metrics` for Grafana integration |
| OAuth authentication | 📝 | Replace API key auth with OAuth2 |
| Docker image | 📝 | Official container distribution |
| Kubernetes operator | 📝 | CRD for managing model routing policies |

---

## License

MIT License — see [LICENSE](LICENSE) for details.

---

## Acknowledgments

- Built with [Hono](https://hono.dev/) — lightweight web framework
- Uses [Drizzle ORM](https://orm.drizzle.team/) for type-safe SQL
- Dashboard with [React](https://react.dev/) and [Tailwind CSS](https://tailwindcss.com/)
- Model routing inspired by [Claude's tool use](https://anthropic.com/) patterns
- Mock server for NIM simulation

---

**Need help?** Open an issue or join the discussion. For questions about model routing strategies or customizing preferences, see the [selector.ts](apps/server/src/router/selector.ts) source — it's fully typed and readable.