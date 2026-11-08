# Claude Code worker

The adapter starts `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages` in the assignment directory. It adds profile instructions and the bounded JSON report format through `--append-system-prompt`. Authentication remains the installed product's responsibility. No permission bypass flag is added.

The protocol follows the official [CLI reference](https://code.claude.com/docs/en/cli-reference), [streaming guide](https://code.claude.com/docs/en/agent-sdk/streaming-output), and [message types](https://code.claude.com/docs/en/agent-sdk/typescript), checked on 2026-11-08. User messages travel over stdin. Completed text, thinking and tools become engine messages; tool results retain their originating event as `Cause`. Repeated usage for one assistant message is counted once. Unrecognized output remains observable as `tool.progress`.

Cancellation stops the process tree and closes unfinished tool calls before the final turn event. Reports accept a strict JSON object or synthesize a bounded summary from the last reply. Cancelled assignments synthesize a blocked report. Product discovery only runs `--version`, with a timeout and bounded output.

Tests build a Go fixture executable in a temporary directory. They exercise real pipes, steering, cancellation, a recorded stream, event causes, report fallback, PATH discovery and the command-line entry. They do not invoke a model service. The builtin adapter runs the same conversation loop and owns the same `worker.Run` lifecycle; background children also start through this adapter.
`system.init` supplies the product session ID. The adapter stores that ID with its assignment directory and scope. Rework passes `--resume` for that exact session and retains the engine session ID. The real-process fixture verifies that the second assignment sees the original instructions.
