import type { ForwardProjectionFlowId } from './domain-id.js';
import { parseForwardProjectionFlowId } from './domain-id.js';
import type { LocalDate } from './local-date.js';
import { parseLocalDate } from './local-date.js';
import type { Money } from './money.js';
import { createMoney } from './money.js';
import type { Completeness } from './completeness.js';
import { parseCompleteness } from './completeness.js';
import { DomainValidationError } from './errors.js';
import { parseStringEnum } from './validation.js';

export const FORWARD_PROJECTION_FLOW_KINDS = [
  'expected_primary_salary',
  'normal_spending',
  'committed_obligation',
  'sinking_funded_spending',
] as const;
export type ForwardProjectionFlowKind = (typeof FORWARD_PROJECTION_FLOW_KINDS)[number];

export type ForwardProjectionCashFlow = Readonly<{
  id: ForwardProjectionFlowId;
  date: LocalDate;
  kind: ForwardProjectionFlowKind;
  amount: Money;
}>;

export function createForwardProjectionCashFlow(
  value: ForwardProjectionCashFlow,
): ForwardProjectionCashFlow {
  const amount = createMoney(value.amount.amountMinor, value.amount.currency);
  if (amount.amountMinor <= 0n) {
    throw new DomainValidationError(
      'forward_projection.non_positive_flow',
      'Forward projection cash-flow magnitudes must be positive.',
    );
  }
  return Object.freeze({
    id: parseForwardProjectionFlowId(value.id),
    date: parseLocalDate(value.date),
    kind: parseStringEnum(value.kind, FORWARD_PROJECTION_FLOW_KINDS, 'ForwardProjectionFlowKind'),
    amount,
  });
}

export type ForwardLiquidityProtectionDay = Readonly<{
  date: LocalDate;
  ringFencedCash: Money;
  currentCycleSinkingDue: Money;
  uncoveredObligations: Money;
  operationalEssential: Money;
  operationalNormal: Money;
  minimumReserveTarget: Money;
  comfortReserveTarget: Money;
  completeness: Completeness;
}>;

export function createForwardLiquidityProtectionDay(
  value: ForwardLiquidityProtectionDay,
): ForwardLiquidityProtectionDay {
  const result = {
    date: parseLocalDate(value.date),
    ringFencedCash: createMoney(value.ringFencedCash.amountMinor, value.ringFencedCash.currency),
    currentCycleSinkingDue: createMoney(
      value.currentCycleSinkingDue.amountMinor,
      value.currentCycleSinkingDue.currency,
    ),
    uncoveredObligations: createMoney(
      value.uncoveredObligations.amountMinor,
      value.uncoveredObligations.currency,
    ),
    operationalEssential: createMoney(
      value.operationalEssential.amountMinor,
      value.operationalEssential.currency,
    ),
    operationalNormal: createMoney(
      value.operationalNormal.amountMinor,
      value.operationalNormal.currency,
    ),
    minimumReserveTarget: createMoney(
      value.minimumReserveTarget.amountMinor,
      value.minimumReserveTarget.currency,
    ),
    comfortReserveTarget: createMoney(
      value.comfortReserveTarget.amountMinor,
      value.comfortReserveTarget.currency,
    ),
    completeness: parseCompleteness(value.completeness),
  };
  const amounts = [
    result.ringFencedCash,
    result.currentCycleSinkingDue,
    result.uncoveredObligations,
    result.operationalEssential,
    result.operationalNormal,
    result.minimumReserveTarget,
    result.comfortReserveTarget,
  ];
  if (
    new Set(amounts.map((item) => item.currency)).size !== 1 ||
    amounts.some((item) => item.amountMinor < 0n) ||
    result.operationalEssential.amountMinor > result.operationalNormal.amountMinor ||
    result.minimumReserveTarget.amountMinor > result.comfortReserveTarget.amountMinor
  ) {
    throw new DomainValidationError(
      'forward_projection.invalid_protection',
      'Projected protection must use ordered, non-negative amounts in one currency.',
    );
  }
  return Object.freeze(result);
}
