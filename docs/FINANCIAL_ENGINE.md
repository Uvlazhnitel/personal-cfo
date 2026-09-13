# Deterministic Financial Engine

This specification consumes the canonical records in [DATA_MODEL.md](DATA_MODEL.md), follows [FRD.md](FRD.md), and is governed by [DECISIONS.md](DECISIONS.md).

## Authority and Interface

The financial engine is the sole authority for Net Worth, Capital Conversion Rate (CCR), spending baselines, liquidity, Cash Drag, Sinking Fund contributions, Safe to Invest, Investment Step-Up, expense optimization, and forecasts. It performs no I/O and has no dependency on Next.js, PostgreSQL, external providers, or AI.

```ts
type MetricResult<T> = Readonly<{
    value: T | null;
    status: "complete" | "partial" | "unavailable";
    asOf: string;
    engineVersion: string;
    settingsVersion: string;
    inputWatermark: string;
    explanation: readonly ExplanationComponent[];
    warnings: readonly DataWarning[];
}>;

declare function evaluateFinancialState(
    input: FinancialEngineInput,
): FinancialEngineResult;
```

Inputs are immutable canonical domain values. Output explanation components contain labeled input amounts and rule IDs; they are facts for UI or AI wording, not generated prose.

`FinancialEngineResult` exposes current-cycle Sinking Fund due, completed Pay Cycle capacities, unresolved-ambiguity warnings, and the existing metric completeness state. These are provider-neutral values; the engine does not create allocations or resolve transactions.

## Common Numerical and Time Rules

- Money uses signed integer minor units. Rates and ratios use arbitrary-precision decimals. JavaScript binary floating point is prohibited in financial paths.
- API and snapshot values serialize integers and decimals as strings.
- EUR is the reporting currency. A non-EUR amount requires a versioned FX rate valid for its effective date. Missing FX never becomes a zero value.
- Monetary division rounds half-even unless a rule explicitly says to round upward. Display formatting cannot change stored results.
- Instants are UTC. Daily and monthly periods close in `Europe/Riga`, including daylight-saving transitions.
- Only booked activity enters authoritative historical metrics. Pending debits may reduce prospective liquidity; pending credits never increase investable money.
- Calculations carry `complete`, `partial`, or `unavailable`. An invest-more or Step-Up recommendation requires complete inputs.
- Material stale data makes dependent metrics unavailable by default unless a metric-specific rule permits a provisional value. Current Net Worth is the explicit exception below. Default thresholds remain 3 days for bank/cash balances, 3 market days for portfolio values, and `max(€100, 2% of rolling monthly recognized income)` for unresolved transactions. These thresholds are settings.
- Plausible unresolved transfers and unexplained cash variances follow their explicit policies below. They are never silently coerced into income or consumption to make a metric complete.

## Net Worth and Capital Attribution

### Definitions and Formula

`Liquid cash` is the current balance of included bank and Cash Accounts. `Reserved cash` is the portion designated by active Sinking Fund allocations. It remains liquid and remains part of Net Worth, but is not free cash. `Investment value` is the most recent complete portfolio valuation. `Contributed capital` is cumulative confirmed principal transferred into investments; it is not current market value.

```text
Net Worth = liquid cash
          + investment market value
          + other included assets
          - included liabilities
```

For a period with reliable boundary valuations:

```text
Investment return = closing investment value
                  - opening investment value
                  - contributions
                  + withdrawals
                  - FX valuation effect
```

The FX term is zero for an all-EUR portfolio. A provider-reported P/L is reconciliation evidence only until its semantics match this formula.

### Invariants and Edge Cases

- Moving money among tracked accounts does not change Net Worth.
- Creating or allocating a Sinking Fund does not change Net Worth.
- A contribution changes investment principal but not Net Worth at transfer time, except for an explicit fee.
- A market gain changes Net Worth and investment return but not contributed capital or CCR.
- Brokerage cash is represented inside the portfolio total or as a separate account, never both.
- Opening balances establish the start of a measurable history and are not capital created.

If an included account has a known value past its explicit `staleAt`, current Net Worth includes that last known value and is `partial`; no invest-more recommendation is emitted. A missing required value or missing EUR conversion makes Net Worth `unavailable`, never a partial subtotal. The input assembler derives `staleAt` from the effective settings and applicable market calendar, and the pure engine only compares it with the supplied calculation time. Period return is unavailable unless both boundary values and intervening flows are complete. Daily snapshots are calculated after the local day closes and on material balance or valuation changes. Corrections recalculate from the earliest affected boundary forward.

## Capital Conversion Rate

### Definitions

`Recognized income` is booked external earned income, including salary and side-hustle income. It excludes refunds, reimbursements, transfers, loan proceeds, asset sales, opening balances, and market gains.

`Net consumption` is external consumption booked in the period, net of linked refunds and reimbursements booked in that period. Asset transfers, investment contributions, cash withdrawals, and reserve allocations are not consumption.

`Short-term reserved funds` are cash currently ring-fenced for future consumption, such as a trip or purchase. Their balance is allocations minus funded consumption and explicit releases. The period change is the sum of those signed reservation events in the period. Emergency liquidity is long-term retained capital and is not a short-term reservation.

### Formula and Timing Policy

For period `p`:

```text
capital_created(p) = recognized_income(p)
                   - net_consumption(p)
                   - change_in_short_term_reserved_funds(p)

CCR(p) = capital_created(p) / recognized_income(p)
```

This is commitment accounting for reservations. Allocating €300 for a future trip reduces capital created when allocated. When €300 is later spent, consumption rises by €300 and the reserved balance falls by €300, so it is not deducted twice. Releasing an unused allocation increases capital created in the release period.

Investment contributions are a destination of retained capital, not an additional numerator term. For explanation, positive capital created is attributed by a deterministic waterfall to net investment contributions, increase in emergency reserve, and remaining long-term unallocated cash, capped so destination labels never exceed capital created.

Rolling CCR is a ratio of sums:

```text
rolling_CCR = sum(capital_created) / sum(recognized_income)
```

It is not the mean of monthly percentages. Current month and rolling 3-, 6-, and 12-month results use local calendar boundaries. Negative values and values above 100% are valid and are not clamped. If recognized income is zero or negative, CCR is unavailable for that period, while capital created remains reportable.

### Edge Cases and Recalculation

- A refund is recognized on its booking date; history is not backdated unless the provider corrected the original booking.
- Spending from savings can produce negative capital created in a later month.
- Funding a reservation from old savings produces negative capital created at allocation time, making the reclassification visible.
- Unresolved credits cannot count as income. Non-material ambiguity makes CCR partial; material ambiguity makes CCR unavailable.
- A changed classification, fund allocation, refund link, FX rate, or opening boundary recalculates every affected rolling window.

### Reservation Input Boundary

CCR receives canonical Sinking Funds, immutable reservation events, linked consumption facts, and explicit history coverage. One shared validator proves fund identity, creation time, currency, linkage, and a non-negative running reserved balance before deriving the short-term-reserve change independently for each measurement period. An empty event set means zero change only when coverage proves the complete history; missing coverage makes CCR unavailable. Rolling windows never reuse one pre-aggregated reserve value.

Economic-flow amounts are canonical EUR reporting values. Earned-income meaning is explicit and may be negative only for a booked income correction. `other_external_flow` is disclosed but remains neutral until given a more specific canonical meaning. Linked refunds and reimbursements reduce consumption on their own booking date; an unlinked refund or reimbursement requires a matching active ambiguity, reduces nothing, and never becomes income. A material classification or transfer ambiguity makes CCR unavailable, while a non-material ambiguity permits only a warned partial value. Cash reconciliation adjustments remain CCR-neutral; a material unexplained variance makes the otherwise calculated CCR partial.

## Unresolved Transfer Candidates

A plausible booked bank-to-cash, bank-to-brokerage, or other internal transfer receives the provisional type `unresolved_transfer`. It is displayed separately as under review and is excluded from authoritative consumption and recognized income until confirmed or rejected.

Consumption and CCR for a non-material affected period are `partial`. A material candidate makes CCR and Safe to Invest unavailable and suppresses invest-more, Cash Drag, and Step-Up recommendations. A non-material candidate permits provisional CCR and Safe-to-Invest values from resolved flows and reconciled cash balances, but both remain `partial` with an ambiguity warning. Net Worth may remain complete when authoritative balances on all affected accounts are complete.

Confirmation classifies the linked entries as an internal transfer. Rejection applies the appropriate external-flow classification. Either resolution appends history and recalculates all affected periods and rolling windows.

## Spending Baseline

### Inputs and Algorithm

The baseline separates expected recurring spending from non-recurring variable spending to prevent double counting:

```text
normal baseline = next-month scheduled recurring spending
                + robust variable-spending estimate

essential baseline = essential recurring spending
                   + robust essential-variable estimate
```

Use the latest six complete calendar months within the configured historical lookback, which is 36 months in V1. Search backward past incomplete months and months without explicit coverage; neither is treated as zero. At least three complete months must be found within that bound; otherwise return the effective user-configured fallback and mark the result partial. A complete month has reconciled bank data, no material unresolved activity, valid FX coverage, and complete spending classification.

For each month, exclude transfers, investment flows, opening balances, Sinking Fund allocations, and user-confirmed irregular events. Linked refunds reduce the relevant variable category. Remove recurring transactions from variable totals. For each category, take the median monthly variable total. Values above `median + max(3 × MAD, materiality threshold)` are flagged for review and winsorized to that boundary unless already marked irregular. A single unusually low month remains in the sample; the median prevents it from dominating.

Category samples include a zero for every complete month without eligible spending in that category. Even-sized medians and MAD medians use half-even minor-unit rounding. Linked refunds and reimbursements reduce the original variable category in their own booking month; a category-month is floored at zero and any excess reversal is disclosed rather than converted into negative spending. Funded Sinking consumption is excluded only up to its validated covered amount, leaving any unfunded remainder as ordinary consumption.

When the latest 24 complete months can be selected within the same configured lookback, an optional seasonal factor compares the target calendar month's median winsorized variable spending with the overall median winsorized variable spending. The seasonal input reuses the same per-category median, MAD, and winsorization policy as the authoritative baseline rather than raw observations. Cap the factor to ±20%, apply it only to the normal and essential variable estimates, and disclose it as an exact fraction. The explicit next-period recurring schedule is not adjusted. A zero overall variable median disables the factor with a warning. With 23 or fewer selected complete months, no seasonality is inferred.

### Outputs and Behavior

Return recurring, variable, essential, normal, variability-buffer, excluded-irregular, and completeness components. The variability buffer is the nearest-rank 80th percentile of positive deviations of eligible monthly normal spending above its median. Three complete monthly observations are sufficient. No positive deviations is an observed zero; fewer than three observations produces zero with an explicit insufficient-sample warning.

Recalculate after a completed month, recurring-series change, irregular flag, refund link, or historical classification correction. Never use machine learning for the authoritative V1 baseline.

## Liquidity Reserve

### Components

- `Operational essential`: booked/pending essential debits and scheduled essential costs before the next reliable income date, less no pending credits.
- `Operational normal`: the same horizon including normal discretionary spending.
- `Ring-fenced`: active Sinking Fund allocations and other explicitly restricted cash.
- `Current-cycle Sinking due`: required committed-fund contributions due in the open Pay Cycle but not yet allocated.
- `Uncovered obligations`: mandatory amounts due in the configured near-term horizon that have no active Sinking Fund and are not already included in recurring/operational spending.
- `Minimum reserve target`: essential baseline × minimum reserve months.
- `Comfort reserve target`: normal baseline × comfort reserve months, plus one variability buffer.

The balanced V1 defaults are one month of essential spending and three months of normal spending. Both are configurable and effective-dated.

For a mandatory obligation expressed as a range, liquidity and Safe to Invest use its upper bound. An optional obligation affects these metrics only after the user marks it committed; a committed range also uses its upper bound.

### Formula

```text
minimum cash = ring-fenced
             + current-cycle Sinking due
             + uncovered obligations
             + max(operational essential, minimum reserve target)

comfort cash = ring-fenced
             + current-cycle Sinking due
             + uncovered obligations
             + max(operational normal, comfort reserve target)

free liquid cash = liquid cash - ring-fenced
```

Using `max` prevents current-cycle operating costs from being added again when the reserve target already covers them. An obligation linked to an active Sinking Fund is represented by its allocated balance plus current-cycle due, not by adding the full future obligation again. An obligation in the operational forecast is likewise not repeated as uncovered.

Pending debits increase operational need; pending credits do not reduce it. If the next income date is unknown, use 31 days and mark partial. If liquid balances, baseline, obligations, or reservation coverage are materially incomplete, the reserve is partial and Safe to Invest is unavailable.

The operational interval is start-inclusive and ends immediately before the supplied next reliable income date. Variable burn is prorated across each covered Europe/Riga calendar month as `monthly variable × covered days / days in month`; the rational terms are accumulated exactly and rounded half-even once at the final monetary boundary. Booked debits are excluded because authoritative current cash already contains them. A pending item linked to a scheduled item supersedes that schedule for the same cash need.

## Sinking Funds

### Pay-Cycle Boundary

A Pay Cycle begins at a booked positive transaction explicitly designated as the primary-salary trigger and ends immediately before the next such booking. The trigger carries its Europe/Riga effective date; the opening transaction UUID is also the stable derived cycle UUID. Side-hustle income, other earned income, and negative salary corrections do not open a cycle. Historical boundaries use actual salary bookings; explicitly supplied expected salary dates are used only to count future funding opportunities. A missing or delayed next salary leaves the current cycle open.

### Current-Cycle Contribution Formula

Creating a fund records a target but reserves nothing. An allocation explicitly designates existing liquid cash. When salary opens a Pay Cycle, create a versioned requirement for each committed active fund. Creating or changing a fund mid-cycle creates or supersedes its requirement immediately.

```text
reserved before requirement = ring-fenced cash immediately before requirement
funded consumption before requirement = cumulative covered spending before requirement
fulfilled before requirement = reserved before requirement
                             + funded consumption before requirement
future opportunities = expected primary-pay dates after this cycle
                       and on or before the fund due date
cycle share = ceil_to_minor_unit(
    max(0, target - fulfilled before requirement)
    / (1 + future opportunities)
)
current-cycle outstanding = max(
    0,
    cycle share - net fulfillment progress during this cycle
)
```

Cap outstanding at the fund's current unallocated shortfall. If no future opportunity occurs before the due date, the current cycle is the only opportunity and the entire shortfall is due now. Releases increase the outstanding amount when applicable. A fully funded or overfunded fund requires zero contribution; overfunding is not released automatically.

Expected funding dates must be complete through the fund due date. Dates strictly after the effective evaluation date and on or before the due date are future opportunities; a later salary is too late. The current active cycle remains the first opportunity for a committed fund created mid-cycle. Exact projected schedules divide the remaining minor units by opportunity count and assign remainder cents to the earliest opportunities, so €100 across three opportunities is €33.34, €33.33, and €33.33.

The outstanding amount becomes due at salary booking, or immediately for a committed fund created or changed mid-cycle. It enters minimum and comfort cash before an allocation exists. When €X is allocated, current-cycle due falls by €X while ring-fenced cash rises by €X, so required liquidity and Safe to Invest do not change. Only the actual allocation changes reserved balance and CCR.

### Allocation Policy

Allocation is manual by default. A fund may explicitly enable `on_primary_income`. At salary receipt or a mid-cycle fund change, the application may convert the deterministic outstanding amount into an audited virtual allocation; no physical bank transfer occurs.

Automatic allocation orders funds by earliest due date, explicit priority, then stable fund ID. It is capped at unallocated liquid cash above non-Sinking minimum cash:

```text
non-Sinking minimum cash = uncovered obligations
                         + max(operational essential, minimum reserve target)

auto-allocatable cash = max(
    0,
    liquid cash - ring-fenced - non-Sinking minimum cash
)
```

A partial allocation leaves the rest outstanding and protected by Safe to Invest. Manual allocation may use any otherwise unallocated cash but must warn if it leaves free cash below non-Sinking minimum liquidity.

An allocation cannot exceed eligible liquid cash. Spending linked to the fund lowers cash and its reserved balance by the covered amount but increases funded consumption to date by the same amount. It therefore preserves target fulfillment and cannot reopen a satisfied current-cycle requirement. Any excess spending is ordinary current-period consumption. A smaller-than-planned purchase leaves the remainder reserved until the user releases, rolls over, or reallocates it.

Reservation events are immutable positive-magnitude `allocation`, `funded_consumption`, or `release` facts. Their reserved-balance deltas are positive, negative, and negative respectively; their target-fulfillment deltas are positive, zero, and negative. Consequently:

```text
reserved balance = allocations - funded consumption - releases
funded consumption to date = funded-consumption events
fulfilled amount = reserved balance + funded consumption to date
remaining to fund = max(0, target - fulfilled amount)
excess = max(0, fulfilled amount - target)
```

A funded-consumption event must link to booked consumption at the same instant and cannot exceed either the linked consumption or currently reserved cash. A release likewise cannot exceed currently reserved cash. Events are ordered by effective instant then stable ID, and the running reserved balance must never be negative. Corrections use compensating events. Summing reserved-balance deltas within a start-inclusive/end-exclusive measurement period produces the unchanged CCR reservation effect.

Fund target, due date, allocation, release, and spending-link changes recalculate contribution, liquidity, CCR, Safe to Invest, Cash Drag, and forecasts from their effective dates.

## Safe to Invest

### Formula and Tiers

The liquidity calculations already include operational needs, uncovered obligations, current-cycle Sinking due, and Sinking Fund allocations. Safe to Invest therefore subtracts each complete threshold exactly once:

```text
conservative = max(0, liquid cash - comfort cash - variability buffer)
recommended  = max(0, liquid cash - comfort cash)
maximum      = max(0, liquid cash - minimum cash)
```

Thus `conservative ≤ recommended ≤ maximum`. Values are rounded down to the configured recommendation increment, €10 by default; unrounded values remain in audit/explanation data.

The buffer difference is intentional. Comfort cash already preserves one variability buffer above the unbuffered comfort baseline. Recommended Safe to Invest preserves that normal Comfort Cash policy; conservative preserves Comfort Cash plus one additional variability buffer. Conservative therefore protects two variability buffers relative to the unbuffered comfort baseline. Maximum preserves Minimum Cash.

The result lists liquid cash, ring-fenced funds, uncovered obligations, operational need, reserve target, variability buffer, pending-debit adjustment, and rounding. It recalculates after income, material spending, balances, obligations, reservations, baseline changes, or settings changes.

Safe to Invest is unavailable rather than zero when inputs are incomplete. Zero means a complete calculation found no surplus. The engine never initiates an investment and never treats an expected incoming payment as available cash.

## Cash Drag

For each complete daily snapshot:

```text
daily excess = max(0, liquid cash - comfort cash)
```

A Cash Drag recommendation requires all of the following:

- current daily excess is positive;
- at least 54 of the last 60 days are complete;
- excess is positive on at least 45 of those 60 calendar days;
- the average over complete days exceeds `max(€250, 10% of current comfort cash)`.

The recommendation amount is bounded by current recommended Safe to Invest, not the historical average. A notification is suppressed while an equivalent active recommendation exists, after dismissal during its cooldown, or when no action is required. The 60-day window, day counts, threshold, and cooldown are settings.

## Investment Step-Up and Step-Down

The engine evaluates the latest four complete Pay Cycles. Each cycle requires two actual primary-salary boundaries, reconciled sources, no minimum-liquidity breach, and no unresolved material transaction or cash variance. Salary placement within a calendar month has no effect.

```text
cycle capacity = recurring investment contributions during the cycle
               + recommended Safe to Invest immediately before
                 the closing salary is booked

sustainable capacity = median(last four cycle capacities)
```

For four observations, median is the half-even minor-unit average of the two central sorted values. Median is selected because minimum is overly sensitive to one legitimate expensive cycle, while a four-sample lower quartile is unstable and behaves too similarly to minimum. Median is not sufficient alone: every proposed contribution must pass the forward stress test.

A Step-Up is eligible when capacity is at least one step above the current recurring contribution and Cash Drag or persistent surplus evidence exists. The default step is €50:

```text
new recurring contribution = min(
    current contribution + €50,
    floor_to_€50(sustainable capacity)
)
```

Stress the candidate over the next 60 days using current balances, expected primary salary, normal spending, upper-bound committed obligations, current and projected Sinking requirements, and 0% market return. Cash must remain at or above minimum cash throughout and finish at or above comfort cash. Reduce a failing candidate by €50 steps until one passes; if no increase passes, recommend hold.

Only one step is recommended per four-Pay-Cycle reassessment window. Acceptance does not execute a brokerage instruction.

A hold is recommended if capacity is uncertain or within one step of the current contribution. A Step-Down is eligible if the current contribution exceeds sustainable capacity or fails the same 60-day test. Reduce it by €50 steps to the greatest amount that passes, including zero. A projected minimum-cash breach bypasses the normal cooldown.

## Cash Reconciliation

A physical count sets the Cash Account's authoritative balance from the reconciliation instant by creating a signed `cash_reconciliation_adjustment`; it never overwrites prior entries.

The variance changes Net Worth, liquidity, and Safe to Invest immediately and appears as unexplained cash gain or loss. It is excluded from recognized income, ordinary consumption, the spending baseline, and CCR. A non-material variance retains calculated metrics with an explicit warning. A material variance makes affected CCR partial and suppresses invest-more, Cash Drag, and Step-Up recommendations until resolved.

If the cause is found, either reclassify the adjustment itself or reverse it before recording the recovered transaction. The engine must reject any resolution that would apply the balance difference twice.

## Expense Optimization

### Drift and Recurrence

Current-month category forecast equals booked category spending plus confirmed recurring charges remaining in the month plus prorated variable baseline for remaining days. A spending-drift candidate requires a complete baseline and a forecast increase exceeding both €50 and 25% of that category baseline by default. Irregular and funded Sinking Fund activity is excluded.

A recurring-series candidate requires at least three compatible booked transactions with amount and interval tolerance. A price-increase alert requires both a 10% and €2 rise over the prior stable amount. Suspected “unused” services are out of scope without explicit usage data.

Recommendations follow FRD priority: unnecessary recurring expenses, clear inefficiencies, drift, convenience spending, then other discretionary spending. A useful expense is never labeled waste solely from its category.

### Potential and Realized Savings

Potential saving is the positive difference between the current forecast/recurring amount and its normal comparison level. It is always labeled an estimate. After acceptance, realized saving compares the next three complete comparable months with the frozen pre-recommendation baseline, excluding unrelated irregular events. Until three months exist, the outcome is partial. No favorable result is attributed when data quality or behavior attribution is ambiguous.

## Financial Forecast

Forecasts use monthly deterministic steps for 1, 3, 5, and 10 years. Inputs include starting cash and investments, explicit future net capital contributions, allocation between cash and investments, known planned expenses, and visible return/inflation assumptions. Sinking Fund allocations are internal designations; only the planned external expense reduces forecast Net Worth.

Contributions-only uses a 0% investment return. Assumed-return views initially expose 3%, 5%, and 7% nominal annual scenarios; 5% is the selected default but is always displayed and editable. Optional real-value display uses a visible, editable 2% inflation assumption.

Convert annual rates to monthly factors with arbitrary-precision decimal arithmetic. For each month, apply return to opening investment value, then apply end-of-month contribution/withdrawal and planned expenses. Round resulting money half-even to minor units at each monthly boundary and retain the exact assumption set.

Do not infer future salary growth, contribution increases, or market returns from history. They must be explicit scenario inputs. Planned expenses are deducted in their due month. A mandatory expense range uses its upper bound in the base/conservative forecast; comparison views may show its lower bound separately. Outputs separate current capital, user contributions, planned expenses, modeled return, cash, and investment value. UI and AI must label all non-zero return results as modeled, not guaranteed. Missing starting values or mandatory-expense amounts make the affected horizon unavailable rather than assuming zero.

## Recommendation and AI Boundary

The deterministic recommendation engine consumes `MetricResult` values and emits a rule ID, evidence, amount/range, reason components, priority, expiry, and required action. Rules suppress duplicate or immaterial messages. “No action required” is a first-class result.

AI receives only these prepared values and may explain or summarize them. It cannot supply a missing amount, change a metric, alter a transaction, accept a recommendation, or promote partial data into a recommendation. Every numeric statement in AI output must match an allowlisted context value; otherwise use a deterministic explanation template.

## Historical Recalculation

Each run is identified by engine version, settings version, as-of time, input watermark, and FX-rate set. A change schedules recalculation from its earliest effective date through today because balances, rolling windows, reservation state, and recommendation outcomes can propagate forward.

Snapshots are immutable. A new result supersedes an old one; it does not edit it. Re-running identical inputs and versions must produce byte-equivalent structured financial values and explanation components. When an older engine version is unavailable, its stored result remains viewable but cannot be regenerated; releases therefore retain supported calculation versions until their audit-retention period ends.

## Worked Examples

### ATM and Cash Spending

Withdrawing €100 creates bank `-10000` and cash `+10000`; Net Worth and consumption are unchanged. Spending €27 from cash later creates consumption of `2700`, lowers Net Worth by €27, and lowers period capital created by €27.

### Contribution and Market Gain

A €200 bank-to-brokerage transfer is an internal transfer and a contribution. If the portfolio then rises by €15 with no other flows, contributed capital rises €200, return is €15, Net Worth rises only €15 from the market move, and CCR receives no €15 benefit.

### Reservation Across Months

Month one has €3,000 income, €2,000 consumption, and a €300 trip allocation: capital created is €700. Month two has €3,000 income, €2,000 ordinary consumption, and spends the reserved €300; the reserved balance falls €300, so capital created is `3000 - 2300 - (-300) = €1,000`. Across both months the trip is deducted once.

### Safe-to-Invest Example

If liquid cash is €7,200, ring-fenced and uncovered amounts are already included in comfort cash of €5,300, minimum cash is €4,700, and variability buffer is €200, the unrounded tiers are €1,700 conservative, €1,900 recommended, and €2,500 maximum. No component is subtracted again.

Comfort cash in this example already contains its normal variability buffer. The conservative €1,700 result preserves another €200, exactly one buffer more than the €1,900 recommended result.

### Current-Cycle Sinking Requirement

Liquid cash is €7,000 and a €1,200 committed trip has no allocation with six funding opportunities remaining. The current-cycle due is €200. If comfort cash excluding the due is €4,500, recommended Safe to Invest is `7000 - 4500 - 200 = €2,300`. After allocating €200, ring-fenced cash rises to €200 and outstanding due falls to zero; recommended Safe to Invest remains €2,300.

### Cash Count

If the ledger says Cash is €140 and the user counts €125, reconciliation creates a `-€15` unexplained adjustment. Net Worth and Safe to Invest fall by €15, while recognized income, ordinary consumption, baseline spending, and CCR inputs do not change.

## Test Strategy

Use table-driven Vitest unit tests and fast-check property tests. A synthetic ledger must cover:

- normal salary and side-hustle income months;
- vacation and large-purchase outliers plus unusually high and low months;
- ATM withdrawal followed by cash spending;
- bank-to-brokerage transfer;
- linked and unlinked refund and reimbursement;
- funded, underfunded, spent, canceled, and overdue Sinking Funds;
- excess cash, insufficient cash, pending debits, and pending credits;
- market gain without contribution and contribution without market gain;
- duplicate imports and pending-to-booked reconciliation;
- unresolved bank-to-cash and bank-to-brokerage transfer candidates;
- physical-cash reconciliation and later cause resolution;
- transaction reclassification, settings changes, and historical recalculation;
- missing FX, stale portfolio, missing income date, zero-income CCR, and DST/month boundaries.

Required properties include:

- any balanced internal transfer leaves Net Worth and consumption unchanged;
- bank-to-cash movement never creates an expense;
- bank-to-brokerage movement never creates consumption or market return;
- market return never changes CCR;
- a Sinking Fund allocation never changes Net Worth;
- allocation plus later covered spending affects cumulative capital creation exactly once;
- replacing current-cycle Sinking due with an equal allocation leaves Safe to Invest unchanged;
- partial automatic allocation leaves the unallocated remainder protected;
- duplicate import is idempotent;
- `conservative ≤ recommended ≤ maximum` and all are non-negative;
- conservative Safe to Invest is exactly one variability buffer below recommended before rounding;
- adding an uncovered obligation cannot increase Safe to Invest;
- equivalent cash flows anchored to salary on the 1st or 28th produce equal Pay Cycle capacity;
- capacities `[€20, €200, €200, €220]` produce a €200 median before stress testing;
- a failing 60-day stress test cannot produce a Step-Up even when median capacity permits one;
- unresolved transfer candidates never enter authoritative consumption or income;
- reconciliation from €140 to €125 changes cash and Net Worth once without inventing consumption or income;
- material transfer or cash ambiguity suppresses invest-more recommendations;
- resolving either ambiguity deterministically supersedes affected snapshots;
- identical versioned inputs produce identical outputs;
- snapshot components reconcile to their displayed totals in exact minor units.
