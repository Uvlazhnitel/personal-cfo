import { DomainValidationError } from './errors.js';
import { parseStringEnum } from './validation.js';

export const PROVISIONAL_INVESTABILITY_REASONS = [
  'non_material_unresolved_transfer',
  'non_material_cash_variance',
] as const;
export type ProvisionalInvestabilityReason = (typeof PROVISIONAL_INVESTABILITY_REASONS)[number];

export const BLOCKING_INVESTABILITY_REASONS = [
  'material_unresolved_transfer',
  'material_cash_variance',
  'incomplete_liquid_balance',
  'incomplete_spending_baseline',
  'incomplete_obligations',
  'incomplete_sinking_protection',
  'unknown_next_reliable_income',
  'other_material_incompleteness',
] as const;
export type BlockingInvestabilityReason = (typeof BLOCKING_INVESTABILITY_REASONS)[number];

export type InvestabilityReadiness =
  | Readonly<{ kind: 'complete' }>
  | Readonly<{
      kind: 'provisional';
      reasons: readonly ProvisionalInvestabilityReason[];
    }>
  | Readonly<{
      kind: 'blocked';
      reasons: readonly BlockingInvestabilityReason[];
    }>;

function validatedReasons<const Values extends readonly string[]>(
  reasons: unknown,
  allowed: Values,
  label: string,
): readonly Values[number][] {
  if (!Array.isArray(reasons) || reasons.length === 0) {
    throw new DomainValidationError(
      'investability.missing_reason',
      `${label} requires at least one reason.`,
    );
  }
  const parsed = reasons.map((reason) => parseStringEnum(reason, allowed, label));
  if (new Set(parsed).size !== parsed.length) {
    throw new DomainValidationError(
      'investability.duplicate_reason',
      `${label} reasons must be unique.`,
    );
  }
  return Object.freeze(
    parsed.sort((left, right) => allowed.indexOf(left) - allowed.indexOf(right)),
  );
}

export function createInvestabilityReadiness(
  value: InvestabilityReadiness,
): InvestabilityReadiness {
  const kind = parseStringEnum(
    value.kind,
    ['complete', 'provisional', 'blocked'] as const,
    'InvestabilityReadiness.kind',
  );
  if (kind === 'complete') return Object.freeze({ kind });
  if (kind === 'provisional') {
    return Object.freeze({
      kind,
      reasons: validatedReasons(
        (value as Extract<InvestabilityReadiness, { kind: 'provisional' }>).reasons,
        PROVISIONAL_INVESTABILITY_REASONS,
        'ProvisionalInvestabilityReason',
      ),
    });
  }
  return Object.freeze({
    kind,
    reasons: validatedReasons(
      (value as Extract<InvestabilityReadiness, { kind: 'blocked' }>).reasons,
      BLOCKING_INVESTABILITY_REASONS,
      'BlockingInvestabilityReason',
    ),
  });
}
