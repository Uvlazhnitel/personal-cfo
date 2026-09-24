# Persistence and Internal Debug Operations

Stages 5–6 implement the durable path from canonical PostgreSQL facts through `evaluateFinancialState()` to versioned snapshots, the authenticated `/debug` page, and Telegram text ingestion. PostgreSQL remains internal to Compose; only Caddy binds `127.0.0.1:8080`.

## Migration Workflow

Migrations in `packages/data/migrations/` are reviewed and sequential: identity/authentication, canonical finance, planning/reconciliation, derived engine state, then the pinned pg-boss schema and queues. Generate schema changes with `pnpm db:generate`, inspect SQL, validate with `pnpm db:check`, and apply once with `pnpm db:migrate`. Web and worker never migrate at startup. Reapplying all committed migrations is safe.

## Canonical Relational Authority

Account balance snapshots, portfolio valuations, investment contributions and attribution, primary-salary triggers, and spending observations have dedicated relational tables. Their owner-scoped foreign keys, exact monetary columns, timestamps, classifications, and status constraints are authoritative. `fact_payloads` cannot contain these fact types and is reserved for non-authoritative bounded metadata.

Migration `0008` implements the Stage 7.1 Sharesight operational boundary. An owner/account/portfolio binding and lease prevent concurrent manual runs; run continuation is application state, never a provider cursor. Every response is stored as AES-256-GCM ciphertext before decoding, then source/revision metadata and continuation commit atomically after normalization. Ciphertext expires after 30 days while safe hashes and revision identity remain. Credentials and tokens are never persisted. This evidence-only stage deliberately does not write canonical valuations, contributions, input versions, or recalculation jobs.

Migration `0009` adds the Portfolio Manager evidence boundary and a shared provider-binding table. Existing Sharesight bindings are backfilled, and `(owner, investment account)` selects exactly one provider connection. Portfolio Manager sync state carries a recoverable lease and opaque provider checkpoint; runs, encrypted receipts, and source revisions are separate append/audit surfaces. Each response is encrypted before decoding. Receipt finalization, replay/revision classification, deterministic current-head selection, and checkpoint advancement commit atomically. Ciphertext expires after 30 days, missing provider rows never imply deletion, and credentials remain environment-only. The shared encryption helper preserves the migration `0008` Sharesight envelope format and exports.

Economic identity is stored in `economic_flows`. Classification revisions contain only classification meaning; loaders combine the immutable base identity with the active classification. A classification correction cannot change transaction identity, effective time, amount, or currency.

## Durable Calculation Flow

Repositories reconstruct domain objects from relational current projections and append-only history. A financial command locks its unique `(owner, kind, Idempotency-Key)`, hashes normalized request content, writes the mutation and audit record, increments the owner input version, and sends a pg-boss job through the same Drizzle transaction. Equal retries replay the stored result; a different payload returns conflict.

Commands derive `earliestAffectedAt` from the mutated canonical fact; HTTP clients never choose this provenance boundary. Classification starts at the flow instant, transfer resolution at the earliest candidate/transaction instant, reconciliation creation at `reconciledAt`, resolution at `resolvedAt`, and Sinking allocation at its effective instant.

The worker assembles one repeatable-read input snapshot for the job's explicit input version, `asOf`, and Europe/Riga effective date. A mismatched queued version becomes `superseded` without evaluation or retry. At publication, the repository takes the same owner advisory lock used by mutations and re-reads `owner_input_versions`. Only an equal version may publish. A command that commits during evaluation therefore prevents the older result from deactivating newer authoritative rows.

Successful runs atomically persist the normalized full result, metric snapshots, Pay Cycles, and fund requirements. Prior derived rows remain queryable but become non-authoritative and link to their replacement. Initial synthetic version 1 alone may retain its checked-in watermark; later runs use `owner:<owner>:v<version>`.

The integration contract verifies queue durability at the application boundary with two completely separate pg-boss consumer instances: a recalculation enqueued and committed through the first instance remains in PostgreSQL after that instance closes, and the second instance processes it through the production recalculation handler. The same contract injects one transient handler failure and observes pg-boss retry the persisted job before exactly one engine run and one authoritative derived-state set are published.

Cash-reconciliation verification follows the complete command-to-publication lifecycle. A signed adjustment changes Net Worth, current liquid cash, and unrounded Safe to Invest by the exact variance while remaining excluded from recognized income, ordinary consumption, and CCR capital creation. Resolution advances the input version and restores later authority without erasing the active-reconciliation meaning at cutoffs before `resolvedAt` or reversing the recorded wealth adjustment.

## Authentication and Commands

Create the local user with `pnpm admin:create-user -- <login>`; the password is read twice without echo. Login names are canonical lowercase. Login rotates active sessions. Browser commands under `/api/v1/commands/<kind>` require the session cookie, exact Origin, matching session-bound CSRF token, and an `Idempotency-Key` header.

Supported command kinds are `classification-correction`, `transfer-resolution`, `sinking-allocation`, `cash-reconciliation`, and `cash-reconciliation-resolution`. Reconciliation resolution is verified as either same-adjustment reclassification or an exact booked reversal on the reconciled account. pg-boss is explicitly started once in both web and worker processes; transactional enqueue fails closed if queue startup or readiness fails. Jobs survive process restart, while command and salary idempotency keys prevent duplicate mutations.

Telegram adds `cash_activity`, `sinking_fund_creation`, and `cash_correction` recalculation causes. A changed Telegram command retains the same atomic mutation/audit/version/recalculation/job contract. A zero-variance cash count returns `mutated: false` and completes without creating any of those economic effects.

## Telegram Persistence

Migration `0006` adds owner links, poll state, durable updates, bounded clarifications, delivery attempts, correction links, and integration status. Migration `0007` adds the explicit processing-retry deadline and state. Telegram numeric identifiers use PostgreSQL `BIGINT`. Update pages and monotonic offsets commit together; a higher offset is never used before the page is durable. Claims use `FOR UPDATE SKIP LOCKED`; five-minute leases recover crashes, while unexpected runtime failures receive at most three total processing attempts with persisted one-second and two-second backoff.

Authorized raw text exists only while an update is received, processing, or retryable and expires after 24 hours. Clarification payloads contain structured known fields only and are cleared at terminal state. Pending reply text is cleared after success, terminal failure, uncertainty, or retention expiry. Processing retry is separate from post-commit delivery retry. The durable audit surface retains identifiers, SHA-256 text hashes, parser outcomes, attempt counts, safe error categories, and entity references, not financial descriptions.

## Development and Recovery

Use `docker compose --profile test up -d postgres-test` for the disposable loopback test database; tests refuse any database not named `personal_cfo_test`. `pnpm synthetic:import` imports only the sanitized Stage 3 fixture and is not part of production runtime behavior.

Before production, configure HTTPS and secure cookies, Caddy edge throttling, external secret injection, encrypted off-host daily backups, retention, monitoring, and a documented restore drill. Backup destination, RPO, and RTO remain open decisions.
