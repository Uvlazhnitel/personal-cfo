# Financial Engine Verification Matrix

## Verification Contract

Stage 4 verifies the pure Stage 2 engine against the deterministic Stage 3 dataset. Production formulas and APIs are unchanged. Property failures are replayable with:

```bash
FC_SEED=<seed> FC_PATH='<path>' pnpm test -- packages/domain/test/verification
```

The full normalized result is locked by `Stage 4 canonical golden serialization > matches the complete healthy-current Stage 2G.1 result byte for byte`. The serializer sorts object keys, preserves semantic array order, renders `bigint` as decimal strings, and rejects values that cannot enter a versioned snapshot.

## FRD Traceability

| Requirement | Concrete verification |
| --- | --- |
| FR-005 Cash Account | `synthetic financial dataset > keeps ATM transfers, investments, opening state, and market changes out of CCR`; `canonical transaction verification > preserves balanced transfer zero-sum semantics under entry ordering` |
| FR-020, FR-022 Net Worth and growth sources | `net worth > calculates liquid cash and investment market value exactly (FR-020)`; `net worth > lets market-only changes alter Net Worth without requiring a contribution`; `Stage 4 orchestration verification > changes wealth and investable cash by the exact count variance without inventing flow` |
| FR-030–032 CCR | `capital conversion rate > calculates a normal salary month exactly (FR-030)`; `capital conversion rate properties`; `synthetic financial dataset > matches the literal rolling multi-month CCR reference exactly` |
| FR-040, FR-041 Baseline and liquidity | `spending baseline`; `spending baseline complete-month selection`; `liquidity reserve`; `Stage 4 orchestration verification > keeps independent cash metrics usable when portfolio valuation is missing` |
| FR-050–052 Cash Drag | `cash drag > accepts exactly 54 complete days but treats 53 as insufficient evidence`; `cash drag > uses an inclusive 44/45 positive-day boundary`; `cash drag properties` |
| FR-060–062 Sinking Funds | `sinking funds`; `reservation accounting`; `sinking fund properties`; `synthetic financial dataset > preserves liquidity and STI when current due becomes reserved cash` |
| FR-070–073 Safe to Invest | `safe to invest`; `safe to invest properties`; `Stage 4 orchestration verification > derives complete, provisional, and blocked investability only from canonical facts` |
| FR-080–083 Step-Up/Step-Down | `investment step > uses the exact four-sample median and half-even central midpoint`; `investment step > returns partial for three cycles and never backfills over an unreliable latest cycle`; `investment step properties`; `Stage 4 forecast verification > does not mutate explicit forecast flows when Step-Up is suppressed for the same window` |
| FR-100–103 Forecast | `financial forecast`; `financial forecast properties`; `Stage 4 forecast verification > reconciles every monthly boundary in every 0/3/5/7 percent scenario` |

FR-032 explanation generation, FR-051 notification delivery, FR-052 execution boundaries, FR-072 presentation, FR-073 persisted recalculation triggers, and the interactive delivery portion of FR-103 remain application/persistence work after Stage 4. Stage 4 verifies the structured deterministic facts those later layers consume.

## Required Reconciliation Regressions

The accepted reconciliation set is preserved verbatim below and linked to its regression evidence:

1. **allocating a current-cycle Sinking requirement leaves Safe to Invest unchanged;** `synthetic financial dataset > preserves liquidity and STI when current due becomes reserved cash`.
2. **partial automatic allocation leaves the outstanding remainder protected;** `sinking funds > converts current due to reserved cash one-for-one for partial and full allocation`.
3. **equivalent cycles with salary on the 1st or 28th produce equal capacity;** `investment step > is invariant to equivalent salary-date placement`.
4. **capacities `[€20, €200, €200, €220]` have median €200, subject to the 60-day stress test;** `investment step > uses the exact four-sample median and half-even central midpoint`; `investment step > holds current when the one-step candidate first breaches minimum cash`.
5. **conservative Safe to Invest is one variability buffer below recommended before rounding;** `safe to invest > preserves the extra-buffer difference before flooring`.
6. **unresolved bank-to-cash or bank-to-brokerage candidates never become consumption;** `capital conversion rate > makes material ambiguity unavailable and non-material ambiguity partial`; `synthetic financial dataset > blocks invest-more on material transfer ambiguity and restores it in the resolved variant`.
7. **reconciling €140 system cash to €125 counted cash lowers Net Worth and Safe to Invest by €15 without creating income or consumption;** `Stage 4 orchestration verification > changes wealth and investable cash by the exact count variance without inventing flow`.
8. **material transfer/cash ambiguity suppresses invest-more recommendations;** `Stage 4 orchestration verification > derives complete, provisional, and blocked investability only from canonical facts`.
9. **resolving either ambiguity deterministically supersedes affected snapshots.** `synthetic financial dataset > keeps reconciliation cutoffs auditable and restores readiness only after resolution`; `synthetic financial dataset > blocks invest-more on material transfer ambiguity and restores it in the resolved variant`.
10. **pre-resolution checkpoints remain unresolved and later valid resolution restores authority.** `orchestration > keeps a reconciliation active through resolvedAt and validates both resolution mechanisms`.

## Coverage Gate

`pnpm test:coverage` runs Vitest/V8 and then `scripts/check-critical-coverage.mjs`. The gate requires exact branch equality (`covered === total`) for `money.ts`, `canonical-transaction.ts`, `sinking-funds.ts`, `capital-conversion.ts`, and `safe-to-invest.ts`; missing reports and zero branch totals fail explicitly. No global exclusions or ignore directives are used.
