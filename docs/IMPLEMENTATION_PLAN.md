# Implementation Plan

This roadmap implements [ARCHITECTURE.md](ARCHITECTURE.md), [DATA_MODEL.md](DATA_MODEL.md), and [FINANCIAL_ENGINE.md](FINANCIAL_ENGINE.md). Blocking choices are tracked in [DECISIONS.md](DECISIONS.md); product behavior traces to [FRD.md](FRD.md).

## Delivery Principles

Build vertical, reviewable slices. Each stage must leave the repository green with `pnpm lint`, `pnpm typecheck`, `pnpm test`, and relevant integration tests. Do not begin a stage until its listed dependency and blocking Open Decisions in `DECISIONS.md` are resolved. Financial behavior is implemented from `FINANCIAL_ENGINE.md`, not inferred from UI examples.

The first implementation task is Stage 1A. None of the remaining Open Decisions blocks it.

## Stage 1A — Workspace and Domain Primitives

**Goal:** Establish reproducible tooling and exact provider-neutral primitives without starting application behavior.

**Dependencies:** Architecture documents accepted.

**Tasks:**

1. Create Node.js 24 and pnpm workspace/package manifests for `apps/web`, `apps/worker`, and the four packages defined in `ARCHITECTURE.md`.
2. Add strict TypeScript, ESLint, formatting, Vitest, coverage, and package-boundary checks.
3. Implement exact `Money`, `CurrencyCode`, currency-scale, `LocalDate`, `Instant`, UUID/domain-ID, `AccountEntry`, booking-status, completeness, `MetricResult`, and clock types with validated string DTO codecs.

**Deliverables:** Locked dependencies, root workspace scripts, exact-value/foundational canonical types, unit tests, and contributor-command updates.

**Acceptance/tests:** Clean install and all root commands pass; exact arithmetic, currency mismatch, serialization, date, and ID cases pass; no financial package imports framework or database code.

**Out of scope:** PostgreSQL schema, migrations, Docker services, financial formulas, Next.js UI/routes, worker behavior, authentication, and integrations.

## Stage 1B — Runtime Scaffolding

**Goal:** Make empty delivery runtimes and development infrastructure reproducibly buildable.

**Dependencies:** Stage 1A.

**Tasks:** Add empty Next.js and worker entry points, CI execution of root checks, and Docker Compose development services for Caddy/web/worker/PostgreSQL without domain schema or behavior.

**Deliverables:** Buildable runtime shells, CI workflow, environment-variable contract, and container health-check skeletons.

**Acceptance/tests:** Web and worker build/start without feature routes or jobs; Compose reaches healthy infrastructure; package boundaries remain enforced.

**Out of scope:** Database tables/migrations, authentication, financial calculations, UI, and integrations.

## Stage 2 — Deterministic Financial Core

**Goal:** Implement the canonical in-memory model and engine calculations.

**Dependencies:** Stage 1A; opening-balance/liability policy resolved before Net Worth behavior is finalized.

**Tasks:** Split sessions by subsystem: ledger invariants and Net Worth; CCR and cash reconciliation; Pay Cycles and Sinking requirements; baseline and liquidity; Safe to Invest and Cash Drag; median-plus-stress Step-Up and expense rules; forecasts and versioned orchestration.

**Deliverables:** Pure engine APIs, exact arithmetic/rounding utilities, completeness propagation, explanation components, and version identifiers.

**Acceptance/tests:** Every formula example in `FINANCIAL_ENGINE.md` passes; identical input yields identical structured output; incomplete input cannot produce invest-more advice.

**Out of scope:** Persistence, HTTP, provider payloads, AI prose, or polished UI.

## Stage 3 — Synthetic Financial Dataset

**Goal:** Create a realistic, non-sensitive reference history for design validation.

**Dependencies:** Stage 2 domain types.

**Tasks:** Build 18–24 months of deterministic EUR fixtures covering salary on different calendar dates, side hustle, recurring/variable spending, travel, ATM/cash, cash reconciliation, refunds, transfer ambiguity, brokerage contributions, market changes, obligations, and Sinking Funds. Add expected Pay Cycle/monthly snapshots and documented provenance.

**Deliverables:** Seed-independent fixture builders, scenario catalog, expected outputs, and policy-calibration notes.

**Acceptance/tests:** Fixtures balance in minor units, contain no real personal data, and reproduce expected Net Worth/CCR/reserve results.

**Out of scope:** Production seeding, live imports, random unrepeatable data, and performance-scale generation.

## Stage 4 — Financial Engine Verification

**Goal:** Establish high confidence in financial invariants before infrastructure work.

**Dependencies:** Stages 2–3.

**Tasks:** Add table-driven tests for every requested scenario, including current-cycle funding, pay-cycle-invariant Step-Up, buffer semantics, unresolved transfers, and cash reconciliation; add fast-check generators for money/ledger invariants and golden snapshot tests for versioned engine output.

**Deliverables:** Unit/property suites, coverage thresholds, regression fixtures, and a traceability map from FR IDs to tests.

**Acceptance/tests:** 100% branch coverage for money, transfer, reservation, CCR, and Safe-to-Invest modules; all properties run with saved failure seeds; every FRD scenario has an explicit regression test.

Required reconciliation regressions are:

- allocating a current-cycle Sinking requirement leaves Safe to Invest unchanged;
- partial automatic allocation leaves the outstanding remainder protected;
- equivalent cycles with salary on the 1st or 28th produce equal capacity;
- capacities `[€20, €200, €200, €220]` have median €200, subject to the 60-day stress test;
- conservative Safe to Invest is one variability buffer below recommended before rounding;
- unresolved bank-to-cash or bank-to-brokerage candidates never become consumption;
- reconciling €140 system cash to €125 counted cash lowers Net Worth and Safe to Invest by €15 without creating income or consumption;
- material transfer/cash ambiguity suppresses invest-more recommendations;
- resolving either ambiguity deterministically supersedes affected snapshots.

**Out of scope:** Browser tests and external-service contract tests.

## Stage 5 — Persistence and Internal Debug Overview

**Status:** Implemented on 2026-09-15; production deployment hardening remains subject to the open backup and edge-control decisions.

**Goal:** Persist canonical facts and make calculations inspectable end to end.

**Dependencies:** Stages 1B and 2–4; provisional policy calibration reviewed.

**Tasks:** Implement Drizzle schema and reviewed migrations in entity-sized sessions, including Pay Cycles, fund requirements, transfer candidates, and cash reconciliations; add repositories, local login/session handling, command idempotency, pg-boss recalculation/allocation jobs, synthetic import, and a server-rendered authenticated debug view.

**Deliverables:** PostgreSQL ledger, versioned snapshots, audit/recalculation records, local auth, and tables showing inputs, components, warnings, and outputs.

**Acceptance/tests:** Re-import is idempotent; migration applies to empty DB; repository integration tests use real PostgreSQL; reclassification, transfer resolution, fund allocation, and reconciliation supersede/recompute correctly; restart loses no job.

**Out of scope:** Production dashboard styling, real providers, AI, and public registration.

## Stage 6 — Telegram Text Input

**Status:** Implemented on 2026-09-16, including the Stage 6.1 durable processing-retry and parser-closure repair; live bot credentials and production deployment remain operator concerns.

**Goal:** Record cash income, cash spending, and future-expense commands from the whitelisted user.

**Dependencies:** Stage 5.

**Tasks:** Add long polling, identity rejection, deterministic parsing, idempotent update handling, proposed-command validation, confidence-based confirmation, cash-count reconciliation, and correction flow. AI classification remains behind a disabled port.

**Deliverables:** Telegram adapter, command handlers, concise confirmations, and redacted operational logging.

**Acceptance/tests:** Replay creates one fact; unauthorized IDs create none; examples in FR-003/004/019 work; ambiguous or invalid input requests clarification without mutation.

**Out of scope:** Voice, general CFO questions, proactive notifications, and raw-message indefinite retention.

## Stage 7 — Portfolio Tracker Integration

**Contract status:** `READY_FOR_LIVE_PROVIDER_VALIDATION`. Stage 7.0 resolved provider-neutral authority and Stage 7.0.2 selected Sharesight. Stage 7.1 implements OAuth client credentials, bounded read-only HTTP, exact response validation, encrypted receipts, replay/revision state, and a durable full-history manual sync. Evidence is intentionally not activated in canonical valuation/contribution tables; no schedule or background job exists.

**Goal:** Import portfolio value, holdings summary, contribution evidence, and reconciliation data without double counting.

**Dependencies:** Stage 5; provider-neutral contract resolved; Sharesight API access provisioned for the personal account; manual Lightyear import freshness explicitly confirmed or recommendations kept source-incomplete.

**Tasks:** Implement capability discovery, encrypted connection configuration, raw receipt, normalization, cursoring, contribution matching, stale-state handling, and contract fixtures.

**Deliverables:** Provider-neutral portfolio adapter, sync jobs, valuation snapshots, contribution/return reconciliation view, and disconnect flow.

**Acceptance/tests:** Market-only gain and contribution-only scenarios separate correctly; retries are idempotent; brokerage cash cannot appear twice; stale data suppresses investment recommendations.

**Out of scope:** Brokerage trading, ETF selection, and automatic contributions.

## Stage 8 — Open Banking Integration

**Goal:** Reliably synchronize Swedbank accounts, balances, and transactions through the selected provider.

**Dependencies:** Stage 5; provider, history, deletion, FX, and consent decisions resolved.

**Tasks:** Implement OAuth/PKCE connection, encrypted tokens, incremental sync, raw imports, stable identity, pending-to-booked matching, transfer candidates, reconciliation, consent renewal, disconnect, and purge.

**Deliverables:** Bank adapter, callback, sync jobs/state, review queue, account reconciliation, and recovery runbook.

**Acceptance/tests:** Duplicate pages create one booked event; ambiguous matches are quarantined; token failures request reconnection; ATM and brokerage transfers remain non-consumption; purge semantics match policy.

**Out of scope:** Additional banks, credential storage, payment initiation, and automatic investment.

## Stage 9 — Decision-Oriented PWA

**Goal:** Deliver the FRD dashboard and secondary screens on iPhone as an installable PWA.

**Dependencies:** Stages 5, 7, and 8; real data reconciled.

**Tasks:** Implement authenticated overview, cash flow, transactions/corrections, capital, investments, plans, forecast, and CFO history in small route-level sessions. Add manifest, responsive/accessibility behavior, and static-only service-worker caching.

**Deliverables:** PWA screens, explicit completeness/staleness states, explanation breakdowns, and command confirmations.

**Acceptance/tests:** Key flows pass Playwright on mobile viewport; money uses server results; no sensitive API response is cached offline; partial and unavailable states cannot look authoritative.

**Out of scope:** Native iOS app, gamification, offline financial writes, and category-first budgeting.

## Stage 10 — What-If Forecasting

**Goal:** Compare user-controlled salary, contribution, side-income, and purchase/trip scenarios before adding AI interpretation.

**Dependencies:** Stages 2 and 9.

**Tasks:** Add validated scenario DTOs, pure forecast comparison, 0/3/5/7% views, nominal/real toggle, uncertainty disclosures, and ephemeral browser state with optional named scenario persistence.

**Deliverables:** Forecast API and screen with component breakdown and differences from baseline.

**Acceptance/tests:** FR-103 scenarios produce exact repeatable outputs; 0% equals contributions-only; planned spending is deducted once; changes never mutate canonical facts.

**Out of scope:** AI interpretation, Monte Carlo simulation, predictive ML, and guaranteed-return language.

## Stage 11 — AI CFO

**Goal:** Explain deterministic metrics and answer financial questions without creating financial truth.

**Dependencies:** Stages 9–10; AI provider, retention, region, and consent decisions resolved.

**Tasks:** Implement allowlisted context builder, provider port, prompt-policy versions, numeric-claim validator, deterministic fallback, data-exposure audit, and explicit-action barrier for proposed changes.

**Deliverables:** CFO question flow, explanation history, privacy controls, and evaluation set.

**Acceptance/tests:** Prompt injection cannot expose secrets or execute commands; invented numbers fail validation; every accepted amount maps to context; provider failure falls back without changing state.

**Out of scope:** Authoritative calculations, autonomous mutations, investment selection, and raw-history bulk upload.

## Stage 12 — Proactive CFO

**Goal:** Send restrained salary, weekly, opportunity, and warning messages.

**Dependencies:** Stages 6 and 11 plus reliable recommendation snapshots.

**Tasks:** Add deterministic event/rule triggers, deduplication, expiry, cooldowns, quiet/no-action behavior, scheduling, delivery outcomes, and user notification settings.

**Deliverables:** Salary and weekly summaries, Cash Drag and Sinking Fund alerts, recommendation lifecycle, and delivery audit.

**Acceptance/tests:** Replayed jobs send once; equivalent active/dismissed advice is suppressed; partial data sends no invest-more advice; “No action required” is valid.

**Out of scope:** Engagement notifications, auto-investing, and unbounded AI-generated outreach.

## Stage 13 — Optional Telegram Voice Input

**Goal:** Give voice messages the same safe command path as text without blocking the deterministic product or data integrations.

**Dependencies:** Stage 6 only; transcription provider/privacy policy selected. This stage may be deferred or implemented any time after Stage 6.

**Tasks:** Download within size/type limits, transcribe through a port, delete temporary audio, pass text through the existing parser, and expose failure/retry status.

**Deliverables:** Voice adapter, lifecycle cleanup, consent/configuration documentation, and fixtures.

**Acceptance/tests:** Successful voice input creates the same canonical command as text; failures create no financial fact; audio is deleted after success and terminal failure.

**Out of scope:** Voice storage, speaker identification, conversational memory, and changes to deterministic financial policy.

## Stage 14 — Security and Correctness Review

**Goal:** Establish production readiness for sensitive personal data.

**Dependencies:** All enabled V1 stages; backup objectives selected.

**Tasks:** Threat-model authentication, tokens, callbacks, Telegram, AI exposure, logs, deletion, backups, and dependency supply chain. Review all formula traceability, run full recalculation, rotate test secrets, test restore, and document incident/recovery procedures.

**Deliverables:** Closed findings, restore evidence, data-flow inventory, operating runbook, and release checklist.

**Acceptance/tests:** No critical/high findings; authorization and CSRF tests pass; secrets and financial descriptions are absent from logs; encrypted backup restores to a clean host; synthetic and production-shadow metrics reconcile.

**Out of scope:** Enterprise IAM, multi-region failover, formal compliance certification, and multi-user access.

## Requirements Traceability

| FRD area | Primary stages |
| --- | --- |
| FR-001, FR-002, FR-003, FR-004, FR-005, FR-006: data sources and cash | 6–8, 13 |
| FR-010, FR-011, FR-012: classification | 5, 6, 8 |
| FR-020, FR-021, FR-022: Net Worth | 2–5, 7–9 |
| FR-030, FR-031, FR-032: CCR | 2–5, 9, 11 |
| FR-040, FR-041, FR-050, FR-051, FR-052: liquidity and Cash Drag | 2–5, 9, 12 |
| FR-060, FR-061, FR-062, FR-070, FR-071, FR-072, FR-073, FR-080, FR-081, FR-082, FR-083: funds, Safe to Invest, and Step-Up | 2–5, 9, 12 |
| FR-090, FR-091, FR-092, FR-093, FR-094: optimization | 2–5, 9, 11–12 |
| FR-100, FR-101, FR-102, FR-103: forecasting | 2–5, 9–10 |
| FR-110, FR-111, FR-112, FR-113, FR-120, FR-121, FR-122, FR-123, FR-124: AI and proactive CFO | 11–12 |
| Dashboard, screens, and Telegram | 6, 9–13 |
| Security | 1A–1B, 5–14 |

## Global Definition of Done

A stage is complete only when its acceptance criteria and tests pass, new behavior maps to FRD IDs, architecture boundaries remain enforced, migrations and configuration are documented, logs contain no sensitive payloads, and unresolved assumptions are added to `DECISIONS.md` rather than silently encoded.
