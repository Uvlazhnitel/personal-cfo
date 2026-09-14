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

### Identity Algorithm

Deduplication is layered:

1. A stable provider ID is unique within `(connection_id, provider_account_id, object_kind)`.
2. A provider revision updates the raw history but does not create another canonical booked event.
3. If pending and booked IDs differ, create a candidate fingerprint from account, currency, absolute amount, normalized counterparty, and a bounded date window.
4. Match automatically only when there is exactly one compatible candidate and provider evidence does not conflict.
5. Store the link and audit evidence. Ambiguous candidates enter review and remain separate.

Payload hashes detect exact replay but are not sufficient identity because providers may reorder or enrich fields. Deleting and reconnecting a source must not bypass deduplication without an explicit import-reset operation.

Pending entries do not enter historical income, spending, CCR, or Net Worth snapshots. Pending debits reduce projected operational cash; pending credits do not increase Safe to Invest. When booked, a matched pending transaction is superseded. Reversed records remain auditable and their booked financial effect is neutralized by a linked reversal.

## Explicit Financial Treatments

### Internal Transfers and ATM Withdrawals

A transfer is one `FinancialTransaction` with linked source and destination entries. A €100 ATM withdrawal creates `Bank -10000 EUR` and `Cash +10000 EUR`; it changes neither Net Worth nor spending. Any ATM fee is a separate consumption entry. Later cash spending is an external-flow transaction against the Cash Account.

### Investment Contributions and Returns

`InvestmentContribution` links a confirmed bank-to-brokerage transfer to principal amount and date. It is an allocation of existing capital, not consumption and not market return. `PortfolioSnapshot` stores total portfolio market value, contributed-capital total when supplied, cash component, holdings summary reference, source time, and completeness.

Investment return for a period is derived from portfolio value changes adjusted for contributions, withdrawals, and FX. Provider-reported P/L is retained for reconciliation but does not override the engine without a documented semantic match. Brokerage cash is included either in the portfolio total or as a separate account balance, never both.

### Refunds and Reimbursements

`TransactionRelation` links a refund, reimbursement, reversal, fee, or correction to the original event. Linked refunds and reimbursements reduce consumption in the original category on their own booking date; they are not recognized income. An unlinked credit remains `unresolved_credit` and cannot improve CCR or Safe to Invest until classified. Refunds greater than the original amount require review.

### Cash Activity

Telegram or PWA cash commands create canonical transactions with a client idempotency key and a Cash Account entry. The original message may be retained only under the configured privacy policy. Cash corrections are compensating records or explicit edits with audit history; deleting the source message never silently deletes the financial fact.

`CashReconciliation` records Cash Account ID, calculated balance, physically counted balance, signed variance, reconciliation instant, actor, optional reason, materiality result, and the linked adjustment transaction. It never overwrites prior entries. The adjustment uses type `cash_reconciliation_adjustment`; it changes the account balance and Net Worth but is not ordinary consumption or recognized income.

`CashReconciliationResolution` is immutable evidence that an unexplained variance ceased to be active. It records the reconciliation ID, resolution instant, and booked resolution transaction ID. Historical evaluations before that instant retain the ambiguity; later evaluations exclude it from the investability blocker while preserving both audit records.

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

Disconnecting revokes tokens and stops synchronization. Purging imported data must remove raw payloads, canonical provider-derived records, snapshots, and AI text derived solely from that connection, then recalculate remaining history. Minimal non-sensitive security audit records may remain. Whether V1 supports individual imported-record deletion or only disconnect-and-purge is an open product decision; implementation must settle re-import suppression and cascading semantics before the Open Banking milestone.
