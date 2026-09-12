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

## Common Numerical and Time Rules

- Money uses signed integer minor units. Rates and ratios use arbitrary-precision decimals. JavaScript binary floating point is prohibited in financial paths.
- API and snapshot values serialize integers and decimals as strings.
- EUR is the reporting currency. A non-EUR amount requires a versioned FX rate valid for its effective date. Missing FX never becomes a zero value.
- Monetary division rounds half-even unless a rule explicitly says to round upward. Display formatting cannot change stored results.
- Instants are UTC. Daily and monthly periods close in `Europe/Riga`, including daylight-saving transitions.
- Only booked activity enters authoritative historical metrics. Pending debits may reduce prospective liquidity; pending credits never increase investable money.
- Calculations carry `complete`, `partial`, or `unavailable`. An invest-more or Step-Up recommendation requires complete inputs.
- Material stale data makes dependent metrics unavailable by default: bank/cash balance older than 3 days, portfolio value older than 3 market days, or an unresolved transaction greater than `max(€100, 2% of rolling monthly recognized income)`. These thresholds are settings.

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

If any material account is stale or missing, current Net Worth is partial and no invest-more recommendation is emitted. Period return is unavailable unless both boundary values and intervening flows are complete. Daily snapshots are calculated after the local day closes and on material balance or valuation changes. Corrections recalculate from the earliest affected boundary forward.

## Capital Conversion Rate

### Definitions

`Recognized income` is booked external earned income, including salary and side-hustle income. It excludes refunds, reimbursements, transfers, loan proceeds, asset sales, opening balances, and market gains.

`Net consumption` is external consumption booked in the period, net of linked refunds and reimbursements booked in that period. Asset transfers, investment contributions, cash withdrawals, and reserve allocations are not consumption.

`Short-term reserved funds` are active allocations for future consumption, such as a trip or purchase. The period change is closing allocated balance minus opening allocated balance. Emergency liquidity is long-term retained capital and is not a short-term reservation.

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
- Unresolved credits cannot count as income; unresolved material debits make CCR partial.
- A changed classification, fund allocation, refund link, FX rate, or opening boundary recalculates every affected rolling window.

## Spending Baseline

### Inputs and Algorithm

The baseline separates expected recurring spending from non-recurring variable spending to prevent double counting:

```text
normal baseline = next-month scheduled recurring spending
                + robust variable-spending estimate

essential baseline = essential recurring spending
                   + robust essential-variable estimate
```

Use the latest six complete calendar months. At least three complete months are required; otherwise return the effective user-configured fallback and mark the result partial. A complete month has reconciled bank data, no material unresolved activity, and valid FX coverage.

For each month, exclude transfers, investment flows, opening balances, Sinking Fund allocations, and user-confirmed irregular events. Linked refunds reduce the relevant variable category. Remove recurring transactions from variable totals. For each category, take the median monthly variable total. Values above `median + max(3 × MAD, materiality threshold)` are flagged for review and winsorized to that boundary unless already marked irregular. A single unusually low month remains in the sample; the median prevents it from dominating.

After 24 complete months, an optional seasonal factor compares the same calendar month with the overall median. Cap the factor to ±20% and disclose it. Until then, no seasonality is inferred.

### Outputs and Behavior

Return recurring, variable, essential, normal, variability-buffer, excluded-irregular, and completeness components. The variability buffer is the 80th percentile positive deviation of eligible monthly normal spending above its median; with insufficient samples it is zero and flagged.

Recalculate after a completed month, recurring-series change, irregular flag, refund link, or historical classification correction. Never use machine learning for the authoritative V1 baseline.

## Liquidity Reserve

### Components

- `Operational essential`: booked/pending essential debits and scheduled essential costs before the next reliable income date, less no pending credits.
- `Operational normal`: the same horizon including normal discretionary spending.
- `Ring-fenced`: active Sinking Fund allocations and other explicitly restricted cash.
- `Uncovered obligations`: mandatory amounts due in the configured near-term horizon that are neither covered by a fund nor already included in recurring/operational spending.
- `Minimum reserve target`: essential baseline × minimum reserve months.
- `Comfort reserve target`: normal baseline × comfort reserve months, plus one variability buffer.

The balanced V1 defaults are one month of essential spending and three months of normal spending. Both are configurable and effective-dated.

For a mandatory obligation expressed as a range, liquidity and Safe to Invest use its upper bound. An optional obligation affects these metrics only after the user marks it committed; a committed range also uses its upper bound.

### Formula

```text
minimum cash = ring-fenced
             + uncovered obligations
             + max(operational essential, minimum reserve target)

comfort cash = ring-fenced
             + uncovered obligations
             + max(operational normal, comfort reserve target)

free liquid cash = liquid cash - ring-fenced
```

Using `max` prevents current-cycle operating costs from being added again when the reserve target already covers them. An obligation linked to a funded Sinking Fund or recurring forecast is counted only for its uncovered portion.

Pending debits increase operational need; pending credits do not reduce it. If the next income date is unknown, use 31 days and mark partial. If liquid balances, baseline, obligations, or reservation coverage are materially incomplete, the reserve is partial and Safe to Invest is unavailable.

## Sinking Funds

### Contribution Formula

Creating a fund records a target but reserves nothing. An allocation explicitly designates existing liquid cash. For an active fund:

```text
remaining = max(0, target - allocated balance)
cycles = scheduled contribution dates strictly before or on due date
required contribution = ceil_to_minor_unit(remaining / cycles)
```

If the due date is today or overdue, cycles is one and the full remaining amount is due now. A fully funded or overfunded fund requires zero contribution. Overfunding is not released automatically.

An allocation cannot exceed eligible liquid cash. Spending linked to the fund lowers cash and allocated balance by the covered amount. Any excess spending is ordinary current-period consumption. A smaller-than-planned purchase leaves the remainder reserved until the user releases, rolls over, or reallocates it.

Fund target, due date, allocation, release, and spending-link changes recalculate contribution, liquidity, CCR, Safe to Invest, Cash Drag, and forecasts from their effective dates.

## Safe to Invest

### Formula and Tiers

The liquidity calculations already include operational needs, uncovered obligations, and Sinking Fund allocations. Safe to Invest therefore subtracts each complete threshold exactly once:

```text
conservative = max(0, liquid cash - comfort cash - variability buffer)
recommended  = max(0, liquid cash - comfort cash)
maximum      = max(0, liquid cash - minimum cash)
```

Thus `conservative ≤ recommended ≤ maximum`. Values are rounded down to the configured recommendation increment, €10 by default; unrounded values remain in audit/explanation data.

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

The engine evaluates four complete calendar months by default. Each month must have reconciled sources, no minimum-liquidity breach, and no unresolved material transactions. Define monthly sustainable capacity as the recommended Safe-to-Invest amount immediately after ordinary month-end obligations, plus the recurring investment already made that month. Overall capacity is the minimum of the four monthly capacities.

A Step-Up is eligible when capacity is at least one step above the current recurring contribution and Cash Drag or persistent surplus evidence exists. The default step is €50:

```text
new recurring contribution = min(
    current contribution + €50,
    floor_to_€50(sustainable capacity)
)
```

Only one step is recommended per four-month reassessment window. Acceptance does not execute a brokerage instruction.

A hold is recommended if capacity is uncertain or within one step of the current contribution. A Step-Down is eligible if current contribution exceeds sustainable capacity or the 60-day deterministic cash forecast breaches minimum cash. The proposed amount is the largest €50 multiple not exceeding capacity, including zero. A projected minimum-cash breach bypasses the normal cooldown.

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
- transaction reclassification, settings changes, and historical recalculation;
- missing FX, stale portfolio, missing income date, zero-income CCR, and DST/month boundaries.

Required properties include:

- any balanced internal transfer leaves Net Worth and consumption unchanged;
- bank-to-cash movement never creates an expense;
- bank-to-brokerage movement never creates consumption or market return;
- market return never changes CCR;
- a Sinking Fund allocation never changes Net Worth;
- allocation plus later covered spending affects cumulative capital creation exactly once;
- duplicate import is idempotent;
- `conservative ≤ recommended ≤ maximum` and all are non-negative;
- adding an uncovered obligation cannot increase Safe to Invest;
- identical versioned inputs produce identical outputs;
- snapshot components reconcile to their displayed totals in exact minor units.
