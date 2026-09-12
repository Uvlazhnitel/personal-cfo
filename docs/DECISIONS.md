# Architecture Decision Log

See [ARCHITECTURE.md](ARCHITECTURE.md) for system boundaries, [DATA_MODEL.md](DATA_MODEL.md) for persisted concepts, [FINANCIAL_ENGINE.md](FINANCIAL_ENGINE.md) for policy, and [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for delivery order.

Decisions are effective for V1 unless superseded by a later entry. Product assumptions that require evidence or provider selection remain in Open Decisions.

## ADR-001 — pnpm Workspace Modular Monolith

**Status:** Accepted — 2026-09-12

**Decision:** Use one repository and release, organized as `apps/web`, `apps/worker`, and focused packages for domain, financial engine, data, and integrations. Use pnpm workspaces without Turborepo.

**Reasoning:** Package boundaries make the engine independently testable while one deployment and database keep operations simple.

**Alternatives:** One undivided Next.js tree weakens dependency boundaries. Microservices add network and operational failure modes with no V1 benefit.

**Consequences:** Cross-package APIs must be explicit. Web and worker are separate processes but remain one modular system and release train.

## ADR-002 — Independent Deterministic Financial Engine

**Status:** Accepted — 2026-09-12

**Decision:** Financial calculations are pure TypeScript functions over canonical immutable inputs. The engine cannot import database, framework, provider, network, clock, or AI modules.

**Reasoning:** Financial outputs must be reproducible, explainable, and testable without infrastructure.

**Alternatives:** Database procedures couple rules to persistence. LLM calculations are non-deterministic and cannot be authoritative. UI formulas drift across clients.

**Consequences:** Application services must assemble complete inputs and pass time/settings explicitly. Formula changes require an engine version and historical recalculation.

## ADR-003 — Integer Minor-Unit Money

**Status:** Accepted — 2026-09-12

**Decision:** Store money as PostgreSQL `BIGINT` minor units with an ISO-4217 currency. Use TypeScript `bigint`; serialize minor units as strings. Use exact decimal representations for FX and rates with explicit rounding.

**Reasoning:** Binary floating point can introduce cent-level errors. Integer arithmetic gives exact addition and comparison while supporting known currency scales.

**Alternatives:** JavaScript `number` is unsafe for authoritative money. Decimal-only money is valid but increases accidental scale and rounding variability.

**Consequences:** JSON adapters convert strings to validated `bigint`. Division and conversion require named rounding policies. UI code cannot calculate from formatted amounts.

## ADR-004 — EUR Reporting with FX-Ready Facts

**Status:** Accepted — 2026-09-12

**Decision:** Report V1 metrics in EUR while retaining original currency, original amount, versioned FX rate, conversion instant, and rounding provenance.

**Reasoning:** The initial user is EUR-based, but bank and portfolio activity may contain other currencies. Preserving originals avoids a future destructive migration.

**Alternatives:** EUR-only ingestion loses or quarantines valid activity. Full multi-currency reporting expands V1 UI and accounting scope.

**Consequences:** A missing required FX rate makes dependent metrics partial or unavailable; it never silently uses 1:1 or zero.

## ADR-005 — Canonical Transaction and Account Entries

**Status:** Accepted — 2026-09-12

**Decision:** Represent an economic event as a canonical transaction and its tracked-account balance effects as signed entries. Use explicit relations for transfers, refunds, reimbursements, reversals, and corrections.

**Reasoning:** This accurately represents ATM and brokerage transfers without introducing a full general-ledger product.

**Alternatives:** One flat provider transaction cannot reliably express two-sided transfers. Full double-entry accounting introduces accounts and rules the product does not need.

**Consequences:** Normalization must construct or link entries. Unmatched transfers remain reviewable rather than being guessed.

## ADR-006 — Contributions and Returns Are Separate

**Status:** Accepted — 2026-09-12

**Decision:** Confirmed cash-to-brokerage transfers are contribution principal. Portfolio valuations are separate snapshots. Return is derived from valuation change adjusted for flows and FX.

**Reasoning:** Treating a transfer as spending understates capital; treating it as return overstates performance and CCR.

**Alternatives:** Trusting a provider P/L field is simpler but provider semantics may differ. Treating investment accounts as ordinary bank balances risks duplicate valuation.

**Consequences:** Portfolio adapters must document whether cash and contributed capital are included. Provider P/L is used for reconciliation until semantics are verified.

## ADR-007 — Versioned Facts, Classifications, and Snapshots

**Status:** Accepted — 2026-09-12

**Decision:** Preserve immutable raw imports and append classification corrections. Store derived snapshots with engine version, settings version, input watermark, and supersession link. This is not event sourcing.

**Reasoning:** Rule changes and user corrections must allow reproducible historical recalculation without making snapshots the source of truth.

**Alternatives:** Overwriting classifications destroys auditability. Full event sourcing adds unnecessary projection and operational complexity.

**Consequences:** Recalculation can propagate from an old effective date through current rolling windows. Retention must preserve engine versions or explicitly mark old results non-reproducible.

## ADR-008 — PostgreSQL, Drizzle, and Reviewed Migrations

**Status:** Accepted — 2026-09-12

**Decision:** PostgreSQL is the sole V1 datastore. Use Drizzle for typed access and generate version-controlled SQL migrations that are reviewed before explicit deployment.

**Reasoning:** Relational constraints, exact numeric types, transactions, and queryability fit the canonical ledger and single-user operational profile.

**Alternatives:** SQLite complicates concurrent web/worker operation and later integrations. Document stores weaken financial invariants. Direct schema push is less auditable in production.

**Consequences:** Schema constraints and application invariants must agree. Migrations run once as a release step and require backup/rollback planning.

## ADR-009 — PostgreSQL-Backed Background Jobs

**Status:** Accepted — 2026-09-12

**Decision:** Use pg-boss in the application database for schedules, retries, transactional enqueueing, and dead-letter handling.

**Reasoning:** Synchronization and recalculation need durable jobs, but a separate queue datastore is unnecessary at V1 scale.

**Alternatives:** In-process timers lose work on restart. A custom queue duplicates retry and scheduling behavior. Redis adds another stateful service.

**Consequences:** The worker has database access and requires queue migrations. Queue health, backlog, retention, and failed jobs must be monitored.

## ADR-010 — Local Authentication and Single-Host Deployment

**Status:** Accepted — 2026-09-12

**Decision:** Bootstrap one local user with an Argon2id password and server-side cookie sessions. Deploy Caddy, web, worker, and PostgreSQL with Docker Compose on one HTTPS Linux host.

**Reasoning:** The PWA needs an application-level boundary; relying only on network location is too weak for a publicly reachable self-hosted finance application.

**Alternatives:** Reverse-proxy identity creates an external dependency. VPN-only access complicates callbacks and mobile access. Kubernetes is disproportionate.

**Consequences:** Account recovery, session revocation, TLS, rate limits, patching, and secret rotation are operator responsibilities. Only Caddy exposes network ports.

## ADR-011 — AI Is an Allowlisted Explanation Adapter

**Status:** Accepted — 2026-09-12

**Decision:** AI receives minimal, prepared `CfoContext` data and returns non-authoritative prose or classification proposals. Numeric claims are validated against supplied values. AI cannot execute commands or become a calculation input.

**Reasoning:** This preserves privacy and prevents probabilistic output from changing financial truth.

**Alternatives:** Sending raw history maximizes model context but unnecessarily exposes sensitive data. Allowing tool-driven mutation violates explicit-action and determinism requirements.

**Consequences:** Context builders, output validation, deterministic fallbacks, prompt-policy versions, and disclosure/audit records are required before enabling AI.

## Open Decisions

| Decision | Why it remains open | Owner | Resolve no later than |
| --- | --- | --- | --- |
| Open Banking provider and history depth | Provider coverage, PSD2 access, stable IDs, pending records, consent renewal, and pricing must be verified for Swedbank Latvia. | Product/engineering | Before Stage 9 |
| Portfolio tracker contract | API shape, valuation time, holdings, cash inclusion, contribution history, and P/L semantics are unknown. | Product/engineering | Before Stage 8 |
| FX provider and missing-rate policy | Availability, licensing, weekend rates, corrections, and portfolio FX attribution need evaluation. | Product/engineering | Before non-EUR ingestion |
| Imported-data deletion scope | FRD does not say whether deletion is per record, account, connection, or all data; re-import suppression and audit retention depend on it. | Product | Before Stage 9 |
| Financial-policy calibration | Reserve months, materiality, Cash Drag threshold, Step-Up cadence, and forecast assumptions are provisional configurable defaults and need synthetic/user validation. | Product | During Stages 3–5 |
| Liabilities and opening balances | V1 may omit liabilities, but Net Worth start-date and historical reconciliation need a chosen cutover policy. | Product | Before Stage 2 completion |
| AI retention and region | Provider, model, zero-retention availability, data region, and user consent are not selected. | Product/security | Before Stage 11 |
| Backup objectives | Off-host destination, encryption-key custody, retention, RPO, and RTO depend on the target server and operator. | Operator | Before production data |

## Explicitly Rejected for V1

Microservices, Kafka, Redis, Kubernetes, CQRS, event sourcing, separate module databases, automated investing, direct brokerage control, and authoritative AI calculations are rejected unless a later measured requirement supersedes these decisions.
