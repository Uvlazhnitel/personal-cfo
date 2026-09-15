# Repository Guidelines

## Sources of Truth

Use each document only for its stated concern:

- `docs/FRD.md`: product intent and functional requirements.
- `docs/ARCHITECTURE.md`: runtime, module, dependency, security, and deployment boundaries.
- `docs/DATA_MODEL.md`: canonical entities, relationships, identity, and source-of-truth rules.
- `docs/FINANCIAL_ENGINE.md`: authoritative formulas, policies, completeness, and rounding.
- `docs/DECISIONS.md`: accepted decisions and unresolved questions.
- `docs/IMPLEMENTATION_PLAN.md`: delivery order and acceptance criteria.

Do not silently resolve conflicts between these documents. Record the conflict in `docs/DECISIONS.md` and reconcile the affected specifications before implementation.

## Project Structure

The accepted pnpm workspace layout is:

```text
apps/web/                  Next.js PWA and API delivery
apps/worker/               background and scheduled work
packages/domain/           canonical types, invariants, and ports
packages/financial-engine/ pure deterministic calculations
packages/data/             Drizzle schema and repositories
packages/integrations/     external-provider adapters
docs/                      requirements and design
```

Dependencies point inward: delivery and adapters may depend on domain interfaces. The financial engine depends only on provider-neutral domain types plus the explicitly allowlisted `decimal.js` forecast-math dependency; decimal objects stay internal. Provider DTOs, persistence models, framework types, and AI clients must not enter the engine.

## Development and Testing

Use Node.js 24 and pnpm 11.19.0. Install with `pnpm install --frozen-lockfile`. Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:coverage`, and `pnpm format:check` before submitting; `pnpm build` compiles both runtimes. Database work uses `pnpm db:check`, `pnpm db:generate`, and explicit `pnpm db:migrate`. Run PostgreSQL integration tests with `DATABASE_URL=.../personal_cfo_test pnpm test:integration`. `pnpm synthetic:import` is development-only; `pnpm admin:create-user -- <login>` requires a TTY.

`docker compose up --build` exposes only Caddy at `127.0.0.1:8080`; application PostgreSQL remains internal. Use the `test` profile for the disposable loopback database and the `tools` profile for explicit migration. Never auto-run migrations from web or worker startup.

Use strict TypeScript. Store money as integer minor units using `bigint`; serialize it as strings and never use JavaScript floating point in financial paths. Keep critical functions pure and pass time, settings, and inputs explicitly.

Unit-test every formula and edge case. Use integration fixtures rather than live credentials, and reference FRD IDs in tests when traceability helps. Internal transfers, cash reconciliation, duplicate imports, classification changes, and historical recalculation require explicit regression coverage.

Persistence mutations must be owner-scoped, transactional, append-only where facts are corrected, and paired atomically with audit, input-version increment, and pg-boss enqueue. Do not store authoritative source facts only in JSONB; JSONB is for bounded planning metadata and normalized derived snapshots.

## Commits and Pull Requests

Follow the established Conventional Commit style with short imperative subjects, for example `docs: reconcile pay-cycle policies` or `feat(domain): add money primitives`. Pull requests must identify affected requirements and decisions, summarize validation, and call out migrations, configuration, security implications, and screenshots when applicable.

## Security

Never commit credentials, tokens, personal transaction data, production exports, or unredacted provider payloads. Use sanitized fixtures. Preserve authentication, encryption, Telegram allowlisting, data-minimization, and non-authoritative AI boundaries from the architecture documents.
