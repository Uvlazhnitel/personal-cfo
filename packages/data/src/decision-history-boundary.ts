import { and, eq } from 'drizzle-orm';

import type { Database } from './database.js';
import { DataConflictError, DataInvariantError } from './errors.js';
import { canonicalDatabaseInstant } from './financial-facts.js';
import { decodeSourceJson, encodeSourceJson } from './json-codec.js';
import type { CommandMutationResult } from './commands.js';
import { evaluationProfiles, planningContexts, users } from './schema.js';

type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export type DecisionHistoryBoundaryInput = Readonly<{
  startDate: string;
  asOf: string;
  effectiveDate: string;
  reason: string;
}>;

function record(value: unknown, code: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DataInvariantError(code, 'Persisted evaluation state must be an object.');
  }
  return value as Readonly<Record<string, unknown>>;
}

function validLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function localDateTimeParts(instant: Date, timeZone: string): Readonly<Record<string, string>> {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  return Object.freeze(
    Object.fromEntries(
      parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
    ),
  );
}

export function localDateStartInstant(value: string, timeZone: string): string {
  if (!validLocalDate(value)) {
    throw new DataInvariantError(
      'decision_history.invalid_start_date',
      'Decision history start date must use YYYY-MM-DD.',
    );
  }
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(0));
  } catch {
    throw new DataInvariantError(
      'decision_history.invalid_time_zone',
      'The owner time zone is invalid.',
    );
  }

  const desired = Date.parse(`${value}T00:00:00.000Z`);
  let candidate = desired;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const parts = localDateTimeParts(new Date(candidate), timeZone);
    const represented = Date.UTC(
      Number(parts['year']),
      Number(parts['month']) - 1,
      Number(parts['day']),
      Number(parts['hour']),
      Number(parts['minute']),
      Number(parts['second']),
    );
    candidate += desired - represented;
  }
  const verification = localDateTimeParts(new Date(candidate), timeZone);
  if (
    `${verification['year']}-${verification['month']}-${verification['day']}` !== value ||
    verification['hour'] !== '00' ||
    verification['minute'] !== '00' ||
    verification['second'] !== '00'
  ) {
    throw new DataInvariantError(
      'decision_history.invalid_start_date',
      'Decision history start date does not identify a valid local midnight.',
    );
  }
  return canonicalDatabaseInstant(new Date(candidate).toISOString());
}

export async function setDecisionHistoryBoundary(
  tx: DatabaseTransaction,
  ownerId: string,
  input: DecisionHistoryBoundaryInput,
): Promise<CommandMutationResult> {
  const asOf = canonicalDatabaseInstant(input.asOf);
  if (!validLocalDate(input.effectiveDate)) {
    throw new DataInvariantError(
      'decision_history.invalid_effective_date',
      'Decision history effective date must use YYYY-MM-DD.',
    );
  }
  const reason = input.reason.trim();
  if (reason.length === 0 || reason.length > 500) {
    throw new DataInvariantError(
      'decision_history.invalid_reason',
      'Decision history boundary requires a reason of at most 500 characters.',
    );
  }

  const owner = await tx.query.users.findFirst({ where: eq(users.id, ownerId) });
  const profile = await tx.query.evaluationProfiles.findFirst({
    where: eq(evaluationProfiles.ownerId, ownerId),
  });
  const context = await tx.query.planningContexts.findFirst({
    where: and(
      eq(planningContexts.ownerId, ownerId),
      eq(planningContexts.kind, 'current'),
      eq(planningContexts.checkpointKey, 'current'),
    ),
  });
  if (owner === undefined || profile === undefined || context === undefined) {
    throw new DataInvariantError(
      'decision_history.profile_required',
      'Decision history boundary requires an owner evaluation profile and current context.',
    );
  }

  const profilePayload = record(
    decodeSourceJson(profile.payload),
    'decision_history.invalid_profile',
  );
  const contextPayload = record(
    decodeSourceJson(context.payload),
    'decision_history.invalid_context',
  );
  if (profilePayload['decisionHistoryBoundary'] !== undefined) {
    throw new DataConflictError(
      'decision_history.already_set',
      'The owner already has an explicit decision history boundary.',
    );
  }

  const startInclusive = localDateStartInstant(input.startDate, owner.timeZone);
  if (startInclusive >= asOf) {
    throw new DataInvariantError(
      'decision_history.invalid_period',
      'Decision history start must be earlier than the command time.',
    );
  }
  const period = Object.freeze({ startInclusive, endExclusive: asOf });
  const boundary = Object.freeze({
    startDate: input.startDate,
    startInclusive,
    timeZone: owner.timeZone,
    source: 'owner_confirmed',
  });

  await tx
    .update(evaluationProfiles)
    .set({
      asOf,
      effectiveDate: input.effectiveDate,
      payload: encodeSourceJson({
        ...profilePayload,
        ccrPeriod: period,
        decisionHistoryBoundary: boundary,
      }),
      updatedAt: asOf,
    })
    .where(eq(evaluationProfiles.ownerId, ownerId));
  await tx
    .update(planningContexts)
    .set({
      effectiveAt: asOf,
      payload: encodeSourceJson({
        ...contextPayload,
        historyCoverage: period,
        reservationCoverage: period,
      }),
    })
    .where(
      and(
        eq(planningContexts.ownerId, ownerId),
        eq(planningContexts.kind, 'current'),
        eq(planningContexts.checkpointKey, 'current'),
      ),
    );

  return Object.freeze({
    entityType: 'decision_history_boundary',
    entityId: ownerId,
    earliestAffectedAt: startInclusive,
    result: Object.freeze({
      startDate: input.startDate,
      startInclusive,
      timeZone: owner.timeZone,
      reason,
    }),
  });
}
