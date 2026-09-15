import { EUR, createMetricResult, createMoney } from '@personal-cfo/domain';
import type {
  DataWarning,
  MetricResult,
  Money,
  SinkingFund,
  SinkingFundId,
} from '@personal-cfo/domain';

import { FinancialEngineInvariantError } from './errors.js';
import type { LiquidityReserve } from './liquidity.js';
import type { CurrentCycleSinkingDue } from './sinking-funds.js';

export type AutomaticSinkingAllocation = Readonly<{
  fundId: SinkingFundId;
  amount: Money;
}>;

export type AutomaticSinkingAllocationPlan = Readonly<{
  allocations: readonly AutomaticSinkingAllocation[];
  allocatableCash: Money;
  allocatedTotal: Money;
  unallocatedCash: Money;
}>;

export type AutomaticSinkingAllocationInput = Readonly<{
  funds: readonly SinkingFund[];
  sinkingProtection: MetricResult<CurrentCycleSinkingDue>;
  liquidity: MetricResult<LiquidityReserve>;
}>;

function warning(code: string): DataWarning {
  return Object.freeze({ code, context: Object.freeze({}) });
}

function money(amountMinor: bigint): Money {
  return createMoney(amountMinor, EUR);
}

export function calculateAutomaticSinkingAllocations(
  input: AutomaticSinkingAllocationInput,
): MetricResult<AutomaticSinkingAllocationPlan> {
  const metadata = {
    asOf: input.liquidity.asOf,
    engineVersion: input.liquidity.engineVersion,
    settingsVersion: input.liquidity.settingsVersion,
    inputWatermark: input.liquidity.inputWatermark,
  } as const;
  if (
    input.sinkingProtection.asOf !== metadata.asOf ||
    input.sinkingProtection.engineVersion !== metadata.engineVersion ||
    input.sinkingProtection.settingsVersion !== metadata.settingsVersion ||
    input.sinkingProtection.inputWatermark !== metadata.inputWatermark
  ) {
    throw new FinancialEngineInvariantError(
      'automatic_sinking.metadata_mismatch',
      'Liquidity and Sinking protection must share one run envelope.',
    );
  }
  if (
    input.liquidity.status !== 'complete' ||
    input.liquidity.value === null ||
    input.sinkingProtection.status !== 'complete' ||
    input.sinkingProtection.value === null
  ) {
    return createMetricResult<AutomaticSinkingAllocationPlan>({
      ...metadata,
      status: 'unavailable',
      value: null,
      explanation: [],
      warnings: [warning('automatic_sinking.incomplete_inputs')],
    });
  }
  const liquidity = input.liquidity.value;
  const nonSinkingMinimum =
    liquidity.uncoveredObligations.amountMinor +
    (liquidity.operationalEssential.amountMinor > liquidity.minimumReserveTarget.amountMinor
      ? liquidity.operationalEssential.amountMinor
      : liquidity.minimumReserveTarget.amountMinor);
  const available =
    liquidity.currentLiquidCash.amountMinor -
    liquidity.ringFencedCash.amountMinor -
    nonSinkingMinimum;
  const allocatable = available > 0n ? available : 0n;
  const due = new Map(
    input.sinkingProtection.value.byFund.map((item) => [item.fundId, item.outstanding.amountMinor]),
  );
  const eligible = [...input.funds]
    .filter(
      (fund) =>
        fund.allocationPolicy === 'on_primary_income' && fund.committed && fund.status === 'active',
    )
    .sort(
      (left, right) =>
        left.dueDate.localeCompare(right.dueDate) ||
        left.priority - right.priority ||
        left.id.localeCompare(right.id),
    );
  if (new Set(input.funds.map((fund) => fund.id)).size !== input.funds.length) {
    throw new FinancialEngineInvariantError(
      'automatic_sinking.duplicate_fund',
      'Sinking Fund IDs must be unique.',
    );
  }
  let remaining = allocatable;
  const allocations: AutomaticSinkingAllocation[] = [];
  for (const fund of eligible) {
    const outstanding = due.get(fund.id) ?? 0n;
    const amount = outstanding < remaining ? outstanding : remaining;
    if (amount > 0n) {
      allocations.push(Object.freeze({ fundId: fund.id, amount: money(amount) }));
      remaining -= amount;
    }
    if (remaining === 0n) break;
  }
  const allocated = allocatable - remaining;
  return createMetricResult({
    ...metadata,
    status: 'complete',
    value: Object.freeze({
      allocations: Object.freeze(allocations),
      allocatableCash: money(allocatable),
      allocatedTotal: money(allocated),
      unallocatedCash: money(remaining),
    }),
    explanation: [
      {
        ruleId: 'automatic-sinking.non-sinking-minimum',
        inputKey: 'nonSinkingMinimum',
        value: nonSinkingMinimum.toString(),
      },
      {
        ruleId: 'automatic-sinking.allocated',
        inputKey: 'allocatedTotal',
        value: allocated.toString(),
      },
    ],
    warnings: [],
  });
}
