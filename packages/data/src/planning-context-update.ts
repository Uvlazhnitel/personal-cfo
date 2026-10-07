import { and, eq } from 'drizzle-orm';
import {
  EUR,
  STANDARD_SPENDING_CATEGORIES,
  createExpectedPrimaryPaySchedule,
  createFutureObligation,
  createMoney,
  createOperationalNeed,
  createRestrictedCash,
  createScheduledSpending,
  parseLocalDate,
} from '@personal-cfo/domain';
import type {
  FutureObligation,
  OperationalNeed,
  SpendingNecessity,
  StandardSpendingCategoryCode,
} from '@personal-cfo/domain';

import type { CommandMutationResult } from './commands.js';
import { DataInvariantError } from './errors.js';
import { canonicalDatabaseInstant } from './financial-facts.js';
import { decodeSourceJson, encodeSourceJson } from './json-codec.js';
import type { DatabaseTransaction } from './owner-lock.js';
import { planningContexts, settingsVersions } from './schema.js';
import { generateUuidV7 } from './uuid-v7.js';

export type PlanningContextUpdateInput = Readonly<{
  scheduledRecurring: readonly Readonly<{
    dueDate: string;
    amountMinor: bigint;
    categoryCode: StandardSpendingCategoryCode;
  }>[];
  recurringScheduleComplete: boolean;
  operationalNeeds: readonly Readonly<{
    dueDate: string;
    amountMinor: bigint;
    necessity: SpendingNecessity;
    direction: OperationalNeed['direction'];
    state: OperationalNeed['state'];
  }>[];
  operationalNeedsComplete: boolean;
  futureObligations: readonly Readonly<{
    dueDate: string;
    amountMinor: bigint;
    priority: FutureObligation['priority'];
    committed: boolean;
  }>[];
  obligationsComplete: boolean;
  otherRestrictedCash: readonly Readonly<{ amountMinor: bigint }>[];
  restrictedCashComplete: boolean;
  primaryPaySchedule: Readonly<{
    kind: 'monthly_day_of_month';
    dayOfMonth: number;
  }> | null;
  asOf: string;
  effectiveDate: string;
  reason: string;
}>;

function record(value: unknown, code: string): Readonly<Record<string, unknown>> {
  const decoded = decodeSourceJson(value);
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new DataInvariantError(code, 'Planning context payload must be an object.');
  }
  return decoded as Readonly<Record<string, unknown>>;
}

function addDays(value: string, days: number): string {
  const date = new Date(`${parseLocalDate(value)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function monthlyDates(
  startExclusive: string,
  endInclusive: string,
  day: number,
): readonly string[] {
  const dates: string[] = [];
  const start = new Date(`${startExclusive.slice(0, 7)}-01T00:00:00.000Z`);
  const end = new Date(`${endInclusive.slice(0, 7)}-01T00:00:00.000Z`);
  for (
    let cursor = start;
    cursor <= end;
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1))
  ) {
    const candidate = `${cursor.getUTCFullYear().toString().padStart(4, '0')}-${(cursor.getUTCMonth() + 1).toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
    if (candidate > startExclusive && candidate <= endInclusive) dates.push(candidate);
  }
  return Object.freeze(dates);
}

function completeness(complete: boolean, count: number): 'complete' | 'partial' | 'unavailable' {
  return complete ? 'complete' : count > 0 ? 'partial' : 'unavailable';
}

function liquidityHorizonDays(payload: Readonly<Record<string, unknown>>): number {
  const liquidity = payload['liquidity'];
  if (typeof liquidity === 'object' && liquidity !== null && !Array.isArray(liquidity)) {
    const value = (liquidity as Readonly<Record<string, unknown>>)['unknownIncomeHorizonDays'];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  }
  return 31;
}

export async function updateCurrentPlanningContext(
  tx: DatabaseTransaction,
  ownerId: string,
  input: PlanningContextUpdateInput,
): Promise<CommandMutationResult> {
  const asOf = canonicalDatabaseInstant(input.asOf);
  const effectiveDate = parseLocalDate(input.effectiveDate);
  const reason = input.reason.trim();
  if (reason.length === 0 || reason.length > 500) {
    throw new DataInvariantError(
      'planning_context.invalid_reason',
      'Planning context update requires a reason of at most 500 characters.',
    );
  }
  const context = await tx.query.planningContexts.findFirst({
    where: and(
      eq(planningContexts.ownerId, ownerId),
      eq(planningContexts.kind, 'current'),
      eq(planningContexts.checkpointKey, 'current'),
    ),
  });
  const settings = await tx.query.settingsVersions.findFirst({
    where: and(eq(settingsVersions.ownerId, ownerId), eq(settingsVersions.isCurrent, true)),
  });
  if (context === undefined || settings === undefined) {
    throw new DataInvariantError(
      'planning_context.current_state_required',
      'A current planning context and settings version are required.',
    );
  }
  const current = record(context.payload, 'planning_context.invalid_payload');
  const quality = record(current['quality'], 'planning_context.invalid_quality');
  const liquidityInputs = record(
    quality['liquidityInputs'],
    'planning_context.invalid_liquidity_quality',
  );

  const scheduledRecurring = input.scheduledRecurring.map((item, index) => {
    const category = STANDARD_SPENDING_CATEGORIES[item.categoryCode];
    return createScheduledSpending({
      id: generateUuidV7(`scheduled-spending-${index}`) as never,
      dueDate: parseLocalDate(item.dueDate),
      amount: createMoney(item.amountMinor, EUR),
      necessity: category.necessity,
    });
  });
  const operationalNeeds = input.operationalNeeds.map((item, index) =>
    createOperationalNeed({
      id: generateUuidV7(`operational-need-${index}`) as never,
      dueDate: parseLocalDate(item.dueDate),
      amount: createMoney(item.amountMinor, EUR),
      necessity: item.necessity,
      direction: item.direction,
      state: item.state,
      scheduledSpendingId: null,
    }),
  );
  const futureObligations = input.futureObligations.map((item, index) =>
    createFutureObligation({
      id: generateUuidV7(`future-obligation-${index}`) as never,
      dueDate: parseLocalDate(item.dueDate),
      amount: Object.freeze({ kind: 'exact', amount: createMoney(item.amountMinor, EUR) }),
      priority: item.priority,
      committed: item.committed,
      status: 'open',
      coverage: Object.freeze({ kind: 'uncovered' }),
    }),
  );
  const otherRestrictedCash = input.otherRestrictedCash.map((item, index) =>
    createRestrictedCash({
      id: generateUuidV7(`restricted-cash-${index}`) as never,
      amount: createMoney(item.amountMinor, EUR),
    }),
  );

  const settingsPayload = record(settings.payload, 'planning_context.invalid_settings');
  const completeThrough = addDays(effectiveDate, liquidityHorizonDays(settingsPayload));
  const expectedPrimaryPaySchedule =
    input.primaryPaySchedule === null
      ? createExpectedPrimaryPaySchedule({
          dates: Object.freeze([]),
          completeThrough: effectiveDate,
        })
      : (() => {
          if (
            !Number.isSafeInteger(input.primaryPaySchedule.dayOfMonth) ||
            input.primaryPaySchedule.dayOfMonth < 1 ||
            input.primaryPaySchedule.dayOfMonth > 28
          ) {
            throw new DataInvariantError(
              'planning_context.invalid_pay_day',
              'V1 monthly primary-pay day must be between 1 and 28.',
            );
          }
          return createExpectedPrimaryPaySchedule({
            dates: monthlyDates(
              effectiveDate,
              completeThrough,
              input.primaryPaySchedule.dayOfMonth,
            ) as never,
            completeThrough: parseLocalDate(completeThrough),
          });
        })();
  const nextReliableIncomeDate = expectedPrimaryPaySchedule.dates[0] ?? null;

  const payload = Object.freeze({
    ...current,
    scheduledRecurring: Object.freeze(scheduledRecurring),
    recurringScheduleComplete: input.recurringScheduleComplete,
    operationalNeeds: Object.freeze(operationalNeeds),
    futureObligations: Object.freeze(futureObligations),
    otherRestrictedCash: Object.freeze(otherRestrictedCash),
    nextReliableIncomeDate,
    expectedPrimaryPaySchedule,
    quality: Object.freeze({
      ...quality,
      liquidityInputs: Object.freeze({
        ...liquidityInputs,
        operationalNeeds: completeness(input.operationalNeedsComplete, operationalNeeds.length),
        obligations: completeness(input.obligationsComplete, futureObligations.length),
        restrictedCash: completeness(input.restrictedCashComplete, otherRestrictedCash.length),
      }),
    }),
  });
  await tx
    .update(planningContexts)
    .set({ effectiveAt: asOf, payload: encodeSourceJson(payload) })
    .where(
      and(
        eq(planningContexts.ownerId, ownerId),
        eq(planningContexts.kind, 'current'),
        eq(planningContexts.checkpointKey, 'current'),
      ),
    );
  return Object.freeze({
    entityType: 'planning_context',
    entityId: ownerId,
    earliestAffectedAt: asOf,
    result: Object.freeze({
      scheduledRecurringCount: scheduledRecurring.length,
      operationalNeedsCount: operationalNeeds.length,
      futureObligationsCount: futureObligations.length,
      restrictedCashCount: otherRestrictedCash.length,
      nextReliableIncomeDate,
      expectedPrimaryPaySchedule,
      reason,
    }),
  });
}
