# Portfolio Manager Provider Binding

Stage 7.2B selects the self-hosted Portfolio Manager integration contract as the production portfolio-data provider. The binding is fixed to upstream commit `af86470e3b3a803f7a75f496c24c580f67a5a8a0` and contract version `portfolio-manager-personal-cfo-v1`. Sharesight remains supported as a separate reference and validation adapter; it is not combined with Portfolio Manager for one canonical investment account.

The implementation is server-only, read-only, manually invoked, and evidence-only. It adds no provider mutation, schedule, canonical valuation activation, confirmed contribution principal, P/L authority, Open Banking, AI, trading, or Stage 8 behavior.

## Configuration and invocation

`pnpm portfolio-manager:sync` requires all of:

- `DATABASE_URL`
- `PORTFOLIO_MANAGER_BASE_URL`
- `PORTFOLIO_MANAGER_API_TOKEN`
- `PORTFOLIO_MANAGER_OWNER_ID`
- `PORTFOLIO_MANAGER_INVESTMENT_ACCOUNT_ID`
- `PORTFOLIO_MANAGER_RAW_RECEIPT_KEY`, exactly 32 base64-decoded bytes

Partial configuration fails closed. The base URL must use HTTPS except for a loopback test service. The non-secret connection identity is SHA-256-derived from the normalized base URL; it never contains or depends on the bearer token. Tokens, authorization headers, provider names, amounts, and raw bodies are not logged.

The configured account must belong to the configured owner and be an active, included, EUR, portfolio-valued investment account. One owner/account may select exactly one provider connection. Migration `0009` backfills existing Sharesight bindings into the shared exclusivity table without moving or reinterpreting Sharesight receipts.

## Bound HTTP contract

Only three `GET` endpoints are authorized:

| Endpoint | Purpose |
| --- | --- |
| `/api/integrations/personal-cfo/v1/capabilities` | Contract negotiation and instance/portfolio identity |
| `/api/integrations/personal-cfo/v1/snapshot` | Current valuation, included cash, and holding reconciliation evidence |
| `/api/integrations/personal-cfo/v1/capital-flows?limit=500&cursor=...` | Incremental contribution/withdrawal observations and correction lineage |

Authentication is a bearer token. The native-fetch client has an injected clock, sleeper, transport, and abort signal, a ten-second request timeout, and three total attempts. Network failures, timeouts, `408`, `429`, and `5xx` use 250 ms then one-second backoff; `Retry-After` is bounded. `400`, `401`, `403`, `404`, incompatible contract/capability responses, and malformed data are terminal typed failures.

Every successful body is AES-256-GCM encrypted and committed before decoding. Ciphertext has a 30-day expiry; its hash and safe operational metadata remain. Pending encrypted receipts are drained before new requests. The opaque provider cursor advances in the same transaction as receipt finalization and source-revision recording. `hasMore=true` requires a present, advancing cursor. A crash resumes from the committed checkpoint, missing observations never imply deletion, and a stale lease is recoverable.

## Capability and authority map

| Portfolio Manager v1 field | Canonical use | Classification |
| --- | --- | --- |
| `providerInstanceId`, `portfolioId` | Bound provider/portfolio identity | DIRECT |
| `valuation.totalValue` on a complete EUR snapshot | Authoritative provider total | DIRECT |
| `valuation.knownValuedSubtotal` | Displayable known subtotal for partial valuation | DIRECT |
| `valuation.status`, missing-price list | Completeness and recommendation gating | DIRECT |
| `valuation.sourceAsOf`, stale flags | Component freshness and stale warning | DIRECT |
| Cash amount with `included_in_total` | Reconciliation component, never added twice | DIRECT |
| Holding ID plus asset ID | Stable listing/position identity | DIRECT |
| Holding quantity, price, value | Exact reconciliation evidence | DIRECT |
| Capital-flow event/revision IDs and fingerprint | Source identity and revision history | DIRECT |
| `ACTIVE` exact-EUR deposit/withdrawal | `ContributionEvidence` only | DERIVED |
| Opaque `nextCursor` | Durable incremental checkpoint | DIRECT |
| Reconciliation/readiness | Application assessment | DERIVED |
| Portfolio P/L, distributions, fees | Not supplied by v1 | UNAVAILABLE |
| Historical valuations | Not supplied by v1 | UNAVAILABLE |
| FX provenance or conversion | Not supplied by v1 | UNAVAILABLE |
| MIC/exchange listing identity | Not supplied by v1 | UNAVAILABLE |
| Provider writes | Not supplied or authorized | UNAVAILABLE |

Exact quantities, prices, values, and amounts remain branded decimal strings through decoding and fingerprint validation. Exponent notation, malformed decimals, overflow, invalid timestamps, identities, enums, cursors, and fingerprints are rejected. EUR valuation values cross the application money boundary through exact string/`bigint` half-even rounding. An active capital flow is eligible for evidence only when its positive EUR amount is exactly representable in minor units; a sub-cent or non-EUR flow is quarantined, not rounded or converted.

## Snapshot semantics

A complete EUR valuation keeps the provider total authoritative and treats cash as `included_in_total`. Holdings are reconciliation evidence, not a second wealth source. Exact or provider-rounding reconciliation is non-blocking. A material complete-component mismatch emits `valuation_components_mismatch`, retains the provider total, and suppresses recommendations.

A partial or unavailable valuation retains `knownValuedSubtotal` and missing-price detail but carries no authoritative total or Net Worth projection. Missing component freshness is valid for unpriced or base-currency holdings. Provider-stale prices emit `stale_valuation`; manual sync otherwise uses receipt time as a conservative stale deadline until canonical freshness settings exist. A non-EUR reporting snapshot is quarantined under the unresolved FX policy.

Holding identity is `(providerHoldingId, assetId)`. Ticker is display metadata only. Equal tickers with different asset IDs, price currencies, or quote sources stay distinct; v1 supplies no MIC/exchange identity.

## Capital-flow authority and revisions

The stable evidence source is `eventId`; the verified upstream SHA-256 fingerprint is its revision. `revisionId`, `replacesRevisionId`, and sorted replacement IDs preserve correction lineage separately. Current source state is selected by `(changedAt, revisionId)`, so late or replayed pages cannot regress a newer replacement or void.

Only `ACTIVE` contributions and withdrawals with exact EUR minor-unit amounts expose `ContributionEvidence`. `REPLACED` and `VOIDED` records update provider evidence state but expose no active evidence. No Portfolio Manager decoder, normalizer, repository, or sync result can construct `ConfirmedContributionPrincipal`; the existing deterministic canonical-transfer confirmation remains the only authority boundary. The sync result therefore fixes `confirmedPrincipalsCreated` to `0`.

## Deliberate limitations

The v1 upstream contract has no P/L, distributions, fees, historical valuations, FX provenance, MIC/exchange identity, or write endpoints. Non-EUR authority remains blocked by the existing FX decision. Stage 7.2B also does not activate canonical portfolio tables or recommendations. Local live validation is optional for deterministic acceptance and is attempted only when the already-running loopback instance exposes these v1 routes and already has safe integration credentials.
