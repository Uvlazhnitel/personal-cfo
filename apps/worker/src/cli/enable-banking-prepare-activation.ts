import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stdin, stdout } from 'node:process';

import {
  createDatabaseContext,
  enableBankingProviderAccounts,
  prepareEnableBankingActivation,
  requireDatabaseUrl,
} from '@personal-cfo/data';
import { and, eq, isNotNull } from 'drizzle-orm';

import { activationFilePaths, writeActivationPlan } from '../enable-banking/activation-files.js';

import {
  enableBankingConfiguration,
  enableBankingScheduleConfiguration,
} from '../enable-banking/config.js';

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} is required.`);
  return value;
}

async function readHidden(prompt: string): Promise<string> {
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise<string>((resolveValue, reject) => {
    let value = '';
    const finish = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === '\u0003') {
          finish();
          reject(new Error('Cancelled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          stdout.write('\n');
          finish();
          resolveValue(value);
          return;
        }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ') value += character;
      }
    };
    stdin.on('data', onData);
  });
}

function exactEuroMinor(value: string): bigint {
  if (!/^-?(0|[1-9][0-9]*)\.[0-9]{2}$/u.test(value))
    throw new Error('Opening balance must be an exact EUR decimal with two fraction digits.');
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [major, fraction] = unsigned.split('.') as [string, string];
  const minor = BigInt(major) * 100n + BigInt(fraction);
  return negative ? -minor : minor;
}

function rigaMidnight(value: string): string {
  const guess = Date.parse(`${value}T00:00:00.000Z`);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Riga',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(guess));
  const number = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((candidate) => candidate.type === type)?.value);
  const represented = Date.UTC(
    number('year'),
    number('month') - 1,
    number('day'),
    number('hour'),
    number('minute'),
    number('second'),
  );
  return new Date(guess - (represented - guess)).toISOString();
}

if (!stdin.isTTY || !stdout.isTTY) throw new Error('Interactive TTY is required.');
const statementPath = argument('--statement');
const statementPeriodFrom = argument('--from');
const statementPeriodThrough = argument('--through');
const { statement, output: outputPath } = await activationFilePaths(
  process.cwd(),
  statementPath,
  argument('--output'),
);
const configuration = await enableBankingConfiguration();
const schedule = enableBankingScheduleConfiguration();
if (configuration.canonicalImportEnabled === true || schedule.enabled)
  throw new Error('Canonical import and scheduling must remain disabled during preparation.');
const openingBalanceMinor = exactEuroMinor(await readHidden('Official opening balance (EUR): '));
const statementSha256 = createHash('sha256')
  .update(await readFile(statement))
  .digest('hex');
const database = createDatabaseContext(requireDatabaseUrl(), { maxConnections: 2 });
try {
  const accounts = await database.db.query.enableBankingProviderAccounts.findMany({
    where: and(
      eq(enableBankingProviderAccounts.ownerId, configuration.ownerId),
      isNotNull(enableBankingProviderAccounts.canonicalAccountId),
    ),
  });
  if (accounts.length !== 1) throw new Error('Exactly one bound provider account is required.');
  const evidence = Object.freeze({
    providerAccountId: accounts[0]!.id,
    openingBalanceMinor,
    currency: 'EUR' as const,
    statementPeriodFrom,
    statementPeriodThrough,
    balanceBoundaryAt: rigaMidnight(statementPeriodFrom),
    statementSha256,
  });
  const now = new Date().toISOString();
  const plan = await prepareEnableBankingActivation(
    database.db,
    configuration.ownerId,
    evidence,
    now,
  );
  const payload = JSON.stringify(
    {
      version: 1,
      preparedAt: now,
      evidence: { ...evidence, openingBalanceMinor: evidence.openingBalanceMinor.toString() },
      plan,
    },
    null,
    2,
  );
  await writeActivationPlan(outputPath, payload);
  console.info(
    JSON.stringify({
      event: 'enable_banking.activation_prepared',
      ready: plan.ready,
      blockers: plan.blockers,
      bookedCount: plan.bookedCount,
      pendingCount: plan.pendingCount,
      coverageFrom: plan.coverageFrom,
      coverageThrough: plan.coverageThrough,
      reconciliation: plan.reconciliation,
      expectedCanonicalTransactions: plan.expectedCanonicalTransactions,
      expectedCanonicalImports: plan.expectedCanonicalImports,
      expectedUnresolvedAmbiguities: plan.expectedUnresolvedAmbiguities,
    }),
  );
} finally {
  await database.close();
}
