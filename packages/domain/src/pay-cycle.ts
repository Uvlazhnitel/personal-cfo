import type { PayCycleId, TransactionId } from './domain-id.js';
import { parsePayCycleId, parseTransactionId, serializeDomainId } from './domain-id.js';
import { DomainValidationError } from './errors.js';
import type { Instant } from './instant.js';
import { compareInstants, parseInstant } from './instant.js';
import type { LocalDate } from './local-date.js';
import { compareLocalDates, parseLocalDate } from './local-date.js';
import { parseStringEnum } from './validation.js';

const PAY_CYCLE_STATUSES = ['closed', 'open'] as const;

export type PrimarySalaryTrigger = Readonly<{
  transactionId: TransactionId;
  effectiveDate: LocalDate;
}>;

export function createPrimarySalaryTrigger(value: PrimarySalaryTrigger): PrimarySalaryTrigger {
  return Object.freeze({
    transactionId: parseTransactionId(value.transactionId),
    effectiveDate: parseLocalDate(value.effectiveDate),
  });
}

export type PayCycle = Readonly<{
  id: PayCycleId;
  openingSalaryTransactionId: TransactionId;
  startInclusive: Instant;
  startDate: LocalDate;
  closingSalaryTransactionId: TransactionId | null;
  endExclusive: Instant | null;
  expectedNextPayDate: LocalDate | null;
  status: 'closed' | 'open';
}>;

export function createPayCycle(value: PayCycle): PayCycle {
  const status = parseStringEnum(value.status, PAY_CYCLE_STATUSES, 'PayCycleStatus');
  const id = parsePayCycleId(value.id);
  const openingSalaryTransactionId = parseTransactionId(value.openingSalaryTransactionId);
  const startInclusive = parseInstant(value.startInclusive);
  const endExclusive = value.endExclusive === null ? null : parseInstant(value.endExclusive);
  const closingSalaryTransactionId =
    value.closingSalaryTransactionId === null
      ? null
      : parseTransactionId(value.closingSalaryTransactionId);

  if (
    (status === 'open' && (endExclusive !== null || closingSalaryTransactionId !== null)) ||
    (status === 'closed' && (endExclusive === null || closingSalaryTransactionId === null))
  ) {
    throw new DomainValidationError(
      'pay_cycle.invalid_closure',
      'Open Pay Cycles cannot have a closing salary; closed Pay Cycles require one.',
    );
  }
  if (endExclusive !== null && compareInstants(endExclusive, startInclusive) <= 0) {
    throw new DomainValidationError(
      'pay_cycle.invalid_boundaries',
      'A Pay Cycle must end after it starts.',
    );
  }
  if (serializeDomainId(id) !== serializeDomainId(openingSalaryTransactionId)) {
    throw new DomainValidationError(
      'pay_cycle.invalid_identity',
      'A derived Pay Cycle ID must equal its opening salary transaction UUID.',
    );
  }
  if (closingSalaryTransactionId === openingSalaryTransactionId) {
    throw new DomainValidationError(
      'pay_cycle.self_closing',
      'A Pay Cycle cannot close with its opening salary transaction.',
    );
  }

  const startDate = parseLocalDate(value.startDate);
  const expectedNextPayDate =
    value.expectedNextPayDate === null ? null : parseLocalDate(value.expectedNextPayDate);
  if (expectedNextPayDate !== null && compareLocalDates(expectedNextPayDate, startDate) <= 0) {
    throw new DomainValidationError(
      'pay_cycle.invalid_expected_date',
      'An expected next pay date must follow the cycle start date.',
    );
  }
  if (status === 'closed' && expectedNextPayDate !== null) {
    throw new DomainValidationError(
      'pay_cycle.closed_with_expected_date',
      'A closed Pay Cycle uses its actual closing salary and cannot retain an expected pay date.',
    );
  }

  return Object.freeze({
    id,
    openingSalaryTransactionId,
    startInclusive,
    startDate,
    closingSalaryTransactionId,
    endExclusive,
    expectedNextPayDate,
    status,
  });
}

export type ExpectedPrimaryPaySchedule = Readonly<{
  dates: readonly LocalDate[];
  completeThrough: LocalDate;
}>;

export function createExpectedPrimaryPaySchedule(
  value: ExpectedPrimaryPaySchedule,
): ExpectedPrimaryPaySchedule {
  const dates = Object.freeze(value.dates.map((date) => parseLocalDate(date)));
  const completeThrough = parseLocalDate(value.completeThrough);

  for (let index = 1; index < dates.length; index += 1) {
    if (compareLocalDates(dates[index - 1]!, dates[index]!) >= 0) {
      throw new DomainValidationError(
        'pay_schedule.invalid_order',
        'Expected primary-pay dates must be unique and strictly increasing.',
      );
    }
  }
  if (dates.some((date) => compareLocalDates(date, completeThrough) > 0)) {
    throw new DomainValidationError(
      'pay_schedule.date_after_coverage',
      'Expected primary-pay dates cannot exceed schedule coverage.',
    );
  }

  return Object.freeze({ dates, completeThrough });
}
