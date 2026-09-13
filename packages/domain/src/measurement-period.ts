import { DomainValidationError } from './errors.js';
import type { Instant } from './instant.js';
import { compareInstants, parseInstant } from './instant.js';

export type MeasurementPeriod = Readonly<{
  startInclusive: Instant;
  endExclusive: Instant;
}>;

export function createMeasurementPeriod(period: MeasurementPeriod): MeasurementPeriod {
  const startInclusive = parseInstant(period.startInclusive);
  const endExclusive = parseInstant(period.endExclusive);

  if (compareInstants(startInclusive, endExclusive) >= 0) {
    throw new DomainValidationError(
      'period.invalid_boundaries',
      'A measurement period must end after it starts.',
    );
  }

  return Object.freeze({ startInclusive, endExclusive });
}

export function periodContains(period: MeasurementPeriod, instant: Instant): boolean {
  return (
    compareInstants(instant, period.startInclusive) >= 0 &&
    compareInstants(instant, period.endExclusive) < 0
  );
}
