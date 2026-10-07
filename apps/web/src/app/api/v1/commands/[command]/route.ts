import {
  DataConflictError,
  DataInvariantError,
  appendCashReconciliation,
  appendClassificationCorrection,
  appendMaterialitySettingsVersion,
  appendManualSinkingAllocation,
  appendReconciliationResolution,
  appendExistingFlowSpendingObservation,
  bootstrapCashAccount,
  bootstrapConservativeEvaluationProfile,
  classifyBankTransactionAsExternalFlow,
  classifyBankTransactionAsPrimarySalary,
  executeFinancialCommand,
  resolveTransferCandidate,
  setDecisionHistoryBoundary,
  updateCurrentPlanningContext,
} from '@personal-cfo/data';
import type {
  EconomicFlowClassification,
  BankExternalFlowClassification,
  MaterialitySettingsInput,
  RecalculationCause,
  ExistingFlowSpendingObservationInput,
  PlanningContextUpdateInput,
} from '@personal-cfo/data';
import type {
  CashReconciliation,
  CashReconciliationResolution,
  CanonicalTransaction,
  EconomicFlow,
  SinkingFundAllocation,
} from '@personal-cfo/domain';
import {
  OPERATIONAL_NEED_DIRECTIONS,
  OPERATIONAL_NEED_STATES,
  OBLIGATION_PRIORITIES,
  parseLocalDate,
  SPENDING_CADENCES,
  SPENDING_NECESSITIES,
  STANDARD_SPENDING_CATEGORY_CODES,
} from '@personal-cfo/domain';
import { NextResponse } from 'next/server.js';
import type { NextRequest } from 'next/server.js';

import { authorizedCommand } from '../../../../../server/auth.js';
import { databaseContext } from '../../../../../server/database.js';
import { webJobBoss } from '../../../../../server/jobs.js';

const COMMANDS = [
  'classification-correction',
  'transfer-resolution',
  'sinking-allocation',
  'cash-reconciliation',
  'cash-reconciliation-resolution',
  'settings-materiality',
  'engine-profile-bootstrap',
  'cash-account-bootstrap',
  'decision-history-boundary',
  'bank-external-flow',
  'bank-primary-salary',
  'spending-observation',
  'planning-context-update',
] as const;
type CommandName = (typeof COMMANDS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DataInvariantError('http.invalid_request', `${name} must be a non-empty string.`);
  }
  return value;
}

function requireOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0)
    throw new DataInvariantError(
      'classification.identity_field_forbidden',
      `Classification contains unsupported fields: ${unexpected.sort().join(', ')}.`,
    );
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean')
    throw new DataInvariantError('http.invalid_request', `${name} must be a boolean.`);
  return value;
}

function requiredArray(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value))
    throw new DataInvariantError('http.invalid_request', `${name} must be an array.`);
  return value;
}

function requiredMinor(value: unknown, name: string, allowZero = false): bigint {
  if (typeof value !== 'bigint' || (allowZero ? value < 0n : value <= 0n)) {
    throw new DataInvariantError(
      'http.invalid_request',
      `${name} must be ${allowZero ? 'a non-negative' : 'a positive'} minor-unit integer.`,
    );
  }
  return value;
}

function requiredLocalDate(value: unknown, name: string): string {
  try {
    return parseLocalDate(requiredString(value, name));
  } catch {
    throw new DataInvariantError('http.invalid_request', `${name} must be a local date.`);
  }
}

function requiredEnum<T extends string>(value: unknown, accepted: readonly T[], name: string): T {
  if (typeof value !== 'string' || !accepted.includes(value as T))
    throw new DataInvariantError('http.invalid_request', `${name} is invalid.`);
  return value as T;
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value))
    throw new DataInvariantError('http.invalid_request', `${name} must be an object.`);
  return value;
}

export function parseSpendingObservationInput(
  value: unknown,
): ExistingFlowSpendingObservationInput {
  const input = requiredRecord(value, 'request');
  const flowId = requiredString(input['economicFlowId'], 'economicFlowId');
  const reason = requiredString(input['reason'], 'reason');
  const hasSemantics =
    input['categoryCode'] !== undefined ||
    input['cadence'] !== undefined ||
    input['irregular'] !== undefined;
  if (!hasSemantics) {
    requireOnlyKeys(input, ['economicFlowId', 'reason']);
    return Object.freeze({ economicFlowId: flowId, reason });
  }
  requireOnlyKeys(input, ['economicFlowId', 'categoryCode', 'cadence', 'irregular', 'reason']);
  return Object.freeze({
    economicFlowId: flowId,
    categoryCode: requiredEnum(
      input['categoryCode'],
      STANDARD_SPENDING_CATEGORY_CODES,
      'categoryCode',
    ),
    cadence: requiredEnum(input['cadence'], SPENDING_CADENCES, 'cadence'),
    irregular: requiredBoolean(input['irregular'], 'irregular'),
    reason,
  });
}

export function parsePlanningContextUpdateInput(
  value: unknown,
  asOf: string,
  effectiveDate: string,
): PlanningContextUpdateInput {
  const input = requiredRecord(value, 'request');
  requireOnlyKeys(input, [
    'scheduledRecurring',
    'recurringScheduleComplete',
    'operationalNeeds',
    'operationalNeedsComplete',
    'futureObligations',
    'obligationsComplete',
    'otherRestrictedCash',
    'restrictedCashComplete',
    'primaryPaySchedule',
    'reason',
  ]);
  const scheduledRecurring = requiredArray(input['scheduledRecurring'], 'scheduledRecurring').map(
    (value, index) => {
      const item = requiredRecord(value, `scheduledRecurring[${index}]`);
      requireOnlyKeys(item, ['dueDate', 'amountMinor', 'categoryCode']);
      return Object.freeze({
        dueDate: requiredLocalDate(item['dueDate'], `scheduledRecurring[${index}].dueDate`),
        amountMinor: requiredMinor(item['amountMinor'], `scheduledRecurring[${index}].amountMinor`),
        categoryCode: requiredEnum(
          item['categoryCode'],
          STANDARD_SPENDING_CATEGORY_CODES,
          `scheduledRecurring[${index}].categoryCode`,
        ),
      });
    },
  );
  const operationalNeeds = requiredArray(input['operationalNeeds'], 'operationalNeeds').map(
    (value, index) => {
      const item = requiredRecord(value, `operationalNeeds[${index}]`);
      requireOnlyKeys(item, ['dueDate', 'amountMinor', 'necessity', 'direction', 'state']);
      return Object.freeze({
        dueDate: requiredLocalDate(item['dueDate'], `operationalNeeds[${index}].dueDate`),
        amountMinor: requiredMinor(item['amountMinor'], `operationalNeeds[${index}].amountMinor`),
        necessity: requiredEnum(
          item['necessity'],
          SPENDING_NECESSITIES,
          `operationalNeeds[${index}].necessity`,
        ),
        direction: requiredEnum(
          item['direction'],
          OPERATIONAL_NEED_DIRECTIONS,
          `operationalNeeds[${index}].direction`,
        ),
        state: requiredEnum(
          item['state'],
          OPERATIONAL_NEED_STATES,
          `operationalNeeds[${index}].state`,
        ),
      });
    },
  );
  const futureObligations = requiredArray(input['futureObligations'], 'futureObligations').map(
    (value, index) => {
      const item = requiredRecord(value, `futureObligations[${index}]`);
      requireOnlyKeys(item, ['dueDate', 'amountMinor', 'priority', 'committed']);
      return Object.freeze({
        dueDate: requiredLocalDate(item['dueDate'], `futureObligations[${index}].dueDate`),
        amountMinor: requiredMinor(item['amountMinor'], `futureObligations[${index}].amountMinor`),
        priority: requiredEnum(
          item['priority'],
          OBLIGATION_PRIORITIES,
          `futureObligations[${index}].priority`,
        ),
        committed: requiredBoolean(item['committed'], `futureObligations[${index}].committed`),
      });
    },
  );
  const otherRestrictedCash = requiredArray(
    input['otherRestrictedCash'],
    'otherRestrictedCash',
  ).map((value, index) => {
    const item = requiredRecord(value, `otherRestrictedCash[${index}]`);
    requireOnlyKeys(item, ['amountMinor']);
    return Object.freeze({
      amountMinor: requiredMinor(item['amountMinor'], `otherRestrictedCash[${index}].amountMinor`),
    });
  });
  const rawPaySchedule = input['primaryPaySchedule'];
  let primaryPaySchedule: PlanningContextUpdateInput['primaryPaySchedule'];
  if (rawPaySchedule === null) {
    primaryPaySchedule = null;
  } else {
    const schedule = requiredRecord(rawPaySchedule, 'primaryPaySchedule');
    requireOnlyKeys(schedule, ['kind', 'dayOfMonth']);
    if (schedule['kind'] !== 'monthly_day_of_month')
      throw new DataInvariantError('http.invalid_request', 'primaryPaySchedule.kind is invalid.');
    if (
      typeof schedule['dayOfMonth'] !== 'number' ||
      !Number.isSafeInteger(schedule['dayOfMonth']) ||
      schedule['dayOfMonth'] < 1 ||
      schedule['dayOfMonth'] > 28
    )
      throw new DataInvariantError(
        'http.invalid_request',
        'primaryPaySchedule.dayOfMonth must be an integer between 1 and 28.',
      );
    primaryPaySchedule = Object.freeze({
      kind: schedule['kind'],
      dayOfMonth: schedule['dayOfMonth'],
    });
  }
  return Object.freeze({
    scheduledRecurring: Object.freeze(scheduledRecurring),
    recurringScheduleComplete: requiredBoolean(
      input['recurringScheduleComplete'],
      'recurringScheduleComplete',
    ),
    operationalNeeds: Object.freeze(operationalNeeds),
    operationalNeedsComplete: requiredBoolean(
      input['operationalNeedsComplete'],
      'operationalNeedsComplete',
    ),
    futureObligations: Object.freeze(futureObligations),
    obligationsComplete: requiredBoolean(input['obligationsComplete'], 'obligationsComplete'),
    otherRestrictedCash: Object.freeze(otherRestrictedCash),
    restrictedCashComplete: requiredBoolean(
      input['restrictedCashComplete'],
      'restrictedCashComplete',
    ),
    primaryPaySchedule,
    asOf,
    effectiveDate,
    reason: requiredString(input['reason'], 'reason'),
  });
}

export function parseClassificationInput(value: unknown): EconomicFlowClassification {
  if (!isRecord(value))
    throw new DataInvariantError('http.invalid_request', 'classification must be an object.');
  switch (value['kind']) {
    case 'earned_income':
      requireOnlyKeys(value, ['kind', 'earnedIncomeSource', 'primarySalary']);
      if (value['primarySalary'] !== undefined && typeof value['primarySalary'] !== 'boolean') {
        throw new DataInvariantError(
          'http.invalid_request',
          'classification.primarySalary must be a boolean when supplied.',
        );
      }
      return Object.freeze({
        kind: value['kind'],
        earnedIncomeSource: requiredString(
          value['earnedIncomeSource'],
          'classification.earnedIncomeSource',
        ) as never,
        ...(value['primarySalary'] === undefined ? {} : { primarySalary: value['primarySalary'] }),
      });
    case 'consumption':
      requireOnlyKeys(value, ['kind', 'reimbursable']);
      if (typeof value['reimbursable'] !== 'boolean')
        throw new DataInvariantError(
          'http.invalid_request',
          'classification.reimbursable must be a boolean.',
        );
      return Object.freeze({ kind: value['kind'], reimbursable: value['reimbursable'] });
    case 'refund':
    case 'reimbursement': {
      requireOnlyKeys(value, ['kind', 'relatedTransactionId']);
      const related = value['relatedTransactionId'];
      if (related !== null && typeof related !== 'string')
        throw new DataInvariantError(
          'http.invalid_request',
          'classification.relatedTransactionId must be a string or null.',
        );
      return Object.freeze({ kind: value['kind'], relatedTransactionId: related });
    }
    case 'cash_reconciliation_adjustment':
    case 'other_external_flow':
      requireOnlyKeys(value, ['kind']);
      return Object.freeze({ kind: value['kind'] });
    default:
      throw new DataInvariantError('http.invalid_request', 'classification.kind is invalid.');
  }
}

export function parseBankExternalFlowClassificationInput(
  value: unknown,
): BankExternalFlowClassification {
  const classification = parseClassificationInput(value);
  switch (classification.kind) {
    case 'consumption':
      return classification;
    case 'other_external_flow':
      return { kind: 'other_external_flow' };
    case 'refund':
    case 'reimbursement':
      if (classification.relatedTransactionId === null) {
        throw new DataInvariantError(
          'http.invalid_request',
          'A bank refund or reimbursement requires relatedTransactionId.',
        );
      }
      return { ...classification, relatedTransactionId: classification.relatedTransactionId };
    case 'earned_income':
    case 'cash_reconciliation_adjustment':
      throw new DataInvariantError(
        'http.invalid_request',
        'classification.kind is not supported by bank-external-flow.',
      );
  }
}

export function parseMaterialitySettingsInput(
  value: unknown,
  effectiveAt: string,
  effectiveDate: string,
): Readonly<MaterialitySettingsInput & { reason: string }> {
  if (!isRecord(value))
    throw new DataInvariantError('http.invalid_request', 'Request body must be an object.');
  const unexpected = Object.keys(value).filter(
    (key) => !['amountMinor', 'currency', 'reason'].includes(key),
  );
  if (unexpected.length > 0) {
    throw new DataInvariantError(
      'http.unsupported_fields',
      `Settings request contains unsupported fields: ${unexpected.sort().join(', ')}.`,
    );
  }
  if (
    typeof value['amountMinor'] !== 'bigint' ||
    value['amountMinor'] < 0n ||
    value['currency'] !== 'EUR'
  ) {
    throw new DataInvariantError(
      'settings.invalid_materiality',
      'Materiality threshold must be a non-negative EUR amount in minor units.',
    );
  }
  return Object.freeze({
    amountMinor: value['amountMinor'],
    currency: value['currency'],
    effectiveAt,
    effectiveDate,
    reason: requiredString(value['reason'], 'reason'),
  });
}

export function parseEvaluationProfileBootstrapInput(value: unknown): Readonly<{ reason: string }> {
  if (!isRecord(value))
    throw new DataInvariantError('http.invalid_request', 'Request body must be an object.');
  const unexpected = Object.keys(value).filter((key) => key !== 'reason');
  if (unexpected.length > 0) {
    throw new DataInvariantError(
      'http.unsupported_fields',
      `Engine profile bootstrap contains unsupported fields: ${unexpected.sort().join(', ')}.`,
    );
  }
  return Object.freeze({ reason: requiredString(value['reason'], 'reason') });
}

export function parseCashAccountBootstrapInput(value: unknown): Readonly<{
  openingBalanceMinor: bigint;
  effectiveAt: string;
  reason: string;
}> {
  if (!isRecord(value))
    throw new DataInvariantError('http.invalid_request', 'Request body must be an object.');
  const unexpected = Object.keys(value).filter(
    (key) => !['openingBalanceMinor', 'effectiveAt', 'reason'].includes(key),
  );
  if (unexpected.length > 0) {
    throw new DataInvariantError(
      'http.unsupported_fields',
      `Cash Account bootstrap contains unsupported fields: ${unexpected.sort().join(', ')}.`,
    );
  }
  if (typeof value['openingBalanceMinor'] !== 'bigint' || value['openingBalanceMinor'] < 0n) {
    throw new DataInvariantError(
      'cash_account.invalid_opening_balance',
      'Cash Account opening balance must be a non-negative EUR amount in minor units.',
    );
  }
  return Object.freeze({
    openingBalanceMinor: value['openingBalanceMinor'],
    effectiveAt: requiredString(value['effectiveAt'], 'effectiveAt'),
    reason: requiredString(value['reason'], 'reason'),
  });
}

export function parseDecisionHistoryBoundaryInput(value: unknown): Readonly<{
  startDate: string;
  reason: string;
}> {
  if (!isRecord(value))
    throw new DataInvariantError('http.invalid_request', 'Request body must be an object.');
  const unexpected = Object.keys(value).filter((key) => !['startDate', 'reason'].includes(key));
  if (unexpected.length > 0) {
    throw new DataInvariantError(
      'http.unsupported_fields',
      `Decision history boundary contains unsupported fields: ${unexpected.sort().join(', ')}.`,
    );
  }
  return Object.freeze({
    startDate: requiredString(value['startDate'], 'startDate'),
    reason: requiredString(value['reason'], 'reason'),
  });
}

export function reviveMoney(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reviveMoney);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      (key === 'amountMinor' || key === 'openingBalanceMinor') &&
      typeof item === 'string' &&
      /^0|-?[1-9][0-9]*$/u.test(item)
    ) {
      result[key] = BigInt(item);
    } else {
      result[key] = reviveMoney(item);
    }
  }
  return result;
}

function localDateInRiga(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Riga',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((value) => value.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function commandCause(command: CommandName): RecalculationCause {
  switch (command) {
    case 'classification-correction':
      return 'classification_correction';
    case 'transfer-resolution':
      return 'transfer_resolution';
    case 'sinking-allocation':
      return 'sinking_allocation';
    case 'cash-reconciliation':
      return 'cash_reconciliation';
    case 'cash-reconciliation-resolution':
      return 'cash_reconciliation_resolution';
    case 'settings-materiality':
      return 'settings_change';
    case 'engine-profile-bootstrap':
      return 'engine_profile_bootstrap';
    case 'cash-account-bootstrap':
      return 'cash_account_bootstrap';
    case 'decision-history-boundary':
      return 'decision_history_boundary';
    case 'bank-external-flow':
      return 'bank_external_flow';
    case 'bank-primary-salary':
      return 'bank_primary_salary';
    case 'spending-observation':
      return 'spending_observation';
    case 'planning-context-update':
      return 'planning_context_update';
  }
}

export function serializeCommandResponse(
  value: Readonly<{
    commandId: string;
    replayed: boolean;
    mutated: boolean;
    inputVersion: bigint;
    result: Readonly<Record<string, unknown>>;
  }>,
): Readonly<Record<string, unknown>> {
  return Object.freeze({ ...value, inputVersion: value.inputVersion.toString() });
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ command: string }> },
): Promise<NextResponse> {
  const session = await authorizedCommand(request);
  if (session === null) return NextResponse.json({ error: 'unauthorized' }, { status: 403 });
  const { command: rawCommand } = await context.params;
  if (!COMMANDS.includes(rawCommand as CommandName))
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const command = rawCommand as CommandName;
  const idempotencyKey = request.headers.get('idempotency-key');
  if (idempotencyKey === null)
    return NextResponse.json({ error: 'missing_idempotency_key' }, { status: 400 });

  try {
    const raw = reviveMoney(await request.json());
    if (!isRecord(raw))
      throw new DataInvariantError('http.invalid_request', 'Request body must be an object.');
    const clock = new Date();
    const now = clock.toISOString();
    const effectiveDate = localDateInRiga(clock);
    const boss = await webJobBoss();
    const result = await executeFinancialCommand(
      databaseContext().db,
      boss,
      {
        ownerId: session.ownerId,
        kind: commandCause(command),
        idempotencyKey,
        request: raw,
        asOf: now,
        effectiveDate,
        now,
      },
      async (tx, commandId) => {
        switch (command) {
          case 'classification-correction':
            return appendClassificationCorrection(
              tx,
              session.ownerId,
              requiredString(raw['flowId'], 'flowId'),
              parseClassificationInput(raw['classification']),
              now,
              requiredString(raw['reason'], 'reason'),
            );
          case 'bank-primary-salary':
            requireOnlyKeys(raw, ['transactionId', 'reason']);
            return classifyBankTransactionAsPrimarySalary(tx, session.ownerId, {
              transactionId: requiredString(raw['transactionId'], 'transactionId'),
              now,
              reason: requiredString(raw['reason'], 'reason'),
            });
          case 'bank-external-flow':
            requireOnlyKeys(raw, ['transactionId', 'classification', 'reason']);
            return classifyBankTransactionAsExternalFlow(tx, session.ownerId, {
              transactionId: requiredString(raw['transactionId'], 'transactionId'),
              classification: parseBankExternalFlowClassificationInput(raw['classification']),
              now,
              reason: requiredString(raw['reason'], 'reason'),
            });
          case 'spending-observation':
            return appendExistingFlowSpendingObservation(
              tx,
              session.ownerId,
              parseSpendingObservationInput(raw),
            );
          case 'planning-context-update':
            return updateCurrentPlanningContext(
              tx,
              session.ownerId,
              parsePlanningContextUpdateInput(raw, now, effectiveDate),
            );
          case 'transfer-resolution': {
            const resolution = raw['resolution'];
            if (resolution !== 'confirmed_transfer' && resolution !== 'rejected_transfer')
              throw new DataInvariantError('http.invalid_request', 'resolution is invalid.');
            return resolveTransferCandidate(
              tx,
              session.ownerId,
              requiredString(raw['candidateId'], 'candidateId'),
              resolution,
              now,
              requiredString(raw['reason'], 'reason'),
              raw['replacementTransaction'] as CanonicalTransaction | undefined,
            );
          }
          case 'sinking-allocation':
            return appendManualSinkingAllocation(
              tx,
              session.ownerId,
              raw['allocation'] as SinkingFundAllocation,
              commandId,
            );
          case 'cash-reconciliation':
            return appendCashReconciliation(
              tx,
              session.ownerId,
              raw['transaction'] as CanonicalTransaction,
              raw['flow'] as EconomicFlow,
              raw['reconciliation'] as CashReconciliation,
            );
          case 'cash-reconciliation-resolution':
            return appendReconciliationResolution(
              tx,
              session.ownerId,
              raw['resolution'] as CashReconciliationResolution,
            );
          case 'settings-materiality': {
            const settings = parseMaterialitySettingsInput(raw, now, effectiveDate);
            return appendMaterialitySettingsVersion(tx, session.ownerId, settings);
          }
          case 'engine-profile-bootstrap': {
            const bootstrap = parseEvaluationProfileBootstrapInput(raw);
            return bootstrapConservativeEvaluationProfile(tx, session.ownerId, {
              ...bootstrap,
              asOf: now,
              effectiveDate,
            });
          }
          case 'cash-account-bootstrap': {
            const bootstrap = parseCashAccountBootstrapInput(raw);
            return bootstrapCashAccount(tx, session.ownerId, {
              ...bootstrap,
              asOf: now,
            });
          }
          case 'decision-history-boundary': {
            const boundary = parseDecisionHistoryBoundaryInput(raw);
            return setDecisionHistoryBoundary(tx, session.ownerId, {
              ...boundary,
              asOf: now,
              effectiveDate,
            });
          }
        }
      },
    );
    return NextResponse.json(serializeCommandResponse(result), {
      status: result.replayed ? 200 : 202,
    });
  } catch (error) {
    if (error instanceof DataConflictError)
      return NextResponse.json({ error: error.code }, { status: 409 });
    if (error instanceof DataInvariantError || error instanceof SyntaxError)
      return NextResponse.json(
        { error: error instanceof DataInvariantError ? error.code : 'http.invalid_json' },
        { status: 400 },
      );
    console.error(
      JSON.stringify({
        event: 'command.failed',
        command,
        error: error instanceof Error ? error.name : 'unknown',
      }),
    );
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
