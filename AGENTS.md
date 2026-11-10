# MerakCode development notes

Monorepo for MerakCode, an AI coding tool built around an Electron desktop app. Node.js 26.12+, pnpm 12, TypeScript (ESM); the `merak` engine is Go. This file lists what is easiest to get wrong; [CONTRIBUTING.md](CONTRIBUTING.md#contributing) is the full guide.

## v1.0.0 rebuild

The `dev-v1.0.0` branch rebuilds the whole architecture. The user designs the architecture and each module: implement what the user has decided, and ask when a design question is still open.

- The v0.3 engine and the `merak` command line (`apps/cli`) are deleted; `packages/sdk` is the new TypeScript SDK, and its types are generated from `merak/protocol`. The new engine, command line and protocol are written in Go in `merak/`; the design is `docs/plans/v1-agent-engine.html`. Implement the slice the user asks for, in the order its section lists, test first.
- Don't read, search or copy the v0.3 engine, command line or SDK (the `v0.3.0` tag, other branches, or other clones of this repository) unless the user asks. Work from the user's design and from tests.
- The desktop baseline is `origin/tt/refactor/ui-side-panel` (it contains all of `dev-v0.3.1`). Copy its
  `apps/desktop` components, styles, i18n entries and e2e specs instead of rewriting them; only the data layer
  changes to the new SDK. The ban on reading the v0.3 engine, command line and SDK is unchanged.
- Nothing that v0.x could do may be missing in v1. Compared with `origin/tt/refactor/ui-side-panel`, every
  feature must keep working; the only change allowed is that planning is no longer a separate mode.
- Never move, skip or weaken a failing test to get CI green. Fix it, or list it in
  `apps/desktop/main/e2e/PENDING.md` with the slice that fixes it.
- `docs/plans/v1-acceptance-review.html` sections 9 and 10 are the current work order. Where it differs from
  `docs/plans/v1-agent-engine.html`, follow the work order.

## Layout

- `merak` — the Go module of the `merak` program (command line, engine and protocol server). It sits at the repository root because it follows Go's layout, not the `apps/` and `packages/` split. `engine/` and `protocol/` are its public packages (the cloud service imports them); `cmd/merak` is the entry; everything else is under `internal/`. The module root package reads the product version from the `package.json` next to it, which only wraps the Go commands for pnpm and turbo.
- `packages/util`, `packages/log` — shared helpers, the error code catalog, logging.
- `packages/sdk` — the TypeScript SDK; its protocol types are generated from `merak/protocol` (`pnpm generate:protocol`).
- `apps/desktop/main` — Electron main process.
- `apps/desktop/renderer` — desktop UI (SolidJS + Vite, plain CSS with design tokens; no `!important`).

## Go code

- Use the Go version named in `merak/go.mod`. Run Go commands inside `merak`, or through its scripts: `pnpm --dir merak test` runs `go test ./...`, `typecheck` runs gofmt and then `go vet ./...` for Linux, macOS and Windows, and `build` builds every release platform into `dist/`.
- No cgo: everything builds with `CGO_ENABLED=0`, so one machine builds every platform. `go test -race` needs cgo and runs only in CI on Linux.
- `engine/` and `protocol/` are public packages; every other package is under `internal/`. Go itself rejects import cycles. Dependencies point one way: `cli` → `server`/`protocol` → `engine` → `platform`; `engine.New` is the only place that imports every engine package.
- Standard library first. Add a module to `go.mod` only for a reason the user agrees with. Provider SDK types never leave the provider's package: the rest of the engine sees only `model.Message` and `model.Part`.
- Format with gofmt; `pnpm --dir merak typecheck` fails on unformatted files.
- Tests are table-driven when cases share a shape, use `t.TempDir()` for temporary directories, and test real behavior without mocks: the fake model is a real `model.Provider`, the memory store is a real `store.Store`.
- Comments and `t.Run` titles are in English; `check:comments` checks Go files too.
- Logging goes through `log/slog` configured by `internal/platform/log`; never log keys, tokens, environment values or conversation content. The engine prints no text meant for users: it emits events and `MRK-xxxx` error codes, and the clients render them. The command line has its own `zh`/`en` text table.

## Commands

- `pnpm check` at the root runs `format:check`, `check:brand`, `check:comments`, `check:versions`, `check:errors`, `typecheck`, `check:css` and `check:unused`, in that order ([what each one checks](CONTRIBUTING.md#commands)). `typecheck` includes the Go checks of `merak`. Run it before finishing a change. It runs no tests; run `pnpm test:script` and the tests of the packages you changed as well.
- Tests run per package: `cd <package> && pnpm test [file]`. `pnpm test` at the root only fails; the root `script/` folder is tested with `pnpm test:script`.
- Never edit generated files; regenerate them. After error codes: `pnpm generate:errors`.

## Conventions

- Prettier: no semicolons, 120 columns. The compiler rejects unused variables and imports, and knip unused files, exports and dependencies. Nothing checks for commented-out code; don't leave any.
- Validate inputs with Zod.
- Code comments, log messages and test titles are in English; `check:comments` fails on Chinese in them (a `// i18n-allow` comment lets the next line through). User-facing text needs Chinese and English: `apps/desktop/renderer/src/i18n/{zh,en}.ts`. Model-facing prompts and tool descriptions are English only.
- Logging: `Log.create(service)` from `src/log.ts` in the desktop main process, `log()` from `src/lib/bridge.ts` in the renderer. Don't use `console.*` for diagnostics, and never log keys, passwords or conversation content.
- An error a user can see needs an `MRK-xxxx` code in `packages/util/errors.json`: the thousands digit matches its `domain`, and `title` and `hint` have both `zh` and `en`. Run `pnpm generate:errors` to regenerate the Go catalog, TypeScript catalog and documentation. See [Error codes and logs](CONTRIBUTING.md#error-codes-and-logs).
- Tests use Vitest against real behavior; avoid mocks. Use a `tmpdir()` fixture for temporary directories and a local fake model for replies.
- Prefer early returns over `else`, `const` over `let`, and small focused functions.
- A change users will notice gets a line under `Unreleased` in `CHANGELOG.md`, in both the English and the Chinese section. See [Pull requests](CONTRIBUTING.md#pull-requests).
- Commit messages follow [Commit messages](CONTRIBUTING.md#commit-messages). Never add `Co-authored-by` or other attribution lines to commits or pull request descriptions.
