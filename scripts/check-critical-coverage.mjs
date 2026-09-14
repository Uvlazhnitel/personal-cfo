import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const SUMMARY_PATH = resolve('coverage/coverage-summary.json');
const CRITICAL_MODULES = Object.freeze([
  'packages/domain/src/money.ts',
  'packages/domain/src/canonical-transaction.ts',
  'packages/financial-engine/src/sinking-funds.ts',
  'packages/financial-engine/src/capital-conversion.ts',
  'packages/financial-engine/src/safe-to-invest.ts',
]);

function branchSummary(summary, modulePath) {
  const absolutePath = resolve(modulePath);
  const entry = summary[absolutePath];
  if (entry === undefined) {
    throw new Error(`Critical coverage entry is missing: ${modulePath}`);
  }
  const { covered, total } = entry.branches;
  if (!Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(covered)) {
    throw new Error(`Critical coverage entry is malformed: ${modulePath}`);
  }
  return { covered, total };
}

const summary = JSON.parse(await readFile(SUMMARY_PATH, 'utf8'));
const failures = [];

for (const metric of ['statements', 'branches', 'functions', 'lines']) {
  const { covered, total } = summary.total?.[metric] ?? {};
  if (!Number.isSafeInteger(covered) || !Number.isSafeInteger(total) || total <= 0) {
    throw new Error(`Global ${metric} coverage is missing or malformed.`);
  }
  const percentage = ((covered / total) * 100).toFixed(2);
  console.log(`global ${metric}: ${covered}/${total} (${percentage}%)`);
}

for (const modulePath of CRITICAL_MODULES) {
  const { covered, total } = branchSummary(summary, modulePath);
  const percentage = ((covered / total) * 100).toFixed(2);
  console.log(`${modulePath}: ${covered}/${total} branches (${percentage}%)`);
  if (covered !== total) failures.push(`${modulePath}: ${covered}/${total}`);
}

if (failures.length > 0) {
  console.error(`Critical branch coverage must be exact: ${failures.join('; ')}`);
  process.exitCode = 1;
}
