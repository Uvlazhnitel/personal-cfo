import {
  DataConflictError,
  DataInvariantError,
  appendCashReconciliation,
  appendClassificationCorrection,
  appendManualSinkingAllocation,
  appendReconciliationResolution,
  executeFinancialCommand,
  resolveTransferCandidate,
} from '@personal-cfo/data';
import type { EconomicFlowClassification, RecalculationCause } from '@personal-cfo/data';
import type {
  CashReconciliation,
  CashReconciliationResolution,
  CanonicalTransaction,
  EconomicFlow,
  SinkingFundAllocation,
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

export function parseClassificationInput(value: unknown): EconomicFlowClassification {
  if (!isRecord(value))
    throw new DataInvariantError('http.invalid_request', 'classification must be an object.');
  switch (value['kind']) {
    case 'earned_income':
      requireOnlyKeys(value, ['kind', 'earnedIncomeSource']);
      return Object.freeze({
        kind: value['kind'],
        earnedIncomeSource: requiredString(
          value['earnedIncomeSource'],
          'classification.earnedIncomeSource',
        ) as never,
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

function reviveMoney(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reviveMoney);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'amountMinor' && typeof item === 'string' && /^0|-?[1-9][0-9]*$/u.test(item)) {
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
  }
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
        effectiveDate: localDateInRiga(clock),
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
        }
      },
    );
    return NextResponse.json(result, { status: result.replayed ? 200 : 202 });
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
