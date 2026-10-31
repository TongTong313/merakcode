# 参与开发

[English](#contributing)

欢迎提问题，也欢迎提代码。要改比较大的功能，先开一个 issue 说说想法，免得做完了才发现方向不对。

## 准备环境

需要 Node.js 26.12 以上、pnpm 12 和 [ripgrep](https://github.com/BurntSushi/ripgrep)：

- PATH 上的 `node` 必须是 26.12 以上。桌面端开发和桌面端的端到端测试都用它跑引擎源码（Electron 自带的 Node 太旧，没有 `node:ffi`）；想换一个 `node`，设 `MERAKCODE_DESKTOP_NODE`。
- 跑测试要 PATH 上有 `rg`，不然每个测试进程都会从 GitHub 下载一份。

```sh
git clone https://github.com/TongTong313/merakcode.git
cd merakcode
pnpm install
pnpm hooks:install   # 提交前检查暂存文件的格式，提交时检查标题
```

从源码运行、调试、打包的命令见 [README 的"从源码开发"](README.md#从源码开发)。

## 常用命令

都在仓库根目录运行：

| 命令                               | 作用                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --dir apps/desktop/main dev` | 从源码开发桌面端（界面热更新，主进程改完自动重启；引擎改完用「帮助 › 重启本地服务」）                                                 |
| `pnpm dev <命令>`                  | 从源码运行 `merak` 的命令，比如 `pnpm dev serve`                                                                                      |
| `pnpm check`                       | 提交 PR 前要过的静态检查（不跑测试），见下面的说明                                                                                    |
| `pnpm test:script`                 | 根目录 `script/` 下脚本的测试                                                                                                         |
| `pnpm format`                      | 格式化整个仓库                                                                                                                        |
| `pnpm generate:sdk`                | 改了服务端接口后重新生成 SDK 客户端（`packages/sdk/openapi.json` 和 `packages/sdk/js/src/client/gen/`）                               |
| `pnpm generate:schema`             | 改了配置项后重新生成 `schema/config.json`                                                                                             |
| `pnpm generate:errors`             | 改了错误码后重新生成 `docs/errors.md`                                                                                                 |
| `pnpm generate:adapter-library`    | 改了 `@merakcode/sdk/adapter` 或内置适配器后，重新生成技能 `adapter-generator` 带的单文件适配器开发库、它的类型声明和 TypeScript 示例 |
| `pnpm generate:sdk-reference`      | 改了服务端接口后重新生成 `docs/sdk/reference.md`（先跑 `generate:sdk`）                                                               |
| `pnpm check:api --write`           | SDK 公开接口有意变动时，更新 `packages/sdk/js/api.md`                                                                                 |
| `pnpm release:version x.y.z`       | 把所有包的版本号改成同一个（维护者发版用）                                                                                            |

`pnpm check` 依次运行下面这些脚本，每个也能单独跑（`pnpm <脚本>`）：

| 脚本                    | 检查什么                                                        |
| ----------------------- | --------------------------------------------------------------- |
| `format:check`          | Prettier 格式                                                   |
| `check:brand`           | 没有旧的产品名和没填的占位符                                    |
| `check:comments`        | 代码注释、日志消息和测试标题里没有中文，见[代码约定](#代码约定) |
| `check:versions`        | 所有包的版本号一致                                              |
| `check:schema`          | `schema/config.json` 是最新的                                   |
| `check:errors`          | `docs/errors.md` 是最新的                                       |
| `check:adapter-library` | 单文件适配器开发库、它的类型声明和适配器示例是最新的            |
| `check:sdk`             | 在临时目录重新生成，确认 OpenAPI 和 SDK 客户端与服务端一致      |
| `typecheck`             | 各个包的类型                                                    |
| `check:deps`            | 依赖边界，见[边界规则](#边界规则)                               |
| `check:css`             | 桌面端的 CSS 里没有 `!important`                                |
| `check:api`             | SDK 公开接口和快照 `packages/sdk/js/api.md` 一致                |
| `check:sdk-reference`   | `docs/sdk/reference.md` 是最新的                                |
| `check:sdk-docs`        | SDK 手册提到了每个公开接口，里面的代码能编译                    |
| `check:docs`            | 文档里写的 `merak` 命令都真的存在                               |
| `check:unused`          | 没用到的文件、导出和依赖（knip）                                |

`pnpm check` 不跑测试。CI 在 Windows、macOS、Linux 上分别运行 `pnpm test:script`、每个包的测试、沙箱一致性测试、CLI 与 SDK npm 包消费测试、桌面生产目录包冒烟和端到端测试（见 `.github/workflows/ci.yml`）。非桌面任务跳过 Electron 下载；系统沙箱一致性用例只在完成初始化的独立任务里运行一次。

`pnpm check:sdk` 在临时目录生成 OpenAPI 和 SDK 客户端，比较文件内容及增删；忽略换行差异，生成前稳定 schema 顺序。生成出来的文件不要手改，改了源头再跑对应的 `generate` 命令。

常规门禁使用本地假模型和本地 HTTP fixture。性能阈值与外部网络隔离只在 Actions 的 **Manual regression** 工作流中手动运行，三个系统各跑一遍，不阻塞 PR 或发布。选择 `external-network` 时，必须提供宿主机可达的外部 TCP 目标 `http://host:port`；目标不可达会失败，不会被记为隔离成功。本地入口是 `apps/cli` 的 `pnpm test:perf` 和 `packages/engine` 的 `pnpm test:sandbox:external`（设置 `MERAKCODE_SANDBOX_EXTERNAL_TARGET`，Windows 先初始化沙箱）。

## 代码是怎么组织的

| 目录                            | 内容                                                                                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/engine/src/agent`     | 智能体 loop、持续会话、模型、记忆、工具、提示词、权限、技能和外部 Agent 接入                                                                          |
| `packages/engine/src/infra`     | 沙箱、配置源解析、工作区、存储、进程和共享锁等基础机制                                                                                                |
| `packages/engine/src/app`       | 引擎服务编排：项目启动、持久任务、HTTP/WebSocket 协议和 host 启停                                                                                     |
| `packages/sdk/js`               | SDK：生成的接口客户端、启动引擎进程、高层 API、把事件整理成会话状态（store）、插件类型、成员适配器开发库（`adapter`）、错误类型（`errors`）、会话导出 |
| `packages/util`、`packages/log` | 共用的基础代码、错误码目录、日志                                                                                                                      |
| `apps/cli`                      | `merak` 这个程序：各个命令，以及 `merak serve`（桌面端内置的引擎就是它）                                                                              |
| `apps/desktop/main`             | 桌面端主进程（Electron）                                                                                                                              |
| `apps/desktop/renderer`         | 桌面端界面（SolidJS + Vite，纯 CSS）                                                                                                                  |

SDK 里只有 `packages/sdk/openapi.json` 和 `packages/sdk/js/src/client/gen/` 是生成的，其他都是手写的，可以直接改。

`merak` 这个程序有两种身份：

- **客户端**。`run`、`acp` 和各个管理命令都不加载引擎，而是用 SDK 的 `startEngine` 拉起一个 `merak serve` 子进程（还是同一个程序），再通过 HTTP 和事件流跟它通信。桌面端也一样。
- **引擎本身**。`merak serve` 加载引擎并对外提供服务。CLI 的平台包 `merakcode-<系统>-<架构>` 里有一份 Node 和打包好的 `lib/index.js`，npm 上的 SDK 拉起的就是它，桌面安装包里也内置了同一份。

```text
桌面端 / merak 的命令 / 你的程序
          │  @merakcode/sdk（HTTP + 事件流 + 终端 WebSocket）
          ▼
     merak serve（引擎）──► 模型服务
          │
          ▼
     系统沙箱里跑命令
```

所以 CLI 的源码依赖 SDK，SDK 运行时又依赖 CLI 的发布产物。三者版本号必须一致，一起发布。

## 边界规则

引擎内部依赖方向为 app → agent → infra；infra 只引用 infra，agent 不引用 app，持续会话记录不引用 loop。字段 schema 由各模块定义，app 静态组合并装配运行接口。产品业务代码只能通过 SDK 调用引擎。`pnpm check:deps` 会检查下面几条，违反了直接报错：

1. 只有 `apps/cli` 能引用引擎，桌面端、以后新加的应用和其他包都不行。它们也不能引用 `apps/cli`，否则就能借 CLI 的命令把引擎带进自己的进程。
2. `apps/cli` 引用引擎时只能用 `@merakcode/engine/host` 这一个入口。
3. 只有 `serve`、`generate` 和 `debug` 这几个命令能加载引擎，具体就是 `serve.ts`、`generate.ts` 和 `debug/host.ts` 这三个文件；`run`、`acp` 和其他命令一律走 SDK。这三个文件只能由 `apps/cli/src/index.ts` 注册命令时引用（`debug` 的子命令可以用 `debug/host.ts`）。
4. `apps/cli/src/index.ts` 启动时加载的模块不能间接带进引擎（用动态 `import()` 按需加载可以）。
5. 客户端代码（各个应用的 `src`）请求引擎只能用 SDK 生成的方法或 SDK 的 `connectPty`：不能自己用 `fetch`、`WebSocket`、`EventSource`、`XMLHttpRequest`，也不能引用 `http`、`https`、`http2`（带不带 `node:` 都算）、`undici`、`ws` 这些模块。访问第三方服务的几个文件在 `script/check-deps.ts` 里单独列出。
6. 发布出去的代码（各个应用和包的 `src`）加载模块时，模块名必须写成字符串字面量，不能在运行时拼出来。例外有两个：SDK 按名字懒加载 undici（免得网页打包把它带进去），以及整个引擎（它要在运行时按路径加载插件、服务商的包和自定义工具）。
7. 引擎里各家服务商的模型目录适配器（`packages/engine/src/agent/model/catalog/` 下以服务商命名的文件，加上 `relay.ts` 和 `config.ts`）只能由 `agent/model/catalog.ts` 和 `catalog/` 目录里的文件引用，引擎的其他代码只通过 `Provider.Model` 看到模型。

引用是从语法树里认出来的：`import`、`export ... from`、`require`、`createRequire`、`resolve`、类型里的 `import()`，以及 `package.json` 里的依赖别名、本地路径和 `imports` 都算；注释和普通字符串不算。测试文件（`*.test.*`）不受第 5 到 7 条和下一段的限制。

客户端直接读引擎的文件只有两种例外。语言设置要在引擎启动之前就用上，所以 `i18n.ts` 可以通过 `@merakcode/util/config-peek` 读全局配置文件里的这一项；`doctor` 要检查配置文件能不能解析，`bug-report` 要把配置文件原样附进报告。其他配置一律通过 SDK 问引擎；客户端和 SDK 也不能用 `@merakcode/util/paths` 里的 `globalConfigFile`，不能碰 `Paths.data`、`Paths.worktrees` 这些引擎的数据目录。

改这些规则（`script/check-deps.ts`）和加载引擎的那几个文件，需要代码负责人审查，见 `.github/CODEOWNERS`。

## 测试

- 测试用 Vitest，每个包在自己的目录里跑：`cd packages/engine && pnpm test`；只跑一个文件就把路径加在后面。根目录的 `pnpm test` 不跑任何测试；根目录 `script/` 下的脚本用 `pnpm test:script` 测。
- 测真实行为，尽量不用 mock。需要临时目录就用测试夹具里的 `tmpdir()`，用完自动清理。
- 要模型回复的用例用本地的假模型（比如 `packages/sdk/js/test/fixture/model.ts`，按脚本吐出回复），不要连真的模型服务。唯一的例外是 `packages/engine/test/live`：它调用真实的模型接口，要先配好对应的 API 密钥，不在 `pnpm test` 里，只有手动运行 `cd packages/engine && pnpm test:live` 才会跑。
- 要协作群成员的用例用假 CLI（`packages/engine/test/collaboration/fixture/` 里的假 Claude Code、Codex、OpenCode）或假适配器，不要启动真的 CLI。
- 端到端用例会起真实进程，比较慢：通过 SDK 驱动引擎的是 `cd apps/cli && pnpm test:e2e`；桌面端先在 `apps/desktop/main` 和 `apps/desktop/renderer` 里各跑一次 `pnpm build`，再在 `apps/desktop/main` 里跑 `pnpm test:e2e`。
- 测试默认关掉沙箱（测试的 preload 里设了 `MERAKCODE_SANDBOX_MODE=off`），否则在没初始化沙箱的 Windows 上会卡在审批。要测沙箱相关的逻辑，在用例里显式打开。
- 沙箱的一致性测试是 `cd packages/engine && pnpm test:sandbox test/sandbox/os/conformance.test.ts`。沙箱没开时这组用例会跳过；CI 在三个系统上设了 `MERAKCODE_SANDBOX_REQUIRED=1`，跳过就算失败。Windows 上要先运行一次 `pnpm dev sandbox setup`（会弹一次管理员确认）。
- 修 Bug 先写一个能复现的失败用例，再改代码。

## 代码约定

- TypeScript + ESM，Prettier 格式化（不写分号，每行最长 120 字符）。
- 输入用 Zod 校验；工具实现 `Tool.Info` 接口。
- 多用提前 `return`，少用 `else`；多用 `const`，少用 `let`；函数保持短小。
- 不留注释掉的代码和用不到的代码。用不到的变量和导入编译器会报（`packages/sdk/js` 除外），用不到的文件、导出和依赖由 knip 报（`pnpm check:unused`）；注释掉的代码没有工具查，要自己注意。
- 代码注释、日志消息和测试标题用英文。注释只写代码本身看不出来的东西（约束、原因、坑），不要复述代码在做什么。
- `pnpm check:comments` 会查 JS/TS 文件里的注释、`log.info(...)` 这类日志调用的消息和 `describe`、`test`、`it` 的标题，以及 `.sh`、`.ps1`、`.yml` 文件里的 `#` 注释；`locales/` 和 `i18n/` 目录、生成的 `gen/` 目录和 `.d.ts` 文件不查。确实要用中文的那一行，在它上一行加 `// i18n-allow`。
- 给用户看的文字要有中英两份：命令行写在 `apps/cli/src/cli/locales/{zh-CN,en-US}.json`（两边的键必须一致，而且每个键都要用到），桌面端写在 `apps/desktop/renderer/src/i18n/{zh,en}.ts`，引擎里用 `Text.pick({ zh, en })`。给模型看的提示词和工具说明只写英文。
- 桌面端界面用纯 CSS 和设计变量，不要写 `!important`。

## 加依赖

- 版本号写精确的，不带 `^` 或 `~`。`pnpm-workspace.yaml` 里设了 `savePrefix: ""`，`pnpm add` 会照这样写。
- 几个包都要用的依赖，版本写进 `pnpm-workspace.yaml` 的 `catalog`，各包的 `package.json` 里写 `"catalog:"`。
- 依赖带安装脚本时，在 `pnpm-workspace.yaml` 的 `allowBuilds` 里写明：`true` 表示运行（要在本机编译的原生模块），`false` 表示跳过（平台包里已经带了编译好的文件）。
- `patches/` 里是对依赖的补丁，登记在 `patchedDependencies` 里，绑定了具体版本。升级这些依赖时要同时更新补丁（`pnpm patch`）。
- 提交更新后的 `pnpm-lock.yaml`，CI 用 `--frozen-lockfile` 安装。

## 错误码和日志

- 用户可能看到的错误都要有错误码，格式是 `MRK-xxxx`，统一登记在 `packages/util/src/error-code.ts`。千位数字要和 `domain` 对应（对照表在文件开头的注释里），`title`（出了什么事）和 `hint`（用户该怎么办）都要有中英两份，`packages/util` 的测试会查这几条。改完跑 `pnpm generate:errors` 更新 `docs/errors.md`。错误码一旦发布就不要改含义，不用了就留着。
- 打日志：引擎和命令行用 `@merakcode/log/logger` 的 `Log.create({ service: "名字" })`；桌面端主进程用 `apps/desktop/main/src/log.ts` 的 `Log.create("名字")`；桌面端界面用 `apps/desktop/renderer/src/lib/bridge.ts` 的 `log()`，由主进程写进日志；SDK 默认不打日志，只交给调用方传入的 `logger`。都不要用 `console.*` 记诊断信息。日志里不能出现密钥、口令和对话内容。
- 日志写在 `~/.merakcode/logs` 下（设了 `MERAKCODE_HOME` 就在那个目录的 `logs` 下）：正式版在 `production/`，从源码运行在 `development/`，再按组件分目录，比如 `cli/`、`server/`、`desktop/`。每个进程一个 NDJSON 文件，超过 20 MB 就轮转，连当前文件最多留 5 个。`merak logs` 能列出来，`merak bug-report` 会打包并去掉敏感信息。

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

1. 从 `main` 新建分支。
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

## Setup

You need Node.js 26.12 or newer, pnpm 12 and [ripgrep](https://github.com/BurntSushi/ripgrep):

- The `node` on PATH must be 26.12 or newer. Desktop development and the desktop end-to-end tests run the engine sources with it (Electron's built-in Node is too old and lacks `node:ffi`); to use a different `node`, set `MERAKCODE_DESKTOP_NODE`.
- Tests need `rg` on PATH; otherwise every test process downloads its own copy from GitHub.

```sh
git clone https://github.com/TongTong313/merakcode.git
cd merakcode
pnpm install
pnpm hooks:install   # check staged files' formatting before each commit, and the title of each commit
```

For running, debugging and packaging from source, see ["Develop from source" in the README](README.en.md#develop-from-source).

## Commands

All from the repo root:

| Command                            | What it does                                                                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm --dir apps/desktop/main dev` | Work on the desktop app from source (UI changes apply on save, main process changes restart the app; after engine changes use Help › Restart Local Service)                          |
| `pnpm dev <command>`               | Run a `merak` command from source, such as `pnpm dev serve`                                                                                                                          |
| `pnpm check`                       | The static checks a PR must pass (no tests), see below                                                                                                                               |
| `pnpm test:script`                 | Tests for the scripts in the root `script/` folder                                                                                                                                   |
| `pnpm format`                      | Format the whole repo                                                                                                                                                                |
| `pnpm generate:sdk`                | Regenerate the SDK client (`packages/sdk/openapi.json` and `packages/sdk/js/src/client/gen/`) after changing a server route                                                          |
| `pnpm generate:schema`             | Regenerate `schema/config.json` after changing config options                                                                                                                        |
| `pnpm generate:errors`             | Regenerate `docs/errors.md` after changing error codes                                                                                                                               |
| `pnpm generate:adapter-library`    | Regenerate the single-file adapter library, its types and the TypeScript examples the `adapter-generator` skill ships, after changing `@merakcode/sdk/adapter` or a built-in adapter |
| `pnpm generate:sdk-reference`      | Regenerate `docs/sdk/reference.md` after changing a server route (run `generate:sdk` first)                                                                                          |
| `pnpm check:api --write`           | Update `packages/sdk/js/api.md` when you change the SDK API on purpose                                                                                                               |
| `pnpm release:version x.y.z`       | Set every package to the same version (for maintainers)                                                                                                                              |

`pnpm check` runs these scripts in order; each can also run on its own (`pnpm <script>`):

| Script                  | What it checks                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `format:check`          | Prettier formatting                                                                         |
| `check:brand`           | No old product names or unfilled placeholders                                               |
| `check:comments`        | No Chinese in code comments, log messages or test titles; see [Conventions](#conventions)   |
| `check:versions`        | Every package has the same version                                                          |
| `check:schema`          | `schema/config.json` is up to date                                                          |
| `check:errors`          | `docs/errors.md` is up to date                                                              |
| `check:adapter-library` | The single-file adapter library, its types and the adapter examples are up to date          |
| `check:sdk`             | OpenAPI and the generated SDK client match the server, regenerated in a temporary directory |
| `typecheck`             | Types in every package                                                                      |
| `check:deps`            | Dependency boundaries; see [Boundary rules](#boundary-rules)                                |
| `check:css`             | No `!important` in the desktop CSS                                                          |
| `check:api`             | The SDK API matches the snapshot in `packages/sdk/js/api.md`                                |
| `check:sdk-reference`   | `docs/sdk/reference.md` is up to date                                                       |
| `check:sdk-docs`        | The SDK guide mentions every public export and its code compiles                            |
| `check:docs`            | Every `merak` command in the docs exists                                                    |
| `check:unused`          | Unused files, exports and dependencies (knip)                                               |

`pnpm check` runs no tests. CI runs repository scripts, every package's tests, sandbox conformance, CLI and SDK npm consumer checks, production desktop directory smoke tests and end-to-end tests on Windows, macOS and Linux (see `.github/workflows/ci.yml`). Non-desktop jobs skip downloading Electron; OS conformance runs once in its initialized, dedicated job.

`pnpm check:sdk` regenerates OpenAPI and the SDK client in a temporary directory and compares content, added files and deleted files. It ignores line-ending differences and stabilizes schema order before generation. Don't edit generated files by hand; change the source and run the matching `generate` command.

Regular gates use local fake models and HTTP fixtures. Timing thresholds and external network isolation run only through the manually dispatched **Manual regression** workflow, on all three systems, outside PR and release gates. For `external-network`, supply a reachable external TCP control endpoint as `http://host:port`; an unreachable endpoint fails rather than counting as successful isolation. Local entry points are `pnpm test:perf` in `apps/cli` and `pnpm test:sandbox:external` in `packages/engine` (set `MERAKCODE_SANDBOX_EXTERNAL_TARGET`; initialize the Windows sandbox first).

## How the code is organized

| Directory                       | What's in it                                                                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/engine/src/agent`     | Agent loop, persistent sessions, models, memory, tools, prompts, permissions, skills and external agents                                                                             |
| `packages/engine/src/infra`     | Sandbox, config source parsing, workspaces, storage, processes and shared locks                                                                                                      |
| `packages/engine/src/app`       | Engine service composition: project startup, persistent tasks, HTTP/WebSocket protocol and host lifecycle                                                                            |
| `packages/sdk/js`               | The SDK: generated API client, engine process launcher, high-level API, event store, plugin types, the member adapter library (`adapter`), error types (`errors`), transcript export |
| `packages/util`, `packages/log` | Shared helpers, the error code catalog, logging                                                                                                                                      |
| `apps/cli`                      | The `merak` program: its commands and `merak serve` (the engine the desktop app ships)                                                                                               |
| `apps/desktop/main`             | Desktop main process (Electron)                                                                                                                                                      |
| `apps/desktop/renderer`         | Desktop UI (SolidJS + Vite, plain CSS)                                                                                                                                               |

Only `packages/sdk/openapi.json` and `packages/sdk/js/src/client/gen/` in the SDK are generated; everything else is hand-written and can be edited directly.

The `merak` program plays two roles:

- **Client.** `run`, `acp` and the management commands never load the engine. They use the SDK's `startEngine` to launch a `merak serve` child process (the same program) and talk to it over HTTP and an event stream. The desktop app does the same.
- **The engine itself.** `merak serve` loads the engine and serves it. The CLI platform package `merakcode-<os>-<arch>` holds a copy of Node and the bundled `lib/index.js`; that is what the SDK from npm launches, and the desktop installer ships the same copy.

```text
desktop app / merak commands / your program
          │  @merakcode/sdk (HTTP + event stream + terminal WebSocket)
          ▼
     merak serve (engine) ──► model providers
          │
          ▼
     commands run in the OS sandbox
```

So the CLI source depends on the SDK, and the SDK at runtime depends on the CLI's release build. All three share one version and ship together.

## Boundary rules

Engine dependencies flow from app to agent to infra; infra imports only infra, agent never imports app, and persistent session records never import loop. Modules define their own field schemas; app statically composes them and binds runtime interfaces. Product code calls the engine only through the SDK. `pnpm check:deps` enforces these rules and fails on any violation:

1. Only `apps/cli` may import the engine; the desktop app, apps added later and the other packages may not. They may not import `apps/cli` either, or they could pull the engine into their own process through the CLI's commands.
2. `apps/cli` may only import the engine through `@merakcode/engine/host`.
3. Only the `serve`, `generate` and `debug` commands load the engine, in exactly three files: `serve.ts`, `generate.ts` and `debug/host.ts`. `run`, `acp` and everything else go through the SDK. Those three files are imported only by `apps/cli/src/index.ts` to register the commands (the `debug` subcommands may use `debug/host.ts`).
4. Modules loaded at startup by `apps/cli/src/index.ts` must not pull in the engine, even indirectly (a dynamic `import()` on demand is fine).
5. Client code (each app's `src`) sends requests to the engine only through SDK-generated methods or SDK `connectPty`: never with its own `fetch`, `WebSocket`, `EventSource` or `XMLHttpRequest`, and never by importing `http`, `https`, `http2` (with or without `node:`), `undici` or `ws`. The few files that talk to third-party servers are listed in `script/check-deps.ts`.
6. Shipped code (the `src` of each app and package) names the modules it loads with string literals, never with names built at runtime. There are two exceptions: the SDK loads undici by name (so web bundles leave it out), and the whole engine is exempt (it loads plugins, provider packages and custom tools by path at runtime).
7. The engine's per-provider model catalog adapters (the files named after providers in `packages/engine/src/agent/model/catalog/`, plus `relay.ts` and `config.ts`) may only be imported by `agent/model/catalog.ts` and the files in `catalog/`; the rest of the engine sees models only as `Provider.Model`.

References are read from the syntax tree: `import`, `export ... from`, `require`, `createRequire`, `resolve`, `import()` in types, and dependency aliases, local paths and `imports` in `package.json` all count; comments and plain strings do not. Test files (`*.test.*`) are exempt from rules 5 to 7 and from the next paragraph.

Clients read the engine's files directly in two cases only. The language setting is needed before the engine starts, so `i18n.ts` reads that key from the global config file through `@merakcode/util/config-peek`; `doctor` checks that config files parse, and `bug-report` attaches them as they are. Everything else comes from the engine through the SDK; clients and the SDK may not use `globalConfigFile` from `@merakcode/util/paths`, nor touch the engine's data directories such as `Paths.data` and `Paths.worktrees`.

Changes to these rules (`script/check-deps.ts`) and to the files that load the engine need review from the code owner; see `.github/CODEOWNERS`.

## Tests

- Tests use Vitest and run per package: `cd packages/engine && pnpm test`; add a file path to run just that file. `pnpm test` at the root runs no tests; the scripts in the root `script/` folder are tested with `pnpm test:script`.
- Test real behavior and avoid mocks. For temporary directories use the `tmpdir()` fixture; it cleans up after itself.
- Tests that need model replies use a local fake model (such as `packages/sdk/js/test/fixture/model.ts`, which replies from a script), never a real provider. The one exception is `packages/engine/test/live`: it calls real model APIs and needs their API keys, is not part of `pnpm test`, and runs only when you run `cd packages/engine && pnpm test:live` yourself.
- Tests that need collaboration members use fake CLIs (the fake Claude Code, Codex and OpenCode in `packages/engine/test/collaboration/fixture/`) or a fake adapter, never a real CLI.
- End-to-end tests start real processes and are slow: the engine driven through the SDK uses `cd apps/cli && pnpm test:e2e`; for the desktop app run `pnpm build` in both `apps/desktop/main` and `apps/desktop/renderer`, then `pnpm test:e2e` in `apps/desktop/main`.
- Tests turn the sandbox off by default (the test preload sets `MERAKCODE_SANDBOX_MODE=off`); otherwise they would stop at an approval on a Windows machine without sandbox setup. Turn it on explicitly in tests that are about the sandbox.
- The sandbox conformance tests are `cd packages/engine && pnpm test:sandbox test/sandbox/os/conformance.test.ts`. They skip when the sandbox is off; CI sets `MERAKCODE_SANDBOX_REQUIRED=1` on all three systems so a skip counts as a failure. On Windows, run `pnpm dev sandbox setup` once first (it asks for administrator approval once).
- When fixing a bug, write a failing test that reproduces it before changing the code.

## Conventions

- TypeScript and ESM, formatted with Prettier (no semicolons, 120 columns).
- Validate inputs with Zod; tools implement the `Tool.Info` interface.
- Prefer early returns over `else`, `const` over `let`, and short functions.
- No commented-out or unused code. The compiler reports unused variables and imports (except in `packages/sdk/js`), and knip reports unused files, exports and dependencies (`pnpm check:unused`); nothing checks for commented-out code, so watch for it yourself.
- Code comments, log messages and test titles are in English. Comments only say what the code can't: constraints, reasons, gotchas. Don't narrate what the code does.
- `pnpm check:comments` checks comments in JS and TS files, the messages of log calls such as `log.info(...)`, the titles of `describe`, `test` and `it`, and `#` comments in `.sh`, `.ps1` and `.yml` files; it skips `locales/` and `i18n/` folders, generated `gen/` folders and `.d.ts` files. When a line really needs Chinese, put `// i18n-allow` on the line before it.
- Text shown to users needs Chinese and English: the command line uses `apps/cli/src/cli/locales/{zh-CN,en-US}.json` (both files need the same keys, and every key must be used), the desktop app uses `apps/desktop/renderer/src/i18n/{zh,en}.ts`, and the engine uses `Text.pick({ zh, en })`. Prompts and tool descriptions for the model are English only.
- The desktop UI uses plain CSS with design tokens. No `!important`.

## Adding dependencies

- Pin exact versions, without `^` or `~`. `pnpm-workspace.yaml` sets `savePrefix: ""`, so `pnpm add` writes them that way.
- When several packages use a dependency, put its version in the `catalog` of `pnpm-workspace.yaml` and write `"catalog:"` in each `package.json`.
- When a dependency has install scripts, list it under `allowBuilds` in `pnpm-workspace.yaml`: `true` runs them (native modules built on your machine), `false` skips them (the platform packages already ship prebuilt files).
- `patches/` holds patches to dependencies, registered under `patchedDependencies` for an exact version. When you upgrade one of those dependencies, update its patch too (`pnpm patch`).
- Commit the updated `pnpm-lock.yaml`; CI installs with `--frozen-lockfile`.

## Error codes and logs

- Every error a user might see needs a code of the form `MRK-xxxx`, registered in `packages/util/src/error-code.ts`. The thousands digit must match its `domain` (the comment at the top of the file has the table), and both `title` (what happened) and `hint` (what the user should do) need Chinese and English; the tests in `packages/util` check this. Then run `pnpm generate:errors` to update `docs/errors.md`. Once a code is released, don't change its meaning; if it is no longer used, leave it in place.
- Logging: the engine and the command line use `Log.create({ service: "name" })` from `@merakcode/log/logger`; the desktop main process uses `Log.create("name")` from `apps/desktop/main/src/log.ts`; the desktop UI uses `log()` from `apps/desktop/renderer/src/lib/bridge.ts`, which the main process writes to its log; the SDK logs nothing by default and only hands entries to a `logger` the caller passes. None of them use `console.*` for diagnostics. Logs must never contain keys, passwords or conversation content.
- Logs go under `~/.merakcode/logs` (or `logs` under `MERAKCODE_HOME` when that is set): `production/` for releases and `development/` when running from source, then one folder per component, such as `cli/`, `server/` and `desktop/`. Each process writes one NDJSON file, rotated at 20 MB, keeping at most 5 files including the current one. `merak logs` lists them and `merak bug-report` zips them with sensitive data removed.

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

1. Branch off `main`.
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
