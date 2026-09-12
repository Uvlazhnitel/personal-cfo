# Implementation Plan

This roadmap implements [ARCHITECTURE.md](ARCHITECTURE.md), [DATA_MODEL.md](DATA_MODEL.md), and [FINANCIAL_ENGINE.md](FINANCIAL_ENGINE.md). Blocking choices are tracked in [DECISIONS.md](DECISIONS.md); product behavior traces to [FRD.md](FRD.md).

## Delivery Principles

Build vertical, reviewable slices. Each stage must leave the repository green with `pnpm lint`, `pnpm typecheck`, `pnpm test`, and relevant integration tests. Do not begin a stage until its listed dependency and blocking Open Decisions in `DECISIONS.md` are resolved. Financial behavior is implemented from `FINANCIAL_ENGINE.md`, not inferred from UI examples.

The first implementation task is Stage 1A: create the workspace and standalone exact-value domain types. It intentionally excludes database schema and UI behavior.

## Stage 1 — Project Foundation

**Goal:** Establish reproducible tooling and enforce architectural boundaries.

**Dependencies:** Architecture documents accepted.

**Tasks:**

1. Create a Node.js 24/pnpm workspace with `apps/web`, `apps/worker`, and the four packages defined in `ARCHITECTURE.md`.
2. Add strict TypeScript, ESLint, formatting, Vitest, coverage, and package-boundary checks.
3. Implement only foundational `Money`, `CurrencyCode`, `LocalDate`, `Instant`, `AccountEntry`, `MetricResult`, clock, and ID types with string DTO codecs.
4. Add Docker Compose development PostgreSQL and CI commands; do not add domain tables.

**Deliverables:** Locked dependencies, workspace scripts, buildable empty runtimes, exact-value types, and contributor-command updates.

**Acceptance/tests:** Clean install and all root commands pass; invalid money/currency/date DTOs fail; no financial package imports framework or database code.

**Out of scope:** Database schema, formulas, routes, authentication UI, and integrations.

## Stage 2 — Deterministic Financial Core

**Goal:** Implement the canonical in-memory model and engine calculations.

**Dependencies:** Stage 1; opening-balance/liability policy resolved.

**Tasks:** Split sessions by subsystem: ledger invariants and Net Worth; CCR and reservations; baseline and liquidity; Safe to Invest and Cash Drag; Step-Up and expense rules; forecasts and versioned orchestration.

**Deliverables:** Pure engine APIs, exact arithmetic/rounding utilities, completeness propagation, explanation components, and version identifiers.

**Acceptance/tests:** Every formula example in `FINANCIAL_ENGINE.md` passes; identical input yields identical structured output; incomplete input cannot produce invest-more advice.

**Out of scope:** Persistence, HTTP, provider payloads, AI prose, or polished UI.

## Stage 3 — Synthetic Financial Dataset

**Goal:** Create a realistic, non-sensitive reference history for design validation.

**Dependencies:** Stage 2 domain types.

**Tasks:** Build 18–24 months of deterministic EUR fixtures covering salary, side hustle, recurring/variable spending, travel, ATM/cash, refunds, brokerage contributions, market changes, obligations, and Sinking Funds. Add expected monthly snapshots and documented provenance.

**Deliverables:** Seed-independent fixture builders, scenario catalog, expected outputs, and policy-calibration notes.

**Acceptance/tests:** Fixtures balance in minor units, contain no real personal data, and reproduce expected Net Worth/CCR/reserve results.

**Out of scope:** Production seeding, live imports, random unrepeatable data, and performance-scale generation.

## Stage 4 — Financial Engine Verification

**Goal:** Establish high confidence in financial invariants before infrastructure work.

**Dependencies:** Stages 2–3.

**Tasks:** Add table-driven tests for every requested scenario, fast-check generators for money/ledger invariants, and golden snapshot tests for versioned engine output.

**Deliverables:** Unit/property suites, coverage thresholds, regression fixtures, and a traceability map from FR IDs to tests.

**Acceptance/tests:** 100% branch coverage for money, transfer, reservation, CCR, and Safe-to-Invest modules; all properties run with saved failure seeds; every FRD scenario has an explicit regression test.

**Out of scope:** Browser tests and external-service contract tests.

## Stage 5 — Persistence and Internal Debug Overview

**Goal:** Persist canonical facts and make calculations inspectable end to end.

**Dependencies:** Stages 2–4; provisional policy calibration reviewed.

**Tasks:** Implement Drizzle schema and reviewed migrations in entity-sized sessions; add repositories, local login/session handling, command idempotency, pg-boss recalculation jobs, synthetic import, and a server-rendered authenticated debug view.

**Deliverables:** PostgreSQL ledger, versioned snapshots, audit/recalculation records, local auth, and tables showing inputs, components, warnings, and outputs.

**Acceptance/tests:** Re-import is idempotent; migration applies to empty DB; repository integration tests use real PostgreSQL; reclassification supersedes and recomputes history; restart loses no job.

**Out of scope:** Production dashboard styling, real providers, AI, and public registration.

## Stage 6 — Telegram Text Input

**Goal:** Record cash income, cash spending, and future-expense commands from the whitelisted user.

**Dependencies:** Stage 5.

**Tasks:** Add long polling, identity rejection, deterministic parsing, idempotent update handling, proposed-command validation, confidence-based confirmation, and correction flow. AI classification remains behind a disabled port.

**Deliverables:** Telegram adapter, command handlers, concise confirmations, and redacted operational logging.

**Acceptance/tests:** Replay creates one fact; unauthorized IDs create none; examples in FR-003/004/019 work; ambiguous or invalid input requests clarification without mutation.

**Out of scope:** Voice, general CFO questions, proactive notifications, and raw-message indefinite retention.

## Stage 7 — Telegram Voice Input

**Goal:** Give voice messages the same safe command path as text.

**Dependencies:** Stage 6; transcription provider/privacy policy selected.

**Tasks:** Download within size/type limits, transcribe through a port, delete temporary audio, pass text through the existing parser, and expose failure/retry status.

**Deliverables:** Voice adapter, lifecycle cleanup, consent/configuration documentation, and fixtures.

**Acceptance/tests:** Successful voice input creates the same canonical command as text; failures create no financial fact; audio is deleted after success and terminal failure.

**Out of scope:** Voice storage, speaker identification, and conversational memory.

## Stage 8 — Portfolio Tracker Integration

**Goal:** Import portfolio value, holdings summary, contribution evidence, and reconciliation data without double counting.

**Dependencies:** Stage 5; portfolio contract and valuation semantics resolved.

**Tasks:** Implement capability discovery, encrypted connection configuration, raw receipt, normalization, cursoring, contribution matching, stale-state handling, and contract fixtures.

**Deliverables:** Provider-neutral portfolio adapter, sync jobs, valuation snapshots, contribution/return reconciliation view, and disconnect flow.

**Acceptance/tests:** Market-only gain and contribution-only scenarios separate correctly; retries are idempotent; brokerage cash cannot appear twice; stale data suppresses investment recommendations.

**Out of scope:** Brokerage trading, ETF selection, and automatic contributions.

## Stage 9 — Open Banking Integration

**Goal:** Reliably synchronize Swedbank accounts, balances, and transactions through the selected provider.

**Dependencies:** Stage 5; provider, history, deletion, FX, and consent decisions resolved.

**Tasks:** Implement OAuth/PKCE connection, encrypted tokens, incremental sync, raw imports, stable identity, pending-to-booked matching, transfer candidates, reconciliation, consent renewal, disconnect, and purge.

**Deliverables:** Bank adapter, callback, sync jobs/state, review queue, account reconciliation, and recovery runbook.

**Acceptance/tests:** Duplicate pages create one booked event; ambiguous matches are quarantined; token failures request reconnection; ATM and brokerage transfers remain non-consumption; purge semantics match policy.

**Out of scope:** Additional banks, credential storage, payment initiation, and automatic investment.

## Stage 10 — Decision-Oriented PWA

**Goal:** Deliver the FRD dashboard and secondary screens on iPhone as an installable PWA.

**Dependencies:** Stages 5, 8, and 9; real data reconciled.

**Tasks:** Implement authenticated overview, cash flow, transactions/corrections, capital, investments, plans, forecast, and CFO history in small route-level sessions. Add manifest, responsive/accessibility behavior, and static-only service-worker caching.

**Deliverables:** PWA screens, explicit completeness/staleness states, explanation breakdowns, and command confirmations.

**Acceptance/tests:** Key flows pass Playwright on mobile viewport; money uses server results; no sensitive API response is cached offline; partial and unavailable states cannot look authoritative.

**Out of scope:** Native iOS app, gamification, offline financial writes, and category-first budgeting.

## Stage 11 — AI CFO

**Goal:** Explain deterministic metrics and answer financial questions without creating financial truth.

**Dependencies:** Stage 10; AI provider, retention, region, and consent decisions resolved.

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

## Stage 13 — What-If Forecasting

**Goal:** Compare user-controlled salary, contribution, side-income, and purchase/trip scenarios.

**Dependencies:** Stages 2 and 10.

**Tasks:** Add validated scenario DTOs, pure forecast comparison, 0/3/5/7% views, nominal/real toggle, uncertainty disclosures, and ephemeral browser state with optional named scenario persistence.

**Deliverables:** Forecast API and screen with component breakdown and differences from baseline.

**Acceptance/tests:** FR-103 scenarios produce exact repeatable outputs; 0% equals contributions-only; planned spending is deducted once; changes never mutate canonical facts.

**Out of scope:** Monte Carlo simulation, predictive ML, and guaranteed-return language.

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
| FR-001, FR-002, FR-003, FR-004, FR-005, FR-006: data sources and cash | 6–9 |
| FR-010, FR-011, FR-012: classification | 5, 6, 9 |
| FR-020, FR-021, FR-022: Net Worth | 2–5, 8–10 |
| FR-030, FR-031, FR-032: CCR | 2–5, 10–11 |
| FR-040, FR-041, FR-050, FR-051, FR-052: liquidity and Cash Drag | 2–5, 10, 12 |
| FR-060, FR-061, FR-062, FR-070, FR-071, FR-072, FR-073, FR-080, FR-081, FR-082, FR-083: funds, Safe to Invest, and Step-Up | 2–5, 10, 12 |
| FR-090, FR-091, FR-092, FR-093, FR-094: optimization | 2–5, 10–12 |
| FR-100, FR-101, FR-102, FR-103: forecasting | 2–5, 10, 13 |
| FR-110, FR-111, FR-112, FR-113, FR-120, FR-121, FR-122, FR-123, FR-124: AI and proactive CFO | 11–12 |
| Dashboard, screens, and Telegram | 6–7, 10–13 |
| Security | 1, 5–12, 14 |

## Global Definition of Done

A stage is complete only when its acceptance criteria and tests pass, new behavior maps to FRD IDs, architecture boundaries remain enforced, migrations and configuration are documented, logs contain no sensitive payloads, and unresolved assumptions are added to `DECISIONS.md` rather than silently encoded.
