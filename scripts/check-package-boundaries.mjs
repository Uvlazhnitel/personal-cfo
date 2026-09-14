import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const packages = [
  ['apps/web', '@personal-cfo/web'],
  ['apps/worker', '@personal-cfo/worker'],
  ['packages/domain', '@personal-cfo/domain'],
  ['packages/financial-engine', '@personal-cfo/financial-engine'],
  ['packages/data', '@personal-cfo/data'],
  ['packages/integrations', '@personal-cfo/integrations'],
];

const localPackageNames = new Set(packages.map(([, name]) => name));
const allowedDependencies = new Map([
  ['@personal-cfo/domain', new Set()],
  ['@personal-cfo/financial-engine', new Set(['@personal-cfo/domain', 'decimal.js'])],
  ['@personal-cfo/data', new Set(['@personal-cfo/domain'])],
  ['@personal-cfo/integrations', new Set(['@personal-cfo/domain'])],
  [
    '@personal-cfo/web',
    new Set([
      '@personal-cfo/domain',
      '@personal-cfo/financial-engine',
      '@personal-cfo/data',
      '@personal-cfo/integrations',
    ]),
  ],
  [
    '@personal-cfo/worker',
    new Set([
      '@personal-cfo/domain',
      '@personal-cfo/financial-engine',
      '@personal-cfo/data',
      '@personal-cfo/integrations',
    ]),
  ],
]);

const dependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];
const violations = [];

for (const [directory, expectedName] of packages) {
  const manifestPath = join(process.cwd(), directory, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  if (manifest.name !== expectedName) {
    violations.push(`${directory}: expected package name ${expectedName}`);
  }

  const allowed = allowedDependencies.get(expectedName);
  for (const field of dependencyFields) {
    const dependencies = manifest[field] ?? {};
    for (const dependency of Object.keys(dependencies)) {
      if (localPackageNames.has(dependency) && !allowed.has(dependency)) {
        violations.push(`${expectedName}: ${field} cannot include ${dependency}`);
      }

      if (expectedName === '@personal-cfo/domain' && !localPackageNames.has(dependency)) {
        violations.push(
          `${expectedName}: ${field} cannot include external dependency ${dependency}`,
        );
      }

      if (
        expectedName === '@personal-cfo/financial-engine' &&
        !localPackageNames.has(dependency) &&
        dependency !== 'decimal.js'
      ) {
        violations.push(
          `${expectedName}: ${field} cannot include external dependency ${dependency}`,
        );
      }
    }
  }
}

if (violations.length > 0) {
  for (const violation of violations) {
    console.error(violation);
  }
  process.exitCode = 1;
} else {
  console.log('Package dependency boundaries are valid.');
}
