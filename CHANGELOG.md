# Changelog

All notable changes to MerakCode are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

MerakCode 所有值得注意的变化都记在这里。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.2.0] - 2026-10-28

### Changed

- Review shows pending agent edits for This turn and Conversation, with comments on selected code lines, resumable drafts and undo after the list becomes empty. Source Control separately stages and unstages files and commits the index. Review decisions preserve Git index and history; Git rows link only to files still pending review. The Git discard, comparison-review and quick-command interfaces are removed; free commands remain available in the terminal.
- Breaking SDK change: review scopes are only `session` / `turn`; decisions require explicit file versions. Git file management uses `vcs.changes.get`, `vcs.changes.stage` and `vcs.changes.unstage`, with checkout and version validation.

- A turn's changed files start folded; clicking the card lists them all, scrolling after six rows. Review stays available while folded.
- New conversations can select a globally configured agent product with its own model and streamed text. Agent Connections settings are separate from Collaboration role templates, including seven read-only built-in roles and custom templates. Turning a product off locks its direct conversations until the user explicitly accepts MerakCode takeover; group members go offline while other members continue.
- The homepage can switch local branches or prepare a new worktree from a chosen branch. Working-branch controls live in Source Control, independently of conversation review. Unsaved editor buffers and review comments survive view changes and prevent switching.
- The SDK adds checkout-aware branch operations and HEAD events. Review decisions and undo now require `expectedCheckout` from the displayed review, so stale operations cannot modify another checkout context.
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

- The composer and side panel navigation stay usable when the window shrinks, and delayed conversation history no longer replaces completed member replies or restores deleted messages.
- External agent cleanup on Linux and macOS finds the system process tools even when PATH has no system commands.
- The first file search waits for the initial index, so an existing file can be mentioned without typing again.
- Refreshing dropdown options no longer resaves an unchanged setting and interrupts a conversation with a config reload.
- Concurrent project configuration loads retain their own warnings instead of losing or mixing them.
- Git index actions finish refreshing their file list before accepting the next action and preserve background refreshes, so Stage all includes files just unstaged or created during the operation.
- Worktree conversations keep their branch names and merge target when the same project is opened through an alternate directory spelling.
- Open branch menus follow refreshes completed by another picker while preserving the guard against switching with unsaved edits.
- Review comments exclude an unselected line when a native selection ends at its start, and feedback relocated during submission stays pending after the earlier request succeeds.
- After the engine restarts or is killed mid-turn, unfinished native tool calls no longer stay spinning: loading the conversation (or disposing the instance) marks them interrupted, and the next message starts a new turn instead of continuing under the stuck one.
- External conversations with agent products such as Claude Code and Codex are titled from the first message with the configured small model, instead of keeping the default `New session - …` title.
- Delayed product probes and session updates no longer undo newer settings or takeover decisions. Recreated products require a fresh takeover decision; takeover retains observed steps from failed or cancelled turns without text. Final snapshots remove obsolete fragments, and connection settings show the adapter's reported permission owner and retain MRK error codes.
- External tasks finish process-tree cleanup before releasing their directory. Final replies calibrate streamed text, client clock differences preserve conversation history, admitted turns update recent activity, and group adapter errors retain localized MRK codes.
- A late takeover response cannot block decisions for a new disable cycle or another conversation. Disabled group members consistently show offline, including queued tasks, with localized errors. Products without text streaming show that output arrives on completion.

- External chat history rejects reused message and part IDs, and command connections preserve complete recovery IDs across split output and failed runs. External chat errors follow the selected language and show stable MRK codes.
- Command connections with a session ID pattern and no resume arguments replay conversation history on later turns. Editing or refreshing agent connections discards stale verification reports.
- Setting up the sandbox, or turning it off, no longer lets a file-changing command through when read-only mode or an explicit deny still refuses it. Resetting the sandbox while it is turned off still reports that it can be set up again.
- Hints on the composer bar open just above their controls: context usage, the model, reasoning, the sandbox, and the permission mode.
- Typing `/skill-name` after a space, including in the middle of a sentence, loads that skill. Skills are read from Claude's `.claude/skills` and `.agents/skills`, and from `.merakcode/skill` and `.merakcode/skills`. A skill the agent is denied is not loaded.
- Maximizing the review from a new conversation fills the window with the review.
- A subagent's question reaches the SDK's `onQuestion` of the conversation that started it, and is dismissed without one, instead of leaving the turn waiting.
- A member adapter's request with nothing to check (empty `paths` or an empty `command`) is refused instead of allowed.
- The Linux sandbox helper only runs the request the engine wrote for it.

### 变更

- 审阅只显示本轮和整个对话的智能体待审改动，支持选中代码行评论、草稿恢复及空列表下撤销审阅。Git 管理独立提供暂存、取消暂存和提交已暂存内容；审阅决定不改变 Git 暂存区及提交历史，Git 文件只跳转到仍待审的改动。移除 Git 页的丢弃、分支比对审阅和快捷命令入口，自由命令由终端承接。
- SDK 不兼容变更：审阅范围只保留 `session` / `turn`，决定必须携带明确的文件版本；Git 文件管理切换到 `vcs.changes.get`、`vcs.changes.stage` 和 `vcs.changes.unstage`，校验 checkout 和文件版本。

- 每轮的改动文件默认收起；点击卡片标题展开全部文件，超过六行时在列表内滚动。收起时仍可直接审阅。
- 新建对话可以选择全局配置的智能体产品，使用各产品独立模型和流式正文。「智能体接入」与「协作群」角色模板设置分开，提供七个只读内置角色和自定义模板。关闭产品后，单聊锁定输入，只有用户明确同意才由 MerakCode 接管；群成员仅显示离线，其他成员继续工作。
- 主页可以切换本地分支，或选择起点后准备创建新工作树。工作分支操作移至独立的 Git 管理页，与对话审阅分开。未保存的编辑缓冲和审阅评论在切换视图后仍保留，并阻止切换工作分支。
- SDK 新增带 checkout 身份的分支操作和 HEAD 事件。审阅决定与撤销现在必须携带所显示审阅的 `expectedCheckout`，防止过期操作修改另一个 checkout 上下文。
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

- 窗口缩小时，消息输入框与右侧面板导航仍可正常使用；延迟返回的对话历史不再覆盖已完成的成员回复或恢复已删除的消息。
- Linux 和 macOS 上，即使 PATH 不包含系统命令，外部智能体清理仍能找到系统进程工具。
- 首次文件搜索会等待初始索引完成，引用已有文件时不必再次输入才能看到补全结果。
- 下拉选项刷新时不再重复保存未改变的设置，避免配置重载中断刚开始的对话。
- 多个项目并行加载配置时，告警按各自项目收集，不再丢失或串到其他项目。
- Git 索引操作在文件列表刷新完成后才接受下一次操作，并保留期间的后台刷新，“暂存全部”也会包含刚取消暂存或在操作期间新建的文件。
- 同一项目使用不同目录写法打开时，工作区对话仍能显示正确的分支名和合并目标。
- 已打开的分支菜单会同步其他选择器完成的刷新，同时继续阻止带有未保存编辑的分支切换。
- 原生代码选区结束在下一行行首时，审阅评论不再包含未选中的行；发送期间重新定位的反馈在旧请求成功后仍保留待发送。
- 引擎在中途重启或被强杀后，未完成的本地工具调用不再一直转圈：打开对话（或销毁实例）时会标为重启中断，下一条消息会开新一轮，而不会挂在卡住的那一轮下面。
- 使用 Claude Code、Codex 等智能体产品的单聊会在第一条消息后使用配置的 small model 生成标题，不再保留默认的 `New session - …` 标题。
- 延迟的产品探测和会话更新不会覆盖新设置或接管决定；删除后重建的产品需要重新确认接管。接管保留无正文失败或取消任务的已记录步骤，最终正文快照清除过时片段，接入设置按适配器报告显示权限归属并保留 MRK 错误码。
- 外部任务清理完进程树后才释放目录占用；完整回复会校准流式正文，客户端时钟偏差不再遗漏对话历史，成功接收的轮次会更新最近活动时间，群适配器错误保留本地化提示与 MRK 编号。
- 过期接管响应不会阻止新禁用周期或其他对话中的确认。停用群成员在排队阶段也统一显示离线，错误提示支持中英；不支持正文流式的产品会标明“完成后输出”。

- 外部对话历史会拒绝复用已有消息和正文片段 ID，命令接入在分块输出和执行失败时仍保存完整恢复 ID。外部对话错误按所选语言显示，并提供稳定的 MRK 错误码。
- 仅配置会话 ID 识别、未配置续接参数的命令接入会在后续轮次回放对话历史。编辑或刷新智能体接入时会丢弃过期验证结果。
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
