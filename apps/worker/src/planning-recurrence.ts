import { createHash } from 'node:crypto';

import { DataInvariantError } from '@personal-cfo/data';
import {
  EUR,
  STANDARD_SPENDING_CATEGORIES,
  STANDARD_SPENDING_CATEGORY_CODES,
  createExpectedPrimaryPaySchedule,
  createMoney,
  createOperationalNeed,
  createScheduledSpending,
  parseDomainId,
  parseLocalDate,
} from '@personal-cfo/domain';
import type {
  LocalDate,
  OperationalNeed,
  ScheduledSpending,
  StandardSpendingCategoryCode,
} from '@personal-cfo/domain';
import type { FinancialCheckpointContext } from '@personal-cfo/financial-engine';

type MonthlyDayOfMonth = Readonly<{
  kind: 'monthly_day_of_month';
  dayOfMonth: number;
}>;

type RecurringSpendingDeclaration = Readonly<{
  id: string;
  amountMinor: bigint;
  categoryCode: StandardSpendingCategoryCode;
  recurrence: MonthlyDayOfMonth;
}>;

function record(value: unknown, code: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DataInvariantError(code, 'Planning recurrence declaration must be an object.');
  }
  return value as Readonly<Record<string, unknown>>;
}

function monthlyDay(value: unknown, code: string): MonthlyDayOfMonth {
  const recurrence = record(value, code);
  const dayOfMonth = recurrence['dayOfMonth'];
  if (
    recurrence['kind'] !== 'monthly_day_of_month' ||
    typeof dayOfMonth !== 'number' ||
    !Number.isSafeInteger(dayOfMonth) ||
    dayOfMonth < 1 ||
    dayOfMonth > 28
  ) {
    throw new DataInvariantError(code, 'V1 recurrence must be monthly on day 1 through 28.');
  }
  return Object.freeze({ kind: 'monthly_day_of_month', dayOfMonth });
}

function declarations(value: unknown): readonly RecurringSpendingDeclaration[] {
  if (!Array.isArray(value)) {
    throw new DataInvariantError(
      'assembly.invalid_recurring_spending_declarations',
      'Recurring spending declarations must be an array.',
    );
  }
  return Object.freeze(
    value.map((raw) => {
      const item = record(raw, 'assembly.invalid_recurring_spending_declaration');
      const categoryCode = item['categoryCode'];
      if (
        typeof categoryCode !== 'string' ||
        !STANDARD_SPENDING_CATEGORY_CODES.includes(categoryCode as StandardSpendingCategoryCode) ||
        typeof item['amountMinor'] !== 'bigint' ||
        item['amountMinor'] <= 0n ||
        item['currency'] !== EUR
      ) {
        throw new DataInvariantError(
          'assembly.invalid_recurring_spending_declaration',
          'Recurring spending declaration must use a standard category and positive EUR amount.',
        );
      }
      return Object.freeze({
        id: parseDomainId(item['id'], 'recurring-spending-declaration'),
        amountMinor: item['amountMinor'],
        categoryCode: categoryCode as StandardSpendingCategoryCode,
        recurrence: monthlyDay(
          item['recurrence'],
          'assembly.invalid_recurring_spending_recurrence',
        ),
      });
    }),
  );
}

function addDays(value: LocalDate, days: number): LocalDate {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return parseLocalDate(date.toISOString().slice(0, 10));
}

function nextMonth(value: string): string {
  const date = new Date(`${value}-01T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 7);
}

function monthlyDates(
  start: LocalDate,
  end: LocalDate,
  dayOfMonth: number,
  startInclusive: boolean,
  endInclusive: boolean,
): readonly LocalDate[] {
  const dates: LocalDate[] = [];
  for (let month = start.slice(0, 7); month <= end.slice(0, 7); month = nextMonth(month)) {
    const candidate = parseLocalDate(`${month}-${dayOfMonth.toString().padStart(2, '0')}`);
    if (
      (startInclusive ? candidate >= start : candidate > start) &&
      (endInclusive ? candidate <= end : candidate < end)
    ) {
      dates.push(candidate);
    }
  }
  return Object.freeze(dates);
}

function deterministicUuidV7(kind: string, sourceId: string, dueDate: LocalDate): string {
  const timestamp = BigInt(new Date(`${dueDate}T00:00:00.000Z`).getTime());
  const bytes = Buffer.alloc(16);
  let remaining = timestamp;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  createHash('sha256').update(`${kind}|${sourceId}|${dueDate}`).digest().copy(bytes, 6, 0, 10);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function primaryPayDeclaration(value: unknown): MonthlyDayOfMonth | null {
  if (value === null) return null;
  return monthlyDay(value, 'assembly.invalid_primary_pay_schedule');
}

function equivalentOperationalNeed(need: OperationalNeed, scheduled: ScheduledSpending): boolean {
  return (
    need.scheduledSpendingId === scheduled.id ||
    (need.dueDate === scheduled.dueDate &&
      need.amount.currency === scheduled.amount.currency &&
      need.amount.amountMinor === scheduled.amount.amountMinor &&
      need.necessity === scheduled.necessity &&
      need.direction === 'debit')
  );
}

export function deriveRunPlanningContext(
  current: FinancialCheckpointContext,
  effectiveDateValue: string,
  unknownIncomeHorizonDays: number,
): FinancialCheckpointContext {
  const effectiveDate = parseLocalDate(effectiveDateValue);
  const raw = current as unknown as Readonly<Record<string, unknown>>;
  const horizonEnd = addDays(effectiveDate, unknownIncomeHorizonDays);
  const hasPrimaryDeclaration = Object.hasOwn(raw, 'primaryPaySchedule');
  const payDeclaration = hasPrimaryDeclaration
    ? primaryPayDeclaration(raw['primaryPaySchedule'])
    : null;
  const expectedPrimaryPaySchedule = hasPrimaryDeclaration
    ? createExpectedPrimaryPaySchedule({
        dates:
          payDeclaration === null
            ? Object.freeze([])
            : monthlyDates(effectiveDate, horizonEnd, payDeclaration.dayOfMonth, false, true),
        completeThrough: payDeclaration === null ? effectiveDate : horizonEnd,
      })
    : current.nextReliableIncomeDate !== null && current.nextReliableIncomeDate <= effectiveDate
      ? createExpectedPrimaryPaySchedule({
          dates: Object.freeze([]),
          completeThrough: effectiveDate,
        })
      : current.expectedPrimaryPaySchedule;
  const nextReliableIncomeDate = hasPrimaryDeclaration
    ? (expectedPrimaryPaySchedule.dates[0] ?? null)
    : current.nextReliableIncomeDate !== null && current.nextReliableIncomeDate <= effectiveDate
      ? null
      : current.nextReliableIncomeDate;
  const operationalEnd = nextReliableIncomeDate ?? horizonEnd;

  const hasRecurringDeclarations = Object.hasOwn(raw, 'recurringSpendingDeclarations');
  if (!hasRecurringDeclarations) {
    const scheduledRecurring = current.scheduledRecurring.map((item) =>
      createScheduledSpending(item),
    );
    const hasCurrentOccurrence = scheduledRecurring.some(
      (item) =>
        item.dueDate.slice(0, 7) === effectiveDate.slice(0, 7) ||
        (item.dueDate >= effectiveDate && item.dueDate < operationalEnd),
    );
    return Object.freeze({
      ...current,
      recurringScheduleComplete:
        current.recurringScheduleComplete &&
        (scheduledRecurring.length === 0 || hasCurrentOccurrence),
      nextReliableIncomeDate,
      expectedPrimaryPaySchedule,
    });
  }

  const recurringDeclarations = declarations(raw['recurringSpendingDeclarations']);
  const targetMonthStart = parseLocalDate(`${effectiveDate.slice(0, 7)}-01`);
  const targetMonthEnd = parseLocalDate(`${nextMonth(effectiveDate.slice(0, 7))}-01`);
  const scheduledById = new Map<string, ScheduledSpending>();
  for (const declaration of recurringDeclarations) {
    const targetDates = monthlyDates(
      targetMonthStart,
      targetMonthEnd,
      declaration.recurrence.dayOfMonth,
      true,
      false,
    );
    const operationalDates = monthlyDates(
      effectiveDate,
      operationalEnd,
      declaration.recurrence.dayOfMonth,
      true,
      false,
    );
    for (const dueDate of new Set([...targetDates, ...operationalDates])) {
      const scheduled = createScheduledSpending({
        id: parseDomainId(
          deterministicUuidV7('scheduled-spending', declaration.id, dueDate),
          'scheduled-spending',
        ),
        dueDate,
        amount: createMoney(declaration.amountMinor, EUR),
        necessity: STANDARD_SPENDING_CATEGORIES[declaration.categoryCode].necessity,
      });
      scheduledById.set(scheduled.id, scheduled);
    }
  }
  const scheduledRecurring = Object.freeze(
    [...scheduledById.values()].sort(
      (left, right) => left.dueDate.localeCompare(right.dueDate) || left.id.localeCompare(right.id),
    ),
  );
  const manualNeeds = current.operationalNeeds.map((item) => createOperationalNeed(item));
  const matchedManualIndexes = new Set<number>();
  const derivedNeeds: OperationalNeed[] = [];
  for (const scheduled of scheduledRecurring.filter(
    (item) => item.dueDate >= effectiveDate && item.dueDate < operationalEnd,
  )) {
    const linkedIndex = manualNeeds.findIndex(
      (item, index) =>
        !matchedManualIndexes.has(index) && item.scheduledSpendingId === scheduled.id,
    );
    const equivalentIndex =
      linkedIndex >= 0
        ? linkedIndex
        : manualNeeds.findIndex(
            (item, index) =>
              !matchedManualIndexes.has(index) && equivalentOperationalNeed(item, scheduled),
          );
    if (equivalentIndex >= 0) {
      matchedManualIndexes.add(equivalentIndex);
      continue;
    }
    derivedNeeds.push(
      createOperationalNeed({
        id: parseDomainId(
          deterministicUuidV7('operational-need', scheduled.id, scheduled.dueDate),
          'operational-need',
        ),
        dueDate: scheduled.dueDate,
        amount: scheduled.amount,
        necessity: scheduled.necessity,
        direction: 'debit',
        state: 'scheduled',
        scheduledSpendingId: scheduled.id,
      }),
    );
  }

  return Object.freeze({
    ...current,
    scheduledRecurring,
    operationalNeeds: Object.freeze([...manualNeeds, ...derivedNeeds]),
    nextReliableIncomeDate,
    expectedPrimaryPaySchedule,
  });
}
