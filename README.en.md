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

MerakCode is an open-source AI coding tool. Beyond strong coding skills, it can help with anything you need AI for. Now that AI writes far faster than people can read, MerakCode puts a lot of care into how people and the agent work together. Collaboration groups let Claude Code, Codex, OpenCode and other products work together, and MerakCode keeps refining how you review what the agent produces, so that its output is what you expect. The aim is to be the best AI coding tool to use, not the most powerful one.

We open-sourced this project to make up for a regret we have carried, and in the hope that the community can keep it going. The name comes from Merak, the star in the Big Dipper that, together with Dubhe, points to Polaris. We hope MerakCode does the same and points each of your ideas in the right direction.

## What it does

- **AI coding**: strong project-level coding across many languages, frameworks, paradigms and styles. Honestly, this part is no different from other AI coding products. You be the judge, and if you like it, a Star is the best way to support us.
- **Collaboration across products**: MerakCode is designed around people and the agent working together. It has a review interface built specifically for checking what the agent produces (desktop app only) and a complete permission system for what the agent may do. It can also work alongside other AI coding products that ship a CLI, so the collaboration reaches across products.
- **Model setup**: connect all kinds of model providers (only 8 for now, more to come) as well as local models. MerakCode can also use models through API relay services.
- **Secure and reliable**: commands the agent runs go into our own OS sandbox. They cannot read key folders such as `~/.ssh` or `~/.aws`, can write only the workspace, temp folders and package manager caches, and need your approval for hosts that are not on the allowlist. This is a small product built by a few people, with no server side (no time to build one...). We don't collect, and couldn't collect, any usage data, so there is nothing of yours to leak.
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
| `⌘/Ctrl+G`            | New collaboration group                                                       |
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

MerakCode edits files and runs commands on your computer, so every action goes through the permission mode first: do it, ask you, or refuse. There is no category called an ordinary file. The rules are:

- **Edits inside the workspace.** If no directory or file name on the path relative to the workspace starts with `.`, ask mode and auto mode edit it immediately. If any segment starts with `.` (`.git`, `.github`, `.env`, `src/.hidden/a.ts`), ask mode asks first and auto mode edits it immediately. Read-only mode never edits, and an allow rule in the config cannot override that.
- **Reads.** A file inside the workspace that is not a secret is read immediately in every mode. A non-secret file outside the workspace asks in read-only and ask mode, and is read immediately in auto mode. Secrets always ask. A secret is a file named `.env`, or `.env.*` other than `.env.example`, `.env.sample`, `.env.template` and `.env.dist`; `id_rsa`, `id_dsa`, `id_ecdsa` or `id_ed25519`, with an optional extra suffix; `credentials` or `credentials.json`; an extension of `.pem`, `.key`, `.p12`, `.pfx`, `.keystore` or `.jks`; or `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials` or `.pgpass`. Files under `.ssh`, `.aws`, `.azure`, `.kube`, `.gnupg`, `.docker`, `.config/gcloud` or `.config/gh` in your home directory count too.
- **Commands.** Commands that certainly do not change files (`ls`, `git status`, `git diff`, `rg`, and the rest of that fixed list) run in every mode. Anything that might change files counts as a file-changing command. File-changing commands, and `rm`, `rmdir`, `unlink`, `shred`, `git clean`, `git reset --hard` and `find -delete`, are refused in read-only mode, asked about in ask mode, and run immediately in auto mode. Risky commands are refused in read-only mode and asked about in ask and auto mode: `sudo`, `su`, `doas`, `pkexec`, `runas`, `dd` when it does not target a whole disk, `shutdown`, `reboot`, `chown`, and `git push`, `npm publish`, `npm unpublish`, `pnpm publish`, `yarn publish`, `bun publish`, `cargo publish`, `gem push`, `twine upload`, `docker push`, `gh release`, `gh pr`, `helm push`. `rm -rf /` (and the home directory), recursively chmodding those locations to `777`, `mkfs`, `dd` onto a whole disk, `format`, `diskpart` and a fork bomb are refused by default. In ask and auto mode they run only when the config explicitly allows them. In read-only mode an allow rule still does not.
- **Websites.** The allowlist matches hostnames exactly; a subdomain does not count. These hosts are reached immediately: `registry.npmjs.org`, `registry.yarnpkg.com`, `registry.npmmirror.com`, `cdn.npmmirror.com`, `pypi.org`, `files.pythonhosted.org`, `pypi.tuna.tsinghua.edu.cn`, `crates.io`, `index.crates.io`, `static.crates.io`, `static.rust-lang.org`, `rsproxy.cn`, `proxy.golang.org`, `sum.golang.org`, `goproxy.cn`, `repo.maven.apache.org`, `repo1.maven.org`, `maven.aliyun.com`, `services.gradle.org`, `plugins.gradle.org`, `rubygems.org`, `github.com`, `codeload.github.com`, `objects.githubusercontent.com`, `raw.githubusercontent.com`, `gitlab.com`, `gitee.com`, `mirrors.aliyun.com`, `mirrors.tuna.tsinghua.edu.cn`. Every other host asks, in every mode.
- **The rest.** Subagents, workflows, scheduled tasks, MCP and tools registered by plugins ask in read-only and ask mode, and run immediately in auto mode. Leaving the sandbox always asks. While the sandbox is not ready, a command that may change things asks even in auto mode. In ask and auto mode, allow and deny rules in the project config override the defaults above. Read-only mode still cannot edit files or run anything except read-only commands.
- **Collaboration members.** The leader hands a task to a member without asking. When a member (Claude Code, Codex, OpenCode, or a product with a member adapter) wants to edit files, run commands, reach a website or read files, the rules above decide it; what needs asking shows in the approval bar and a member's question in the question box, both naming the member. Members' commands do not run in MerakCode's OS sandbox (Codex runs them in its own sandbox), and a custom product added as a one-shot command never asks: its own settings decide.

| Mode          | Good for                              | What happens                                                                                                                                                                                                           |
| ------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read-only     | Designs and plans                     | No edits, only read-only commands. Still asks before a non-secret read outside the workspace, a secret, or a host off the allowlist                                                                                    |
| Ask (default) | Everyday work                         | Edits a workspace file immediately when no path segment starts with `.`. Asks before edits to dot paths, file-changing commands and deletes, reads or edits outside the workspace, secrets, or hosts off the allowlist |
| Auto          | Large projects, when you trust the AI | Edits inside the workspace (including dot paths), file-changing commands and deletes run immediately. Still asks before writes outside, risky commands, secret reads, hosts off the allowlist, or leaving the sandbox  |

Switch modes next to the input in the desktop app, or press `Shift+Tab`. When it asks, you can allow once, allow for this session, always allow (saved to the project config) or deny.

Commands the agent runs also go into an **OS sandbox**: they can only write the workspace, temp folders and package manager caches; they cannot read key folders such as `~/.ssh` or `~/.aws`; they cannot change `.git/hooks` or `.git/config`; and network traffic goes through a local proxy that asks you about hosts off the allowlist that you have not approved. The sandbox is our own code on top of what each OS provides:

| System  | Built on                                                      | What you need to do                                                                                                                                |
| ------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows | A separate low-rights account, NTFS permissions, the firewall | Click "Set up" under Settings → Permissions & security in the desktop app (or run `merak sandbox setup` once) and approve one administrator prompt |
| Linux   | Landlock (kernel 5.13 or newer)                               | Nothing. Network rules need kernel 6.7 or newer                                                                                                    |
| macOS   | The built-in Seatbelt (sandbox-exec)                          | Nothing                                                                                                                                            |

While the sandbox is not ready (for example before setup on Windows), commands that may change things ask first, even in auto mode. For what the sandbox does and does not protect against, see [SECURITY.md](SECURITY.md).

## Collaboration groups

In a collaboration group MerakCode is the leader, and Claude Code, Codex, OpenCode and other AI coding tools can be members. Say what you want in the group; the leader splits it into tasks for the members, and each replies in the group when it is done.

- Create one from New collaboration group in the sidebar, `⌘/Ctrl+G` or the command palette, or copy the members of an existing group.
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

To change the language: in the desktop app, use Settings → General → Language. On the command line, set `"locale"` in the config (`zh-CN` or `en-US`) or the environment variable `MERAKCODE_LOCALE`.

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

**Note**: desktop development reloads the UI as you save and restarts the app when main process code changes. Engine changes do not restart anything: use Help › Restart Local Service, and windows reconnect on their own.

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
