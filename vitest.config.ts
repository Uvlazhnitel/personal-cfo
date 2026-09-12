import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      include: ['packages/domain/src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'json-summary'],
    },
    include: ['packages/**/*.test.ts'],
  },
});
