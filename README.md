<p align="center">
  <img src="apps/desktop/renderer/public/logo.svg" width="72" alt="MerakCode" />
</p>

<h1 align="center">MerakCode</h1>

<p align="center">致力于做最好用的 AI Coding 工具</p>

<p align="center">
  <a href="https://github.com/TongTong313/merakcode/actions/workflows/ci.yml"><img src="https://github.com/TongTong313/merakcode/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/TongTong313/merakcode/releases"><img src="https://img.shields.io/github/v/release/TongTong313/merakcode?include_prereleases" alt="Release" /></a>
  <a href="https://www.npmjs.com/package/merakcode"><img src="https://img.shields.io/npm/v/merakcode" alt="npm" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/TongTong313/merakcode" alt="License" /></a>
</p>

<p align="center">简体中文 · <a href="README.en.md">English</a></p>

---

MerakCode 是一个开源的 AI Coding 工具，除了具备强大的编程能力外，它还可以用于任何需要 AI 协助的场景。在现在 AI 生成速度远大于人类阅读速度的今天，MerakCode 非常注重人机协同交互体验，通过优化产物审核机制与使用体验，确保智能体输出的内容符合预期。

开源这个项目是为了弥补我们的心中的一个遗憾，也是想依靠社区的力量，让这个项目能够持续发展下去。产品的名字来自北斗七星里的天璇星，它和天枢一起指向北极星。我们希望 MerakCode 也像它一样，为你的每一个想法指明方向。

## 能做什么

- **AI Coding**：强大的项目级代码编程能力，支持多种编程语言，支持多种编程框架，支持多种编程范式，支持多种编程风格。有一说一，这点和其他的 AI Coding 产品没啥区别，好不好用大家说了算，好用就点一个 Star 支持一下。
- **跨产品人机协同**：MerakCode 的设计特别看中人机协同，有专门优化过的智能体产物审核交互界面（仅限桌面客户端），具备一套完整的智能体操作权限管理机制。此外，MerakCode 也支持联动各类带 CLI 的AI Coding 产品，进一步实现跨产品的人机协同。
- **模型配置**：支持配置各类大模型服务（目前仅支持8家，后续会持续扩展），也支持配置本地模型。此外，MerakCode 支持配置各类中转站的模型。
- **安全可靠**：智能体执行的命令在自研的系统沙箱里跑，读不到密钥目录，写不了工作区以外的地方，访问陌生网站也要经过你同意。几个人开发的小产品，没有服务端（没时间开发。。。），所以我们不收集也没能力收集大家的任何使用数据，大家不用担心任何数据的泄露问题。
- **支持扩展**：支持 MCP、技能（Skills）、插件、自定义智能体和斜杠命令。
- **Coding能力外延**：本质上 AI Coding 属于最复杂的一类任务，自然大家拿 MerakCode 做些其他事情也是没问题的。
- **支持二次开发**：MerakCode 提供智能体 SDK，MerakCode 各产品形态均基于 SDK 构建。大家也可以基于这个引擎进行二次开发，打造自己的 AI Coding 工具。

## 如何安装

### 桌面客户端安装

在 [Releases](https://github.com/TongTong313/merakcode/releases) 页面下载：

| 系统    | 文件                                                                          |
| ------- | ----------------------------------------------------------------------------- |
| Windows | `MerakCode-<版本>-windows-x64.exe`                                            |
| macOS   | `MerakCode-<版本>-darwin-arm64.dmg`（Apple 芯片）、`-darwin-x64.dmg`（Intel） |
| Linux   | `MerakCode-<版本>-linux-x64.AppImage` 或 `.deb`                               |

桌面客户端自带引擎，不用另外装命令行版。

安装包目前没有代码签名，第一次打开时系统会拦一下：

- **Windows**：出现"Windows 已保护你的电脑"时，点"更多信息"，再点"仍要运行"。
- **macOS**：双击后提示无法打开时，到"系统设置 → 隐私与安全性"，在页面下方点"仍要打开"。没签名的 macOS 版不能自动更新，有新版本时会提示你去下载页。

### 命令行安装

命令行版没有界面，适合在终端里跑一次性任务、写脚本，或者接到编辑器里用（ACP）。它和桌面客户端共用同一份配置和密钥。

macOS / Linux：

```sh
curl -fsSL https://github.com/TongTong313/merakcode/releases/latest/download/install.sh | sh
```

Windows（PowerShell）：

```powershell
irm https://github.com/TongTong313/merakcode/releases/latest/download/install.ps1 | iex
```

也可以用 npm 装（安装包自带运行时，本机有 Node.js 18 以上就行）：

```sh
npm install -g merakcode
```

装好后的命令是 `merak`。以后升级用 `merak upgrade`（也可以写 `merak update`）。

想自己核对下载的文件，把 Releases 页面上的 `SHA256SUMS` 和安装包下载到同一个文件夹，在那里运行：

```sh
sha256sum -c SHA256SUMS --ignore-missing          # Linux
shasum -a 256 -c SHA256SUMS --ignore-missing      # macOS
```

```powershell
# Windows：输出的值要和 SHA256SUMS 里这个文件那一行的值一样
(Get-FileHash .\merakcode-<版本>-windows-x64.zip).Hash.ToLower()
```

### 卸载

Windows 上如果初始化过沙箱，卸载前先在桌面客户端的"设置 → 权限与安全"里点"重置"（或者运行 `merak sandbox reset`）。它会删掉沙箱账户和防火墙规则，并收回给过的文件夹权限。

- 桌面客户端：在系统的"应用"列表里卸载。
- 一行脚本装的：macOS / Linux 删除 `~/.local/bin/merak`；Windows 从用户 PATH 里去掉 `~\.merakcode\bin`。
- npm 装的：`npm uninstall -g merakcode`。
- 配置、会话记录、日志和缓存都在 `~/.merakcode` 一个文件夹里（Windows 上 `~` 是 `C:\Users\<用户名>`；设置环境变量 `MERAKCODE_HOME` 可以换位置），不需要的话删掉它。

## 快速开始

打开桌面客户端，点"打开文件夹"选择你的项目。

第一次用要先连一个模型服务：在引导页里选择服务商，填入 API 密钥（之后可以在"设置 → 模型与供应商"里改）。官方目录有 OpenAI、Anthropic、Google、阿里云百炼、智谱、DeepSeek、月之暗面和 OpenRouter。其他服务在配置里加一个 OpenAI 兼容接口，写上地址、模型名和 API 密钥。

然后直接说要做什么：

```text
给 utils/date.ts 里的 formatDate 加上单元测试
```

常用的操作（macOS 上是 `⌘`，Windows 和 Linux 上是 `Ctrl`）：

| 操作             | 作用                                       |
| ---------------- | ------------------------------------------ |
| `⌘/Ctrl+K`       | 命令面板：搜索对话标题、对话内容或命令     |
| `⌘/Ctrl+N`       | 新建对话                                   |
| `⌘/Ctrl+,`       | 打开设置                                   |
| `⌘/Ctrl+J`       | 打开或关闭终端                             |
| `⌘/Ctrl+B`       | 显示或隐藏右侧面板                         |
| `Shift+Tab`      | 切换权限模式                               |
| 输入框里输入 `/` | 选斜杠命令，比如 `/compact` 压缩太长的对话 |
| 输入框里输入 `@` | 引用项目里的文件                           |

## 常用命令

命令行版在终端里用。没在桌面客户端里连过模型服务的话，先运行 `merak provider login` 连一个，然后在项目目录里执行一次任务，结果打印到终端：

```sh
cd your-project
merak run "解释一下 src/index.ts 是怎么启动的"
```

| 命令                           | 作用                                                                      |
| ------------------------------ | ------------------------------------------------------------------------- |
| `merak run "<任务>"`           | 执行一次任务，结果打印到终端                                              |
| `merak provider login`         | 连接模型服务；`list` 查看连了哪些，`logout` 删掉                          |
| `merak serve --port 4096`      | 只启动引擎，给 SDK 或别的程序连                                           |
| `merak upgrade`（或 `update`） | 升级。`--check` 只看有没有新版本，`--yes` 不再确认                        |
| `merak models`                 | 列出能用的模型                                                            |
| `merak mcp list`               | 查看 MCP 服务的状态                                                       |
| `merak sandbox status`         | 查看沙箱是否开着；`setup` 初始化，`reset` 撤销                            |
| `merak doctor`                 | 检查安装、配置、模型和沙箱，告诉你哪里有问题                              |
| `merak logs`                   | 日志在哪、最近的运行记录；`--tail` 实时看最新的日志                       |
| `merak bug-report`             | 把检查结果、配置和日志打包成 zip，方便提 issue；密钥和对话内容不会放进去  |
| `merak acp`                    | 作为 [ACP](https://agentclientprotocol.com) 智能体运行，给 Zed 等编辑器用 |

每个命令都可以加 `--help` 看完整说明。

### 在编辑器里用（ACP）

支持 [ACP](https://agentclientprotocol.com) 的编辑器可以直接把 MerakCode 当智能体用。以 Zed 为例，在 `~/.config/zed/settings.json` 里加上：

```json
{
  "agent_servers": {
    "MerakCode": { "command": "merak", "args": ["acp"] }
  }
}
```

## 权限和沙箱

MerakCode 会在你的电脑上改文件、跑命令，所以每次操作前按权限模式判断：直接做、先问你，还是不做。

| 模式         | 适合             | 怎么做                                                                                                    |
| ------------ | ---------------- | --------------------------------------------------------------------------------------------------------- |
| 只读         | 生成设计与方案   | 只读文件、跑只读命令（如 `git status`、`ls`）。不改文件，不跑别的命令                                     |
| 询问（默认） | 日常开发         | 读文件、改工作区里的文件直接做；跑命令、改工作区外的文件、读敏感文件、联网之前先问你                      |
| 自动         | 大型项目+信任 AI | 大部分操作直接做；高风险命令（如 `git push`、`sudo`）、改工作区外的文件、读敏感文件、访问陌生网站仍然先问 |

在桌面客户端的输入框旁边切换模式，或者按 `Shift+Tab`。问你的时候可以选：只允许这一次、这个会话里都允许、总是允许（写进项目配置）、拒绝。`rm -rf /`、格式化磁盘这类命令默认在任何模式下都不执行。

智能体跑的命令还会放进**系统沙箱**：只能写工作区、临时目录和包管理器缓存，读不到 `~/.ssh`、`~/.aws` 这类放密钥的目录，不能改 `.git/hooks` 和 `.git/config`，联网要经过一个本地代理，没见过的网站会先问你。沙箱是用操作系统自带的能力自己写的：

| 系统    | 用的是什么                          | 需要做什么                                                                                              |
| ------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Windows | 独立的低权限账户、NTFS 权限、防火墙 | 在桌面客户端的"设置 → 权限与安全"里点"初始化"（或者运行一次 `merak sandbox setup`），会弹一次管理员确认 |
| Linux   | Landlock（内核 5.13 以上）          | 不用设置。网络限制要内核 6.7 以上                                                                       |
| macOS   | 系统自带的 Seatbelt（sandbox-exec） | 不用设置                                                                                                |

沙箱没准备好时（比如 Windows 还没初始化），会改东西的命令在自动模式下也会先问你。能保证什么、不能保证什么，见 [SECURITY.md](SECURITY.md)。

## 配置

| 位置                                                | 作用                                        |
| --------------------------------------------------- | ------------------------------------------- |
| `~/.merakcode/merakcode.json`                       | 全局配置（模型、语言、权限规则等）          |
| `<项目>/.merakcode/merakcode.json`                  | 项目配置，覆盖全局配置                      |
| `<项目>/AGENTS.md`                                  | 给 MerakCode 的项目说明（也认 `CLAUDE.md`） |
| `<项目>/.merakcode/agents/`、`skills/`、`commands/` | 自定义智能体、技能、斜杠命令                |

配置文件可以写 JSON，也可以写带注释的 JSONC。开头写上 `"$schema"`，编辑器就能补全和检查：

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/TongTong313/merakcode/main/schema/config.json",
  "model": "anthropic/claude-sonnet-4-5",
  "locale": "zh-CN",
  "permission": {
    "bash": { "git status": "allow", "rm -rf *": "deny" },
  },
  "sandbox": { "mode": "preferred" },
}
```

界面换成英文：桌面客户端在"设置 → 通用 → 语言"里切换；命令行在配置里写 `"locale": "en-US"`，或者设置环境变量 `MERAKCODE_LOCALE=en-US`。

## SDK

想在自己的程序里用 MerakCode，用 TypeScript SDK：

```sh
npm install @merakcode/sdk
```

```ts
import { createMerakCode } from "@merakcode/sdk"

const merak = await createMerakCode({ cwd: process.cwd() })
const session = await merak.session()
for await (const event of session.run("这个项目是做什么的？")) {
  if (event.type === "text") process.stdout.write(event.delta)
}
await merak.close()
```

完整说明见 [SDK 手册](docs/sdk/README.md)。

## 从源码开发

需要 Node.js 26.12 以上和 pnpm 12。

```sh
git clone https://github.com/TongTong313/merakcode.git
cd merakcode
pnpm install
pnpm hooks:install          # 提交前自动检查格式
```

### 从源码运行

| 想做的事         | 命令                                                                             |
| ---------------- | -------------------------------------------------------------------------------- |
| 开发桌面客户端   | `pnpm --dir apps/desktop/main dev`                                               |
| 运行命令行的命令 | `pnpm dev run "解释一下这个项目"`                                                |
| 只启动引擎       | `pnpm dev serve --port 4096`                                                     |
| 用调试器调引擎   | `node --inspect --import ./script/node/register.mjs apps/cli/src/index.ts serve` |
| 打出详细日志     | `pnpm dev serve --print-logs --log-level DEBUG`                                  |

**特别注意**：桌面端开发支持界面热更新，主进程和引擎的代码改完会自动重启，大家调试起来更方便了。

`pnpm dev` 跑的是源码，不用先构建。改了代码重新运行就生效。

### 测试和检查

```sh
pnpm check                              # 格式、类型、依赖边界、生成文件是否最新……提交前跑一遍
cd packages/engine && pnpm test         # 每个包在自己的目录里跑测试
cd apps/cli && pnpm test test/cli/doctor-command.test.ts   # 只跑一个文件
```

### 打包

```sh
pnpm --dir apps/cli build --single      # 本机平台的命令行发布包，在 apps/cli/dist/ 下
pnpm --dir apps/desktop/main package    # 本机平台的桌面安装包，在 apps/desktop/main/release/ 下
```

打好的命令行版在 `apps/cli/dist/merakcode-<版本>-<平台>/bin/merak`（Windows 是 `merak.cmd`）。打包要从网上下载 Node 和 Electron，网络慢的话可以设置 `MERAKCODE_NODE_MIRROR`、`ELECTRON_MIRROR` 换下载源。

### 生成文件

| 改了什么     | 运行                                                  |
| ------------ | ----------------------------------------------------- |
| 服务端接口   | `pnpm generate:sdk`，再 `pnpm generate:sdk-reference` |
| 配置项       | `pnpm generate:schema`                                |
| 错误码       | `pnpm generate:errors`                                |
| SDK 公开接口 | `pnpm check:api --write`                              |

### 让 SDK 用源码版引擎

```ts
const merak = await createMerakCode({
  executablePath: [process.execPath, "--import", "<仓库>/script/node/register.mjs", "<仓库>/apps/cli/src/index.ts"],
})
```

### 代码结构

```text
apps/cli              merak 命令；merak serve 就是引擎，桌面客户端内置的也是它
apps/desktop/main     桌面客户端主进程（Electron）
apps/desktop/renderer 桌面客户端界面（SolidJS）
packages/engine       引擎：会话、模型、工具、权限、HTTP 服务
packages/sandbox      系统沙箱（Windows / Linux / macOS）
packages/sdk/js       TypeScript SDK
packages/util、log    共用的工具函数和日志
packages/client-core  桌面客户端的审批选项
```

桌面客户端和命令行的各个命令都不直接引用引擎代码，而是通过 SDK 启动一个 `merak serve` 进程，再走 HTTP 和事件流通信。`pnpm check` 会检查这条边界。更多约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 遇到问题

1. 报错里有错误码（比如 `[MRK-2002]`），先在[错误码表](docs/errors.md)里查。
2. 运行 `merak doctor`，它会告诉你是哪一项出了问题。
3. 还解决不了，运行 `merak bug-report`，把生成的 zip 附在 [issue](https://github.com/TongTong313/merakcode/issues/new/choose) 里。
4. 想自己看日志：`merak logs` 会显示日志在哪，`merak logs --tail` 实时看最新的。

## 安全

发现安全问题请不要公开提 issue，按 [SECURITY.md](SECURITY.md) 里的方式私下报告。

## 参与开发

欢迎大家提 Issue 和 Pull Request，一起完善 MerakCode，贡献规范可参考 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)

## 致谢

本项目实现参考了部分 [opencode](https://github.com/anomalyco/opencode) 项目代码，在此对表示感谢，它们的许可证声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
