import { describe, expect, it } from 'vitest';

import {
  parseBankExternalFlowClassificationInput,
  parseCashAccountBootstrapInput,
  parseClassificationInput,
  parseDecisionHistoryBoundaryInput,
  parseEvaluationProfileBootstrapInput,
  parseMaterialitySettingsInput,
  parsePlanningContextUpdateInput,
  parseSpendingObservationInput,
  reviveMoney,
  serializeCommandResponse,
} from '../src/app/api/v1/commands/[command]/route.js';

describe('spending observation request', () => {
  it('accepts explicit consumption semantics and a semantics-free linked reversal', () => {
    expect(
      parseSpendingObservationInput({
        economicFlowId: 'flow-1',
        categoryCode: 'health',
        cadence: 'variable',
        irregular: true,
        reason: 'Owner confirmed.',
      }),
    ).toEqual({
      economicFlowId: 'flow-1',
      categoryCode: 'health',
      cadence: 'variable',
      irregular: true,
      reason: 'Owner confirmed.',
    });
    expect(
      parseSpendingObservationInput({ economicFlowId: 'flow-2', reason: 'Linked reversal.' }),
    ).toEqual({ economicFlowId: 'flow-2', reason: 'Linked reversal.' });
  });

  it.each([
    { economicFlowId: 'flow', categoryCode: 'health', cadence: 'variable', reason: 'missing bool' },
    {
      economicFlowId: 'flow',
      categoryCode: 'health',
      cadence: 'variable',
      irregular: true,
      necessity: 'essential',
      reason: 'forbidden',
    },
    { economicFlowId: 'flow', ownerId: 'caller-controlled', reason: 'forbidden' },
    { economicFlowId: 'flow', transactionId: 'caller-controlled', reason: 'forbidden' },
    { economicFlowId: 'flow', amountMinor: 100n, reason: 'forbidden' },
    { economicFlowId: 'flow', economicDate: '2026-09-26', reason: 'forbidden' },
  ])('rejects incomplete or caller-controlled fields %#', (request) => {
    expect(() => parseSpendingObservationInput(request)).toThrow();
  });
});

describe('planning context update request', () => {
  const request = {
    scheduledRecurring: [{ dueDate: '2026-11-03', amountMinor: 1_999n, categoryCode: 'sport' }],
    recurringScheduleComplete: true,
    operationalNeeds: [],
    operationalNeedsComplete: true,
    futureObligations: [],
    obligationsComplete: true,
    otherRestrictedCash: [],
    restrictedCashComplete: true,
    primaryPaySchedule: { kind: 'monthly_day_of_month', dayOfMonth: 5 },
    reason: 'Owner confirmed current planning declarations.',
  } as const;

  it('accepts explicit complete empty sets and the recurring gym schedule', () => {
    expect(
      parsePlanningContextUpdateInput(request, '2026-10-07T12:00:00Z', '2026-10-07'),
    ).toMatchObject({
      scheduledRecurring: [{ dueDate: '2026-11-03', amountMinor: 1_999n, categoryCode: 'sport' }],
      operationalNeeds: [],
      operationalNeedsComplete: true,
      primaryPaySchedule: { kind: 'monthly_day_of_month', dayOfMonth: 5 },
    });
  });

  it('rejects caller-controlled IDs, currency, and generated pay dates', () => {
    for (const invalid of [
      { ...request, ownerId: 'forbidden' },
      {
        ...request,
        scheduledRecurring: [
          { dueDate: '2026-11-03', amountMinor: 1_999n, categoryCode: 'sport', currency: 'EUR' },
        ],
      },
      {
        ...request,
        primaryPaySchedule: {
          kind: 'monthly_day_of_month',
          dayOfMonth: 5,
          dates: ['2026-11-05'],
        },
      },
      {
        ...request,
        scheduledRecurring: [{ dueDate: '2026-11-31', amountMinor: 1_999n, categoryCode: 'sport' }],
      },
      {
        ...request,
        primaryPaySchedule: { kind: 'monthly_day_of_month', dayOfMonth: 31 },
      },
    ]) {
      expect(() =>
        parsePlanningContextUpdateInput(invalid, '2026-10-07T12:00:00Z', '2026-10-07'),
      ).toThrow();
    }
  });
});

describe('bank external-flow classification request', () => {
  it('accepts only supported explicit classifications', () => {
    expect(
      parseBankExternalFlowClassificationInput({ kind: 'consumption', reimbursable: false }),
    ).toEqual({ kind: 'consumption', reimbursable: false });
    expect(
      parseBankExternalFlowClassificationInput({
        kind: 'reimbursement',
        relatedTransactionId: '01a108b9-2730-701f-8fd1-c28cd1920c5e',
      }),
    ).toEqual({
      kind: 'reimbursement',
      relatedTransactionId: '01a108b9-2730-701f-8fd1-c28cd1920c5e',
    });
    expect(parseBankExternalFlowClassificationInput({ kind: 'other_external_flow' })).toEqual({
      kind: 'other_external_flow',
    });
  });

  it.each([
    { kind: 'earned_income', earnedIncomeSource: 'other' },
    { kind: 'cash_reconciliation_adjustment' },
    { kind: 'reimbursement', relatedTransactionId: null },
    { kind: 'other_external_flow', ownerId: 'forbidden' },
  ])('rejects unsupported or identity-bearing input %#', (classification) => {
    expect(() => parseBankExternalFlowClassificationInput(classification)).toThrow();
  });
});

describe('classification correction request', () => {
  it('preserves an explicit supplemental salary decision', () => {
    expect(
      parseClassificationInput({
        kind: 'earned_income',
        earnedIncomeSource: 'salary',
        primarySalary: false,
      }),
    ).toEqual({
      kind: 'earned_income',
      earnedIncomeSource: 'salary',
      primarySalary: false,
    });
  });

  it('rejects a non-boolean primary salary value', () => {
    expect(() =>
      parseClassificationInput({
        kind: 'earned_income',
        earnedIncomeSource: 'salary',
        primarySalary: 'false',
      }),
    ).toThrow(expect.objectContaining({ code: 'http.invalid_request' }));
  });
});

describe('materiality settings command request', () => {
  it('accepts an exact non-negative EUR minor-unit amount and explicit reason', () => {
    const request = reviveMoney({
      amountMinor: '10000',
      currency: 'EUR',
      reason: 'Owner approved the production materiality threshold.',
    });
    expect(parseMaterialitySettingsInput(request, '2026-09-28T12:00:00Z', '2026-09-28')).toEqual({
      amountMinor: 10_000n,
      currency: 'EUR',
      effectiveAt: '2026-09-28T12:00:00Z',
      effectiveDate: '2026-09-28',
      reason: 'Owner approved the production materiality threshold.',
    });
  });

  it.each([
    [{ amountMinor: -1n, currency: 'EUR', reason: 'negative' }, 'settings.invalid_materiality'],
    [
      { amountMinor: 10_000n, currency: 'USD', reason: 'wrong currency' },
      'settings.invalid_materiality',
    ],
    [{ amountMinor: 10_000n, currency: 'EUR', reason: '' }, 'http.invalid_request'],
    [
      { amountMinor: 10_000n, currency: 'EUR', reason: 'extra', ownerId: 'forbidden' },
      'http.unsupported_fields',
    ],
  ])('rejects an invalid or over-scoped request', (request, code) => {
    expect(() =>
      parseMaterialitySettingsInput(request, '2026-09-28T12:00:00Z', '2026-09-28'),
    ).toThrow(expect.objectContaining({ code }));
  });

  it('serializes the command input version as a JSON-safe decimal string', () => {
    const response = serializeCommandResponse({
      commandId: '018f0000-0000-7000-8000-000000000001',
      replayed: false,
      mutated: true,
      inputVersion: 9_007_199_254_740_993n,
      result: Object.freeze({ accepted: true }),
    });
    expect(response).toMatchObject({ inputVersion: '9007199254740993' });
    expect(() => JSON.stringify(response)).not.toThrow();
  });
});

describe('evaluation profile bootstrap request', () => {
  it('accepts only an explicit reason', () => {
    expect(
      parseEvaluationProfileBootstrapInput({
        reason: 'Owner approved a conservative production engine profile.',
      }),
    ).toEqual({ reason: 'Owner approved a conservative production engine profile.' });
  });

  it.each([
    [{ reason: '' }, 'http.invalid_request'],
    [{ reason: 'approved', ownerId: 'forbidden' }, 'http.unsupported_fields'],
    [{ reason: 'approved', current: {} }, 'http.unsupported_fields'],
  ])('rejects missing or caller-controlled profile state', (request, code) => {
    expect(() => parseEvaluationProfileBootstrapInput(request)).toThrow(
      expect.objectContaining({ code }),
    );
  });
});

describe('cash account bootstrap request', () => {
  it('accepts only an explicit balance, instant, and reason', () => {
    const request = reviveMoney({
      openingBalanceMinor: '12500',
      effectiveAt: '2026-07-01T00:00:00Z',
      reason: 'Owner confirmed the cash cutover balance.',
    });
    expect(parseCashAccountBootstrapInput(request)).toEqual({
      openingBalanceMinor: 12_500n,
      effectiveAt: '2026-07-01T00:00:00Z',
      reason: 'Owner confirmed the cash cutover balance.',
    });
  });

  it.each([
    [
      { openingBalanceMinor: -1n, effectiveAt: '2026-07-01T00:00:00Z', reason: 'invalid' },
      'cash_account.invalid_opening_balance',
    ],
    [
      { openingBalanceMinor: 0n, effectiveAt: '2026-07-01T00:00:00Z', reason: '' },
      'http.invalid_request',
    ],
    [
      {
        openingBalanceMinor: 0n,
        effectiveAt: '2026-07-01T00:00:00Z',
        reason: 'approved',
        ownerId: 'forbidden',
      },
      'http.unsupported_fields',
    ],
    [
      {
        openingBalanceMinor: 0n,
        effectiveAt: '2026-07-01T00:00:00Z',
        reason: 'approved',
        currency: 'EUR',
      },
      'http.unsupported_fields',
    ],
  ])('rejects invalid or caller-controlled state', (request, code) => {
    expect(() => parseCashAccountBootstrapInput(request)).toThrow(
      expect.objectContaining({ code }),
    );
  });
});

describe('decision history boundary request', () => {
  it('accepts only an owner-confirmed local start date and reason', () => {
    expect(
      parseDecisionHistoryBoundaryInput({
        startDate: '2026-07-01',
        reason: 'Owner approved reliable decision history from July.',
      }),
    ).toEqual({
      startDate: '2026-07-01',
      reason: 'Owner approved reliable decision history from July.',
    });
  });

  it.each([
    [{ startDate: '', reason: 'approved' }, 'http.invalid_request'],
    [{ startDate: '2026-07-01', reason: '' }, 'http.invalid_request'],
    [
      { startDate: '2026-07-01', reason: 'approved', ownerId: 'forbidden' },
      'http.unsupported_fields',
    ],
    [
      { startDate: '2026-07-01', reason: 'approved', endExclusive: 'caller-controlled' },
      'http.unsupported_fields',
    ],
  ])('rejects missing or caller-controlled boundary state', (request, code) => {
    expect(() => parseDecisionHistoryBoundaryInput(request)).toThrow(
      expect.objectContaining({ code }),
    );
  });
});
