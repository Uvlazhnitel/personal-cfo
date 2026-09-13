import { FinancialEngineInvariantError } from './errors.js';

export function halfEvenDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new FinancialEngineInvariantError(
      'math.invalid_denominator',
      'Exact division requires a positive denominator.',
    );
  }
  const sign = numerator < 0n ? -1n : 1n;
  const absolute = numerator < 0n ? -numerator : numerator;
  const quotient = absolute / denominator;
  const remainder = absolute % denominator;
  const doubled = remainder * 2n;
  const rounded =
    doubled > denominator || (doubled === denominator && quotient % 2n !== 0n)
      ? quotient + 1n
      : quotient;
  return sign * rounded;
}

export function median(values: readonly bigint[]): bigint {
  if (values.length === 0) {
    throw new FinancialEngineInvariantError('math.empty_median', 'Median requires a value.');
  }
  const sorted = [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : halfEvenDivide(sorted[middle - 1]! + sorted[middle]!, 2n);
}

export function nearestRank(values: readonly bigint[], percentile: bigint, scale: bigint): bigint {
  if (values.length === 0) return 0n;
  if (percentile <= 0n || percentile > scale || scale <= 0n) {
    throw new FinancialEngineInvariantError(
      'math.invalid_percentile',
      'Nearest-rank percentile must be in (0, 1].',
    );
  }
  const sorted = [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const rank = Number((percentile * BigInt(sorted.length) + scale - 1n) / scale);
  return sorted[rank - 1]!;
}

export function multiplyFractionHalfEven(
  amount: bigint,
  numerator: bigint,
  denominator: bigint,
): bigint {
  return halfEvenDivide(amount * numerator, denominator);
}
