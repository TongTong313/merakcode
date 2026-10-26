# MerakCode development notes

Monorepo for MerakCode, an AI coding tool: an Electron desktop app (the main product), a `merak` command line without a UI, and a TypeScript SDK. Node.js 26.12+, pnpm 12, TypeScript (ESM). This file lists what is easiest to get wrong; [CONTRIBUTING.md](CONTRIBUTING.md#contributing) is the full guide.

## Layout

- `packages/engine` — sessions, models, tools, permissions, the HTTP and event stream server. Most logic lives here.
- `packages/sandbox` — the OS sandbox, one backend per system; the engine runs commands through it.
- `packages/sdk/js` — the TypeScript SDK (`@merakcode/sdk`): engine launcher, high-level API, event store, plugin and adapter types, errors, transcript export. It is hand-written and editable, except `src/client/gen/` and `packages/sdk/openapi.json`, which are generated from the server's OpenAPI spec; never edit those by hand.
- `packages/util`, `packages/log` — shared helpers, the error code catalog, logging.
- `packages/client-core` — approval options for the desktop UI.
- `apps/cli` — the `merak` command. `merak serve` hosts the engine (the desktop installer ships this build). Only `serve`, `generate` and `debug` load the engine; every other command talks to it through `@merakcode/sdk`.
- `apps/desktop/main` — Electron main process; starts the bundled engine.
- `apps/desktop/renderer` — desktop UI (SolidJS + Vite, plain CSS with design tokens; no `!important`).

## Commands

- `pnpm check` at the root runs `format:check`, `check:brand`, `check:comments`, `check:versions`, `check:schema`, `check:errors`, `check:adapter-library`, `typecheck`, `check:deps`, `check:css`, `check:api`, `check:sdk-reference`, `check:sdk-docs`, `check:docs` and `check:unused`, in that order ([what each one checks](CONTRIBUTING.md#commands)). Run it before finishing a change. It runs no tests; CI also runs `pnpm test:script` and the tests of every package.
- Tests run per package: `cd <package> && pnpm test [file]`. `pnpm test` at the root only fails; the root `script/` folder is tested with `pnpm test:script`.
- Tests need `rg` (ripgrep) on PATH; without it every test process downloads its own copy from GitHub.
- End-to-end tests use real processes and a local fake model: `apps/cli` → `pnpm test:e2e` (the engine driven through the SDK); `apps/desktop/main` → `pnpm test:e2e` (launches the Electron app; build main and renderer first). Desktop development and these tests run the engine sources with the `node` on PATH, so it must be 26.12+ as well.
- Never edit generated files; regenerate them. After changing a route: `pnpm generate:sdk`, then `pnpm generate:sdk-reference`, and `pnpm check:api --write` if the SDK API snapshot changed (`pnpm check` does not notice a stale SDK client). After config options: `pnpm generate:schema`. After error codes: `pnpm generate:errors`. After `@merakcode/sdk/adapter` or a built-in adapter: `pnpm generate:adapter-library`.

## Conventions

- Prettier: no semicolons, 120 columns. The compiler rejects unused variables and imports (except in `packages/sdk/js`), and knip unused files, exports and dependencies. Nothing checks for commented-out code; don't leave any.
- Validate inputs with Zod. Tools implement `Tool.Info`.
- Code comments, log messages and test titles are in English; `check:comments` fails on Chinese in them (a `// i18n-allow` comment lets the next line through). User-facing text needs Chinese and English: `apps/cli/src/cli/locales/{zh-CN,en-US}.json` (keys must match and be used), `apps/desktop/renderer/src/i18n/{zh,en}.ts`, and `Text.pick({ zh, en })` in the engine. Model-facing prompts and tool descriptions are English only.
- Dependency boundaries (`check:deps`): only those three CLI commands load the engine, through `@merakcode/engine/host`; the desktop app and the other packages never import the engine or `apps/cli`; client code reaches the engine only through the SDK's generated methods, never its own `fetch`, `WebSocket` or `node:http`; module names are string literals. See [Boundary rules](CONTRIBUTING.md#boundary-rules).
- Logging: `Log.create({ service })` from `@merakcode/log/logger` in the engine and CLI, `Log.create(service)` from `src/log.ts` in the desktop main process, `log()` from `src/lib/bridge.ts` in the renderer. Don't use `console.*` for diagnostics, and never log keys, passwords or conversation content.
- An error a user can see needs an `MRK-xxxx` code in `packages/util/src/error-code.ts`: the thousands digit matches its `domain`, and `title` and `hint` have both `zh` and `en`. Then run `pnpm generate:errors`. See [Error codes and logs](CONTRIBUTING.md#error-codes-and-logs).
- Tests use Vitest against real behavior; avoid mocks. Use the `tmpdir()` fixture for temporary directories and a local fake model for replies. The engine's `pnpm test:live` calls real providers with real keys; don't run it unless asked.
- Prefer early returns over `else`, `const` over `let`, and small focused functions.
- A change users will notice gets a line under `Unreleased` in `CHANGELOG.md`, in both the English and the Chinese section. See [Pull requests](CONTRIBUTING.md#pull-requests).
- Commit messages follow [Commit messages](CONTRIBUTING.md#commit-messages). Never add `Co-authored-by` or other attribution lines to commits or pull request descriptions.
