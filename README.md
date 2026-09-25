# Personal CFO

Personal CFO is a deterministic, self-hosted financial decision system. It provides a PostgreSQL-backed calculation pipeline, local authentication, an internal persisted-state debug view, durable Telegram text input for one allowlisted owner, manually invoked read-only portfolio evidence adapters, and a secure evidence-only Enable Banking connection for one Swedbank Latvia EUR account. Portfolio Manager is the selected self-hosted production portfolio provider; Sharesight remains an independent reference/validation provider. Canonical bank and portfolio activation, voice, AI, proactive notifications, and the product PWA are not implemented.

## Requirements

- Node.js 24
- pnpm 11.19.0
- Docker with Compose for PostgreSQL 17 and the local runtime

## Development

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm format:check
```

Use `pnpm format` to apply formatting and `pnpm test:coverage` to generate a local coverage report.

Integration tests require `DATABASE_URL` to name exactly `personal_cfo_test`. Start the disposable loopback-only database with `docker compose --profile test up -d postgres-test`.

## Database and runtime

```bash
cp .env.example .env
docker compose up -d postgres
docker compose --profile tools run --rm migrate
docker compose --profile tools run --rm migrate node dist/dev/import-synthetic.js
docker compose --profile tools run --rm migrate node dist/cli/create-user.js local-user
docker compose up -d web worker caddy
pnpm build
pnpm dev:web
pnpm dev:worker
```

The web app is available at [http://localhost:3000](http://localhost:3000). `/api/health/live` is dependency-free; `/api/health/ready` returns `503` until PostgreSQL migrations and all four queues are present. `/debug` requires the bootstrapped local account and renders persisted data only.

Telegram remains disabled when `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_ID`, and `TELEGRAM_OWNER_ID` are all absent. Set all three to enable it; partial configuration fails worker startup. See [`docs/TELEGRAM.md`](docs/TELEGRAM.md) for supported commands, durability, correction, and privacy behavior.

Sharesight configuration is read only by `pnpm sharesight:sync`, so normal worker startup remains unaffected. The command stores encrypted validation receipts and provider evidence but never writes canonical valuations or confirmed investment principal. See [`docs/PORTFOLIO_PROVIDER_SHARESIGHT.md`](docs/PORTFOLIO_PROVIDER_SHARESIGHT.md) for required variables, authority boundaries, and current live-validation prerequisites.

Portfolio Manager configuration is read only by `pnpm portfolio-manager:sync`; normal worker startup remains unaffected. The manual command requires the v1 integration contract, stores every response as an encrypted receipt before decoding, resumes the provider cursor atomically, and produces evidence only. It never writes canonical valuations, confirmed principal, input versions, recalculations, recommendations, or financial jobs. See [`docs/PORTFOLIO_PROVIDER_PORTFOLIO_MANAGER.md`](docs/PORTFOLIO_PROVIDER_PORTFOLIO_MANAGER.md).

Enable Banking configuration is loaded only by the connection API routes and `pnpm enable-banking:fetch`. The application RSA key must be an external absolute-path mode-0600 file; the 32-byte data key encrypts session aliases, page continuations, display hints, and 30-day raw receipts. The authenticated connect route starts bank-controlled SCA, the public callback consumes a single-use 15-minute state, and account binding is an explicit authenticated CSRF-protected action. The manual fetch always requests `strategy=longest`, drains all continuation pages, and persists evidence only—never canonical entries, flows, contributions, versions, recalculations, recommendations, or jobs. See [`docs/OPEN_BANKING_PROVIDER_ENABLE_BANKING.md`](docs/OPEN_BANKING_PROVIDER_ENABLE_BANKING.md).

## Docker Compose

```bash
docker compose up --build -d
docker compose --profile tools run --rm migrate
```

The Caddy proxy serves [http://127.0.0.1:8080](http://127.0.0.1:8080); PostgreSQL remains internal. The admin command prompts twice without echo. Host-side `pnpm db:migrate` and `pnpm synthetic:import` require a host-reachable `DATABASE_URL`. Compose uses explicitly development-only credentials and the narrowly allowed insecure-cookie exception. Production requires HTTPS, secure cookies, external secrets, Caddy edge throttling, encrypted off-host backups, and a tested restore procedure.

Accepted requirements, architecture, data rules, financial policies, and delivery stages are documented in [`docs/`](docs/).
