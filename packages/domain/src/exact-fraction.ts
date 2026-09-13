import { DomainValidationError } from './errors.js';

export type ExactFraction = Readonly<{
  numerator: bigint;
  denominator: bigint;
}>;

export function createExactFraction(numerator: unknown, denominator: unknown): ExactFraction {
  if (typeof numerator !== 'bigint' || typeof denominator !== 'bigint' || denominator <= 0n) {
    throw new DomainValidationError(
      'fraction.invalid',
      'ExactFraction requires a bigint numerator and a positive bigint denominator.',
    );
  }
  return Object.freeze({ numerator, denominator });
}
