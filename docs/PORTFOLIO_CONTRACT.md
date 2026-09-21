# Provider-Neutral Portfolio Contract

This document is the application-side contract for Stage 7 portfolio ingestion. It resolves accounting and normalization semantics without selecting or implementing a provider. The executable types and validation live in `packages/integrations/src/portfolio` and use domain `Money`, currency, account ID, decimal, completeness, and UTC instant primitives.

Stage 7.0 readiness is `BLOCKED_ON_PROVIDER_BINDING`: the repository names an existing portfolio tracker and Lightyear as product context, but contains no selected provider, verified API documentation, authentication contract, or endpoint mapping. A provider must be selected and proven to satisfy this contract before the live Stage 7 integration starts.

## Terminology and authority

- A **provider-reported market value** is the exact source field before cash normalization.
- `totalMarketValue` is the total economic value of the investment account at `sourceAsOf`, including known brokerage cash. It is `null`, never zero, when cash treatment prevents that total from being known.
- A **Net Worth projection** states how that one economic value enters canonical accounts: once through the investment account, once through a validated investment-plus-separate-cash split, or not at all when unavailable.
- A **holding** is detail and reconciliation evidence. Holdings are not canonical accounts and are never blindly added to the provider total.
- A **contribution** or **withdrawal** is an external principal flow. It is distinct from valuation change, consumption, income, and market movement.
- Provider P/L, contributed-capital aggregates, holdings totals, distributions, and fees are reconciliation evidence unless a separately accepted source mapping establishes canonical semantics.

Canonical normalized facts, not raw payloads, are application inputs. Existing deterministic financial-engine formulas remain authoritative.

## Capabilities

Capability discovery explicitly reports a boolean for every capability; omission and `null` are invalid and cannot be interpreted as unsupported. The bounded set is:

```text
total_market_value             brokerage_cash
holdings                       holding_market_values
contributed_capital_total      contribution_history
provider_profit_loss           currency
fx_information                 valuation_source_timestamp
incremental_cursor             historical_valuations
distributions                  fees
```

A missing capability remains different from a valid empty result. For example, `holdings=false` means unsupported, `holdings=true` with `complete` and an empty list means the portfolio genuinely has no holdings, and `partial` means some detail is present but incomplete.

## Snapshot and valuation semantics

A normalized `PortfolioSnapshot` identifies the owner-scoped canonical investment account, provider connection, provider portfolio account, provider revision, `sourceAsOf`, `receivedAt`, and `staleAt`. It carries exact original/reporting amounts, provider-reported value, total economic value, cash treatment, Net Worth projection, optional provider contributed-capital aggregate, holdings with explicit completeness, and source completeness.

`sourceAsOf` is the provider valuation instant. `receivedAt` is when this application received it. They are never substituted for one another. `staleAt` is derived by the application from effective versioned settings and the applicable market calendar; server-local time is not an input. A revision of the same source fact retains its stable source identity and appends a new revision rather than destructively replacing receipt history.

### Brokerage cash

`PortfolioCash` is an explicit three-state union:

| Treatment | Meaning | Required normalization |
| --- | --- | --- |
| `included_in_total` | Provider value already contains brokerage cash. | `totalMarketValue` equals the provider value. Cash may be shown as a component, but cannot be a second account value. |
| `excluded_from_total` | Provider value excludes a known exact cash amount. | `totalMarketValue` equals provider value plus cash. Projection chooses either the aggregate investment value or the exact securities/cash split, never both. |
| `unavailable` | Provider cash treatment or amount is unknown. | `totalMarketValue` and Net Worth projection are unavailable; affected metrics cannot be authoritative. |

The split projection requires a distinct Cash Account and exact component values. The aggregate projection feeds the economic total to the investment account. Validation rejects an omitted cash component, a split for included cash, mismatched components, or a projection that reuses the investment account as its cash account.

Net Worth consumes only the declared projection. It does not sum provider value, total value, holdings, and cash. Brokerage holdings do not become Safe-to-Invest liquid cash. Portfolio valuation and market movement do not enter recognized income, consumption, or CCR.

## Holdings and component reconciliation

A holding has stable provider holding and security identities, optional bounded name/symbol, exact decimal quantity, optional exact market value, source instant, and revision identity. One investment account can contain many holdings; no canonical account is created per holding.

When complete holding market values are available, their EUR reporting values are compared with the provider-reported total. Included cash is added to the component sum when separately supplied; excluded cash is not, because the provider comparison total also excludes it. The result is one of:

- `exact`;
- `within_provider_rounding`, using a non-negative provider-documented minor-unit tolerance;
- `material_mismatch`;
- `unavailable`, when components, cash semantics, completeness, or FX are insufficient.

This diagnostic can emit `valuation_components_mismatch`; it never replaces the authoritative provider total with a locally summed value. A material mismatch makes recommendation readiness `partial` and suppresses invest-more recommendations. Exact and within-provider-rounding results do not block recommendations. An unavailable comparison also does not block an otherwise complete, fresh authoritative total because holdings remain reconciliation detail.

## Contributions, withdrawals, and matching

`ContributionEvidence` carries the connection and portfolio IDs, optional stable provider event ID, exact positive money, explicit `contribution` or `withdrawal` direction, effective instant, optional provider reference, and revision identity. It is a provider observation only and is never authoritative principal. A sign is not used to guess direction. Dividends, interest, internal cash movements, market gains, and ordinary purchases do not become contribution principal by default.

Matching to a canonical bank/brokerage transfer is deterministic. Evidence records exact amount/currency agreement, non-negative time distance, provider and bank reference agreement when present, portfolio-account agreement, and the canonical transfer identity. States are `unmatched`, `candidate`, `confirmed`, and `rejected`. Unmatched, candidate, and rejected evidence produces no authoritative principal. `confirmed` requires exact money, the correct portfolio account, a canonical transfer ID, and one stable confirmed contribution key.

Only `ConfirmedContributionPrincipal`, produced by the validated evidence-plus-match constructor, may enter contribution/withdrawal reconciliation. Its contribution key identifies one economic principal flow: bank and portfolio observations of the same transfer converge on that key rather than creating provider-specific principal records. Reference and time evidence remain attached for audit but are not mandatory when the required deterministic proof is present.

For complete EUR boundaries, residual market movement is exactly:

```text
closing value - opening value - contributions + withdrawals - FX valuation effect
```

Thus €10,000 → €11,000 with a €1,000 contribution has zero market movement; €10,000 → €10,500 with no flows has €500 market movement; and €10,000 + €1,000 contribution - €200 withdrawal → €11,300 has €500 market movement. Market movement is not income or contribution principal and is not added to CCR.

## P/L, distributions, and fees

Provider P/L is permanently tagged `reconciliation_only` by this contract. Its semantics are `unknown`, `all_time`, `unrealized`, `realized_and_unrealized`, or `period`; it also records period boundaries and whether FX basis is unknown, provider-native, or reporting-currency. Unknown semantics cannot be normalized into authoritative market return. A disagreement is surfaced, not used to rewrite deterministic residual movement.

Distributions distinguish `portfolio_internal_return`, `external_distribution`, and `unknown`. Internal reinvested dividends/interest remain within valuation return. An exact external distribution may participate as a withdrawal only after provider semantics and destination evidence are verified. Unknown detail creates no transaction and never becomes salary or side-hustle income.

Fees distinguish `reflected_in_valuation`, `external_account_fee`, and `unknown`. A valuation-reflected fee is not subtracted again. An external fee needs a separate canonical external flow with source evidence. Unknown fee treatment remains reconciliation-only. No tax behavior is implied.

## Freshness, completeness, and recommendations

Freshness is evaluated against supplied UTC `now` and persisted `staleAt`. The current value may remain displayed as stale-known with `partial` status, matching existing Net Worth policy, but invest-more recommendations are suppressed. A failed sync does not erase the last valid snapshot.

The bounded warnings are `cash_treatment_unknown`, `contributed_capital_unavailable`, `holdings_incomplete`, `provider_pl_semantics_unverified`, `stale_valuation`, `missing_valuation`, `valuation_components_mismatch`, `fx_unavailable`, and `source_incomplete`.

Recommendation gating is mandatory for a missing valuation, unknown cash treatment that risks duplicate value, unavailable required FX, stale valuation, or material `valuation_components_mismatch`. A material holdings mismatch leaves the known provider total in place, marks readiness at least `partial`, and suppresses invest-more. Missing value is `unavailable`, never zero. Holdings or contributed-capital detail may be incomplete without changing a complete current valuation, but dependent reconciliation views disclose the warning. Existing engine completeness and recommendation rules remain authoritative downstream.

## Currency and FX

EUR is the reporting currency. An EUR-native amount has identical original and reporting money. Future non-EUR facts retain original money and exact EUR reporting money plus a versioned FX reference, consistent with ADR-004. Until the FX provider and attribution decision is resolved, a live Stage 7 adapter may accept only facts that already yield exact EUR reporting values; unsupported non-EUR facts are quarantined. Missing FX produces `fx_unavailable`; it never becomes EUR at 1:1 or zero. Mixed-currency holdings can remain detail only when the authoritative portfolio total has exact EUR reporting value.

## Cursor, receipt, identity, and revision contract

`PortfolioCursor` supports opaque strings, page tokens, UTC timestamp watermarks, and bounded composite string state. Serialization is deterministic, while applications treat the content as opaque provider state and never infer numeric pagination. A new cursor commits only in the same transaction that durably records the raw receipt, successful normalization, canonical facts, identities, and revision links for that page. A crash before commit replays the old cursor safely.

Connection, provider portfolio, valuation, holding, contribution, and revision identities are stable and never array positions. Prefer provider IDs. When a provider lacks a stable revision/event ID, the adapter constructs a documented deterministic SHA-256 source fingerprint from canonical source fields; the fingerprint algorithm/version is part of the adapter contract. Payload hashes detect exact replay but do not replace source identity. Same source ID plus a new revision means revised contents; canonical versioned-fact rules append and supersede projections without deleting history.

Each raw receipt records provider, endpoint capability, request cursor/window, `receivedAt`, payload SHA-256, source/revision IDs, normalization version, and processing status. Provider payload ciphertext is retained for at most 30 days for replay/diagnostics, then deleted. Receipt metadata, hashes, canonical facts, source links, and revision audit remain under their normal retention. Raw payloads are never financial truth.

## Connection and security lifecycle

Connection lifecycle is separate from metric completeness: `disconnected`, `connecting`, `active`, `degraded`, `reauth_required`, and `disabled`. Access/refresh tokens, API keys, client secrets, and provider credentials are secrets encrypted at rest with the existing versioned authenticated-encryption boundary. They never enter logs, fixtures, jobs, cursors, or raw receipt metadata. Provider name, non-sensitive connection state, capability set, key version, consent expiry, sync timestamps, and keyed/encrypted account references are metadata. Rotation replaces the encrypted envelope; revocation deletes usable credentials and stops synchronization.

Disconnect immediately revokes/deletes credentials and stops future sync. It retains minimal connection/sync audit plus historical canonical valuations and contributions so financial history does not silently change. Purge is a distinct explicit operation governed by the still-open imported-data deletion policy; it removes connection-derived payloads/facts and recalculates remaining history.

Account IDs, holdings, portfolio values, contribution evidence, raw payloads, and credentials are sensitive. Fixtures use only synthetic identifiers, instruments, references, and amounts.

## Stage 7 acceptance fixture catalog

`PORTFOLIO_CONTRACT_FIXTURES` covers valuation-only, contribution-only, market-only gain, mixed contribution/withdrawal/gain, withdrawal, cash included, cash excluded with aggregate and split projections, unknown cash treatment, stale and missing valuation, duplicate page, revised fact, cursor replay, holdings mismatch, and provider P/L disagreement. It follows the Stage 3 pattern of recurring contributions and an ad-hoc larger contribution without copying personal data.

The full Stage 7 implementation may add HTTP adapters, encrypted connection persistence, durable sync jobs, and provider-specific contract tests only after provider binding is resolved. This contract authorizes no trading, Open Banking, AI classification, automatic contribution, provider write, or Stage 8 behavior.
