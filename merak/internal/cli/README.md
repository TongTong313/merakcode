# Command-line language

`merak event emit --group GROUP --type ci.finished --payload '{"status":"success"}'` sends an external event to an existing engine. The command prefixes short types with `external.` and prints the resulting event ID. Payloads must be JSON objects; omitted payloads use `{}`. Protocol clients use `event.emit` (SDK `client.event.emit`) with the full `external.*` type. Built-in event types cannot be emitted through this entry point. The engine records the event as an external actor in the group's stream.

`merak debug worker --kind claude-code "Check README"` runs the installed Claude Code product in the current directory. It writes engine event JSON lines as they arrive and ends with a JSON object containing `report`. Interrupting the command cancels the process tree. `member.catalog` and `client.member.catalog()` discover local products without starting a task.

The same command accepts `codex`, `opencode`, `pi`, `acp` and `command`. Use `--binary PATH` for a specific executable; ACP and command require it. For example, `merak debug worker --kind command --binary ./verifier "Check README"` sends the prompt on stdin and synthesizes a report from stdout. Configure product arguments and environment in a worker profile when running group tasks.

`merak --lang zh run --model MODEL INPUT` selects a language for a command. `merak run --lang en ...` also works. The language flag accepts `zh` and `en`; it does not change the engine or model language.

Without a flag, selection checks `MERAKCODE_LANG`, `LC_ALL`, `LC_MESSAGES` and `LANG`, in that order. Chinese locale names select `zh`; other names select `en`. On Windows, when those variables are absent, the command reads the user's locale with [GetUserDefaultLocaleName](https://learn.microsoft.com/en-us/windows/win32/api/winnls/nf-winnls-getuserdefaultlocalename). Other platforms use the terminal locale environment and fall back to English.

`text/zh.json` and `text/en.json` contain command messages. Tests require identical non-empty keys. Stable errors render the code, title and hint from the generated Go catalog. `packages/util/errors.json` is the error source; `pnpm generate:errors` writes the Go catalog, TypeScript catalog and documentation. `pnpm check:errors` checks all three outputs.

The current domain numbers are engine/connection 1, model provider 2, configuration 3, session 4, tool/permission 5, task/group 6, storage host/cloud 7, update 8 and internal 9. Existing published codes retain their meaning.

## Diagnostics

`merak diagnose --out merak-diag.zip` collects version metadata, connection metadata without the token, model catalog sources and the last three days of structured logs. It uses a running engine when available and collects local files without starting an engine otherwise. `--days` accepts 1 through 30; `--with-config` includes redacted configuration. `--session ID` or `--group ID` explicitly includes the selected event history. Default archives contain no conversation history.

Engine and command logs live under `~/.merakcode/logs/production/` or `MERAKCODE_HOME/logs/production/`. `serve --development` selects the development directory. Each process keeps at most five 20 MiB files. Oversized records become a metadata-only omission record. Credentials and conversation attributes are redacted before writing and again when exporting.

The protocol exposes `diagnostics.bundle` and chunked `blob.read`; SDK callers use `client.diagnostics.bundle()` followed by `client.blob.get(ref)`. Protocol archives are limited to 64 MiB and chunks to 1 MiB. Member catalog, group state and sandbox status will be populated as those modules become available.
