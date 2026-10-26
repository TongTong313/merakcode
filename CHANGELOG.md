# Changelog

All notable changes to MerakCode are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

MerakCode 所有值得注意的变化都记在这里。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Changed

- The conversation composer shows the sandbox as on or off beside a shield. Hovering context usage, the model, reasoning, the sandbox, or the permission mode says what that control configures, with the current value still on the button. The menu can set the sandbox up (Windows asks for administrator approval once), turn it on, or turn it off, without leaving the conversation. A command waiting only because the sandbox was not ready continues once the sandbox is on, or once you turn it off. An already set up sandbox is warmed when the engine starts.
- The homepage model menu lists Official before Configured, and "Add model" at its bottom opens the provider list in Settings.
- Commands wrapped in `env`, `sudo`, `nice`, `timeout`, `xargs` and the like, command lines inside `sh -c` and `eval`, and tool options before a subcommand (`git -C dir push`, `pnpm --filter x publish`) are judged by the command that actually runs. Read-only commands with options that write files or run other programs (`sort -o`, `rg --pre`, `git diff --output=`) count as file-changing commands.
- A command argument naming a secret file is asked about even as a relative path (`cat .env`), and `~/.merakcode/data/auth.json`, where MerakCode keeps provider keys, counts as a secret.
- Editing MerakCode's own config files (`merakcode.json`, `merakcode.jsonc`) asks first even in auto mode, under the new permission key `config_write`, and the sandbox keeps commands from changing a project's config files, as it does for `.git/hooks` and `.git/config`.
- Error hints point to `merak provider login` and Settings → Models & providers instead of a `/provider` command, and the sandbox hints say what to do in each case.
- The engine no longer accepts browser requests from `*.merakcode.ai`.
- Tool descriptions for the model match what the tools do; the `ls` tool, which was never available, is removed.
- The desktop installers' `THIRD_PARTY_LICENSES.txt` also lists the packages bundled into the main process.
- The README, SECURITY.md, SDK guide, CONTRIBUTING.md and AGENTS.md are brought in line with the code: a permission rule example that did not apply, SDK examples that did not run as written, and what the sandbox and permission checks can and cannot stop.

### Fixed

- Setting up the sandbox, or turning it off, no longer lets a file-changing command through when read-only mode or an explicit deny still refuses it. Resetting the sandbox while it is turned off still reports that it can be set up again.
- Hints on the composer bar open just above their controls: context usage, the model, reasoning, the sandbox, and the permission mode.
- Typing `/skill-name` after a space, including in the middle of a sentence, loads that skill. Skills are read from Claude's `.claude/skills` and `.agents/skills`, and from `.merakcode/skill` and `.merakcode/skills`. A skill the agent is denied is not loaded.
- Maximizing the review from a new conversation fills the window with the review.
- A subagent's question reaches the SDK's `onQuestion` of the conversation that started it, and is dismissed without one, instead of leaving the turn waiting.
- A member adapter's request with nothing to check (empty `paths` or an empty `command`) is refused instead of allowed.
- The Linux sandbox helper only runs the request the engine wrote for it.

### 变更

- 对话栏里沙箱是盾牌图标加「开」或「关」。悬停上下文用量、模型、思考档位、沙箱或权限模式，都会说明这个控件是在配置什么，当前的值仍写在按钮上。点开沙箱可以初始化（Windows 会要一次管理员确认）、开启或关闭，不用离开当前对话。只因为沙箱没就绪才在等审批的命令，会在沙箱打开之后继续执行；你把沙箱关掉之后也会继续。已经初始化过的沙箱会在引擎启动时预先准备好。
- 主页的模型菜单改成「官方供应商」在前、「配置的模型」在后，底部的「添加模型」改为打开设置里的服务商列表。
- 包在 `env`、`sudo`、`nice`、`timeout`、`xargs` 等命令里的命令、`sh -c` 和 `eval` 里的命令，以及写在子命令前面的选项（`git -C 目录 push`、`pnpm --filter x publish`），都按实际执行的那条命令判断。只读命令带上会写文件或执行别的程序的参数（`sort -o`、`rg --pre`、`git diff --output=`）时，按会改文件的命令算。
- 命令的参数写到密钥文件时，用相对路径（`cat .env`）也会先问；MerakCode 保存模型服务密钥的 `~/.merakcode/data/auth.json` 也算密钥。
- 改 MerakCode 自己的配置文件（`merakcode.json`、`merakcode.jsonc`）在自动模式下也要先问，对应新的权限键 `config_write`；沙箱也不让命令改项目的配置文件，和 `.git/hooks`、`.git/config` 一样。
- 错误码的提示改为指向 `merak provider login` 和「设置 → 模型与供应商」，不再提不存在的 `/provider` 命令；沙箱相关的提示写清了每种情况该怎么办。
- 引擎不再接受来自 `*.merakcode.ai` 的浏览器请求。
- 给模型看的工具说明和工具的实际行为对齐；删掉了从来没有启用过的 `ls` 工具。
- 桌面安装包里的 `THIRD_PARTY_LICENSES.txt` 也列出了打进主进程的依赖包。
- README、SECURITY.md、SDK 手册、CONTRIBUTING.md 和 AGENTS.md 按代码重新核对：修正了不生效的权限规则示例、照着写跑不起来的 SDK 示例，并写清了沙箱和权限审批能挡什么、挡不住什么。

### 修复

- 初始化沙箱或关掉沙箱时，只读模式或明确拒绝仍挡住的改文件命令不会被放行。沙箱关着的时候重置，仍会显示还可以再初始化。
- 对话栏上的悬停说明出现在控件正上方，包括上下文用量、模型、思考档位、沙箱和权限模式。
- 在空格后面输入 `/技能名`（包括写在句子中间）会加载该技能。技能从 Claude 的 `.claude/skills`、`.agents/skills`，以及 `.merakcode/skill`、`.merakcode/skills` 读取。智能体被拒绝使用的技能不会加载。
- 在新对话里铺满审阅时，窗口显示的是全屏审阅。
- 子智能体的提问会交给发起它的会话的 SDK `onQuestion`，没给 `onQuestion` 时会被跳过，不再让这一轮一直卡着。
- 成员适配器发来的没有可检查内容的审批请求（`paths` 为空或 `command` 为空）改为拒绝，不再放行。
- Linux 沙箱的辅助进程只执行引擎为它写好的那条请求。

## [0.1.2] - 2026-10-25

### Changed

- Connected providers load their model list from the provider, with the saved key, instead of a bundled models.dev snapshot. A failed refresh is shown once (MRK-2001, MRK-2004, or MRK-2010).
- The homepage model menu is two sections, Configured then Official. An official provider starts with one current model per named line: Alibaba starts on unsuffixed `qwen-plus` and `qwen-max`, and OpenRouter starts with nothing on. A model that starts off can be added from the bottom of the menu, and Settings has a model list for each provider.
- Prices can be USD or CNY, can step by prompt size, and use a separate thinking price. Stats and the composer show a separate total for each currency (USD and CNY are never added together); ACP reports a cost only when every reply is priced in the same currency.
- The reasoning level starts from the model's catalog default, then keeps the level last sent with that model. A relay's discovered models keep the context, output, and modalities the catalog reported.
- Member adapters are written in TypeScript: Node runs an `adapter.mts` as it is, the single-file adapter library comes with its type declarations (`merakcode-adapter.d.mts`), and the `adapter-generator` skill writes TypeScript from the built-in adapters. Adapters already written in JavaScript keep working. The SDK guide explains writing one step by step.
- SDK: global stats `totalCost` and `costPerDay` are keyed by currency, `Model.cost` is optional and carries `currency`, and a relay's discovered models have `input` and `outputModalities` instead of `image`.

### Fixed

- The new-group dialog can clear a copied group and return to a blank draft.

### 变更

- 已连接的服务商用保存的密钥向服务商拉取模型列表，不再使用打包的 models.dev 快照。刷新失败时提示一次（MRK-2001、MRK-2004 或 MRK-2010）。
- 主页的模型菜单分成「配置的模型」和「官方供应商」两段。官方供应商默认只打开每个指定系列里当前的一个模型：阿里云百炼只开不带后缀的 `qwen-plus` 和 `qwen-max`，OpenRouter 默认一个都不开。没打开的模型可以在菜单底部「添加模型」，设置里每个服务商有一份「模型配置」。
- 价格可以是美元或人民币，可以按提示词长度分档，思考另有价格。统计和输入框按币种分别显示合计（美元和人民币不相加）；ACP 只在每条回复都有价格且币种相同时才上报费用。
- 推理档位先用模型目录里的默认值，再记住这个模型上次发送的档位。中转发现的模型保留目录里实际返回的上下文、输出长度和模态。
- 成员适配器改用 TypeScript 写：Node 直接运行 `adapter.mts`，单文件适配器开发库带上了类型声明（`merakcode-adapter.d.mts`），技能 `adapter-generator` 照着内置适配器写 TypeScript。已经用 JavaScript 写好的适配器照样能用。SDK 手册一步步讲了怎么写。
- SDK：全局统计的 `totalCost`、`costPerDay` 改为按币种分组，`Model.cost` 改为可选并带上 `currency`，中转站发现的模型用 `input` 和 `outputModalities` 代替 `image`。

### 修复

- 新建协作群时，复制了已有的群之后可以清空，回到空白草稿。

## [0.1.1] - 2026-10-24

### Added

- Collaboration groups: MerakCode leads, and Claude Code, Codex, OpenCode and other CLIs join as members. Members are mentioned with `@`, listed in a member column, tracked in a group todo, and a group can be created with `Ctrl+G` (`⌘G` on macOS) or copied from another one.
- Members follow the group's permission mode: what Claude Code, Codex and OpenCode want to do is decided by MerakCode's rules and shows in the approval bar, and their questions open MerakCode's question box, both naming the member.
- Settings › Collaboration: turn products on or off, see their versions and paths and who decides their permissions, add and edit custom ones, restore defaults, check again. A CLI older than recommended shows how to upgrade it.
- Member adapters: `@merakcode/sdk/adapter` lets any AI coding CLI join a group, and the built-in skill `adapter-generator` writes and registers an adapter for one, working from MerakCode's own adapters for Claude Code, Codex and OpenCode.

### Changed

- Context that changes every step (git status, the group's state) goes at the end of the conversation, so more of each prompt is cached.
- Desktop development no longer restarts the engine when its code changes; use Help › Restart Local Service.
- When automatic updates are turned off, Check for updates says so.

### Removed

- The built-in skill `auto-cli`.

### Fixed

- The sidebar no longer shows a conversation as running while memory is extracted in the background after a reply.
- A conversation no longer stays running after the local service restarts.
- Without GitHub access, files are found right away (in `@` references and glob) instead of after the ripgrep download times out.
- Opened thinking and steps no longer close as a reply goes on.

### 新增

- 协作群：MerakCode 当群主，Claude Code、Codex、OpenCode 和其他 CLI 当成员。可以用 `@` 点名成员，右侧有成员栏和群待办；用 `Ctrl+G`（macOS 上是 `⌘G`）新建，也可以从已有的群复制。
- 成员遵守群里的权限模式：Claude Code、Codex、OpenCode 要做的操作按 MerakCode 的规则判断，需要时出现在审批栏里；它们提的问题弹出 MerakCode 的提问框，都会写明是哪个成员。
- 设置 › 协作群：开关产品，查看版本、路径和权限由谁决定，添加和编辑自定义产品，恢复默认，重新检测。CLI 版本比建议的旧时会提示怎么升级。
- 成员适配器：`@merakcode/sdk/adapter` 让任何 AI 编程 CLI 都能加入协作群，内置技能 `adapter-generator`（适配器生成助手）以 MerakCode 自己的 Claude Code、Codex、OpenCode 适配器为示例，替你写好并注册适配器。

### 变更

- 每一步都会变的上下文（git 状态、群状态）放到对话末尾，提示词能缓存的部分更多。
- 桌面端开发时，引擎代码改完不再自动重启，用「帮助 › 重启本地服务」。
- 关闭自动更新后，「检查更新」会提示已关闭。

### 移除

- 内置技能 `auto-cli`。

### 修复

- 回复结束后后台提取记忆时，侧边栏不再一直显示运行中。
- 本地服务重启后，对话不再卡在运行中。
- 连不上 GitHub 时，`@` 引用和 glob 立刻就能找到文件，不再等 ripgrep 下载超时。
- 展开的思考和步骤不会在回复继续输出时收起。

## [0.1.0] - 2026-10-22

The first public release.

### Added

- Desktop app for Windows, macOS and Linux, with the engine built in. It checks for updates and installs them where the platform allows (unsigned macOS builds and the Linux deb point to the download page instead).
- `merak` command line (no UI): `merak run` for one-off tasks, `merak serve` to run only the engine and `merak acp` for editors.
- TypeScript SDK `@merakcode/sdk`: start or connect to an engine, run sessions, handle approvals and questions, and give the model your own tools.
- Eight built-in model providers (OpenAI, Anthropic, Google, Alibaba Cloud Model Studio, Zhipu AI, DeepSeek, Moonshot AI, OpenRouter), plus any OpenAI-compatible API configured with an API key.
- Three permission modes (read-only, ask, auto) with per-project rules.
- An OS sandbox for agent commands on Windows (separate account, NTFS permissions, firewall), Linux (Landlock) and macOS (Seatbelt), with `merak sandbox status|setup|reset`.
- Error codes (`MRK-xxxx`) on every user-facing error, listed in `docs/errors.md`.
- `merak doctor`, `merak logs` and `merak bug-report` for troubleshooting.
- `merak upgrade` (alias `update`) for script and npm installs.
- Chinese and English UI.

首个公开发布的版本。

### 新增

- Windows、macOS 和 Linux 桌面客户端，自带引擎。会检查更新，平台允许时直接安装（未签名的 macOS 版和 Linux 的 deb 包改为提示去发布页下载）。
- 没有界面的 `merak` 命令行：`merak run` 跑一次性任务，`merak serve` 只启动引擎，`merak acp` 接到编辑器里用。
- TypeScript SDK `@merakcode/sdk`：启动或连接引擎、运行会话、处理审批和提问，还能把自己的工具交给模型调用。
- 内置八家模型服务商（OpenAI、Anthropic、Google、阿里云百炼、智谱、DeepSeek、月之暗面、OpenRouter），其他服务可以用 API 密钥接入 OpenAI 兼容接口。
- 三种权限模式（只读、询问、自动），可以按项目设置规则。
- 智能体执行的命令放进系统沙箱：Windows（独立账户、NTFS 权限、防火墙）、Linux（Landlock）和 macOS（Seatbelt），用 `merak sandbox status|setup|reset` 管理。
- 所有面向用户的错误都带错误码（`MRK-xxxx`），清单见 `docs/errors.md`。
- 排查问题用的 `merak doctor`、`merak logs` 和 `merak bug-report`。
- `merak upgrade`（别名 `update`），用于脚本安装和 npm 安装的升级。
- 中文和英文界面。
