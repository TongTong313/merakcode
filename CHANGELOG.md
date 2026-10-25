# Changelog

All notable changes to MerakCode are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

MerakCode 所有值得注意的变化都记在这里。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.2] - 2026-10-25

### Changed

- Connected providers load their model list from the provider, with the saved key, instead of a bundled models.dev snapshot. A failed refresh is shown once (MRK-2001, MRK-2004, or MRK-2010).
- The homepage model menu is two sections, Configured then Official. An official provider starts with one current model per named line: Alibaba starts on unsuffixed `qwen-plus` and `qwen-max`, and OpenRouter starts with nothing on. A model that starts off can be added from the bottom of the menu, and Settings has a model list for each provider.
- Prices can be USD or CNY, can step by prompt size, and use a separate thinking price. Stats, the composer, and ACP show a total only when every priced reply shares one currency.
- The reasoning level starts from the model's catalog default, then keeps the level last sent with that model. A relay's discovered models keep the context, output, and modalities the catalog reported.
- Member adapters are written in TypeScript: Node runs an `adapter.mts` as it is, the single-file adapter library comes with its type declarations (`merakcode-adapter.d.mts`), and the `adapter-generator` skill writes TypeScript from the built-in adapters. Adapters already written in JavaScript keep working. The SDK guide explains writing one step by step.

### Fixed

- The new-group dialog can clear a copied group and return to a blank draft.

### 变更

- 已连接的服务商用保存的密钥向服务商拉取模型列表，不再使用打包的 models.dev 快照。刷新失败时提示一次（MRK-2001、MRK-2004 或 MRK-2010）。
- 主页的模型菜单分成「配置的模型」和「官方供应商」两段。官方供应商默认只打开每个指定系列里当前的一个模型：阿里云百炼只开不带后缀的 `qwen-plus` 和 `qwen-max`，OpenRouter 默认一个都不开。没打开的模型可以在菜单底部「添加模型」，设置里每个服务商有一份「模型配置」。
- 价格可以是美元或人民币，可以按提示词长度分档，思考另有价格。统计、输入框和 ACP 只在每条有价格的回复币种相同时显示合计。
- 推理档位先用模型目录里的默认值，再记住这个模型上次发送的档位。中转发现的模型保留目录里实际返回的上下文、输出长度和模态。
- 成员适配器改用 TypeScript 写：Node 直接运行 `adapter.mts`，单文件适配器开发库带上了类型声明（`merakcode-adapter.d.mts`），技能 `adapter-generator` 照着内置适配器写 TypeScript。已经用 JavaScript 写好的适配器照样能用。SDK 手册一步步讲了怎么写。

### 修复

- 新建协作群时，复制了已有的群之后可以清空，回到空白草稿。

## [0.1.1] - 2026-10-24

### Added

- Collaboration groups: MerakCode leads, and Claude Code, Codex, OpenCode and other CLIs join as members. Members are mentioned with `@`, listed in a member column, tracked in a group todo, and a group can be created with `Ctrl+G` or copied from another one.
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
- Without GitHub access, files are found right away (in `@` references, glob and ls) instead of after the ripgrep download times out.
- Opened thinking and steps no longer close as a reply goes on.

### 新增

- 协作群：MerakCode 当群主，Claude Code、Codex、OpenCode 和其他 CLI 当成员。可以用 `@` 点名成员，右侧有成员栏和群待办；用 `Ctrl+G` 新建，也可以从已有的群复制。
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
- 连不上 GitHub 时，`@` 引用、glob 和 ls 立刻就能找到文件，不再等 ripgrep 下载超时。
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
