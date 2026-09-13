# Personal CFO

Personal CFO is a deterministic, self-hosted financial decision system. The repository currently contains Stage 1B runtime scaffolding; it has no financial data, database schema, or integrations.

## Requirements

- Node.js 24
- pnpm 11.19.0

## Development

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm format:check
```

Use `pnpm format` to apply formatting and `pnpm test:coverage` to generate a local coverage report.

## Runtime shells

```bash
pnpm build
pnpm dev:web
pnpm dev:worker
```

The web shell is available at [http://localhost:3000](http://localhost:3000). Its liveness endpoint is `/api/health/live`; `/api/health/ready` confirms only runtime configuration and intentionally reports the database as `not-configured` until Stage 5.

## Docker Compose

```bash
docker compose up --build
```

The local Caddy proxy serves the web shell at [http://127.0.0.1:8080](http://127.0.0.1:8080). Compose uses explicitly development-only PostgreSQL defaults from `compose.yaml`; copy `.env.example` to `.env` to override them. Local Compose uses HTTP only. Production TLS belongs to the later deployment configuration.

Accepted requirements, architecture, data rules, financial policies, and delivery stages are documented in [`docs/`](docs/).
