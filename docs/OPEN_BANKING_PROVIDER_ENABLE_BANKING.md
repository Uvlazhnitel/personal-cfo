# Enable Banking / Swedbank Latvia Contract

## Status and boundary

Stage 8.0 selected Enable Banking restricted production for one owner-controlled Swedbank Latvia EUR account. Stage 8.1 implements the server-only binding `enable-banking-swedbank-lv-v1`: RS256 application authentication, state-protected redirect/session exchange, explicit EUR account binding, encrypted receipts, and a manual read-only diagnostic scan. Stage 8.2 adds durable manual and disabled-by-default daily synchronization. Canonical booked imports remain fail-closed behind deployment, identity, coverage, and explicit owner-activation gates.

The production assumption is deliberately narrow: one non-commercial user links only their own allowlisted account. Public or multi-user operation requires a new access, licensing, and pricing review.

## Official evidence

- Enable Banking documents Swedbank among the major Latvian ASPSPs, redirect and decoupled authentication, Smart-ID/eParaksts SCA, and a Swedbank sandbox: <https://enablebanking.com/docs/markets/lv/>.
- A production application may be activated in restricted mode by linking the operator's own accounts: <https://enablebanking.com/docs/api/linked-accounts>.
- The API reference defines RS256 application JWT authentication, `/auth`, `/sessions`, accounts, balances, transactions, stable `entry_reference`, session-scoped `continuation_key`, and session deletion: <https://enablebanking.com/docs/api/reference/>.
- Enable Banking documents sandbox/evaluation access, ASPSP-specific consent validity, early `EXPIRED_SESSION`, `longest`/`default` transaction strategies, and the common post-authorization 90-day history restriction: <https://enablebanking.com/docs/faq/>.
- Enable Banking supports signed webhooks, but webhooks are not financial authority in this binding: <https://enablebanking.com/docs/api/webhooks/>.
- Enable Banking states that personal, sandbox, and evaluation usage remains free: <https://enablebanking.com/blog/2026/01/15/enable-banking-changelog-december-2025>.
- Swedbank confirms Latvian PSD2 availability, regulated-TPP requirements for direct access, and a four-per-day limit for unattended PSU access: <https://www.swedbank.com/openbanking/faq.html>.
- Candidate comparisons use the official [GoCardless Bank Account Data documentation](https://docs.gocardless.com/docs/bank-account-data), [Salt Edge AIS documentation](https://docs.saltedge.com/account_information/v5/), [Tink FAQ](https://tink.com/faq/), [Yapily Nordic coverage](https://docs.yapily.com/registration-configurations/countries/nordics) and [pricing](https://www.yapily.com/pricing), plus Token.io's [Swedbank Latvia listing](https://developer.token.io/tpp_notices/content/0_-_data/tb-021721-data.htm) and [production-transition requirements](https://developer.token.io/reseller_rest_api_doc/content/e-rest/dashboard/transition_to_prod.htm).

## Candidate decision

| Candidate | Swedbank Latvia | Personal production feasibility | Regulatory/commercial result | Decision |
| --- | --- | --- | --- | --- |
| Enable Banking | Officially documented | Restricted production for the operator's linked accounts; sandbox available | Provider mediates ASPSP access; unrestricted/public use needs a contract | **Selected** |
| Direct Swedbank PSD2 | Officially documented | Not realistic for this application | The application would need the appropriate FSA-regulated TPP/AISP status | Rejected |
| GoCardless Bank Account Data | Exact current public proof not found | New personal production onboarding/free use not publicly proven | Institution-specific access is exposed through an authenticated directory | `AMBIGUOUS` |
| Salt Edge | Exact current public proof not found | Live onboarding is reviewed commercially | Current personal pricing and Swedbank Latvia coverage are not public | `AMBIGUOUS` |
| Tink | Baltic platform, but exact target terms are sales-mediated | Enterprise onboarding | No personal pay-per-use production path | Rejected |
| Yapily | Swedbank Latvia appears in official Baltic coverage material | Tailored commercial onboarding | Sales-priced business product | Rejected |
| Token.io | Swedbank Latvia appears in official support material | Production transition requires approved company/use case | Commercial agreement required | Rejected |
| TrueLayer | Exact Swedbank Latvia coverage not publicly proven | Production is commercially onboarded | Target feasibility cannot be established | `UNAVAILABLE` |

No paid dependency is silently accepted. The selected path is valid only while Enable Banking continues to permit restricted own-account production use.

### Comparative contract evidence

This matrix classifies only facts provable from public official documentation for the Swedbank Latvia target. Generic European support does not become target-bank support.

| Candidate | Account/balance AIS | Booked/pending detail | Stable/revision identity | Pagination/history | Consent lifecycle | Sandbox | Personal production/cost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Enable Banking | `DIRECT` | `DIRECT` statuses and fields | `DIRECT` when optional `entry_reference` exists; otherwise `AMBIGUOUS` | `DIRECT` session cursor, `AMBIGUOUS` depth | `DIRECT` session/expiry; renewal `DERIVED` | `DIRECT` | `DIRECT` restricted own-account access; personal use documented free |
| Direct Swedbank | `DIRECT` | `DIRECT` PSD2 account information | `AMBIGUOUS` from public material | 90-day production history `DIRECT`; no API pagination | `DIRECT` bank consent | `DIRECT` | `UNAVAILABLE` without regulated TPP/AISP status |
| GoCardless | Generic AIS `DIRECT`; target institution capabilities `AMBIGUOUS` | Generic `DIRECT`; Swedbank Latvia feature flags `AMBIGUOUS` | `AMBIGUOUS` for the target | Generic history/cursor `DIRECT`; target depth `AMBIGUOUS` | Generic `DIRECT` | `DIRECT` | Current new personal production/free access `AMBIGUOUS` |
| Salt Edge | Generic AIS `DIRECT`; exact target coverage `AMBIGUOUS` | Generic `DIRECT`; target semantics `AMBIGUOUS` | `AMBIGUOUS` | Generic pagination `DIRECT`; target depth `AMBIGUOUS` | Generic `DIRECT` | `DIRECT` | Commercial approval and pricing `AMBIGUOUS` |
| Tink | Platform AIS `DIRECT`; exact public target proof `AMBIGUOUS` | Platform capability `DIRECT`; target semantics `AMBIGUOUS` | `AMBIGUOUS` | `AMBIGUOUS` for target | Platform `DIRECT` | `DIRECT` | `UNAVAILABLE` for personal use; enterprise sales onboarding |
| Yapily | Swedbank Latvia coverage `DIRECT` | AIS capability `DIRECT`; target record semantics `AMBIGUOUS` | `AMBIGUOUS` | `AMBIGUOUS` for target | Platform `DIRECT` | `DIRECT` | `UNAVAILABLE` for free personal use; tailored business pricing |
| Token.io | Swedbank Latvia listing `DIRECT` | AIS capability `DIRECT`; target record semantics `AMBIGUOUS` | `AMBIGUOUS` | `AMBIGUOUS` for target | Platform `DIRECT` | `DIRECT` | `UNAVAILABLE` without approved commercial production transition |
| TrueLayer | Target coverage `UNAVAILABLE` | Target semantics `UNAVAILABLE` | `UNAVAILABLE` | `UNAVAILABLE` | Generic platform only | `DIRECT` | Personal Swedbank Latvia production feasibility `UNAVAILABLE` |

## Capability matrix

`DIRECT` means the field is present in the provider contract. `DERIVED` means Personal CFO computes it using a documented rule. `UNAVAILABLE` means the provider contract lacks it. `AMBIGUOUS` means it may be present but cannot safely carry authority in all Swedbank responses.

| Capability | Class | Binding rule |
| --- | --- | --- |
| Account identity | `DIRECT` | `identification_hash` is stable across sessions; `uid` is a session alias. |
| Account currency/list | `DIRECT` | Returned account fields; V1 activates exactly one EUR account. |
| Current booked balance | `DIRECT` | Latest `ITBD`, then `CLBD` on an equal timestamp. |
| Available balance | `DIRECT` | `ITAV`/`CLAV`; liquidity evidence only. |
| Booked/pending transactions | `DIRECT` | `BOOK`, `PDNG`, and `HOLD` are explicit statuses. |
| Stable transaction ID | `AMBIGUOUS` | `entry_reference` is immutable/cross-session when supplied, but optional. |
| Provider transaction ID | `DIRECT` | `transaction_id` is detail-fetch identity only and is documented as unstable. |
| Pending-to-booked relation | `UNAVAILABLE` | Same `entry_reference` proves a revision; changed IDs create only candidates. |
| Dates, direction, amount, currency | `DIRECT` | Exact strings plus `credit_debit_indicator`; no floating-point conversion. |
| Counterparty/remittance/bank code | `DIRECT` | Optional evidence, never sole authority. |
| Original/instructed amount and exchange data | `DIRECT` | Retained as provenance; not an FX valuation source. |
| Corrections | `DERIVED` | Same source with a different canonical fingerprint is a revision. |
| Reversals | `AMBIGUOUS` | Authoritative only when provider status/source supplies a deterministic relation. |
| Removed/deleted records | `UNAVAILABLE` | Absence never deletes or cancels a fact. |
| Pagination | `DIRECT` | Drain `continuation_key`, including empty pages. |
| Incremental cursor | `UNAVAILABLE` | Continuation is valid only in the current session/scan. |
| Historical range | `AMBIGUOUS` | Use `longest`; authority begins at the earliest fully drained returned date. |
| Consent identity/expiry | `DIRECT` | Authorization/session IDs and actual `access.valid_until`. |
| Renewal/reconnection | `DERIVED` | Expiry or `EXPIRED_SESSION` requires user reauthorization. |
| Rate limit | `UNAVAILABLE` | No numeric Enable Banking client limit is published. Honor `429`/`Retry-After`. |
| Polling | `DIRECT` | Account endpoints are read APIs; Stage 8.2 can dispatch at most one singleton sync per connection generation and scheduled day. |
| Webhooks | `DIRECT` | Signed notifications may update session state; never financial facts. |
| Sandbox | `DIRECT` | Swedbank Latvia sandbox is documented. |
| Restricted production | `DIRECT` | Own linked accounts only. |
| Disconnect/revocation | `DIRECT` | Delete the provider session when supported and erase local credentials. |
| Data purge | `DERIVED` | Account-scoped Personal CFO policy below. |
| Provider retention | `AMBIGUOUS` | Do not make deletion guarantees on behalf of the provider. |

## Authentication and consent

The application signs short-lived RS256 JWTs with `kid=application_id`, issuer `enablebanking.com`, audience `api.enablebanking.com`, and no more than the documented 24-hour TTL. The private key is a deployment secret and is never stored in a raw receipt or browser.

`POST /auth` requests personal account-information access for Swedbank Latvia and an expiry no later than the current ASPSP maximum. The redirect callback must present a cryptographically random, single-use, expiring state value. Enable Banking returns the state and authorization code; the server exchanges the code through `POST /sessions`. The provider handles bank-specific OAuth/SCA. Personal CFO does not invent PKCE, refresh tokens, or store bank credentials.

The connection state is `disconnected`, `connecting`, `active`, `reauth_required`, `error`, or `revoked`. Actual `access.valid_until` is stored. `EXPIRED_SESSION`, early expiry, or normal expiry enters `reauth_required` and requires bank-user interaction. Cancelled authorization creates no financial observation.

## Identity, revisions, and pagination

- Connection authority is `(owner, provider, internal connection generation)`.
- Account authority is `(provider, owner, identification_hash)`; `uid` is encrypted session metadata.
- Transaction source is `(account identification_hash, entry_reference)`.
- Same source and fingerprint is replay. Same source and changed fingerprint is a revision.
- The fingerprint uses version, account identity, stable entry reference, status, direction, exact amount/currency, dates, counterparty/account evidence, bank code, reference/remittance, merchant code, and exchange metadata in canonical order.
- Missing `entry_reference` is quarantined. `transaction_id`, amount/date/description, or a payload hash cannot replace stable identity.
- `continuation_key` is committed with each encrypted page and drained even when a page is empty. It is never carried across provider sessions as an incremental watermark.

## History and synchronization policy

Initial authorization and reconnect use `strategy=longest` immediately after authorization. Recurring sync starts a new overlapping scan with `strategy=default`; it never reuses a provider continuation from a previous run. A closed coverage interval is recorded only after every continuation page completes. The returned earliest booked date—not a requested date—sets the cutover.

Swedbank/PSD2 material supports a 90-day normal-history baseline; Enable Banking notes that longer history can be available briefly after authorization but varies by ASPSP and account. Personal CFO therefore never claims twelve months merely because `longest` was requested. Current Pay Cycle, rolling 3/6/12-month metrics, Cash Drag, and CCR are authoritative only when their complete required interval is proven. No CSV bootstrap is part of Stage 8.

The worker may dispatch one singleton job per connection generation and Europe/Riga day. Scheduling defaults off and, when enabled, defaults to `15 3 * * *`. Stored canonical history survives consent renewal, while a new session must re-establish account identity by `identification_hash` and restart with `longest`.

## Pending, booked, and correction policy

Only `BOOK` with a stable source and exact EUR account movement is eligible for a canonical import command. `PDNG` and `HOLD` are observations: pending debits may reduce projected operational cash, and pending credits cannot improve Safe to Invest.

The same stable source moving from pending/hold to booked is a deterministic revision. Different or missing IDs may form only a review candidate when account, direction, exact amount/currency, compatible bank code, compatible normalized counterparty/reference, and a seven-calendar-day window agree. Even a unique candidate is not automatic authority. Disappearance is not booking, cancellation, or deletion.

`CNCL`/`RJCT` or corrected content on the same stable source is retained as a revision. A provider-confirmed reversal creates a compensating canonical correction while retaining the original. A separate opposite movement without an explicit relation is a new observation, not an inferred reversal.

## Transfers and classification candidates

- ATM debit plus cash destination is a bank-to-cash candidate, not consumption; a separately reported fee is consumption.
- Brokerage debit plus portfolio contribution evidence is an investment-transfer candidate. Only the existing exact canonical-transfer match can create `ConfirmedContributionPrincipal`.
- Bank-to-bank movement is a transfer candidate, not consumption.
- A credit with compatible counterparty/reference/bank code and a prior fact may be a refund/reimbursement candidate.
- Other booked external debits are consumption candidates only after the deterministic classification/review path.

The provider adapter does not auto-categorize any of these observations.

## Balance reconciliation and EUR boundary

The latest booked balance is compared with canonical booked account entries through the same provider cutoff. Results are `reconciled`, `provider_stale`, `incomplete_history`, `unresolved_pending`, `material_mismatch`, or `unavailable`. The effective persisted materiality threshold is used; no adjustment is synthesized to force agreement. Material mismatch blocks authority-dependent recommendations.

Only an EUR Swedbank account can be activated in V1. The exact booked EUR account movement is canonical money. Merchant/instructed currency and provider exchange fields remain provenance and never replace that movement. Non-EUR accounts may be discovered but cannot be activated or enter EUR metrics until the general FX provider decision is resolved.

## Security, disconnect, and purge

Every provider response must be AES-256-GCM encrypted and committed before decoding. Receipt metadata includes endpoint, session/scan scope, ciphertext hash, receive time, and safe status; ciphertext expires after 30 days. Tokens, JWTs, private keys, raw payloads, descriptions, account identifiers, and amounts never enter logs.

Disconnect stops claims, closes the provider session when supported, erases usable encrypted session credentials, and preserves canonical financial history.

Purge is account-scoped in V1. It removes encrypted receipts, checkpoints, provider observations, imported canonical bank transactions and entries, classifications, bank-derived transfer/reconciliation links, and dependent snapshots/recommendations. A portfolio observation survives, but a contribution confirmation that depended on purged bank evidence is invalidated. The command increments input version once and requests recalculation from the earliest removed effective date.

Only a non-reconstructable audit event with internal command/generation identity, timestamp, safe counts, and hashes remains. The retired generation rejects stale jobs. A later explicit consent creates a new generation and may import the data again.

## Stage 8.1 secure client and manual evidence scan

The client implements `GET /aspsps`, `POST /auth`, `POST /sessions`, session/account/balance/transaction reads, and explicit session deletion using native `fetch`. Five-minute JWTs have `kid=application_id`, `iss=enablebanking.com`, and `aud=api.enablebanking.com`; the external RSA key and JWT are never persisted. Safe GETs use at most three attempts for timeout/network, `408`, `429`, and `5xx`, with bounded `Retry-After`. Authorization, code exchange, and deletion are never blindly retried after an indeterminate outcome.

The callback accepts only one valid state and exactly one code or cancellation. Only the state hash is stored, and its pending-to-exchanging compare-and-set prevents replay. Provider session/account aliases become usable only after Swedbank Latvia personal-session identity and account-detail identity are validated. Account selection is explicit and restricted to one owner-scoped included EUR `balance_snapshot` bank account.

`pnpm enable-banking:fetch` validates the active session and account, requests `strategy=longest`, and drains every continuation page, including empty pages. Each body is encrypted and committed before decoding. Continuations are encrypted current-session/run checkpoints; source/fingerprint equality is replay and changed fingerprint is revision. Records without `entry_reference` are quarantined, absence never deletes evidence, and `confirmedPrincipalsCreated` is always zero. The command logs only counts, enum/status summaries, and safe categories.

## Stage 8.2 durable synchronization and canonical gate

`pnpm enable-banking:sync` and the scheduled worker share `executeEnableBankingSync()`. They reuse the Stage 8.1 lease, receipt encryption, source revisions, and session-scoped continuation. Every normalized balance/transaction observation is immutable and receipt-linked. Replay changes no financial state; a new fingerprint is a provider revision; absence is never deletion.

Canonical import requires all five facts: the deployment flag, stable account identity across the current binding, booked `entry_reference` replay across completed scans, a closed coverage interval, and authenticated owner activation. Until then, the result is `evidence_only` with explicit unmet reasons. Eligible booked movements enter one financial-command transaction as signed neutral bank entries with an unresolved ambiguity; no income, consumption, transfer, or contribution is invented. A provider correction adds compensation and an optional replacement. Pending/hold records never create entries, and changed-ID pending/booked pairs remain review candidates.

The latest booked `ITBD` (then `CLBD` on a tied timestamp) is reconciled at the same cutoff against canonical booked entries. Stale provider data, incomplete history, unresolved pending evidence, unavailable balance, or material mismatch downgrades liquid-balance completeness and suppresses authority-dependent recommendations. No adjustment is synthesized. Brokerage transfer evidence reaches `ConfirmedContributionPrincipal` only through the pre-existing exact canonical-transfer constructor.

Stage 8.2 is deterministically `READY_FOR_LIVE_BANK_VALIDATION`. Live sandbox/production proof remains required before enabling canonical import. Account-scoped purge and full consent-renewal UX remain later Stage 8 work.

Stage 8.2 adds no payment initiation, another bank/provider, generic banking framework, non-EUR activation, AI categorization, Stage 9 UI, trading, or automatic investment.
