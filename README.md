<p align="center">
  <img src="apps/desktop/renderer/public/logo.svg" width="72" alt="MerakCode" />
</p>

<h1 align="center">MerakCode</h1>

<p align="center">一款入口型 AI Coding 工具</p>

<p align="center">
  <a href="https://github.com/TongTong313/merakcode/actions/workflows/ci.yml"><img src="https://github.com/TongTong313/merakcode/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/TongTong313/merakcode/releases"><img src="https://img.shields.io/github/v/release/TongTong313/merakcode?include_prereleases" alt="Release" /></a>
  <a href="https://www.npmjs.com/package/merakcode"><img src="https://img.shields.io/npm/v/merakcode" alt="npm" /></a>
  <a href="#从源码开发"><img src="https://img.shields.io/badge/dev%20node-%3E%3D26.12-339933?logo=nodedotjs&logoColor=white" alt="Node.js (development)" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-7.0-3178C6?logo=typescript&logoColor=white" alt="TypeScript" /></a>
</p>

<p align="center">简体中文 · <a href="README.en.md">English</a></p>

---

MerakCode 是一个开源的**入口型 AI Coding 工具**，产品设计的灵感来自于我自己，我喜欢结合 Claude Code、Codex、OpenCode 等产品一起干活，但又没有一个很好的入口型 AI Coding 工具，因此 MerakCode 应运而生。在 AI 生成速度远大于人类阅读速度的今天，我们不去卷 AI Coding 能力（虽然 MerakCode 本身也具备强大的编程能力），而是更看重实际编码场景的人机协同交互体验。如何更好地接入并组合使用其他各类 AI Coding Harness，是 MerakCode 的核心价值所在。MerakCode 的协作群可以让 Claude Code、Codex、OpenCode 等产品一起干活。如果你是各类 AI Coding 工具的使用者，并且想把它们组合在一起发挥最大效能，那么 MerakCode 是一个不错的选择。

开源这个项目是为了弥补我们心中的一个遗憾，也是想依靠社区的力量，让这个项目能够持续发展下去。产品的名字来自北斗七星里的天璇星，它和天枢一起指向北极星。我们希望 MerakCode 也像它一样，为你的每一个想法指明方向。

## 能做什么

- **AI Coding**：强大的项目级代码编程能力，支持多种编程语言，支持多种编程框架，支持多种编程范式，支持多种编程风格。有一说一，这点和其他的 AI Coding 产品没啥区别，好不好用大家说了算，好用就点一个 Star 支持一下。
- **跨产品人机协同**：MerakCode 的设计特别看中人机协同，有专门优化过的智能体产物审核交互界面（仅限桌面客户端），具备一套完整的智能体操作权限管理机制。此外，MerakCode 也支持联动各类带 CLI 的 AI Coding 产品，进一步实现跨产品的人机协同。
- **模型配置**：支持配置各类大模型服务（目前仅支持8家，后续会持续扩展），也支持配置本地模型。此外，MerakCode 支持配置各类中转站的模型。
- **安全可靠**：智能体执行的命令在自研的系统沙箱里跑，读不到 `~/.ssh`、`~/.aws` 这类密钥目录，只能写工作区、临时目录和包管理器缓存，允许名单以外的网站要经过你同意（Windows 要先在对话栏初始化一次，设置里也能；协作群成员的命令不在这个沙箱里；能保证什么、不能保证什么见[权限和沙箱](#权限和沙箱)）。几个人开发的小产品，没有服务端（没时间开发。。。），所以我们不收集也没能力收集大家的任何使用数据，大家不用担心任何数据的泄露问题。
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
- **macOS**：双击后提示无法打开时，到"系统设置 → 隐私与安全性"，在页面下方点"仍要打开"。

没签名的 macOS 版，以及 Linux 的 `.deb`，不能自动更新，有新版本时会提示你去下载页。

### 命令行安装

命令行版没有界面，适合在终端里跑一次性任务、写脚本，或者接到编辑器里用（ACP）。它和桌面客户端共用同一份配置和密钥。支持 Linux（x64、arm64，需要 glibc，Alpine 这类 musl 系统还不行）、macOS（Apple 芯片、Intel）和 Windows（x64、arm64）。

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

装好后的命令是 `merak`。以后升级用 `merak upgrade`（也可以写 `merak update`，`merak upgrade <版本>` 装指定版本）。

- 一行脚本把程序装在 `~/.merakcode/versions/<版本>/`，macOS / Linux 的命令放在 `~/.local/bin/merak`（不在 PATH 里时脚本会提示），Windows 放在 `~\.merakcode\bin` 并加进用户 PATH。
- 下载慢可以换源：一行脚本和 `merak upgrade` 认 `MERAKCODE_DOWNLOAD_BASE`（下载地址），npm 装的升级认 `MERAKCODE_NPM_REGISTRY`。`MERAKCODE_VERSION`、`MERAKCODE_INSTALL_DIR`、`MERAKCODE_BIN_DIR` 可以指定版本和安装位置。
- Linux 上提示自带的 Node 起不来，一般是缺 libatomic：Debian / Ubuntu 装 `libatomic1`，Fedora / RHEL 装 `libatomic`。

想自己核对命令行版的压缩包（`merakcode-<版本>-<平台>.tar.gz` 或 `.zip`；一行脚本安装时已经自动校验过），把 Releases 页面上的 `SHA256SUMS` 和压缩包下载到同一个文件夹，在那里运行（`SHA256SUMS` 只列命令行版的压缩包，不含桌面安装包）：

```sh
sha256sum -c SHA256SUMS --ignore-missing                 # Linux
grep 'darwin-arm64.tar.gz' SHA256SUMS | shasum -a 256 -c # macOS（Apple 芯片）
grep 'darwin-x64.tar.gz' SHA256SUMS | shasum -a 256 -c   # macOS（Intel）
```

macOS 自带的 `shasum` 没有 `--ignore-missing`，所以上面是先抽出你下载的那一行再校验。

```powershell
# Windows：输出的值要和 SHA256SUMS 里这个文件那一行的值一样
(Get-FileHash .\merakcode-<版本>-windows-x64.zip).Hash.ToLower()
```

### 卸载

Windows 上如果初始化过沙箱，卸载前先在桌面客户端的"设置 → 权限与安全"里点"重置"（或者运行 `merak sandbox reset`）。它会删掉沙箱账户和防火墙规则，并收回给过的文件夹权限。

- 桌面客户端：Windows 在"设置 → 应用"里卸载；macOS 把"应用程序"里的 MerakCode 拖进废纸篓；Linux 的 AppImage 直接删掉文件，`.deb` 用 `sudo apt remove merakcode-desktop`。
- 一行脚本装的：程序在 `~/.merakcode/versions/` 里（随下面的文件夹一起删）；macOS / Linux 再删除 `~/.local/bin/merak`；Windows 从用户 PATH 里去掉 `~\.merakcode\bin`。
- npm 装的：`npm uninstall -g merakcode`。
- 配置、API 密钥（明文保存在 `~/.merakcode/data/auth.json`）、会话记录、日志、缓存，以及一行脚本装的程序，都在 `~/.merakcode` 一个文件夹里（Windows 上 `~` 是 `C:\Users\<用户名>`；设置环境变量 `MERAKCODE_HOME` 可以换位置），不需要的话删掉它。

## 快速开始

打开桌面客户端，点"打开文件夹"选择你的项目。

第一次用要先连一个模型服务：在引导页里选择服务商，填入 API 密钥（之后可以在"设置 → 模型与供应商"里改）。官方目录有 OpenAI、Anthropic、Google、阿里云百炼、智谱、DeepSeek、月之暗面和 OpenRouter（阿里云百炼、智谱、月之暗面用的是中国大陆的接口）。环境变量里的密钥（比如 `OPENAI_API_KEY`）不会自动拿来用。

其他服务（本地的 Ollama、LM Studio，公司内部的网关，或者中转站）在"设置 → 模型与供应商"里点"添加自定义供应商"，选"兼容接口"或"中转站"；命令行可以用 `merak provider relay` 加中转站。本地模型不需要密钥，也要随便填一个（比如 `none`），没有密钥的服务商不会出现在列表里。

连上以后，模型菜单里官方服务商每家只默认打开几个当前的主力模型（OpenRouter 默认一个都不开），自定义供应商的模型全部打开。想用别的模型，点模型菜单底部的"添加模型"，在设置里该服务商的"模型配置"里打开。

然后直接说要做什么：

```text
给 utils/date.ts 里的 formatDate 加上单元测试
```

常用的操作（macOS 上是 `⌘`，Windows 和 Linux 上是 `Ctrl`）：

| 操作             | 作用                                       |
| ---------------- | ------------------------------------------ |
| `⌘/Ctrl+K`       | 命令面板：搜索对话标题、对话内容或命令     |
| `⌘/Ctrl+N`       | 新建对话                                   |
| `⌘/Ctrl+G`       | 新建协作群                                 |
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

| 命令                                                 | 作用                                                                                                                                |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `merak run "<任务>"`                                 | 执行一次任务，结果打印到终端。`-c` 接着上次的会话，`-m` 指定模型，`-f` 附上文件，`--format json` 输出原始事件；也可以从管道读入任务 |
| `merak run --permission-level fullTakeover "<任务>"` | 以全面接管级别执行，见下面的说明                                                                                                    |
| `merak provider login`                               | 连接模型服务；`list` 查看连了哪些，`logout` 删掉，`relay` 加中转站                                                                  |
| `merak serve --port 4096`                            | 只启动引擎，给 SDK 或别的程序连                                                                                                     |
| `merak upgrade`（或 `update`）                       | 升级。`--check` 只看有没有新版本，`--yes` 不再确认                                                                                  |
| `merak models`                                       | 列出能用的模型；`--refresh` 重新拉取模型列表                                                                                        |
| `merak mcp list`                                     | 查看 MCP 服务的状态                                                                                                                 |
| `merak skill`、`merak plugin`                        | 管理技能和插件                                                                                                                      |
| `merak session`、`merak export`、`merak import`      | 管理会话，导出、导入会话                                                                                                            |
| `merak stats`                                        | 用量和费用统计                                                                                                                      |
| `merak sandbox status`                               | 查看沙箱是否开着；`setup` 初始化（只有 Windows 需要），`reset` 撤销                                                                 |
| `merak doctor`                                       | 检查安装、配置、模型和沙箱，告诉你哪里有问题                                                                                        |
| `merak logs`                                         | 日志在哪、最近的运行记录；`--tail` 实时看最新的日志                                                                                 |
| `merak bug-report`                                   | 把检查结果、配置和日志打包成 zip，方便提 issue；密钥和对话内容不会放进去                                                            |
| `merak acp`                                          | 作为 [ACP](https://agentclientprotocol.com) 智能体运行，给 Zed 等编辑器用                                                           |

每个命令都可以加 `--help` 看完整说明。

`merak run` 没有审批处理器时会拒绝需要确认的操作。`--permission-level autoApprove` 只自动批准符合条件的安全操作。显式选择 `--permission-level fullTakeover` 才会跳过安全审批。旧 `--auto` 选项已移除。

`merak serve` 默认只监听 `127.0.0.1`，但不设口令，这台电脑上的任何程序都能调用它。给别的程序用时设置环境变量 `MERAKCODE_SERVER_PASSWORD`（HTTP Basic 认证，用户名默认 `merakcode`），详见 [SECURITY.md](SECURITY.md#引擎的接口)。

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

新对话默认使用“每次询问”。子任务、群成员和后台任务沿用根对话的最新权限级别。

| 权限级别                     | 沙箱就绪时                                                                                           | 本次操作缺少所需隔离时               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 每次询问 `ask`               | 每项操作先询问；可按显示范围授予本对话授权                                                           | 每项操作先询问，只能允许这一次或拒绝 |
| 仅询问危险行为 `autoApprove` | 放行项目内普通读写、沙箱内普通命令（含工作区内删除）和专用计划写入；推送、提权、越界、额外联网等询问 | 保留级别，每项操作先询问             |
| 全面接管 `fullTakeover`      | 跳过安全审批；受控命令优先使用沙箱，需要当前账户时使用当前账户                                       | 跳过安全审批，显示当前账户执行       |

全面接管仍遵守用户的任务范围、参数校验和并发保护。命令启动后失败时，系统不会把整条命令自动改用当前账户重跑。

沙箱由产品准备。桌面首次具备交互条件时，Windows 会请求一次系统管理员确认。用户取消后，前两档继续逐次询问。用户可从沙箱状态入口重试。`merak sandbox status` 和 `merak sandbox setup` 用于诊断与修复。

三档都能生成官方计划。模型使用 `plan_generate` 保存 Markdown，使用 `plan_edit` 修改正文。只出稿的要求不授权项目实施。人工保存无需智能体审批。计划标签显示完整 Markdown，编辑操作使用现有编辑器。

按钮和明确的聊天指令共用计划启动流程。启动采用最新已保存正文，记录固定快照，保留当前权限级别。执行中改稿不会改变本次快照。详情见[权限级别与官方计划](docs/session-modes.md)。

外部适配器使用协议 3。宿主只控制适配器真实上报的操作。外部产品的原生限制继续适用。依赖计划的任务需要适配器声明完整输入和容量能力。

## 协作群

协作群里 MerakCode 当群主，可以拉 Claude Code、Codex、OpenCode 和其他 AI 编程工具当成员。你在群里说要做什么，群主拆好任务分给成员，成员各自完成后在群里回复。

- 新建：侧边栏的「新建协作群」、`⌘/Ctrl+G` 或命令面板（都要先打开项目）。也可以从已有的群复制群名和成员（连同角色和职责，这里用不了的产品会跳过），复制后点「清空」回到空白。
- 成员可以是 MerakCode 自己。群主可以同时给几个成员派活：改的路径互不重叠的成员同时干，同一个成员或路径重叠的排队。
- 在输入框里用 `@` 点名成员；右侧成员栏可以改名字、角色和职责。
- 成员要做的操作和提的问题会出现在审批栏和提问框里，按你选的权限模式判断。
- 在「设置 › 协作群」里开关产品、查看版本和路径、看权限由谁决定（接了适配器的由 MerakCode 审批，一次性命令由产品自己决定）、添加自定义产品。版本比建议的旧时会提示你升级（`claude update`、`codex update`、`opencode upgrade`），但照样能用。建议版本：Claude Code 2.1.283、Codex 0.164.0、OpenCode 1.19.4 及以上。
- 没有内置适配器的 AI 编程工具，可以点「设置 › 协作群」里的「让 MerakCode 写适配器，帮你接入自己的 AI Coding 工具」，或者在普通对话里让 MerakCode 用技能「适配器生成助手」（`adapter-generator`）写一个成员适配器并注册好。技能以内置的三个适配器为示例：工具的通信方式和其中一个相同就照着改，都不同就参考它们自己写。也可以按 [SDK 手册的成员适配器一节](docs/sdk/README.md#15-成员适配器adapter) 自己写。

产品也可以写在配置里：

```jsonc
{
  "collaboration": {
    "products": {
      // 内置产品只需要改想改的字段，比如命令的位置或额外启动参数
      "codex": { "command": "/opt/codex/bin/codex", "args": ["-c", "model=\"o3\""] },
      // 自己的适配器
      "mycli": { "title": "MyCLI", "adapter": "member", "command": "node", "args": ["/path/to/adapter.mts"] },
    },
  },
}
```

## 配置

| 位置                                                          | 作用                                                                                                                                                     |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.merakcode/merakcode.jsonc`                                | 全局配置（模型、语言、权限规则等）。也认 `merakcode.json`，两个都在时 `.jsonc` 优先；桌面客户端和命令行改设置时写在这里                                  |
| `<项目>/.merakcode/merakcode.json`                            | 项目配置，覆盖全局配置。也认 `.jsonc`，以及项目根目录的 `merakcode.json(c)`；审批时选"总是允许"写在这里                                                  |
| `<项目>/AGENTS.md`                                            | 给 MerakCode 的项目说明（也认 `CLAUDE.md`，同一个目录下 `AGENTS.md` 优先）；`~/.merakcode/AGENTS.md` 和 `~/.claude/CLAUDE.md` 对所有项目生效             |
| `<项目>/.merakcode/agents/`、`skills/`、`commands/`、`rules/` | 自定义智能体、技能、斜杠命令、规则（`*.mdc`）。前三个放在 `~/.merakcode/` 下对所有项目生效。也会读 `.claude/skills`、`.agents/skills` 和 `.cursor/rules` |

配置文件可以写 JSON，也可以写带注释的 JSONC。开头写上 `"$schema"`，编辑器就能补全和检查：

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/TongTong313/merakcode/main/schema/config.json",
  "model": "anthropic/claude-sonnet-4-5",
  "locale": "zh-CN",
  "permission": {
    "bash": { "npm test *": "allow" },
    "bash_delete": { "rm -rf *": "deny" },
  },
  "sandbox": { "mode": "preferred" },
}
```

命令按级别分开写规则：`bash_readonly`（只读命令）、`bash`（其他命令）、`bash_delete`（删除）、`bash_risky`（高风险）、`bash_forbidden`（禁止的那些）。规则要写在命令所属的那一级下面才会生效，比如 `rm` 的规则写在 `bash` 下不起作用。全部的键和说明见 [schema](schema/config.json)。

配置里可以用 `{env:变量名}` 读环境变量，比如 `"apiKey": "{env:OPENAI_API_KEY}"`。

界面换成英文：桌面客户端在"设置 → 通用 → 语言"里切换（会写进全局配置，命令行也跟着变）。命令行默认中文，只看全局配置里的 `"locale"`，或者环境变量 `MERAKCODE_LOCALE=en-US`（优先于配置）。

引擎会联网刷新模型列表：启动后和之后每小时一次，用你保存的密钥向已连接的服务商拉取，另外不带密钥读取一次 openrouter.ai 的公开模型目录。设置环境变量 `MERAKCODE_DISABLE_CATALOG_FETCH=1` 可以关掉，`merak models --refresh` 手动刷新。

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

需要 Node.js 26.12 以上（PATH 上的 `node` 也要是这个版本）、pnpm 12，跑测试还要 PATH 上有 [ripgrep](https://github.com/BurntSushi/ripgrep)（`rg`）。

```sh
git clone https://github.com/TongTong313/merakcode.git
cd merakcode
pnpm install
pnpm hooks:install          # 提交前检查格式，提交时检查标题
```

### 从源码运行

| 想做的事         | 命令                                                                             |
| ---------------- | -------------------------------------------------------------------------------- |
| 开发桌面客户端   | `pnpm --dir apps/desktop/main dev`                                               |
| 运行命令行的命令 | `pnpm dev run --dir "$PWD" "解释一下这个项目"`                                   |
| 只启动引擎       | `pnpm dev serve --port 4096`                                                     |
| 用调试器调引擎   | `node --inspect --import ./script/node/register.mjs apps/cli/src/index.ts serve` |
| 把日志打到终端   | `pnpm dev serve --print-logs`（从源码运行时日志级别默认就是 DEBUG）              |

**特别注意**：桌面端开发时界面热更新；主进程的代码改完会自动重启应用；引擎的代码改完不会自动重启，在菜单「帮助 › 重启本地服务」里重启即可，窗口会自动重连。

`pnpm dev` 跑的是源码，不用先构建。改了代码重新运行就生效。它在 `apps/cli` 目录里运行，所以要用 `--dir` 指定项目目录，否则命令会把 `apps/cli` 当成项目。

### 测试和检查

```sh
pnpm check                                                  # 格式、类型、依赖边界、生成文件是否最新……提交前跑一遍
pnpm --dir packages/engine test                             # 每个包在自己的目录里跑测试
pnpm --dir apps/cli test test/cli/doctor-command.test.ts    # 只跑一个文件
```

### 打包

```sh
pnpm --dir apps/cli build --single      # 本机平台的命令行发布包，在 apps/cli/dist/ 下
pnpm --dir apps/desktop/main package    # 本机平台的桌面安装包，在 apps/desktop/main/release/ 下
```

打好的命令行版在 `apps/cli/dist/merakcode-<版本>-<平台>/bin/merak`（Windows 是 `merak.cmd`）。打包要从网上下载 Node 和 Electron，网络慢的话可以设置 `MERAKCODE_NODE_MIRROR`、`ELECTRON_MIRROR`、`ELECTRON_BUILDER_BINARIES_MIRROR` 换下载源；跑测试时没装 ripgrep 会从 GitHub 下载，可以用 `MERAKCODE_RIPGREP_BASE_URL` 换源。

### 生成文件

| 改了什么                              | 运行                                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 服务端接口                            | `pnpm generate:sdk`，再 `pnpm generate:sdk-reference`；SDK 接口快照变了再跑 `pnpm check:api --write` |
| 配置项                                | `pnpm generate:schema`                                                                               |
| 错误码                                | `pnpm generate:errors`                                                                               |
| `@merakcode/sdk/adapter` 或内置适配器 | `pnpm generate:adapter-library`                                                                      |
| SDK 公开接口                          | `pnpm check:api --write`                                                                             |

### 让 SDK 用源码版引擎

先在仓库里跑过 `pnpm install`；运行你程序的 Node 要是 26.12 以上。`--import` 后面要写成 `file://` 地址，Windows 上才认：

```ts
import { pathToFileURL } from "node:url"

const repo = "/path/to/merakcode"
const merak = await createMerakCode({
  executablePath: [
    process.execPath,
    "--import",
    pathToFileURL(`${repo}/script/node/register.mjs`).href,
    `${repo}/apps/cli/src/index.ts`,
  ],
})
```

### 代码结构

```text
apps/cli              merak 命令；merak serve 就是引擎，桌面客户端内置的也是它
apps/desktop/main     桌面客户端主进程（Electron）
apps/desktop/renderer 桌面客户端界面（SolidJS）
packages/engine       引擎：会话、模型、工具、权限、HTTP 和事件流服务
  src/agent           智能体 loop、会话、上下文、模型、工具与权限
  src/infra           沙箱、配置 IO、存储、进程与工作区机制
  src/app             任务、项目和会话编排、server 与 host
packages/sdk/js       TypeScript SDK
packages/util、log    共用的工具函数和日志
```

桌面客户端和命令行的命令（`serve`、`generate`、`debug` 除外）都不直接引用引擎代码，而是通过 SDK 启动一个 `merak serve` 进程，再走 HTTP 和事件流通信。`pnpm check` 会检查这条边界。更多约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

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

本项目实现参考了部分 [opencode](https://github.com/anomalyco/opencode) 项目代码，在此表示感谢。许可证声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
