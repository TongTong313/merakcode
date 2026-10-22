<p align="center">
  <img src="apps/desktop/renderer/public/logo.svg" width="72" alt="MerakCode" />
</p>

<h1 align="center">MerakCode</h1>

<p align="center">Aiming to be the best AI coding tool to work with</p>

<p align="center">
  <a href="https://github.com/TongTong313/merakcode/actions/workflows/ci.yml"><img src="https://github.com/TongTong313/merakcode/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/TongTong313/merakcode/releases"><img src="https://img.shields.io/github/v/release/TongTong313/merakcode?include_prereleases" alt="Release" /></a>
  <a href="https://www.npmjs.com/package/merakcode"><img src="https://img.shields.io/npm/v/merakcode" alt="npm" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D26.12-339933?logo=nodedotjs&logoColor=white" alt="Node.js" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-7.0-3178C6?logo=typescript&logoColor=white" alt="TypeScript" /></a>
</p>

<p align="center"><a href="README.md">简体中文</a> · English</p>

---

MerakCode is an open-source AI coding tool. Beyond strong coding skills, it can help with anything you need AI for. AI now writes far faster than people can read, so MerakCode puts a lot of care into how people and the agent work together: a better way to review what the agent produces and a smoother experience overall, so that its output is what you expect.

We open-sourced this project to make up for a regret we have carried, and in the hope that the community can keep it going. The name comes from Merak, the star in the Big Dipper that, together with Dubhe, points to Polaris. We hope MerakCode does the same and points each of your ideas in the right direction.

## What it does

- **AI coding**: strong project-level coding across many languages, frameworks, paradigms and styles. Honestly, this part is no different from other AI coding products. You be the judge, and if you like it, a Star is the best way to support us.
- **Collaboration across products**: MerakCode is designed around people and the agent working together. It has a review interface built specifically for checking what the agent produces (desktop app only) and a complete permission system for what the agent may do. It can also work alongside other AI coding products that ship a CLI, so the collaboration reaches across products.
- **Model setup**: connect all kinds of model providers (only 8 for now, more to come) as well as local models. MerakCode can also use models through API relay services.
- **Secure and reliable**: commands the agent runs go into our own OS sandbox. They cannot read your key folders, cannot write outside the workspace, and need your approval to reach unfamiliar websites. This is a small product built by a few people, with no server side (no time to build one...). We don't collect, and couldn't collect, any usage data, so there is nothing of yours to leak.
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
- **macOS**: if the app "cannot be opened", go to System Settings → Privacy & Security and click "Open Anyway" near the bottom. Unsigned macOS builds cannot update themselves; the app tells you when a new version is out and opens the download page.

### Command line

The command-line version has no UI. It is for one-off tasks in a terminal, scripts, and editors (through ACP). It shares its config and keys with the desktop app.

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

To check a download yourself, put the release's `SHA256SUMS` in the same folder as the file and run:

```sh
sha256sum -c SHA256SUMS --ignore-missing          # Linux
shasum -a 256 -c SHA256SUMS --ignore-missing      # macOS
```

```powershell
# Windows: the output must equal the value on this file's line in SHA256SUMS
(Get-FileHash .\merakcode-<version>-windows-x64.zip).Hash.ToLower()
```

### Uninstall

On Windows, if you set up the sandbox, first click "Reset" under Settings → Permissions & security in the desktop app (or run `merak sandbox reset`). It removes the sandbox account and firewall rule and takes back the folder permissions it was given.

- Desktop app: uninstall it from the system's app list.
- Installed with the script: on macOS / Linux delete `~/.local/bin/merak`; on Windows remove `~\.merakcode\bin` from your user PATH.
- Installed with npm: `npm uninstall -g merakcode`.
- Config, sessions, logs and caches all live in one folder, `~/.merakcode` (on Windows `~` is `C:\Users\<you>`; the `MERAKCODE_HOME` environment variable moves it). Delete it if you no longer need it.

## Quick start

Open the desktop app and click "Open folder" to pick your project.

The first time, connect a model provider: on the onboarding screen, pick a provider and enter its API key (change it later under Settings → Models & providers). The built-in catalog is OpenAI, Anthropic, Google, Alibaba Cloud Model Studio, Zhipu AI, DeepSeek, Moonshot AI and OpenRouter. Any other service is an OpenAI-compatible provider in your config, with its URL, model ids and API key.

Then just say what you want:

```text
Add unit tests for formatDate in utils/date.ts
```

Handy actions (`⌘` on macOS, `Ctrl` on Windows and Linux):

| Action                | What it does                                                                  |
| --------------------- | ----------------------------------------------------------------------------- |
| `⌘/Ctrl+K`            | Command palette: search conversation titles, conversation content or commands |
| `⌘/Ctrl+N`            | New conversation                                                              |
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

| Command                       | What it does                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `merak run "<task>"`          | Run one task and print the result                                                 |
| `merak provider login`        | Connect a model provider; `list` shows the connected ones, `logout` removes one   |
| `merak serve --port 4096`     | Start only the engine, for the SDK or other programs                              |
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

| Mode          | Good for                              | What happens                                                                                                                                                    |
| ------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read-only     | Designs and plans                     | Only reads files and runs read-only commands (such as `git status` or `ls`). No edits, no other commands                                                        |
| Ask (default) | Everyday work                         | Reads files and edits inside the workspace right away; asks before running commands, editing outside the workspace, reading sensitive files or going online     |
| Auto          | Large projects, when you trust the AI | Does most things right away; still asks before risky commands (such as `git push` or `sudo`), edits outside the workspace, sensitive files and unknown websites |

Switch modes next to the input in the desktop app, or press `Shift+Tab`. When it asks, you can allow once, allow for this session, always allow (saved to the project config) or deny. By default, commands such as `rm -rf /` or formatting a disk never run, in any mode.

Commands the agent runs also go into an **OS sandbox**: they can only write the workspace, temp folders and package manager caches; they cannot read key folders such as `~/.ssh` or `~/.aws`; they cannot change `.git/hooks` or `.git/config`; and network traffic goes through a local proxy that asks you about sites it has not seen. The sandbox is our own code on top of what each OS provides:

| System  | Built on                                                      | What you need to do                                                                                                                                |
| ------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows | A separate low-rights account, NTFS permissions, the firewall | Click "Set up" under Settings → Permissions & security in the desktop app (or run `merak sandbox setup` once) and approve one administrator prompt |
| Linux   | Landlock (kernel 5.13 or newer)                               | Nothing. Network rules need kernel 6.7 or newer                                                                                                    |
| macOS   | The built-in Seatbelt (sandbox-exec)                          | Nothing                                                                                                                                            |

While the sandbox is not ready (for example before setup on Windows), commands that may change things ask first, even in auto mode. For what the sandbox does and does not protect against, see [SECURITY.md](SECURITY.md).

## Configuration

| Location                                               | Purpose                                                        |
| ------------------------------------------------------ | -------------------------------------------------------------- |
| `~/.merakcode/merakcode.json`                          | Global config (model, language, permission rules...)           |
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

To switch to English: in the desktop app, use Settings → General → Language; for the command line, set `"locale": "en-US"` in the config or the environment variable `MERAKCODE_LOCALE=en-US`.

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

| To                         | Run                                                                              |
| -------------------------- | -------------------------------------------------------------------------------- |
| Work on the desktop app    | `pnpm --dir apps/desktop/main dev`                                               |
| Run a command-line command | `pnpm dev run "Explain this project"`                                            |
| Start only the engine      | `pnpm dev serve --port 4096`                                                     |
| Debug the engine           | `node --inspect --import ./script/node/register.mjs apps/cli/src/index.ts serve` |
| Print detailed logs        | `pnpm dev serve --print-logs --log-level DEBUG`                                  |

**Note**: desktop development reloads the UI as you save and restarts the main process and the engine when their code changes, which makes debugging much easier.

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
apps/cli              the merak command; merak serve is the engine, and the desktop app ships the same one
apps/desktop/main     desktop app main process (Electron)
apps/desktop/renderer desktop app UI (SolidJS)
packages/engine       the engine: sessions, models, tools, permissions, HTTP server
packages/sandbox      the OS sandbox (Windows / Linux / macOS)
packages/sdk/js       TypeScript SDK
packages/util, log    shared helpers and logging
packages/client-core  approval options for the desktop app
```

Neither the desktop app nor the command-line commands import engine code. They start a `merak serve` process through the SDK and talk to it over HTTP and an event stream. `pnpm check` enforces this. See [CONTRIBUTING.md](CONTRIBUTING.md) for the rest of the conventions.

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
