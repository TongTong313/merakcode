# MerakCode development notes

Monorepo for MerakCode, an AI coding tool built around an Electron desktop app. Node.js 26.12+, pnpm 12, TypeScript (ESM); the `merak` engine is Go. This file lists what is easiest to get wrong; [CONTRIBUTING.md](CONTRIBUTING.md#contributing) is the full guide.

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
- A package never imports a package above it. When it needs something from above, it defines an interface for what it needs and the package above passes the implementation.
- Standard library first. Add a module to `go.mod` only for a reason the user agrees with. Provider SDK types never leave the provider's package: the rest of the engine sees only `model.Message` and `model.Part`.
- Format with gofmt; `pnpm --dir merak typecheck` fails on unformatted files.
- Tests are table-driven when cases share a shape, use `t.TempDir()` for temporary directories, and test real behavior without mocks: the fake model is a real `model.Provider`, the memory store is a real `store.Store`.
- The tests of a package sit next to its code. A helper that the tests of several packages share lives in a helper package of its own (for example `engine/store/storetest`), not in a `_test.go` file of another package.
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
- Never move, skip or weaken a failing test to get CI green. Fix it.
- Prefer early returns over `else`, `const` over `let`, and small focused functions.
- A change users will notice gets a line under `Unreleased` in `CHANGELOG.md`, in both the English and the Chinese section. See [Pull requests](CONTRIBUTING.md#pull-requests).
- Commit messages follow [Commit messages](CONTRIBUTING.md#commit-messages). Never add `Co-authored-by` or other attribution lines to commits or pull request descriptions.

## Replies

Write every reply to the user in controlled Chinese, so that the user can read it quickly and check it.

请用受控中文回答，目的是让用户快速读懂并检查内容。

**词汇**

1. 一词一义，同一事物全文用同一叫法。
2. 用日常词，不用套话、成语、比喻、黑话，也不用空间隐喻，比如上移、下沉、打通。
3. 必须用术语时，首次出现给一句话定义，之后不换词。

**句子**

4. 一句只讲一件事。说明句不超过 35 字，步骤句不超过 25 字。超长就拆成两句或多句，内容原样保留。
5. 用主动语态，写明谁做什么，不省略主语。
6. 指代词只在对象唯一时使用，否则重复名词。
7. 定语不超过三层，超过就拆成两句。

**结构**

8. 开头一句话给结论，再给依据。
9. 一段一个主题，每段句数不宜太多，但也不要过度分段。操作用编号步骤，三项以上并列用列表。

**保真，优先级最高**

10. 数字、单位、条件、例外、时间范围一律保留。限定条件单独写成紧跟其后的一句，不塞进主句。
11. 每个判断标明已确认事实、推断或不确定。没有依据就写没有依据，不知道就明说，不补全。
12. 只简化表达，不改结论强度。原文是可能，不能写成会。

**执行**

13. 第 1、2、4、5、8、10、11、12 条必须执行，其余在不损失信息时执行。回答中不要说明用了哪些规则，也不要自我评价。要用人能流畅读懂的语言回答。
