# Canonical Data Model

This model implements the boundaries in [ARCHITECTURE.md](ARCHITECTURE.md) and supplies canonical inputs to [FINANCIAL_ENGINE.md](FINANCIAL_ENGINE.md). Product requirements remain authoritative in [FRD.md](FRD.md).

## Modeling Principles

The canonical model records economic facts independently of Swedbank, Lightyear, Telegram, or any future provider. It is a lightweight personal-finance ledger, not a general accounting system. A `FinancialTransaction` describes an economic event; one or more `AccountEntry` records describe how tracked account balances moved.

All user-owned entities include `owner_id`, even though V1 has one user. IDs are UUIDv7. Instants are UTC `timestamptz`; economic dates are ISO local dates interpreted in `Europe/Riga`. Important records distinguish `occurred_at`, `booked_at`, `source_updated_at`, `created_at`, and `updated_at`.

## Exact Values and Serialization

Money is stored as signed PostgreSQL `BIGINT` minor units plus an ISO-4217 currency code. TypeScript uses `bigint`, never `number`:

```ts
type Money = Readonly<{
    amountMinor: bigint;
    currency: CurrencyCode;
}>;

type MoneyDto = Readonly<{
    amountMinor: string;
    currency: string;
}>;
```

EUR is the reporting currency. Non-EUR facts retain original money and use a versioned `FxRate` containing base currency, quote currency, exact decimal rate, rate date/time, provider, and rounding mode. The canonical quote is reporting-currency major units per one original-currency major unit. Converted amounts store the rate ID and rounding remainder/provenance. Rates, percentages, and forecast factors use PostgreSQL `NUMERIC` and decimal strings in JSON. Monetary rounding is half-even unless a rule explicitly requires upward rounding, as with a Sinking Fund contribution.

## Ownership and Accounts

### User and Session

`User` contains the single account ID, login name, Argon2id password hash, locale, time zone, and lifecycle timestamps. `Session` contains a hashed random token, expiry, last use, and revocation time. Financial data never uses a login name as an identifier.

### Account

`Account` is the common balance-bearing entity. Important fields are ID, owner, name, subtype, currency, institution label, status, inclusion flags, and optional integration account reference. Subtypes include `bank`, `cash`, `investment`, `other_asset`, and `liability`. The virtual Cash Account is a normal account with subtype `cash` and no provider connection.

An account has at most one authoritative balance source at an instant. Bank balances come from the bank connection; manual cash balance comes from canonical entries plus an opening balance; portfolio value comes from portfolio snapshots. An investment contribution entry must not also be treated as portfolio market value.

`AccountBalanceSnapshot` records an account balance, source time, received time, status, and source reference. It supports reconciliation and stale-data reporting; it is not itself a transaction.

## Transaction Ledger

### FinancialTransaction

This record represents one canonical event. Important fields are ID, owner, effective date/time, booking status (`pending`, `booked`, `reversed`), lifecycle status, description, counterparty ID, source kind, source record ID, and current classification version ID. A transaction does not derive meaning from the sign of one provider amount.

### AccountEntry

An entry links a transaction to a tracked account and contains signed original money, optional EUR reporting money and FX rate, entry role, and source timestamps. Positive increases the tracked account balance; negative decreases it. Entry roles include `external_flow`, `transfer_source`, `transfer_destination`, `valuation_adjustment`, and `opening_balance`.

Invariants:

- Entries for one account and provider identity are idempotent.
- A confirmed internal transfer has at least one source and one destination entry and has zero consumption and income classification.
- Same-currency internal transfer entries sum to zero, allowing an explicit fee entry if necessary.
- A plausible unmatched transfer is classified as `unresolved_transfer`, never as authoritative consumption or income, until deterministic evidence or user confirmation resolves it.
- Opening balances establish a measurement boundary and never count as income or capital creation.

### TransactionClassification and Rule

`TransactionClassification` is append-only and contains transaction type, expense category, income source, recurring/irregular flags, confidence, classifier kind, rule/model version, reason, creator, and validity timestamps. The transaction points to the current version. User corrections outrank learned, deterministic, provider, and AI classifications in that order.

`ClassificationRule` records user-approved matching conditions for a normalized merchant/counterparty and its output. Rules are versioned, can be disabled, and never rewrite history silently. Changing a rule creates new classifications and a recalculation request.

`Counterparty` holds a normalized display name and non-sensitive match keys. `IncomeSource` identifies salary, side hustle, or another source and includes stability, expected cadence, and whether it is the primary pay-cycle anchor. `RecurringTransaction` describes a detected or confirmed series, expected amount/range, cadence, next date, category, and confidence.

`PayCycle` is provider-neutral. It links its opening booked primary-salary transaction, opening instant, expected next pay date, optional closing primary-salary transaction/instant, and completeness status. A cycle begins when primary salary is booked and ends immediately before the next booked primary salary. Side-hustle income does not open a cycle. A missing or delayed next salary leaves the cycle open and unavailable for Step-Up observation.

### TransferCandidate

`TransferCandidate` links one or more transactions/entries that might form a bank-to-cash, bank-to-brokerage, or other internal transfer. It stores candidate kind, evidence, confidence, materiality result and threshold version, status (`unresolved`, `confirmed_transfer`, `rejected_transfer`), resolver, resolution time, and audit reason.

While unresolved, its entries remain in account balances but are excluded from authoritative consumption and income. Resolution appends transaction relation/classification versions and requests recalculation; it never overwrites the imported facts.

## Import Identity and Deduplication

### IntegrationConnection and RawImport

`IntegrationConnection` identifies the provider, connection status, capability set, consent expiry, encrypted token envelope, key version, and last successful synchronization. Provider account identifiers are encrypted or keyed hashes when plaintext is unnecessary.

`RawImport` is the immutable receipt of a provider object: connection, object kind, provider object ID when available, payload ciphertext, payload hash, provider revision, source time, received time, and processing status. Raw data is accessible only to ingestion and explicit diagnostics.

`SyncCursor` stores one cursor per connection, account, and object kind. `SyncRun` records its range, cursor before/after, counts, status, and error category. Advance a cursor only in the same database transaction that safely records the imported page.

Portfolio cursors are opaque provider state and may be strings, page tokens, timestamp watermarks, or composite values. Portfolio raw payload ciphertext is bounded to 30 days; receipt metadata, hashes, normalization version, stable source/revision links, and canonical facts follow their ordinary audit retention. Disconnect removes usable credentials and stops synchronization without deleting historical canonical facts. Purge is a separate explicit operation.

### Identity Algorithm

Deduplication is layered:

1. A stable provider ID is unique within `(connection_id, provider_account_id, object_kind)`.
2. A provider revision updates the raw history but does not create another canonical booked event.
3. If pending and booked IDs differ, create a candidate fingerprint from account, currency, absolute amount, normalized counterparty, and a bounded date window.
4. Match automatically only when there is exactly one compatible candidate and provider evidence does not conflict.
5. Store the link and audit evidence. Ambiguous candidates enter review and remain separate.

Payload hashes detect exact replay but are not sufficient identity because providers may reorder or enrich fields. Deleting and reconnecting a source must not bypass deduplication without an explicit import-reset operation.

### Enable Banking / Swedbank observations

Stage 8.0 binds one EUR Swedbank Latvia account through Enable Banking. `BankProviderAccount` uses `(provider, owner, identification_hash)` as its stable identity; the provider account `uid` belongs to one consent session and is stored only as an encrypted alias. `BankBalanceObservation` retains exact amount, ISO balance type, provider cutoff, and last committed entry reference. `ITBD`, then `CLBD` on an equal cutoff, is ledger reconciliation authority; available balances remain liquidity evidence.

`BankTransactionObservation` is provider evidence, not `FinancialTransaction` or `AccountEntry`. Its source is `(account identification_hash, entry_reference)`. Same source and canonical SHA-256 fingerprint is replay; same source and changed fingerprint is a revision. Provider `transaction_id` may change and is never source identity. A missing entry reference is quarantined rather than replaced by an amount/date/description fingerprint.

`PDNG` and `HOLD` observations never enter historical income, consumption, CCR, or Net Worth. Pending debits may reduce projected operational cash; pending credits cannot increase Safe to Invest. The same entry reference changing to `BOOK` is a deterministic revision. A changed or missing identifier may form a seven-day exact-economic candidate but is never auto-confirmed. Disappearance is not deletion.

`BankHistoryCoverage` becomes complete only after every session-scoped continuation page for its closed interval is durably received and normalized. Initial/reconnect scans use the provider's `longest` strategy; later consent sessions establish a new scan rather than reuse an old continuation key. Metrics whose full input period predates the proven cutover are partial or unavailable.

Migration `0010` persists the Stage 8.1 operational boundary. `EnableBankingConnection` owns one consent generation, encrypted session alias, actual expiry, and bounded lease. `EnableBankingAuthorizationAttempt` contains only a single-use SHA-256 state hash and atomic status; the authorization code is never stored. `EnableBankingProviderAccount` keeps the stable account key plus encrypted identification hash, session UID, and display hint; an explicit owner-scoped EUR binding references the canonical bank account. `EnableBankingRun`, `EnableBankingRawReceipt`, and `EnableBankingSourceRevision` preserve scan state, AES-256-GCM ciphertext, replay/revision identity, and safe status. Ciphertext expires after 30 days. These tables are evidence/operations, not canonical ledger authority.

Migration `0011` adds immutable normalized transaction and balance observations, per-session closed history coverage, sync state, canonical import lineage, observation matches, and balance-reconciliation results. The current provider observation is selected by source/revision history; absence never deletes it. Canonical imports reference both the exact provider revision and financial command. A revised booked observation compensates the prior fact and optionally appends a replacement rather than overwriting history. Imported movements remain neutral external-flow projections with `unclassified_external_flow` or `unresolved_transfer` ambiguity until deterministic review resolves them. Explicit owner activation is stored separately from provider/session identity.

Pending entries do not enter historical income, spending, CCR, or Net Worth snapshots. Pending debits reduce projected operational cash; pending credits do not increase Safe to Invest. When booked, a matched pending transaction is superseded. Reversed records remain auditable and their booked financial effect is neutralized by a linked reversal.

## Explicit Financial Treatments

### Internal Transfers and ATM Withdrawals

A transfer is one `FinancialTransaction` with linked source and destination entries. A €100 ATM withdrawal creates `Bank -10000 EUR` and `Cash +10000 EUR`; it changes neither Net Worth nor spending. Any ATM fee is a separate consumption entry. Later cash spending is an external-flow transaction against the Cash Account.

### Investment Contributions and Returns

`ContributionEvidence` is a provider observation of a possible external capital flow; it is not principal and cannot enter market-movement reconciliation. It remains `unmatched`, `candidate`, `confirmed`, or `rejected`. Only a deterministic confirmed link with exact money, the correct portfolio account, one canonical transfer, and one contribution key yields `ConfirmedContributionPrincipal` and the canonical `InvestmentContribution`. The contribution key converges bank and portfolio observations on one economic principal flow. A withdrawal is an explicit direction, never a guessed negative contribution.

`PortfolioSnapshot` identifies the canonical investment account, provider connection/account, stable source/revision, actual provider `sourceAsOf`, separate `receivedAt`, `staleAt`, nullable provider-reported and total economic value, known-valued subtotal, optional contributed-capital aggregate, cash component, holdings detail/completeness, source completeness, and one Net Worth projection. `totalMarketValue` includes known brokerage cash. A partial valuation may retain a known subtotal while its total and projection are unavailable. When cash is provider-excluded, normalization either aggregates it exactly or declares an exact investment-plus-separate-cash projection; when cash treatment is unknown, the total and projection are unavailable rather than zero.

The accepted Sharesight binding uses decimal-string `portfolio.id` as provider account identity. Its valuation total includes separately reported cash, so the normalized cash treatment is `included_in_total` and the cash component is never added to Net Worth again. Sharesight cash-account transaction IDs are observation identities, not economic principal identities. Stable source IDs pair with versioned SHA-256 fingerprints because Sharesight exposes neither a provider revision number nor deletion tombstones. Missing records therefore never delete canonical history.

Sharesight supplies a valuation date rather than an exact valuation instant. The binding derives a conservative local start-of-day `sourceAsOf` from that date and the explicitly mapped portfolio timezone, while retaining `receivedAt` separately. Unknown timezone mappings are quarantined. Manual Lightyear trade-file freshness is not observable through the API; an unconfirmed import state produces partial source completeness even when the Sharesight total itself is available.

Stage 7.1 adds `SharesightSyncState`, `SharesightSyncRun`, `SharesightRawReceipt`, and `SharesightSourceRevision`. They are operational/evidence records, not canonical finance. Sync state fixes one provider portfolio to an explicit owner and EUR investment account and holds a bounded lease. A response is AES-256-GCM receipted before decoding; ciphertext expires after 30 days. Stable source IDs and fingerprints preserve replay/revision history without interpreting absence as deletion. Stage 7.1 writes neither `PortfolioValuation` nor `InvestmentContribution`.

Stage 7.1.1 live validation observed that unconfirmed trades and payouts can omit every stable record ID. These items stay inside their durable encrypted receipt and receive a safe quarantine category. They do not create `SharesightSourceRevision`, and no identity is synthesized from amount, date, security, or other mutable economic fields.

Stage 7.2B adds one `PortfolioProviderBinding` per owner/canonical investment account, backfilled from existing Sharesight state. It enforces cross-provider exclusivity without changing historical Sharesight receipts. `PortfolioManagerSyncState` stores the opaque checkpoint and bounded lease; `PortfolioManagerSyncRun` records safe status/counts; `PortfolioManagerRawReceipt` stores pre-decoding AES-256-GCM ciphertext with 30-day expiry; and `PortfolioManagerSourceRevision` stores stable source/revision identity and replacement/void lineage. Current state is selected deterministically by `(changedAt, revisionId)`. These are operational evidence records and never canonical `PortfolioValuation` or `InvestmentContribution` rows.

For Portfolio Manager, a holding identity combines the provider holding ID with asset ID; ticker is display metadata and cannot merge distinct listings. A capital-flow `eventId` is the stable observation source and its verified SHA-256 fingerprint is the revision. Only an `ACTIVE`, exactly representable EUR deposit/withdrawal can expose `ContributionEvidence`. `REPLACED`, `VOIDED`, sub-cent, unavailable, and non-EUR observations cannot expose active principal evidence, and no provider state constructs `ConfirmedContributionPrincipal`.

Holdings are components and reconciliation evidence, not independent accounts or an alternate wealth source. Investment return for a period is derived from portfolio value changes adjusted for confirmed contributions, explicit withdrawals, and FX. Provider-reported P/L and contributed-capital aggregates are retained for reconciliation but do not override canonical principal or the engine. Brokerage cash enters Net Worth through exactly one declared projection, never both the portfolio total and a separate account.

### Refunds and Reimbursements

`TransactionRelation` links a refund, reimbursement, reversal, fee, or correction to the original event. Linked refunds and reimbursements reduce consumption in the original category on their own booking date; they are not recognized income. An unlinked credit remains `unresolved_credit` and cannot improve CCR or Safe to Invest until classified. Refunds greater than the original amount require review.

### Cash Activity

Telegram or PWA cash commands create canonical transactions with a client idempotency key and a Cash Account entry. The original message may be retained only under the configured privacy policy. Cash corrections are compensating records or explicit edits with audit history; deleting the source message never silently deletes the financial fact.

Stage 6 uses `TelegramOwnerLink` for the configured sender-to-owner mapping, `TelegramPollState` plus `TelegramUpdate` as the durable long-poll inbox, `TelegramPendingClarification` for one bounded structured draft per owner/source/chat, `TelegramDelivery` for post-commit replies, `TelegramMessageLink` for correction targets, and `TelegramIntegrationStatus` for redacted operations. Provider IDs are exact `BIGINT` values. Update identity is `(sourceKey, updateId)` and message identity is unique within source/chat. `TelegramUpdate` distinguishes receipt, leased processing, persisted retry eligibility, clarification, and terminal outcomes; its attempt count and next-processing time bound infrastructure retries independently of reply delivery.

Telegram corrections never edit or delete the prior economic fact. Expense cancellation/correction appends a linked refund and optional replacement consumption. Income cancellation/correction appends a negative earned-income correction and optional replacement positive income. Superseded message links prevent a second correction through the same old confirmation.

`CashReconciliation` records Cash Account ID, calculated balance, physically counted balance, signed variance, reconciliation instant, actor, optional reason, materiality result, and the linked adjustment transaction. It never overwrites prior entries. The adjustment uses type `cash_reconciliation_adjustment`; it changes the account balance and Net Worth but is not ordinary consumption or recognized income.

`CashReconciliationResolution` is immutable evidence that an unexplained variance ceased to be active. It is an explicit union: `reclassified_adjustment` references the original booked adjustment transaction, while `reversed_adjustment` references a distinct booked `valuation_adjustment`. A reversal must occur no earlier than reconciliation and no later than `resolvedAt`; entries on the reconciliation account must sum exactly to the negative variance in the same currency. Other entries may coexist but do not contribute to that proof.

Resolution does not erase or overwrite either record. The reconciliation remains active for every historical cutoff before `resolvedAt`, even when a reversal transaction already exists, and becomes inactive only at or after `resolvedAt`. Duplicate resolutions, malformed original adjustments, unrelated transactions, and wrong-account, currency, or amount reversals are invalid canonical state.

If a forgotten transaction is identified later, either reclassify the adjustment itself with added details or reverse the adjustment before adding the recovered transaction. Both paths preserve the audit trail and ensure the balance changes only once.

## Planning and Reservation Entities

### SinkingFund

`SinkingFund` contains ID, owner, name, target amount, due date, priority, commitment status, lifecycle status, allocation policy, and timestamps. `SinkingFundAllocationPolicy` is `manual` by default or the explicit per-fund value `on_primary_income`. A fund is a plan, not a physical account. `SinkingFundAllocation` records dated positive allocations, spending draws, releases, and corrections. The sum of active allocations is the reserved balance.

Creating or raising a target does not allocate cash. Total active allocations may not exceed eligible liquid cash; an unfunded target is represented as a shortfall, not negative free cash. Spending linked to a fund reduces both cash and its reserved balance. Canceling a fund requires the user to release or reassign its remaining allocation.

`SinkingFundCycleRequirement` records fund ID, Pay Cycle ID, required amount, satisfied amount, outstanding amount, target and allocation inputs, remaining funding opportunities, calculation version, effective time, and optional superseded-by ID. It becomes due when primary salary opens a cycle or immediately when a committed fund is created or changed mid-cycle. Superseded requirements remain auditable.

An opt-in automatic allocation is still an ordinary `SinkingFundAllocation` linked to its requirement and originating command/job. It never moves physical money. Automatic allocation processes funds by due date, explicit priority, then ID, and is limited to unallocated liquid cash above non-Sinking minimum liquidity. Any unfunded remainder stays outstanding.

### FutureObligation

`FutureObligation` represents a dated expected outflow with amount/range, mandatory flag, recurrence link, confidence, source, and optional Sinking Fund. Without an active fund, liquidity counts the uncovered near-term amount not already present in its operational recurring forecast. With an active committed fund, liquidity uses the fund's allocated balance plus current-cycle requirement and does not add the full obligation separately. This coverage link prevents reserve double counting.

### FinancialSettings

Settings are effective-dated and versioned. They include reporting currency, risk profile, reserve months, variability percentile, materiality threshold, Cash Drag persistence, Step-Up window/step, baseline window, forecast rates, inflation, and stale-data limits. A snapshot references one settings version. Changing settings schedules recalculation; it never mutates prior snapshot inputs.

`LiquidityConfiguration` is the effective-dated settings component for essential/normal classification, income stability, minimum and comfort months, operational horizon, obligation horizon, variability percentile, current-cycle funding policy, and Step-Up stress horizon. Keeping it explicit prevents UI defaults from becoming hidden financial rules.

## Derived State and Recommendations

### NetWorthSnapshot and FinancialMetricSnapshot

`NetWorthSnapshot` stores components and total at an `as_of` instant. `FinancialMetricSnapshot` stores metric kind, period, exact value or structured value, status (`complete`, `partial`, `unavailable`), explanation components, stale/missing inputs, engine version, settings version, input watermark, created time, and optional superseded-by ID.

Snapshots are derived caches, not primary financial facts. They may be rebuilt from canonical records, valuation snapshots, FX rates, and effective settings. Only one snapshot version is current for a metric/period/engine/settings/input watermark combination.

## Persistence Projection

Stage 5 stores canonical identities separately from append-only revisions. `financial_transactions` owns stable identity; `transaction_versions` and revision-scoped `account_entries` retain corrections. `flow_classifications` likewise appends a new revision and marks the prior projection non-current. Owner ID participates in composite foreign keys, preventing a user-owned child from referencing another owner's account, transaction, flow, fund, reconciliation, or engine run.

Classification revisions store only the economic meaning specific to their kind. Flow ID, transaction ID, effective instant, amount, and currency always come from `economic_flows` and cannot be changed by classification correction.

Account balance snapshots, portfolio valuations, investment contributions and their recurring/ad-hoc attribution, primary-salary triggers, and spending observations use dedicated relational tables. Exact original/reporting amounts, FX availability, source/staleness times, contribution principal, and classification fields are queryable and constrained; generic JSON payloads are not authoritative for these facts.

An owner-scoped monotonic `BIGINT` input version advances in the same transaction as a financial command. Runtime watermarks are `owner:<uuid>:v<version>`. The initial development synthetic import preserves its checked-in fixture watermark at version 1 solely so the Stage 4 serialized golden can be compared byte-for-byte; the database version remains authoritative and every subsequent command uses the owner/version watermark.

Engine results are normalized JSONB caches with sorted keys and decimal-string bigint values. Per-metric rows, Pay Cycles, Net Worth detail, and Sinking requirements remain queryable projections. Recalculation marks prior metric/requirement rows non-authoritative, inserts replacements, and links prior rows through `superseded_by`; canonical facts are never superseded by editing snapshot JSON.

### Recommendation, Outcome, and CFO Insight

`Recommendation` is generated by deterministic rules and contains type, rule version, evidence snapshot IDs, proposed action, exact financial impact, priority, creation/expiry, and status. It never executes an investment. `RecommendationOutcome` records accepted, dismissed, deferred, or completed state plus later measured impact and measurement window.

`CfoInsight` stores explanatory text, linked recommendation/metric IDs, prompt-policy and model identifiers, created time, and validation status. It is explicitly non-authoritative and cannot be used as a calculation input. Numbers in an insight must be traceable to its allowlisted context.

## Recalculation and Audit

`RecalculationRequest` records the earliest affected date, reason, requested engine/settings version, deduplication key, status, and error. Causes include booking, Pay Cycle opening/closure, correction, transfer resolution, cash reconciliation, fund requirement/allocation changes, FX-rate revision, portfolio revision, and settings change. The worker recomputes forward through the current date because rolling windows and fund balances can propagate an older change.

`AuditEvent` records security- and finance-relevant commands using actor, action, entity reference, time, outcome, and redacted metadata. It does not duplicate raw secrets or financial descriptions.

## Source-of-Truth Precedence

| Concern | Authoritative source | Notes |
| --- | --- | --- |
| Bank movement and balance | Booked Open Banking record | Manual correction is separate and audited. |
| Cash movement | Accepted user command | ATM destination is linked to bank movement. |
| Physical cash balance | Latest Cash Reconciliation plus subsequent entries | Variance remains an explicit adjustment. |
| Classification | Latest user override, then active deterministic rule | AI output is only a proposal. |
| Portfolio market value | Latest complete portfolio snapshot | Staleness is explicit. |
| Contribution principal | Confirmed transfer/contribution link | Provider aggregate is reconciliation evidence. |
| Reserved cash | Sinking Fund allocation ledger | Physical account balance is not partitioned. |
| Current-cycle Sinking amount due | Versioned Sinking Fund cycle requirement | It remains distinct from allocated cash. |
| Financial metrics | Versioned deterministic-engine result | Snapshots are rebuildable. |
| Recommendation action | Explicit user outcome | Recommendation text cannot execute an action. |

## Deletion and Retention Boundary

Disconnect and purge are distinct. Disconnect closes the provider session when supported, removes usable local credentials, and stops synchronization while preserving canonical history and non-secret audit provenance.

Bank-data purge is account-scoped in V1. It removes encrypted receipts, sync state, provider observations, imported canonical transactions and entries, classifications, bank-derived transfer/reconciliation links, and derived snapshots/recommendations. It also invalidates contribution confirmations that depended on purged bank evidence without deleting independent portfolio evidence. One input-version increment and recalculation request rebuild remaining history from the earliest removed effective date.

Purge retains only a non-reconstructable audit event containing internal command/connection-generation identity, time, safe counts, and hashes. The retired generation rejects late work. A new explicit consent creates a new generation and may import again. Hiding rows is not purge, and individual-record deletion is not supported in V1.
