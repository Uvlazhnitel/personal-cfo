# Repository Guidelines

## Project Structure & Module Organization

This repository is currently requirements-first. The authoritative specification is `docs/FRD.md`; update it when behavior, scope, calculations, or integrations change. Keep additional design notes under `docs/`, using names such as `docs/open-banking.md`.

No application or test directories exist yet. When implementation begins, use `src/` for application code, `tests/` for tests, and `assets/` for static files. Separate financial formulas, integrations, Telegram handling, and UI concerns.

## Build, Test, and Development Commands

No package manifest, build system, or test runner exists yet. Useful checks today include:

```sh
rg '^## FR-' docs/FRD.md     # list functional requirements
git diff --check             # detect whitespace errors (after Git setup)
```

When adding tooling, expose `test`, `lint`, `format`, and `dev` tasks and update this guide.

## Coding Style & Naming Conventions

Commit formatter and linter configuration with the first implementation. Until then, use four spaces in code examples, UTF-8 text, and concise Markdown headings. Prefer domain names such as `safeToInvest`, `sinkingFund`, and `cashAccount`. Reference FRD IDs where traceability helps, for example `FR-070 calculates investable cash`.

Keep critical financial calculations deterministic and isolated from AI-generated explanations. Represent money with decimal or integer minor-unit types, never binary floating point.

## Testing Guidelines

Unit-test every financial formula and edge cases such as transfers, refunds, duplicate imports, reserved cash, and currencies. Integration-test bank, portfolio, and Telegram adapters with fixtures, not live credentials. Name tests after observable behavior and reference the relevant FRD ID. Run the full suite before opening a pull request.

## Commit & Pull Request Guidelines

Git history is unavailable, so no existing convention can be inferred. Use short, imperative subjects, optionally with a Conventional Commit prefix: `feat: add cash transfer classification`. Pull requests should summarize the change, identify affected requirements, report validation, and include screenshots for UI changes. Link issues and call out migrations, configuration, or security implications.

## Security & Configuration

Never commit banking credentials, API tokens, personal transaction data, or production exports. Keep secrets in ignored environment files or a secret manager. Encrypt stored tokens, authenticate financial APIs, and whitelist the permitted Telegram user ID as required by `docs/FRD.md`.
