# Sharesight Portfolio Provider Binding

Sharesight User API V2/V2.1 remains the independent Stage 7 reference/validation provider for the single-owner personal deployment. Stage 7.1 adds its server-only read client and manually invoked durable validation sync. ADR-035 selects self-hosted Portfolio Manager as the production provider; existing Sharesight receipts and revision history remain intact and cannot share authority with Portfolio Manager for the same canonical investment account. This adapter adds no provider writes, background synchronization, or canonical financial activation.

Sharesight is selected because its documented User API can pull portfolio data, its API supports OAuth 2.0 and a sandbox by request, and Sharesight officially supports sanitized Lightyear trade-file imports. The Lightyear connection is a manual CSV import, not a live broker feed. The adapter therefore cannot infer that a fresh Sharesight valuation proves the Lightyear trade history is current.

Official references:

- [Sharesight API overview](https://portfolio.sharesight.com/api)
- [OAuth 2.0 configuration](https://portfolio.sharesight.com/api/2/configuring_oauth)
- [OAuth 2.0 token flow](https://portfolio.sharesight.com/api/2/authentication_flow)
- [User API limits](https://portfolio.sharesight.com/api/2/usage_limits)
- [User API V2 reference](https://portfolio.sharesight.com/api/2/doc/index.html)
- [Lightyear import support](https://www.sharesight.com/eu/partners/lightyear/)
- [Lightyear statements and exports](https://lightyear.com/en-eu/help/trading-and-investments/tax-and-statement)

## Authentication and endpoints

The personal deployment binds to OAuth 2.0 `client_credentials`, which Sharesight documents for an API application linked to its owner's account. Authorization Code is documented but is not selected or implemented. Access tokens last 30 minutes. Sharesight does not publish granular scope names; authorization is bounded by the account-linked API application and scope availability is `UNAVAILABLE`.

| Concern | Binding |
| --- | --- |
| Portfolio identity | `GET /api/v2/portfolios.json` |
| Authoritative valuation and holdings | `GET /api/v2.1/portfolios/:id/valuation.json` |
| Cash accounts | `GET /api/v2/portfolios/:id/cash_accounts.json` |
| Cash-flow evidence | `GET /api/v2/cash_accounts/:id/cash_account_transactions.json` |
| Trade state | `GET /api/v2/portfolios/:id/trades.json` |
| Provider P/L | `GET /api/v2/portfolios/:id/performance.json` |
| Distributions | `GET /api/v2/portfolios/:id/payouts.json` |

The live client keeps tokens only in memory, reuses them with a 60-second expiry margin, and coalesces concurrent token acquisition. The documented limit is 360 requests per minute. Valuation and performance calls use at most three concurrent slots. A `403` with rate-limit evidence is retried with a bounded wait; `401` permits one new client-credentials grant and replay. Deterministic `400`, access-denied `403`, `412`, and `422` responses are not retried. Network, timeout, `408`, `429`, and server failures receive at most three safe-read attempts.

Sharesight documents a sandbox obtainable by request. It does not document a webhook or an incremental transaction cursor, so Stage 7 remains polling-only and `incremental_cursor=false`.

## Capability matrix

`DIRECT` means the provider response contains the value. `DERIVED` means the adapter constructs it using the documented rule below. `UNAVAILABLE` means no documented field exists. `AMBIGUOUS` means the field exists but its economic or lifecycle meaning is insufficient for canonical authority.

| Canonical concern | Provider field or rule | Classification | Authority |
| --- | --- | --- | --- |
| Provider connection | Fixed provider plus configured personal connection ID | DERIVED | Identity only |
| Portfolio account | `portfolio.id` | DIRECT | Stable provider account identity |
| Portfolio currency | `portfolio.currency_code` | DIRECT | EUR only until FX binding |
| Portfolio timezone | `portfolio.tz_name` | DIRECT | Must resolve through the explicit adapter map |
| Authoritative total | `portfolio_valuation.value` | DIRECT | Portfolio total, including reported cash |
| Brokerage cash | `portfolio_valuation_cash_accounts[].value` | DIRECT | Component already included in total |
| Holdings | `portfolio_valuation_holdings[]` | DIRECT | Reconciliation detail only |
| Holding values | `portfolio_valuation_holdings[].value` | DIRECT | Reconciliation detail only |
| Holdings completeness | holding-limit headers plus returned list | DERIVED | Partial/unavailable does not replace total |
| Exact valuation instant | No documented timestamp | UNAVAILABLE | Never invented |
| Conservative `sourceAsOf` | `balance_date` at local start of day | DERIVED | Freshness boundary, not provider event time |
| Receipt and stale times | Local receipt plus effective settings | DERIVED | Application metadata |
| Contributed-capital aggregate | No documented exact field | UNAVAILABLE | `null` |
| Cash contribution evidence | transaction ID/date/amount/type/reference | DIRECT | Evidence only |
| Cash withdrawal evidence | transaction ID/date/amount/type/reference | DIRECT | Evidence only |
| Confirmed principal | Provider cannot prove the bank-side transfer | UNAVAILABLE | Created only by canonical matching |
| Provider P/L | performance gain fields and period | DIRECT | Permanently reconciliation-only |
| Distribution | payout fields | DIRECT | Destination/treatment is AMBIGUOUS |
| Fee amount | trade `brokerage` and cash transaction type | DIRECT | Reflected/external treatment is AMBIGUOUS |
| Provider FX provenance | exchange-rate/currency-gain fields lack a versioned source | AMBIGUOUS | Non-EUR authoritative facts quarantined |
| Provider revision | No revision number or `updated_at` | UNAVAILABLE | SHA-256 fingerprint is DERIVED |
| Provider cursor/pagination | No documented cursor or page token | UNAVAILABLE | Application windows are DERIVED |
| Pending/booked contribution state | Cash transactions expose no settlement lifecycle | AMBIGUOUS | Never used as principal proof |
| Trade state | `confirmed`, `unconfirmed`, `rejected` | DIRECT | Trade reconciliation only |
| Deletion tombstone | Deleted records have no documented tombstone | AMBIGUOUS | Absence never deletes a canonical fact |
| Lightyear import freshness | Manual file import has no API freshness marker | AMBIGUOUS | `source_incomplete` until independently confirmed |
| Historical valuations | valuation `balance_date` parameter | DIRECT | Date-level history |
| Webhook | No documented User API webhook | UNAVAILABLE | Polling only |

## Identity, revision, and continuation

- The canonical provider portfolio ID is the decimal string form of `portfolio.id`.
- Cash evidence source identity is `portfolio ID / cash-account ID / cash-account-transaction ID`. Trade and payout sources use their stable provider ID under the validated portfolio.
- Every nested resource must resolve to the configured portfolio. A cash-account or response-link mismatch is quarantined; a valuation portfolio mismatch is a contract failure.
- Provider numeric JSON tokens are captured from their original source lexeme and converted directly to decimal strings or `bigint` minor units. Exponents, excess money precision, overflow, and invalid currencies are rejected without JavaScript financial arithmetic.
- A stable source ID plus the versioned SHA-256 fingerprint of canonically ordered economic fields is the revision identity. Exact replays retain the fingerprint; corrected fields produce a new fingerprint under the same source ID.
- Missing IDs do not become deletion facts because Sharesight supplies no deletion tombstone.
- Sharesight has date filters but no documented provider pagination. Initial/full reconciliation uses deterministic calendar-month application windows encoded as a composite cursor. The cursor is explicitly `sharesight-application-window`, is not sent as provider state, and does not make `incremental_cursor` true.
- Every manual Stage 7.1 run rescans inception through the current valuation date. Exact source/fingerprint equality is replay; a new fingerprint under the same source is a revision. Missing records never become deletion evidence.

The confirmed contribution key remains provider-neutral. It is derived from owner, canonical bank transfer, canonical investment account, and direction. It never uses the Sharesight transaction ID as economic authority, allowing bank and portfolio observations to converge on one principal flow.

## Normalization and readiness policy

The valuation total is normalized as `cash.treatment= included_in_total`. Cash accounts are retained only as components; Net Worth receives one aggregate investment-account projection. Holdings and cash components may be reconciled with the total but never replace it.

Only the exact cash transaction types `DEPOSIT` and `WITHDRAWAL` can produce `ContributionEvidence`. Direction comes from the explicit type. A deposit must be positive and a withdrawal negative; contradictory signs are quarantined. Other free-form transaction types are ignored for principal. The normalized amount is always a positive magnitude with an explicit direction.

Provider evidence never creates `ConfirmedContributionPrincipal`. Exact money, the correct portfolio account, a canonical transfer ID, and one canonical contribution key remain mandatory through the Stage 7.0.1 constructor.

An EUR total can remain displayable when holdings are partial. A material comparison of complete components emits `valuation_components_mismatch` and suppresses invest-more. Missing holdings detail alone does not suppress an otherwise complete source. Manual Lightyear import freshness is never promoted by Stage 7.1: snapshots have `sourceCompleteness=partial`, emit `source_incomplete`, use receipt time as the conservative provisional stale boundary, and cannot authorize invest-more.

Run the validation sync with `pnpm sharesight:sync`. Client credentials, the target portfolio, explicit owner/account IDs, and the 32-byte base64 receipt-encryption key come from server environment variables. Raw response ciphertext uses AES-256-GCM and expires after 30 days; hashes and revision metadata remain. No token or credential is persisted or logged.

V3 is excluded because Sharesight documents it as closed beta with shapes that may change without notice. Live sandbox/production credentials are not required by CI. Canonical valuation activation, automatic transfer matching, provider writes, Open Banking, trading, scheduling, and Stage 8 remain outside Stage 7.1.

## Observed live Sharesight behavior

The Stage 7.1.1 sandbox validation on 2026-09-23 used local-only credentials and retained no token or plaintext response outside the encrypted receipt boundary. The classifications below distinguish observed facts from the existing documented contract.

| Behavior | Classification | Validation result |
| --- | --- | --- |
| OAuth client credentials | OBSERVED | The sandbox token endpoint returned a bearer token with a 1,800-second lifetime. |
| API versions | OBSERVED | The same authorization exposed both V2 and V3 portfolio discovery. V3 remains excluded because availability does not make its closed-beta shapes stable. |
| API origin | OBSERVED | The provisioned sandbox application used the HTTPS origin supplied in its OAuth metadata rather than the production default. |
| V2/V2.1 reads | OBSERVED | Portfolio discovery, valuation, holdings, cash accounts, trades, payouts, and performance returned successful read-only responses. |
| Performance shape | OBSERVED | The V2 performance report was returned directly at the JSON root, without a `portfolio_performance` wrapper. The decoder accepts both documented fixture and observed forms. |
| Trade identity | OBSERVED | Confirmed trades had stable IDs. Some unconfirmed trades had both `id` and `unique_identifier` null and a null brokerage currency; these records are retained in the encrypted receipt and quarantined rather than assigned a derived identity. |
| Payout identity | OBSERVED | Observed unconfirmed payouts had null IDs. They are retained in the encrypted receipt and quarantined; no source revision is invented. |
| Exact numbers | OBSERVED | Holdings and reports used ordinary integer and decimal JSON tokens, including multiple fractional scales. Exact lexical decoding remained valid without financial floating-point arithmetic. |
| Replay identity | OBSERVED | Repeated unchanged syncs produced replay dispositions and no new source revision. Stable valuation and holding IDs were also observed across repeated reads. |
| Portfolio currencies | OBSERVED | Exactly one discovered portfolio was EUR and therefore eligible for the current binding. A non-EUR portfolio was useful for DTO validation but remains outside canonical activation. |
| Holdings and cash reconciliation | AMBIGUOUS | The eligible EUR portfolio contained no holdings or cash accounts. A non-EUR portfolio exposed holdings but no cash component, so live validation did not independently prove the included-in-total cash assumption or material-mismatch behavior. |
| Contributions and withdrawals | UNAVAILABLE | No sandbox cash-account `DEPOSIT` or `WITHDRAWAL` record was present. Contribution normalization remains fixture- and contract-tested but is `NOT_OBSERVED_LIVE`. |
| Provider correction/revision | UNAVAILABLE | No naturally revised source record was present. Revision replacement remains deterministically tested but is `NOT_OBSERVED_LIVE`. |
| VGLA | UNAVAILABLE | No holding with symbol VGLA was present in either accessible portfolio: `VGLA_NOT_PRESENT`. No listing equivalence was inferred. |
| Lightyear import freshness | AMBIGUOUS | No response added an independent brokerage-import freshness signal. `sourceCompleteness=partial`, `source_incomplete`, and recommendation suppression remain unchanged. |

The resulting readiness is `READY_WITH_DOCUMENTED_PROVIDER_LIMITATIONS`. It authorizes further read-only sync work, not canonical activation or invest-more recommendations. Live contribution identity, included-cash reconciliation, VGLA listing identity, and natural revision behavior still require representative provider data.
