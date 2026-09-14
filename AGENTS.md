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

Use Node.js 24 and pnpm 11.19.0. Install with `pnpm install --frozen-lockfile`. Run `pnpm lint` for source and package-boundary checks, `pnpm typecheck` for strict TypeScript, `pnpm test` for Vitest, and `pnpm format:check` before submitting. Use `pnpm format` to apply formatting and `pnpm test:coverage` when measuring coverage. Build runtime shells with `pnpm build`; use `pnpm dev:web` or `pnpm dev:worker` locally. `docker compose up --build` exposes only Caddy at `127.0.0.1:8080`; PostgreSQL remains internal.

Use strict TypeScript. Store money as integer minor units using `bigint`; serialize it as strings and never use JavaScript floating point in financial paths. Keep critical functions pure and pass time, settings, and inputs explicitly.

Unit-test every formula and edge case. Use integration fixtures rather than live credentials, and reference FRD IDs in tests when traceability helps. Internal transfers, cash reconciliation, duplicate imports, classification changes, and historical recalculation require explicit regression coverage.

## Commits and Pull Requests

Follow the established Conventional Commit style with short imperative subjects, for example `docs: reconcile pay-cycle policies` or `feat(domain): add money primitives`. Pull requests must identify affected requirements and decisions, summarize validation, and call out migrations, configuration, security implications, and screenshots when applicable.

## Security

Never commit credentials, tokens, personal transaction data, production exports, or unredacted provider payloads. Use sanitized fixtures. Preserve authentication, encryption, Telegram allowlisting, data-minimization, and non-authoritative AI boundaries from the architecture documents.
