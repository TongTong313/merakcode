# MerakCode development notes

Monorepo for MerakCode, an AI coding tool built around an Electron desktop app. Node.js 26.12+, pnpm 12, TypeScript (ESM). This file lists what is easiest to get wrong; [CONTRIBUTING.md](CONTRIBUTING.md#contributing) is the full guide.

## v1.0.0 rebuild

The `dev-v1.0.0` branch rebuilds the whole architecture. The user designs the architecture and each module: implement what the user has decided, and ask when a design question is still open.

- The v0.3 engine, the `merak` command line (`apps/cli`) and the SDK (`packages/sdk`) are deleted. The user plans to write the new engine in Go.
- Don't read, search or copy the v0.3 engine, command line or SDK (the `v0.3.0` tag, other branches, or other clones of this repository) unless the user asks. Work from the user's design and from tests.
- The desktop app still uses the v0.3 SDK's protocol types, so it does not compile; it moves to the new protocol once that exists. Until then `pnpm typecheck` leaves it out, knip reads it but reports none of its issues (`ignore` in `knip.json`), its tests don't run, and the workflows in `.github/workflows/` still describe v0.3.

## Layout

- `packages/util`, `packages/log` — shared helpers, the error code catalog, logging.
- `apps/desktop/main` — Electron main process.
- `apps/desktop/renderer` — desktop UI (SolidJS + Vite, plain CSS with design tokens; no `!important`).

## Commands

- `pnpm check` at the root runs `format:check`, `check:brand`, `check:comments`, `check:versions`, `check:errors`, `typecheck`, `check:css` and `check:unused`, in that order ([what each one checks](CONTRIBUTING.md#commands)). Run it before finishing a change. It runs no tests; run `pnpm test:script` and the tests of the packages you changed as well.
- Tests run per package: `cd <package> && pnpm test [file]`. `pnpm test` at the root only fails; the root `script/` folder is tested with `pnpm test:script`.
- Never edit generated files; regenerate them. After error codes: `pnpm generate:errors`.

## Conventions

- Prettier: no semicolons, 120 columns. The compiler rejects unused variables and imports, and knip unused files, exports and dependencies. Nothing checks for commented-out code; don't leave any.
- Validate inputs with Zod.
- Code comments, log messages and test titles are in English; `check:comments` fails on Chinese in them (a `// i18n-allow` comment lets the next line through). User-facing text needs Chinese and English: `apps/desktop/renderer/src/i18n/{zh,en}.ts`. Model-facing prompts and tool descriptions are English only.
- Logging: `Log.create(service)` from `src/log.ts` in the desktop main process, `log()` from `src/lib/bridge.ts` in the renderer. Don't use `console.*` for diagnostics, and never log keys, passwords or conversation content.
- An error a user can see needs an `MRK-xxxx` code in `packages/util/src/error-code.ts`: the thousands digit matches its `domain`, and `title` and `hint` have both `zh` and `en`. Then run `pnpm generate:errors`. See [Error codes and logs](CONTRIBUTING.md#error-codes-and-logs).
- Tests use Vitest against real behavior; avoid mocks. Use a `tmpdir()` fixture for temporary directories and a local fake model for replies.
- Prefer early returns over `else`, `const` over `let`, and small focused functions.
- A change users will notice gets a line under `Unreleased` in `CHANGELOG.md`, in both the English and the Chinese section. See [Pull requests](CONTRIBUTING.md#pull-requests).
- Commit messages follow [Commit messages](CONTRIBUTING.md#commit-messages). Never add `Co-authored-by` or other attribution lines to commits or pull request descriptions.
