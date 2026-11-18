# Worker adapters

All adapters emit engine session, message, tool and turn events. Engine scope and member attribution remain attached to those events. Reports use the bounded task schema, with a synthesized report when the product returns plain text. Command workers always synthesize their report. Cancelling a run terminates its process tree, preserves partial text and closes pending tool calls.

| Kind        | Transport           | Mid-run messages           | Permission forwarding | Read-only assignment                         |
| ----------- | ------------------- | -------------------------- | --------------------- | -------------------------------------------- |
| builtin     | In process          | Yes                        | Yes                   | Read-only tool pool                          |
| claude-code | stream-json         | Yes                        | Engine MCP gate       | Restricted tool list                         |
| codex       | app-server JSON-RPC | turn/steer                 | Engine gate           | Read-only sandbox and denied write approvals |
| opencode    | ACP v1              | Unsupported                | Engine gate           | Read tools allowed; other permissions denied |
| pi          | LF-delimited RPC    | prompt with steer behavior | Not advertised        | Restricted tool list                         |
| acp         | ACP v1              | Unsupported                | Engine gate           | Rejected before launch                       |
| command     | Text stdin/stdout   | Unsupported                | Unsupported           | Rejected before launch                       |
| remote      | MerakCode protocol  | Source member capability   | Assigning engine      | Enforced by the source engine                |

Capabilities describe this implementation. ACP v1 does not promise insertion into an active prompt; these adapters return `worker.ErrUnsupported` from `Send`. ACP clients advertise no filesystem or terminal services. Unknown requests cannot grant access. Approval responses select only a one-time option. OpenCode receives an inline `permission: "ask"` override. Generic ACP agents must be configured to request approval through the protocol.

Codex uses `untrusted` approvals and the user approval reviewer in asking modes. Full takeover disables its built-in approval and sandbox layers; the engine's selected isolation still applies. Codex approvals and ACP permission requests pass through the same permission gate as builtin tools. Pi has no standard engine permission bridge here; no permission capability is advertised. Claude Code, Codex, OpenCode, Pi and supported ACP products receive the engine's scoped MCP group tools. Workspace MCP servers are mounted only in builtin members.

Claude Code, Codex and Pi also run as external Leaders. Their code tools remain read-only while MCP exposes task planning, member messages and approval tools. A completed model reply does not finish a Leader turn until the engine receives its finish signal.

Remote adapters preserve the execution engine's event IDs and sequences. Group history is synchronized in bounded batches. Shared document lookups, questions and permissions are answered by the assigning engine. Reconnecting to the same endpoint preserves its connection identity and updates the stored token.

Native Codex threads and ACP sessions are persisted against the engine session, member, group, task and working directory. Rework resumes the same native session. An ACP agent that cannot reload its saved session returns an error. Pi runs with `--no-session`; rework restores the engine conversation in the next prompt. Replay is bounded to 4 MiB and refuses an oversized history without silently discarding it. Command reruns retain engine history while receiving only the new task packet on stdin.

JSON records and command output are bounded to 4 MiB. Records split on LF only, including Pi strings containing U+2028. Stderr is not parsed or logged. Known Windows npm launchers execute their Node entry directly so shell expansion cannot alter model names or instructions. Local product discovery probes the four named products concurrently with a five-second limit per probe. Generic ACP and commands use the binary configured in their profile.

Each adapter has a real fixture process and fixed expected events. Engine tests also exercise permissions, readonly assignments, cancellation, steering, attribution and rework. Tests do not call live model services.

Protocol references:

- [Codex App Server](https://learn.chatgpt.com/docs/app-server), with schemas also generated from the locally installed Codex CLI.
- [ACP initialization](https://agentclientprotocol.com/protocol/v1/initialization), [session setup](https://agentclientprotocol.com/protocol/v1/session-setup), and [tool permissions](https://agentclientprotocol.com/protocol/v1/tool-calls).
- [OpenCode ACP](https://docs.opencode.ai/docs/acp/), [permissions](https://docs.opencode.ai/docs/permissions/) and [configuration precedence](https://docs.opencode.ai/docs/config/).
- [Pi RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md), [events](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md), and [message types](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/message-types.md).
