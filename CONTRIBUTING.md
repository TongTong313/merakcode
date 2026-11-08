# 参与开发

[English](#contributing)

欢迎提问题，也欢迎提代码。要改比较大的功能，先开一个 issue 说说想法，免得做完了才发现方向不对。

## v1.0.0 重建

`dev-v1.0.0` 分支重建整体架构。旧引擎、`merak` 命令行（`apps/cli`）和 SDK（`packages/sdk`）都已删除。新的引擎、命令行和协议用 Go 写，放在根目录的 `merak/`。设计见 `docs/plans/v1-agent-engine.html`。重建期间：

- 仓库里有 Go 程序 `merak/`、桌面端（`apps/desktop`）和共用的 `packages/util`、`packages/log`。
- 桌面端已经使用新的 Go 协议和 SDK。`pnpm typecheck` 和 `pnpm check:unused` 检查桌面端。CI 运行主进程、渲染进程测试和已迁移的 Linux 桌面端端到端测试。
- `ci.yml` 已经覆盖当前仓库。`release.yml`、`regression.yml` 和下面的"发布"一节还是 v0.3 的流程。`ci.yml` 只在 PR 和推送到 `main` 时运行，`release.yml` 只在打 tag 时运行，`regression.yml` 只能手动运行。

## 准备环境

需要 Node.js 26.12 以上和 pnpm 12：

- `merak/` 用 Go 写，PATH 上要有 `merak/go.mod` 里写的 Go 版本。

```sh
git clone https://github.com/TongTong313/merakcode.git
cd merakcode
pnpm install
pnpm hooks:install   # 提交前检查暂存文件的格式，提交时检查标题
```

从源码运行、调试、打包的命令见 [README 的"从源码开发"](README.md#从源码开发)。

## 常用命令

都在仓库根目录运行：

| 命令                         | 作用                                                           |
| ---------------------------- | -------------------------------------------------------------- |
| `pnpm check`                 | 提交 PR 前要过的静态检查（不跑测试），见下面的说明             |
| `pnpm test:script`           | 根目录 `script/` 下脚本的测试                                  |
| `pnpm format`                | 格式化整个仓库                                                 |
| `pnpm --dir merak build`     | 不用 cgo，把 `merak` 编译成 6 个平台的程序，放在 `merak/dist/` |
| `pnpm generate:errors`       | 改了错误码后重新生成 Go、TypeScript 目录和文档                 |
| `pnpm release:version x.y.z` | 把所有包的版本号改成同一个（维护者发版用）                     |

`pnpm check` 依次运行下面这些脚本，每个也能单独跑（`pnpm <脚本>`）：

| 脚本             | 检查什么                                                                                |
| ---------------- | --------------------------------------------------------------------------------------- |
| `format:check`   | Prettier 格式                                                                           |
| `check:brand`    | 没有旧的产品名和没填的占位符                                                            |
| `check:comments` | 代码注释、日志消息和测试标题里没有中文，见[代码约定](#代码约定)                         |
| `check:versions` | 所有包的版本号一致                                                                      |
| `check:errors`   | Go、TypeScript 错误码目录和文档是最新的                                                 |
| `typecheck`      | 各个包的类型，包含桌面端；`merak` 跑 gofmt 和 Linux、macOS、Windows 三个系统的 `go vet` |
| `check:css`      | 桌面端的 CSS 里没有 `!important`                                                        |
| `check:unused`   | 没用到的文件、导出和依赖，包含桌面端（knip）                                            |

`pnpm check` 不跑测试。生成出来的文件（比如 `docs/errors.md`）不要手改，改了源头再跑对应的 `generate` 命令。

## 代码是怎么组织的

| 目录                            | 内容                                                                                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `merak`                         | `merak` 程序的 Go 模块（命令行、引擎、协议服务端），按 Go 的布局放在根目录。`engine/`、`protocol/` 是公开包，入口是 `cmd/merak`，其他包在 `internal/` 下 |
| `packages/util`、`packages/log` | 共用的基础代码、错误码目录、日志                                                                                                                         |
| `apps/desktop/main`             | 桌面端主进程（Electron）                                                                                                                                 |
| `apps/desktop/renderer`         | 桌面端界面（SolidJS + Vite，纯 CSS）                                                                                                                     |

## 测试

- Go 的测试在 `merak` 里用 `go test ./...` 跑，也可以用 `pnpm --dir merak test`。临时目录用 `t.TempDir()`。
- 测试用 Vitest，每个包在自己的目录里跑：`cd packages/util && pnpm test`；只跑一个文件就把路径加在后面。根目录的 `pnpm test` 不跑任何测试；根目录 `script/` 下的脚本用 `pnpm test:script` 测。
- 测真实行为，尽量不用 mock。需要临时目录就用测试夹具里的 `tmpdir()`，用完自动清理。
- 要模型回复的用例用本地的假模型，不要连真的模型服务。
- Windows 最多同时执行两个测试文件。
- 修 Bug 先写一个能复现的失败用例，再改代码。

## 代码约定

- `merak` 的 Go 代码用 gofmt 格式化，不用 cgo。`engine/`、`protocol/` 之外的包都放在 `internal/` 下。优先用标准库，加 Go 依赖前先说明理由。模型服务商 SDK 的类型不出它自己的包。日志走 `log/slog`，不记密钥和对话内容。引擎不输出给用户看的文字，只发事件和错误码。
- TypeScript + ESM，Prettier 格式化（不写分号，每行最长 120 字符）。
- 输入用 Zod 校验。
- 多用提前 `return`，少用 `else`；多用 `const`，少用 `let`；函数保持短小。
- 不留注释掉的代码和用不到的代码。用不到的变量和导入编译器会报，用不到的文件、导出和依赖由 knip 报（`pnpm check:unused`）；注释掉的代码没有工具查，要自己注意。
- 代码注释、日志消息和测试标题用英文。注释只写代码本身看不出来的东西（约束、原因、坑），不要复述代码在做什么。
- `pnpm check:comments` 会查 JS/TS 文件里的注释、`log.info(...)` 这类日志调用的消息和 `describe`、`test`、`it` 的标题，以及 `.sh`、`.ps1`、`.yml` 文件里的 `#` 注释，以及 Go 文件里的注释和 `t.Run` 的标题；`locales/` 和 `i18n/` 目录、生成的 `gen/` 目录和 `.d.ts` 文件不查。确实要用中文的那一行，在它上一行加 `// i18n-allow`。
- 给用户看的文字要有中英两份，桌面端写在 `apps/desktop/renderer/src/i18n/{zh,en}.ts`。给模型看的提示词和工具说明只写英文。
- 桌面端界面用纯 CSS 和设计变量，不要写 `!important`。

## 加依赖

- 版本号写精确的，不带 `^` 或 `~`。`pnpm-workspace.yaml` 里设了 `savePrefix: ""`，`pnpm add` 会照这样写。
- 几个包都要用的依赖，版本写进 `pnpm-workspace.yaml` 的 `catalog`，各包的 `package.json` 里写 `"catalog:"`。
- 依赖带安装脚本时，在 `pnpm-workspace.yaml` 的 `allowBuilds` 里写明：`true` 表示运行（要在本机编译的原生模块），`false` 表示跳过（平台包里已经带了编译好的文件）。
- `patches/` 里是对依赖的补丁，登记在 `patchedDependencies` 里，绑定了具体版本。升级这些依赖时要同时更新补丁（`pnpm patch`）。
- 提交更新后的 `pnpm-lock.yaml`，CI 用 `--frozen-lockfile` 安装。

## 错误码和日志

- 用户可能看到的错误都要有错误码，格式是 `MRK-xxxx`，统一登记在 `packages/util/errors.json`。千位数字要和 `domain` 对应（对照表在 JSON 的 `domains` 字段里），`title`（出了什么事）和 `hint`（用户该怎么办）都要有中英两份，`packages/util` 的测试会查这几条。改完跑 `pnpm generate:errors` 更新 Go、TypeScript 目录和 `docs/errors.md`。错误码一旦发布就不要改含义，不用了就留着。
- 打日志：桌面端主进程用 `apps/desktop/main/src/log.ts` 的 `Log.create("名字")`；桌面端界面用 `apps/desktop/renderer/src/lib/bridge.ts` 的 `log()`，由主进程写进日志。都不要用 `console.*` 记诊断信息。日志里不能出现密钥、口令和对话内容。
- 日志写在 `~/.merakcode/logs` 下（设了 `MERAKCODE_HOME` 就在那个目录的 `logs` 下）：正式版在 `production/`，从源码运行在 `development/`，再按组件分目录，比如 `desktop/`。每个进程一个 NDJSON 文件，超过 20 MB 就轮转，连当前文件最多留 5 个。

## 提交说明

提交说明用英文，写成这个格式：

```text
type(scope): summary

- what changed and why
- one point per line
```

- `type` 从这些里选：`feat`（新功能）、`fix`（修 Bug）、`docs`（文档）、`test`（测试）、`refactor`（不改行为的重构）、`perf`（性能）、`build`（构建和依赖）、`ci`（CI 配置）、`chore`（其他杂事）、`revert`（撤销之前的提交）。
- `scope` 写改动在哪一块，比如 `desktop`、`cli`、`engine`、`sdk`、`sandbox`、`review`、`changelog`、`contributing`。跨了好几块就不写，直接 `type: summary`。
- 不兼容的改动可以在冒号前加 `!`，比如 `feat(sdk)!: rename the run options`。
- 标题用祈使句，小写开头，结尾不加句号，整行不超过 100 个字符。
- 标题和列表之间空一行，不然 GitHub 和 `git log --oneline` 会把列表拼进标题。列表每行以 `- ` 开头，写改了什么、为什么改。
- 不加 `Co-authored-by` 之类的署名行，AI 工具自动加的也删掉。PR 描述同样不加。
- 发版的提交写成 `release: vx.y.z`，不带 scope，列表概括这个版本的变化。
- PR 标题也用这个格式。合并 PR 用 "Squash and merge"（PR 标题就是提交标题）或 "Rebase and merge"，不用 GitHub 默认的合并提交，`main` 上的提交才能保持这个格式。

跑过 `pnpm hooks:install` 之后，git 会用 `script/hooks` 里的两个钩子：`pre-commit` 用 Prettier 检查暂存文件的格式，`commit-msg` 检查标题。`commit-msg` 只查这些：`type` 在上面的列表里，`scope` 只含小写字母、数字和 `-`，冒号后面跟一个空格再写内容，整行不超过 100 个字符；或者是发版标题 `release: vx.y.z`（测试版是 `vx.y.z-渠道名.数字`）。以 `Merge `、`fixup! `、`squash! `、`amend! ` 开头的标题直接放过。小写开头、不加句号和正文的写法，钩子不查，要自己注意。

## 提交 PR

1. 从 `main` 新建分支；v1.0.0 的改动从 `dev-v1.0.0` 新建。
2. 改完跑 `pnpm check` 和你改到的包的测试。
3. PR 标题按上面的提交说明格式写。PR 里写清楚改了什么、为什么改、怎么验证的。改了界面就附截图。
4. 用户能感觉到的改动，在 `CHANGELOG.md` 的 `Unreleased` 下面中英文各写一行：英文写在英文小节（比如 `### Fixed`），中文写在对应的中文小节（比如 `### 修复`；`Added` 对应 `新增`，以此类推）。

## 发布（维护者）

所有包用同一个版本号，格式是 `主版本.次版本.修订号`，每次升哪一位由维护者决定。带 `-` 的版本（比如 `0.2.0-beta.1`）是测试版，`-` 后面必须是"小写字母组成的渠道名.数字"。测试版只推给已经在这个渠道上的安装：先手动装上这个渠道的一个版本（比如 `merak upgrade 0.2.0-beta.1`），之后才会收到这个渠道的更新；装正式版的收不到测试版。

1. 运行 `pnpm release:version x.y.z`。在 `CHANGELOG.md` 里保留空的 `## [Unreleased]`，在它下面加一节 `## [x.y.z] - YYYY-MM-DD`，把 `Unreleased` 下的条目都移进去。提交（标题写 `release: vx.y.z`）并合并到 `main`。`CHANGELOG.md` 里没有这个版本的一节就不能发布。
2. 在 `main` 上打 tag 并推送：`git tag vx.y.z && git push origin vx.y.z`。
3. `.github/workflows/release.yml` 会自动：
   - 检查 tag、版本号和 `CHANGELOG.md` 对得上，并把 CI 完整跑一遍；
   - 构建 6 个平台的命令行包和 npm 包，在这 6 个平台上分别用压缩包和 npm 包各装一遍，确认能启动、基本命令能用；
   - 在三个系统上打桌面安装包和更新清单；
   - 建一个草稿 Release，说明从 `CHANGELOG.md` 里对应版本那一节截取；
   - 准备发布到 npm（正式版打 `latest` 标签，测试版打渠道名，比如 `beta`），等维护者批准。
4. 下载草稿里的安装包试一下，没问题就在这次运行里批准 npm 这一步，再在 GitHub 上点"发布"。

点了发布之后：一行安装脚本会装到新版本，`merak upgrade` 能升级（脚本装的问 GitHub，npm 装的问 npm），桌面端会提示更新（没签名的 macOS 版和 Linux 的 deb 包会提示去下载页）。

想先试跑一遍流水线：在 Actions 页面手动运行 Release，默认只构建、不建 Release、不发 npm。关掉 dry-run 只能在 tag 上运行。

仓库的 Settings → Environments 里要建一个叫 `npm` 的环境，加上必需的审批人，npm 那一步才会停下来等批准；`NPM_TOKEN` 也放在这个环境里。等这些包在 npmjs.com 上配好 Trusted Publishing，就可以不用 `NPM_TOKEN` 了。

需要配置的 secrets：

| Secret                                                     | 用途                            | 必需 |
| ---------------------------------------------------------- | ------------------------------- | ---- |
| `NPM_TOKEN`                                                | 发布到 npm（放在 `npm` 环境里） | 是   |
| `MAC_CERTIFICATE`、`MAC_CERTIFICATE_PASSWORD`              | macOS 签名                      | 否   |
| `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` | macOS 公证                      | 否   |

---

# Contributing

[中文](#参与开发)

Questions and code are both welcome. For bigger changes, open an issue first to talk about the idea, so nobody builds the wrong thing.

## v1.0.0 rebuild

The `dev-v1.0.0` branch rebuilds the whole architecture. The old engine, the `merak` command line (`apps/cli`) and the SDK (`packages/sdk`) are deleted. The new engine, command line and protocol are written in Go in the root `merak/` directory; the design is `docs/plans/v1-agent-engine.html`. During the rebuild:

- The repository holds the Go program `merak/`, the desktop app (`apps/desktop`) and the shared `packages/util` and `packages/log`.
- The desktop app uses the new Go protocol and SDK. Both `pnpm typecheck` and `pnpm check:unused` include it. CI runs main-process and renderer tests and the migrated desktop end-to-end tests on Linux.
- `ci.yml` covers the current repository; `release.yml`, `regression.yml` and the "Releasing" section below still describe v0.3. `ci.yml` runs only on pull requests and pushes to `main`, `release.yml` only on tags, and `regression.yml` only by hand.

## Setup

You need Node.js 26.12 or newer and pnpm 12:

- `merak/` is written in Go. Put the Go version named in `merak/go.mod` on PATH.

```sh
git clone https://github.com/TongTong313/merakcode.git
cd merakcode
pnpm install
pnpm hooks:install   # check staged files' formatting before each commit, and the title of each commit
```

For running, debugging and packaging from source, see ["Develop from source" in the README](README.en.md#develop-from-source).

## Commands

All from the repo root:

| Command                      | What it does                                                             |
| ---------------------------- | ------------------------------------------------------------------------ |
| `pnpm check`                 | The static checks a PR must pass (no tests), see below                   |
| `pnpm test:script`           | Tests for the scripts in the root `script/` folder                       |
| `pnpm format`                | Format the whole repo                                                    |
| `pnpm --dir merak build`     | Build `merak` for all 6 release platforms without cgo into `merak/dist/` |
| `pnpm generate:errors`       | Regenerate Go, TypeScript and docs after changing error codes            |
| `pnpm release:version x.y.z` | Set every package to the same version (for maintainers)                  |

`pnpm check` runs these scripts in order; each can also run on its own (`pnpm <script>`):

| Script           | What it checks                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| `format:check`   | Prettier formatting                                                                                   |
| `check:brand`    | No old product names or unfilled placeholders                                                         |
| `check:comments` | No Chinese in code comments, log messages or test titles; see [Conventions](#conventions)             |
| `check:versions` | Every package has the same version                                                                    |
| `check:errors`   | Go and TypeScript error catalogs and docs are up to date                                              |
| `typecheck`      | Each package's types, including desktop; `merak` runs gofmt and `go vet` for Linux, macOS and Windows |
| `check:css`      | No `!important` in the desktop CSS                                                                    |
| `check:unused`   | Unused files, exports and dependencies, including desktop (knip)                                      |

`pnpm check` runs no tests. Don't edit generated files such as `docs/errors.md` by hand; change the source and run the matching `generate` command.

## How the code is organized

| Directory                       | What's in it                                                                                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `merak`                         | The Go module of the `merak` program (command line, engine and protocol server), at the root following Go's layout. `engine/` and `protocol/` are public; `cmd/merak` is the entry; everything else is under `internal/` |
| `packages/util`, `packages/log` | Shared helpers, the error code catalog, logging                                                                                                                                                                          |
| `apps/desktop/main`             | Desktop main process (Electron)                                                                                                                                                                                          |
| `apps/desktop/renderer`         | Desktop UI (SolidJS + Vite, plain CSS)                                                                                                                                                                                   |

## Tests

- Run Go tests inside `merak` with `go test ./...`, or use `pnpm --dir merak test`. Use `t.TempDir()` for temporary directories.
- Tests use Vitest and run per package: `cd packages/util && pnpm test`; add a file path to run just that file. `pnpm test` at the root runs no tests; the scripts in the root `script/` folder are tested with `pnpm test:script`.
- Test real behavior and avoid mocks. For temporary directories use the `tmpdir()` fixture; it cleans up after itself.
- Tests that need model replies use a local fake model, never a real provider.
- Windows runs at most two test files at a time.
- When fixing a bug, write a failing test that reproduces it before changing the code.

## Conventions

- Go code in `merak` uses gofmt and no cgo. `engine/` and `protocol/` are public; every other package is under `internal/`. Prefer the standard library and explain the reason before adding a Go dependency. Provider SDK types stay inside the provider's package. Log through `log/slog`, without keys or conversation content. The engine emits events and error codes, not text meant for users.
- TypeScript and ESM, formatted with Prettier (no semicolons, 120 columns).
- Validate inputs with Zod.
- Prefer early returns over `else`, `const` over `let`, and short functions.
- No commented-out or unused code. The compiler reports unused variables and imports, and knip reports unused files, exports and dependencies (`pnpm check:unused`); nothing checks for commented-out code, so watch for it yourself.
- Code comments, log messages and test titles are in English. Comments only say what the code can't: constraints, reasons, gotchas. Don't narrate what the code does.
- `pnpm check:comments` checks comments in JS and TS files, the messages of log calls such as `log.info(...)`, the titles of `describe`, `test` and `it`, `#` comments in `.sh`, `.ps1` and `.yml` files, and comments and `t.Run` titles in Go files; it skips `locales/` and `i18n/` folders, generated `gen/` folders and `.d.ts` files. When a line really needs Chinese, put `// i18n-allow` on the line before it.
- Text shown to users needs Chinese and English; the desktop app keeps it in `apps/desktop/renderer/src/i18n/{zh,en}.ts`. Prompts and tool descriptions for the model are English only.
- The desktop UI uses plain CSS with design tokens. No `!important`.

## Adding dependencies

- Pin exact versions, without `^` or `~`. `pnpm-workspace.yaml` sets `savePrefix: ""`, so `pnpm add` writes them that way.
- When several packages use a dependency, put its version in the `catalog` of `pnpm-workspace.yaml` and write `"catalog:"` in each `package.json`.
- When a dependency has install scripts, list it under `allowBuilds` in `pnpm-workspace.yaml`: `true` runs them (native modules built on your machine), `false` skips them (the platform packages already ship prebuilt files).
- `patches/` holds patches to dependencies, registered under `patchedDependencies` for an exact version. When you upgrade one of those dependencies, update its patch too (`pnpm patch`).
- Commit the updated `pnpm-lock.yaml`; CI installs with `--frozen-lockfile`.

## Error codes and logs

- Every error a user might see needs a code of the form `MRK-xxxx`, registered in `packages/util/errors.json`. The thousands digit must match its `domain` (the JSON `domains` field has the table), and both `title` (what happened) and `hint` (what the user should do) need Chinese and English; the tests in `packages/util` check this. Then run `pnpm generate:errors` to update both language catalogs and `docs/errors.md`. Once a code is released, don't change its meaning; if it is no longer used, leave it in place.
- Logging: the desktop main process uses `Log.create("name")` from `apps/desktop/main/src/log.ts`; the desktop UI uses `log()` from `apps/desktop/renderer/src/lib/bridge.ts`, which the main process writes to its log. Neither uses `console.*` for diagnostics. Logs must never contain keys, passwords or conversation content.
- Logs go under `~/.merakcode/logs` (or `logs` under `MERAKCODE_HOME` when that is set): `production/` for releases and `development/` when running from source, then one folder per component, such as `desktop/`. Each process writes one NDJSON file, rotated at 20 MB, keeping at most 5 files including the current one.

## Commit messages

Write commit messages in English, in this format:

```text
type(scope): summary

- what changed and why
- one point per line
```

- `type` is one of `feat` (new feature), `fix` (bug fix), `docs`, `test`, `refactor` (no behavior change), `perf`, `build` (build and dependencies), `ci`, `chore` (anything else) and `revert`.
- `scope` names the part you changed, such as `desktop`, `cli`, `engine`, `sdk`, `sandbox`, `review`, `changelog` or `contributing`. Leave it out when the change spans several parts: `type: summary`.
- An incompatible change may add `!` before the colon, such as `feat(sdk)!: rename the run options`.
- Write the title in the imperative, starting lowercase, with no final period, at most 100 characters in all.
- Leave a blank line between the title and the list, or GitHub and `git log --oneline` join the list onto the title. Each list line starts with `- ` and says what changed and why.
- Leave out `Co-authored-by` and other attribution lines, including the ones AI tools add. The same goes for pull request descriptions.
- A release commit is `release: vx.y.z`, with no scope; its list sums up the version.
- Pull request titles use the same format. Merge with "Squash and merge" (the pull request title becomes the commit title) or "Rebase and merge", not GitHub's default merge commit, so the commits on `main` keep this format.

After `pnpm hooks:install`, git uses the two hooks in `script/hooks`: `pre-commit` checks the formatting of staged files with Prettier, and `commit-msg` checks the title. `commit-msg` only checks that `type` is on the list above, `scope` has only lowercase letters, digits and `-`, a space and some text follow the colon, and the whole title is at most 100 characters; or that it is a release title, `release: vx.y.z` (`vx.y.z-channel.n` for a test release). Titles starting with `Merge `, `fixup! `, `squash! ` or `amend! ` pass as they are. The hook does not check the lowercase start, the final period or the body, so watch those yourself.

## Pull requests

1. Branch off `main`; for v1.0.0 work, branch off `dev-v1.0.0`.
2. Run `pnpm check` and the tests of the packages you touched.
3. Title the pull request in the commit message format above. Say what changed, why, and how you checked it. Add screenshots for UI changes.
4. For changes users will notice, add a line under `Unreleased` in `CHANGELOG.md` in both English and Chinese: the English line under the English heading (such as `### Fixed`) and the Chinese line under its Chinese counterpart (such as `### 修复`; `新增` for `Added`, and so on).

## Releasing (maintainers)

All packages share one version number, written `major.minor.patch`; maintainers decide which part each release raises. Versions with a `-` (such as `0.2.0-beta.1`) are test releases; after the `-` comes a lowercase channel name, a dot and a number. A test release only reaches installs already on its channel: install a version from that channel by hand first (such as `merak upgrade 0.2.0-beta.1`), and from then on that channel's updates arrive; installs of normal releases never get test releases.

1. Run `pnpm release:version x.y.z`. In `CHANGELOG.md`, keep an empty `## [Unreleased]` and add a `## [x.y.z] - YYYY-MM-DD` section below it, moving every entry from `Unreleased` into it. Commit (titled `release: vx.y.z`) and merge into `main`. A version without its section in `CHANGELOG.md` cannot be published.
2. Tag `main` and push the tag: `git tag vx.y.z && git push origin vx.y.z`.
3. `.github/workflows/release.yml` then:
   - checks that the tag, the version and `CHANGELOG.md` agree, and runs all of CI;
   - builds the command-line packages for 6 platforms and the npm packages, and installs each platform from both its archive and its npm packages to check they start and the basic commands work;
   - builds the desktop installers and update manifests on all three systems;
   - creates a draft release whose notes are that version's section of `CHANGELOG.md`;
   - gets ready to publish to npm (`latest` for normal releases, the channel name such as `beta` for test releases) and waits for a maintainer's approval.
4. Download the installers from the draft and try them; if they work, approve the npm step in that run, then click "Publish release" on GitHub.

Once published, the install scripts get the new version, `merak upgrade` can update (script installs check GitHub, npm installs check npm), and the desktop app offers the update (unsigned macOS builds and the Linux deb point to the download page).

To try the pipeline first, run the Release workflow by hand from the Actions page. By default that only builds; it creates no release and publishes nothing. Switching dry-run off only works on a tag.

Create an environment named `npm` under Settings → Environments with required reviewers, so the npm step waits for approval, and keep `NPM_TOKEN` in that environment. Once the packages have Trusted Publishing set up on npmjs.com, `NPM_TOKEN` is no longer needed.

Secrets the repository needs:

| Secret                                                     | Used for                                     | Required |
| ---------------------------------------------------------- | -------------------------------------------- | -------- |
| `NPM_TOKEN`                                                | Publishing to npm (in the `npm` environment) | Yes      |
| `MAC_CERTIFICATE`, `MAC_CERTIFICATE_PASSWORD`              | macOS signing                                | No       |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | macOS notarization                           | No       |
