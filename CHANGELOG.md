# Changelog

All notable changes to MerakCode are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

MerakCode 所有值得注意的变化都记在这里。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Changed

- Replace fixed side-panel tabs with a conversation-owned editor for files, reviews, Git, independent terminals and browser pages. Restore independent layouts and drafts, keep tabs adjacent, open files directly for editing, and preview images safely. Preserve concurrent file changes and late-edited drafts. Closing waits for every window's decision, durable drafts and confirmed terminal process exit.

- Rename permission choices to Ask every time, Ask only for risky actions and Full takeover, with explicit safety descriptions.

- Replace conversation modes with Ask every time (`ask`, the default), Ask only for risky actions (`autoApprove`) and Full takeover (`fullTakeover`). The first two levels require per-operation confirmation when required isolation is unavailable. Full takeover chooses isolation or the current account before launch and never replays a failed command automatically. Dedicated official-plan tools preserve human edits, fixed execution snapshots and explicit start sources. Products use the SDK and external adapters use protocol 3.

- After a turn finishes, reasoning and tool steps collapse into a single timing line, keeping the final reply and that turn's changed files. Copy takes only the final reply while folded, and the whole turn once expanded.

### Fixed

- Reject runtime-supplied command arguments, package-manager side effects, indirect file reads and system changes in draft-only tasks. Apply sensitive-file approval to input redirects, file aliases and option values while preserving ordinary literal file reads.

- Reject shell argument expansion and shell-state changes in draft-only tasks while preserving quoted literal arguments.

- Keep SDK cancellation effective during long requests and response bodies after garbage collection.

- Reject shell-variable assignments and unknown `printf` formats in draft-only tasks. Release obsolete plan button locks after chat reruns, including saved sessions, while preserving paused execution snapshots.

- Reject search commands that launch external programs or inherit executable search configuration in draft-only tasks. Preserve execution outcomes across queued discussions so completed or failed plans can be started again.

- Reject abbreviated output options and unknown sorting options in draft-only commands. Let paused plan discussions finish after read-only tools, use the latest editable document for discussion, and preserve the fixed snapshot for execution and resume.

- Treat shell environment overrides as executable input in draft-only tasks. Keep Windows write grants scoped to each command's allowed directories and reject internal grant identifiers supplied by command environments. Hide helper windows and suppress interactive error dialogs. Report ambient writable-directory limits and keep affected commands on per-operation approval.

- Confirm foreground commands, background commands, workflows and external operations have stopped before reporting a plan capacity pause. Preserve unconfirmed stops until their real receipts arrive, prevent automatic resume, and let chat and desktop buttons resume the same snapshot with the selected model. Validate current and rejected legacy adapter protocols in packaged CLI smoke tests.

- Restore controlled Git history queries in draft-only tasks while blocking unsafe arguments, external programs and injected Git configuration.

- Use the backend's private temporary directory for both sandbox permissions and command environment, avoiding authorization of the entire system temporary directory.

- Keep repeated desktop quit requests inside the asynchronous cleanup and let the engine bind its initial port atomically, avoiding startup conflicts between concurrent clients.

- Keep unisolated external tools on per-operation approval even when they copy an official tool name. Bind external plan saves to the running user turn, refresh Windows sandbox readiness after credential changes, and confirm command descendants have stopped before reporting cancellation.

- Respect disabled sandbox operations in tests and system policy. Ordinary tests cannot initialize or reset the Windows account. Noninteractive sandbox verification reuses existing setup, and Windows test workers use bounded concurrency.

- Keep long plans scrollable beneath a fixed action toolbar. Recheck official-plan authorization before saving, preserve cancellation outcomes for external operations, verify the Windows sandbox account at startup, and preserve Chinese paths in installation commands. External root conversations can submit official plans through the SDK adapter host.

- Preserve task limits across child tasks, imported history, queued delegations and workflow notifications. Revalidate root permissions before dispatch and restore only idle child tasks owned by the same root conversation. Visual tooltips no longer intercept panel controls.

- Permission changes apply to compound approvals, scoped grants and delayed target checks. Child conversations share the root official plan and preserve fixed execution content. Repeated saves retain conflict detection, and session deletion validates plan paths before removing unshared legacy copies.

- Switching modes rechecks approvals and cancels unfinished MCP operations. Imported plans stay isolated from the current plan; the approved plan still applies after path aliases and context compaction. Rejected native questions are settled properly.

- Changing only the case of the plan path no longer bypasses human-edit protection, and the approved plan stays in use until background work finishes. Empty-plan errors now have Chinese and English text, and adapter generation instructions use the current mode names.

- Background notifications no longer overwrite human plan edits. Cancel decisions from an old mode no longer apply after a switch. Queued external tasks start under the current mode. A broken session import returns an input error.

- Image attachments in the composer and sent messages show thumbnails; clicking one opens the full image.

### 变更

- 右侧固定面板改为按单聊／群聊独立保存的统一编辑区，文件、审阅、Git、终端和浏览器共用紧邻的标签栏；恢复独立布局和草稿，文件直接编辑，图片安全预览，保护并发文件修改和后来编辑的草稿。退出前先收集各窗口决定、确认草稿持久化，再等待终端进程实际退出。

- 权限选项改为“每次询问”“仅询问危险行为”和“全面接管”，并显示对应安全性描述。

- 权限级别改为每次询问（`ask`，默认）、仅询问危险行为（`autoApprove`）和全面接管（`fullTakeover`）。本次操作缺少所需隔离时，前两档逐次询问。全面接管在启动前选择沙箱或当前账户，不自动重跑失败命令。专用官方计划工具保留人工修改、固定执行快照和启动来源。产品通过 SDK 调用，外部适配器使用协议 3。

- 一轮对话结束后，思考和工具步骤收成一行用时，最终回复和本轮改动文件仍保留。收起时复制只取最终回复，展开后复制整轮内容。

### 修复

- 只出稿任务拒绝动态命令参数、包管理器副作用、间接文件读取和系统修改。输入重定向、文件别名和选项值统一检查敏感文件审批。普通文件读取继续可用。

- 在只出稿任务中拒绝参数展开和 Shell 状态修改，保留引号包裹的普通文本参数。

- SDK 长请求在垃圾回收后仍能取消，等待响应正文时也适用。

- 只出稿任务拒绝修改 Shell 变量及未知格式的 `printf` 命令。聊天重跑后解除过期的计划按钮锁定，已保存会话也适用，暂停执行继续保留原快照。

- 只出稿任务拒绝调用外部程序的搜索命令及可执行的搜索配置。排队讨论保留原执行结果，已完成或失败的计划可以再次启动。

- 只出稿命令拒绝输出参数缩写和未知排序参数。暂停后的计划讨论可在只读工具返回后完成。讨论使用最新编辑稿，执行和恢复继续使用固定快照。

- 只出稿任务把 Shell 环境覆盖按可执行输入处理。Windows 命令只携带获准目录的写入标识，命令环境不能覆盖内部授权标识。辅助进程隐藏窗口并关闭交互错误弹窗。系统中所有人可写目录的限制会明确显示，相关命令继续逐次审批。

- 计划容量暂停会等待前台命令、后台命令、工作流和外部操作确认停止。未确认停止时继续阻止新操作，真实回执到达后更新状态。暂停后不自动恢复。聊天和桌面按钮使用所选模型恢复同一快照。CLI 发布包自检验证当前协议并拒绝旧协议。

- 只出稿任务可以执行受控 Git 历史查询。危险参数、外部程序和注入的 Git 配置继续受限。

- 沙箱权限和命令环境统一使用后端专用临时目录，避免给整个系统临时目录授权。

- 桌面重复退出请求会等待关闭清理。引擎直接绑定初始端口，避免并发客户端抢占预选端口。

- 外部工具冒用官方工具名时仍逐次审批。外部计划保存绑定当前用户轮次。Windows 沙箱在凭据变化后重新探测。命令确认子进程全部退出后才报告停止。

- 测试环境和系统策略禁止沙箱操作时，常规测试不能初始化或重置 Windows 账户。非交互沙箱验收复用已有初始化结果。Windows 测试限制并发数量。

- 长计划可在固定操作栏下滚动。官方计划保存前重新检查权限。外部操作保留取消结果。Windows 启动时验证沙箱账户。安装命令保留中文路径。外部根对话可通过 SDK 适配器提交官方计划。

- 子任务、导入历史、排队委派和工作流通知保留原任务限制。实际派发前重新检查根对话权限。只恢复当前根对话中空闲的子任务。纯显示提示框不再拦截面板操作。

- 权限变化即时作用于复合审批、范围授权和延迟目标检查。子会话共用根对话官方计划，并保留固定执行内容。连续保存保留冲突检查。删除会话会先校验计划路径，再清理没有其他引用的旧计划副本。

- 切换模式时重新检查审批，并取消未完成的 MCP 操作；导入的计划与当前计划隔离，路径别名和上下文压缩后仍沿用已批准的执行计划；被拒绝的原生提问也会正常收尾。

- 计划路径仅大小写变化时，人工修改仍受保护；后台任务完成前始终使用已批准的计划。空计划错误补齐中英文提示，适配器生成说明同步为当前模式名称。

- 后台通知不再覆盖人工修改的计划；旧模式的取消决定在切换后不再生效；排队的外部任务按切换后的模式启动；导入损坏的会话数据返回输入错误。

- 输入框和已发送消息中的图片附件显示缩略图，点击可查看大图。

## [0.3.0] - 2026-11-01

### Changed

- Split the engine into `agent`, `infra`, and `app`: agent behavior, shared infrastructure, and service wiring, with clearer dependency rules between them.
- Put request dispatch, queues, cancellation, recovery, and turn completion in `agent/loop`. Session and message persistence stay in `agent/session`. Execution and context reports reuse the same tool preparation; memory work is scheduled when a turn completes.
- Keep permission decisions in `agent/permission`, and OS isolation in `infra/sandbox` via the existing platform backends and their own conformance tests.
- Keep each config field next to the module that owns it. Infrastructure handles config IO and validation; the app layer handles project init and reload. The host starts and stops the server in one direction only.
- Desktop and CLI product features go through the SDK, including terminal sessions via `connectPty`. Terminal input keeps send order across connect. Existing HTTP, event, config, and persisted-data contracts stay compatible.
- Drop the unused sandbox and client-core package shells and utility re-exports; keep the real code with the modules that use it.

### Fixed

- Unpack release archives with Unicode paths without depending on the Windows system code page.
- Coordinate config dependency installs across engine instances and processes; reinstall damaged packages even when an npm lockfile already exists; keep the local plugin API if npm lifecycle scripts fail.
- Restore interrupted user SDK backups before skipping init; do not let a partial backup cleanup overwrite a restored SDK; stop npm lifecycle child processes before releasing the install directory.
- On dependency process failures, include the Windows operation name and system error code.
- Wait for project file watchers to finish subscribing before startup completes, so early Git changes are not missed.
- Let Git change lists finish loading when a slow request overlaps a background refresh.
- Show takeover dialogs only after Settings closes. Verify Windows installer checksums without relying on PowerShell module discovery. Keep long Unicode paths in release archive headers.
- Shutdown stops scheduled runs before draining memory work; persisted tasks resume after startup; an explicit tool stop no longer reruns the same user request.
- Keep concurrent config edits when auto-writing schema or hitting temporary Windows file locks; use atomic replace when the OS supports it.
- Global events without a directory no longer interrupt Git panel updates; one failing event listener no longer drops later conversation events.

### 变更

- 引擎拆成 `agent`、`infra`、`app` 三层：智能体能力、基础机制、服务编排，并理清依赖方向。
- 请求分发、队列、取消、恢复和回合收尾归到 `agent/loop`；会话与消息持久化仍在 `agent/session`。执行与上下文报告共用工具准备结果，回合结束后再安排记忆任务。
- 权限决策留在 `agent/permission`，系统隔离由 `infra/sandbox` 通过现有平台后端执行，并保留独立的一致性测试。
- 配置字段和默认值跟所属模块放在一起；基础层负责读写与校验，应用层负责项目初始化和重载；宿主单向调用服务端，统一启停顺序。
- 桌面和 CLI 的产品能力统一走 SDK，终端连接由 `connectPty` 承接，连接前后保持输入发送顺序；现有 HTTP、事件、配置和持久数据契约保持兼容。
- 去掉 sandbox、client-core 多余的包壳和工具转发模块，实现留在真正使用的地方。

### 修复

- 发布归档解压不再受 Windows 系统代码页限制，Unicode 路径可完整保留。
- 多个引擎实例和进程的配置依赖安装互相协调；已有 npm 锁文件时仍会重装损坏的包；npm 生命周期脚本失败后仍保留本地插件 API。
- 跳过初始化前先恢复中断的用户 SDK 备份；备份清理只完成一部分时，不会覆盖已恢复的 SDK；释放安装目录前先停掉 npm 生命周期的子进程。
- 依赖进程管理失败时带上 Windows 操作名和系统错误码。
- 项目启动会等到文件监听订阅完成，避免漏掉最初的 Git 变更。
- 后台刷新与较慢请求重叠时，Git 改动列表仍能加载完。
- 接管弹窗等设置关闭后再显示；Windows 安装器校验不再依赖 PowerShell 模块发现；发布归档头正确保留长 Unicode 路径。
- 退出时先停定时任务，再排空记忆任务；持久任务在启动后恢复；工具明确结束回合后，不再重复执行同一条用户请求。
- 自动补写 schema 或遇到 Windows 文件临时占用时，保留并发修改；系统支持时用原子替换写入。
- 不带目录的全局事件不再打断 Git 面板更新；单个事件监听器出错，也不会丢掉后续对话事件。

## [0.2.0] - 2026-10-28

### Changed

- Review lists pending agent edits for This turn and Conversation. You can comment on selected lines, resume drafts, and undo after the list is empty. Source Control separately stages, unstages, and commits. Review decisions do not change the Git index or history; Git rows only open files still pending review. Git discard, comparison review, and quick commands are removed; free commands stay in the terminal.
- Breaking SDK change: review scopes are only `session` / `turn`; decisions must carry explicit file versions. Git file APIs are `vcs.changes.get`, `vcs.changes.stage`, and `vcs.changes.unstage`, with checkout and version checks.

- A turn's changed files start folded; click the card to list them all, with scrolling after six rows. Review still works while folded.
- New conversations can pick a globally configured agent product, each with its own model and streamed text. Agent Connections settings are separate from Collaboration role templates (seven built-in read-only roles plus custom ones). Turning a product off locks its direct chats until the user accepts MerakCode takeover; group members show offline while others keep working.
- The homepage can switch local branches or prepare a new worktree from a chosen branch. Working-branch controls live in Source Control, apart from conversation review. Unsaved editor buffers and review comments survive view changes and block branch switches.
- The SDK adds checkout-aware branch operations and HEAD events. Review decisions and undo require `expectedCheckout` from the displayed review, so a stale call cannot change another checkout.
- The composer shows sandbox on/off next to a shield. Hovering context usage, model, reasoning, sandbox, or permission mode explains what that control sets; the current value stays on the button. From the menu you can set up the sandbox (Windows asks for admin once), turn it on, or turn it off without leaving the conversation. A command waiting only because the sandbox was not ready continues once the sandbox is on, or once you turn it off. An already set-up sandbox is warmed at engine start.
- The homepage model menu lists Official before Configured; `Add model` at the bottom opens the provider list in Settings.
- Commands wrapped in `env`, `sudo`, `nice`, `timeout`, `xargs` and similar, lines inside `sh -c` / `eval`, and options before a subcommand (`git -C dir push`, `pnpm --filter x publish`) are judged by the command that actually runs. Read-only commands with write or exec options (`sort -o`, `rg --pre`, `git diff --output=`) count as file-changing.
- An argument that names a secret file is asked about even as a relative path (`cat .env`). `~/.merakcode/data/auth.json`, where MerakCode stores provider keys, counts as a secret.
- Editing MerakCode config (`merakcode.json`, `merakcode.jsonc`) asks first even in auto mode, under the new permission key `config_write`. The sandbox also blocks changing a project's config files, same as `.git/hooks` and `.git/config`.
- Error hints point to `merak provider login` and Settings → Models & providers instead of a `/provider` command. Sandbox hints say what to do in each case.
- The engine no longer accepts browser requests from `*.merakcode.ai`.
- Tool descriptions match what the tools actually do; the unused `ls` tool is removed.
- Desktop installers' `THIRD_PARTY_LICENSES.txt` also lists packages bundled into the main process.
- README, SECURITY.md, the SDK guide, CONTRIBUTING.md, and AGENTS.md match the code again: fixed a permission rule example that never applied, SDK examples that did not run as written, and clearer notes on what sandbox and permission checks can and cannot stop.

### Fixed

- The composer and side-panel navigation stay usable when the window shrinks. Delayed history no longer replaces finished member replies or restores deleted messages.
- On Linux and macOS, external-agent cleanup finds system process tools even when PATH has no system commands.
- The first file search waits for the initial index, so an existing file can be mentioned without typing again.
- Refreshing dropdown options no longer resaves an unchanged setting and reloads config mid-conversation.
- Concurrent project config loads keep their own warnings instead of losing or mixing them.
- Git index actions finish refreshing the file list before the next action, and keep background refreshes, so Stage all includes files just unstaged or created during the operation.
- Worktree conversations keep the right branch name and merge target when the same project is opened via another directory spelling.
- Open branch menus follow refreshes done by another picker, and still block switches when there are unsaved edits.
- Review comments omit an unselected line when a native selection ends at that line's start. Feedback moved during submit stays pending after the earlier request succeeds.
- After the engine restarts or is killed mid-turn, unfinished native tool calls no longer spin forever: opening the conversation (or disposing the instance) marks them interrupted, and the next message starts a new turn instead of continuing under the stuck one.
- External chats with products such as Claude Code and Codex get a title from the first message via the configured small model, instead of keeping `New session - …`.
- Late product probes and session updates no longer undo newer settings or takeover decisions. Recreated products need a fresh takeover; takeover keeps observed steps from failed or cancelled turns that had no text. Final snapshots drop obsolete fragments; connection settings show the adapter's reported permission owner and keep MRK codes.
- External tasks finish process-tree cleanup before releasing their directory. Final replies calibrate streamed text; client clock skew no longer drops history; admitted turns update recent activity; group adapter errors keep localized MRK codes.
- A late takeover response cannot block decisions for a new disable cycle or another conversation. Disabled group members show offline even while queued, with localized errors. Products without text streaming note that output arrives on completion.
- External chat history rejects reused message and part IDs. Command connections keep full recovery IDs across split output and failed runs. External chat errors follow the selected language and use stable MRK codes.
- Command connections with a session ID pattern and no resume args replay history on later turns. Editing or refreshing agent connections discards stale verification reports.
- Setting up or bypassing sandbox enforcement no longer lets a file-changing command through when read-only mode or an explicit deny still blocks it. Resetting the sandbox while it is off still reports that it can be set up again.
- Composer-bar hints open just above their controls: context usage, model, reasoning, sandbox, and permission mode.
- Typing `/skill-name` after a space — including mid-sentence — loads that skill. Skills are read from Claude's `.claude/skills` and `.agents/skills`, and from `.merakcode/skill` and `.merakcode/skills`. Denied skills are not loaded.
- Maximizing review from a new conversation fills the window with the review.
- A subagent's question goes to the parent conversation's SDK `onQuestion`; without one it is dismissed, instead of leaving the turn waiting.
- A member adapter request with nothing to check (empty `paths` or empty `command`) is refused, not allowed.
- The Linux sandbox helper only runs the request the engine wrote for it.

### 变更

- 审阅只显示本轮和整个对话里待审的智能体改动，支持选中代码行评论、草稿恢复，以及列表为空时撤销审阅。Git 管理独立提供暂存、取消暂存和提交；审阅决定不改 Git 暂存区与提交历史，Git 文件只跳转到仍待审的改动。移除 Git 页的丢弃、分支比对审阅和快捷命令入口，自由命令改由终端承接。
- SDK 不兼容变更：审阅范围只保留 `session` / `turn`，决定必须带明确的文件版本；Git 文件管理改为 `vcs.changes.get`、`vcs.changes.stage`、`vcs.changes.unstage`，并校验 checkout 与文件版本。

- 每轮改动文件默认收起；点击卡片展开全部，超过六行时在列表内滚动。收起时仍可直接审阅。
- 新建对话可选全局配置的智能体产品，使用各产品独立模型和流式正文。`智能体接入` 与 `协作群` 角色模板设置分开，提供七个只读内置角色和自定义模板。关闭产品后，单聊锁定输入，需用户明确同意后才由 MerakCode 接管；群成员仅显示离线，其他成员继续工作。
- 主页可切换本地分支，或选定起点后准备新工作树。工作分支操作移到独立的 Git 管理页，与对话审阅分开。未保存的编辑缓冲和审阅评论在切换视图后仍保留，并阻止切换工作分支。
- SDK 新增带 checkout 身份的分支操作和 HEAD 事件。审阅决定与撤销须携带当前审阅的 `expectedCheckout`，避免过期操作改到另一个 checkout。
- 对话栏沙箱以盾牌图标加开/关显示。悬停上下文用量、模型、思考档位、沙箱或权限模式时，说明该控件在配置什么，当前值仍写在按钮上。可在对话内初始化沙箱（Windows 需一次管理员确认）、开启或关闭。仅因沙箱未就绪而等待的命令，会在沙箱打开或关闭后继续。已初始化的沙箱会在引擎启动时预热。
- 主页模型菜单改为官方供应商在前、配置的模型在后；底部 `添加模型` 打开设置里的服务商列表。
- 包在 `env`、`sudo`、`nice`、`timeout`、`xargs` 等命令里的命令、`sh -c` / `eval` 里的命令，以及写在子命令前的选项（`git -C 目录 push`、`pnpm --filter x publish`），都按实际执行的那条判断。只读命令带上会写文件或执行其他程序的参数（`sort -o`、`rg --pre`、`git diff --output=`）时，按会改文件的命令处理。
- 参数指向密钥文件时，相对路径（`cat .env`）也会先询问；MerakCode 存放模型密钥的 `~/.merakcode/data/auth.json` 也算密钥。
- 修改 MerakCode 自身配置（`merakcode.json`、`merakcode.jsonc`）在自动模式下也要先问，对应新权限键 `config_write`；沙箱同样禁止改项目配置文件，与 `.git/hooks`、`.git/config` 一致。
- 错误提示改为指向 `merak provider login` 和 `设置 → 模型与供应商`，不再提不存在的 `/provider`；沙箱相关提示写清各情况该怎么处理。
- 引擎不再接受来自 `*.merakcode.ai` 的浏览器请求。
- 给模型看的工具说明与实际行为对齐；删除从未启用过的 `ls` 工具。
- 桌面安装包里的 `THIRD_PARTY_LICENSES.txt` 也列出打进主进程的依赖。
- README、SECURITY.md、SDK 手册、CONTRIBUTING.md、AGENTS.md 按代码重新核对：修正未生效的权限规则示例、无法照着跑的 SDK 示例，并写清沙箱与权限审批能挡什么、挡不住什么。

### 修复

- 窗口缩小时，消息输入框与右侧面板导航仍可用；延迟返回的对话历史不再覆盖已完成的成员回复，也不会恢复已删除的消息。
- Linux 和 macOS 上，即使 PATH 不含系统命令，外部智能体清理仍能找到系统进程工具。
- 首次文件搜索会等初始索引完成，引用已有文件时不必再输入一次才看到补全。
- 下拉选项刷新时不再重复保存未改动的设置，避免配置重载打断刚开始的对话。
- 多个项目并行加载配置时，告警按各自项目收集，不再丢失或串到其他项目。
- Git 索引操作在文件列表刷新完成后再接受下一次操作，并保留期间的后台刷新；`暂存全部` 也会包含刚取消暂存或操作期间新建的文件。
- 同一项目用不同目录写法打开时，工作区对话仍显示正确的分支名和合并目标。
- 已打开的分支菜单会同步其他选择器完成的刷新，并继续阻止带有未保存编辑的分支切换。
- 原生选区结束在下一行行首时，审阅评论不再包含未选中的行；发送期间重新定位的反馈，在旧请求成功后仍保留待发送。
- 引擎中途重启或被强杀后，未完成的本地工具调用不再一直转圈：打开对话（或销毁实例）时标为重启中断，下一条消息开新一轮，不会挂在卡住的那一轮下。
- 使用 Claude Code、Codex 等产品的单聊，会在第一条消息后用配置的 small model 生成标题，不再保留默认的 `New session - …`。
- 延迟的产品探测和会话更新不会覆盖新设置或接管决定；删除后重建的产品需重新确认接管。接管保留无正文的失败或取消任务中已记录的步骤；最终正文快照清除过时片段；接入设置按适配器报告显示权限归属，并保留 MRK 错误码。
- 外部任务清理完进程树后才释放目录；完整回复会校准流式正文；客户端时钟偏差不再遗漏对话历史；成功接收的轮次会更新最近活动时间；群适配器错误保留本地化提示与 MRK 编号。
- 过期接管响应不会挡住新禁用周期或其他对话中的确认。停用群成员在排队阶段也统一显示离线，错误提示支持中英；不支持正文流式的产品会标明完成后输出。
- 外部对话历史拒绝复用已有消息和正文片段 ID；命令接入在分块输出和执行失败时仍保存完整恢复 ID。外部对话错误按所选语言显示，并使用稳定的 MRK 错误码。
- 仅配置会话 ID 识别、未配置续接参数的命令接入，会在后续轮次回放对话历史。编辑或刷新智能体接入时丢弃过期验证结果。
- 初始化或关闭沙箱时，只读模式或明确拒绝仍挡住的改文件命令不会被放行。沙箱关闭时重置，仍提示还可以再初始化。
- 对话栏悬停说明出现在控件正上方，涵盖上下文用量、模型、思考档位、沙箱和权限模式。
- 在空格后输入 `/技能名`（包括写在句子中间）会加载该技能。技能从 Claude 的 `.claude/skills`、`.agents/skills`，以及 `.merakcode/skill`、`.merakcode/skills` 读取。被拒绝使用的技能不会加载。
- 在新对话里最大化审阅时，窗口显示全屏审阅。
- 子智能体的提问交给发起它的会话的 SDK `onQuestion`；没有 `onQuestion` 时直接跳过，不再卡住这一轮。
- 成员适配器发来无可检查内容的审批请求（`paths` 为空或 `command` 为空）改为拒绝，不再放行。
- Linux 沙箱辅助进程只执行引擎为它写好的那条请求。

## [0.1.2] - 2026-10-25

### Changed

- Connected providers load their model list from the provider with the saved key, instead of a bundled models.dev snapshot. A failed refresh is shown once (MRK-2001, MRK-2004, or MRK-2010).
- The homepage model menu has two sections: Configured, then Official. An official provider starts with one current model per named line: Alibaba starts on unsuffixed `qwen-plus` and `qwen-max`; OpenRouter starts with none on. Models that start off can be added from the bottom of the menu; Settings has a model list per provider.
- Prices can be USD or CNY, can step by prompt size, and can use a separate thinking price. Stats and the composer show a separate total per currency (USD and CNY are never added together). ACP reports a cost only when every reply is priced in the same currency.
- Reasoning level starts from the model's catalog default, then remembers the last level sent with that model. Relay-discovered models keep the context, output, and modalities the catalog reported.
- Member adapters are written in TypeScript: Node runs `adapter.mts` as-is; the single-file adapter library ships type declarations (`merakcode-adapter.d.mts`); the `adapter-generator` skill writes TypeScript from the built-in adapters. Existing JavaScript adapters still work. The SDK guide walks through writing one.
- SDK: global stats `totalCost` and `costPerDay` are keyed by currency; `Model.cost` is optional and carries `currency`; relay-discovered models use `input` and `outputModalities` instead of `image`.

### Fixed

- The new-group dialog can clear a copied group and return to a blank draft.

### 变更

- 已连接的服务商用保存的密钥向服务商拉取模型列表，不再使用打包的 models.dev 快照。刷新失败时提示一次（MRK-2001、MRK-2004 或 MRK-2010）。
- 主页模型菜单分成 `配置的模型` 和 `官方供应商` 两段。官方供应商默认只打开每个指定系列里当前的一个模型：阿里云百炼只开不带后缀的 `qwen-plus` 和 `qwen-max`，OpenRouter 默认全关。未打开的模型可在菜单底部 `添加模型`；设置里每个服务商有一份 `模型配置`。
- 价格可以是美元或人民币，可按提示词长度分档，思考另有价格。统计和输入框按币种分别合计（美元与人民币不相加）；ACP 仅在每条回复都有价格且币种相同时才上报费用。
- 推理档位先用模型目录默认值，再记住该模型上次发送的档位。中转发现的模型保留目录实际返回的上下文、输出长度和模态。
- 成员适配器改用 TypeScript：Node 直接运行 `adapter.mts`；单文件适配器开发库带类型声明（`merakcode-adapter.d.mts`）；技能 `adapter-generator` 照着内置适配器写 TypeScript。已有的 JavaScript 适配器仍可用。SDK 手册逐步说明怎么写。
- SDK：全局统计 `totalCost`、`costPerDay` 按币种分组；`Model.cost` 改为可选并带 `currency`；中转站发现的模型用 `input` 和 `outputModalities` 代替 `image`。

### 修复

- 新建协作群时，复制已有群之后可以清空，回到空白草稿。

## [0.1.1] - 2026-10-24

### Added

- Collaboration groups: MerakCode leads; Claude Code, Codex, OpenCode and other CLIs join as members. Mention members with `@`, see them in a member column and a group todo. Create a group with `Ctrl+G` (`⌘G` on macOS), or copy an existing one.
- Members follow the group's permission mode: Claude Code, Codex and OpenCode actions go through MerakCode rules and the approval bar; their questions open MerakCode's question box, both naming the member.
- Settings › Collaboration: turn products on or off, see versions, paths and who decides permissions, add and edit custom ones, restore defaults, check again. A CLI older than recommended shows how to upgrade.
- Member adapters: `@merakcode/sdk/adapter` lets any AI coding CLI join a group. The built-in skill `adapter-generator` writes and registers an adapter from MerakCode's own Claude Code, Codex and OpenCode adapters.

### Changed

- Context that changes every step (git status, group state) goes at the end of the conversation, so more of each prompt can be cached.
- Desktop development no longer restarts the engine when its code changes; use Help › Restart Local Service.
- When automatic updates are off, Check for updates says so.

### Removed

- The built-in skill `auto-cli`.

### Fixed

- The sidebar no longer shows a conversation as running while memory is extracted in the background after a reply.
- A conversation no longer stays running after the local service restarts.
- Without GitHub access, files are found right away (in `@` references and glob) instead of waiting for the ripgrep download to time out.
- Opened thinking and steps no longer close as a reply continues.

### 新增

- 协作群：MerakCode 当群主，Claude Code、Codex、OpenCode 和其他 CLI 当成员。可用 `@` 点名成员，右侧有成员栏和群待办；用 `Ctrl+G`（macOS 为 `⌘G`）新建，也可从已有群复制。
- 成员遵守群的权限模式：Claude Code、Codex、OpenCode 要做的操作按 MerakCode 规则判断，需要时出现在审批栏；它们的提问弹出 MerakCode 提问框，都会标明成员。
- 设置 › 协作群：开关产品，查看版本、路径和权限归属，添加和编辑自定义产品，恢复默认，重新检测。CLI 版本低于建议时会提示如何升级。
- 成员适配器：`@merakcode/sdk/adapter` 让任何 AI 编程 CLI 都能加入协作群；内置技能 `adapter-generator`（适配器生成助手）以 MerakCode 自带的 Claude Code、Codex、OpenCode 适配器为示例，写好并注册适配器。

### 变更

- 每一步都会变的上下文（git 状态、群状态）放到对话末尾，提示词可缓存的部分更多。
- 桌面端开发时，引擎代码改完不再自动重启，改用 `帮助 › 重启本地服务`。
- 关闭自动更新后，`检查更新` 会提示已关闭。

### 移除

- 内置技能 `auto-cli`。

### 修复

- 回复结束后后台提取记忆时，侧边栏不再一直显示运行中。
- 本地服务重启后，对话不再卡在运行中。
- 连不上 GitHub 时，`@` 引用和 glob 立刻能找到文件，不再等 ripgrep 下载超时。
- 展开的思考和步骤不会在回复继续输出时收起。

## [0.1.0] - 2026-10-22

The first public release.

### Added

- Desktop app for Windows, macOS and Linux, with the engine built in. Checks for updates and installs them where the platform allows (unsigned macOS builds and the Linux deb point to the download page instead).
- `merak` CLI (no UI): `merak run` for one-off tasks, `merak serve` to run only the engine, `merak acp` for editors.
- TypeScript SDK `@merakcode/sdk`: start or connect to an engine, run sessions, handle approvals and questions, and give the model your own tools.
- Eight built-in model providers (OpenAI, Anthropic, Google, Alibaba Cloud Model Studio, Zhipu AI, DeepSeek, Moonshot AI, OpenRouter), plus any OpenAI-compatible API configured with an API key.
- Three permission modes (read-only, ask, auto) with per-project rules.
- An OS sandbox for agent commands on Windows (separate account, NTFS permissions, firewall), Linux (Landlock) and macOS (Seatbelt), managed with `merak sandbox status|setup|reset`.
- Error codes (`MRK-xxxx`) on every user-facing error, listed in `docs/errors.md`.
- `merak doctor`, `merak logs` and `merak bug-report` for troubleshooting.
- `merak upgrade` (alias `update`) for script and npm installs.
- Chinese and English UI.

首个公开发布的版本。

### 新增

- Windows、macOS 和 Linux 桌面客户端，自带引擎。会检查更新，平台允许时直接安装（未签名的 macOS 版和 Linux deb 包改为提示去发布页下载）。
- 无界面的 `merak` 命令行：`merak run` 跑一次性任务，`merak serve` 只启动引擎，`merak acp` 接到编辑器里用。
- TypeScript SDK `@merakcode/sdk`：启动或连接引擎、运行会话、处理审批和提问，还可把自己的工具交给模型调用。
- 内置八家模型服务商（OpenAI、Anthropic、Google、阿里云百炼、智谱、DeepSeek、月之暗面、OpenRouter），其他服务可用 API 密钥接入 OpenAI 兼容接口。
- 三种权限模式（只读、询问、自动），可按项目设置规则。
- 智能体执行的命令放入系统沙箱：Windows（独立账户、NTFS 权限、防火墙）、Linux（Landlock）和 macOS（Seatbelt），用 `merak sandbox status|setup|reset` 管理。
- 所有面向用户的错误都带错误码（`MRK-xxxx`），清单见 `docs/errors.md`。
- 排查问题用的 `merak doctor`、`merak logs` 和 `merak bug-report`。
- `merak upgrade`（别名 `update`），用于脚本安装和 npm 安装的升级。
- 中文和英文界面。
