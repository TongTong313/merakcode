# Changelog

All notable changes to MerakCode are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

MerakCode 所有值得注意的变化都记在这里。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Changed

- Desktop development no longer restarts the engine when its code changes; use Help › Restart Local Service.

### Fixed

- The sidebar no longer shows a conversation as running while memory is extracted in the background after a reply.
- A conversation no longer stays running after the local service restarts.
- Without GitHub access, files are found right away (in `@` references, glob and ls) instead of after the ripgrep download times out.

### 变更

- 桌面端开发时，引擎代码改完不再自动重启，用「帮助 › 重启本地服务」。

### 修复

- 回复结束后后台提取记忆时，侧边栏不再一直显示运行中。
- 本地服务重启后，对话不再卡在运行中。
- 连不上 GitHub 时，`@` 引用、glob 和 ls 立刻就能找到文件，不再等 ripgrep 下载超时。

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
