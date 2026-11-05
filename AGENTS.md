# MerakCode development notes

Monorepo for MerakCode, an AI coding tool: an Electron desktop app (the main product), a `merak` command line without a UI, and a TypeScript SDK. Node.js 26.12+, pnpm 12, TypeScript (ESM). This file lists what is easiest to get wrong; [CONTRIBUTING.md](CONTRIBUTING.md#contributing) is the full guide.

## v1.0.0 rebuild

The `dev-v1.0.0` branch rebuilds the engine from scratch. The user designs each module: implement what the user has decided, and ask when a design question is still open.

- Don't read, search or copy the v0.3 engine (the `v0.3.0` tag, other branches, or other clones of this repository) unless the user asks. Work from the user's design and from tests.
- The CLI, the desktop app and the SDK still speak the v0.3 engine's protocol; they move to the new engine once its protocol exists. Until then `apps/cli` is left out of `pnpm typecheck`, `check:sdk` and `check:adapter-library` are left out of `pnpm check` (`generate:sdk` and `generate:adapter-library` fail too), tests that start an engine (in `apps/cli`, `packages/sdk/js` and the desktop end-to-end tests) are expected to fail, and `.github/workflows/ci.yml`, which runs only on pull requests and pushes to `main`, still describes v0.3.

## Layout

- `packages/engine` — the engine being rebuilt; `src/index.ts` is its entry. See [Engine code](#engine-code).
- `packages/sdk/js` — the TypeScript SDK (`@merakcode/sdk`): engine launcher, high-level API, event store, plugin and adapter types, errors, transcript export. It is hand-written and editable, except `src/client/gen/` and `packages/sdk/openapi.json`, which are generated from the server's OpenAPI spec; never edit those by hand.
- `packages/util`, `packages/log` — shared helpers, the error code catalog, logging.
- `apps/cli` — the `merak` command. `merak serve` hosts the engine (the desktop installer ships this build). Only `serve`, `generate` and `debug` load the engine; every other command talks to it through `@merakcode/sdk`.
- `apps/desktop/main` — Electron main process; starts the bundled engine.
- `apps/desktop/renderer` — desktop UI (SolidJS + Vite, plain CSS with design tokens; no `!important`).

## Engine code

- Sources run on plain `node`, with no loader. Use only erasable TypeScript (`erasableSyntaxOnly`: no `namespace`, `enum` or parameter properties), end relative imports in `.ts`, and import types with `import type`. Keep prompts and tool descriptions in `.ts` files; nothing loads `.txt` imports. `test/node-runtime.test.ts` loads every source file on plain Node.
- Files under `packages/engine/src` never import each other in a cycle; type-only and dynamic imports count (`check:deps`).
- Dependencies start from zero, workspace packages such as `@merakcode/util` and `@merakcode/log` included. Add one to `packages/engine/package.json` only for a reason the user agrees with. `check:deps` rejects packages the engine imports without listing them, and devDependencies in `src`.

## Commands

- `pnpm check` at the root runs `format:check`, `check:brand`, `check:comments`, `check:versions`, `check:errors`, `typecheck`, `check:deps`, `check:css`, `check:api`, `check:sdk-reference`, `check:sdk-docs`, `check:docs` and `check:unused`, in that order ([what each one checks](CONTRIBUTING.md#commands)). Run it before finishing a change. It runs no tests; run `pnpm test:script` and the tests of the packages you changed as well.
- Tests run per package: `cd <package> && pnpm test [file]`. `pnpm test` at the root only fails; the root `script/` folder is tested with `pnpm test:script`.
- Tests need `rg` (ripgrep) on PATH; without it every test process downloads its own copy from GitHub.
- End-to-end tests use real processes and a local fake model: `apps/cli` → `pnpm test:e2e` (the engine driven through the SDK); `apps/desktop/main` → `pnpm test:e2e` (launches the Electron app; build main and renderer first). Desktop development and these tests run the engine sources with the `node` on PATH, so it must be 26.12+ as well.
- Never edit generated files; regenerate them. After error codes: `pnpm generate:errors`. After changing the SDK's public API on purpose: `pnpm check:api --write`.

## Conventions

- Prettier: no semicolons, 120 columns. The compiler rejects unused variables and imports (except in `packages/sdk/js`), and knip unused files, exports and dependencies. Nothing checks for commented-out code; don't leave any.
- Validate inputs with Zod.
- Code comments, log messages and test titles are in English; `check:comments` fails on Chinese in them (a `// i18n-allow` comment lets the next line through). User-facing text needs Chinese and English: `apps/cli/src/cli/locales/{zh-CN,en-US}.json` (keys must match and be used) and `apps/desktop/renderer/src/i18n/{zh,en}.ts`. Model-facing prompts and tool descriptions are English only.
- Dependency boundaries (`check:deps`): only those three CLI commands load the engine, through `@merakcode/engine/host`; the desktop app and the other packages never import the engine or `apps/cli`; client code reaches the engine only through the SDK's generated methods, never its own `fetch`, `WebSocket` or `node:http`; module names are string literals, in the engine too. See [Boundary rules](CONTRIBUTING.md#boundary-rules).
- Logging: `Log.create({ service })` from `@merakcode/log/logger` in the CLI, `Log.create(service)` from `src/log.ts` in the desktop main process, `log()` from `src/lib/bridge.ts` in the renderer. Don't use `console.*` for diagnostics, and never log keys, passwords or conversation content.
- An error a user can see needs an `MRK-xxxx` code in `packages/util/src/error-code.ts`: the thousands digit matches its `domain`, and `title` and `hint` have both `zh` and `en`. Then run `pnpm generate:errors`. See [Error codes and logs](CONTRIBUTING.md#error-codes-and-logs).
- Tests use Vitest against real behavior; avoid mocks. Use a `tmpdir()` fixture for temporary directories and a local fake model for replies.
- Prefer early returns over `else`, `const` over `let`, and small focused functions.
- A change users will notice gets a line under `Unreleased` in `CHANGELOG.md`, in both the English and the Chinese section. See [Pull requests](CONTRIBUTING.md#pull-requests).
- Commit messages follow [Commit messages](CONTRIBUTING.md#commit-messages). Never add `Co-authored-by` or other attribution lines to commits or pull request descriptions.
