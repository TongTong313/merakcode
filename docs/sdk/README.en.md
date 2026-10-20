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
| `@merakcode/sdk/errors`     | The `MerakCodeError` class and helpers. Works in browsers too                                               |

## 2. Install and requirements

```sh
npm install @merakcode/sdk
```

- Needs Node.js 24 or newer.
- Supports Windows, macOS and Linux on x64 and arm64.
- npm also installs one engine package for your system, named `merakcode-<os>-<arch>` (such as `merakcode-windows-x64`). It carries its own Node and the engine, so it is fairly large. It is an optional dependency: with `--omit=optional`, or when you move `node_modules` to a different system, the engine is missing and you get `MRK-1001`.

**Using a different engine.** To use an engine other than the one from npm, set `executablePath`:

- An executable: on macOS / Linux you can point at an installed `merak`, such as `~/.merakcode/versions/<version>/bin/merak`.
- A command prefix array: on Windows `merak.cmd` cannot be started directly, so write `[<version dir>\node\node.exe, <version dir>\lib\index.js]`. To run from source, write it like this:

```ts
import { createMerakCode } from "@merakcode/sdk"

const repo = "/path/to/merakcode"
const merak = await createMerakCode({
  executablePath: [process.execPath, "--import", `${repo}/script/node/register.mjs`, `${repo}/apps/cli/src/index.ts`],
})
await merak.close()
```

**Connecting to a running engine.** Pass `url` instead of starting a new process. If the engine has a password (the `MERAKCODE_SERVER_PASSWORD` environment variable), the user name is `merakcode`; send it with HTTP Basic auth:

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

In this case `close()` only disconnects; it does not stop that engine.

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

It uses the default model of a provider you have already connected (for example, Qwen when `DASHSCOPE_API_KEY` is set). If you haven't connected one yet, run `merak` and type `/provider`, or put it in the `config` option (see section 5).

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
- **Agent**: decides the prompt and which tools are available. The default is `build`; the subagents are `general` and `explore`. You can add your own in the config.
- **Model**: written as `provider/model`, such as `anthropic/claude-sonnet-4-5` or `alibaba-cn/qwen-plus`. `merak models` lists what you can use.
- **Permission mode**: `readonly`, `ask` (default) or `auto`. Together with your permission rules it decides whether an action that changes things runs, asks first, or is refused.
- **Events**: the engine pushes every change (new messages, part updates, approval requests, session status...) over an event stream. The high-level API picks out the events of the current session for you.

## 5. High-level API

### createMerakCode(options)

Starts (or connects to) an engine and returns a `MerakCode` object. Options (type `MerakCodeOptions`, which includes every field of `EngineOptions`):

| Option           | Meaning                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| `cwd`            | Project folder. The engine's working directory when it is started, and the folder every request is about     |
| `executablePath` | Engine command, see section 2. Defaults to the engine package from npm                                       |
| `env`            | Extra environment variables for the engine process (merged with the current process's)                       |
| `config`         | Inline config, written like `merakcode.json`, with the highest priority                                      |
| `agents`         | Custom agents, written like the `agent` section of the config (type `AgentConfig`)                           |
| `timeout`        | How long to wait for the engine to start, in milliseconds. Default 60000                                     |
| `serve`          | Arguments for `merak serve`. Default `["--hostname", "127.0.0.1", "--port", "0"]` (a random local port only) |
| `signal`         | Cancels starting                                                                                             |
| `logger`         | Log callback, see section 13                                                                                 |
| `url`            | Connect to a running engine instead of starting one                                                          |
| `headers`        | Request headers (such as the password) when connecting to a running engine                                   |
| `tools`          | Host tools, see section 7                                                                                    |
| `clientRun`      | Your own run or trace id; the engine writes it into the log line of every request                            |

`config`, `agents`, `env`, `timeout`, `serve` and `executablePath` only apply when a new engine is started; they are ignored with `url`.

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

| Member                 | Meaning                                                                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `info`           | Session id and full details                                                                                                                                                |
| `run(prompt, options)` | Sends a message and returns this turn's events. Ends with `done` when the turn is over                                                                                     |
| `events(handlers)`     | All later events of this session, across turns. A background workflow sends the session another turn when it finishes; use this to keep waiting. Ends when `signal` aborts |
| `messages()`           | Every message and part in the session                                                                                                                                      |
| `abort()`              | Stops the running turn (queued messages still run)                                                                                                                         |

Options of `run` (`RunOptions`, which includes every field of `Handlers`):

| Option         | Meaning                                                                                |
| -------------- | -------------------------------------------------------------------------------------- |
| `model`        | Model for this turn, as `provider/model`                                               |
| `agent`        | Agent for this turn                                                                    |
| `mode`         | Permission mode: `"readonly"`, `"ask"` or `"auto"`                                     |
| `onPermission` | Called for approvals, see section 6. Without it everything is denied                   |
| `onQuestion`   | Called when the model asks a question, see section 6. Without it questions are skipped |
| `signal`       | Stops this turn                                                                        |

`run` produces 5 kinds of events (`RunEvent`):

| `type`      | Contents                                                                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`      | A piece of the reply (`delta`) as it is generated; `partID` tells reply paragraphs apart                                                       |
| `reasoning` | A piece of the model's thinking, only for models with thinking on. Some models put the answer only in their thinking and leave the reply empty |
| `part`      | The latest full state of any other part, such as a tool call starting or finishing                                                             |
| `error`     | Something went wrong in this turn (`error` is a `MerakCodeError`); `done` still follows                                                        |
| `done`      | The turn is over; `message` is the full reply, with `cost` and `tokens`                                                                        |

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

## 6. Approvals, questions and stopping

### Approvals

When the agent wants to edit files, run commands or go online and the permission rules say to ask, the engine sends an approval request (`PermissionRequest`) and the SDK calls your `onPermission`. Approvals from subagents and workflows come here too.

Useful fields of `PermissionRequest`:

| Field        | Meaning                                                                                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `permission` | What it wants to do: `read`, `edit`, `bash`, `network`, `mcp`, `subagent`, `workflow_run`, `cron`, or a tool name. It does not say how risky it is: `git push` is also `bash`, and editing outside the workspace is also `edit` |
| `patterns`   | The specifics, such as the command, file paths or host names                                                                                                                                                                    |
| `metadata`   | Extra details that depend on the action, such as a description of the command or the change                                                                                                                                     |
| `sessionID`  | The session that asked; `root` is its top-level session                                                                                                                                                                         |
| `tool`       | The tool call that triggered it                                                                                                                                                                                                 |

Return one `PermissionDecision`:

- `"allow-once"`: allow this one time
- `"allow-session"`: allow the same request for the rest of this session
- `"always"`: always allow, saved to the project config
- `"deny"`: refuse

Without `onPermission` everything is denied: if the host says nothing, nothing goes through.

```ts
import { createMerakCode } from "@merakcode/sdk"

const merak = await createMerakCode({ cwd: process.cwd() })
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

Sometimes the model stops to ask multiple-choice questions (`QuestionRequest`). Each entry in `questions` has `question` (the text), `header` (a short title) and `options` (each with `label` and `description`); `multiple` means more than one can be picked, and `custom` means you can write your own answer.

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
- If the engine process exits unexpectedly, iterations waiting for events throw `EngineExitedError` (`MRK-1004`).
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

The agent may start a background workflow and end the turn first; when the workflow finishes, the engine sends the session another turn. Keep waiting with `events()`:

```ts
import { createMerakCode } from "@merakcode/sdk"

const merak = await createMerakCode({ cwd: process.cwd() })
const session = await merak.session()
for await (const event of session.run("In the background, translate every document in docs into Chinese")) {
  if (event.type === "text") process.stdout.write(event.delta)
}
const controller = new AbortController()
for await (const event of session.events({ signal: controller.signal, onPermission: () => "allow-once" })) {
  if (event.type === "text") process.stdout.write(event.delta)
  if (event.type === "done") controller.abort()
}
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

| Field         | Meaning                                                                               |
| ------------- | ------------------------------------------------------------------------------------- |
| `name`        | Tool name; also its `permission` in approvals                                         |
| `description` | What the model reads; say when to use it                                              |
| `args`        | Parameters as a zod shape: `{ name: schema }`                                         |
| `run`         | `(args, context) => string`, may be async. A thrown error's message goes to the model |

`context` (type `ToolRunContext`) has `sessionID`, `messageID` and `callID`.

Host tools need approval like any other tool; the permission name is the tool name.

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

Put a `.ts` or `.js` file in the project's `.merakcode/tool/` folder (or the global `~/.config/merakcode/tool/`). The default export becomes a tool named after the file; other named exports become `file_export`. Turn one off with `"tools": { "file": false }` in the config.

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

- `.ts` / `.js` files in the project's `.merakcode/plugin/` or the global `~/.config/merakcode/plugin/` folder;
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
| `auth`                                       | When the user signs in to a provider in `/provider`                                     | Offers OAuth or API key sign-in (type `AuthHook`; the OAuth result is `AuthOAuthResult`)                                                |
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

The client from `createMerakCodeClient` covers every engine endpoint, grouped by area: `client.session`, `client.permission`, `client.provider`, `client.file`, `client.mcp` and so on. Every method, parameter and return type is in the [API reference](reference.md). It doesn't depend on Node and works in browsers.

Options (`MerakCodeClientConfig` plus these):

| Option             | Meaning                                                                            |
| ------------------ | ---------------------------------------------------------------------------------- |
| `baseUrl`          | Engine URL                                                                         |
| `headers`          | Request headers, such as the password                                              |
| `directory`        | Project folder, sent with every request                                            |
| `workspaceFolders` | Folders of a multi-root workspace (`{ name?, path }[]`)                            |
| `clientRun`        | Your run id, written into the engine's request log                                 |
| `logger`           | Called for every failed request                                                    |
| `fetch`            | Your own fetch                                                                     |
| `throwOnError`     | When `true`, errors throw the engine's error body instead of returning `{ error }` |

Each method takes one object as its first argument, with path parameters, query parameters and body fields all at the top level; the second argument can carry `signal`, `headers` and `throwOnError`. It resolves to `{ data, error, response }`: `data` on success, `error` on failure. `fromResponse(error, response)` turns the error into a `MerakCodeError`.

`client.event.subscribe()` resolves to `{ stream }`, an async iterator over every event for the current folder; `client.global.event()` covers every folder, and each item is `{ directory, payload }`: `payload` is the event and `directory` the project folder it belongs to (events that belong to no folder, such as `server.connected`, have none).

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
await client.session.promptAsync({ sessionID: created.data.id, parts: [{ type: "text", text: "Hello" }] })
for await (const event of events.stream) {
  if (event.type === "session.idle" && event.properties.sessionID === created.data.id) break
}
controller.abort()
await engine.close()
```

## 9. Engine process

`@merakcode/sdk/process` only handles the engine process:

- `startEngine(options)`: starts an engine and returns an `Engine` once it is listening. The options are `cwd`, `executablePath`, `env`, `config`, `timeout`, `serve`, `signal` and `logger` from the table in section 5 (type `EngineOptions`). Every start uses a random port and a one-time password, which reaches the engine only through an environment variable.
- `resolveEngine()`: returns the command (an array) that starts the engine package from npm; throws `MRK-1001` if it isn't there.

`Engine`:

| Member    | Meaning                                                                      |
| --------- | ---------------------------------------------------------------------------- |
| `url`     | Engine URL, such as `http://127.0.0.1:53124`                                 |
| `headers` | Request headers for the engine (with the password)                           |
| `pid`     | Process id                                                                   |
| `exited`  | Resolves when the process exits, with its exit code (0 after a normal close) |
| `close()` | Asks the engine to exit and waits; kills it if it hasn't exited in 8 seconds |

The engine and your program share an IPC channel. When your program exits or crashes, the channel closes and the engine exits on its own, so no orphan process is left behind.

If starting fails you get an `EngineStartError`: `output` holds the engine's last output, and the message includes its last 5 lines. A timeout is `MRK-1002`, any other start failure is `MRK-1003`, and cancelling with `signal` is `MRK-4002`.

## 10. Session state (store)

A UI needs to turn the stream of events into "which sessions are there, what messages does each have, what's waiting for approval". `@merakcode/sdk/store` does that. It isn't tied to any UI framework and works in browsers:

| Function / type              | Meaning                                                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createSessionsState()`      | A new empty state (type `SessionsState`)                                                                                                           |
| `applyEvent(state, event)`   | Merges one event into the state, changing the object you pass in. Returns a `Change`: `insert`, `update`, `remove`, `replace`, `none` or `ignored` |
| `activity(state, sessionID)` | What a session is doing now (`Activity`): `approval`, `question`, `running` or `idle`. Child sessions count toward their top-level session         |
| `rootOf(state, sessionID)`   | Follows `parentID` up to the top-level session                                                                                                     |
| `forgetSession(state, id)`   | Drops everything cached for a session                                                                                                              |
| `search(list, id, key)`      | Binary search in a list sorted by id; returns `{ found, index }`                                                                                   |

Every list in the state is sorted by id (engine ids increase over time). Updates merge in place and unchanged child objects keep their references, so UI frameworks only redraw what changed. With Solid you can write `setStore(produce((draft) => applyEvent(draft, event)))`.

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

Options (`TranscriptOptions`): `thinking` (include the model's thinking), `toolDetails` (include tool inputs and outputs), `assistantMetadata` (include the model name and timing), `lang` (`"zh"` or `"en"`, Chinese by default).

```ts
import { writeFile } from "node:fs/promises"
import { createMerakCode } from "@merakcode/sdk"
import { formatTranscript } from "@merakcode/sdk/transcript"

const merak = await createMerakCode({ cwd: process.cwd() })
const session = await merak.session({ id: "ses_xxx" })
const messages = await session.messages()
const markdown = formatTranscript(session.info, messages, {
  thinking: false,
  toolDetails: true,
  assistantMetadata: true,
  lang: "en",
})
await writeFile("session.md", markdown)
await merak.close()
```

## 12. Errors

Every error the SDK throws is a `MerakCodeError` (or a subclass):

| Field       | Meaning                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| `code`      | Error code such as `MRK-2002`. See the [error code list](../errors.md) for what it means and what to do |
| `message`   | Description                                                                                             |
| `status`    | HTTP status (only for errors from the engine)                                                           |
| `requestID` | The id of that request in the engine's log, for troubleshooting                                         |
| `data`      | Extra details from the engine                                                                           |
| `retryable` | Whether trying again makes sense, as with timeouts or rate limits                                       |

Subclasses: `EngineStartError` (the engine didn't start), `EngineExitedError` (the engine exited while in use, with `exitCode`), `RequestTimeoutError` (a request took too long).

`isMerakCodeError(error)` tells whether an error came from the SDK; `fromResponse(error, response)` turns the `error` returned by the low-level client into a `MerakCodeError`. These three can also be imported from `@merakcode/sdk/errors` on their own (handy in browsers).

Errors on the model's side during a turn (a wrong key, quota used up) are not thrown. They arrive as an `error` event, followed by `done` as usual.

```ts
import { createMerakCode, isMerakCodeError } from "@merakcode/sdk"

try {
  const merak = await createMerakCode({ cwd: process.cwd(), timeout: 30_000 })
  const session = await merak.session()
  for await (const event of session.run("Hello")) {
    if (event.type === "error" && event.error.retryable) console.log("worth retrying later:", event.error.message)
  }
  await merak.close()
} catch (error) {
  if (isMerakCodeError(error)) console.error(`[${error.code}] ${error.message}`, error.requestID ?? "")
  else throw error
}
```

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

The engine writes its own logs to the local log folder; read them with `merak logs`. To put them elsewhere, pass `MERAKCODE_LOG_ROOT` through `env`. `MERAKCODE_DIAGNOSTIC_LOGS=1` makes the engine write detailed debug logs. If you pass `clientRun`, every request line in the engine's log carries it, so you can match it with your own logs.

## 14. Versions

The SDK and the engine must be the same version. When you install the SDK from npm, the engine package is pinned to the SDK's version, so there is nothing to do.

When `executablePath` points at another engine, or `url` connects to a running one, keeping the versions the same is up to you. `client.global.health()` tells you the engine's version.
