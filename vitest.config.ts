import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: {
    jsx: { runtime: 'automatic' },
  },
  test: {
    maxWorkers: 4,
    testTimeout: 15_000,
    coverage: {
      include: ['packages/domain/src/**/*.ts', 'packages/financial-engine/src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'json-summary'],
    },
    exclude: [...configDefaults.exclude, '**/test-integration/**'],
    include: [
      'packages/**/*.test.ts',
      'apps/worker/test/**/*.test.ts',
      'apps/web/test/**/*.test.{ts,tsx}',
    ],
  },
});
