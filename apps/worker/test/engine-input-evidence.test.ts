import {
  EUR,
  createAccount,
  createAccountEntry,
  createAccountBalanceSnapshot,
  createCanonicalTransaction,
  createMoney,
  createNativeReportableAmount,
} from '@personal-cfo/domain';
import { describe, expect, it } from 'vitest';
import { generateUuidV7 } from '@personal-cfo/data';
import type { FinancialEngineInput } from '@personal-cfo/financial-engine';

import { deriveEvidenceBackedCurrentContext } from '../src/engine-input.js';

function fixture(
  options: Readonly<{
    missingBalance?: boolean;
    reconciliationStatus?: string;
    ambiguityMateriality?: 'material' | 'non_material';
    incompleteReservationCoverage?: boolean;
  }> = {},
) {
  const bankId = generateUuidV7('evidence-bank') as never;
  const cashId = generateUuidV7('evidence-cash') as never;
  const openingId = generateUuidV7('evidence-opening') as never;
  const unknownId = generateUuidV7('evidence-unknown') as never;
  const accounts = [
    createAccount({
      id: bankId,
      subtype: 'bank',
      currency: EUR,
      includeInNetWorth: true,
      valueSource: 'balance_snapshot',
      brokerageCashFor: null,
    }),
    createAccount({
      id: cashId,
      subtype: 'cash',
      currency: EUR,
      includeInNetWorth: true,
      valueSource: 'ledger',
      brokerageCashFor: null,
    }),
  ];
  const transactions = [
    createCanonicalTransaction({
      id: openingId,
      effectiveAt: '2026-07-01T00:00:00Z' as never,
      bookingStatus: 'booked',
      kind: 'opening_balance',
      entries: [
        createAccountEntry({
          id: generateUuidV7('evidence-opening-entry') as never,
          transactionId: openingId,
          accountId: cashId,
          amount: createMoney(123_000n, EUR),
          role: 'opening_balance',
        }),
      ],
    }),
    createCanonicalTransaction({
      id: unknownId,
      effectiveAt: '2026-07-12T09:00:00Z' as never,
      bookingStatus: 'booked',
      kind: 'external_flow',
      entries: [
        createAccountEntry({
          id: generateUuidV7('evidence-unknown-entry') as never,
          transactionId: unknownId,
          accountId: bankId,
          amount: createMoney(-5_000n, EUR),
          role: 'external_flow',
        }),
      ],
    }),
  ];
  const current = {
    monthCoverage: [],
    scheduledRecurring: [],
    recurringScheduleComplete: false,
    operationalNeeds: [],
    futureObligations: [],
    otherRestrictedCash: [],
    nextReliableIncomeDate: null,
    expectedPrimaryPaySchedule: { dates: [], completeThrough: '2026-10-07' },
    historyCoverage: {
      startInclusive: '2026-06-30T21:00:00Z',
      endExclusive: '2026-10-07T03:00:00Z',
    },
    reservationCoverage: {
      startInclusive: '2026-06-30T21:00:00Z',
      endExclusive: options.incompleteReservationCoverage
        ? '2026-10-07T03:00:00Z'
        : '2026-10-07T03:00:00.001Z',
    },
    quality: {
      liquidityInputs: {
        operationalNeeds: 'unavailable',
        obligations: 'unavailable',
        restrictedCash: 'unavailable',
      },
      liquidBalance: 'unavailable',
      spendingClassification: 'unavailable',
      reservationHistory: 'unavailable',
    },
  } as unknown as FinancialEngineInput['current'];
  const canonical = {
    accounts,
    transactions,
    investmentContributions: [],
    economicFlows: [],
    ambiguities: [
      {
        transactionId: unknownId,
        effectiveAt: '2026-07-12T09:00:00Z',
        kind: 'unclassified_external_flow',
        materiality: options.ambiguityMateriality ?? 'non_material',
      },
    ],
    cashReconciliations: [],
    sinkingFunds: [],
    sinkingFundAllocations: [],
    spendingObservations: [],
    accountBalanceSnapshots: options.missingBalance
      ? []
      : [
          createAccountBalanceSnapshot({
            accountId: bankId,
            value: createNativeReportableAmount(createMoney(111_314n, EUR)),
            sourceAsOf: '2026-10-06T21:00:00Z' as never,
            staleAt: '2026-10-08T21:00:00Z' as never,
          }),
        ],
    portfolioValuations: [],
    primarySalaryTriggers: [],
  } as unknown as FinancialEngineInput['canonical'];
  return {
    current,
    canonical,
    bankCoverage: [{ coveredFrom: '2024-09-27', coveredThrough: '2026-10-07' }],
    bankReconciliations: [
      {
        canonicalAccountId: bankId,
        sourceAsOf: '2026-10-06T21:00:00Z',
        differenceMinor:
          options.reconciliationStatus === 'reconciled' ||
          options.reconciliationStatus === undefined
            ? 0n
            : 1n,
        currency: 'EUR',
        status: options.reconciliationStatus ?? 'reconciled',
      },
    ],
    asOf: '2026-10-07T03:00:00Z' as never,
    effectiveDate: '2026-10-07',
    settingsVersion: 'settings-v1',
    engineVersion: 'stage2g.1.0',
    inputWatermark: 'owner:test:v1',
  };
}

describe('evidence-backed engine input', () => {
  it('promotes complete reconciled liquid evidence and authoritative empty reservations', () => {
    const result = deriveEvidenceBackedCurrentContext(fixture());
    expect(result.quality.liquidBalance).toBe('complete');
    expect(result.quality.reservationHistory).toBe('complete');
    expect(result.quality.spendingClassification).toBe('partial');
    expect(result.monthCoverage).toHaveLength(3);
    expect(result.monthCoverage[0]).toMatchObject({
      month: '2026-07',
      reconciled: true,
      materialAmbiguityFree: true,
      fxComplete: true,
      spendingClassificationComplete: false,
    });
  });

  it('fails closed for mismatch and missing reportable balance evidence', () => {
    expect(
      deriveEvidenceBackedCurrentContext(fixture({ reconciliationStatus: 'material_mismatch' }))
        .quality.liquidBalance,
    ).not.toBe('complete');
    expect(
      deriveEvidenceBackedCurrentContext(fixture({ missingBalance: true })).quality.liquidBalance,
    ).toBe('unavailable');
  });

  it('preserves non-banking authoritative quality when no bank evidence source is present', () => {
    const input = fixture();
    const existingCoverage = Object.freeze([
      Object.freeze({
        month: '2026-07' as never,
        reconciled: true,
        materialAmbiguityFree: true,
        fxComplete: true,
        spendingClassificationComplete: true,
      }),
    ]);
    const result = deriveEvidenceBackedCurrentContext({
      ...input,
      bankCoverage: [],
      bankReconciliations: [],
      current: {
        ...input.current,
        monthCoverage: existingCoverage,
        quality: {
          ...input.current.quality,
          liquidBalance: 'complete',
          spendingClassification: 'complete',
        },
      },
    });
    expect(result.quality.liquidBalance).toBe('complete');
    expect(result.quality.spendingClassification).toBe('complete');
    expect(result.monthCoverage).toBe(existingCoverage);
  });

  it('keeps incomplete reservations unavailable and material ambiguities visible by month', () => {
    const result = deriveEvidenceBackedCurrentContext(
      fixture({ ambiguityMateriality: 'material', incompleteReservationCoverage: true }),
    );
    expect(result.quality.reservationHistory).toBe('unavailable');
    expect(result.monthCoverage[0]?.materialAmbiguityFree).toBe(false);
    expect(result.monthCoverage[0]?.spendingClassificationComplete).toBe(false);
  });
});
