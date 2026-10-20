<p align="center">
  <img src="apps/desktop/renderer/public/logo.svg" width="72" alt="MerakCode" />
</p>

<h1 align="center">MerakCode</h1>

<p align="center">开源的 AI 编程助手，终端、桌面、SDK 三种用法。</p>

<p align="center">
  <a href="https://github.com/TongTong313/merakcode/actions/workflows/ci.yml"><img src="https://github.com/TongTong313/merakcode/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/TongTong313/merakcode/releases"><img src="https://img.shields.io/github/v/release/TongTong313/merakcode?include_prereleases" alt="Release" /></a>
  <a href="https://www.npmjs.com/package/merakcode"><img src="https://img.shields.io/npm/v/merakcode" alt="npm" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/TongTong313/merakcode" alt="License" /></a>
</p>

<p align="center">简体中文 · <a href="README.en.md">English</a></p>

---

MerakCode 是一个开源的 AI 编程助手，什么场景都能用。它能读懂你的项目，帮你写代码、修 Bug、跑命令、补测试；处理文档、表格、PDF 这类日常办公活儿也一样顺手。名字来自北斗七星里的天璇星，它和天枢一起指向北极星。我们希望 MerakCode 也像它一样，用最简单顺手的方式，为你的每一个想法指明方向。

## 能做什么

- **模型随便选**：内置两百多家模型服务（Claude、GPT、Gemini、通义千问、DeepSeek 等），也能接 LM Studio、Ollama 这类本地模型，或者任何兼容 OpenAI 接口的服务。
- **一个引擎，三种用法**：终端界面、桌面客户端和 TypeScript SDK 用的是同一个引擎，行为一致。
- **改东西之前先问你**：按权限模式决定哪些操作直接做、哪些先问；命令在自研的系统沙箱里跑，读不到密钥目录，写不了工作区以外的地方，访问陌生网站也要经过你同意。
- **能扩展**：支持 MCP、技能（Skills）、插件、自定义智能体和斜杠命令。
- **不只写代码**：能读 Word 和 PDF，能读写 Excel 表格。
- **中英双语**：界面默认中文，可以切到英文。
- **没有遥测**：不收集任何使用数据。日志只写在你自己的电脑上。

## 安装

### 命令行

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

### 桌面客户端

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

### 卸载

Windows 上如果初始化过沙箱，卸载前先运行 `merak sandbox reset`。它会删掉沙箱账户和防火墙规则，并收回给过的文件夹权限。

- 一行脚本装的：macOS / Linux 删除 `~/.merakcode` 和 `~/.local/bin/merak`；Windows 删除 `%LOCALAPPDATA%\merakcode`，再从用户 PATH 里去掉其中的 `bin` 目录。
- npm 装的：`npm uninstall -g merakcode`。
- 桌面客户端：在系统的"应用"列表里卸载。
- 配置、会话记录和日志在 `~/.config/merakcode`、`~/.local/share/merakcode`、`~/.local/state/merakcode` 和 `~/.cache/merakcode`（Windows 上 `~` 是 `C:\Users\<用户名>`），不需要的话一起删掉。

## 快速开始

在项目目录里运行：

```sh
cd your-project
merak
```

第一次用要先连一个模型服务：在输入框里输入 `/provider`，选择服务商，填入 API 密钥。环境变量里已经有密钥的（比如 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`DASHSCOPE_API_KEY`）会自动识别。

然后直接说要做什么：

```text
给 utils/date.ts 里的 formatDate 加上单元测试
```

不进界面、只执行一次任务：

```sh
merak run "解释一下 src/index.ts 是怎么启动的"
```

界面里常用的：

| 输入           | 作用                                            |
| -------------- | ----------------------------------------------- |
| `/provider`    | 连接或切换模型服务                              |
| `/models`      | 选择模型                                        |
| `/new`         | 新建会话                                        |
| `/sessions`    | 打开历史会话                                    |
| `/compact`     | 对话太长时压缩一下                              |
| `/undo`        | 撤销上一轮改动                                  |
| `/permissions` | 查看和修改权限规则、沙箱（也可以输 `/sandbox`） |
| `/language`    | 切换中文 / 英文                                 |
| `/help`        | 所有命令和快捷键                                |
| `Shift+Tab`    | 切换权限模式                                    |

## 常用命令

| 命令                           | 作用                                                                      |
| ------------------------------ | ------------------------------------------------------------------------- |
| `merak`                        | 打开终端界面                                                              |
| `merak run "<要做的事>"`       | 执行一次任务，结果打印到终端                                              |
| `merak serve --port 4096`      | 只启动引擎，给桌面端、SDK 或别的终端连                                    |
| `merak attach <地址>`          | 用终端界面连接一个已经在运行的引擎                                        |
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
| 只读         | 先看代码、出方案 | 只读文件、跑只读命令（如 `git status`、`ls`）。不改文件，不跑别的命令                                     |
| 询问（默认） | 日常开发         | 读文件、改工作区里的文件直接做；跑命令、改工作区外的文件、读敏感文件、联网之前先问你                      |
| 自动         | 放手让它做       | 大部分操作直接做；高风险命令（如 `git push`、`sudo`）、改工作区外的文件、读敏感文件、访问陌生网站仍然先问 |

在界面里按 `Shift+Tab` 切换模式。问你的时候可以选：只允许这一次、这个会话里都允许、总是允许（写进项目配置）、拒绝。`rm -rf /`、格式化磁盘这类命令默认在任何模式下都不执行。

智能体跑的命令还会放进**系统沙箱**：只能写工作区、临时目录和包管理器缓存，读不到 `~/.ssh`、`~/.aws` 这类放密钥的目录，不能改 `.git/hooks` 和 `.git/config`，联网要经过一个本地代理，没见过的网站会先问你。沙箱是用操作系统自带的能力自己写的：

| 系统    | 用的是什么                          | 需要做什么                                                     |
| ------- | ----------------------------------- | -------------------------------------------------------------- |
| Windows | 独立的低权限账户、NTFS 权限、防火墙 | 运行一次 `merak sandbox setup`，会弹一次管理员确认，要等几分钟 |
| Linux   | Landlock（内核 5.13 以上）          | 不用设置。网络限制要内核 6.7 以上                              |
| macOS   | 系统自带的 Seatbelt（sandbox-exec） | 不用设置                                                       |

沙箱没准备好时（比如 Windows 还没初始化），会改东西的命令在自动模式下也会先问你。能保证什么、不能保证什么，见 [SECURITY.md](SECURITY.md)。

## 配置

| 位置                                                | 作用                                        |
| --------------------------------------------------- | ------------------------------------------- |
| `~/.config/merakcode/merakcode.json`                | 全局配置（模型、语言、权限规则等）          |
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

界面换成英文：在 `/language` 里切换，或者在配置里写 `"locale": "en-US"`，或者设置环境变量 `MERAKCODE_LOCALE=en-US`。

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

| 想做的事           | 命令                                                                             |
| ------------------ | -------------------------------------------------------------------------------- |
| 打开终端界面       | `pnpm dev`                                                                       |
| 带参数运行         | `pnpm dev run "解释一下这个项目"`                                                |
| 只启动引擎         | `pnpm dev serve --port 4096`                                                     |
| 另开一个终端连上它 | `pnpm dev attach http://127.0.0.1:4096`                                          |
| 用调试器调引擎     | `node --inspect --import ./script/node/register.mjs apps/cli/src/index.ts serve` |
| 打出详细日志       | `pnpm dev --print-logs --log-level DEBUG`                                        |
| 开发桌面客户端     | `pnpm --dir apps/desktop/main dev`（加 `--renderer` 会先重建界面）               |

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
apps/cli              merak 命令和终端界面；merak serve 就是引擎
apps/desktop/main     桌面客户端主进程（Electron）
apps/desktop/renderer 桌面客户端界面（SolidJS）
packages/engine       引擎：会话、模型、工具、权限、HTTP 服务
packages/sandbox      系统沙箱（Windows / Linux / macOS）
packages/sdk/js       TypeScript SDK
packages/util、log    共用的工具函数和日志
packages/client-core  终端和桌面共用的审批选项
```

终端界面和桌面客户端都不直接引用引擎代码，而是通过 SDK 启动一个 `merak serve` 进程，再走 HTTP 和事件流通信。`pnpm check` 会检查这条边界。更多约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 遇到问题

1. 报错里有错误码（比如 `[MRK-2002]`），先在[错误码表](docs/errors.md)里查。
2. 运行 `merak doctor`，它会告诉你是哪一项出了问题。
3. 还解决不了，运行 `merak bug-report`，把生成的 zip 附在 [issue](https://github.com/TongTong313/merakcode/issues/new/choose) 里。
4. 想自己看日志：`merak logs` 会显示日志在哪，`merak logs --tail` 实时看最新的。

## 安全

发现安全问题请不要公开提 issue，按 [SECURITY.md](SECURITY.md) 里的方式私下报告。

## 许可证

[MIT](LICENSE)

## 致谢

感谢 [opencode](https://github.com/anomalyco/opencode) 以及 MerakCode 用到的其他开源项目。它们的许可证声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
