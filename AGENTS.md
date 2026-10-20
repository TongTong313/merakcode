# MerakCode development notes

Monorepo for MerakCode, an AI coding agent with a terminal UI and an Electron desktop app. Node.js 26.12+, pnpm 12, TypeScript (ESM). See CONTRIBUTING.md for the full guide.

## Layout

- `packages/engine` — sessions, tools, permissions, sandbox, HTTP server. Most logic lives here.
- `apps/cli` — `merak` command and the terminal UI (SolidJS on OpenTUI). Talks to the engine through `@merakcode/sdk`.
- `apps/desktop/main` — Electron main process; starts the bundled engine.
- `apps/desktop/renderer` — desktop UI (SolidJS + Vite, plain CSS with design tokens; no `!important`).
- `packages/sdk` — generated from the server's OpenAPI spec. Never edit by hand; run `pnpm generate:sdk` after changing a route.
- `packages/client-core` — approval options shared by the terminal UI and the desktop UI.

## Commands

- `pnpm check` at the root: formatting, config schema, typecheck, dependency boundaries, no `!important`, SDK API snapshot, unused code. Run before finishing a change.
- Tests run per package: `cd <package> && pnpm test [file]`. There is no root test command.
- End-to-end tests use real processes and a local fake model: `apps/cli` → `pnpm test:e2e` (terminal UI); `apps/desktop/main` → `pnpm test:e2e` (launches the Electron app; build main and renderer first).
- After changing config options, run `pnpm generate:schema`.

## Conventions

- Prettier: no semicolons, 120 columns. The compiler rejects unused variables and imports.
- Validate inputs with Zod. Tools implement `Tool.Info`.
- Log with `Log.create({ service })`; don't use `console.*` for diagnostics.
- User-facing text needs Chinese and English: `apps/cli/src/cli/locales/{zh-CN,en-US}.json` (keys must match), `apps/desktop/renderer/src/i18n/{zh,en}.ts`, and `Text.pick({ zh, en })` in the engine. Model-facing prompts and tool descriptions are English only.
- Tests use Vitest against real behavior; avoid mocks. Use the `tmpdir()` fixture for temporary directories.
- Prefer early returns over `else`, `const` over `let`, and small focused functions. Don't leave commented-out code.
