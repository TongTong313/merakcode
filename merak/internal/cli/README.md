# Command-line language

Product commands connect through the Go SDK. `serve` and isolated debug-host startup assemble the engine; commands do not call engine business methods directly.

`merak run --json INPUT` streams event JSON lines and accepts permission and question replies as JSON lines on stdin. Provider selection uses the engine configuration. `merak acp` serves ACP version 1 over stdin and stdout, including new sessions, prompts, cancellation, text updates and permission requests. Client-provided stdio MCP servers start in the new session; user configuration takes precedence on name conflicts. HTTP and SSE servers are rejected. Workspace MCP servers retain their per-server trust requests, forwarded to the editor through `session/request_permission`.

`merak group` exposes create, add, remove, update, board, inbox, say, pause and resume. `merak task` exposes create, assign, review, update and cancel. `merak member` exposes catalog, register and test. Use `--file PATH` for a protocol-shaped JSON request or `--file -` to read it from stdin; requests are limited to 1 MiB.

`merak cloud login --dev --endpoint ws://127.0.0.1:8787` signs in to a development cloud server. `merak cloud status` reports the account and device connection, and `merak cloud logout` disconnects and removes the stored login. The engine stores tokens in the system credential store, with a restricted local file fallback when unavailable. Client responses never contain the cloud token.

`merak serve --listen 192.168.1.10 --port 8788` explicitly exposes the authenticated engine protocol on a local network address. The default address remains `127.0.0.1`. The remote member form accepts `ws://192.168.1.10:8788/rpc` and the token from that engine's `engine.json`. Remote Workers execute in the registered source member's checkout. The assigning engine receives the original event IDs and sequences and routes approvals through its own task thread.

`merak event emit --group GROUP --type ci.finished --payload '{"status":"success"}'` sends an external event to an existing engine. The command prefixes short types with `external.` and prints the resulting event ID. Payloads must be JSON objects; omitted payloads use `{}`. Protocol clients use `event.emit` (SDK `client.event.emit`) with the full `external.*` type. Built-in event types cannot be emitted through this entry point. The engine records the event as an external actor in the group's stream.

`merak debug worker --kind claude-code "Check README"` runs the installed Claude Code product in the current directory. It writes engine event JSON lines as they arrive and ends with a JSON object containing `report`. Interrupting the command cancels the process tree. `member.catalog` and `client.member.catalog()` discover local products without starting a task.

The same command accepts `codex`, `opencode`, `pi`, `acp` and `command`. Use `--binary PATH` for a specific executable; ACP and command require it. For example, `merak debug worker --kind command --binary ./verifier "Check README"` sends the prompt on stdin and synthesizes a report from stdout. Configure product arguments and environment in a worker profile when running group tasks.

When `debug worker` emits `permission.requested`, reply on stdin with a JSON line such as `{"decision":"allow"}` or `{"decision":"deny"}`. Invalid input and EOF deny the request. A member that cannot forward approvals requests permission to start when the system sandbox is unavailable; that request includes the reason and the unrestricted-startup warning.

`merak --lang zh run --model MODEL INPUT` selects a language for a command. `merak run --lang en ...` also works. The language flag accepts `zh` and `en`; it does not change the engine or model language.

Without a flag, selection checks `MERAKCODE_LANG`, `LC_ALL`, `LC_MESSAGES` and `LANG`, in that order. Chinese locale names select `zh`; other names select `en`. On Windows, when those variables are absent, the command reads the user's locale with [GetUserDefaultLocaleName](https://learn.microsoft.com/en-us/windows/win32/api/winnls/nf-winnls-getuserdefaultlocalename). Other platforms use the terminal locale environment and fall back to English.

`text/zh.json` and `text/en.json` contain command messages. Tests require identical non-empty keys. Stable errors render the code, title and hint from the generated Go catalog. `packages/util/errors.json` is the error source; `pnpm generate:errors` writes the Go catalog, TypeScript catalog and documentation. `pnpm check:errors` checks all three outputs.

The current domain numbers are engine/connection 1, model provider 2, configuration 3, session 4, tool/permission 5, task/group 6, storage host/cloud 7, update 8 and internal 9. Existing published codes retain their meaning.

## Diagnostics

`merak diagnose --out merak-diag.zip` collects version metadata, connection metadata without the token, model catalog sources and the last three days of structured logs. It uses a running engine when available and collects local files without starting an engine otherwise. `--days` accepts 1 through 30; `--with-config` includes redacted configuration. `--session ID` or `--group ID` explicitly includes the selected event history. Default archives contain no conversation history.

Engine and command logs live under `~/.merakcode/logs/production/` or `MERAKCODE_HOME/logs/production/`. `serve --development` selects the development directory. Each process keeps at most five 20 MiB files. Oversized records become a metadata-only omission record. Credentials and conversation attributes are redacted before writing and again when exporting.

The protocol exposes `diagnostics.bundle` and chunked `blob.read`; SDK callers use `client.diagnostics.bundle()` followed by `client.blob.get(ref)`. Protocol archives are limited to 64 MiB and chunks to 1 MiB. Member catalog, group state and sandbox status will be populated as those modules become available.

## Maintenance commands

`merak stats [--days N] [--json]` totals the usage of the `turn.finished` events of the last N days (default 30) by day, by provider and model, and by agent; costs are kept per currency and turns without a price are counted apart. `merak doctor [--json]` checks the engine (starting it when it does not run), the data folder, one short turn of the default model, the sandbox, git and the MCP servers. A failed item ends the command with exit code 3; a sandbox or git that is missing is only a warning. `merak logs [-f] [--lines N] [--component NAME] [--development]` prints the last lines of the logs of every component in time order, and with `-f` keeps following them. `merak bug-report [--out FILE]` writes the diagnostic archive of `merak diagnose --with-config` to `merak-bug-report-<time>.zip` and prints where to send it. `merak generate` prints the JSON Schema of the protocol (the same document `pnpm generate:protocol` reads) and needs no engine.

`merak sandbox status [--json]` prints the answer of `sandbox.status`. `merak sandbox setup` calls `sandbox.setup`, which on Windows asks for administrator approval once. `merak sandbox reset` removes the Windows account pool; it works on the files of this machine and refuses while the engine runs, because the engine keeps the accounts in use.

`merak upgrade [version]` checks the version argument, tells a desktop-installed copy to update through the desktop app, asks the user to stop a running engine, and then answers `MRK-4016` because the download address and checksum format belong to the release process, which does not exist yet.

## Start at login

`merak service install` makes the engine start when the current user logs in; `merak service uninstall` undoes it. A running engine is never started or stopped by either command. macOS gets a LaunchAgent at `~/Library/LaunchAgents/com.merakcode.merak.plist` that runs `merak serve`; launchd reads it at the next login. Linux gets a systemd user unit at `$XDG_CONFIG_HOME/systemd/user/merakcode.service` (or `~/.config/systemd/user/`) that is enabled with `systemctl --user`. Windows gets the value `MerakCode` under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, written with `reg.exe`; it runs `merak service launch`, which starts the engine in the background and returns, so no console window stays open. Neither the unit nor the plist restarts an engine that the user stopped. When `MERAKCODE_HOME` is set at install time, macOS and Linux pass it on to the engine; a Windows Run value cannot carry it. Systems without these facilities answer `MRK-5016`.
