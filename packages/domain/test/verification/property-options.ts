import type fc from 'fast-check';

type AssertOptions = NonNullable<Parameters<typeof fc.assert>[1]>;

function parseSeed(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^-?[0-9]+$/.test(value)) throw new Error('FC_SEED must be a base-10 integer.');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('FC_SEED must be a safe integer.');
  return parsed;
}

export function propertyOptions(seed: number, numRuns: number): AssertOptions {
  const environment = (
    globalThis as typeof globalThis & {
      process?: { env?: Readonly<Record<string, string | undefined>> };
    }
  ).process?.env;
  const resolvedSeed = parseSeed(environment?.['FC_SEED'], seed);
  const path = environment?.['FC_PATH'];
  return path === undefined || path.length === 0
    ? { seed: resolvedSeed, numRuns }
    : { seed: resolvedSeed, path, numRuns };
}
