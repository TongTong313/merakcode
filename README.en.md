<p align="center">
  <img src="apps/desktop/renderer/public/logo.svg" width="72" alt="MerakCode" />
</p>

<h1 align="center">MerakCode</h1>

<p align="center">An entry-point AI coding tool</p>

<p align="center">
  <a href="https://github.com/TongTong313/merakcode/actions/workflows/ci.yml"><img src="https://github.com/TongTong313/merakcode/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/TongTong313/merakcode/releases"><img src="https://img.shields.io/github/v/release/TongTong313/merakcode?include_prereleases" alt="Release" /></a>
  <a href="https://www.npmjs.com/package/merakcode"><img src="https://img.shields.io/npm/v/merakcode" alt="npm" /></a>
  <a href="#develop-from-source"><img src="https://img.shields.io/badge/dev%20node-%3E%3D26.12-339933?logo=nodedotjs&logoColor=white" alt="Node.js (development)" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-7.0-3178C6?logo=typescript&logoColor=white" alt="TypeScript" /></a>
</p>

<p align="center"><a href="README.md">简体中文</a> · English</p>

---

MerakCode is an open-source **entry-point AI coding tool**. The idea came from me: I like using Claude Code, Codex, OpenCode and other products together, but there was no good entry-point AI coding tool for that, so MerakCode came to be. Now that AI generates far faster than people can read, we are not competing on AI coding ability (though MerakCode itself has strong coding ability). We care more about how people and tools work together in real coding. Connecting and combining other AI coding harnesses is what MerakCode is for. MerakCode's collaboration groups let Claude Code, Codex, OpenCode and other products work together. If you use these AI coding tools and want to combine them to get the most out of them, MerakCode is a good choice.

We open-sourced this project to make up for a regret we have carried, and in the hope that the community can keep it going. The name comes from Merak, the star in the Big Dipper that, together with Dubhe, points to Polaris. We hope MerakCode does the same and points each of your ideas in the right direction.

## What it does

- **AI coding**: strong project-level coding across many languages, frameworks, paradigms and styles. Honestly, this part is no different from other AI coding products. You be the judge, and if you like it, a Star is the best way to support us.
- **Collaboration across products**: MerakCode is designed around people and the agent working together. It has a review interface built specifically for checking what the agent produces (desktop app only) and a complete permission system for what the agent may do. It can also work alongside other AI coding products that ship a CLI, so the collaboration reaches across products.
- **Model setup**: connect all kinds of model providers (only 8 for now, more to come) as well as local models. MerakCode can also use models through API relay services.
- **Secure and reliable**: commands the agent runs go into our own OS sandbox. They cannot read key folders such as `~/.ssh` or `~/.aws`, can write only the workspace, temp folders and package manager caches, and need your approval for hosts that are not on the allowlist (on Windows, set it up once in Settings first; collaboration members' commands do not run in it; for what it does and does not guarantee, see [Permissions and the sandbox](#permissions-and-the-sandbox)). This is a small product built by a few people, with no server side (no time to build one...). We don't collect, and couldn't collect, any usage data, so there is nothing of yours to leak.
- **Extensible**: MCP, skills, plugins, custom agents and slash commands.
- **Beyond coding**: AI coding is one of the hardest kinds of task there is, so using MerakCode for other things works just fine.
- **Build your own**: MerakCode ships an agent SDK, and every MerakCode product is built on it. You can build your own AI coding tool on the same engine.

## How to install

### Desktop app

Download from the [Releases](https://github.com/TongTong313/merakcode/releases) page:

| System  | File                                                                              |
| ------- | --------------------------------------------------------------------------------- |
| Windows | `MerakCode-<version>-windows-x64.exe`                                             |
| macOS   | `MerakCode-<version>-darwin-arm64.dmg` (Apple silicon), `-darwin-x64.dmg` (Intel) |
| Linux   | `MerakCode-<version>-linux-x64.AppImage` or `.deb`                                |

The desktop app ships with its own engine; you do not need the command-line version as well.

The installers are not code-signed yet, so the system stops them the first time:

- **Windows**: when you see "Windows protected your PC", click "More info", then "Run anyway".
- **macOS**: if the app "cannot be opened", go to System Settings → Privacy & Security and click "Open Anyway" near the bottom.

Unsigned macOS builds, and Linux installs from a `.deb`, cannot update themselves. When a new version is out, the app sends you to the download page.

### Command line

The command-line version has no UI. It is for one-off tasks in a terminal, scripts, and editors (through ACP). It shares its config and keys with the desktop app. It runs on Linux (x64 and arm64, with glibc; musl systems such as Alpine are not supported yet), macOS (Apple silicon and Intel) and Windows (x64 and arm64).

macOS / Linux:

```sh
curl -fsSL https://github.com/TongTong313/merakcode/releases/latest/download/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://github.com/TongTong313/merakcode/releases/latest/download/install.ps1 | iex
```

Or with npm (the package brings its own runtime; any Node.js 18 or newer can install it):

```sh
npm install -g merakcode
```

The command is `merak`. Upgrade later with `merak upgrade` (or `merak update`; `merak upgrade <version>` installs a given version).

- The install script puts the program in `~/.merakcode/versions/<version>/`. On macOS / Linux the command goes in `~/.local/bin/merak` (the script tells you if that is not on your PATH); on Windows it goes in `~\.merakcode\bin`, which is added to your user PATH.
- For a mirror, the install script and `merak upgrade` read `MERAKCODE_DOWNLOAD_BASE` (where to download from), and upgrades of an npm install read `MERAKCODE_NPM_REGISTRY`. `MERAKCODE_VERSION`, `MERAKCODE_INSTALL_DIR` and `MERAKCODE_BIN_DIR` pick the version and where it goes.
- If Linux says the bundled Node does not start, libatomic is usually missing: install `libatomic1` on Debian / Ubuntu, or `libatomic` on Fedora / RHEL.

To check a command-line archive yourself (`merakcode-<version>-<platform>.tar.gz` or `.zip`; the install scripts already check it for you), put the release's `SHA256SUMS` in the same folder as the archive and run (`SHA256SUMS` lists only the command-line archives, not the desktop installers):

```sh
sha256sum -c SHA256SUMS --ignore-missing                 # Linux
grep 'darwin-arm64.tar.gz' SHA256SUMS | shasum -a 256 -c # macOS (Apple silicon)
grep 'darwin-x64.tar.gz' SHA256SUMS | shasum -a 256 -c   # macOS (Intel)
```

The `shasum` that ships with macOS has no `--ignore-missing`, so the commands above check only the line for the file you downloaded.

```powershell
# Windows: the output must equal the value on this file's line in SHA256SUMS
(Get-FileHash .\merakcode-<version>-windows-x64.zip).Hash.ToLower()
```

### Uninstall

On Windows, if you set up the sandbox, first click "Reset" under Settings → Permissions & security in the desktop app (or run `merak sandbox reset`). It removes the sandbox account and firewall rule and takes back the folder permissions it was given.

- Desktop app: on Windows, uninstall it under Settings → Apps; on macOS, drag MerakCode from Applications to the Trash; on Linux, delete the AppImage, or run `sudo apt remove merakcode-desktop` for the `.deb`.
- Installed with the script: the program is in `~/.merakcode/versions/` (it goes with the folder below); on macOS / Linux also delete `~/.local/bin/merak`; on Windows remove `~\.merakcode\bin` from your user PATH.
- Installed with npm: `npm uninstall -g merakcode`.
- Config, API keys (kept in plain text in `~/.merakcode/data/auth.json`), sessions, logs, caches and a script-installed program all live in one folder, `~/.merakcode` (on Windows `~` is `C:\Users\<you>`; the `MERAKCODE_HOME` environment variable moves it). Delete it if you no longer need it.

## Quick start

Open the desktop app and click "Open folder" to pick your project.

The first time, connect a model provider: on the onboarding screen, pick a provider and enter its API key (change it later under Settings → Models & providers). The built-in catalog is OpenAI, Anthropic, Google, Alibaba (China), Zhipu AI, DeepSeek, Moonshot AI (China) and OpenRouter; Alibaba, Zhipu and Moonshot use their mainland China endpoints. Keys in environment variables (such as `OPENAI_API_KEY`) are not picked up on their own.

For any other service (a local Ollama or LM Studio, a company gateway, or an API relay), click "Add custom provider" under Settings → Models & providers and choose "Compatible API" or "Relay"; on the command line, `merak provider relay` adds a relay. A local model needs no key, but enter one anyway (such as `none`): a provider without a key is not listed.

Once connected, the model menu turns on only a few current models for each built-in provider (none for OpenRouter), and every model of a custom provider. For other models, click "Add model" at the bottom of the model menu and turn them on under that provider's "Configure" in Settings.

Then just say what you want:

```text
Add unit tests for formatDate in utils/date.ts
```

Handy actions (`⌘` on macOS, `Ctrl` on Windows and Linux):

| Action                | What it does                                                                  |
| --------------------- | ----------------------------------------------------------------------------- |
| `⌘/Ctrl+K`            | Command palette: search conversation titles, conversation content or commands |
| `⌘/Ctrl+N`            | New conversation                                                              |
| `⌘/Ctrl+G`            | New team (a collaboration group)                                              |
| `⌘/Ctrl+,`            | Open settings                                                                 |
| `⌘/Ctrl+J`            | Open or close the terminal                                                    |
| `⌘/Ctrl+B`            | Show or hide the side panel                                                   |
| `Shift+Tab`           | Switch permission mode                                                        |
| Type `/` in the input | Pick a slash command, such as `/compact` to shrink a long conversation        |
| Type `@` in the input | Reference a file in the project                                               |

## Commands

The command-line version runs in a terminal. If you have not connected a model provider in the desktop app, run `merak provider login` first. Then run a task in your project folder and get the result printed:

```sh
cd your-project
merak run "Explain how src/index.ts starts up"
```

| Command                                         | What it does                                                                                                                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `merak run "<task>"`                            | Run one task and print the result. `-c` continues the last session, `-m` picks the model, `-f` attaches files, `--format json` prints the raw events; the task can also come from a pipe |
| `merak run --auto "<task>"`                     | Run it in auto mode; see below                                                                                                                                                           |
| `merak provider login`                          | Connect a model provider; `list` shows the connected ones, `logout` removes one, `relay` adds a relay                                                                                    |
| `merak serve --port 4096`                       | Start only the engine, for the SDK or other programs                                                                                                                                     |
| `merak upgrade` (or `update`)                   | Upgrade. `--check` only looks for a new version, `--yes` skips the question                                                                                                              |
| `merak models`                                  | List the models you can use; `--refresh` fetches the model lists again                                                                                                                   |
| `merak mcp list`                                | Show MCP server status                                                                                                                                                                   |
| `merak skill`, `merak plugin`                   | Manage skills and plugins                                                                                                                                                                |
| `merak session`, `merak export`, `merak import` | Manage, export and import sessions                                                                                                                                                       |
| `merak stats`                                   | Token usage and cost                                                                                                                                                                     |
| `merak sandbox status`                          | Is the sandbox on? `setup` sets it up (Windows only), `reset` undoes it                                                                                                                  |
| `merak doctor`                                  | Check the install, config, models and sandbox, and say what is wrong                                                                                                                     |
| `merak logs`                                    | Where the logs are and recent runs; `--tail` follows the newest log                                                                                                                      |
| `merak bug-report`                              | Zip the checks, config and logs for an issue; keys and conversations are left out                                                                                                        |
| `merak acp`                                     | Run as an [ACP](https://agentclientprotocol.com) agent for editors such as Zed                                                                                                           |

Add `--help` to any command for the full details.

`merak run` has no one to approve anything: an action that would ask (in ask mode, `npm install` or `npm test`, say) is refused, and the agent is told why. To let such actions through, add `--auto`, or write allow rules in the project config (see [Configuration](#configuration)). `--auto` directly allows every action, asks nothing and skips the command sandbox; use it only when you fully trust the task.

`merak serve` listens only on `127.0.0.1` by default, but has no password, so any program on this computer can call it. When other programs connect, set the environment variable `MERAKCODE_SERVER_PASSWORD` (HTTP Basic auth; the user name is `merakcode` by default). See [SECURITY.md](SECURITY.md#the-engines-api).

### In your editor (ACP)

Editors that speak [ACP](https://agentclientprotocol.com) can use MerakCode as their agent. For Zed, add this to `~/.config/zed/settings.json`:

```json
{
  "agent_servers": {
    "MerakCode": { "command": "merak", "args": ["acp"] }
  }
}
```

## Permissions and the sandbox

Sessions use `plan`, `execute` (the default), and `auto`. The selector sits immediately after the attachment button at the lower left of the composer; `Shift+Tab` also switches modes. Modes select available tool categories. In plan and execute, existing authorization rules and the OS sandbox assess each operation.

| Mode              | Behavior                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan              | Research, reads and read-only commands; writes only the current session plan, without modifying project files.                                                                                    |
| Execute (default) | Read, write and execute tasks under existing external-directory, sensitive-path, dangerous-command, network and sandbox rules.                                                                    |
| Auto              | Red danger mode. The backend allows all safety requests, including deny rules, blacklisted operations and external access, and bypasses the command sandbox. No new questions or approval popups. |

Execute normally edits workspace files directly when no path segment starts with `.`. Hidden paths, MerakCode configuration, secrets, external access, mutating or dangerous commands and websites off the allowlist retain their existing checks. Text classification cannot observe every action inside scripts or commands constructed from variables; the OS sandbox adds enforcement. Auto bypasses these safety controls without creating permanent grants. Input validation, cancellation and concurrent-edit conflict protection still apply.

Mode changes apply immediately without restarting the conversation. Incompatible controllable operations are interrupted; completed writes are not rolled back. Same-mode messages preserve approved running work. Entering auto releases pending safety approvals, while questions already asked still require a human response. Processes already running in an OS sandbox retain its restrictions.

A completed plan shows “Plan generated / Awaiting review”, with actions to view, edit, execute or continue editing. Review has no timeout; a suggestion to enter plan still times out after 15 seconds. Each session has one plan, opened in the same editor from the card or Plan tab. Human saves take priority. Execution uses the latest saved content when work actually starts; later edits do not change that execution. See [Session modes and plans](docs/session-modes.md).

External products retain their native tools. Direct chats and group members share host authorization, which controls only reported operations. Unreported actions and each product's own sandbox remain outside host control; settings describe those limits. Auto allows reported safety requests and refuses new questions.

The **OS sandbox** keeps its independent on/off setting. When enabled in plan or execute, it limits command writes to the workspace, temporary directories and package caches, and restricts secret directories, protected configuration and network access. Auto bypasses command sandbox enforcement regardless of the switch, without changing that setting. Leaving auto restores the configured policy.

| System  | Built on                                                   | Setup                                                                                                 |
| ------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Windows | Separate low-rights account, NTFS permissions and firewall | Set up in the sandbox control or run `merak sandbox setup`; one administrator confirmation is needed. |
| Linux   | Landlock (kernel 5.13+, glibc)                             | None; network restrictions need kernel 6.7+.                                                          |
| macOS   | Seatbelt (sandbox-exec)                                    | None.                                                                                                 |

In plan and execute, mutating commands still ask when a preferred sandbox is unavailable. Setup or turning the sandbox off re-evaluates requests blocked only on readiness. See [SECURITY.md](SECURITY.md) for the enforcement boundary.

## Collaboration groups

In a collaboration group MerakCode is the leader, and Claude Code, Codex, OpenCode and other AI coding tools can be members. Say what you want in the group; the leader splits it into tasks for the members, and each replies in the group when it is done.

- Create one from New team in the sidebar, `⌘/Ctrl+G` or the command palette (with a project open). You can also copy the name and members of an existing group, with their roles and duties; members whose product is unavailable here are skipped, and Clear undoes the copy.
- A member can be MerakCode itself. The leader can hand out work to several members at once: members whose paths do not overlap work at the same time, while the same member or overlapping paths wait their turn.
- Mention a member with `@` in the input; rename it or change its role and duty in the member column.
- What members want to do, and what they ask, shows in the approval bar and the question box, decided by the permission mode you chose.
- Under Settings › Collaboration, turn products on or off, see their versions and paths and who decides their permissions (MerakCode approves for a product with an adapter; a one-shot command decides itself), and add your own. A CLI older than recommended shows how to upgrade it (`claude update`, `codex update`, `opencode upgrade`) and still works. Recommended: Claude Code 2.1.283, Codex 0.164.0, OpenCode 1.19.4 or later.
- For an AI coding tool without a built-in adapter, click "Have MerakCode write an adapter to connect your own AI coding tool" under Settings › Collaboration, or ask MerakCode in an ordinary conversation to write and register a member adapter with the adapter generator skill (`adapter-generator`). The skill works from the three built-in adapters: a tool that talks the way one of them does gets a copy of it, changed where it differs; any other gets an adapter written after them. You can also write one yourself with [the member adapter section of the SDK guide](docs/sdk/README.en.md#15-member-adapters-adapter).

Products can also be set in the config:

```jsonc
{
  "collaboration": {
    "products": {
      // A built-in product needs only the fields you change, such as where its command is or extra arguments
      "codex": { "command": "/opt/codex/bin/codex", "args": ["-c", "model=\"o3\""] },
      // Your own adapter
      "mycli": { "title": "MyCLI", "adapter": "member", "command": "node", "args": ["/path/to/adapter.mts"] },
    },
  },
}
```

## Configuration

| Location                                                         | Purpose                                                                                                                                                                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.merakcode/merakcode.jsonc`                                   | Global config (model, language, permission rules...). `merakcode.json` works too, and `.jsonc` wins when both exist; the desktop app and the command line save settings here                      |
| `<project>/.merakcode/merakcode.json`                            | Project config, overrides the global one. `.jsonc` works too, and so does `merakcode.json(c)` in the project root; "always allow" is saved here                                                   |
| `<project>/AGENTS.md`                                            | Notes about your project for MerakCode (`CLAUDE.md` works too; `AGENTS.md` wins in the same folder); `~/.merakcode/AGENTS.md` and `~/.claude/CLAUDE.md` apply to every project                    |
| `<project>/.merakcode/agents/`, `skills/`, `commands/`, `rules/` | Custom agents, skills, slash commands and rules (`*.mdc`). The first three also work under `~/.merakcode/` for every project. `.claude/skills`, `.agents/skills` and `.cursor/rules` are read too |

Config files can be plain JSON or JSONC with comments. Add `"$schema"` at the top and your editor will autocomplete and check it:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/TongTong313/merakcode/main/schema/config.json",
  "model": "anthropic/claude-sonnet-4-5",
  "locale": "en-US",
  "permission": {
    "bash": { "npm test *": "allow" },
    "bash_delete": { "rm -rf *": "deny" },
  },
  "sandbox": { "mode": "preferred" },
}
```

Command rules go under the key for their level: `bash_readonly` (read-only commands), `bash` (other commands), `bash_delete` (deletes), `bash_risky` (risky ones) and `bash_forbidden` (the refused ones). A rule only applies under its command's level: a rule for `rm` under `bash` does nothing. See the [schema](schema/config.json) for every key.

A config can read environment variables with `{env:NAME}`, such as `"apiKey": "{env:OPENAI_API_KEY}"`.

To change the language: the desktop app starts in your system language; change it under Settings → General → Language (saved in the global config, so the command line follows). The command line is in Chinese by default and reads only `"locale"` in the global config (`zh-CN` or `en-US`), or the environment variable `MERAKCODE_LOCALE=en-US`, which wins over the config.

The engine goes online to refresh model lists: shortly after it starts and every hour, it fetches each connected provider's list with your saved key, and reads openrouter.ai's public model catalog without a key. Set `MERAKCODE_DISABLE_CATALOG_FETCH=1` to turn this off; `merak models --refresh` refreshes by hand.

## SDK

To use MerakCode from your own program, use the TypeScript SDK:

```sh
npm install @merakcode/sdk
```

```ts
import { createMerakCode } from "@merakcode/sdk"

const merak = await createMerakCode({ cwd: process.cwd() })
const session = await merak.session()
for await (const event of session.run("What does this project do?")) {
  if (event.type === "text") process.stdout.write(event.delta)
}
await merak.close()
```

See the [SDK guide](docs/sdk/README.en.md) for everything else.

## Develop from source

You need Node.js 26.12 or newer (the `node` on your PATH too), pnpm 12, and [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) on your PATH for the tests.

```sh
git clone https://github.com/TongTong313/merakcode.git
cd merakcode
pnpm install
pnpm hooks:install          # check formatting before each commit, and the title of each commit
```

### Run from source

| To                             | Run                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------- |
| Work on the desktop app        | `pnpm --dir apps/desktop/main dev`                                               |
| Run a command-line command     | `pnpm dev run --dir "$PWD" "Explain this project"`                               |
| Start only the engine          | `pnpm dev serve --port 4096`                                                     |
| Debug the engine               | `node --inspect --import ./script/node/register.mjs apps/cli/src/index.ts serve` |
| Print the logs in the terminal | `pnpm dev serve --print-logs` (from source the log level is DEBUG already)       |

**Note**: desktop development reloads the UI as you save and restarts the app when main process code changes. Engine changes do not restart anything: use Help › Restart Local Service, and windows reconnect on their own.

`pnpm dev` runs the source directly; there is nothing to build first. Change the code and run it again. It runs inside `apps/cli`, so pass `--dir` to point at your project, or the command takes `apps/cli` as the project.

### Tests and checks

```sh
pnpm check                                                  # formatting, types, dependency boundaries, generated files... run before you commit
pnpm --dir packages/engine test                             # each package runs its own tests
pnpm --dir apps/cli test test/cli/doctor-command.test.ts    # a single file
```

### Packaging

```sh
pnpm --dir apps/cli build --single      # CLI release bundle for this machine, in apps/cli/dist/
pnpm --dir apps/desktop/main package    # desktop installer for this machine, in apps/desktop/main/release/
```

The CLI ends up at `apps/cli/dist/merakcode-<version>-<platform>/bin/merak` (`merak.cmd` on Windows). Packaging downloads Node and Electron; if that is slow, set `MERAKCODE_NODE_MIRROR`, `ELECTRON_MIRROR` and `ELECTRON_BUILDER_BINARIES_MIRROR` to a closer mirror. Tests download ripgrep from GitHub when it is not installed; `MERAKCODE_RIPGREP_BASE_URL` picks another source.

### Generated files

| If you changed                                 | Run                                                                                                               |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A server route                                 | `pnpm generate:sdk`, then `pnpm generate:sdk-reference`; `pnpm check:api --write` if the SDK API snapshot changed |
| A config option                                | `pnpm generate:schema`                                                                                            |
| An error code                                  | `pnpm generate:errors`                                                                                            |
| `@merakcode/sdk/adapter` or a built-in adapter | `pnpm generate:adapter-library`                                                                                   |
| The SDK public API                             | `pnpm check:api --write`                                                                                          |

### Point the SDK at the engine source

Run `pnpm install` in the repo first, and run your program with Node.js 26.12 or newer. Pass the loader to `--import` as a `file://` URL; Windows accepts nothing else:

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

### Layout

```text
apps/cli              the merak command; merak serve is the engine, and the desktop app ships the same one
apps/desktop/main     desktop app main process (Electron)
apps/desktop/renderer desktop app UI (SolidJS)
packages/engine       the engine: sessions, models, tools, permissions, HTTP and event stream server
  src/agent           agent loop, sessions, context, models, tools and permissions
  src/infra           sandbox, config IO, storage, processes and workspace mechanisms
  src/app             task, project and session composition, server and host
packages/sdk/js       TypeScript SDK
packages/util, log    shared helpers and logging
```

Neither the desktop app nor the command-line commands (other than `serve`, `generate` and `debug`) import engine code. They start a `merak serve` process through the SDK and talk to it over HTTP and an event stream. `pnpm check` enforces this. See [CONTRIBUTING.md](CONTRIBUTING.md) for the rest of the conventions.

## When something goes wrong

1. If the error has a code (such as `[MRK-2002]`), look it up in the [error code list](docs/errors.md).
2. Run `merak doctor`; it tells you which part is broken.
3. Still stuck? Run `merak bug-report` and attach the zip to an [issue](https://github.com/TongTong313/merakcode/issues/new/choose).
4. To read the logs yourself: `merak logs` shows where they are, `merak logs --tail` follows the newest one.

## Security

Please do not report security problems in public issues. See [SECURITY.md](SECURITY.md) for how to report them privately.

## Contributing

Issues and pull requests are welcome; let's make MerakCode better together. See [CONTRIBUTING.md](CONTRIBUTING.md) for the guidelines.

## License

[MIT](LICENSE)

## Thanks

Parts of this project are based on code from [opencode](https://github.com/anomalyco/opencode), and we thank them for it. Their license notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
