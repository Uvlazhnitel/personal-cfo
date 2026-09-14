import {
  EUR,
  createForwardLiquidityProjectionCoverage,
  createForwardLiquidityProjectionDay,
  createForwardLiquidityProtectionDay,
  createForwardProjectionCashFlow,
  createMetricResult,
  createRecurringInvestmentSchedule,
  parseInstant,
  parseLocalDate,
} from '@personal-cfo/domain';
import type {
  DataWarning,
  ForwardLiquidityProjectionCoverage,
  ForwardLiquidityProjectionDay,
  ForwardLiquidityProtectionDay,
  ForwardProjectionCashFlow,
  Instant,
  LocalDate,
  MetricResult,
  RecurringInvestmentSchedule,
} from '@personal-cfo/domain';

import { FinancialEngineInvariantError } from './errors.js';
import type { ForwardLiquidityStressScenario, InvestmentStepSettings } from './investment-step.js';
import type { LiquidityReserve } from './liquidity.js';
import { addLocalDays } from './local-calendar.js';

export type ForwardProjectionSource = Readonly<{
  cashFlows: readonly ForwardProjectionCashFlow[];
  protectionDays: readonly ForwardLiquidityProtectionDay[];
  coverage: ForwardLiquidityProjectionCoverage;
  contributionSchedule: RecurringInvestmentSchedule;
}>;

export type ForwardProjectionAssemblyInput = Readonly<{
  currentLiquidity: MetricResult<LiquidityReserve>;
  source: ForwardProjectionSource;
  effectiveDate: LocalDate;
  settings: InvestmentStepSettings;
  asOf: Instant;
  engineVersion: string;
  settingsVersion: string;
  inputWatermark: string;
}>;

function warning(code: string, context: Readonly<Record<string, string>> = {}): DataWarning {
  return Object.freeze({ code, context: Object.freeze({ ...context }) });
}

function requireUnique(values: readonly string[], code: string, message: string): void {
  if (new Set(values).size !== values.length)
    throw new FinancialEngineInvariantError(code, message);
}

export function assembleForwardLiquidityProjection(
  input: ForwardProjectionAssemblyInput,
): MetricResult<ForwardLiquidityStressScenario> {
  const asOf = parseInstant(input.asOf);
  const effectiveDate = parseLocalDate(input.effectiveDate);
  const base = {
    asOf,
    engineVersion: input.engineVersion,
    settingsVersion: input.settingsVersion,
    inputWatermark: input.inputWatermark,
  } as const;
  if (
    input.currentLiquidity.asOf !== asOf ||
    input.currentLiquidity.settingsVersion !== input.settingsVersion
  ) {
    throw new FinancialEngineInvariantError(
      'forward_projection.metadata_mismatch',
      'Current liquidity must share the projection run envelope.',
    );
  }
  if (input.currentLiquidity.value === null) {
    return createMetricResult<ForwardLiquidityStressScenario>({
      ...base,
      status: 'unavailable',
      value: null,
      explanation: [],
      warnings: [warning('forward_projection.missing_current_liquidity')],
    });
  }
  const coverage = createForwardLiquidityProjectionCoverage(input.source.coverage);
  const schedule = createRecurringInvestmentSchedule(input.source.contributionSchedule);
  const flows = input.source.cashFlows.map((item) => createForwardProjectionCashFlow(item));
  const protection = input.source.protectionDays.map((item) =>
    createForwardLiquidityProtectionDay(item),
  );
  requireUnique(
    flows.map((item) => item.id),
    'forward_projection.duplicate_flow',
    'Forward projection cash-flow IDs must be unique.',
  );
  requireUnique(
    protection.map((item) => item.date),
    'forward_projection.duplicate_protection_date',
    'Forward protection dates must be unique.',
  );
  if (
    flows.some((item) => item.amount.currency !== EUR) ||
    protection.some((item) => item.ringFencedCash.currency !== EUR)
  ) {
    throw new FinancialEngineInvariantError(
      'forward_projection.currency_mismatch',
      'Stage 2G forward projection source facts must use EUR.',
    );
  }
  const horizonStart = addLocalDays(effectiveDate, 1);
  const horizonEnd = addLocalDays(effectiveDate, input.settings.stressHorizonDays);
  if (
    flows.some((item) => item.date < horizonStart || item.date > horizonEnd) ||
    protection.some((item) => item.date < horizonStart || item.date > horizonEnd)
  ) {
    throw new FinancialEngineInvariantError(
      'forward_projection.outside_horizon',
      'Forward source facts must stay inside the configured horizon.',
    );
  }
  const coverageValues = Object.values(coverage);
  if (coverageValues.includes('unavailable')) {
    return createMetricResult<ForwardLiquidityStressScenario>({
      ...base,
      status: 'unavailable',
      value: null,
      explanation: [],
      warnings: [warning('forward_projection.unavailable_source_coverage')],
    });
  }
  const protectionByDate = new Map(protection.map((item) => [item.date, item]));
  const flowsByDate = new Map<LocalDate, ForwardProjectionCashFlow[]>();
  for (const flow of flows) {
    const group = flowsByDate.get(flow.date) ?? [];
    group.push(flow);
    flowsByDate.set(flow.date, group);
  }
  let baseCash = input.currentLiquidity.value.currentLiquidCash.amountMinor;
  const days: ForwardLiquidityProjectionDay[] = [];
  for (let offset = 1; offset <= input.settings.stressHorizonDays; offset += 1) {
    const date = addLocalDays(effectiveDate, offset);
    const dayProtection = protectionByDate.get(date);
    if (dayProtection === undefined) continue;
    const dayFlows = flowsByDate.get(date) ?? [];
    const total = (kind: ForwardProjectionCashFlow['kind']) =>
      dayFlows
        .filter((item) => item.kind === kind)
        .reduce((sum, item) => sum + item.amount.amountMinor, 0n);
    const salary = total('expected_primary_salary');
    const spending = total('normal_spending');
    const obligations = total('committed_obligation');
    const sinkingSpend = total('sinking_funded_spending');
    baseCash += salary - spending - obligations - sinkingSpend;
    const protectedBase =
      dayProtection.ringFencedCash.amountMinor +
      dayProtection.currentCycleSinkingDue.amountMinor +
      dayProtection.uncoveredObligations.amountMinor;
    const minimum =
      protectedBase +
      (dayProtection.operationalEssential.amountMinor >
      dayProtection.minimumReserveTarget.amountMinor
        ? dayProtection.operationalEssential.amountMinor
        : dayProtection.minimumReserveTarget.amountMinor);
    const comfort =
      protectedBase +
      (dayProtection.operationalNormal.amountMinor > dayProtection.comfortReserveTarget.amountMinor
        ? dayProtection.operationalNormal.amountMinor
        : dayProtection.comfortReserveTarget.amountMinor);
    days.push(
      createForwardLiquidityProjectionDay({
        date,
        expectedPrimarySalaryInflow: { amountMinor: salary, currency: EUR },
        normalSpendingOutflow: { amountMinor: spending, currency: EUR },
        committedObligationOutflow: { amountMinor: obligations, currency: EUR },
        sinkingFundedSpendingOutflow: { amountMinor: sinkingSpend, currency: EUR },
        sinkingProtectedCash: {
          amountMinor:
            dayProtection.ringFencedCash.amountMinor +
            dayProtection.currentCycleSinkingDue.amountMinor,
          currency: EUR,
        },
        baseLiquidCashBeforeContribution: { amountMinor: baseCash, currency: EUR },
        minimumCash: { amountMinor: minimum, currency: EUR },
        comfortCash: { amountMinor: comfort, currency: EUR },
        completeness:
          dayProtection.completeness === 'complete' &&
          coverageValues.every((item) => item === 'complete')
            ? 'complete'
            : 'partial',
      }),
    );
  }
  const complete =
    input.currentLiquidity.status === 'complete' &&
    coverageValues.every((item) => item === 'complete') &&
    days.length === input.settings.stressHorizonDays &&
    days.every((item) => item.completeness === 'complete');
  const value = Object.freeze({
    effectiveDate,
    projectionDays: Object.freeze(days),
    projectionCoverage: coverage,
    contributionSchedule: schedule,
  });
  return createMetricResult({
    ...base,
    status: complete ? 'complete' : 'partial',
    value,
    explanation: Object.freeze([
      {
        ruleId: 'forward-projection.derived-days',
        inputKey: 'projectionDays',
        value: days.length.toString(),
      },
    ]),
    warnings: complete ? [] : [warning('forward_projection.partial')],
  });
}
