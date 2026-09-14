import { parseLocalDate, parseYearMonth } from '@personal-cfo/domain';
import type { LocalDate, YearMonth } from '@personal-cfo/domain';

export function daysInGregorianMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function dateParts(date: LocalDate): readonly [number, number, number] {
  return [Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10))];
}

export function localDateOrdinal(date: LocalDate): number {
  const [year, month, day] = dateParts(date);
  const priorYear = year - 1;
  let result =
    priorYear * 365 +
    Math.floor(priorYear / 4) -
    Math.floor(priorYear / 100) +
    Math.floor(priorYear / 400);
  for (let currentMonth = 1; currentMonth < month; currentMonth += 1) {
    result += daysInGregorianMonth(year, currentMonth);
  }
  return result + day - 1;
}

export function localDateFromOrdinal(ordinal: number): LocalDate {
  let low = 1;
  let high = 9999;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const start = localDateOrdinal(parseLocalDate(`${middle.toString().padStart(4, '0')}-01-01`));
    if (start <= ordinal) low = middle;
    else high = middle - 1;
  }
  let remaining =
    ordinal - localDateOrdinal(parseLocalDate(`${low.toString().padStart(4, '0')}-01-01`));
  let month = 1;
  while (remaining >= daysInGregorianMonth(low, month)) {
    remaining -= daysInGregorianMonth(low, month);
    month += 1;
  }
  return parseLocalDate(
    `${low.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${(remaining + 1).toString().padStart(2, '0')}`,
  );
}

export function addLocalDays(date: LocalDate, days: number): LocalDate {
  return localDateFromOrdinal(localDateOrdinal(date) + days);
}

export function localDaysBetween(startInclusive: LocalDate, endExclusive: LocalDate): number {
  return localDateOrdinal(endExclusive) - localDateOrdinal(startInclusive);
}

export function yearMonthFromLocalDate(date: LocalDate): YearMonth {
  return parseYearMonth(date.slice(0, 7));
}

export function priorYearMonths(target: YearMonth, count: number): readonly YearMonth[] {
  const targetYear = Number(target.slice(0, 4));
  const targetMonth = Number(target.slice(5, 7));
  const targetIndex = targetYear * 12 + targetMonth - 1;
  const result: YearMonth[] = [];
  for (let offset = count; offset >= 1; offset -= 1) {
    const index = targetIndex - offset;
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
    if (year >= 1) {
      result.push(
        parseYearMonth(`${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}`),
      );
    }
  }
  return Object.freeze(result);
}

export function addYearMonths(month: YearMonth, offset: number): YearMonth {
  if (!Number.isSafeInteger(offset)) throw new RangeError('Year-month offset must be an integer.');
  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5, 7)) - 1;
  const absolute = year * 12 + monthIndex + offset;
  const resultYear = Math.floor(absolute / 12);
  const resultMonth = (absolute % 12) + 1;
  return parseYearMonth(
    `${resultYear.toString().padStart(4, '0')}-${resultMonth.toString().padStart(2, '0')}`,
  );
}
