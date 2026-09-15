import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      include: ['packages/domain/src/**/*.ts', 'packages/financial-engine/src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'json-summary'],
    },
    exclude: [...configDefaults.exclude, '**/test-integration/**'],
    include: ['packages/**/*.test.ts'],
  },
});
