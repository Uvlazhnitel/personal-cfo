import { and, eq } from 'drizzle-orm';
import {
  EUR,
  STANDARD_SPENDING_CATEGORIES,
  createExpectedPrimaryPaySchedule,
  createFutureObligation,
  createMoney,
  createOperationalNeed,
  createRestrictedCash,
  parseLocalDate,
} from '@personal-cfo/domain';
import type {
  CurrencyCode,
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
import { planningContexts } from './schema.js';
import { generateUuidV7 } from './uuid-v7.js';

export type MonthlyDayOfMonthRecurrence = Readonly<{
  kind: 'monthly_day_of_month';
  dayOfMonth: number;
}>;

export type RecurringSpendingDeclaration = Readonly<{
  id: string;
  amountMinor: bigint;
  currency: CurrencyCode;
  categoryCode: StandardSpendingCategoryCode;
  recurrence: MonthlyDayOfMonthRecurrence;
}>;

export type PlanningContextUpdateInput = Readonly<{
  scheduledRecurring: readonly Readonly<{
    amountMinor: bigint;
    categoryCode: StandardSpendingCategoryCode;
    recurrence: MonthlyDayOfMonthRecurrence;
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

function completeness(complete: boolean, count: number): 'complete' | 'partial' | 'unavailable' {
  return complete ? 'complete' : count > 0 ? 'partial' : 'unavailable';
}

function validateMonthlyDay(dayOfMonth: number, code: string): number {
  if (!Number.isSafeInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 28) {
    throw new DataInvariantError(code, 'V1 monthly day must be between 1 and 28.');
  }
  return dayOfMonth;
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
  if (context === undefined) {
    throw new DataInvariantError(
      'planning_context.current_state_required',
      'A current planning context is required.',
    );
  }
  const current = record(context.payload, 'planning_context.invalid_payload');
  const quality = record(current['quality'], 'planning_context.invalid_quality');
  const liquidityInputs = record(
    quality['liquidityInputs'],
    'planning_context.invalid_liquidity_quality',
  );

  const recurringSpendingDeclarations: readonly RecurringSpendingDeclaration[] = Object.freeze(
    input.scheduledRecurring.map((item, index) => {
      if (STANDARD_SPENDING_CATEGORIES[item.categoryCode] === undefined) {
        throw new DataInvariantError(
          'planning_context.invalid_recurring_category',
          'Recurring spending requires a standard category.',
        );
      }
      createMoney(item.amountMinor, EUR);
      return Object.freeze({
        id: generateUuidV7(`recurring-spending-declaration-${index}`),
        amountMinor: item.amountMinor,
        currency: EUR,
        categoryCode: item.categoryCode,
        recurrence: Object.freeze({
          kind: 'monthly_day_of_month' as const,
          dayOfMonth: validateMonthlyDay(
            item.recurrence.dayOfMonth,
            'planning_context.invalid_recurring_day',
          ),
        }),
      });
    }),
  );
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

  const primaryPaySchedule =
    input.primaryPaySchedule === null
      ? null
      : Object.freeze({
          kind: 'monthly_day_of_month' as const,
          dayOfMonth: validateMonthlyDay(
            input.primaryPaySchedule.dayOfMonth,
            'planning_context.invalid_pay_day',
          ),
        });
  const expectedPrimaryPaySchedule = createExpectedPrimaryPaySchedule({
    dates: Object.freeze([]),
    completeThrough: effectiveDate,
  });

  const payload = Object.freeze({
    ...current,
    recurringSpendingDeclarations,
    scheduledRecurring: Object.freeze([]),
    recurringScheduleComplete: input.recurringScheduleComplete,
    operationalNeeds: Object.freeze(operationalNeeds),
    futureObligations: Object.freeze(futureObligations),
    otherRestrictedCash: Object.freeze(otherRestrictedCash),
    primaryPaySchedule,
    nextReliableIncomeDate: null,
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
      recurringSpendingDeclarationCount: recurringSpendingDeclarations.length,
      operationalNeedsCount: operationalNeeds.length,
      futureObligationsCount: futureObligations.length,
      restrictedCashCount: otherRestrictedCash.length,
      primaryPaySchedule,
      reason,
    }),
  });
}
