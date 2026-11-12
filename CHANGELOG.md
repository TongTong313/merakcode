# Changelog

All notable changes to MerakCode are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

MerakCode 所有值得注意的变化都记在这里。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- Read and edit the `lsp` and `formatter` sections of a v0.3 configuration file with `config.get` and `config.set`, and override them entry by entry in a project. The engine does not run language servers or formatters, and `config.get` hides environment values.
- Route routine Worker approvals to the task Leader, preserve escalation deadlines, and require per-server trust for workspace MCP configuration. Mount group tools in supported external products.

- Run Claude Code, Codex and Pi as Leaders; preserve queued events across rate limits; patrol stalled tasks; run workspace setup and reuse idle worktrees.

- Configure permission defaults and turn limits in desktop, show context and usage totals, and initialize Windows member isolation from settings.

- Connect development cloud accounts, forward cloud groups through the local engine, and register remote Workers by address and token. Add cloud account settings, cloud group creation and remote member selection.

- Enforce S25 member sandboxes on Windows, Linux and macOS, restore protected files, isolate product state, report partial enforcement and offer full takeover through the SDK and desktop. Add shared isolation tests and Windows account cleanup in CI.

- Expose sandbox status and route external member startup and network approvals through the engine.

- Watch external Git and file changes, configure event rules and group initiative, emit external events from the command line, and refresh desktop Git and review views automatically.

- Review task reports and baseline changes from the inbox, return combined comments for rework, approve delivery or return a goal to planning, inspect integration conflicts, and download published artifacts.

- Create and assign tasks from group boards, read structured worker reports and live execution history, answer inbox requests, and keep informational read status and tray badges across reloads.

- Create local collaboration groups from desktop, manage and test member profiles, send group and task messages, combine progress, restore member activity, and track unread notices.

- Fold task boards and human inboxes from group events, enforce goal phases and review checkpoints, route approvals by role, and hand tasks between Leader sessions without blocking other goals.

- Run Codex, OpenCode, Pi, ACP agents and commands as workers, forward supported approvals, preserve rework context, and expose their verified capabilities.

- Run document tasks in isolated folders, publish declared artifacts, serialize inplace work with project leases, and run research tasks with read-only tools.

- Support group interruptions and receipts, direct worker messages, task-thread questions, human review and rework, priority queues, and checks before integration.

- Isolate group worker changes in Git worktrees, queue fast-forward integrations, create conflict-resolution tasks for the original member, and reject overlapping collaborator scopes.

- Coordinate local groups with Leader threads, queued worker assignments, bounded reports, progress events, persisted group tables, and SDK group and task requests.

- Run Claude Code workers through the shared event and report contract, discover local products, and expose `merak debug worker` with streamed events and bounded reports.

- Show the engine version in desktop settings and export the engine diagnostic archive through a native save dialog.

- Run desktop terminal tabs through the Go engine with output replay, ordered input, process cleanup, and restored desktop checks and CI coverage.

- Review working files against each conversation's starting commit, send inline feedback, open read-only code, and inspect or switch Git branches through the Go engine.

- Add model discovery without saving drafts, secret-preserving provider configuration, owner-bound questions, replayable model changes, and SDK conversation folding for the desktop migration.
- Start or reconnect to the Go engine from the desktop app, host SQLite storage, keep work running in the tray, and package the native engine without a separate Node runtime.
- Export redacted diagnostic ZIP archives from the command line or SDK, and rotate correlated engine logs with bounded file sizes.
- Run read-only child agents in the background with `spawn` and `wait_child`, deliver reports once through session events, and cancel children with their parent.
- Generate Go and TypeScript error catalogs from one JSON source, and render command-line messages in Chinese or English using system settings or `--lang`.
- Recall project notes in new conversations and file reads, add `remember` and `recall`, and extract notes during idle time after scanning for recognizable credentials.
- Add Anthropic Messages, Gemini and OpenRouter configurations, image and native PDF input, preserved thinking signatures and cache usage, and model catalog refresh with user overrides.
- Recover interrupted tool calls, preserve partial replies and usage, buffer events during storage-host outages, and stop the engine in order with `merak stop`.
- Estimate and calibrate context usage, reserve output capacity, rebuild old turns into replayable summaries, and report request budgets without editing recent history.
- Persist sessions in a shared SQLite format, restore snapshots and event history after restart, and support a single SDK storage host over the protocol.
- Add an authenticated local Go protocol server, generated SDK types and validators, streamed session requests, cancellation, bounded subscriptions and automatic engine startup from the command line.
- Add compatible-provider reasoning, thinking selection, model limits, estimated costs and transient retries; expose the built-in catalog with `merak models`.
- Load deferred Go tools on demand while keeping provider tool definitions fixed and sharing direct-call input validation.
- Add Go search tools, parallel reads, stale-edit protection, background commands, bounded output with retrievable blob references, and full or read-only tool pools.
- Run approved bash commands with timeout and exit status, and include workspace AGENTS.md instructions in Go conversations.
- Stream OpenAI-compatible replies with `merak run`, using `OPENAI_MODEL`, `OPENAI_BASE_URL`, and `OPENAI_API_KEY`; keep text increments out of stored event sequences.
- Require terminal approval before Go conversations write or edit files, and return denied operations to the model.
- Let Go conversations read workspace files, return tool errors to the model, and replay paired tool events.
- Add scripted Go debug conversations with ordered events, replayable messages, and structured command diagnostics.
- Add the Go `merak --version` command, builds for six platforms, and Go checks in the workspace and CI.

### Changed

- Leave the `plugin` and `plugin_options` keys of a v0.3 configuration file in place but report them as unused: v1.0.0 has no plugin module.
- Rename permission choices to Ask every time, Ask only for risky actions and Full takeover, with explicit safety descriptions.

- Replace conversation modes with Ask every time (`ask`, the default), Ask only for risky actions (`autoApprove`) and Full takeover (`fullTakeover`). The first two levels require per-operation confirmation when required isolation is unavailable. Full takeover chooses isolation or the current account before launch and never replays a failed command automatically. Dedicated official-plan tools preserve human edits, fixed execution snapshots and explicit start sources. Products use the SDK and external adapters use protocol 3.

- After a turn finishes, reasoning and tool steps collapse into a single timing line, keeping the final reply and that turn's changed files. Copy takes only the final reply while folded, and the whole turn once expanded.

- Run the engine as a background process of its own: closing the desktop app no longer stops it, tasks keep going, and the next start of the app (or of `merak`) joins the same engine. "Stop Background Engine and Quit" in the tray and the File menu, or `merak stop`, ends it; `merak status` shows whether it runs, its process id, port, folder and number of clients. The desktop app no longer hosts the storage of the engine, so `merak serve --store remote` and the native SQLite module are gone.

- Decide who a request acts as from the connection, not from the request: no call names a person any more, and `hello` tells the client which person it is. Provider keys and the environment values of external agents are kept in the credential vault instead of the configuration file and the database; keys found in the configuration file or in `auth.json` of earlier versions are moved there. `merak provider list|login|logout` and `merak provider relay add|remove` manage them.

- Fetch the model list of every configured provider in the background, so a provider with a key shows its full list without a manual refresh. The lists, with context sizes, prices and thinking levels from the public catalog and a fallback table, are kept across restarts and work offline; models that cannot chat are left out, deprecated ones are marked, and a failed refresh is reported once. `merak models refresh [provider]` refreshes at once, `merak serve --refresh-models` is gone.

- Keep every MerakCode file under one folder, `~/.merakcode` (`MERAKCODE_HOME` moves it), and read the v0.3 configuration format unchanged. A change in settings now edits only that setting, so the comments and the rest of the file stay as written, and an address taken from an environment variable is no longer copied into the file. `merak serve` takes its port and host from the `server` setting.

- Replace member profiles with agents (`merak agent`, `agent.*` methods): a group member is added by the id of an existing agent, never by an inline definition. A group has exactly one Leader agent and one Leader thread, changed in one step by the owner, and every group and conversation needs an existing workspace folder. Tasks no longer have a Leader of their own: the Leader of the group runs all of its goals. Data written by an earlier development build is refused with MRK-1008 instead of being read wrongly.

- Make tasks belong to groups: a task can be created on its own (`merak task create --project`) and starts once a new group is made for it (`merak group create --task`) or an existing group takes it (`merak group bind`); a group can own many tasks and a task belongs to at most one group. A group moves to the workspace of the task it takes only when no work is running (MRK-6014). Add `task.list`, `group.list` and batch `task.archive`: finished tasks are archived after `board.autoArchiveDays` days (default 3, 0 turns it off). Remove the per-minute turn limits of Leaders.

- Put the human's word first: a message to a Worker, or a task given to it directly, now stops its current step and also wakes the Leader to update its plan; Workers that cannot take messages mid-run restart the same claim in the same workspace. Every delivery is receipted (`input.delivered`, `input.consumed`), Leaders and Workers get a `todo_write` list that clients can fold into the Leader's breakdown, and the Leader has a full system prompt.

- Let Workers take work on their own: `claim_task` (built-in and external Workers through MCP) claims an open task of the group for the Worker itself, a Worker that has just reported is shown the group's unclaimed tasks, and idle built-in Workers are invited once per task after the Leader's turn.

- Bring the v0.3 session features back: `session.update`, `session.revert` and `session.unrevert` (files are put back from a shadow Git snapshot, `snapshot` setting), `session.compact` and automatic compaction (`compaction.auto`), `session.delete`, `session.search`, session export and import, and the daily deletion of idle conversations (`storage.retention_days`); `merak session` has the same commands.

- Bring the v0.3 workspace features back: repository commit and push, git worktrees, `file.status`, `file.find`, `file.identity` and spelling-tolerant directory lookup, a `code` workspace for the files of a folder, and read-only file agents (`agent.list` takes a directory).

- Support remote MCP servers over Streamable HTTP with OAuth (PKCE) login and logout, MCP prompts as slash commands, and `mcp.status`; MCP settings are edited in place in the v0.3 `mcp` section.

- Make memory, rules, skills and slash commands configurable as in v0.3: `memory.auto_extract`, `memory.auto_recall`, `memory.model`, personal and project rules (`rules.*`, `rules.read`, `rules.change`), skills from folders, URLs and Git (`skill.list`, `skill.discover`, `skill.install`, `skill.uninstall`; the `skill` tool and recommendations; built-in `docx`, `excel` and `pdf` skills) and `command` entries with `$ARGUMENTS` (`command.list`, `session.command`). Configuration problems that do not stop the program come back as `warnings` of `config.get`.

- Planning is no longer a mode: the `write_plan` tool saves a plan to the session, a message sent with `plan: true` asks for one, and `plan.get`, `plan.save`, `plan.execute` and `plan.stop` read and run it.

- Bring the v0.3 tools back: `multi_edit`, `docx_read`, `excel_read`, `excel_write`, `web_fetch`, `web_search` and `code_search`; the `tools` section of the configuration switches tools off by name or pattern.

- Let a client offer tools to the models: `tool.register` lists a tool as `client__<name>`, the engine sends `tool.call` to that connection and the client answers with `tool.result`; the tool is asked about by its effect and disappears when the connection closes. The SDK has `client.tool.register`.

- Read the v0.3 `agent` and `default_agent` keys: `build` overrides the built-in Worker's model, prompt and tools, `general` and `explore` are agents a child can be started as, `title`, `summary`, `compaction` and `memory-extractor` choose the model of those jobs, `plan` is ignored with a warning, and every other name becomes an agent that is listed, can be started as a child and can be the default for new conversations. `small_model` and `memory.model` now take effect too.

- Run tasks on a schedule: the model can create, list and delete scheduled tasks with `schedule_create`, `schedule_list` and `schedule_delete` (five-field cron in the machine's time zone, a built-in `loop` skill explains how). The background engine checks every minute and starts a new conversation titled "定时：…" in the task's folder, then puts a notice in the inbox; runs that fell while the engine was stopped are not made up, and one notice says how many were missed. `schedule.list` and `schedule.delete` and `merak schedule list|delete` manage them.

### Fixed

- Find Git Bash on Windows when `git` comes from a `mingw64\bin` folder, as it does in a Git Bash terminal.
- Wait long enough for slow model refreshes, connection tests and cloud calls instead of failing after 10 seconds. Report the real cause of group and agent failures with their own error codes, and run the built-in Leader and Workers on the default model when they have none.

- Keep group usage folding in the SDK and preserve the newest context budget when history arrives out of order.

- Expose cloud member discovery through the SDK and route the MCP command through the Go SDK.
- Preserve the previous cloud connection when saving credentials fails, and avoid rewriting unchanged system credential markers.

- Preserve terminal input while its display loads or its connection opens, including when hidden and reopened. Keep global shortcuts available while the terminal has focus.

- Preserve instructions received while a Worker prepares its workspace and material packet, and avoid replaying instructions already included in that packet.

- Build desktop tests in a temporary directory so they cannot delete the running app's entry file.

- Restore the v0.3.1 conversation width, project grouping, group shortcut and collapsible member sidebar. Adapt task, inbox, budget, remote member and review screens to small windows; contain long text and keep question controls reachable with the terminal open.

- Enforce task and member budgets across rework and remote claims. Apply owner-approved grants, extend active deadlines, and require explicit consent to continue a budget-stopped chat. Accept trusted editor stdio MCP servers in ACP sessions and redact credentials split across streamed fragments.

- Enforce task and profile budgets across rework sessions, retain paused Leader inputs after restart, hand over the default Leader, and extract closed-task memory for external members.
- Restrict private member assignments to their owner, preserve shared-document access through the SDK, redact imported event secrets and exclude file bodies from cloud uploads.
- Expose group, task, member, JSON streaming and ACP commands through the SDK; run desktop main-process and engine lifecycle checks in CI.

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

### 新增

- 可以用 `config.get` 和 `config.set` 读取和修改 v0.3 配置文件里的 `lsp` 和 `formatter` 两段，项目配置可以按条目覆盖。引擎不运行语言服务器和格式化工具，`config.get` 不返回环境变量的值。
- 常规 Worker 审批先交给任务线程 Leader。升级后保留原截止时间。工作区 MCP 按服务器确认。外部产品可使用群工具。

- Claude Code、Codex 和 Pi 可担任 Leader。限流期间保留待处理事件。引擎巡查停滞任务、运行工作区安装命令并复用空闲工作树。

- 桌面端可设置默认权限和回合上限。界面显示上下文与用量统计。设置页可初始化 Windows 成员隔离。

- 引擎可登录开发云端，并转发云端群请求。用户可用地址和令牌添加远端 Worker。桌面端增加云端账号、云端建群和远端成员表单。

- 完成 S25 成员沙箱，覆盖 Windows、Linux 和 macOS。还原保护文件，隔离产品状态，并报告部分强制。SDK 和桌面支持全面接管。CI 增加共用隔离测试和 Windows 账户清理。

- 提供沙箱状态查询。引擎处理外部成员的启动审批和联网审批。

- 监视外部 Git 和文件变化，配置事件规则与群主动程度，从命令行发送外部事件，并自动刷新桌面 Git 和审核面板。

- 从收件箱审核任务报告和起点差异，合并评论后返工，通过交付或打回规划，查看集成冲突，并下载已发布产物。

- 在群任务看板创建和指派任务，查看成员报告与实时执行过程，在收件箱处理请求，并在刷新后保留信息已读状态和托盘角标。

- 桌面端支持创建本地协作群、管理和测试成员档案、发送群聊与任务消息、合并进度、恢复成员状态，并显示未读通知数。

- 从群事件生成任务看板和收件箱，检查目标阶段与审核条件，按角色发送审批，并在更换 Leader 时传递交接摘要，其他目标继续运行。

- 支持 Codex、OpenCode、Pi、ACP 智能体和命令作为工作者。引擎转发支持的审批，保留返工上下文，并返回已实现的能力。

- 文档任务使用独立目录并发布声明的产物；原地任务通过项目租约依次运行；调研任务只使用只读工具。

- 支持群发言打断和回执、成员直达消息、任务线程问答、人工审核与返工、优先级队列，以及合并前检查。

- 群内工作者使用独立 Git 工作区；引擎依次快进合并，冲突时给原成员创建集成任务，并拒绝范围重叠的协作认领。

- 本地群支持 Leader 线程、工作者认领队列、定长报告、进度事件和群状态存储；SDK 可建群、加成员及建任务。

- Claude Code 工作者使用统一的事件与报告接口；支持本机产品探测及 `merak debug worker`，并限制报告长度。

- 桌面设置页显示引擎版本，并通过系统保存对话框导出引擎诊断包。

- 桌面终端改用 Go 引擎，支持输出回放、输入保序和进程清理，并恢复桌面端检查及 CI 测试。

- 桌面端按对话起始提交审核文件改动，支持发送行内评论、只读代码查看、查看 Git 状态和切换已有分支。

- 新增临时模型发现、保留密钥的服务商配置、限定回答连接的提问、可重放的模型切换及桌面端会话状态折叠。
- 桌面端启动或连接 Go 引擎，担任 SQLite 存储宿主，关闭窗口后继续工作，并在安装包中携带原生引擎。
- 通过命令行或 SDK 导出脱敏诊断 ZIP，并按文件上限轮转带事件关联字段的引擎日志。
- 新增 `spawn`、`wait_child` 后台只读子智能体；会话事件只插入一次报告，取消父会话会同时停止子智能体。
- Go 和 TypeScript 从同一份 JSON 生成错误码；命令行按系统设置或 `--lang` 显示中文、英文文案。
- 新会话和文件读取可召回项目笔记；新增 `remember`、`recall` 工具，并在空闲时提取笔记，写入前扫描可识别的密钥。
- 新增 Anthropic Messages、Gemini 和 OpenRouter 配置；支持图片与原生 PDF 输入、思考签名和缓存用量保留，以及模型目录刷新与用户覆盖。
- 引擎恢复未完成的工具调用，保留部分回复和用量，缓冲宿主离线期间的事件，并支持 `merak stop` 有序退出。
- 新增上下文用量估算与校准、输出容量预留、可重放的旧回合摘要和逐次请求预算事件。
- 新增共享 SQLite 存储格式、会话快照恢复、重启后历史查询和 SDK 远程存储宿主。
- 新增带令牌校验的本机 Go 协议服务、自动生成的 SDK 类型与校验器、会话流式请求、取消、有界订阅和命令行自动启动引擎。
- Go 对话新增兼容服务商思考、档位选择、模型限制、预估费用和临时失败重试；`merak models` 可查询内置目录。
- Go 对话支持按需加载工具，保持服务商工具定义固定，并复用直接调用时的输入校验。
- Go 对话新增搜索工具、并行读取、文件变更检查、后台命令、可按引用读取的输出截断，以及完整和只读工具池。
- Go 对话支持审批后运行 bash 命令，返回超时和退出状态，并读取工作目录中的 AGENTS.md 规则。
- `merak run` 根据 `OPENAI_MODEL`、`OPENAI_BASE_URL` 和 `OPENAI_API_KEY` 流式输出 OpenAI 兼容模型的回答；消息增量不占用入库事件序号。
- Go 对话写入或编辑文件前先请求终端审批，拒绝后会把结果交回模型。
- Go 对话支持读取工作目录中的文件、向模型返回工具错误和重放成对的工具事件。
- Go 调试命令支持剧本对话、有序事件、消息重放和结构化命令日志。
- 新增 Go 版 `merak --version` 命令。构建支持六个平台。工作区和 CI 增加 Go 检查。

### 变更

- v0.3 配置文件里的 `plugin` 和 `plugin_options` 保留在文件里，但会提示不再使用：v1.0.0 没有插件模块。
- 权限选项改为“每次询问”“仅询问危险行为”和“全面接管”，并显示对应安全性描述。

- 权限级别改为每次询问（`ask`，默认）、仅询问危险行为（`autoApprove`）和全面接管（`fullTakeover`）。本次操作缺少所需隔离时，前两档逐次询问。全面接管在启动前选择沙箱或当前账户，不自动重跑失败命令。专用官方计划工具保留人工修改、固定执行快照和启动来源。产品通过 SDK 调用，外部适配器使用协议 3。

- 一轮对话结束后，思考和工具步骤收成一行用时，最终回复和本轮改动文件仍保留。收起时复制只取最终回复，展开后复制整轮内容。

- 引擎作为独立的后台进程运行：关闭桌面端不再停止它，任务照常推进，下次打开桌面端（或运行 `merak`）会连上同一个引擎。托盘和文件菜单里的“停止后台引擎并退出”，或 `merak stop`，可以停止它；`merak status` 显示它是否在跑、进程 id、端口、根目录和已连接的客户端数。桌面端不再充当引擎的存储宿主，`merak serve --store remote` 和原生 SQLite 模块一并删除。

- 请求以谁的身份执行由连接决定，不再由请求自报：所有调用都不再带人名，`hello` 会告诉客户端它是谁。服务商密钥和外部智能体的环境变量值存进凭据库，不再写进配置文件和数据库；旧版配置文件和 `auth.json` 里已有的密钥会被迁进凭据库。`merak provider list|login|logout` 和 `merak provider relay add|remove` 管理它们。

- 在后台拉取每个已配置服务商的模型列表：配了密钥的服务商打开就能看到完整列表，不用手动刷新。列表连同公开目录和兜底表补全的上下文、价格、思考档位一起保存，重启和离线后仍在；不能对话的模型不显示，已弃用的会标出，刷新失败只提示一次。`merak models refresh [服务商]` 立刻刷新，`merak serve --refresh-models` 已删除。

- 所有文件统一放在 `~/.merakcode` 一个目录下（`MERAKCODE_HOME` 可以挪动它），配置沿用 v0.3 的格式，不用改。在设置里改一项只改这一项，文件里的注释和其他内容保持原样；环境变量里的地址不再被写进配置文件。`merak serve` 的端口和地址取自配置里的 `server`。

- 成员配置（profile）改为智能体（agent）（`merak agent`、`agent.*` 方法）：群成员只能按已有智能体的 id 加入，不再内联定义。一个群有且只有一个 Leader 智能体和一条 Leader 线程，只有群主能一步换掉它；每个群和会话都必须有一个已存在的工作区文件夹。任务不再有自己的 Leader，由群的 Leader 统一推进它所有的目标。早期开发版写下的数据会被 MRK-1008 拒绝，不会被读错。

- 任务归属协作群：任务可以单独创建（`merak task create --project`），再为它新建协作群（`merak group create --task`）或交给已有协作群（`merak group bind`）后才开始推进；一个群可以有多个任务，一个任务最多属于一个群。群接收的任务工作空间不同时，只有群里没有进行中的工作才会搬过去（MRK-6014）。新增 `task.list`、`group.list` 和批量 `task.archive`：结束的任务在 `board.autoArchiveDays` 天后自动归档（默认 3 天，0 为关闭）。删除 Leader 的每分钟回合上限。

- 人的指令优先：在群里 @ 某个成员、或直接给它派任务，会打断它当前的一步，并同时唤醒 Leader 更新计划；不能中途收消息的成员会在同一个工作区里带着人的话重新开始这次认领。每次送达都有回执（`input.delivered`、`input.consumed`），Leader 和 Worker 都有 `todo_write` 待办，客户端可以折叠出 Leader 的任务拆解；Leader 有了完整的系统提示词。

- Worker 主动认领：`claim_task`（内置 Worker 和经 MCP 的外部 Worker）可以认领所在协作群里还没人负责的任务；Worker 交完报告会看到群里待认领的任务；Leader 的回合结束后，空闲的内置 Worker 对每张待认领的卡各收到一次邀约。

- 找回 v0.3 的会话功能：`session.update`、`session.revert`、`session.unrevert`（文件从影子 Git 快照还原，`snapshot` 设置）、`session.compact` 与自动压缩（`compaction.auto`）、`session.delete`、`session.search`、会话导出与导入，以及每天清理闲置会话（`storage.retention_days`）；`merak session` 有同样的命令。

- 找回 v0.3 的工作区功能：仓库提交与推送、git 工作树、`file.status`、`file.find`、`file.identity`，目录名拼写容错，按文件夹读文件的 `code` 工作区，以及只读的文件智能体（`agent.list` 可以带目录）。

- 支持经 Streamable HTTP 的远程 MCP 服务器，含 OAuth（PKCE）登录与退出；MCP 提示词作为斜杠命令；新增 `mcp.status`。MCP 设置按 v0.3 的 `mcp` 段原地修改。

- 记忆、规则、技能和斜杠命令可以像 v0.3 一样配置：`memory.auto_extract`、`memory.auto_recall`、`memory.model`，个人和项目规则（`rules.*`、`rules.read`、`rules.change`），来自文件夹、URL 和 Git 的技能（`skill.list`、`skill.discover`、`skill.install`、`skill.uninstall`，`skill` 工具与推荐，内置 `docx`、`excel`、`pdf` 技能），以及带 `$ARGUMENTS` 的 `command` 配置（`command.list`、`session.command`）。不致命的配置问题以 `config.get` 的 `warnings` 返回。

- 规划不再是独立模式：`write_plan` 工具把计划存进会话，发消息带 `plan: true` 就会请求出计划，`plan.get`、`plan.save`、`plan.execute`、`plan.stop` 读取并执行它。

- 找回 v0.3 的工具：`multi_edit`、`docx_read`、`excel_read`、`excel_write`、`web_fetch`、`web_search`、`code_search`；配置的 `tools` 段可以按名字或通配符关闭工具。

- 客户端可以给模型提供工具：`tool.register` 把工具列为 `client__<name>`，引擎向该连接发 `tool.call`，客户端用 `tool.result` 回答；工具按其影响类别询问权限，连接断开后消失。SDK 有 `client.tool.register`。

- 读取 v0.3 的 `agent` 和 `default_agent`：`build` 覆盖内置 Worker 的模型、提示词和工具，`general`、`explore` 是子智能体可选的角色，`title`、`summary`、`compaction`、`memory-extractor` 指定这几件内部任务用的模型，`plan` 忽略并告警，其他名字成为智能体，出现在智能体库里、可作为子智能体启动、可作为新对话的默认智能体。`small_model` 和 `memory.model` 现在也会生效。

- 定时任务：模型可以用 `schedule_create`、`schedule_list`、`schedule_delete` 创建、查看和删除定时任务（五段 cron，按本机时区，内置 `loop` 技能说明怎么写）。后台引擎每分钟检查一次，到点在任务的工作空间里新开一个标题为“定时：…”的对话，结束后给收件箱发通知；引擎没运行时错过的时间点不补跑，只发一条说明错过了几次的通知。可以用 `schedule.list`、`schedule.delete` 和 `merak schedule list|delete` 管理。

### 修复

- Windows 上 `git` 来自 `mingw64\bin` 文件夹（例如在 Git Bash 终端里）时也能找到 Git Bash。
- 模型刷新、连通测试和云端调用较慢时不再 10 秒就失败。群和智能体的失败用各自的错误码说明真实原因；内置 Leader 和 Worker 没有配置模型时使用默认模型。

- 由 SDK 汇总群用量。历史事件乱序到达时保留最新上下文预算。

- SDK 提供云端成员查询。MCP 命令通过 Go SDK 连接引擎。
- 凭据保存失败时保留原云端连接。更新系统凭据时不再重复写入相同标记。

- 保留终端加载和连接期间的输入，隐藏并重新打开终端后继续发送。终端获得焦点后仍可使用全局快捷键。

- 保留 Worker 准备工作区和材料包期间收到的指令，避免重复发送材料包已包含的指令。

- 桌面构建测试改用临时目录，避免删除正在运行的应用入口文件。

- 恢复 v0.3.1 的对话宽度、项目归组、协作群快捷键和成员栏折叠交互。任务、收件箱、预算、远程成员和审核界面适配小窗口，长文本不再溢出，打开终端后仍能操作问题区。

- 返工与远程认领共用任务和成员预算。owner 批准后追加额度，运行中的时长上限随之延长。单聊用完预算后，人必须确认才能继续。ACP 会话可直接启动编辑器传入的 stdio MCP 服务器。流式片段中的密钥会先脱敏。

- 任务预算和档案预算累计返工用量。引擎在重启后保留暂停期间的输入，并支持默认 Leader 交接。外部成员结束任务后也会提取记忆。
- 私有成员仅接受拥有者派工。共享文档通过 SDK 访问。引擎清除导入事件中的密钥，云端上传排除文件正文。
- 群、任务、成员、JSON 流和 ACP 命令通过 SDK 调用产品能力。CI 增加桌面主进程和引擎生命周期检查。

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
