<p align="center">
  <img src="apps/desktop/renderer/public/logo.svg" width="72" alt="MerakCode" />
</p>

<h1 align="center">MerakCode</h1>

<p align="center">An open-source AI coding agent for the terminal, the desktop and your own code.</p>

<p align="center">
  <a href="https://github.com/TongTong313/merakcode/actions/workflows/ci.yml"><img src="https://github.com/TongTong313/merakcode/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/TongTong313/merakcode/releases"><img src="https://img.shields.io/github/v/release/TongTong313/merakcode?include_prereleases" alt="Release" /></a>
  <a href="https://www.npmjs.com/package/merakcode"><img src="https://img.shields.io/npm/v/merakcode" alt="npm" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/TongTong313/merakcode" alt="License" /></a>
</p>

<p align="center"><a href="README.md">简体中文</a> · English</p>

---

MerakCode is an open-source AI coding agent for every kind of task. It reads your project, writes and fixes code, runs commands and tests, and handles everyday office work such as documents, spreadsheets and PDFs. The name comes from Merak, the star in the Big Dipper that points to Polaris. Like that star, MerakCode aims to point each of your ideas in the right direction, with as little friction as possible.

## What it does

- **Any model you like**: over 200 model providers built in (Claude, GPT, Gemini, Qwen, DeepSeek and more), plus local models through LM Studio or Ollama, or any OpenAI-compatible API.
- **One engine, three ways to use it**: the terminal UI, the desktop app and the TypeScript SDK all run the same engine and behave the same way.
- **Asks before it changes things**: a permission mode decides what runs right away and what needs your OK. Commands run in a built-in OS sandbox that cannot read your key folders, cannot write outside the workspace, and needs your approval to reach new websites.
- **Extensible**: MCP servers, skills, plugins, custom agents and slash commands.
- **More than code**: reads Word and PDF files, reads and writes Excel spreadsheets.
- **Chinese and English**: the UI starts in Chinese; switch to English with one setting (see [Configuration](#configuration)).
- **No telemetry**: nothing about your usage is collected. Logs stay on your own computer.

## Install

### Command line

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

The command is `merak`. Upgrade later with `merak upgrade` (or `merak update`).

To check the downloads yourself, each release has a `SHA256SUMS` file:

```sh
sha256sum -c SHA256SUMS --ignore-missing
```

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
- **macOS**: if the app "cannot be opened", go to System Settings → Privacy & Security and click "Open Anyway" near the bottom. Unsigned macOS builds cannot update themselves; the app tells you when a new version is out and opens the download page.

### Uninstall

On Windows, if you set up the sandbox, run `merak sandbox reset` first. It removes the sandbox account and firewall rule and takes back the folder permissions it was given.

- Installed with the script: on macOS / Linux delete `~/.merakcode` and `~/.local/bin/merak`; on Windows delete `%LOCALAPPDATA%\merakcode` and remove its `bin` folder from your user PATH.
- Installed with npm: `npm uninstall -g merakcode`.
- Desktop app: uninstall it from the system's app list.
- Config, sessions and logs live in `~/.config/merakcode`, `~/.local/share/merakcode`, `~/.local/state/merakcode` and `~/.cache/merakcode` (on Windows `~` is `C:\Users\<you>`). Delete them too if you no longer need them.

## Quick start

Run it in your project folder:

```sh
cd your-project
merak
```

The first time, connect a model provider: type `/provider`, pick one and paste your API key. Keys already in your environment (such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `DASHSCOPE_API_KEY`) are picked up automatically.

Then just say what you want:

```text
Add unit tests for formatDate in utils/date.ts
```

Run a single task without the UI:

```sh
merak run "Explain how src/index.ts starts up"
```

Handy inside the UI:

| Type           | What it does                                            |
| -------------- | ------------------------------------------------------- |
| `/provider`    | Connect or switch model providers                       |
| `/models`      | Pick a model                                            |
| `/new`         | Start a new session                                     |
| `/sessions`    | Open an earlier session                                 |
| `/compact`     | Shrink a long conversation                              |
| `/undo`        | Undo the last turn's changes                            |
| `/permissions` | Permission rules and the sandbox (`/sandbox` works too) |
| `/language`    | Switch between Chinese and English                      |
| `/help`        | All commands and shortcuts                              |
| `Shift+Tab`    | Switch permission mode                                  |

## Commands

| Command                       | What it does                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `merak`                       | Open the terminal UI                                                              |
| `merak run "<task>"`          | Run one task and print the result                                                 |
| `merak serve --port 4096`     | Start only the engine, for the desktop app, the SDK or another terminal           |
| `merak attach <url>`          | Open the terminal UI against an engine that is already running                    |
| `merak upgrade` (or `update`) | Upgrade. `--check` only looks for a new version, `--yes` skips the question       |
| `merak models`                | List the models you can use                                                       |
| `merak mcp list`              | Show MCP server status                                                            |
| `merak sandbox status`        | Is the sandbox on? `setup` turns it on, `reset` removes it                        |
| `merak doctor`                | Check the install, config, models and sandbox, and say what is wrong              |
| `merak logs`                  | Where the logs are and recent runs; `--tail` follows the newest log               |
| `merak bug-report`            | Zip the checks, config and logs for an issue; keys and conversations are left out |
| `merak acp`                   | Run as an [ACP](https://agentclientprotocol.com) agent for editors such as Zed    |

Add `--help` to any command for the full details.

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

MerakCode edits files and runs commands on your computer, so every action goes through the permission mode first: do it, ask you, or refuse.

| Mode          | Good for                      | What happens                                                                                                                                                    |
| ------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read-only     | Exploring code, making a plan | Only reads files and runs read-only commands (such as `git status` or `ls`). No edits, no other commands                                                        |
| Ask (default) | Everyday work                 | Reads files and edits inside the workspace right away; asks before running commands, editing outside the workspace, reading sensitive files or going online     |
| Auto          | Letting it get on with it     | Does most things right away; still asks before risky commands (such as `git push` or `sudo`), edits outside the workspace, sensitive files and unknown websites |

Press `Shift+Tab` in the UI to switch modes. When it asks, you can allow once, allow for this session, always allow (saved to the project config) or deny. By default, commands such as `rm -rf /` or formatting a disk never run, in any mode.

Commands the agent runs also go into an **OS sandbox**: they can only write the workspace, temp folders and package manager caches; they cannot read key folders such as `~/.ssh` or `~/.aws`; they cannot change `.git/hooks` or `.git/config`; and network traffic goes through a local proxy that asks you about sites it has not seen. The sandbox is our own code on top of what each OS provides:

| System  | Built on                                                      | What you need to do                                                                         |
| ------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Windows | A separate low-rights account, NTFS permissions, the firewall | Run `merak sandbox setup` once and approve one administrator prompt; it takes a few minutes |
| Linux   | Landlock (kernel 5.13 or newer)                               | Nothing. Network rules need kernel 6.7 or newer                                             |
| macOS   | The built-in Seatbelt (sandbox-exec)                          | Nothing                                                                                     |

While the sandbox is not ready (for example before setup on Windows), commands that may change things ask first, even in auto mode. For what the sandbox does and does not protect against, see [SECURITY.md](SECURITY.md).

## Configuration

| Location                                               | Purpose                                                        |
| ------------------------------------------------------ | -------------------------------------------------------------- |
| `~/.config/merakcode/merakcode.json`                   | Global config (model, language, permission rules...)           |
| `<project>/.merakcode/merakcode.json`                  | Project config, overrides the global one                       |
| `<project>/AGENTS.md`                                  | Notes about your project for MerakCode (`CLAUDE.md` works too) |
| `<project>/.merakcode/agents/`, `skills/`, `commands/` | Custom agents, skills and slash commands                       |

Config files can be plain JSON or JSONC with comments. Add `"$schema"` at the top and your editor will autocomplete and check it:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/TongTong313/merakcode/main/schema/config.json",
  "model": "anthropic/claude-sonnet-4-5",
  "locale": "en-US",
  "permission": {
    "bash": { "git status": "allow", "rm -rf *": "deny" },
  },
  "sandbox": { "mode": "preferred" },
}
```

To use English: switch in `/language`, set `"locale": "en-US"` in the config, or set the environment variable `MERAKCODE_LOCALE=en-US`.

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

You need Node.js 26.12 or newer and pnpm 12.

```sh
git clone https://github.com/TongTong313/merakcode.git
cd merakcode
pnpm install
pnpm hooks:install          # check formatting before each commit
```

### Run from source

| To                                   | Run                                                                              |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| Open the terminal UI                 | `pnpm dev`                                                                       |
| Pass arguments                       | `pnpm dev run "Explain this project"`                                            |
| Start only the engine                | `pnpm dev serve --port 4096`                                                     |
| Connect to it from a second terminal | `pnpm dev attach http://127.0.0.1:4096`                                          |
| Debug the engine                     | `node --inspect --import ./script/node/register.mjs apps/cli/src/index.ts serve` |
| Print detailed logs                  | `pnpm dev --print-logs --log-level DEBUG`                                        |
| Work on the desktop app              | `pnpm --dir apps/desktop/main dev` (add `--renderer` to rebuild the UI first)    |

`pnpm dev` runs the source directly; there is nothing to build first. Change the code and run it again.

### Tests and checks

```sh
pnpm check                              # formatting, types, dependency boundaries, generated files... run before you commit
cd packages/engine && pnpm test         # each package runs its own tests
cd apps/cli && pnpm test test/cli/doctor-command.test.ts   # a single file
```

### Packaging

```sh
pnpm --dir apps/cli build --single      # CLI release bundle for this machine, in apps/cli/dist/
pnpm --dir apps/desktop/main package    # desktop installer for this machine, in apps/desktop/main/release/
```

The CLI ends up at `apps/cli/dist/merakcode-<version>-<platform>/bin/merak` (`merak.cmd` on Windows). Packaging downloads Node and Electron; if that is slow, set `MERAKCODE_NODE_MIRROR` and `ELECTRON_MIRROR` to a closer mirror.

### Generated files

| If you changed     | Run                                                     |
| ------------------ | ------------------------------------------------------- |
| A server route     | `pnpm generate:sdk`, then `pnpm generate:sdk-reference` |
| A config option    | `pnpm generate:schema`                                  |
| An error code      | `pnpm generate:errors`                                  |
| The SDK public API | `pnpm check:api --write`                                |

### Point the SDK at the engine source

```ts
const merak = await createMerakCode({
  executablePath: [process.execPath, "--import", "<repo>/script/node/register.mjs", "<repo>/apps/cli/src/index.ts"],
})
```

### Layout

```text
apps/cli              the merak command and terminal UI; merak serve is the engine
apps/desktop/main     desktop app main process (Electron)
apps/desktop/renderer desktop app UI (SolidJS)
packages/engine       the engine: sessions, models, tools, permissions, HTTP server
packages/sandbox      the OS sandbox (Windows / Linux / macOS)
packages/sdk/js       TypeScript SDK
packages/util, log    shared helpers and logging
packages/client-core  approval options shared by the terminal and desktop UIs
```

Neither the terminal UI nor the desktop app imports engine code. Both start a `merak serve` process through the SDK and talk to it over HTTP and an event stream. `pnpm check` enforces this. See [CONTRIBUTING.md](CONTRIBUTING.md) for the rest of the conventions.

## When something goes wrong

1. If the error has a code (such as `[MRK-2002]`), look it up in the [error code list](docs/errors.md).
2. Run `merak doctor`; it tells you which part is broken.
3. Still stuck? Run `merak bug-report` and attach the zip to an [issue](https://github.com/TongTong313/merakcode/issues/new/choose).
4. To read the logs yourself: `merak logs` shows where they are, `merak logs --tail` follows the newest one.

## Security

Please do not report security problems in public issues. See [SECURITY.md](SECURITY.md) for how to report them privately.

## License and credits

[MIT](LICENSE). MerakCode is built on [opencode](https://github.com/anomalyco/opencode) (MIT); third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
