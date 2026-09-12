# Personal CFO

Personal CFO is a deterministic, self-hosted financial decision system. The repository is currently at Stage 1A: workspace tooling and provider-neutral domain primitives only.

## Requirements

- Node.js 24
- pnpm 11.19.0

## Development

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm format:check
```

Use `pnpm format` to apply formatting and `pnpm test:coverage` to generate a local coverage report.

Accepted requirements, architecture, data rules, financial policies, and delivery stages are documented in [`docs/`](docs/).
