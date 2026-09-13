import {
  EUR,
  compareInstants,
  createCashReconciliation,
  createEconomicFlow,
  createFlowAmbiguity,
  createMeasurementPeriod,
  createMetricResult,
  createMoney,
  parseInstant,
  periodContains,
} from '@personal-cfo/domain';
import type {
  CashReconciliation,
  DataWarning,
  EconomicFlow,
  FlowAmbiguity,
  ExplanationComponent,
  Instant,
  MeasurementPeriod,
  MetricResult,
  Money,
  SinkingFund,
  SinkingFundAllocation,
} from '@personal-cfo/domain';

import { FinancialEngineInvariantError } from './errors.js';
import type { LedgerInput, ValidatedLedger } from './ledger.js';
import { validateLedger } from './ledger.js';
import { calculateReservationEffect } from './sinking-funds.js';

export type CapitalCreatedBreakdown = Readonly<{
  recognizedIncome: Money;
  grossConsumption: Money;
  refunds: Money;
  reimbursements: Money;
  netConsumption: Money;
  shortTermReservedFundsChange: Money;
  otherExternalInflows: Money;
  otherExternalOutflows: Money;
  cashReconciliationAdjustments: Money;
  capitalCreated: Money;
}>;

export type ExactRatio = Readonly<{
  numerator: bigint;
  denominator: bigint;
}>;

export type CapitalConversionRateValue = Readonly<{
  recognizedIncome: Money;
  grossConsumption: Money;
  refunds: Money;
  reimbursements: Money;
  netConsumption: Money;
  shortTermReservedFundsChange: Money;
  otherExternalInflows: Money;
  otherExternalOutflows: Money;
  cashReconciliationAdjustments: Money;
  capitalCreated: Money;
  ratio: ExactRatio;
}>;

export type CapitalConversionInput = LedgerInput &
  Readonly<{
    economicFlows: readonly EconomicFlow[];
    cashReconciliations: readonly CashReconciliation[];
    ambiguities: readonly FlowAmbiguity[];
    period: MeasurementPeriod;
    historyCoverage: MeasurementPeriod;
    sinkingFunds: readonly SinkingFund[];
    sinkingFundAllocations: readonly SinkingFundAllocation[];
    reservationCoverage: MeasurementPeriod;
    asOf: Instant;
    engineVersion: string;
    settingsVersion: string;
    inputWatermark: string;
  }>;

export type RollingCapitalConversionInput = Omit<CapitalConversionInput, 'period'> &
  Readonly<{ periods: readonly MeasurementPeriod[] }>;

export type RollingCapitalConversionResult = Readonly<{
  period: MeasurementPeriod;
  result: MetricResult<CapitalConversionRateValue>;
}>;

type ValidatedInput = Readonly<{
  ledger: ValidatedLedger;
  flows: readonly EconomicFlow[];
  reconciliations: readonly CashReconciliation[];
  ambiguities: readonly FlowAmbiguity[];
  period: MeasurementPeriod;
  historyCoverage: MeasurementPeriod;
  reserveChange: Money | null;
  reservationWarnings: readonly DataWarning[];
  asOf: Instant;
}>;

function requireUnique(values: readonly string[], code: string, message: string): void {
  if (new Set(values).size !== values.length) {
    throw new FinancialEngineInvariantError(code, message);
  }
}

function transactionAmountMinor(flow: EconomicFlow): bigint {
  switch (flow.kind) {
    case 'consumption':
      return -flow.amount.amountMinor;
    case 'earned_income':
    case 'refund':
    case 'reimbursement':
      return flow.amount.amountMinor;
    case 'cash_reconciliation_adjustment':
    case 'other_external_flow':
      return flow.amount.amountMinor;
  }
}

function validateFlowTransactions(ledger: ValidatedLedger, flows: readonly EconomicFlow[]): void {
  const transactions = new Map(
    ledger.transactions.map((transaction) => [transaction.id, transaction]),
  );

  requireUnique(
    flows.map((flow) => flow.id),
    'capital_conversion.duplicate_flow_id',
    'Economic flow IDs must be unique.',
  );
  requireUnique(
    flows.map((flow) => flow.transactionId),
    'capital_conversion.duplicate_flow_transaction',
    'A transaction can have only one economic-flow classification.',
  );

  for (const flow of flows) {
    const transaction = transactions.get(flow.transactionId);
    const expectedKind =
      flow.kind === 'cash_reconciliation_adjustment' ? 'valuation_adjustment' : 'external_flow';

    if (
      transaction === undefined ||
      transaction.kind !== expectedKind ||
      transaction.bookingStatus !== 'booked' ||
      transaction.effectiveAt !== flow.effectiveAt ||
      transaction.entries.length !== 1
    ) {
      throw new FinancialEngineInvariantError(
        'capital_conversion.invalid_flow_transaction',
        'An economic flow must match its booked canonical transaction.',
      );
    }
    if (flow.amount.currency !== EUR) {
      throw new FinancialEngineInvariantError(
        'capital_conversion.reporting_currency_mismatch',
        'Stage 2B economic flows must use canonical EUR reporting amounts.',
      );
    }
    if (
      (flow.kind === 'consumption' || flow.kind === 'refund' || flow.kind === 'reimbursement') &&
      flow.amount.amountMinor <= 0n
    ) {
      throw new FinancialEngineInvariantError(
        'capital_conversion.invalid_flow_sign',
        'Consumption, refunds, and reimbursements use positive magnitudes.',
      );
    }

    const entriesTotal = transaction.entries.reduce((sum, entry) => {
      if (entry.amount.currency !== EUR) {
        throw new FinancialEngineInvariantError(
          'capital_conversion.entry_currency_mismatch',
          'A Stage 2B classified transaction must contain EUR entries.',
        );
      }
      return sum + entry.amount.amountMinor;
    }, 0n);

    if (entriesTotal !== transactionAmountMinor(flow)) {
      throw new FinancialEngineInvariantError(
        'capital_conversion.flow_amount_mismatch',
        'An economic-flow amount must reconcile to its canonical transaction entries.',
      );
    }
  }
}

function validateReversals(flows: readonly EconomicFlow[]): void {
  const byTransaction = new Map(flows.map((flow) => [flow.transactionId, flow]));
  const applied = new Map<string, bigint>();

  for (const flow of flows) {
    if (flow.kind !== 'refund' && flow.kind !== 'reimbursement') continue;
    if (flow.relatedTransactionId === null) continue;
    const original = byTransaction.get(flow.relatedTransactionId);

    if (original?.kind !== 'consumption') {
      throw new FinancialEngineInvariantError(
        'capital_conversion.invalid_reversal_target',
        'A refund or reimbursement must reference canonical consumption.',
      );
    }
    if (flow.kind === 'reimbursement' && !original.reimbursable) {
      throw new FinancialEngineInvariantError(
        'capital_conversion.non_reimbursable_target',
        'A reimbursement must reference reimbursable consumption.',
      );
    }
    if (original.amount.currency !== flow.amount.currency) {
      throw new FinancialEngineInvariantError(
        'capital_conversion.reversal_currency_mismatch',
        'A reversal must use the original consumption currency.',
      );
    }

    const total = (applied.get(original.transactionId) ?? 0n) + flow.amount.amountMinor;
    if (total > original.amount.amountMinor) {
      throw new FinancialEngineInvariantError(
        'capital_conversion.reversal_exceeds_consumption',
        'Linked refunds and reimbursements cannot exceed original consumption.',
      );
    }
    applied.set(original.transactionId, total);
  }
}

function validateAmbiguities(
  ledger: ValidatedLedger,
  flows: readonly EconomicFlow[],
  ambiguities: readonly FlowAmbiguity[],
): void {
  requireUnique(
    ambiguities.map((ambiguity) => ambiguity.transactionId),
    'capital_conversion.duplicate_ambiguity',
    'A transaction can have only one active economic-flow ambiguity.',
  );
  const transactions = new Map(
    ledger.transactions.map((transaction) => [transaction.id, transaction]),
  );
  const flowsByTransaction = new Map(flows.map((flow) => [flow.transactionId, flow]));

  for (const ambiguity of ambiguities) {
    const transaction = transactions.get(ambiguity.transactionId);
    const flow = flowsByTransaction.get(ambiguity.transactionId);
    if (
      transaction === undefined ||
      transaction.kind !== 'external_flow' ||
      transaction.effectiveAt !== ambiguity.effectiveAt
    ) {
      throw new FinancialEngineInvariantError(
        'capital_conversion.invalid_ambiguity_transaction',
        'An ambiguity must reference a canonical transaction at the same instant.',
      );
    }
    const expectedFlowKind =
      ambiguity.kind === 'unlinked_refund'
        ? 'refund'
        : ambiguity.kind === 'unlinked_reimbursement'
          ? 'reimbursement'
          : null;
    if (
      expectedFlowKind === null
        ? flow !== undefined
        : flow?.kind !== expectedFlowKind || flow.relatedTransactionId !== null
    ) {
      throw new FinancialEngineInvariantError(
        'capital_conversion.ambiguity_conflicts_with_flow',
        'An ambiguity must agree with the canonical classification state.',
      );
    }
  }

  const ambiguitiesByTransaction = new Map(
    ambiguities.map((ambiguity) => [ambiguity.transactionId, ambiguity]),
  );
  for (const flow of flows) {
    if (
      (flow.kind === 'refund' || flow.kind === 'reimbursement') &&
      flow.relatedTransactionId === null
    ) {
      const ambiguity = ambiguitiesByTransaction.get(flow.transactionId);
      const expectedKind = flow.kind === 'refund' ? 'unlinked_refund' : 'unlinked_reimbursement';
      if (ambiguity?.kind !== expectedKind) {
        throw new FinancialEngineInvariantError(
          'capital_conversion.missing_unlinked_reversal_ambiguity',
          'Every unlinked refund or reimbursement requires a matching active ambiguity.',
        );
      }
    }
  }
}

function validateCashReconciliations(
  ledger: ValidatedLedger,
  flows: readonly EconomicFlow[],
  reconciliations: readonly CashReconciliation[],
): void {
  const accounts = new Map(ledger.accounts.map((account) => [account.id, account]));
  const transactions = new Map(
    ledger.transactions.map((transaction) => [transaction.id, transaction]),
  );
  const adjustmentFlows = new Map(
    flows
      .filter((flow) => flow.kind === 'cash_reconciliation_adjustment')
      .map((flow) => [flow.transactionId, flow]),
  );

  requireUnique(
    reconciliations.map((item) => item.id),
    'capital_conversion.duplicate_reconciliation_id',
    'Cash reconciliation IDs must be unique.',
  );
  requireUnique(
    reconciliations.map((item) => item.adjustmentTransactionId),
    'capital_conversion.duplicate_reconciliation_adjustment',
    'An adjustment transaction can belong to only one cash reconciliation.',
  );

  for (const reconciliation of reconciliations) {
    const account = accounts.get(reconciliation.accountId);
    const transaction = transactions.get(reconciliation.adjustmentTransactionId);
    const flow = adjustmentFlows.get(reconciliation.adjustmentTransactionId);
    const entry = transaction?.entries[0];

    if (account?.subtype !== 'cash' || account.valueSource !== 'ledger') {
      throw new FinancialEngineInvariantError(
        'capital_conversion.invalid_reconciliation_account',
        'Cash reconciliation must target a ledger-authoritative cash account.',
      );
    }
    if (
      transaction?.kind !== 'valuation_adjustment' ||
      transaction.bookingStatus !== 'booked' ||
      transaction.effectiveAt !== reconciliation.reconciledAt ||
      transaction.entries.length !== 1 ||
      entry?.accountId !== reconciliation.accountId ||
      entry.amount.amountMinor !== reconciliation.variance.amountMinor ||
      entry.amount.currency !== reconciliation.variance.currency ||
      flow?.amount.amountMinor !== reconciliation.variance.amountMinor ||
      flow.amount.currency !== reconciliation.variance.currency
    ) {
      throw new FinancialEngineInvariantError(
        'capital_conversion.invalid_reconciliation_adjustment',
        'Cash reconciliation must match one audited ledger adjustment exactly.',
      );
    }
  }

  if (adjustmentFlows.size !== reconciliations.length) {
    throw new FinancialEngineInvariantError(
      'capital_conversion.missing_reconciliation',
      'Every cash reconciliation adjustment requires one reconciliation record.',
    );
  }
}

function validateInput(input: CapitalConversionInput): ValidatedInput {
  const ledger = validateLedger(input);
  const flows = Object.freeze(input.economicFlows.map((flow) => createEconomicFlow(flow)));
  const reconciliations = Object.freeze(
    input.cashReconciliations.map((item) => createCashReconciliation(item)),
  );
  const ambiguities = Object.freeze(input.ambiguities.map((item) => createFlowAmbiguity(item)));
  const period = createMeasurementPeriod(input.period);
  const historyCoverage = createMeasurementPeriod(input.historyCoverage);
  const asOf = parseInstant(input.asOf);

  validateFlowTransactions(ledger, flows);
  validateReversals(flows);
  validateAmbiguities(ledger, flows, ambiguities);
  validateCashReconciliations(ledger, flows, reconciliations);

  if (compareInstants(period.endExclusive, asOf) > 0) {
    throw new FinancialEngineInvariantError(
      'capital_conversion.period_after_as_of',
      'A measurement period cannot extend beyond the result as-of instant.',
    );
  }

  const reservationEffect = calculateReservationEffect({
    funds: input.sinkingFunds,
    allocations: input.sinkingFundAllocations,
    reservationCoverage: input.reservationCoverage,
    period,
    economicFlows: flows,
    asOf,
    engineVersion: input.engineVersion,
    settingsVersion: input.settingsVersion,
    inputWatermark: input.inputWatermark,
  });

  return Object.freeze({
    ledger,
    flows,
    reconciliations,
    ambiguities,
    period,
    historyCoverage,
    reserveChange: reservationEffect.value?.change ?? null,
    reservationWarnings: reservationEffect.warnings,
    asOf,
  });
}

function warning(code: string, context: Readonly<Record<string, string>> = {}): DataWarning {
  return Object.freeze({ code, context: Object.freeze({ ...context }) });
}

function money(amountMinor: bigint): Money {
  return createMoney(amountMinor, EUR);
}

function calculateBreakdown(input: ValidatedInput): CapitalCreatedBreakdown {
  let recognizedIncome = 0n;
  let grossConsumption = 0n;
  let refunds = 0n;
  let reimbursements = 0n;
  let otherExternalInflows = 0n;
  let otherExternalOutflows = 0n;
  let cashReconciliationAdjustments = 0n;

  for (const flow of input.flows) {
    if (!periodContains(input.period, flow.effectiveAt)) continue;
    switch (flow.kind) {
      case 'earned_income':
        recognizedIncome += flow.amount.amountMinor;
        break;
      case 'consumption':
        grossConsumption += flow.amount.amountMinor;
        break;
      case 'refund':
        if (flow.relatedTransactionId !== null) refunds += flow.amount.amountMinor;
        break;
      case 'reimbursement':
        if (flow.relatedTransactionId !== null) reimbursements += flow.amount.amountMinor;
        break;
      case 'cash_reconciliation_adjustment':
        cashReconciliationAdjustments += flow.amount.amountMinor;
        break;
      case 'other_external_flow':
        if (flow.amount.amountMinor > 0n) otherExternalInflows += flow.amount.amountMinor;
        else otherExternalOutflows += -flow.amount.amountMinor;
        break;
    }
  }

  const reserveChange = input.reserveChange?.amountMinor ?? 0n;
  const netConsumption = grossConsumption - refunds - reimbursements;
  const capitalCreated = recognizedIncome - netConsumption - reserveChange;

  return Object.freeze({
    recognizedIncome: money(recognizedIncome),
    grossConsumption: money(grossConsumption),
    refunds: money(refunds),
    reimbursements: money(reimbursements),
    netConsumption: money(netConsumption),
    shortTermReservedFundsChange: money(reserveChange),
    otherExternalInflows: money(otherExternalInflows),
    otherExternalOutflows: money(otherExternalOutflows),
    cashReconciliationAdjustments: money(cashReconciliationAdjustments),
    capitalCreated: money(capitalCreated),
  });
}

function explanation(value: CapitalCreatedBreakdown): readonly ExplanationComponent[] {
  return Object.freeze([
    Object.freeze({
      ruleId: 'ccr.recognized_income',
      inputKey: 'recognizedIncome',
      value: value.recognizedIncome.amountMinor.toString(),
    }),
    Object.freeze({
      ruleId: 'ccr.gross_consumption',
      inputKey: 'grossConsumption',
      value: (-value.grossConsumption.amountMinor).toString(),
    }),
    Object.freeze({
      ruleId: 'ccr.refunds',
      inputKey: 'refunds',
      value: value.refunds.amountMinor.toString(),
    }),
    Object.freeze({
      ruleId: 'ccr.reimbursements',
      inputKey: 'reimbursements',
      value: value.reimbursements.amountMinor.toString(),
    }),
    Object.freeze({
      ruleId: 'ccr.reserve_change',
      inputKey: 'shortTermReservedFundsChange',
      value: (-value.shortTermReservedFundsChange.amountMinor).toString(),
    }),
    Object.freeze({
      ruleId: 'ccr.capital_created',
      inputKey: 'capitalCreated',
      value: value.capitalCreated.amountMinor.toString(),
    }),
    Object.freeze({
      ruleId: 'ccr.other_external_inflows_neutral',
      inputKey: 'otherExternalInflows',
      value: value.otherExternalInflows.amountMinor.toString(),
    }),
    Object.freeze({
      ruleId: 'ccr.other_external_outflows_neutral',
      inputKey: 'otherExternalOutflows',
      value: value.otherExternalOutflows.amountMinor.toString(),
    }),
    Object.freeze({
      ruleId: 'ccr.cash_reconciliation_neutral',
      inputKey: 'cashReconciliationAdjustments',
      value: value.cashReconciliationAdjustments.amountMinor.toString(),
    }),
  ]);
}

function quality(input: ValidatedInput): Readonly<{
  status: 'complete' | 'partial' | 'unavailable';
  warnings: readonly DataWarning[];
}> {
  const warnings: DataWarning[] = [];
  let status: 'complete' | 'partial' | 'unavailable' = 'complete';
  const coverageComplete =
    compareInstants(input.historyCoverage.startInclusive, input.period.startInclusive) <= 0 &&
    compareInstants(input.historyCoverage.endExclusive, input.period.endExclusive) >= 0;

  if (!coverageComplete) {
    status = 'unavailable';
    warnings.push(warning('ccr.missing_history_coverage'));
  }
  if (input.reserveChange === null) {
    status = 'unavailable';
    warnings.push(...input.reservationWarnings);
  }

  const classifiedTransactions = new Set(input.flows.map((flow) => flow.transactionId));
  const ambiguousTransactions = new Set(input.ambiguities.map((item) => item.transactionId));
  const missingClassification = input.ledger.transactions.some(
    (transaction) =>
      transaction.bookingStatus === 'booked' &&
      transaction.kind === 'external_flow' &&
      periodContains(input.period, transaction.effectiveAt) &&
      !classifiedTransactions.has(transaction.id) &&
      !ambiguousTransactions.has(transaction.id),
  );
  if (missingClassification) {
    status = 'unavailable';
    warnings.push(warning('ccr.missing_material_classification'));
  }

  for (const ambiguity of input.ambiguities.filter((item) =>
    periodContains(input.period, item.effectiveAt),
  )) {
    warnings.push(
      warning(`ccr.${ambiguity.kind}`, {
        transactionId: ambiguity.transactionId,
        materiality: ambiguity.materiality,
      }),
    );
    if (ambiguity.materiality === 'material') status = 'unavailable';
    else if (status === 'complete') status = 'partial';
  }

  for (const reconciliation of input.reconciliations.filter((item) =>
    periodContains(input.period, item.reconciledAt),
  )) {
    warnings.push(
      warning('ccr.cash_reconciliation_adjustment', {
        reconciliationId: reconciliation.id,
        materiality: reconciliation.materiality,
      }),
    );
    if (reconciliation.materiality === 'material' && status === 'complete') status = 'partial';
  }

  return Object.freeze({ status, warnings: Object.freeze(warnings) });
}

function baseResultInput(input: CapitalConversionInput, validated: ValidatedInput) {
  return {
    asOf: validated.asOf,
    engineVersion: input.engineVersion,
    settingsVersion: input.settingsVersion,
    inputWatermark: input.inputWatermark,
  } as const;
}

export function calculateCapitalCreated(
  input: CapitalConversionInput,
): MetricResult<CapitalCreatedBreakdown> {
  const validated = validateInput(input);
  const value = calculateBreakdown(validated);
  const dataQuality = quality(validated);

  return createMetricResult({
    ...baseResultInput(input, validated),
    status: dataQuality.status,
    value: dataQuality.status === 'unavailable' ? null : value,
    explanation: explanation(value),
    warnings: dataQuality.warnings,
  });
}

export function calculateCapitalConversionRate(
  input: CapitalConversionInput,
): MetricResult<CapitalConversionRateValue> {
  const validated = validateInput(input);
  const breakdown = calculateBreakdown(validated);
  const dataQuality = quality(validated);
  const explanations = [...explanation(breakdown)];
  const warnings = [...dataQuality.warnings];

  if (dataQuality.status === 'unavailable' || breakdown.recognizedIncome.amountMinor <= 0n) {
    if (breakdown.recognizedIncome.amountMinor === 0n)
      warnings.push(warning('ccr.zero_recognized_income'));
    if (breakdown.recognizedIncome.amountMinor < 0n)
      warnings.push(warning('ccr.negative_recognized_income'));
    return createMetricResult<CapitalConversionRateValue>({
      ...baseResultInput(input, validated),
      status: 'unavailable',
      value: null,
      explanation: explanations,
      warnings,
    });
  }

  const ratio = Object.freeze({
    numerator: breakdown.capitalCreated.amountMinor,
    denominator: breakdown.recognizedIncome.amountMinor,
  });
  const value = Object.freeze({ ...breakdown, ratio });
  explanations.push(
    Object.freeze({
      ruleId: 'ccr.ratio',
      inputKey: 'capitalCreated/recognizedIncome',
      value: `${ratio.numerator}/${ratio.denominator}`,
    }),
  );

  return createMetricResult({
    ...baseResultInput(input, validated),
    status: dataQuality.status,
    value,
    explanation: explanations,
    warnings,
  });
}

export function calculateRollingCapitalConversionRates(
  input: RollingCapitalConversionInput,
): readonly RollingCapitalConversionResult[] {
  return Object.freeze(
    input.periods.map((period) => {
      const canonicalPeriod = createMeasurementPeriod(period);
      return Object.freeze({
        period: canonicalPeriod,
        result: calculateCapitalConversionRate({ ...input, period: canonicalPeriod }),
      });
    }),
  );
}
