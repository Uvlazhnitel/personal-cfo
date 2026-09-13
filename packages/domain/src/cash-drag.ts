import type { Completeness } from './completeness.js';
import { parseCompleteness } from './completeness.js';
import { DomainValidationError } from './errors.js';
import type { LocalDate } from './local-date.js';
import { parseLocalDate } from './local-date.js';
import type { Money } from './money.js';
import { createMoney } from './money.js';

export type CashDragDailyObservation = Readonly<{
  date: LocalDate;
  liquidCash: Money;
  comfortCash: Money;
  completeness: Completeness;
}>;

export function createCashDragDailyObservation(
  value: CashDragDailyObservation,
): CashDragDailyObservation {
  const liquidCash = createMoney(value.liquidCash.amountMinor, value.liquidCash.currency);
  const comfortCash = createMoney(value.comfortCash.amountMinor, value.comfortCash.currency);
  if (
    liquidCash.currency !== comfortCash.currency ||
    liquidCash.amountMinor < 0n ||
    comfortCash.amountMinor < 0n
  ) {
    throw new DomainValidationError(
      'cash_drag.invalid_daily_amounts',
      'Cash Drag daily amounts must be non-negative and use one currency.',
    );
  }
  return Object.freeze({
    date: parseLocalDate(value.date),
    liquidCash,
    comfortCash,
    completeness: parseCompleteness(value.completeness),
  });
}
