# MerakCode SDK 手册

简体中文 · [English](README.en.md)

用 `@merakcode/sdk`，你可以在自己的 TypeScript / JavaScript 程序里使用 MerakCode：开会话、发消息、拿回复、处理审批，还能把自己写的函数交给模型调用。

所有接口的完整列表见 [接口参考](reference.md)。

**目录**

1. [概述](#1-概述)
2. [安装和要求](#2-安装和要求)
3. [快速开始](#3-快速开始)
4. [核心概念](#4-核心概念)
5. [高层 API](#5-高层-api)
6. [审批、提问和中止](#6-审批提问和中止)
7. [扩展：宿主工具、项目工具和插件](#7-扩展宿主工具项目工具和插件)
8. [底层客户端](#8-底层客户端)
9. [进程管理](#9-进程管理)
10. [会话状态（store）](#10-会话状态store)
11. [导出会话（transcript）](#11-导出会话transcript)
12. [错误处理](#12-错误处理)
13. [日志和调试](#13-日志和调试)
14. [版本兼容](#14-版本兼容)
15. [成员适配器（adapter）](#15-成员适配器adapter)

## 1. 概述

```text
你的程序 ──@merakcode/sdk──► 引擎进程（merak serve）──► 模型服务
                 HTTP + 事件流            │
                                         └─► 读写文件、跑命令（权限审批 + 系统沙箱）
```

SDK 本身不调用模型。它在后台启动一个引擎进程（就是 `merak serve`，和命令行版、桌面端用的是同一个引擎），然后通过 HTTP 和事件流跟它通信。会话、工具、权限、沙箱都在引擎里。

SDK 分成几个入口，按需要选：

| 入口                        | 用来做什么                                                                       |
| --------------------------- | -------------------------------------------------------------------------------- |
| `@merakcode/sdk`            | 高层 API：`createMerakCode` 一步启动引擎、开会话、跑对话。大多数场景用这个就够了 |
| `@merakcode/sdk/client`     | 底层 HTTP 客户端，覆盖引擎的全部接口。浏览器里也能用                             |
| `@merakcode/sdk/process`    | 只负责启动和关闭引擎进程，客户端你自己建                                         |
| `@merakcode/sdk/store`      | 把引擎推来的事件整理成会话、消息、审批等状态，适合做界面。浏览器里也能用         |
| `@merakcode/sdk/plugin`     | 写插件、写项目里的自定义工具时用的类型和 `tool()`                                |
| `@merakcode/sdk/transcript` | 把会话导出成 Markdown                                                            |
| `@merakcode/sdk/adapter`    | 写协作群的成员适配器，让协作群驱动你的 AI 编程工具                               |
| `@merakcode/sdk/errors`     | 错误类 `MerakCodeError` 和相关函数。浏览器里也能用                               |

## 2. 安装和要求

```sh
npm install @merakcode/sdk
```

- 需要 Node.js 24 或更新的版本。
- 支持 Windows、macOS、Linux 的 x64 和 arm64。Linux 要用 glibc 的发行版；Alpine 这类 musl 系统装不上引擎包，要用 `executablePath` 自己指定引擎。
- 安装时 npm 会按你的系统装上一个引擎包，名字是 `merakcode-<系统>-<架构>`（比如 `merakcode-windows-x64`），里面自带 Node 和引擎，所以体积比较大。它是可选依赖，用了 `--omit=optional` 或者换了一台不同系统的机器跑，就会找不到引擎，报 `MRK-1001`。

**用别的引擎。** 不想用 npm 装的引擎时，用 `executablePath` 指定：

- 一个可执行文件：macOS / Linux 上可以直接写装好的 `merak`，比如 `~/.merakcode/versions/<版本>/bin/merak`。
- 一个命令前缀数组：Windows 上 `merak.cmd` 不能直接启动，要写成 `[<版本目录>\node\node.exe, <版本目录>\lib\index.js]`；从源码运行就写成下面这样（先在仓库里 `pnpm install`，运行你程序的 Node 要是 26.12 以上；`--import` 后面要写成 `file://` 地址，Windows 上才认）。

```ts
import { pathToFileURL } from "node:url"
import { createMerakCode } from "@merakcode/sdk"

const repo = "/path/to/merakcode"
const merak = await createMerakCode({
  executablePath: [
    process.execPath,
    "--import",
    pathToFileURL(`${repo}/script/node/register.mjs`).href,
    `${repo}/apps/cli/src/index.ts`,
  ],
})
await merak.close()
```

**连接已经在运行的引擎。** 用 `url` 代替启动新进程。引擎如果设置了口令（环境变量 `MERAKCODE_SERVER_PASSWORD`），按 HTTP Basic 认证带上，用户名默认是 `merakcode`（引擎设置了 `MERAKCODE_SERVER_USERNAME` 时用它）：

```ts
import { createMerakCode } from "@merakcode/sdk"

const password = process.env.MERAKCODE_SERVER_PASSWORD ?? ""
const merak = await createMerakCode({
  url: "http://127.0.0.1:4096",
  headers: { authorization: `Basic ${Buffer.from(`merakcode:${password}`).toString("base64")}` },
  cwd: "/path/to/project",
})
await merak.close()
```

这时 `close()` 只断开连接，不会关掉那个引擎。另外要注意：用 `url` 连接时，引擎退出或者事件流连不上（地址、口令不对）都不会抛错，SDK 会每隔 3 到 30 秒重连，断开期间的事件会丢，正在等事件的迭代会一直等。可以给 `run` 传 `signal` 设个上限。

## 3. 快速开始

```ts
import { createMerakCode } from "@merakcode/sdk"

const merak = await createMerakCode({ cwd: process.cwd() })
try {
  const session = await merak.session()
  for await (const event of session.run("用一句话介绍你自己。")) {
    if (event.type === "text") process.stdout.write(event.delta)
    if (event.type === "error") console.error(event.error.code, event.error.message)
  }
} finally {
  await merak.close()
}
```

用的模型是你已经连接好的模型服务的默认模型（在配置里写过 `options.apiKey`，用 `merak provider login` 连过，或者在桌面端「设置 → 模型与供应商」里填过密钥）。还没连接过的话，先运行 `merak provider login` 连一个，或者在 `config` 选项里写上（见第 5 节）。

仓库里有三个可以直接跑的示例，在 [`packages/sdk/js/examples`](../../packages/sdk/js/examples)：

| 文件             | 内容                                     |
| ---------------- | ---------------------------------------- |
| `minimal.ts`     | 开一个会话，发一句话，边收边打印回复     |
| `custom-tool.ts` | 定义一个查库存的工具，让模型调用它       |
| `batch.ts`       | 一个引擎同时开几个会话，各自总结一个文件 |

## 4. 核心概念

- **引擎**：一个 `merak serve` 进程。一个引擎可以同时服务多个会话，也可以服务多个项目目录。
- **会话**（session）：一次对话。智能体派出的子智能体、后台工作流会建**子会话**，子会话的 `parentID` 指向父会话。
- **消息和 Part**：每条消息（`role` 是 `user` 或 `assistant`）由若干 Part 组成。常见的 Part：`text`（正文）、`reasoning`（思考过程）、`tool`（一次工具调用，含参数、状态和输出）、`file`（附件）、`step-start` / `step-finish`（一步的开始和结束，带用量）、`patch`（这一步改了哪些文件）、`subtask`、`agent`、`retry`、`compaction`。
- **智能体**（agent）：决定用什么提示词、能用哪些工具。默认是 `build`；子智能体有 `general`、`explore`；`simplifier` 两种都能当。可以在配置里自己加。
- **模型**：写成 `服务商/模型`，比如 `anthropic/claude-sonnet-4-5`、`alibaba-cn/qwen-plus`。`merak models` 能列出可用的。
- **权限模式**：`readonly`（只读）、`ask`（询问，默认）、`auto`（自动）。会改东西的操作是直接做、先问，还是不做，由它和你的权限规则决定。
- **事件**：引擎把所有变化（新消息、Part 更新、审批请求、会话状态……）通过事件流推出来。高层 API 帮你只挑出当前会话的事件。

## 5. 高层 API

### createMerakCode(options)

启动（或连接）一个引擎，返回 `MerakCode` 对象。选项（类型 `MerakCodeOptions`，包含 `EngineOptions` 的全部字段）：

| 选项             | 说明                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `cwd`            | 项目目录。启动引擎时是引擎的工作目录，请求也都针对这个目录                                                                     |
| `executablePath` | 引擎命令，见第 2 节。默认用 npm 装的引擎包                                                                                     |
| `env`            | 追加给引擎进程的环境变量（会和当前进程的环境变量合并）                                                                         |
| `config`         | 内联配置，写法和 `merakcode.json` 一样，优先级最高                                                                             |
| `agents`         | 自定义智能体，写法同配置里的 `agent` 段（类型 `AgentConfig`）。同时给了 `config.agent` 时，`agents` 会整个替换它               |
| `timeout`        | 等引擎启动的最长时间，毫秒，默认 60000                                                                                         |
| `serve`          | 传给 `merak serve` 的参数，默认 `["--hostname", "127.0.0.1", "--port", "0"]`（只监听本机的随机端口）                           |
| `signal`         | 取消启动（传入时已经中止的 `signal` 不会取消启动）                                                                             |
| `logger`         | 日志回调，见第 13 节                                                                                                           |
| `url`            | 连接已经在运行的引擎，不再启动新进程                                                                                           |
| `headers`        | 连接已有引擎时带的请求头（口令等）                                                                                             |
| `tools`          | 宿主工具，见第 7 节                                                                                                            |
| `clientRun`      | 你自己的运行编号或追踪编号，引擎会把它写进每条请求日志。只能用字母、数字和 `_`、`.`、`:`、`-`，最长 100 个字符，否则引擎不记录 |

`config`、`agents`、`env`、`timeout`、`serve`、`executablePath`、`signal` 只在启动新引擎时有效；用 `url` 连接时会被忽略。

```ts
import { createMerakCode } from "@merakcode/sdk"

const merak = await createMerakCode({
  cwd: process.cwd(),
  config: {
    model: "alibaba-cn/qwen-plus",
    provider: { "alibaba-cn": { options: { apiKey: process.env.DASHSCOPE_API_KEY } } },
  },
  agents: {
    reviewer: {
      description: "只读地审查代码，指出问题",
      prompt: "你是一个严格的代码审查员。只指出问题，不要改代码。",
      mode: "primary",
      permission: { edit: "deny", bash: "deny" },
    },
  },
})
await merak.close()
```

返回的 `MerakCode`：

| 成员             | 说明                                                               |
| ---------------- | ------------------------------------------------------------------ |
| `client`         | 底层客户端（第 8 节），想调高层 API 没覆盖的接口时用               |
| `url`            | 引擎地址                                                           |
| `pid`            | 引擎进程号；用 `url` 连接时是 `undefined`                          |
| `session(input)` | 新建会话；传 `id` 就是拿回已有的会话。还可以传 `title`、`parentID` |
| `close()`        | 关闭：停掉宿主工具，关掉自己启动的引擎                             |

### 会话 MerakCodeSession

| 成员                   | 说明                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| `id`、`info`           | 会话编号和信息。`info` 是新建或取回时的快照，之后生成的标题不会更新进来，要最新的用 `client.session.get` |
| `run(prompt, options)` | 发一条消息，返回这一轮的事件流。这一轮结束时产出 `done`，然后结束                                        |
| `events(handlers)`     | 这个会话之后的所有事件，不限于一轮。后台工作流做完会再给会话发一轮，用它接着等。中止 `signal` 时结束     |
| `messages()`           | 会话里的所有消息和 Part                                                                                  |
| `abort()`              | 停掉正在跑的这一轮（排队的消息会接着执行）                                                               |

`run` 的选项（`RunOptions`，包含 `Handlers` 的全部字段）：

| 选项           | 说明                                                        |
| -------------- | ----------------------------------------------------------- |
| `model`        | 这一轮用的模型，写成 `服务商/模型`                          |
| `agent`        | 这一轮用的智能体                                            |
| `mode`         | 权限模式：`"readonly"`、`"ask"`、`"auto"`                   |
| `onPermission` | 需要审批时调用，见第 6 节。不给的话，需要审批的请求一律拒绝 |
| `onQuestion`   | 模型提问时调用，见第 6 节。不给的话跳过提问                 |
| `signal`       | 中止这一轮                                                  |

`run` 产出的事件（`RunEvent`）有 5 种：

| `type`      | 内容                                                                                                                                                                                                                    |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`      | 回复正文的一小段（`delta`），边生成边到；`partID` 区分不同的正文段落                                                                                                                                                    |
| `reasoning` | 思考过程的一小段，开了思考的模型才有。有的模型会把结论只写在思考里，正文是空的                                                                                                                                          |
| `part`      | 其他所有 Part 的完整最新状态，比如工具调用开始、完成。也包括你发出的这条消息的 Part，以及生成完的正文和思考（`text`、`reasoning` 的完整内容，前面已经以 `delta` 到过）                                                  |
| `error`     | 这一轮出错了（`error` 是 `MerakCodeError`），可能不止一个。出错时这一轮已经生成了回复消息的（比如密钥不对、额度用完），之后还会有 `done`；还没生成的（比如模型名写错），可能没有 `done`，或者 `done` 带的是上一轮的回复 |
| `done`      | 这一轮结束，`message` 是这个会话最后一条回复消息，里面有 `cost`（费用）和 `tokens`（用量）                                                                                                                              |

```ts
import { createMerakCode } from "@merakcode/sdk"

const merak = await createMerakCode({ cwd: process.cwd() })
const session = await merak.session({ title: "改 README" })
let answer = ""
for await (const event of session.run("README 里有错别字吗？只列出来，不要改。", { mode: "readonly" })) {
  if (event.type === "text") answer += event.delta
  if (event.type === "part" && event.part.type === "tool")
    console.log("工具：", event.part.tool, event.part.state.status)
  if (event.type === "done") console.log("花费：", event.message.cost, "输出 token：", event.message.tokens.output)
}
console.log(answer)
await merak.close()
```

同一个会话同时只跑一个 `run()`：同时发的消息会排队执行，两个迭代会收到彼此的事件，并在两轮都结束后才各自收到同一个 `done`。要并发就开多个会话（见 `batch.ts`）。

## 6. 审批、提问和中止

### 审批

智能体要改文件、跑命令、联网时，如果按权限模式和规则需要问人，引擎会发一个审批请求（`PermissionRequest`），SDK 调用你的 `onPermission`。子智能体和工作流的审批也会转到这里。

不是每个操作都会问：默认的 `ask` 模式下，工作区里普通文件的修改直接执行；`auto` 模式下大多数命令和宿主工具也直接执行（规则见 [README 的权限和沙箱](../../README.md#权限和沙箱)）。想让每次改文件都经过你，在 `config` 里写 `permission: { edit: "ask" }`，或者用 `readonly` 模式。

`PermissionRequest` 里常用的字段：

| 字段         | 说明                                                                                                                                                                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `permission` | 要做的事：`read`、`edit`、`bash`、`sandbox`（命令要离开沙箱，或者写工作区外的目录）、`network`、`mcp`、`subagent`、`workflow_run`、`cron`、`skill`，或者工具的名字。危险程度不在这里区分：`git push` 也是 `bash`，改工作区外的文件也是 `edit` |
| `patterns`   | 具体对象，比如命令内容、文件路径、域名                                                                                                                                                                                                        |
| `metadata`   | 附加信息，不同操作不一样，比如命令的说明、要改的内容                                                                                                                                                                                          |
| `sessionID`  | 发起请求的会话；`root` 是它所属的最上层会话                                                                                                                                                                                                   |
| `tool`       | 是哪次工具调用触发的                                                                                                                                                                                                                          |

返回 `PermissionDecision` 之一：

- `"allow-once"`：只允许这一次
- `"allow-session"`：这个会话里同一范围的请求都允许：命令按前缀（比如 `npm install *`），文件按这个文件或它所在的目录
- `"always"`：总是允许，写进项目配置。请求的 `always` 为 `false` 时（子智能体、工作流、沙箱权限、改 MerakCode 的配置文件）只在这个会话里生效
- `"deny"`：拒绝

没给 `onPermission` 时，需要审批的请求一律拒绝：宿主没表态，就不放行。

审批和提问只在你迭代 `run()` 或 `events()` 的过程中处理。提前 `break` 之后再来的请求没人回复，这一轮会一直等，要先调用 `session.abort()`。回调里不要抛错：错误不会传给你，请求也不会被回复。排查卡住的一轮时，`client.permission.list()` 和 `client.question.list()` 能列出还没回复的请求。

下面的例子让每次改文件都先问宿主：

```ts
import { createMerakCode } from "@merakcode/sdk"

const merak = await createMerakCode({ cwd: process.cwd(), config: { permission: { edit: "ask" } } })
const session = await merak.session()
const run = session.run("把 package.json 里的版本号改成 1.2.0", {
  onPermission: (request) => {
    console.log("审批：", request.permission, request.patterns.join(", "))
    return request.permission === "edit" ? "allow-once" : "deny"
  },
})
for await (const event of run) if (event.type === "text") process.stdout.write(event.delta)
await merak.close()
```

### 提问

模型有时会停下来问你选择题（`QuestionRequest`）。`questions` 里每一题有 `question`（题目）、`header`（短标题）、`options`（选项，每项有 `label` 和 `description`），`multiple` 表示能多选，`custom` 表示能自己写答案（模型提的问题都能）。子智能体的提问也会转到这里；`auto` 模式下模型不会提问。

`onQuestion` 按题目顺序返回每一题的答案，每题是一个字符串数组：选中的 `label`，或者自己写的文字。没给 `onQuestion` 时这次提问会被跳过，模型会知道你没有回答。

```ts
import { createMerakCode } from "@merakcode/sdk"

const merak = await createMerakCode({ cwd: process.cwd() })
const session = await merak.session()
const run = session.run("帮我初始化一个新项目，先问我用什么语言", {
  onQuestion: (request) => request.questions.map((question) => [question.options[0]?.label ?? "TypeScript"]),
})
for await (const event of run) if (event.type === "text") process.stdout.write(event.delta)
await merak.close()
```

### 中止和超时

- 给 `run` 传 `signal`，中止后引擎会停掉这一轮，迭代抛出 `AbortError`。
- 也可以调用 `session.abort()`。
- SDK 自己启动的引擎意外退出时，正在等事件的迭代会抛出 `EngineExitedError`（`MRK-1004`）。用 `url` 连接的引擎不会这样，见第 2 节。
- 直接用底层客户端时，可以用 `withRequestDeadline` 给一次请求加时限，超时抛 `RequestTimeoutError`（`MRK-1007`）。时限默认 5 秒，可以用 `timeout` 改；还可以传 `signal`，测试里可以传自己的 `timer`（`RequestDeadlineTimer`）。选项类型是 `RequestDeadlineOptions`。

```ts
import { createMerakCode, withRequestDeadline } from "@merakcode/sdk"

const merak = await createMerakCode({ cwd: process.cwd() })
const session = await merak.session()

const controller = new AbortController()
setTimeout(() => controller.abort(), 60_000)
try {
  for await (const event of session.run("把所有测试跑一遍", { signal: controller.signal, mode: "auto" }))
    if (event.type === "text") process.stdout.write(event.delta)
} catch (error) {
  if (error instanceof Error && error.name === "AbortError") console.log("超过一分钟，停了")
}

const health = await withRequestDeadline((signal) => merak.client.global.health({ signal }), { timeout: 2_000 })
console.log(health.data?.version)
await merak.close()
```

### 等后台任务

你明确让智能体用工作流时（提示词里写了"工作流"或 "workflow"），它会在后台启动工作流，这一轮先结束；工作流做完后，引擎给这个会话发一条通知（正文里有 `<workflow-notification>`），模型再回复一轮。启动工作流（`workflow_run`）在 `ask` 模式下要审批。

- 先用 `events()` 订阅，再调用 `run()`，否则可能错过工作流结束后的那一轮。
- 工作流做得快时，两轮会连在一起，只产出一个 `done`，所以不要靠数 `done`，要等看到通知之后的那个 `done`。
- 同一个会话上同时开着的每个迭代都会回复审批，给它们同样的 `onPermission`。

```ts
import { createMerakCode, type PermissionDecision } from "@merakcode/sdk"

const merak = await createMerakCode({ cwd: process.cwd() })
const session = await merak.session()
const onPermission = (): PermissionDecision => "allow-once"
const controller = new AbortController()
const later = (async () => {
  let notified = false
  for await (const event of session.events({ signal: controller.signal, onPermission })) {
    if (event.type === "text") process.stdout.write(event.delta)
    if (event.type === "part" && event.part.type === "text" && event.part.text.includes("<workflow-notification>"))
      notified = true
    if (event.type === "done" && notified) controller.abort()
  }
})()
for await (const _ of session.run("用工作流在后台把 docs 目录里的文档都翻译成英文", { onPermission }));
await later
await merak.close()
```

## 7. 扩展：宿主工具、项目工具和插件

有三种方式给模型加能力：

| 方式     | 代码在哪里运行 | 适合                                                    |
| -------- | -------------- | ------------------------------------------------------- |
| 宿主工具 | 你自己的程序里 | 用你程序里现成的数据和函数，比如查数据库、调内部接口    |
| 项目工具 | 引擎进程里     | 跟着项目走，所有用这个项目的人（终端、桌面、SDK）都能用 |
| 插件     | 引擎进程里     | 除了加工具，还要在引擎的各个环节插手：改参数、拦请求等  |

项目工具和插件在引擎进程里运行，不在沙箱里，权限和你本人一样，只用你信任的。

### 宿主工具

用 `tool()` 定义（类型 `HostTool`），传给 `createMerakCode` 的 `tools`。模型调用时，引擎把调用转回你的程序执行，再把结果交给模型。

| 字段          | 说明                                                                                                                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | 工具名，也是审批时的 `permission`。字母开头，只能用字母、数字、`_`、`-`，最长 64 个字符，否则 `createMerakCode` 报 `MRK-1009`；和内置工具（`bash`、`read`、`edit`、`write` 等）重名的会被忽略 |
| `description` | 给模型看的说明，写清楚什么时候用                                                                                                                                                              |
| `args`        | 参数，用 zod 写成 `{ 参数名: schema }`                                                                                                                                                        |
| `run`         | `(args, context) => string`，可以是异步的。抛出的错误信息会交给模型                                                                                                                           |

`context`（类型 `ToolRunContext`）里有 `sessionID`、`messageID`、`callID`。

宿主工具和插件注册的工具一样审批：只读和询问模式先问，自动模式直接执行，审批名就是工具名。

宿主工具注册在整个引擎进程上：之后任何一次注册都会整体替换它，`close()` 也不会注销。几个程序用 `url` 连同一个引擎时，会互相覆盖对方的宿主工具。

```ts
import { createMerakCode, tool } from "@merakcode/sdk"
import { z } from "zod"

const stock = tool({
  name: "stock",
  description: "查询仓库里某种水果的库存数量",
  args: { fruit: z.string().describe("水果的英文名，比如 apple") },
  run: ({ fruit }, context) => {
    console.log(`会话 ${context.sessionID} 在查 ${fruit}`)
    return fruit === "apple" ? "12" : "0"
  },
})

const merak = await createMerakCode({ cwd: process.cwd(), tools: [stock] })
const session = await merak.session()
const run = session.run("仓库里还有几个苹果？", {
  onPermission: (request) => (request.permission === "stock" ? "allow-once" : "deny"),
})
for await (const event of run) if (event.type === "text") process.stdout.write(event.delta)
await merak.close()
```

### 项目工具

在项目的 `.merakcode/tool/` 目录（或全局的 `~/.merakcode/tool/`）放一个 `.ts` 或 `.js` 文件。默认导出的工具名就是文件名；其他具名导出的工具名是 `文件名_导出名`。在配置里写 `"tools": { "文件名": false }` 可以关掉它。

`@merakcode/sdk/plugin` 和 zod 不用自己装：引擎会在 `.merakcode` 目录里放好 `@merakcode/sdk/plugin`，缺 zod 时会自动用 npm 装上（第一次需要联网）。

```ts
// .merakcode/tool/weather.ts
import { tool } from "@merakcode/sdk/plugin"

export default tool({
  description: "查某个城市今天的天气",
  args: { city: tool.schema.string().describe("城市名") },
  async execute(args, context) {
    context.metadata({ title: `查 ${args.city} 的天气` })
    const response = await fetch(`https://wttr.in/${encodeURIComponent(args.city)}?format=3`, { signal: context.abort })
    return response.text()
  },
})
```

`execute` 的 `context`（类型 `ToolContext`）：

| 字段                              | 说明                                                                    |
| --------------------------------- | ----------------------------------------------------------------------- |
| `sessionID`、`messageID`、`agent` | 是哪个会话、哪条消息、哪个智能体调用的                                  |
| `directory`、`worktree`           | 项目目录和 git 工作区根目录。解析相对路径时用它们，别用 `process.cwd()` |
| `abort`                           | 这次调用被取消时触发                                                    |
| `metadata(input)`                 | 更新界面上显示的标题和附加数据                                          |
| `ask(input)`                      | 主动请求一次审批，被拒绝时会抛错                                        |

返回值（类型 `ToolResult`）可以是字符串，也可以是 `{ title, output, metadata, attachments }`。`normalizeToolResult` 把两种写法统一成对象。`tool()` 返回的类型是 `ToolDefinition`。

### 插件

插件可以从三个地方加载：

- 项目的 `.merakcode/plugin/` 或全局的 `~/.merakcode/plugin/` 目录里的 `.ts` / `.js` 文件；
- 配置里的 `plugin` 数组，写 npm 包名（可以带版本），比如 `"plugin": ["my-merak-plugin@1.0.0"]`；
- 带参数的写法：`"plugin": [["my-merak-plugin", { "level": "strict" }]]`。

插件模块导出一个函数（类型 `Plugin`），或者 `{ id, server, options }`（类型 `PluginModule`，`server` 就是那个函数）。函数收到 `PluginInput`，返回 `Hooks`：

| `PluginInput` 字段                 | 说明                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `client`                           | 连接当前引擎的客户端                                                                                                     |
| `project`、`directory`、`worktree` | 当前项目、目录和 git 工作区根目录                                                                                        |
| `serverUrl`                        | 引擎地址                                                                                                                 |
| `$`                                | 跑命令的模板函数（类型 `PluginShell`），比如 ``await $`git status`.text()``                                              |
| `options`                          | 这个插件的参数（类型 `PluginOptions`）：模块自带的 `options`、配置里的写法、配置 `plugin_options[id]` 合并而成，后者优先 |
| `dataDirectory`                    | 这个插件专用的数据目录。不会提前建好，写之前先 `mkdir`                                                                   |

`$` 的用法和 zx 类似：`` $`cmd ${arg}` `` 返回 `PluginShellPromise`，可以 `.text()`、`.json()`、`.lines()`、`.quiet()`、`.nothrow()`、`.cwd(dir)`、`.env(vars)`；结果是 `PluginShellOutput`（`stdout`、`stderr`、`exitCode`）；命令失败时抛 `PluginShellError`。插值的类型是 `ShellExpression`，会自动加引号。

`Hooks` 里的每一项都是可选的：

| Hook                                         | 什么时候调用                                               | 能做什么                                                                                            |
| -------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `tool`                                       | 加载时                                                     | 注册工具，写法同项目工具                                                                            |
| `config`                                     | 加载时，拿到合并后的配置                                   | 读配置、校验自己的参数                                                                              |
| `event`                                      | 引擎每发出一个事件                                         | 监听会话、消息、审批等变化                                                                          |
| `auth`                                       | 用户登录某个服务商时（`merak provider login`、桌面端设置） | 提供 OAuth 或 API 密钥登录方式（类型 `AuthHook`，OAuth 结果是 `AuthOAuthResult`）                   |
| `provider`                                   | 列模型、调模型时                                           | `providers()` 注册整套服务商；`models()` 替换某个服务商的模型列表；`fetch()` 包住发往模型的网络请求 |
| `chat.message`                               | 收到用户消息                                               | 改消息内容和 Part                                                                                   |
| `chat.params`                                | 调模型之前                                                 | 改 `temperature`、`topP`、`topK`、`maxOutputTokens` 和其他参数（`provider` 是 `ProviderContext`）   |
| `chat.headers`                               | 调模型之前                                                 | 加请求头                                                                                            |
| `permission.ask`                             | 要审批时                                                   | 把 `status` 改成 `allow` 或 `deny`，直接替用户决定                                                  |
| `command.execute.before`                     | 执行斜杠命令之前                                           | 改命令展开后的 Part                                                                                 |
| `tool.execute.before`                        | 工具执行之前                                               | 改参数 `args`                                                                                       |
| `tool.execute.after`                         | 工具执行之后                                               | 改标题、输出、附加数据                                                                              |
| `tool.definition`                            | 把工具列表发给模型之前                                     | 改某个工具的说明和参数                                                                              |
| `shell.env`                                  | 跑命令之前                                                 | 加环境变量                                                                                          |
| `experimental.chat.messages.transform`       | 把历史消息发给模型之前                                     | 改发给模型的消息                                                                                    |
| `experimental.chat.system.transform`         | 组装系统提示词时                                           | 改系统提示词                                                                                        |
| `experimental.chat.guard`                    | 用户消息存下来之后、开始干活之前                           | `refuse: true` 拒绝这一轮，`message` 作为回复                                                       |
| `experimental.text.complete`                 | 每段正文生成完                                             | 改这段正文                                                                                          |
| `experimental.message.complete.transform`    | 整条回复写入之前                                           | 改整条回复的文字，比如做内容审核                                                                    |
| `experimental.tool.path.guard`               | 工具算出要读写的绝对路径之后、真正读写之前                 | 把路径加进 `denied` 禁止访问（只能禁止，不能放行）                                                  |
| `experimental.session.compacting`            | 压缩会话之前                                               | 补充上下文，或者换掉压缩用的提示词                                                                  |
| `experimental.compaction.messages.transform` | 压缩时，消息交给总结模型之前                               | 改或过滤消息                                                                                        |
| `experimental.compaction.summary.transform`  | 总结写回会话之前                                           | 改总结内容                                                                                          |
| `dispose`                                    | 引擎关闭或插件卸载时                                       | 释放进程、定时器等资源                                                                              |

`experimental.` 开头的 Hook 以后可能会改。

```ts
// .merakcode/plugin/guard.ts
import type { Plugin } from "@merakcode/sdk/plugin"

export const guard: Plugin = async ({ directory, $ }) => {
  const branch = (await $`git -C ${directory} branch --show-current`.nothrow().text()).trim()
  return {
    "permission.ask": async (input, output) => {
      if (
        branch === "main" &&
        input.permission === "bash" &&
        input.patterns.some((item) => item.startsWith("git push"))
      )
        output.status = "deny"
    },
    "tool.execute.after": async (input, output) => {
      if (input.tool === "bash") output.output = output.output.slice(0, 20_000)
    },
  }
}
```

## 8. 底层客户端

`createMerakCodeClient` 返回的客户端覆盖引擎的全部接口，按功能分组：`client.session`、`client.permission`、`client.provider`、`client.file`、`client.mcp` 等。每个方法、参数和返回值见 [接口参考](reference.md)。它不依赖 Node：在浏览器里用时从 `@merakcode/sdk/client` 引入（主入口带着启动进程的代码）。网页的来源不是 `localhost`、`127.0.0.1` 时，引擎要用 `merak serve --cors <来源>` 放行。

配置项（`MerakCodeClientConfig` 加上下面几项）：

| 选项               | 说明                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`          | 引擎地址                                                                                                                                    |
| `headers`          | 请求头，比如口令                                                                                                                            |
| `directory`        | 项目目录，每个请求都会带上                                                                                                                  |
| `workspaceFolders` | 多根工作区的各个目录（`{ name?, path }[]`）                                                                                                 |
| `clientRun`        | 你的运行编号，写进引擎的请求日志                                                                                                            |
| `logger`           | 每个失败的请求都会调用它                                                                                                                    |
| `fetch`            | 换成你自己的 fetch。默认的 fetch 用的是不限时的连接池；换掉以后，Node 自带的 fetch 会在 5 分钟时断开很长的同步请求（比如 `session.prompt`） |
| `throwOnError`     | 为 `true` 时出错直接抛出引擎返回的错误内容，不再返回 `{ error }`                                                                            |

每个方法的第一个参数是一个对象，路径参数、查询参数和请求体字段都平铺在里面（没有参数的方法，比如 `global.health`，第一个参数就是下面说的选项）；第二个参数可以传 `signal`、`headers`、`throwOnError`。返回 `{ data, error, response }`：成功时 `data` 有值，失败时 `error` 有值。用 `fromResponse(error, response)` 把错误变成 `MerakCodeError`。

`client.event.subscribe()` 返回 `{ stream }`，是当前目录所有事件的异步迭代器。它在开始迭代后才真正连上引擎，连上后第一个事件是 `server.connected`：要在这之后再发消息，否则开头的事件会丢。`client.global.event()` 是所有目录的事件，每一项是 `{ directory, payload }`：`payload` 是事件本身，`directory` 是它属于哪个项目目录（`server.connected` 这类不属于任何目录的事件没有它）。

```ts
import { createMerakCodeClient, fromResponse } from "@merakcode/sdk"
import { startEngine } from "@merakcode/sdk/process"

const engine = await startEngine({ cwd: process.cwd() })
const client = createMerakCodeClient({ baseUrl: engine.url, headers: engine.headers, directory: process.cwd() })

const sessions = await client.session.list()
if (sessions.error) throw fromResponse(sessions.error, sessions.response)
console.log(sessions.data.map((session) => session.title))

const created = await client.session.create({ title: "底层客户端示例" }, { throwOnError: true })
const controller = new AbortController()
const events = await client.event.subscribe(undefined, { signal: controller.signal })
const stream = events.stream[Symbol.asyncIterator]()
await stream.next() // server.connected：连上了才发消息
await client.session.promptAsync({ sessionID: created.data.id, parts: [{ type: "text", text: "你好" }] })
for (let next = await stream.next(); !next.done; next = await stream.next()) {
  if (next.value.type === "session.idle" && next.value.properties.sessionID === created.data.id) break
}
controller.abort()
await engine.close()
```

## 9. 进程管理

`@merakcode/sdk/process` 只管引擎进程：

- `startEngine(options)`：启动引擎，等它开始监听后返回 `Engine`。选项就是第 5 节表里的 `cwd`、`executablePath`、`env`、`config`、`timeout`、`serve`、`signal`、`logger`（类型 `EngineOptions`）。默认每次启动都用随机端口和一次性口令（自己传 `serve` 又没写 `--port` 时，引擎先试 4096），口令只通过环境变量交给引擎。
- `resolveEngine()`：返回 npm 装的引擎包的启动命令（数组），找不到时抛 `MRK-1001`。

`Engine`：

| 成员      | 说明                                             |
| --------- | ------------------------------------------------ |
| `url`     | 引擎地址，比如 `http://127.0.0.1:53124`          |
| `headers` | 访问引擎要带的请求头（含口令）                   |
| `pid`     | 进程号                                           |
| `exited`  | 进程退出时完成，值是退出码（正常关闭是 0）       |
| `close()` | 让引擎正常退出并等它结束，8 秒内没退出就强制结束 |

引擎和你的程序之间有一条 IPC 通道。你的程序退出或崩溃时通道断开，引擎会自己退出，不会留下孤儿进程。反过来，引擎还在运行时，你的程序不会自己退出，所以用完一定要 `close()`，最好写在 `finally` 里。

启动失败抛 `EngineStartError`：`output` 是引擎最后的输出，错误信息里带了最后 5 行。超时是 `MRK-1002`，其他启动失败是 `MRK-1003`，被 `signal` 取消是 `MRK-4002`。

## 10. 会话状态（store）

做界面时，需要把源源不断的事件整理成"有哪些会话、每个会话有哪些消息、哪些在等审批"。`@merakcode/sdk/store` 就做这件事，不依赖任何界面框架，浏览器里也能用：

| 函数 / 类型                  | 说明                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createSessionsState()`      | 新建一个空状态（类型 `SessionsState`）                                                                                                                              |
| `applyEvent(state, event)`   | 把一个事件合并进状态，直接修改传入的对象。返回 `Change`：`insert`、`update`、`remove`、`replace`、`none`、`ignored`                                                 |
| `activity(state, sessionID)` | 会话现在的状态（`Activity`）：`approval`（等审批）、`question`（等回答）、`running`、`idle`。子会话的状态算在最上层会话头上，后台子会话（比如回复后的记忆提取）不算 |
| `rootOf(state, sessionID)`   | 顺着 `parentID` 找到最上层会话                                                                                                                                      |
| `forgetSession(state, id)`   | 删掉某个会话缓存的全部数据                                                                                                                                          |
| `search(list, id, key)`      | 在按 id 排好序的列表里二分查找，返回 `{ found, index }`                                                                                                             |

状态从空开始，只合并之后来的事件；已有的会话和消息要先用 `client.session.list()`、`session.messages()` 取回来。状态里的列表都按 id 排序：消息和 Part 的 id 随时间递增，会话的 id 随时间递减，所以 `state.session` 是最新的在前。更新时原地合并，没变的子对象保持原来的引用，所以界面框架只会重画变了的部分。用 Solid 时可以这样写：`setStore(produce((draft) => applyEvent(draft, event)))`。

```ts
import { createMerakCodeClient } from "@merakcode/sdk/client"
import { activity, applyEvent, createSessionsState } from "@merakcode/sdk/store"

const client = createMerakCodeClient({ baseUrl: "http://127.0.0.1:4096", directory: process.cwd() })
const state = createSessionsState()
const events = await client.event.subscribe()
for await (const event of events.stream) {
  applyEvent(state, event)
  for (const session of state.session) console.log(session.title, activity(state, session.id))
}
```

## 11. 导出会话（transcript）

`@merakcode/sdk/transcript` 把会话转成 Markdown：

- `formatTranscript(session, messages, options)`：整个会话。`session` 是 `SessionInfo`（`id`、`title`、`time`），`messages` 是 `MessageWithParts[]`。
- `formatMessage`、`formatPart`、`formatAssistantHeader`：单条消息、单个 Part、回复的标题行。

只导出正文、思考和工具调用；附件、改动摘要等 Part 不导出，时间按本机的时区和格式显示。

选项（`TranscriptOptions`）：`thinking`（是否带思考过程）、`toolDetails`（是否带工具的参数和输出）、`assistantMetadata`（是否带智能体名、模型名和耗时）、`lang`（`"zh"` 或 `"en"`，默认中文）。

```ts
import { writeFile } from "node:fs/promises"
import { createMerakCode } from "@merakcode/sdk"
import { formatTranscript } from "@merakcode/sdk/transcript"

const merak = await createMerakCode({ cwd: process.cwd() })
const session = await merak.session({ id: "ses_xxx" })
const messages = await session.messages()
// session.info 是取回时的快照；要最新的标题，用 client.session.get 再取一次
const info = (await merak.client.session.get({ sessionID: session.id }, { throwOnError: true })).data
const markdown = formatTranscript(info, messages, {
  thinking: false,
  toolDetails: true,
  assistantMetadata: true,
  lang: "zh",
})
await writeFile("session.md", markdown)
await merak.close()
```

## 12. 错误处理

SDK 抛出的错误都是 `MerakCodeError`（或它的子类），只有两种例外：中止时抛的 `AbortError`，以及底层客户端设了 `throwOnError` 时抛出的引擎原始错误内容。

| 字段        | 说明                                                               |
| ----------- | ------------------------------------------------------------------ |
| `code`      | 错误码，比如 `MRK-2002`。含义和处理办法见 [错误码表](../errors.md) |
| `message`   | 说明                                                               |
| `status`    | HTTP 状态码（来自引擎接口的错误才有，`error` 事件里的错误没有）    |
| `requestID` | 引擎日志里对应那条请求的编号，排查时用（`error` 事件里的错误没有） |
| `data`      | 引擎给的附加信息                                                   |
| `retryable` | 这类错误值不值得重试，比如超时、限流                               |

子类：`EngineStartError`（启动失败）、`EngineExitedError`（引擎中途退出，带 `exitCode`）、`RequestTimeoutError`（请求超时）。

`isMerakCodeError(error)` 判断是不是 SDK 的错误；`fromResponse(error, response)` 把底层客户端返回的 `error` 变成 `MerakCodeError`。`MerakCodeError`、`isMerakCodeError`、`fromResponse` 也可以从 `@merakcode/sdk/errors` 单独引入（适合浏览器），上面三个子类不在这个入口里。

一轮对话里模型那边出的错（比如密钥不对、额度用完）不会抛出，而是作为 `error` 事件产出；之后是否还有 `done`，见第 5 节的事件表。

```ts
import { createMerakCode, isMerakCodeError } from "@merakcode/sdk"

const merak = await createMerakCode({ cwd: process.cwd(), timeout: 30_000 })
try {
  const session = await merak.session()
  for await (const event of session.run("你好")) {
    if (event.type === "error" && event.error.retryable) console.log("可以稍后重试：", event.error.message)
  }
} catch (error) {
  if (isMerakCodeError(error)) console.error(`[${error.code}] ${error.message}`, error.requestID ?? "")
  else throw error
} finally {
  await merak.close()
}
```

启动失败（`createMerakCode` 本身抛错）时没有引擎要关，所以它放在 `try` 外面。

## 13. 日志和调试

SDK 默认不打任何日志。传 `logger` 就能收到这些记录（类型 `Logger`，每条是 `LogEntry`：`level`、`message`、`data`）：

- 引擎启动、开始监听、启动失败、退出；
- 每个失败的请求（方法、路径、HTTP 状态码、错误码、`requestID`）。

```ts
import { createMerakCode, type LogEntry } from "@merakcode/sdk"

const merak = await createMerakCode({
  cwd: process.cwd(),
  clientRun: "nightly-42",
  logger: (entry: LogEntry) => console.error(`[merak ${entry.level}] ${entry.message}`, entry.data ?? {}),
  env: { MERAKCODE_DIAGNOSTIC_LOGS: "1" },
})
await merak.close()
```

引擎自己的日志写在 `~/.merakcode/logs` 下（设了 `MERAKCODE_HOME` 就在那个目录的 `logs` 下），SDK 启动的引擎写在其中的 `server/` 子目录。用 `merak logs` 查看；只装了 SDK、没装 `merak` 的话，引擎包里的 `bin/merak logs` 也行。想换个位置，通过 `env` 传 `MERAKCODE_LOG_ROOT`。`MERAKCODE_DIAGNOSTIC_LOGS=1` 会让引擎记更详细的调试日志。传了 `clientRun` 的话，引擎的每条请求日志都会带上它，方便和你自己的日志对上。

## 14. 版本兼容

SDK 和引擎必须是同一个版本。npm 装 SDK 时，引擎包的版本已经锁定成和 SDK 一样，不用操心。

用 `executablePath` 指向别的引擎，或者用 `url` 连接已有的引擎时，要自己保证版本一致。SDK 不会自动比对版本，也不会报 `MRK-1010`；版本不一致时，可能在任意接口上出现参数或字段错误。可以把 `client.global.health()` 返回的 `version` 和你装的 `@merakcode/sdk` 的版本（看 `package.json` 或锁文件）对一下。

## 15. 成员适配器（adapter）

协作群能拉 Claude Code、Codex、OpenCode 进来当成员，靠的是**成员适配器**。你的 AI 编程工具没有内置适配器的话，可以照这一节自己写一个（几十行 TypeScript），也可以在「设置 › 协作群」里点「让 MerakCode 写适配器，帮你接入自己的 AI Coding 工具」，让内置技能 `adapter-generator`（适配器生成助手）替你写好并注册。

### 15.1 适配器是什么

适配器是一个小程序，夹在 MerakCode 和你的 CLI 中间，负责两边传话：

```text
MerakCode  ⇄  适配器库 merakcode-adapter.mjs  ⇄  你写的 adapter.mts  ⇄  你的 CLI
          （成员协议，库已经处理好）         （CLI 自己的通信方式，由你来写）
```

- MerakCode 每派一个任务，就启动一次适配器，任务做完适配器就退出。
- 和 MerakCode 通信的部分由适配器库处理，你不用管协议细节。
- 你只写右边那一半：怎么启动你的 CLI、怎么读它的输出、它要审批或提问时怎么转给 MerakCode、怎么把结果交回来。
- 适配器自己不做任何决定。CLI 想改文件、跑命令、联网、问用户问题时，都交给 MerakCode。MerakCode 按群里的权限模式（只读、询问、自动）和用户的规则判断，需要时弹出审批栏或提问框，所以成员和 MerakCode 自己的工具守同一套规矩。
- 内置的 Claude Code、Codex、OpenCode 适配器也是这样写的，只用了这个库和 Node 自带的模块。技能 `adapter-generator` 就是拿它们当示例的。

### 15.2 一个任务从头到尾怎么走

1. 群主把任务交给成员。MerakCode 用配置里的命令和参数启动你的适配器（比如 `node adapter.mts`），工作目录是项目目录。
2. 适配器库先调用你写的 `inspect`，告诉 MerakCode 这个 CLI 叫什么、是什么版本；返回 `unavailable` 时任务直接失败。设置页显示产品状态时，也只调用这一步，不派任务。
3. MerakCode 把任务发过来，库调用你写的 `run(task, host)`。
4. 你在 `run` 里启动 CLI、读它的输出。CLI 每做一步、每次要审批、每次要提问，你就调用 `host` 上对应的方法（见 15.3）。
5. CLI 做完了，`run` 返回 `{ text, sessionId }`：`text` 是成员在群里的回复；`sessionId` 是 CLI 的会话 id，下次给这个成员派任务时会作为 `task.resume` 传回来，用来接着上次的会话干。
6. 适配器退出。用户中途点了停止的话，`task.signal` 会触发，你要把 CLI 停掉。任务正常结束后 `task.signal` 也会触发（MerakCode 拿到结果就关掉适配器的输入），所以不能把它当成"用户点了停止"。

同一个产品可能同时跑好几个适配器进程：不同成员改的路径互不重叠时会并行。所以不要用固定端口、共享的临时文件或全局锁。

### 15.3 host 是什么

`host` 就是 MerakCode。`run(task, host)` 的两个参数：

- `task` 是这次要干的活：任务内容、项目目录、权限模式等（见 15.5 的表）；
- `host` 是干活过程中找 MerakCode 用的三个方法。

| 方法                       | 作用                                                                     | 要不要等                                               |
| -------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------ |
| `host.step(step)`          | 告诉 MerakCode "我正在做什么"，成员的气泡里实时显示，比如"Bash npm test" | 不等，只是通知                                         |
| `host.permission(request)` | 问 MerakCode "这件事能不能做"，请求分五种（见 15.6）                     | 要等，拿到"允许"或"拒绝"                               |
| `host.question(questions)` | 请 MerakCode 弹出提问框问用户                                            | 要等，拿到用户的答案；用户点「跳过」或停止群聊时会抛错 |

以 CLI 想跑 `npm test` 为例，一次审批是这样走的：

```text
CLI → 适配器："我想跑 npm test"
适配器 → await host.permission({ kind: "command", command: "npm test" })   ← 在这里停下来等
         MerakCode 按权限模式判断：自动放行、直接拒绝（比如只读模式下改文件），或者弹出审批栏"小明 · MyCLI 请求 / 要运行命令"
         用户点"允许"
host.permission 返回 { allow: true }
适配器 → CLI："可以，跑吧"
```

`host` 不用你创建，也不用导入：适配器库创建好，在调用 `run` 时作为第二个参数传进来，`run` 里直接用就行。它的类型叫 `Host`（大写），只有把 `host` 传给你自己写的函数、要给参数标类型时，才需要 `import { type Host } from "./merakcode-adapter.mjs"`。15.5 的例子里有这种写法。

### 15.4 准备文件

建一个文件夹，推荐放在 `~/.merakcode/adapters/<id>/`（`<id>` 是你给这个产品起的 id，比如 `mycli`），里面放三个文件：

| 文件                      | 是什么                                       | 怎么来       |
| ------------------------- | -------------------------------------------- | ------------ |
| `merakcode-adapter.mjs`   | 适配器库，处理和 MerakCode 的通信            | 复制，不要改 |
| `merakcode-adapter.d.mts` | 适配器库的类型声明，让编辑器有提示和类型检查 | 复制，不要改 |
| `adapter.mts`             | 你写的适配器                                 | 照 15.5 写   |

前两个文件在 MerakCode 的安装目录里，同一个文件夹下还有三个内置适配器的示例 `example-claude-code.mts`、`example-codex.mts`、`example-opencode.mts`，可以直接拿来改：

- 桌面端：安装目录下的 `resources/engine/lib/skills/adapter-generator/`，macOS 上是 `/Applications/MerakCode.app/Contents/Resources/engine/lib/skills/adapter-generator/`；
- 命令行版：`~/.merakcode/versions/<版本>/lib/skills/adapter-generator/`（安装时设置了 `MERAKCODE_INSTALL_DIR` 或 `MERAKCODE_HOME`，就在那个目录下）；用 npm 装的，在全局 `node_modules` 的 `merakcode-<系统>-<架构>/lib/skills/adapter-generator/` 下。

运行不用装任何东西：MerakCode 自带的 Node 能直接运行 `.mts` 文件。想要类型检查，在文件夹里运行 `npm install --save-dev typescript @types/node`，再放一个 `tsconfig.json`：

```json
{ "compilerOptions": { "module": "nodenext", "target": "esnext", "strict": true, "noEmit": true, "types": ["node"] } }
```

适配器库的类型声明也用到了 Node 的类型，而 TypeScript 6 起不会自动加载 `@types/node`，所以要写 `types`。这些只影响编辑器和检查，运行不需要。

扩展名用 `.mts`，不用 `.ts`：`.mts` 永远按 ES 模块（`import`/`export`）运行；`.ts` 要看上级目录的 `package.json` 有没有写 `"type": "module"`，而 `~/.merakcode/package.json` 没写，Node 会先按老式模块解析失败、再重新解析，每次启动都打一条警告。

如果你的适配器本来就在一个 Node 项目里，也可以不复制库，改用 npm 包：`npm install @merakcode/sdk --omit=optional`（不加 `--omit=optional` 会顺带装上约 140MB 的引擎，适配器用不到），然后从 `@merakcode/sdk/adapter` 导入，用法完全一样。

### 15.5 一个完整的例子

下面把一个**虚构的** CLI `mycli` 接进协作群。它每行输出一个 JSON 事件，从标准输入读命令。这些消息格式是编的：写你自己的适配器时，换成你的 CLI 文档里写的格式。

```ts
// adapter.mts：把虚构的 CLI「mycli」接进协作群
import readline from "node:readline"
import { adapter, spawn, stop, version, type Host, type Permission } from "./merakcode-adapter.mjs"

// 你的 CLI 的命令名。MerakCode 不会把它告诉适配器：配置里的命令和参数是用来启动适配器本身的
const CLI = "mycli"

// mycli 每行输出一个 JSON 事件，这里列出会用到的四种
type MyCliEvent =
  | { type: "tool"; name: string; detail?: string } // 它开始用一个工具
  | { type: "approval"; id: string; action: string; path?: string; command?: string; url?: string } // 它要审批
  | { type: "question"; id: string; text: string; choices: string[] } // 它要问用户
  | { type: "done"; text: string; session: string } // 任务做完了

// adapter() 把这个程序变成一个适配器：它接管和 MerakCode 的通信，在需要时调用下面两个函数
adapter({
  // inspect：只说明这个 CLI 是什么，不干活。设置页显示产品状态时也会调用它
  inspect: async () => ({
    name: "MyCLI",
    recommended: "1.2.0", // 低于这个版本时，设置页提示建议升级（照样能用）
    upgrade: "npm install -g mycli", // 提示里给出的升级命令
    ...(await version(CLI)), // 跑 mycli --version：得到 { version }，没装或出错时得到 { unavailable: 原因 }
  }),

  // run：做一个任务。task 是这次的活，host 是 MerakCode（见 15.3），两个都由库传进来
  async run(task, host) {
    // 1. 按权限模式拼出 mycli 的参数：让它遇到拿不准的事都来问，由 MerakCode 决定
    const args = ["run", "--json", "--approvals", "ask"]
    if (task.mode === "readonly") args.push("--read-only") // 只读模式：不让它改文件
    if (task.resume) args.push("--session", task.resume) // 接着上次的会话

    // 2. 启动 mycli。用库里的 spawn：在 Windows 上，npm 装的 CLI 是 .cmd 文件，Node 自带的 spawn 启动不了
    const cli = spawn(CLI, args, { cwd: task.cwd, stdio: ["pipe", "pipe", "inherit"], windowsHide: true })
    // 用户在群里点停止时，task.signal 会触发：把 mycli 停掉
    task.signal.addEventListener("abort", () => void stop(cli), { once: true })

    // 往 mycli 的标准输入写一行 JSON
    const send = (message: object) => cli.stdin.write(JSON.stringify(message) + "\n")
    send({ prompt: task.prompt }) // 把任务交给它

    try {
      // 3. 一行一行读 mycli 的输出，按事件类型处理
      for await (const line of readline.createInterface({ input: cli.stdout })) {
        const event = parse(line)
        if (!event) continue // 不是 JSON 的行（比如它打印的日志）跳过

        // 它开始用一个工具：显示到成员的气泡里
        if (event.type === "tool") host.step({ tool: event.name, detail: event.detail })

        if (event.type === "approval") {
          // 问 MerakCode 能不能做，在这里等它回复（可能要等用户在审批栏里点）
          const verdict = await host.permission(toPermission(event))
          // 把结果告诉 mycli；拒绝时带上理由，好让它换个办法
          send({ approval: event.id, approved: verdict.allow, reason: verdict.allow ? undefined : verdict.message })
        }

        if (event.type === "question") await ask(host, event, send)

        // 做完了：text 是成员在群里的回复，sessionId 下次作为 task.resume 传回来
        if (event.type === "done") return { text: event.text, sessionId: event.session }
      }
      // 输出读完了却没等到 done：mycli 中途退出了
      throw new Error("mycli 没给出回复就退出了")
    } finally {
      // 4. 不管是做完、出错还是被停止，都把 mycli 收掉
      await stop(cli)
    }
  },
})

/** 把一行输出解析成事件；不是 JSON 的行返回 undefined */
function parse(line: string): MyCliEvent | undefined {
  try {
    return JSON.parse(line) as MyCliEvent
  } catch {
    return undefined
  }
}

/** 把 mycli 的审批事件翻译成 MerakCode 的五种请求之一（见 15.6），尽量选最具体的那种 */
function toPermission(event: Extract<MyCliEvent, { type: "approval" }>): Permission {
  if (event.action === "write" && event.path) return { kind: "write", paths: [event.path] }
  if (event.action === "shell" && event.command) return { kind: "command", command: event.command }
  if (event.action === "read" && event.path) return { kind: "read", paths: [event.path] }
  if (event.action === "fetch" && event.url)
    return { kind: "network", host: new URL(event.url).hostname, url: event.url }
  // 以上都不是，或者 mycli 没给路径、命令时，才用 tool，把能给的都放进 detail
  return { kind: "tool", name: event.action, detail: event.path ?? event.command ?? event.url }
}

/**
 * 在 MerakCode 的提问框里问用户，再把用户选的答案交回给 mycli。
 * host 传进了自己写的函数，所以参数要标上类型 Host
 */
async function ask(host: Host, event: Extract<MyCliEvent, { type: "question" }>, send: (message: object) => void) {
  // 用户点「跳过」或停止群聊时 host.question 会抛错：接住它，告诉 mycli 用户没有回答，否则整个任务失败
  const answers = await host
    .question([
      { question: event.text, header: "提问", options: event.choices.map((label) => ({ label, description: "" })) },
    ])
    .catch(() => [] as string[][])
  // answers 里每个问题一个数组：用户选的选项文字，或者用户自己写的回答；这里只问了一个问题
  send({ answer: event.id, choice: answers[0]?.[0] })
}
```

这个例子里，CLI 一次只发一个请求，所以在循环里直接 `await` 就行。如果你的 CLI 会同时发好几个请求，回复时不要在循环里等，写法参考 `example-claude-code.mts`。

`adapter()` 接收的对象（类型 `Definition`）就是上面这两个函数：

| 函数               | 什么时候调用                                                                            | 返回什么                                                                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inspect(product)` | 每个任务开始前一次，以及设置页显示状态时（不带任务）。返回 `unavailable` 时任务直接失败 | `Info`：名称 `name`，可选的版本 `version`、路径 `path`、建议版本 `recommended`、升级命令 `upgrade`，用不了时写原因 `unavailable`                  |
| `run(task, host)`  | 每个任务一次                                                                            | `Result`：回复 `text`（不能为空，否则任务失败），以及下次续接用的 `sessionId`（任务成功时才保存；CLI 那边的会话已经不在时，要自己退回到新开会话） |

`task`（类型 `Task`）里有：

| 字段           | 是什么                                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `task.prompt`  | 交给成员的完整任务，包括它的职责和群里的情况                                                                                           |
| `task.cwd`     | 项目目录，CLI 要在这里干活                                                                                                             |
| `task.mode`    | 群里的权限模式（类型 `Mode`）：`"readonly"`、`"ask"` 或 `"auto"`                                                                       |
| `task.resume`  | 上次任务返回的 `sessionId`，第一次是空的                                                                                               |
| `task.product` | 这个产品的 id 和名称（类型 `Product`）。接入方式是 `member` 时只有 `id`、`title`：配置里的命令和参数用来启动适配器本身，不会传给适配器 |
| `task.signal`  | 用户停止群聊时触发，这时要停掉 CLI                                                                                                     |

### 15.6 五种审批请求

`host.permission` 接收的请求（类型 `Permission`）分五种，尽量选最具体的那种：

| `kind`    | 什么时候用 | 写法                                            |
| --------- | ---------- | ----------------------------------------------- |
| `write`   | 改文件     | `{ kind: "write", paths: ["src/a.ts"] }`        |
| `command` | 跑命令     | `{ kind: "command", command: "npm test" }`      |
| `network` | 联网       | `{ kind: "network", host: "example.com", url }` |
| `read`    | 读文件     | `{ kind: "read", paths: [".env"] }`             |
| `tool`    | 以上都不是 | `{ kind: "tool", name: "某工具", detail }`      |

- 返回值（类型 `Verdict`）是 `{ allow: true }` 或 `{ allow: false, message }`。拒绝时把 `message` 当理由转给 CLI。
- MerakCode 按它自己的工具的规则判断这些请求：改文件按 edit，读文件按 read，命令按 bash，联网按 network，其他按插件工具。"本对话允许""总是允许""信任文件或目录"都由 MerakCode 处理，你的适配器只会收到"允许"或"拒绝"。
- 路径可以是相对项目目录的，也可以是绝对路径。
- `paths` 不要给空数组或空字符串，`command` 不要给空字符串：没有可检查的内容时，MerakCode 会直接拒绝，拒绝的 `message` 里说明缺了什么。拿不到路径或命令时改用 `tool`。

`host.question` 接收的问题（类型 `Question`）有 `question`（问题）、`header`（很短的标题）、`options`（选项，每个有 `label` 和 `description`），可选 `multiple`（能不能多选）和 `custom`（默认 `true`：用户可以不选选项、自己写回答）。返回值里每个问题一个数组（类型 `Answer`），装着用户选的选项文字或自己写的回答。用户点「跳过」或停止群聊时，`host.question` 会抛错（消息是 `The user dismissed this question`），请接住它，告诉 CLI 用户没有回答，否则整个任务失败。`host.step` 接收的一步（类型 `Step`）是 `{ tool, detail }`。

### 15.7 先自己测一遍

在适配器文件夹里运行（`node` 用你电脑上的 Node 24 以上版本就行）：

```sh
# 只握手、不干活：应当打印名称和版本
node merakcode-adapter.mjs check -- node adapter.mts

# 真跑一个任务：会用你的 CLI 自己的模型，可能花钱。请在一个新建的空目录里运行，把路径换成适配器文件夹
node <适配器文件夹>/merakcode-adapter.mjs test -- node <适配器文件夹>/adapter.mts "Run node --version, then create hello.txt containing hi, then reply OK"
```

测试模式会打印每一步、每个审批请求、每个提问，所有请求一律允许，提问总选第一个选项，最后打印结果和会话 id。满足下面三条才算跑通：

- `node --version` 作为 `command` 请求到达；
- 写 `hello.txt` 作为 `write` 请求到达；
- 结果正常返回。

只有 `check` 通过还不够，它只证明握手没问题（`inspect` 返回 `unavailable` 时 `check` 的退出码也是 0）。测试模式固定用 `ask` 模式，工作目录是当前目录，产品是 `{ id: "test", title: "test" }`，测不到只读模式下的参数。SDK 里同样的入口是 `cli(argv)`。

### 15.8 注册到 MerakCode

在全局配置 `~/.merakcode/merakcode.jsonc`（已有 `merakcode.json` 就改它；设置了 `MERAKCODE_HOME` 时在那个目录下）里加一个产品，接入方式写 `member`。id 不要用 `merak`，也不要和已有的产品重名：写成内置产品的 id 会覆盖那个内置产品。`args` 不经过 shell，`~` 和环境变量不会展开；Windows 上 JSON 里的反斜杠要写两个，或者改用 `/`。

```jsonc
{
  "collaboration": {
    "products": {
      "mycli": {
        "title": "MyCLI",
        "adapter": "member",
        // node 是 MerakCode 自带的 Node，没装 Node 的电脑也能跑
        "command": "node",
        // 适配器的绝对路径
        "args": ["/Users/你/.merakcode/adapters/mycli/adapter.mts"],
      },
    },
  },
}
```

也可以在「设置 › 协作群 › 添加产品」里加：接入方式选"成员适配器（命令和参数启动你的适配器）"，命令填 `node`，参数填适配器的路径。

注册后，设置页这一行会显示 `inspect` 返回的版本，以及"权限：由 MerakCode 审批"，然后就能在群里添加这个产品的成员了。设置页的检测结果会缓存 60 秒，改了 `adapter.mts` 之后点「重新检测」。

### 15.9 运行时的规则和常见的坑

- **一个任务一个进程**：每个任务都启动一个新的适配器进程。要接着上次干，就靠你返回的 `sessionId`。
- **用户点停止**：`task.signal` 触发，你负责停掉 CLI。MerakCode 同时关掉适配器的输入，库在 5 秒后让适配器退出；那时适配器还在的话，MerakCode 会把它和它启动的进程一起结束。所以要在 5 秒内停掉 CLI：在 macOS 和 Linux 上，适配器退出时还没停掉的 CLI 不一定会被一起清理。
- **MerakCode 退出**：适配器的输入流被关闭，`task.signal` 随之触发，库会在 5 秒后让适配器退出；CLI 会不会一起结束，取决于你有没有在 `task.signal` 里调用 `stop`。
- **设置页的 `inspect` 有时限**：10 秒内没回应，这个产品显示为不可用。任务开始前的那一次没有时限，所以 `inspect` 要快、没有副作用；设置页调用它时，工作目录不是项目目录，不要依赖当前目录。
- **不要往标准输出打印东西**：标准输出是和 MerakCode 通信专用的。库只把 `console.log`、`console.info` 转到了标准错误（MerakCode 的日志里），`console.debug`、`console.dir` 仍然写标准输出，打日志请用 `console.error`。直接写 `process.stdout`，或者让 CLI 继承适配器的标准输出，都会把通信搞乱。
- **排错**：适配器写到标准错误的每一行都会进 MerakCode 的日志（`merak logs`）。适配器中途退出时，失败消息里会带上它最后一行错误。
- **不要给 CLI 加跳过审批的参数**（比如"全部自动放行"）：加了以后 MerakCode 就管不到它了，权限模式和审批都会失效。
- **适配器以你本人的权限运行，不在 MerakCode 的沙箱里**。MerakCode 只管得到 CLI 主动来问的操作，只接你信任的 CLI。

### 15.10 TypeScript 写法的限制

MerakCode 自带的 Node 运行 `.mts` 时，只是把类型删掉再运行，所以：

- 运行时不检查类型。类型错误要靠编辑器发现，或者按 15.4 放好 `tsconfig.json` 后在文件夹里运行 `npx tsc`。
- 只能用"删掉类型后就是 JavaScript"的写法：类型标注、`type`、`interface`、`as`、`!`、泛型都可以；**`enum`、`namespace`、构造函数参数属性（`constructor(private x)`）不行**，Node 会报语法错误。
- 只导入类型时写 `type`，比如 `import { adapter, type Host } from "./merakcode-adapter.mjs"`。
- 相对导入要写完整的扩展名，比如 `./merakcode-adapter.mjs`。

### 15.11 库里的其他内容

- `spawn`：参数和返回值都和 `node:child_process` 的 `spawn` 一样，但在 Windows 上也能启动 npm 装的 CLI（`.cmd` 文件），参数原样传过去。
- `stop(child)`：结束 CLI 和它启动的所有进程，结束后才返回。CLI 的输入还开着的话，先关掉输入，等它最多 3 秒自己退出；还不退出，Windows 上强制结束整棵进程树，macOS 和 Linux 上发 `SIGTERM` 再等最多 3 秒（不发 `SIGKILL`）。
- `version(command)`：跑 `<CLI> --version`，返回第一行；没装、出错或 5 秒内没回应时，返回原因。
- `connect`：你的 CLI 也说 JSON-RPC 的话，可以用它来连，写法见 `example-codex.mts`。对方先断开时，还在等的请求会以 `ConnectionClosed` 失败。
- `PROTOCOL`：成员协议的版本号。协议本身是标准输入输出上的 JSON-RPC 2.0，一行一条消息，由库处理。
