# Persistence and Internal Debug Operations

Stage 5 implements the first durable path from canonical PostgreSQL facts through `evaluateFinancialState()` to versioned snapshots and the authenticated `/debug` page. PostgreSQL remains internal to Compose; only Caddy binds `127.0.0.1:8080`.

## Migration Workflow

Migrations in `packages/data/migrations/` are reviewed and sequential: identity/authentication, canonical finance, planning/reconciliation, derived engine state, then the pinned pg-boss schema and queues. Generate schema changes with `pnpm db:generate`, inspect SQL, validate with `pnpm db:check`, and apply once with `pnpm db:migrate`. Web and worker never migrate at startup. Reapplying all committed migrations is safe.

## Durable Calculation Flow

Repositories reconstruct domain objects from relational current projections and append-only history. A financial command locks its unique `(owner, kind, Idempotency-Key)`, hashes normalized request content, writes the mutation and audit record, increments the owner input version, and sends a pg-boss job through the same Drizzle transaction. Equal retries replay the stored result; a different payload returns conflict.

The worker obtains an owner advisory lock and stores one engine run per version/envelope. Successful runs atomically persist the normalized full result, metric snapshots, Pay Cycles, and fund requirements. Prior derived rows remain queryable but become non-authoritative and link to their replacement.

## Authentication and Commands

Create the local user with `pnpm admin:create-user -- <login>`; the password is read twice without echo. Login names are canonical lowercase. Login rotates active sessions. Browser commands under `/api/v1/commands/<kind>` require the session cookie, exact Origin, matching session-bound CSRF token, and an `Idempotency-Key` header.

Supported command kinds are `classification-correction`, `transfer-resolution`, `sinking-allocation`, `cash-reconciliation`, and `cash-reconciliation-resolution`. Reconciliation resolution is verified as either same-adjustment reclassification or an exact booked reversal on the reconciled account.

## Development and Recovery

Use `docker compose --profile test up -d postgres-test` for the disposable loopback test database; tests refuse any database not named `personal_cfo_test`. `pnpm synthetic:import` imports only the sanitized Stage 3 fixture and is not part of production runtime behavior.

Before production, configure HTTPS and secure cookies, Caddy edge throttling, external secret injection, encrypted off-host daily backups, retention, monitoring, and a documented restore drill. Backup destination, RPO, and RTO remain open decisions.
