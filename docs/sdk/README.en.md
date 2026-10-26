# MerakCode SDK guide

[简体中文](README.md) · English

With `@merakcode/sdk` you can use MerakCode from your own TypeScript / JavaScript program: open sessions, send messages, read the replies, handle approvals, and hand your own functions to the model as tools.

For the full list of endpoints, see the [API reference](reference.md).

**Contents**

1. [Overview](#1-overview)
2. [Install and requirements](#2-install-and-requirements)
3. [Quick start](#3-quick-start)
4. [Core concepts](#4-core-concepts)
5. [High-level API](#5-high-level-api)
6. [Approvals, questions and stopping](#6-approvals-questions-and-stopping)
7. [Extending: host tools, project tools and plugins](#7-extending-host-tools-project-tools-and-plugins)
8. [Low-level client](#8-low-level-client)
9. [Engine process](#9-engine-process)
10. [Session state (store)](#10-session-state-store)
11. [Exporting sessions (transcript)](#11-exporting-sessions-transcript)
12. [Errors](#12-errors)
13. [Logging and debugging](#13-logging-and-debugging)
14. [Versions](#14-versions)
15. [Member adapters (adapter)](#15-member-adapters-adapter)

## 1. Overview

```text
your program ──@merakcode/sdk──► engine process (merak serve) ──► model providers
                HTTP + event stream          │
                                             └─► edits files, runs commands (permission checks + OS sandbox)
```

The SDK does not call models itself. It starts an engine process in the background (that is `merak serve`, the same engine the CLI and the desktop app use) and talks to it over HTTP and an event stream. Sessions, tools, permissions and the sandbox all live in the engine.

The SDK has several entry points; pick what you need:

| Entry point                 | What it's for                                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `@merakcode/sdk`            | The high-level API: `createMerakCode` starts an engine, opens sessions and runs turns. Enough for most uses |
| `@merakcode/sdk/client`     | The low-level HTTP client for every engine endpoint. Works in browsers too                                  |
| `@merakcode/sdk/process`    | Only starts and stops the engine process; you build the client                                              |
| `@merakcode/sdk/store`      | Turns engine events into sessions, messages, approvals and so on, for building a UI. Works in browsers too  |
| `@merakcode/sdk/plugin`     | Types and `tool()` for writing plugins and project tools                                                    |
| `@merakcode/sdk/transcript` | Exports a session as Markdown                                                                               |
| `@merakcode/sdk/adapter`    | Writes a member adapter, so collaboration groups can drive your AI coding tool                              |
| `@merakcode/sdk/errors`     | The `MerakCodeError` class and helpers. Works in browsers too                                               |

## 2. Install and requirements

```sh
npm install @merakcode/sdk
```

- Needs Node.js 24 or newer.
- Supports Windows, macOS and Linux on x64 and arm64. Linux needs a glibc distribution; on musl systems such as Alpine the engine package does not install, so point `executablePath` at an engine yourself.
- npm also installs one engine package for your system, named `merakcode-<os>-<arch>` (such as `merakcode-windows-x64`). It carries its own Node and the engine, so it is fairly large. It is an optional dependency: with `--omit=optional`, or when you move `node_modules` to a different system, the engine is missing and you get `MRK-1001`.

**Using a different engine.** To use an engine other than the one from npm, set `executablePath`:

- An executable: on macOS / Linux you can point at an installed `merak`, such as `~/.merakcode/versions/<version>/bin/merak`.
- A command prefix array: on Windows `merak.cmd` cannot be started directly, so write `[<version dir>\node\node.exe, <version dir>\lib\index.js]`. To run from source, write it like this (run `pnpm install` in the repo first, and run your program with Node.js 26.12 or newer; pass the loader to `--import` as a `file://` URL, which is all Windows accepts):

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

**Connecting to a running engine.** Pass `url` instead of starting a new process. If the engine has a password (the `MERAKCODE_SERVER_PASSWORD` environment variable), send it with HTTP Basic auth; the user name is `merakcode` unless the engine sets `MERAKCODE_SERVER_USERNAME`:

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

In this case `close()` only disconnects; it does not stop that engine. Note also that with `url`, an engine that goes away, or an event stream that cannot connect (wrong address or password), throws nothing: the SDK reconnects every 3 to 30 seconds, events in between are lost, and an iteration waiting for events keeps waiting. Pass `signal` to `run` to cap it.

## 3. Quick start

```ts
import { createMerakCode } from "@merakcode/sdk"

const merak = await createMerakCode({ cwd: process.cwd() })
try {
  const session = await merak.session()
  for await (const event of session.run("Introduce yourself in one sentence.")) {
    if (event.type === "text") process.stdout.write(event.delta)
    if (event.type === "error") console.error(event.error.code, event.error.message)
  }
} finally {
  await merak.close()
}
```

It uses the default model of a provider you have already connected (an `options.apiKey` in config, a provider connected with `merak provider login`, or a key entered under Settings → Models & providers in the desktop app). If you haven't connected one yet, run `merak provider login`, or put it in the `config` option (see section 5).

The repo has three runnable examples in [`packages/sdk/js/examples`](../../packages/sdk/js/examples):

| File             | What it does                                                          |
| ---------------- | --------------------------------------------------------------------- |
| `minimal.ts`     | Opens a session, sends one message and prints the reply as it streams |
| `custom-tool.ts` | Defines a stock lookup tool and lets the model call it                |
| `batch.ts`       | Runs several sessions at once in one engine, each summarizing a file  |

## 4. Core concepts

- **Engine**: one `merak serve` process. One engine can serve many sessions, and many project folders.
- **Session**: one conversation. Subagents and background workflows started by the agent create **child sessions** whose `parentID` points at the parent.
- **Messages and parts**: each message (`role` is `user` or `assistant`) is made of parts. Common parts: `text` (the reply), `reasoning` (the model's thinking), `tool` (one tool call with its input, state and output), `file` (an attachment), `step-start` / `step-finish` (the start and end of a step, with usage), `patch` (files changed in that step), `subtask`, `agent`, `retry`, `compaction`.
- **Agent**: decides the prompt and which tools are available. The default is `build`; the subagents are `general` and `explore`; `simplifier` works as either. You can add your own in the config.
- **Model**: written as `provider/model`, such as `anthropic/claude-sonnet-4-5` or `alibaba-cn/qwen-plus`. `merak models` lists what you can use.
- **Permission mode**: `readonly`, `ask` (default) or `auto`. Together with your permission rules it decides whether an action that changes things runs, asks first, or is refused.
- **Events**: the engine pushes every change (new messages, part updates, approval requests, session status...) over an event stream. The high-level API picks out the events of the current session for you.

## 5. High-level API

### createMerakCode(options)

Starts (or connects to) an engine and returns a `MerakCode` object. Options (type `MerakCodeOptions`, which includes every field of `EngineOptions`):

| Option           | Meaning                                                                                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cwd`            | Project folder. The engine's working directory when it is started, and the folder every request is about                                                                            |
| `executablePath` | Engine command, see section 2. Defaults to the engine package from npm                                                                                                              |
| `env`            | Extra environment variables for the engine process (merged with the current process's)                                                                                              |
| `config`         | Inline config, written like `merakcode.json`, with the highest priority                                                                                                             |
| `agents`         | Custom agents, written like the `agent` section of the config (type `AgentConfig`). When `config.agent` is given too, `agents` replaces it entirely                                 |
| `timeout`        | How long to wait for the engine to start, in milliseconds. Default 60000                                                                                                            |
| `serve`          | Arguments for `merak serve`. Default `["--hostname", "127.0.0.1", "--port", "0"]` (a random local port only)                                                                        |
| `signal`         | Cancels starting (a `signal` that is already aborted does not cancel it)                                                                                                            |
| `logger`         | Log callback, see section 13                                                                                                                                                        |
| `url`            | Connect to a running engine instead of starting one                                                                                                                                 |
| `headers`        | Request headers (such as the password) when connecting to a running engine                                                                                                          |
| `tools`          | Host tools, see section 7                                                                                                                                                           |
| `clientRun`      | Your own run or trace id; the engine writes it into the log line of every request. Only letters, digits, `_`, `.`, `:` and `-`, at most 100 characters, or the engine leaves it out |

`config`, `agents`, `env`, `timeout`, `serve`, `executablePath` and `signal` only apply when a new engine is started; they are ignored with `url`.

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
      description: "Reviews code without changing it",
      prompt: "You are a strict code reviewer. Point out problems; never edit code.",
      mode: "primary",
      permission: { edit: "deny", bash: "deny" },
    },
  },
})
await merak.close()
```

The returned `MerakCode`:

| Member           | Meaning                                                                                |
| ---------------- | -------------------------------------------------------------------------------------- |
| `client`         | The low-level client (section 8), for endpoints the high-level API doesn't cover       |
| `url`            | Engine URL                                                                             |
| `pid`            | Engine process id; `undefined` when connected with `url`                               |
| `session(input)` | Creates a session; pass `id` to get an existing one. Also takes `title` and `parentID` |
| `close()`        | Stops the host tools and the engine it started                                         |

### Sessions: MerakCodeSession

| Member                 | Meaning                                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `info`           | Session id and details. `info` is a snapshot from when the session was created or fetched, so a title generated later is not in it; use `client.session.get` for the latest |
| `run(prompt, options)` | Sends a message and returns this turn's events. Ends with `done` when the turn is over                                                                                      |
| `events(handlers)`     | All later events of this session, across turns. A background workflow sends the session another turn when it finishes; use this to keep waiting. Ends when `signal` aborts  |
| `messages()`           | Every message and part in the session                                                                                                                                       |
| `abort()`              | Stops the running turn (queued messages still run)                                                                                                                          |

Options of `run` (`RunOptions`, which includes every field of `Handlers`):

| Option         | Meaning                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------- |
| `model`        | Model for this turn, as `provider/model`                                                     |
| `agent`        | Agent for this turn                                                                          |
| `mode`         | Permission mode: `"readonly"`, `"ask"` or `"auto"`                                           |
| `onPermission` | Called for approvals, see section 6. Without it, every request that needs approval is denied |
| `onQuestion`   | Called when the model asks a question, see section 6. Without it questions are skipped       |
| `signal`       | Stops this turn                                                                              |

`run` produces 5 kinds of events (`RunEvent`):

| `type`      | Contents                                                                                                                                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `text`      | A piece of the reply (`delta`) as it is generated; `partID` tells reply paragraphs apart                                                                                                                                                                                                   |
| `reasoning` | A piece of the model's thinking, only for models with thinking on. Some models put the answer only in their thinking and leave the reply empty                                                                                                                                             |
| `part`      | The latest full state of every other part, such as a tool call starting or finishing. That includes the parts of the message you sent, and the finished `text` and `reasoning` parts (whose content already arrived as deltas)                                                             |
| `error`     | Something went wrong in this turn (`error` is a `MerakCodeError`); there may be more than one. If the turn already produced a reply message (a wrong key, quota used up), `done` follows; if not (a wrong model name), there may be no `done`, or `done` carries the previous turn's reply |
| `done`      | The turn is over; `message` is the session's last reply message, with `cost` and `tokens`                                                                                                                                                                                                  |

```ts
import { createMerakCode } from "@merakcode/sdk"

const merak = await createMerakCode({ cwd: process.cwd() })
const session = await merak.session({ title: "README check" })
let answer = ""
for await (const event of session.run("Any typos in the README? List them, don't fix them.", { mode: "readonly" })) {
  if (event.type === "text") answer += event.delta
  if (event.type === "part" && event.part.type === "tool")
    console.log("tool:", event.part.tool, event.part.state.status)
  if (event.type === "done") console.log("cost:", event.message.cost, "output tokens:", event.message.tokens.output)
}
console.log(answer)
await merak.close()
```

Run one `run()` at a time per session: messages sent together queue, both iterators see each other's events, and both get the same `done` only after both turns end. For concurrency, use several sessions (see `batch.ts`).

## 6. Approvals, questions and stopping

### Approvals

When the agent wants to edit files, run commands or go online and the permission mode and rules say to ask, the engine sends an approval request (`PermissionRequest`) and the SDK calls your `onPermission`. Approvals from subagents and workflows come here too.

Not every action asks: in the default `ask` mode, edits to ordinary files inside the workspace go through without asking, and in `auto` mode most commands and host tools run without asking too (the rules are in [Permissions and the sandbox in the README](../../README.en.md#permissions-and-the-sandbox)). To approve every file edit yourself, set `permission: { edit: "ask" }` in `config`, or use `readonly` mode.

Useful fields of `PermissionRequest`:

| Field        | Meaning                                                                                                                                                                                                                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `permission` | What it wants to do: `read`, `edit`, `bash`, `sandbox` (a command leaving the sandbox or writing outside the workspace), `network`, `mcp`, `subagent`, `workflow_run`, `cron`, `skill`, or a tool name. It does not say how risky it is: `git push` is also `bash`, and editing outside the workspace is also `edit` |
| `patterns`   | The specifics, such as the command, file paths or host names                                                                                                                                                                                                                                                         |
| `metadata`   | Extra details that depend on the action, such as a description of the command or the change                                                                                                                                                                                                                          |
| `sessionID`  | The session that asked; `root` is its top-level session                                                                                                                                                                                                                                                              |
| `tool`       | The tool call that triggered it                                                                                                                                                                                                                                                                                      |

Return one `PermissionDecision`:

- `"allow-once"`: allow this one time
- `"allow-session"`: allow requests of the same scope for the rest of this session: commands by prefix (such as `npm install *`), files by that file or its folder
- `"always"`: always allow, saved to the project config. When the request's `always` is `false` (subagents, workflows, sandbox permissions, changes to MerakCode's config files), it only lasts for this session
- `"deny"`: refuse

Without `onPermission`, every request that needs approval is denied: if the host says nothing, nothing goes through.

Approvals and questions are handled only while you iterate `run()` or `events()`. After breaking out early, later requests go unanswered and the turn waits forever; call `session.abort()` first. Don't throw in the callbacks: the error is not passed back to you, and the request stays unanswered. When a turn seems stuck, `client.permission.list()` and `client.question.list()` list the requests nobody has answered.

This example has every file edit ask the host first:

```ts
import { createMerakCode } from "@merakcode/sdk"

const merak = await createMerakCode({ cwd: process.cwd(), config: { permission: { edit: "ask" } } })
const session = await merak.session()
const run = session.run("Set the version in package.json to 1.2.0", {
  onPermission: (request) => {
    console.log("approval:", request.permission, request.patterns.join(", "))
    return request.permission === "edit" ? "allow-once" : "deny"
  },
})
for await (const event of run) if (event.type === "text") process.stdout.write(event.delta)
await merak.close()
```

### Questions

Sometimes the model stops to ask multiple-choice questions (`QuestionRequest`). Each entry in `questions` has `question` (the text), `header` (a short title) and `options` (each with `label` and `description`); `multiple` means more than one can be picked, and `custom` means you can write your own answer (true for every question the model asks). Questions from subagents come here too; the model never asks questions in `auto` mode.

`onQuestion` returns one answer per question, in order. Each answer is an array of strings: the chosen `label`s, or your own text. Without `onQuestion` the question is skipped and the model is told you didn't answer.

```ts
import { createMerakCode } from "@merakcode/sdk"

const merak = await createMerakCode({ cwd: process.cwd() })
const session = await merak.session()
const run = session.run("Set up a new project; ask me which language first", {
  onQuestion: (request) => request.questions.map((question) => [question.options[0]?.label ?? "TypeScript"]),
})
for await (const event of run) if (event.type === "text") process.stdout.write(event.delta)
await merak.close()
```

### Stopping and timeouts

- Pass `signal` to `run`. When it aborts, the engine stops the turn and the iteration throws an `AbortError`.
- Or call `session.abort()`.
- If an engine the SDK started exits unexpectedly, iterations waiting for events throw `EngineExitedError` (`MRK-1004`). An engine connected with `url` does not do this; see section 2.
- With the low-level client, `withRequestDeadline` puts a time limit on a request and throws `RequestTimeoutError` (`MRK-1007`) when it runs out. The limit defaults to 5 seconds; change it with `timeout`. It also takes a `signal`, and tests can pass their own `timer` (`RequestDeadlineTimer`). The options type is `RequestDeadlineOptions`.

```ts
import { createMerakCode, withRequestDeadline } from "@merakcode/sdk"

const merak = await createMerakCode({ cwd: process.cwd() })
const session = await merak.session()

const controller = new AbortController()
setTimeout(() => controller.abort(), 60_000)
try {
  for await (const event of session.run("Run all the tests", { signal: controller.signal, mode: "auto" }))
    if (event.type === "text") process.stdout.write(event.delta)
} catch (error) {
  if (error instanceof Error && error.name === "AbortError") console.log("Stopped after a minute")
}

const health = await withRequestDeadline((signal) => merak.client.global.health({ signal }), { timeout: 2_000 })
console.log(health.data?.version)
await merak.close()
```

### Waiting for background work

When you ask the agent for a workflow by name (the prompt says "workflow"), it starts one in the background and ends the turn first; when the workflow finishes, the engine posts a notification to the session (its text contains `<workflow-notification>`) and the model replies in another turn. Starting a workflow (`workflow_run`) needs approval in `ask` mode.

- Subscribe with `events()` before calling `run()`, or you may miss the turn after the workflow finishes.
- When the workflow is quick, the two turns run together and produce a single `done`, so don't count `done`s: wait for the `done` after the notification.
- Every iterator open on the session answers approvals, so give them all the same `onPermission`.

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
for await (const _ of session.run("Use a workflow to translate every document in docs into Chinese", { onPermission }));
await later
await merak.close()
```

## 7. Extending: host tools, project tools and plugins

There are three ways to give the model new abilities:

| Way           | Where the code runs | Good for                                                                                                    |
| ------------- | ------------------- | ----------------------------------------------------------------------------------------------------------- |
| Host tools    | In your own program | Using data and functions your program already has, such as a database or an internal API                    |
| Project tools | In the engine       | Shipping with the project, so everyone using it (terminal, desktop, SDK) gets the tool                      |
| Plugins       | In the engine       | Adding tools and also stepping into the engine's workflow: changing parameters, blocking requests and so on |

Project tools and plugins run inside the engine process, outside the sandbox, with your own rights. Only use ones you trust.

### Host tools

Define them with `tool()` (type `HostTool`) and pass them as `tools` to `createMerakCode`. When the model calls one, the engine forwards the call to your program, runs it there and hands the result back to the model.

| Field         | Meaning                                                                                                                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`        | Tool name; also its `permission` in approvals. It starts with a letter and has only letters, digits, `_` and `-`, at most 64 characters, or `createMerakCode` fails with `MRK-1009`; a name that clashes with a built-in tool (`bash`, `read`, `edit`, `write` and so on) is ignored |
| `description` | What the model reads; say when to use it                                                                                                                                                                                                                                             |
| `args`        | Parameters as a zod shape: `{ name: schema }`                                                                                                                                                                                                                                        |
| `run`         | `(args, context) => string`, may be async. A thrown error's message goes to the model                                                                                                                                                                                                |

`context` (type `ToolRunContext`) has `sessionID`, `messageID` and `callID`.

Host tools are approved like plugin tools: they ask in read-only and ask mode and run without asking in auto mode; the permission name is the tool name.

Host tools are registered on the whole engine process: any later registration replaces them all, and `close()` does not unregister them. Programs sharing one engine through `url` replace each other's host tools.

```ts
import { createMerakCode, tool } from "@merakcode/sdk"
import { z } from "zod"

const stock = tool({
  name: "stock",
  description: "Look up how many of a fruit are in stock",
  args: { fruit: z.string().describe("Fruit name in English, such as apple") },
  run: ({ fruit }, context) => {
    console.log(`session ${context.sessionID} is looking up ${fruit}`)
    return fruit === "apple" ? "12" : "0"
  },
})

const merak = await createMerakCode({ cwd: process.cwd(), tools: [stock] })
const session = await merak.session()
const run = session.run("How many apples are left?", {
  onPermission: (request) => (request.permission === "stock" ? "allow-once" : "deny"),
})
for await (const event of run) if (event.type === "text") process.stdout.write(event.delta)
await merak.close()
```

### Project tools

Put a `.ts` or `.js` file in the project's `.merakcode/tool/` folder (or the global `~/.merakcode/tool/`). The default export becomes a tool named after the file; other named exports become `file_export`. Turn one off with `"tools": { "file": false }` in the config.

You don't need to install `@merakcode/sdk/plugin` or zod: the engine puts `@merakcode/sdk/plugin` in the `.merakcode` folder and installs zod with npm if it is missing (this needs the network the first time).

```ts
// .merakcode/tool/weather.ts
import { tool } from "@merakcode/sdk/plugin"

export default tool({
  description: "Today's weather in a city",
  args: { city: tool.schema.string().describe("City name") },
  async execute(args, context) {
    context.metadata({ title: `Weather in ${args.city}` })
    const response = await fetch(`https://wttr.in/${encodeURIComponent(args.city)}?format=3`, { signal: context.abort })
    return response.text()
  },
})
```

The `context` of `execute` (type `ToolContext`):

| Field                             | Meaning                                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `sessionID`, `messageID`, `agent` | Which session, message and agent made the call                                                  |
| `directory`, `worktree`           | Project folder and git worktree root. Resolve relative paths against these, not `process.cwd()` |
| `abort`                           | Fires when the call is cancelled                                                                |
| `metadata(input)`                 | Updates the title and extra data shown in the UI                                                |
| `ask(input)`                      | Asks for an approval yourself; throws if it is denied                                           |

The return value (type `ToolResult`) is either a string or `{ title, output, metadata, attachments }`. `normalizeToolResult` turns both into the object form. `tool()` returns a `ToolDefinition`.

### Plugins

Plugins are loaded from three places:

- `.ts` / `.js` files in the project's `.merakcode/plugin/` or the global `~/.merakcode/plugin/` folder;
- the `plugin` array in the config, with npm package names (optionally versioned), such as `"plugin": ["my-merak-plugin@1.0.0"]`;
- with options: `"plugin": [["my-merak-plugin", { "level": "strict" }]]`.

A plugin module exports a function (type `Plugin`) or `{ id, server, options }` (type `PluginModule`, where `server` is that function). The function receives a `PluginInput` and returns `Hooks`:

| `PluginInput` field                | Meaning                                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `client`                           | A client connected to the current engine                                                                                                                           |
| `project`, `directory`, `worktree` | The current project, folder and git worktree root                                                                                                                  |
| `serverUrl`                        | Engine URL                                                                                                                                                         |
| `$`                                | A template function for running commands (type `PluginShell`), such as ``await $`git status`.text()``                                                              |
| `options`                          | This plugin's options (type `PluginOptions`): the module's own `options`, the config entry and the config's `plugin_options[id]`, merged with the last one winning |
| `dataDirectory`                    | A data folder just for this plugin. It isn't created for you; `mkdir` it before writing                                                                            |

`$` works like zx: `` $`cmd ${arg}` `` returns a `PluginShellPromise` that supports `.text()`, `.json()`, `.lines()`, `.quiet()`, `.nothrow()`, `.cwd(dir)` and `.env(vars)`; the result is a `PluginShellOutput` (`stdout`, `stderr`, `exitCode`); a failed command throws a `PluginShellError`. Interpolated values (type `ShellExpression`) are quoted automatically.

Every entry of `Hooks` is optional:

| Hook                                         | When it is called                                                                       | What it can do                                                                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `tool`                                       | On load                                                                                 | Registers tools, written like project tools                                                                                             |
| `config`                                     | On load, with the merged config                                                         | Reads the config, validates its own options                                                                                             |
| `event`                                      | For every event the engine emits                                                        | Watches sessions, messages, approvals and so on                                                                                         |
| `auth`                                       | When the user signs in to a provider (`merak provider login`, desktop settings)         | Offers OAuth or API key sign-in (type `AuthHook`; the OAuth result is `AuthOAuthResult`)                                                |
| `provider`                                   | When listing and calling models                                                         | `providers()` registers whole providers; `models()` replaces a provider's model list; `fetch()` wraps the network requests to the model |
| `chat.message`                               | When a user message arrives                                                             | Changes the message and its parts                                                                                                       |
| `chat.params`                                | Before calling the model                                                                | Changes `temperature`, `topP`, `topK`, `maxOutputTokens` and other options (`provider` is a `ProviderContext`)                          |
| `chat.headers`                               | Before calling the model                                                                | Adds request headers                                                                                                                    |
| `permission.ask`                             | When an approval is needed                                                              | Sets `status` to `allow` or `deny`, deciding for the user                                                                               |
| `command.execute.before`                     | Before a slash command runs                                                             | Changes the parts the command expands to                                                                                                |
| `tool.execute.before`                        | Before a tool runs                                                                      | Changes its `args`                                                                                                                      |
| `tool.execute.after`                         | After a tool runs                                                                       | Changes its title, output and metadata                                                                                                  |
| `tool.definition`                            | Before the tool list is sent to the model                                               | Changes a tool's description and parameters                                                                                             |
| `shell.env`                                  | Before a command runs                                                                   | Adds environment variables                                                                                                              |
| `experimental.chat.messages.transform`       | Before the history is sent to the model                                                 | Changes the messages the model sees                                                                                                     |
| `experimental.chat.system.transform`         | While building the system prompt                                                        | Changes the system prompt                                                                                                               |
| `experimental.chat.guard`                    | After a user message is saved, before any work starts                                   | `refuse: true` refuses the turn, with `message` as the reply                                                                            |
| `experimental.text.complete`                 | When each piece of reply text is done                                                   | Changes that text                                                                                                                       |
| `experimental.message.complete.transform`    | Before the whole reply is written                                                       | Changes the whole reply, for example for content review                                                                                 |
| `experimental.tool.path.guard`               | After a tool has worked out the absolute paths it will touch, before it reads or writes | Adds paths to `denied` (it can only deny, never allow)                                                                                  |
| `experimental.session.compacting`            | Before a session is compacted                                                           | Adds context, or replaces the compaction prompt                                                                                         |
| `experimental.compaction.messages.transform` | During compaction, before messages go to the summary model                              | Changes or filters the messages                                                                                                         |
| `experimental.compaction.summary.transform`  | Before the summary is written back                                                      | Changes the summary                                                                                                                     |
| `dispose`                                    | When the engine shuts down or the plugin is unloaded                                    | Frees processes, timers and other resources                                                                                             |

Hooks starting with `experimental.` may change in future versions.

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

## 8. Low-level client

The client from `createMerakCodeClient` covers every engine endpoint, grouped by area: `client.session`, `client.permission`, `client.provider`, `client.file`, `client.mcp` and so on. Every method, parameter and return type is in the [API reference](reference.md). It doesn't depend on Node: in a browser, import it from `@merakcode/sdk/client` (the main entry carries the process launcher). For a web page not served from `localhost` or `127.0.0.1`, start the engine with `merak serve --cors <origin>`.

Options (`MerakCodeClientConfig` plus these):

| Option             | Meaning                                                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`          | Engine URL                                                                                                                                                                              |
| `headers`          | Request headers, such as the password                                                                                                                                                   |
| `directory`        | Project folder, sent with every request                                                                                                                                                 |
| `workspaceFolders` | Folders of a multi-root workspace (`{ name?, path }[]`)                                                                                                                                 |
| `clientRun`        | Your run id, written into the engine's request log                                                                                                                                      |
| `logger`           | Called for every failed request                                                                                                                                                         |
| `fetch`            | Your own fetch. The default one uses a connection pool without time limits; with your own, Node's built-in fetch cuts long synchronous requests (such as `session.prompt`) at 5 minutes |
| `throwOnError`     | When `true`, errors throw the engine's error body instead of returning `{ error }`                                                                                                      |

Each method takes one object as its first argument, with path parameters, query parameters and body fields all at the top level (a method without parameters, such as `global.health`, takes the options below first); the second argument can carry `signal`, `headers` and `throwOnError`. It resolves to `{ data, error, response }`: `data` on success, `error` on failure. `fromResponse(error, response)` turns the error into a `MerakCodeError`.

`client.event.subscribe()` resolves to `{ stream }`, an async iterator over every event for the current folder. It only connects once you start iterating, and the first event is `server.connected`: send messages after that, or the first events are lost. `client.global.event()` covers every folder, and each item is `{ directory, payload }`: `payload` is the event and `directory` the project folder it belongs to (events that belong to no folder, such as `server.connected`, have none).

```ts
import { createMerakCodeClient, fromResponse } from "@merakcode/sdk"
import { startEngine } from "@merakcode/sdk/process"

const engine = await startEngine({ cwd: process.cwd() })
const client = createMerakCodeClient({ baseUrl: engine.url, headers: engine.headers, directory: process.cwd() })

const sessions = await client.session.list()
if (sessions.error) throw fromResponse(sessions.error, sessions.response)
console.log(sessions.data.map((session) => session.title))

const created = await client.session.create({ title: "Low-level client example" }, { throwOnError: true })
const controller = new AbortController()
const events = await client.event.subscribe(undefined, { signal: controller.signal })
const stream = events.stream[Symbol.asyncIterator]()
await stream.next() // server.connected: send only once connected
await client.session.promptAsync({ sessionID: created.data.id, parts: [{ type: "text", text: "Hello" }] })
for (let next = await stream.next(); !next.done; next = await stream.next()) {
  if (next.value.type === "session.idle" && next.value.properties.sessionID === created.data.id) break
}
controller.abort()
await engine.close()
```

## 9. Engine process

`@merakcode/sdk/process` only handles the engine process:

- `startEngine(options)`: starts an engine and returns an `Engine` once it is listening. The options are `cwd`, `executablePath`, `env`, `config`, `timeout`, `serve`, `signal` and `logger` from the table in section 5 (type `EngineOptions`). By default every start uses a random port and a one-time password (with your own `serve` and no `--port`, the engine tries 4096 first); the password reaches the engine only through an environment variable.
- `resolveEngine()`: returns the command (an array) that starts the engine package from npm; throws `MRK-1001` if it isn't there.

`Engine`:

| Member    | Meaning                                                                      |
| --------- | ---------------------------------------------------------------------------- |
| `url`     | Engine URL, such as `http://127.0.0.1:53124`                                 |
| `headers` | Request headers for the engine (with the password)                           |
| `pid`     | Process id                                                                   |
| `exited`  | Resolves when the process exits, with its exit code (0 after a normal close) |
| `close()` | Asks the engine to exit and waits; kills it if it hasn't exited in 8 seconds |

The engine and your program share an IPC channel. When your program exits or crashes, the channel closes and the engine exits on its own, so no orphan process is left behind. The other way round, your program does not exit by itself while the engine runs, so always call `close()`, ideally in `finally`.

If starting fails you get an `EngineStartError`: `output` holds the engine's last output, and the message includes its last 5 lines. A timeout is `MRK-1002`, any other start failure is `MRK-1003`, and cancelling with `signal` is `MRK-4002`.

## 10. Session state (store)

A UI needs to turn the stream of events into "which sessions are there, what messages does each have, what's waiting for approval". `@merakcode/sdk/store` does that. It isn't tied to any UI framework and works in browsers:

| Function / type              | Meaning                                                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createSessionsState()`      | A new empty state (type `SessionsState`)                                                                                                                                                                     |
| `applyEvent(state, event)`   | Merges one event into the state, changing the object you pass in. Returns a `Change`: `insert`, `update`, `remove`, `replace`, `none` or `ignored`                                                           |
| `activity(state, sessionID)` | What a session is doing now (`Activity`): `approval`, `question`, `running` or `idle`. Child sessions count toward their top-level session, except background ones (such as memory extraction after a reply) |
| `rootOf(state, sessionID)`   | Follows `parentID` up to the top-level session                                                                                                                                                               |
| `forgetSession(state, id)`   | Drops everything cached for a session                                                                                                                                                                        |
| `search(list, id, key)`      | Binary search in a list sorted by id; returns `{ found, index }`                                                                                                                                             |

The state starts empty and only merges events that arrive later; fetch existing sessions and messages first with `client.session.list()` and `session.messages()`. Every list in the state is sorted by id: message and part ids increase over time, session ids decrease, so `state.session` is newest first. Updates merge in place and unchanged child objects keep their references, so UI frameworks only redraw what changed. With Solid you can write `setStore(produce((draft) => applyEvent(draft, event)))`.

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

## 11. Exporting sessions (transcript)

`@merakcode/sdk/transcript` turns a session into Markdown:

- `formatTranscript(session, messages, options)`: a whole session. `session` is a `SessionInfo` (`id`, `title`, `time`) and `messages` is `MessageWithParts[]`.
- `formatMessage`, `formatPart` and `formatAssistantHeader`: one message, one part, or the heading line of a reply.

Only the reply text, thinking and tool calls are exported; attachments, change summaries and other parts are left out, and times use this machine's time zone and format.

Options (`TranscriptOptions`): `thinking` (include the model's thinking), `toolDetails` (include tool inputs and outputs), `assistantMetadata` (include the agent name, model name and timing), `lang` (`"zh"` or `"en"`, Chinese by default).

```ts
import { writeFile } from "node:fs/promises"
import { createMerakCode } from "@merakcode/sdk"
import { formatTranscript } from "@merakcode/sdk/transcript"

const merak = await createMerakCode({ cwd: process.cwd() })
const session = await merak.session({ id: "ses_xxx" })
const messages = await session.messages()
// session.info is a snapshot from when it was fetched; for the latest title, fetch it again with client.session.get
const info = (await merak.client.session.get({ sessionID: session.id }, { throwOnError: true })).data
const markdown = formatTranscript(info, messages, {
  thinking: false,
  toolDetails: true,
  assistantMetadata: true,
  lang: "en",
})
await writeFile("session.md", markdown)
await merak.close()
```

## 12. Errors

Every error the SDK throws is a `MerakCodeError` (or a subclass), with two exceptions: the `AbortError` thrown on abort, and the engine's raw error body thrown by the low-level client with `throwOnError`.

| Field       | Meaning                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| `code`      | Error code such as `MRK-2002`. See the [error code list](../errors.md) for what it means and what to do |
| `message`   | Description                                                                                             |
| `status`    | HTTP status (only for errors from engine endpoints, not for errors in `error` events)                   |
| `requestID` | The id of that request in the engine's log, for troubleshooting (not for errors in `error` events)      |
| `data`      | Extra details from the engine                                                                           |
| `retryable` | Whether trying again makes sense, as with timeouts or rate limits                                       |

Subclasses: `EngineStartError` (the engine didn't start), `EngineExitedError` (the engine exited while in use, with `exitCode`), `RequestTimeoutError` (a request took too long).

`isMerakCodeError(error)` tells whether an error came from the SDK; `fromResponse(error, response)` turns the `error` returned by the low-level client into a `MerakCodeError`. `MerakCodeError`, `isMerakCodeError` and `fromResponse` can also be imported from `@merakcode/sdk/errors` on their own (handy in browsers); the three subclasses above are not in that entry.

Errors on the model's side during a turn (a wrong key, quota used up) are not thrown. They arrive as an `error` event; whether `done` follows is in the event table in section 5.

```ts
import { createMerakCode, isMerakCodeError } from "@merakcode/sdk"

const merak = await createMerakCode({ cwd: process.cwd(), timeout: 30_000 })
try {
  const session = await merak.session()
  for await (const event of session.run("Hello")) {
    if (event.type === "error" && event.error.retryable) console.log("worth retrying later:", event.error.message)
  }
} catch (error) {
  if (isMerakCodeError(error)) console.error(`[${error.code}] ${error.message}`, error.requestID ?? "")
  else throw error
} finally {
  await merak.close()
}
```

When starting fails (`createMerakCode` itself throws) there is no engine to close, which is why it stays outside the `try`.

## 13. Logging and debugging

The SDK logs nothing by default. Pass `logger` to receive these records (type `Logger`; each record is a `LogEntry` with `level`, `message` and `data`):

- the engine starting, listening, failing to start, and exiting;
- every failed request (method, path, HTTP status, error code, `requestID`).

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

The engine writes its own logs under `~/.merakcode/logs` (or `logs` under `MERAKCODE_HOME` when that is set); an engine the SDK started writes in its `server/` folder. Read them with `merak logs`; with only the SDK installed, the engine package's `bin/merak logs` works too. To put them elsewhere, pass `MERAKCODE_LOG_ROOT` through `env`. `MERAKCODE_DIAGNOSTIC_LOGS=1` makes the engine write detailed debug logs. If you pass `clientRun`, every request line in the engine's log carries it, so you can match it with your own logs.

## 14. Versions

The SDK and the engine must be the same version. When you install the SDK from npm, the engine package is pinned to the SDK's version, so there is nothing to do.

When `executablePath` points at another engine, or `url` connects to a running one, keeping the versions the same is up to you. The SDK does not compare versions and never reports `MRK-1010`; a mismatch can show up as parameter or field errors on any endpoint. Compare the `version` from `client.global.health()` with the `@merakcode/sdk` version in your `package.json` or lockfile.

## 15. Member adapters (adapter)

A collaboration group takes Claude Code, Codex and OpenCode as members through **member adapters**. For an AI coding tool MerakCode has no adapter for, write one with this section (a few dozen lines of TypeScript), or click "Have MerakCode write an adapter to connect your own AI coding tool" under Settings › Collaboration and let the built-in skill `adapter-generator` write and register one for you.

### 15.1 What an adapter is

An adapter is a small program between MerakCode and your CLI, passing messages both ways:

```text
MerakCode  ⇄  adapter library merakcode-adapter.mjs  ⇄  your adapter.mts  ⇄  your CLI
          (the member protocol, done by the library)      (your CLI's own way of talking, written by you)
```

- MerakCode starts the adapter for each task it hands out, and the adapter exits when the task is done.
- The library does the talking to MerakCode; you need not know the protocol.
- You write the right half only: how to start your CLI, how to read its output, how to pass its approvals and questions on to MerakCode, and how to hand back the result.
- The adapter decides nothing itself. When the CLI wants to edit files, run commands, reach a website or ask the user something, it goes to MerakCode, which decides under the group's permission mode (read-only, ask, auto) and the user's rules, and shows the approval bar or the question box when needed. So a member follows the same rules as MerakCode's own tools.
- The built-in adapters for Claude Code, Codex and OpenCode are written this way too, with this library and Node built-ins only. The `adapter-generator` skill works from them as its examples.

### 15.2 How one task goes

1. The leader hands a task to a member. MerakCode starts your adapter with the command and arguments in the config (such as `node adapter.mts`), in the project directory.
2. The library first calls your `inspect`, which tells MerakCode what the CLI is called and which version it is; if it returns `unavailable`, the task fails. Settings only calls this to show a product's state; it hands out no task.
3. MerakCode sends the task, and the library calls your `run(task, host)`.
4. In `run` you start the CLI and read its output. Each time the CLI does something, needs an approval or asks a question, you call the matching method of `host` (see 15.3).
5. When the CLI is done, `run` returns `{ text, sessionId }`: `text` is the member's reply in the group; `sessionId` is the CLI's session id, given back as `task.resume` with the member's next task so it continues where it left off.
6. The adapter exits. If the user stops the group midway, `task.signal` fires, and you stop the CLI. `task.signal` also fires after a task ends normally (MerakCode closes the adapter's input once it has the result), so don't take it to mean "the user stopped".

One product may have several adapter processes at once: different members whose paths do not overlap run in parallel. So don't use fixed ports, shared temp files or global locks.

### 15.3 What host is

`host` is MerakCode. The two arguments of `run(task, host)`:

- `task` is the work at hand: the task, the project directory, the permission mode and more (see the table in 15.5);
- `host` holds the three methods for going to MerakCode while you work.

| Method                     | What it does                                                                                       | Waits?                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `host.step(step)`          | Tells MerakCode "this is what I am doing", shown live in the member's bubble, like "Bash npm test" | No, it only tells                                                             |
| `host.permission(request)` | Asks MerakCode "may I do this"; requests come in five kinds (see 15.6)                             | Yes, for "allow" or "refuse"                                                  |
| `host.question(questions)` | Has MerakCode ask the user in its question box                                                     | Yes, for the user's answers; it throws when the user skips or stops the group |

When the CLI wants to run `npm test`, one approval goes like this:

```text
CLI → adapter: "I want to run npm test"
adapter → await host.permission({ kind: "command", command: "npm test" })   ← waits here
          MerakCode decides under the permission mode: it allows, refuses outright (an edit in read-only mode, say), or shows "Xiaoming · MyCLI asks to / Wants to run a command"
          The user clicks "Allow"
host.permission resolves to { allow: true }
adapter → CLI: "go ahead"
```

You neither create nor import `host`: the library makes it and passes it to `run` as the second argument; use it there as it is. Its type is `Host` (capital H). You only import that, with `import { type Host } from "./merakcode-adapter.mjs"`, to pass `host` on to a function of your own and type its parameter, as the example in 15.5 does.

### 15.4 The files

Make a folder, preferably `~/.merakcode/adapters/<id>/` (`<id>` is the id you give the product, such as `mycli`), with three files in it:

| File                      | What it is                                                              | Where it comes from |
| ------------------------- | ----------------------------------------------------------------------- | ------------------- |
| `merakcode-adapter.mjs`   | The adapter library, which talks to MerakCode                           | Copied, unchanged   |
| `merakcode-adapter.d.mts` | The library's type declarations, for hints and type checks in an editor | Copied, unchanged   |
| `adapter.mts`             | Your adapter                                                            | Written as in 15.5  |

The first two are in MerakCode's install folder, next to three examples, the built-in adapters `example-claude-code.mts`, `example-codex.mts` and `example-opencode.mts`, which you can start from:

- Desktop app: `resources/engine/lib/skills/adapter-generator/` in the install folder; on macOS `/Applications/MerakCode.app/Contents/Resources/engine/lib/skills/adapter-generator/`;
- Command line: `~/.merakcode/versions/<version>/lib/skills/adapter-generator/` (under `MERAKCODE_INSTALL_DIR` or `MERAKCODE_HOME` if one was set at install); installed with npm, in `merakcode-<os>-<arch>/lib/skills/adapter-generator/` in the global `node_modules`.

Running needs nothing installed: the Node MerakCode ships with runs `.mts` files as they are. For type checks, run `npm install --save-dev typescript @types/node` in the folder and add a `tsconfig.json`:

```json
{ "compilerOptions": { "module": "nodenext", "target": "esnext", "strict": true, "noEmit": true, "types": ["node"] } }
```

The library's type declarations use Node's types too, and TypeScript 6 no longer loads `@types/node` by itself, hence `types`. This is for the editor and checks only, not for running.

The extension is `.mts`, not `.ts`: a `.mts` file always runs as an ES module (`import`/`export`), while a `.ts` file depends on `"type": "module"` in the nearest `package.json`. `~/.merakcode/package.json` has none, so Node would first fail to parse it the old way, parse it again, and print a warning on every start.

If your adapter is part of a Node project anyway, you can use the npm package instead of copying the library: `npm install @merakcode/sdk --omit=optional` (without `--omit=optional` it also installs the engine, about 140 MB, which an adapter does not need), then import from `@merakcode/sdk/adapter` the same way.

### 15.5 A complete example

This connects a **made-up** CLI, `mycli`, to collaboration groups. It prints one JSON event per line and reads commands on stdin. Its messages are invented: for your own adapter, use the ones your CLI's documentation gives.

```ts
// adapter.mts: connects the made-up CLI "mycli" to MerakCode's collaboration groups
import readline from "node:readline"
import { adapter, spawn, stop, version, type Host, type Permission } from "./merakcode-adapter.mjs"

// Your CLI's command. MerakCode does not tell the adapter: the config's command and arguments start the adapter itself
const CLI = "mycli"

// mycli prints one JSON event per line; these are the four the adapter uses
type MyCliEvent =
  | { type: "tool"; name: string; detail?: string } // it starts using a tool
  | { type: "approval"; id: string; action: string; path?: string; command?: string; url?: string } // it asks first
  | { type: "question"; id: string; text: string; choices: string[] } // it asks the user something
  | { type: "done"; text: string; session: string } // the task is done

// adapter() makes this program an adapter: it does the talking to MerakCode and calls the two functions below
adapter({
  // inspect: says what the CLI is, and does no work. Settings calls it to show the product's state
  inspect: async () => ({
    name: "MyCLI",
    recommended: "1.2.0", // below this version, settings suggests an upgrade (it still works)
    upgrade: "npm install -g mycli", // the upgrade command settings shows
    ...(await version(CLI)), // runs mycli --version: { version }, or { unavailable: why } when it is missing or fails
  }),

  // run: does one task. task is the work, host is MerakCode (see 15.3); the library passes both
  async run(task, host) {
    // 1. mycli's arguments for the permission mode: it asks about everything it is unsure of, and MerakCode decides
    const args = ["run", "--json", "--approvals", "ask"]
    if (task.mode === "readonly") args.push("--read-only") // read-only: it must not edit files
    if (task.resume) args.push("--session", task.resume) // continue the last session

    // 2. Start mycli. spawn from the library also starts a CLI npm installed on Windows (a .cmd file), unlike Node's
    const cli = spawn(CLI, args, { cwd: task.cwd, stdio: ["pipe", "pipe", "inherit"], windowsHide: true })
    // When the user stops the group, task.signal fires: stop mycli
    task.signal.addEventListener("abort", () => void stop(cli), { once: true })

    // Writes one JSON line to mycli's stdin
    const send = (message: object) => cli.stdin.write(JSON.stringify(message) + "\n")
    send({ prompt: task.prompt }) // hand it the task

    try {
      // 3. Read mycli's output line by line, by event type
      for await (const line of readline.createInterface({ input: cli.stdout })) {
        const event = parse(line)
        if (!event) continue // a line that is not JSON (a log line, say) is skipped

        // It starts using a tool: show it in the member's bubble
        if (event.type === "tool") host.step({ tool: event.name, detail: event.detail })

        if (event.type === "approval") {
          // Ask MerakCode whether it may, and wait for the answer (perhaps for the user to click in the approval bar)
          const verdict = await host.permission(toPermission(event))
          // Tell mycli; a refusal carries the reason, so it can try another way
          send({ approval: event.id, approved: verdict.allow, reason: verdict.allow ? undefined : verdict.message })
        }

        if (event.type === "question") await ask(host, event, send)

        // Done: text is the member's reply in the group, sessionId comes back as task.resume next time
        if (event.type === "done") return { text: event.text, sessionId: event.session }
      }
      // The output ended without a done event: mycli exited midway
      throw new Error("mycli exited without a reply")
    } finally {
      // 4. Done, failed or stopped, mycli is stopped
      await stop(cli)
    }
  },
})

/** The event on one line of output, or undefined for a line that is not JSON */
function parse(line: string): MyCliEvent | undefined {
  try {
    return JSON.parse(line) as MyCliEvent
  } catch {
    return undefined
  }
}

/** mycli's approval event as one of MerakCode's five kinds of request (see 15.6), the most specific one that fits */
function toPermission(event: Extract<MyCliEvent, { type: "approval" }>): Permission {
  if (event.action === "write" && event.path) return { kind: "write", paths: [event.path] }
  if (event.action === "shell" && event.command) return { kind: "command", command: event.command }
  if (event.action === "read" && event.path) return { kind: "read", paths: [event.path] }
  if (event.action === "fetch" && event.url)
    return { kind: "network", host: new URL(event.url).hostname, url: event.url }
  // tool only for what is none of the others, or when mycli gave no path or command: put what it gave in detail
  return { kind: "tool", name: event.action, detail: event.path ?? event.command ?? event.url }
}

/**
 * Asks the user in MerakCode's question box and passes the answer back to mycli.
 * host is passed on to a function of our own, so its parameter is typed Host
 */
async function ask(host: Host, event: Extract<MyCliEvent, { type: "question" }>, send: (message: object) => void) {
  // host.question throws when the user skips or stops the group: catch it and tell mycli there was no answer,
  // or the whole task fails
  const answers = await host
    .question([
      { question: event.text, header: "Question", options: event.choices.map((label) => ({ label, description: "" })) },
    ])
    .catch(() => [] as string[][])
  // answers holds one list per question: the labels the user picked, or what they typed; only one question here
  send({ answer: event.id, choice: answers[0]?.[0] })
}
```

Here the CLI sends one request at a time, so `await` in the loop is fine. If your CLI sends several at once, answer them without waiting in the loop, as `example-claude-code.mts` does.

The object `adapter()` takes (type `Definition`) is those two functions:

| Function           | When it is called                                                                           | What it returns                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inspect(product)` | Before each task, and when settings shows the state (no task). `unavailable` fails the task | `Info`: `name`, and optionally `version`, `path`, the recommended version `recommended`, the upgrade command `upgrade`, or `unavailable` with why                                                                 |
| `run(task, host)`  | Once per task                                                                               | `Result`: the reply `text` (it may not be empty, or the task fails), and the `sessionId` to continue next time (saved only when the task succeeds; if the CLI's session is gone, fall back to a new one yourself) |

`task` (type `Task`) holds:

| Field          | What it is                                                                                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task.prompt`  | The member's whole task, with its duty and what goes on in the group                                                                                                               |
| `task.cwd`     | The project directory, where the CLI works                                                                                                                                         |
| `task.mode`    | The group's permission mode (type `Mode`): `"readonly"`, `"ask"` or `"auto"`                                                                                                       |
| `task.resume`  | The `sessionId` the last task returned; empty the first time                                                                                                                       |
| `task.product` | The product's id and title (type `Product`). With adapter `member` it has only `id` and `title`: the config's command and arguments start the adapter itself and are not passed on |
| `task.signal`  | Fires when the user stops the group; stop the CLI then                                                                                                                             |

### 15.6 The five kinds of request

A request to `host.permission` (type `Permission`) is one of five kinds; use the most specific one that fits:

| `kind`    | When               | How                                             |
| --------- | ------------------ | ----------------------------------------------- |
| `write`   | Editing files      | `{ kind: "write", paths: ["src/a.ts"] }`        |
| `command` | Running a command  | `{ kind: "command", command: "npm test" }`      |
| `network` | Reaching a website | `{ kind: "network", host: "example.com", url }` |
| `read`    | Reading files      | `{ kind: "read", paths: [".env"] }`             |
| `tool`    | None of the others | `{ kind: "tool", name: "some tool", detail }`   |

- It resolves to a `Verdict`: `{ allow: true }` or `{ allow: false, message }`. On a refusal, pass `message` on to the CLI as the reason.
- MerakCode judges these requests by the rules of its own tools: edit for writes, read for reads, bash for commands, network for websites, and plugin tools for the rest. "Allow for this conversation", "always allow" and trusting a file or directory are all MerakCode's business: your adapter only ever gets "allow" or "refuse".
- A path may be relative to the project directory or absolute.
- Never send empty `paths` (or an empty path) or an empty `command`: with nothing to check, MerakCode refuses the request, and the refusal's `message` says what is missing. When the CLI gives no path or command, use `tool`.

A question for `host.question` (type `Question`) has `question`, a short `header`, `options` (each with `label` and `description`) and optionally `multiple` (whether several may be picked) and `custom` (true by default: the user may type an answer instead of picking). The result holds one list per question (type `Answer`) with the labels the user picked or what they typed. When the user clicks Skip or stops the group, `host.question` throws (`The user dismissed this question`): catch it and tell the CLI there was no answer, or the whole task fails. A step for `host.step` (type `Step`) is `{ tool, detail }`.

### 15.7 Try it yourself first

In the adapter's folder, run (with Node 24 or later on your machine):

```sh
# Only the handshake, no work: it prints the name and version
node merakcode-adapter.mjs check -- node adapter.mts

# A real task: it uses your CLI's own model and may cost money. Run it in a new empty directory, with your adapter folder
node <adapter folder>/merakcode-adapter.mjs test -- node <adapter folder>/adapter.mts "Run node --version, then create hello.txt containing hi, then reply OK"
```

Test mode prints every step, permission request and question, allows each request, picks the first option of each question, then prints the result and the session id. It works when all three hold:

- `node --version` arrives as a `command` request;
- writing `hello.txt` arrives as a `write` request;
- the result comes back.

A passing `check` alone proves only the handshake (it exits with 0 even when `inspect` returns `unavailable`). Test mode always uses `ask` mode, the current directory, and the product `{ id: "test", title: "test" }`, so it cannot check the arguments for read-only mode. In the SDK the same entry is `cli(argv)`.

### 15.8 Register it with MerakCode

Add a product to the global config `~/.merakcode/merakcode.jsonc` (or `merakcode.json` if that is the one there; under `MERAKCODE_HOME` when that is set), with `member` as its adapter. Don't use `merak` or the id of an existing product: a built-in product's id overrides that built-in product. `args` do not go through a shell, so `~` and environment variables are not expanded; on Windows, double the backslashes in JSON or use `/`.

```jsonc
{
  "collaboration": {
    "products": {
      "mycli": {
        "title": "MyCLI",
        "adapter": "member",
        // node is the Node MerakCode ships with, so it runs even where Node is not installed
        "command": "node",
        // the adapter's absolute path
        "args": ["/Users/<you>/.merakcode/adapters/mycli/adapter.mts"],
      },
    },
  },
}
```

Or add it under Settings › Collaboration › Add product: set Driven by to "Member adapter (command and arguments start your adapter)", enter `node` as the command and the adapter's path as the argument.

Once registered, the product's row in settings shows the version `inspect` reports and "Permissions: approved in MerakCode", and members of it can be added to a group. Settings caches the check for 60 seconds; after changing `adapter.mts`, click Check again.

### 15.9 Rules while it runs, and common mistakes

- **One process per task**: each task starts a new adapter process. Continuing the last one is what the `sessionId` you return is for.
- **The user stops the group**: `task.signal` fires and you stop the CLI. MerakCode also closes the adapter's stdin, and the library exits the adapter 5 seconds later; an adapter still there then is ended with what it started. So stop the CLI within 5 seconds: on macOS and Linux, a CLI left running when the adapter exits is not necessarily cleaned up with it.
- **MerakCode exits**: the adapter's stdin closes, `task.signal` fires, and the library exits the adapter 5 seconds later; whether the CLI goes too depends on your calling `stop` on `task.signal`.
- **`inspect` in settings has a time limit**: with no answer within 10 seconds, the product shows as unavailable. The call before a task has none, so keep `inspect` quick and free of side effects; in settings its working directory is not the project, so don't rely on it.
- **Never print to stdout**: stdout is for talking to MerakCode. The library sends only `console.log` and `console.info` to stderr (MerakCode's log); `console.debug` and `console.dir` still write to stdout, so log with `console.error`. Writing to `process.stdout`, or letting the CLI inherit the adapter's stdout, breaks the talking.
- **Troubleshooting**: every line the adapter writes to stderr goes into MerakCode's log (`merak logs`). When an adapter exits midway, the failure message carries its last error line.
- **Never give the CLI options that skip approvals** (such as "allow everything"): MerakCode then no longer governs it, and the permission mode and approvals stop working.
- **An adapter runs with your own rights, outside MerakCode's sandbox.** MerakCode only governs what the CLI asks about, so connect only CLIs you trust.

### 15.10 What TypeScript can be used

The Node MerakCode ships with runs a `.mts` file by removing its types, so:

- Types are not checked when it runs. An editor finds type errors, or run `npx tsc` in the folder with the `tsconfig.json` from 15.4.
- Only TypeScript that is JavaScript once its types are removed works: type annotations, `type`, `interface`, `as`, `!` and generics are fine; **`enum`, `namespace` and constructor parameter properties (`constructor(private x)`) are not**, and Node stops with a syntax error.
- Import what is only a type with `type`, as in `import { adapter, type Host } from "./merakcode-adapter.mjs"`.
- Write relative imports with their full extension, such as `./merakcode-adapter.mjs`.

### 15.11 More in the library

- `spawn`: takes the same arguments and returns the same as `spawn` from `node:child_process`, and also starts a CLI npm installed on Windows (a `.cmd` file), passing its arguments unchanged.
- `stop(child)`: ends a CLI and everything it started, and resolves once that is done. A CLI whose input is still open gets it closed and up to 3 seconds to exit; after that the whole tree is killed on Windows, while macOS and Linux get `SIGTERM` and up to 3 more seconds (no `SIGKILL`).
- `version(command)`: runs `<cli> --version` and gives the first line, or why there is none (not installed, failing, or no answer within 5 seconds).
- `connect`: when your CLI speaks JSON-RPC too, it connects to it; see `example-codex.mts`. Requests still waiting when the other side goes away fail with `ConnectionClosed`.
- `PROTOCOL`: the member protocol's version. The protocol is JSON-RPC 2.0 on stdin and stdout, one message per line, which the library takes care of.
