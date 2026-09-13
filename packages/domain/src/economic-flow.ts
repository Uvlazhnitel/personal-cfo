import type { EconomicFlowId, TransactionId } from './domain-id.js';
import { parseEconomicFlowId, parseTransactionId } from './domain-id.js';
import { DomainValidationError } from './errors.js';
import type { Instant } from './instant.js';
import { parseInstant } from './instant.js';
import type { Money } from './money.js';
import { createMoney } from './money.js';
import { parseStringEnum } from './validation.js';

export const EARNED_INCOME_SOURCES = ['salary', 'side_hustle', 'other'] as const;
export type EarnedIncomeSource = (typeof EARNED_INCOME_SOURCES)[number];

export const ECONOMIC_FLOW_KINDS = [
  'earned_income',
  'consumption',
  'refund',
  'reimbursement',
  'cash_reconciliation_adjustment',
  'other_external_flow',
] as const;
export type EconomicFlowKind = (typeof ECONOMIC_FLOW_KINDS)[number];

type EconomicFlowBase = Readonly<{
  id: EconomicFlowId;
  transactionId: TransactionId;
  effectiveAt: Instant;
  amount: Money;
}>;

export type EconomicFlow =
  | (EconomicFlowBase & Readonly<{ kind: 'earned_income'; source: EarnedIncomeSource }>)
  | (EconomicFlowBase & Readonly<{ kind: 'consumption'; reimbursable: boolean }>)
  | (EconomicFlowBase &
      Readonly<{
        kind: 'refund' | 'reimbursement';
        relatedTransactionId: TransactionId | null;
      }>)
  | (EconomicFlowBase &
      Readonly<{
        kind: 'cash_reconciliation_adjustment' | 'other_external_flow';
      }>);

export function parseEconomicFlowKind(value: unknown): EconomicFlowKind {
  return parseStringEnum(value, ECONOMIC_FLOW_KINDS, 'EconomicFlowKind');
}

export function parseEarnedIncomeSource(value: unknown): EarnedIncomeSource {
  return parseStringEnum(value, EARNED_INCOME_SOURCES, 'EarnedIncomeSource');
}

export function createEconomicFlow(flow: EconomicFlow): EconomicFlow {
  parseEconomicFlowKind(flow.kind);
  const base = {
    id: parseEconomicFlowId(flow.id),
    transactionId: parseTransactionId(flow.transactionId),
    effectiveAt: parseInstant(flow.effectiveAt),
    amount: createMoney(flow.amount.amountMinor, flow.amount.currency),
  };

  if (flow.amount.amountMinor === 0n) {
    throw new DomainValidationError(
      'economic_flow.zero_amount',
      'An economic flow amount must be non-zero.',
    );
  }

  switch (flow.kind) {
    case 'earned_income':
      return Object.freeze({
        ...base,
        kind: flow.kind,
        source: parseEarnedIncomeSource(flow.source),
      });
    case 'consumption':
      if (typeof flow.reimbursable !== 'boolean') {
        throw new DomainValidationError(
          'economic_flow.invalid_reimbursable',
          'Consumption reimbursable must be a boolean.',
        );
      }
      return Object.freeze({ ...base, kind: flow.kind, reimbursable: flow.reimbursable });
    case 'refund':
    case 'reimbursement':
      return Object.freeze({
        ...base,
        kind: flow.kind,
        relatedTransactionId:
          flow.relatedTransactionId === null ? null : parseTransactionId(flow.relatedTransactionId),
      });
    case 'cash_reconciliation_adjustment':
    case 'other_external_flow':
      return Object.freeze({ ...base, kind: flow.kind });
  }
}

export const FLOW_AMBIGUITY_KINDS = [
  'unresolved_transfer',
  'unclassified_external_flow',
  'unlinked_refund',
  'unlinked_reimbursement',
] as const;
export type FlowAmbiguityKind = (typeof FLOW_AMBIGUITY_KINDS)[number];

export const FLOW_MATERIALITIES = ['material', 'non_material'] as const;
export type FlowMateriality = (typeof FLOW_MATERIALITIES)[number];

export type FlowAmbiguity = Readonly<{
  transactionId: TransactionId;
  effectiveAt: Instant;
  kind: FlowAmbiguityKind;
  materiality: FlowMateriality;
}>;

export function createFlowAmbiguity(ambiguity: FlowAmbiguity): FlowAmbiguity {
  return Object.freeze({
    transactionId: parseTransactionId(ambiguity.transactionId),
    effectiveAt: parseInstant(ambiguity.effectiveAt),
    kind: parseStringEnum(ambiguity.kind, FLOW_AMBIGUITY_KINDS, 'FlowAmbiguityKind'),
    materiality: parseStringEnum(ambiguity.materiality, FLOW_MATERIALITIES, 'FlowMateriality'),
  });
}
