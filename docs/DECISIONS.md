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

## ADR-012 — Pay-Cycle Sinking Fund Requirements

**Status:** Accepted — 2026-09-13

**Decision:** Schedule committed Sinking Fund contributions against actual primary-salary Pay Cycles. Protect the outstanding current-cycle requirement in minimum and comfort cash before allocation. Allocation is manual by default, with deterministic `on_primary_income` behavior available only through an explicit per-fund setting.

**Reasoning:** A target that is not yet ring-fenced still competes with investing during the current income cycle. Protecting the due amount closes that gap, while exchanging outstanding due for ring-fenced cash one-for-one prevents double counting.

**Alternatives:** Calendar-month funding is sensitive to salary-date placement. Treating only allocated cash as reserved can recommend investing money needed to keep a committed fund on schedule. Automatic allocation by default makes a user choice without sufficient V1 evidence.

**Consequences:** Pay Cycle and versioned fund-requirement concepts are canonical inputs. Opt-in automatic allocation is audited, ordered deterministically, limited by non-Sinking minimum liquidity, and never moves physical money.

## ADR-013 — Robust Pay-Cycle Investment Step-Up

**Status:** Accepted — 2026-09-13

**Decision:** Evaluate the latest four complete actual primary-salary Pay Cycles. Use their median capacity, then require the proposed contribution to pass a deterministic 60-day liquidity stress test at 0% market return.

**Reasoning:** Actual salary boundaries remove arbitrary calendar timing. Median resists one legitimate expensive cycle, while the forward test protects against known near-term liquidity risk.

**Alternatives:** Minimum capacity is too sensitive to one outlier. A lower quartile is unstable with four samples and behaves similarly to minimum. Median alone does not account for future obligations.

**Consequences:** Step-Up waits for four complete cycles and reliable data. A candidate is reduced in €50 steps until the forecast stays above minimum cash throughout and ends at or above comfort cash; otherwise the result is hold or Step-Down.

## ADR-014 — Unresolved Transfers Are Quarantined from Meaning

**Status:** Accepted — 2026-09-13

**Decision:** A plausible unmatched transfer is `unresolved_transfer`, not income or consumption. Non-material affected flow metrics are partial; a material candidate makes CCR and Safe to Invest unavailable and suppresses invest-more recommendations.

**Reasoning:** Treating a delayed bank-to-cash or bank-to-brokerage match as consumption knowingly creates misleading CCR and spending data.

**Alternatives:** Provisional consumption is simple but wrong in common cases. Provisional transfer classification can hide a real external expense.

**Consequences:** Candidates require explicit evidence/status and resolution history. Account balances can remain usable, but metric completeness and recommendation gates must disclose the ambiguity and trigger recalculation after resolution.

## ADR-015 — Cash Reconciliation Uses Audited Adjustments

**Status:** Accepted — 2026-09-13

**Decision:** A physical cash count creates a reconciliation record and signed `cash_reconciliation_adjustment`; it never overwrites ledger history. The adjustment is an unexplained Net Worth change, not ordinary income or consumption.

**Reasoning:** Manual cash inevitably drifts. Inventing a normal expense or income would contaminate CCR and the spending baseline, while ignoring the count would overstate available cash.

**Alternatives:** Direct balance overwrite loses provenance. Automatic consumption classification pretends the cause is known. Refusing reconciliation leaves incorrect liquidity.

**Consequences:** The counted balance immediately affects Net Worth, liquidity, and Safe to Invest. Material unexplained variance suppresses invest-more advice. Later resolution must reclassify the adjustment or reverse it before adding a recovered transaction so the balance changes once.

## ADR-016 — Net Worth Freshness and Missing Values

**Status:** Accepted — 2026-09-13

**Decision:** Current Net Worth may use a known value past its explicit `staleAt`, but the result is `partial` and carries a source warning. A missing required value or missing EUR conversion makes Net Worth `unavailable`; the engine never presents a known-component subtotal as Net Worth. Each input supplies `sourceAsOf` and `staleAt`; the assembler derives the deadline from effective settings and any applicable market calendar.

**Reasoning:** A last known value remains useful when visibly qualified, while a value that never existed cannot be replaced with zero. An explicit deadline keeps the engine deterministic without embedding an incomplete market-holiday calendar.

**Alternatives:** Making every stale value unavailable discards useful current-state information. Returning a partial subtotal can be mistaken for total wealth. Hardcoding weekdays or 72 hours silently changes the accepted three-market-day policy.

**Consequences:** Net Worth distinguishes stale-known from missing data. Invest-more rules remain suppressed for partial inputs. Later provider and FX work must supply versioned conversion and freshness provenance.

## ADR-017 — Stage 2B CCR Completeness Boundary

**Status:** Accepted — 2026-09-13

**Decision:** Stage 2B requires explicit canonical EUR economic-flow classifications, complete period coverage, and an explicit short-term-reserve effect. Material classification or transfer ambiguity makes CCR unavailable; non-material ambiguity permits a warned partial value. Linked refunds and reimbursements reduce consumption on their booking date. Unlinked reversals and neutral external flows never become income or silently change consumption. Cash reconciliation adjustments remain outside CCR, with material unexplained variance making the result partial.

**Reasoning:** A confidently wrong income-to-capital ratio is less useful than an unavailable result. Keeping the reservation term explicit prevents Stage 2B from overstating capital creation before Stage 2C supplies allocation facts, while period-local reversals keep the audit trail stable.

**Alternatives:** Defaulting reservation effects to zero hides missing inputs. Treating all ambiguity as partial can present a materially wrong ratio. Backdating refunds silently rewrites previously reported periods.

**Consequences:** Callers must supply complete reservation-event coverage before an empty period can produce zero impact. Resolution or reclassification recalculates affected periods and rolling windows. This narrows ADR-014 for CCR specifically: its material unresolved-transfer result is unavailable rather than partial.

## ADR-018 — Explicit Pay Dates and Event-Based Reservation Accounting

**Status:** Accepted — 2026-09-13

**Decision:** Actual positive primary-salary triggers define Pay Cycle boundaries. Callers supply Europe/Riga effective dates and a future primary-pay schedule with explicit coverage; the engine does not forecast salary dates. The active cycle counts for a committed fund created mid-cycle. Funding dates after the due date are excluded, and remainder cents are assigned to the earliest eligible opportunities. CCR derives reserve changes from immutable allocation, funded-consumption, and release events for each measurement period.

**Reasoning:** Explicit dates preserve holiday and booking-date variation without embedding a cadence predictor. Event aggregation makes current and rolling CCR correct for different windows, while front-loaded remainder cents retain the accepted upward-rounded current requirement and exact target total.

**Alternatives:** Calendar-month cycles and generated salary dates introduce hidden assumptions. One pre-aggregated reserve value cannot serve multiple rolling periods. Equal rounded contributions can lose cents.

**Consequences:** Expected-pay and reservation histories carry completeness coverage. Empty covered history yields zero reserve change; missing coverage makes the result unavailable. Overfunding remains reserved and separately visible until an explicit release, and corrections use compensating immutable events.

## ADR-019 — Validated Reservation Ledger and Fulfillment Projection

**Status:** Accepted — 2026-09-13

**Decision:** Every reservation calculation uses one canonical history validator over Sinking Funds, reservation events, coverage, as-of time, and linked consumption facts. Events must reference an existing same-currency fund after its creation and, in effective-time then stable-ID order, may never make reserved cash negative. Scheduling projects current reserved cash, funded consumption to date, fulfilled target amount, remaining funding need, and excess separately. Funded consumption moves value from reserved to spent progress without reducing fulfillment; a release reduces both reserved cash and fulfillment.

**Reasoning:** Current ring-fenced cash is not the same as cumulative target progress. Treating funded spending as lost progress reschedules an already funded purchase, while aggregating unvalidated releases can falsely increase capital created.

**Alternatives:** Deriving funding need from current reserved balance loses completed spending progress. Validating only events inside a CCR window cannot prove its opening reserve or prevent impossible releases.

**Consequences:** CCR inputs include the relevant Sinking Funds and complete reservation history, including pre-period events needed to validate opening balances. Funded-consumption and release events remain negative reservation changes for commitment accounting, so the CCR formula and rolling-window behavior do not change.

## ADR-020 — Exact Spending Baseline Statistics and Proration

**Status:** Accepted — 2026-09-13

**Decision:** Use half-even minor-unit medians, nearest-rank P80 variability, and a minimum of three complete monthly observations. Select the latest required complete months within a 36-month V1 historical lookback, continuing past incomplete or missing-coverage months. When 24 complete months are available within that bound, an exact target-calendar-month factor may adjust only variable spending and is capped to ±20%; it reuses the authoritative per-category MAD winsorization rather than raw spending. Explicit recurring schedules remain unchanged. Linked reversals affect their booking month and cannot make a category-month negative. Operational variable burn is prorated over Europe/Riga calendar days, accumulated as an exact rational, and rounded half-even once.

**Reasoning:** These rules avoid interpolation and binary floating point, prevent isolated data gaps and raw seasonal outliers from distorting the baseline, preserve the authority of next-period recurring schedules, keep refund history auditable, and prevent month-length differences from creating hidden liquidity assumptions.

**Alternatives:** Linear percentile interpolation adds an unnecessary rounding surface. Adjusting the whole baseline double-adjusts known recurring costs. A fixed 31-day divisor is simpler but distorts shorter calendar months.

**Consequences:** Baseline results disclose their factor, excluded reversal excess, selected sample window, and deterministic warnings for skipped incomplete and missing-coverage months. Seasonality uses its own latest-24-complete-month selection within the same bound. Changing any policy requires an engine-version change and historical recalculation.

## ADR-021 — Explicit Investability Readiness and Cash Drag Window

**Status:** Accepted — 2026-09-14

**Decision:** Safe to Invest consumes Stage 2D liquidity plus a typed readiness gate that distinguishes complete, approved non-material provisional, and blocked states. Cash Drag evaluates the effective Europe/Riga date plus the preceding 59 local dates; current Stage 2D liquidity is authoritative for the effective date. Only complete daily observations enter the average, which uses one half-even minor-unit division. A partial Safe-to-Invest value cannot make Cash Drag eligible. Stage 2E reports financial eligibility and the current rounded Recommended Safe-to-Invest action cap, but does not implement notification deduplication or cooldowns.

**Reasoning:** Different partial-liquidity causes have different safety consequences and cannot be inferred from human-readable warnings. An explicit current-day authority prevents conflicting snapshots, while local-date windows and exact averaging preserve deterministic persistence evidence.

**Alternatives:** Treating every partial result as investable can expose unsafe advice. Treating all partial results as zero confuses missing information with no surplus. Recomputing historical comfort cash under current settings destroys the meaning of the historical evidence.

**Consequences:** Input assembly must classify investability readiness explicitly and retain each day's authoritative comfort threshold. Historical observations stop before the current effective date. Persistence-backed recommendation lifecycle remains a later-stage responsibility.

## ADR-022 — Auditable Daily Step-Up Stress Boundaries

**Status:** Accepted — 2026-09-14

**Decision:** Evaluate recurring-contribution candidates at the next 60 Europe/Riga daily closing boundaries, beginning the day after the effective date. Current authoritative liquid cash is the opening state. Stage 2F consumes a structured, arithmetically reconciled daily projection rather than rebuilding baseline, obligation, or Sinking Fund policy. A complete-capacity Step-Down may remain `partial` when its exact target lacks complete forward evidence; zero is returned with an explicit residual-breach flag when even zero fails a complete path.

**Reasoning:** Starting after the current authoritative boundary prevents same-day cash flows from being applied twice. Named projected components retain auditability without duplicating Stage 2D calculations. A known excessive contribution still supports a conservative reduction when future coverage is incomplete, while the partial status prevents the proposed target from being presented as proven safe.

**Alternatives:** Including the effective date requires unresolved intraday ordering. Accepting opaque balances loses salary, obligation, and Sinking provenance. Suppressing every capacity-driven reduction until forward coverage is complete hides a known overcommitment; claiming such a reduction is completely safe overstates the evidence.

**Consequences:** Projection assembly must provide complete-through coverage and one reconciled row per forward date. Recommendation persistence later associates an issued Step-Up with the ordered four-cycle window. Safety Step-Down remains independent of Cash Drag and upward-window suppression.

## ADR-023 — Deterministic Forecast Precision and Checkpoint Orchestration

**Status:** Accepted — 2026-09-14

**Decision:** Long-term forecasts begin at the next full Europe/Riga month and use an isolated `decimal.js` clone at 64 significant digits with half-even rounding to calculate compound monthly roots. Money returns to integer minor units at every monthly boundary. `evaluateFinancialState` derives investability, historical Cash Drag observations, pre-closing Safe to Invest, and forward Step-Up paths from primitive checkpoint facts under one run envelope. Pre-closing evaluation uses the prior local day close; later same-date activity makes the capacity observation incomplete.

**Reasoning:** Annual-to-monthly compound roots are generally irrational and cannot be represented by bigint fractions, while JavaScript binary floating point is prohibited for authoritative financial arithmetic. A next-month boundary avoids awarding a full month's return to a partial month. Primitive checkpoints close the earlier trust boundaries without adding persistence or fabricatable downstream metrics.

**Alternatives:** Annual-rate division by 12 is mathematically different. Carrying fractional cents across boundaries hides non-monetary state. Accepting ready-made readiness, daily excess, STI, or projection rows merely relocates authority to callers. Intraday ordering around salary is unavailable in the canonical V1 facts.

**Consequences:** `packages/financial-engine` may depend only on `@personal-cfo/domain` and the explicitly reviewed `decimal.js` package. Decimal objects stay private and outputs use canonical rate strings. Historical checkpoint assembly must retain effective settings and complete source facts; stored prior-version snapshot reproduction remains a future persistence concern.

## ADR-024 — Cutoff-Derived History and Verifiable Cash-Reconciliation Resolution

**Status:** Accepted — 2026-09-14

**Decision:** Historical checkpoints carry planning, coverage, and quality context only. At every inclusive cutoff, the engine derives booked economic flows, active ambiguities and reconciliations, Sinking Funds, allocations, and linked spending observations from one root canonical history and sorts them by time and stable identity. Cash reconciliation resolution is either same-adjustment reclassification or a distinct booked valuation-adjustment reversal. A reversal is valid only when its entries on the reconciled account exactly negate the variance in the same currency. Resolution affects active state only from `resolvedAt`.

**Reasoning:** A checkpoint-owned copy of financial history can omit material evidence and manufacture authoritative historical liquidity or Safe to Invest. A generic resolution link can likewise clear an unexplained variance without proving the economic correction. Cutoff projection and exact account-level reversal proof make both authority boundaries deterministic and auditable.

**Alternatives:** Trusting checkpoint subsets leaves omission authority with the caller. Clearing at reversal-transaction time contradicts the explicit resolution lifecycle. Requiring a single-entry reversal would reject valid multi-entry adjustments; counting entries from other accounts would falsely prove correction.

**Consequences:** Canonical evidence overrides optimistic checkpoint completeness. Original reconciliation adjustments are validated even after resolution, prior cutoffs retain the blocker, and resolved adjustment records remain immutable audit history while leaving active metric projections. Ambiguities remain active because Stage 2 has no ambiguity-resolution lifecycle; reclassification records provenance without adding classification history.

## ADR-025 — Relational Identity with Append-Only Revisions

**Status:** Accepted — 2026-09-15

**Decision:** Store stable transaction and flow identities separately from append-only transaction, entry, and classification revisions. Current projections select one active revision. Composite owner-scoped foreign keys protect every cross-entity reference.

**Reasoning:** Corrections must preserve the previously asserted fact and cannot rely on globally unique IDs alone to enforce ownership.

**Consequences:** Repository writes append revisions and switch the current marker transactionally. Canonical financial facts remain relational; JSONB is limited to validated source projections, bounded planning metadata, and derived snapshots.

## ADR-026 — Command and Job Atomicity

**Status:** Accepted — 2026-09-15

**Decision:** A financial command, audit record, monotonic owner input-version increment, recalculation record, and pg-boss send commit in one PostgreSQL transaction. Idempotency is unique by owner, command kind, and key; normalized SHA-256 request hashes distinguish replay from conflict.

**Reasoning:** An application/database dual write can permanently lose recalculation or apply a mutation twice after an uncertain response.

**Consequences:** Jobs contain IDs and provenance only. Transient failures retry three times with five-second exponential backoff; permanent canonical failures go directly to explicit dead-letter queues.

## ADR-027 — Versioned Snapshot Supersession

**Status:** Accepted — 2026-09-15

**Decision:** Each successful run atomically inserts a normalized full result and queryable metric projections. It marks prior authoritative projections non-authoritative and links them to replacements with `superseded_by`. One owner advisory lock and run-envelope identity prevent competing authoritative runs.

**Reasoning:** Overwriting derived values destroys auditability while retaining multiple unlabelled current rows makes reads ambiguous.

**Consequences:** Snapshots are caches and never become source facts. The first sanitized synthetic import keeps its Stage 4 fixture watermark at durable input version 1 for byte-equivalent golden verification; later mutations use `owner:<uuid>:v<version>`.

## ADR-028 — Development-Only Insecure Cookie Exception

**Status:** Accepted — 2026-09-15

**Decision:** Session cookies are secure by default. `SESSION_COOKIE_SECURE=false` is accepted only when `NODE_ENV=development` and `APP_ORIGIN` is loopback HTTP; other insecure combinations fail startup.

**Reasoning:** Local Compose deliberately serves HTTP on loopback, where a Secure cookie cannot complete authentication. Broad insecure configuration would weaken production silently.

**Consequences:** Production must terminate HTTPS and retain Secure, HttpOnly, SameSite=Lax cookies. Application login throttling ships now; Caddy edge throttling remains deployment configuration because the stock image has no rate-limit module.

## ADR-029 — Recalculation Publication Consistency

**Status:** Accepted — 2026-09-16

**Decision:** A queued recalculation may publish authoritative derived state only when its input version equals the owner's current input version both during repeatable-read assembly and inside the publication transaction. Financial mutations and publication share one owner advisory lock. A mismatch marks the recalculation `superseded`; it creates no engine run, receives no retry, and changes no authoritative snapshot.

**Reasoning:** A preflight check alone cannot prevent a command from committing while a calculation is running. Without the transactional publication guard, an older result can overwrite newer authoritative state or label newer facts with an older version.

**Alternatives:** Reconstructing historical database state for every obsolete job adds event-sourcing complexity rejected for V1. Ordering jobs in one worker does not protect multiple processes or delayed retries.

**Consequences:** Job `asOf` and Europe/Riga effective date own the run boundary. Initial synthetic version 1 may retain its fixture watermark; all later runs use the durable owner/version watermark. Recalculation records expose obsolete work explicitly while current authority remains monotonic.

## ADR-030 — Durable Telegram Long-Poll Inbox and Offset

**Status:** Accepted — 2026-09-16

**Decision:** Persist every normalized `getUpdates` page and its monotonic next offset in one PostgreSQL transaction. Drain locally pending updates before polling. Telegram acknowledgement occurs only by the later poll with that persisted higher offset.

**Reasoning:** Advancing an in-memory offset before the financial command commits can lose an update across a crash. Processing before any offset advance can needlessly retain provider backlog and does not provide stronger command atomicity.

**Consequences:** Update and message identities are durably deduplicated. Five-minute leases recover crashed processors. Explicitly observed unexpected processing failures retain bounded text and retry after one and two seconds, with three total attempts; exhaustion is terminal. Owner advisory locking and stable command idempotency provide exactly-once financial effects across retries and concurrent workers. Telegram reply delivery uses a separate state machine and remains at-most-controlled rather than claimed exactly once.

## ADR-031 — Bounded Telegram Clarification and Text Retention

**Status:** Accepted — 2026-09-16

**Decision:** Retain normalized authorized text only while an update is pending, for at most 24 hours. Keep one structured clarification per owner/source/chat for 15 minutes and no more than two invalid replies. Clear text or structured payloads on every terminal state while retaining identifiers, hashes, outcomes, safe failures, and correction links.

**Reasoning:** Crash recovery needs a durable input, but indefinite conversational storage is unnecessary for the bounded command surface and increases exposure of personal financial descriptions.

**Consequences:** `/debug` and logs expose operational categories rather than message contents or Telegram identifiers. A complete independent command supersedes an active clarification. Corrections use the recorded successful bot-message identity for 30 days and preserve compensating financial history.

## ADR-032 — Provider-Neutral Portfolio Valuation and Contribution Contract

**Status:** Accepted — 2026-09-17

**Decision:** Normalize every portfolio source through the provider-neutral contract in `PORTFOLIO_CONTRACT.md`. `totalMarketValue` is the exact total economic investment-account value, while a three-state cash treatment records whether provider cash was included, excluded and exactly added/split, or unavailable. One explicit Net Worth projection prevents duplicate cash. Holdings, provider contributed-capital totals, and provider P/L remain detail/reconciliation evidence. Raw provider contribution events are never authoritative principal; only deterministic confirmed transfer matching with exact money and the correct portfolio account creates contribution principal. Withdrawals are explicit. Source and receipt times, freshness, opaque cursor commit, stable source/revision identity, exact FX provenance, bounded raw receipt, and disconnect-without-purge semantics are mandatory.

**Reasoning:** Provider fields alone do not establish accounting meaning. Separating valuation wealth, principal flows, market residual, and cash projection preserves the existing Net Worth/CCR invariants and makes replay, correction, stale-data gating, and provider replacement deterministic.

**Alternatives:** Mirroring a provider DTO would leak unstable semantics into the application. Summing every available value double-counts cash and holdings. Trusting provider P/L or aggregate contributed capital can mix flows with performance. Selecting an undocumented provider contract would only hide the prerequisite.

**Consequences:** Stage 7 adapters must prove their real API can supply or explicitly lack each capability and pass the synthetic contract fixtures before live ingestion. One confirmed contribution key converges bank and portfolio observations on one economic principal flow. Material holdings/component mismatch suppresses invest-more without replacing the provider total; exact, within-rounding, or unavailable holdings reconciliation does not independently override an otherwise authoritative total. Raw portfolio payload ciphertext expires after 30 days while canonical facts and safe receipt/revision audit remain. Missing valuation, material ambiguity, stale data, or missing FX suppress invest-more recommendations. ADR-033 resolves the first concrete provider binding; no financial-engine formula changes result from this decision.

## ADR-033 — Sharesight Reference Portfolio Provider Binding

**Status:** Accepted — 2026-09-22

**Decision:** Bind the initial single-owner Stage 7 reference/validation read path to Sharesight User API V2/V2.1. Use the portfolio ID as provider account identity, the valuation report total as the authoritative provider value with cash already included, stable resource IDs plus deterministic SHA-256 fingerprints for revisions, and exact lexical JSON-number decoding. Sharesight cash-account `DEPOSIT` and `WITHDRAWAL` records may become `ContributionEvidence` only; the existing deterministic canonical-transfer match remains the sole constructor of contribution principal. Sharesight exposes no provider cursor, revision number, exact valuation timestamp, webhook, granular OAuth scopes, or Lightyear import-freshness marker, so these capabilities remain unavailable, derived, or ambiguous as recorded in `PORTFOLIO_PROVIDER_SHARESIGHT.md`.

**Reasoning:** Sharesight has an official read API, OAuth 2.0 personal-account access, documented sandbox provisioning, valuation/holding/cash/transaction/report endpoints, and official Lightyear trade-file support. Lightyear itself documents statements and exports but no public portfolio API. Plaid Investments is limited to supported US/Canadian institutions, and SnapTrade does not list Lightyear among its supported brokerages. Sharesight therefore preserves the accepted Lightyear product context without selecting an unrelated broker or inventing an undocumented interface.

**Alternatives:** A direct Lightyear adapter was rejected because no official API/authentication/endpoint contract is published. Plaid Investments was rejected for geographic/institution mismatch. SnapTrade was rejected because its documented brokerage list does not include Lightyear. Sharesight V3 was rejected because Sharesight labels it closed beta and subject to shape changes without notice.

**Consequences:** The Sharesight adapter may use OAuth 2.0 client credentials for the linked personal account and polling over deterministic application-owned date windows. Manual Lightyear CSV upkeep remains an operator responsibility; without independent freshness confirmation, snapshots are partial and cannot authorize invest-more. Provider totals may still be displayed, holdings remain reconciliation evidence, non-EUR authoritative facts remain quarantined pending the FX decision, and no trading or provider write is authorized. ADR-035 later selects Portfolio Manager for the production path without deleting or reinterpreting this independent reference adapter.

## ADR-034 — Durable Manual Sharesight Reference Validation Sync

**Status:** Accepted — 2026-09-22

**Decision:** Stage 7.1 uses a server-only OAuth client-credentials adapter and an explicitly invoked manual sync. Every provider response is encrypted with AES-256-GCM and committed before decoding. A lease-backed run records deterministic full-history monthly continuation, while stable source IDs and SHA-256 fingerprints distinguish new, replayed, and revised evidence. Raw ciphertext expires after 30 days. Credentials and access tokens remain environment/in-memory only. Stage 7.1 persists operational evidence but does not write canonical portfolio valuations, confirmed principal, input versions, or recalculation jobs.

**Reasoning:** Sharesight exposes no provider cursor, correction feed, deletion tombstone, or Lightyear-import freshness marker. Full rescans are the only deterministic way to observe historical revisions, and a durable pre-normalization receipt is required for crash auditability. Canonical activation before live response validation would bypass completeness/readiness information that the existing canonical valuation table cannot yet represent.

**Alternatives:** An in-memory-only adapter cannot prove replay behavior across restarts. Incremental-only polling misses historical corrections. Treating a fresh Sharesight response as proof of a fresh manual Lightyear import would invent authority. Writing directly into existing canonical tables would make partial evidence economically active before the required readiness projection exists.

**Consequences:** Stage 7 becomes `READY_FOR_LIVE_PROVIDER_VALIDATION`. Operators run `pnpm sharesight:sync`; no cron, queue, webhook, or worker lifecycle hook is added. Every run rescans portfolio inception through the valuation date. Missing records never delete history. All Stage 7.1 snapshots remain `source_incomplete` until a later auditable freshness workflow, and provider contribution evidence still requires deterministic bank-transfer confirmation before principal exists.

**Live validation clarification — 2026-09-23:** The provisioned sandbox exposed the accepted V2/V2.1 endpoints as well as V3 portfolio discovery, so the stable binding remains V2/V2.1. Live V2 performance responses place the report directly at the response root. Some unconfirmed trades and payouts expose no stable provider ID; those observations remain encrypted receipt evidence and are quarantined rather than assigned application-invented source identities. Repeated eligible-portfolio syncs proved replay stability and zero canonical activation. The sandbox did not contain cash contributions, withdrawals, VGLA, cash components, or a naturally revised record, so the stage advances only to `READY_WITH_DOCUMENTED_PROVIDER_LIMITATIONS`.

## ADR-035 — Portfolio Manager Production Provider and Durable Manual Sync

**Status:** Accepted — 2026-09-23

**Decision:** Select self-hosted Portfolio Manager as the production Stage 7 provider, pinned to upstream commit `af86470e3b3a803f7a75f496c24c580f67a5a8a0` and contract `portfolio-manager-personal-cfo-v1`. Use only its capabilities, snapshot, and cursor-paged capital-flow `GET` routes. Preserve provider decimals lexically, verify capital-flow SHA-256 fingerprints, select current revisions by `(changedAt, revisionId)`, and retain included cash as a component of—not an addition to—the provider total. A partial snapshot keeps a known-valued subtotal but no authoritative total or Net Worth projection. Only active, exactly representable EUR deposits/withdrawals may expose `ContributionEvidence`; no provider path creates confirmed principal.

Every response is AES-256-GCM encrypted and committed before decoding. Receipt finalization, source revision state, and the opaque checkpoint advance atomically. A shared owner/account provider binding, including backfilled Sharesight connections, prevents cross-provider authority. The sync is manual and evidence-only: it writes no canonical valuation, investment contribution, input version, recalculation, recommendation, or financial job.

**Reasoning:** Portfolio Manager supplies the missing deterministic production boundary directly: explicit capabilities, authoritative/partial valuation status, included-cash semantics, stable holding/asset identity, exact decimal strings, opaque continuation, stable event/revision identity, correction lineage, and verifiable content fingerprints. Binding to one reviewed upstream commit avoids inventing semantics or introducing a generic multi-provider framework. Sharesight remains useful as independent validation evidence but its manual Lightyear import freshness and unavailable provider cursor make it unsuitable as the selected production source.

**Alternatives:** Replacing Sharesight history would destroy useful validation evidence and is unnecessary. Treating both providers as authoritative for one investment account would make identity and valuation conflicts ambiguous. Polling Portfolio Manager without durable receipts/checkpoints would lose crash/revision auditability. Rounding sub-cent contribution observations or converting non-EUR flows would cross the unresolved money/FX authority boundary.

**Consequences:** Stage 7 is `READY_FOR_PORTFOLIO_MANAGER_SYNC`. Operators invoke `pnpm portfolio-manager:sync`; normal worker startup is unchanged. The v1 limitations are explicit: no P/L, distributions, fees, historical valuations, FX provenance, MIC/exchange identity, or provider writes. Non-EUR authority remains blocked on the existing FX decision. Canonical activation and scheduling remain later work, and the confirmed-principal-only market-movement interface is unchanged.

## Open Decisions

| Decision | Why it remains open | Owner | Resolve no later than |
| --- | --- | --- | --- |
| Open Banking provider and history depth | Provider coverage, PSD2 access, stable IDs, pending records, consent renewal, and pricing must be verified for Swedbank Latvia. | Product/engineering | Before Stage 8 |
| FX provider and missing-rate policy | Availability, licensing, weekend rates, corrections, and portfolio FX attribution need evaluation. | Product/engineering | Before non-EUR ingestion |
| Imported-data deletion scope | FRD does not say whether deletion is per record, account, connection, or all data; re-import suppression and audit retention depend on it. | Product | Before Stage 8 |
| Numerical policy calibration | Reserve months, materiality, Cash Drag threshold, recommendation increments, and forecast assumptions remain provisional configurable defaults needing synthetic/user validation. Pay-cycle and Step-Up algorithms are accepted. | Product | During Stages 3–5 |
| Liabilities and opening balances | V1 may omit liabilities, but Net Worth start-date and historical reconciliation need a chosen cutover policy. | Product | Before Stage 2 completion |
| AI retention and region | Provider, model, zero-retention availability, data region, and user consent are not selected. | Product/security | Before Stage 11 |
| Backup objectives | Off-host destination, encryption-key custody, retention, RPO, and RTO depend on the target server and operator. | Operator | Before production data |

## Explicitly Rejected for V1

Microservices, Kafka, Redis, Kubernetes, CQRS, event sourcing, separate module databases, automated investing, direct brokerage control, and authoritative AI calculations are rejected unless a later measured requirement supersedes these decisions.
