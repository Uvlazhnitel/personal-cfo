import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

const infrastructureImports = [
  '**/apps/**',
  '**/data/**',
  '**/integrations/**',
  'next',
  'next/*',
  'react',
  'react/*',
  'drizzle-orm',
  'drizzle-orm/*',
  'pg',
  'pg/*',
  'openai',
  'openai/*',
  '@ai-sdk/*',
  'telegraf',
  'telegraf/*',
];

export default tseslint.config(
  {
    ignores: ['**/.next/**', '**/dist/**', 'coverage/**', 'node_modules/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['packages/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@personal-cfo/*', '**/financial-engine/**', ...infrastructureImports],
              message: 'The domain package must remain provider- and infrastructure-neutral.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/financial-engine/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@personal-cfo/web',
                '@personal-cfo/web/*',
                '@personal-cfo/worker',
                '@personal-cfo/worker/*',
                '@personal-cfo/data',
                '@personal-cfo/data/*',
                '@personal-cfo/integrations',
                '@personal-cfo/integrations/*',
                ...infrastructureImports,
              ],
              message:
                'The financial engine may depend only on provider-neutral domain code and deterministic utilities.',
            },
          ],
        },
      ],
    },
  },
  {
    ...tseslint.configs.disableTypeChecked,
    files: ['scripts/**/*.mjs', '*.config.mjs'],
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
);
