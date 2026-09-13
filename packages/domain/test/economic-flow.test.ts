import { describe, expect, it } from 'vitest';

import {
  DomainValidationError,
  EUR,
  createCashReconciliation,
  createEconomicFlow,
  createFlowAmbiguity,
  createMeasurementPeriod,
  createMoney,
  parseAccountId,
  parseCashReconciliationId,
  parseEconomicFlowId,
  parseInstant,
  parseTransactionId,
  periodContains,
} from '../src/index.js';

function uuid(seed: number): string {
  return `01890f3e-7b2c-7${seed.toString(16).padStart(3, '0')}-8abc-${seed
    .toString(16)
    .padStart(12, '0')}`;
}

describe('Stage 2B domain facts', () => {
  it('creates immutable explicit economic-flow classifications', () => {
    const flow = createEconomicFlow({
      id: parseEconomicFlowId(uuid(1)),
      transactionId: parseTransactionId(uuid(2)),
      effectiveAt: parseInstant('2026-09-15T12:00:00Z'),
      amount: createMoney(30_000n, EUR),
      kind: 'earned_income',
      source: 'side_hustle',
    });

    expect(flow).toMatchObject({ kind: 'earned_income', source: 'side_hustle' });
    expect(Object.isFrozen(flow)).toBe(true);
  });

  it('uses start-inclusive and end-exclusive measurement periods', () => {
    const period = createMeasurementPeriod({
      startInclusive: parseInstant('2026-09-01T00:00:00Z'),
      endExclusive: parseInstant('2026-10-01T00:00:00Z'),
    });

    expect(periodContains(period, period.startInclusive)).toBe(true);
    expect(periodContains(period, period.endExclusive)).toBe(false);
    expect(() =>
      createMeasurementPeriod({
        startInclusive: period.endExclusive,
        endExclusive: period.startInclusive,
      }),
    ).toThrowError(DomainValidationError);
  });

  it('validates an audited cash reconciliation and exact signed variance', () => {
    const reconciliation = createCashReconciliation({
      id: parseCashReconciliationId(uuid(1)),
      accountId: parseAccountId(uuid(2)),
      calculatedBalance: createMoney(14_000n, EUR),
      countedBalance: createMoney(12_500n, EUR),
      variance: createMoney(-1_500n, EUR),
      reconciledAt: parseInstant('2026-09-15T12:00:00Z'),
      actor: 'local-user',
      reason: null,
      materiality: 'material',
      adjustmentTransactionId: parseTransactionId(uuid(3)),
    });

    expect(reconciliation.variance.amountMinor).toBe(-1_500n);
    expect(Object.isFrozen(reconciliation)).toBe(true);
    expect(() =>
      createCashReconciliation({ ...reconciliation, variance: createMoney(-1n, EUR) }),
    ).toThrowError(DomainValidationError);
  });

  it('validates provider-neutral ambiguity facts', () => {
    const ambiguity = createFlowAmbiguity({
      transactionId: parseTransactionId(uuid(1)),
      effectiveAt: parseInstant('2026-09-15T12:00:00Z'),
      kind: 'unresolved_transfer',
      materiality: 'non_material',
    });

    expect(ambiguity).toMatchObject({ kind: 'unresolved_transfer', materiality: 'non_material' });
  });
});
