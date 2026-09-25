import { build } from 'esbuild';

const shared = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  sourcemap: true,
  external: ['argon2', 'drizzle-orm', 'drizzle-orm/*', 'pg', 'pg-boss', 'decimal.js'],
};

await build({
  ...shared,
  entryPoints: {
    index: 'src/index.ts',
    'cli/migrate': 'src/cli/migrate.ts',
    'cli/create-user': 'src/cli/create-user.ts',
    'cli/enable-banking-fetch': 'src/cli/enable-banking-fetch.ts',
    'cli/portfolio-manager-sync': 'src/cli/portfolio-manager-sync.ts',
    'cli/sharesight-sync': 'src/cli/sharesight-sync.ts',
    'dev/import-synthetic': 'src/dev/import-synthetic.ts',
  },
  outdir: 'dist',
});
