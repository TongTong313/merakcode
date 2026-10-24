# adapter-generator

You write a **member adapter**: a small TypeScript program that lets a MerakCode collaboration group give tasks to one
coding CLI. MerakCode starts the adapter for each task and talks to it on stdin/stdout through the adapter library. The
adapter drives the CLI and hands every step, permission request and question to MerakCode, which applies the user's
permission mode and asks the user when needed. You write and register the adapter. You do not create groups or add
members.

Node runs the adapter as it is, with no build step: it is a `.mts` file, and Node removes the types before running it.

## Files of this skill

Read them with the read tool (`builtin-skill://adapter-generator/<file>`). Each is also on disk, listed under disk files
below, so you can copy it with `cp`.

- `merakcode-adapter.mjs` and `merakcode-adapter.d.mts`: the adapter library and its types. Copy both next to the
  adapter with `cp`. Never write them out yourself: a retyped library breaks in ways that are hard to find.
- `example-claude-code.mts`, `example-codex.mts`, `example-opencode.mts`: the adapters MerakCode itself runs for Claude
  Code, Codex and OpenCode. Each talks to its CLI in one of the three ways in step 1, and each is tested against its
  CLI.

## The contract

`adapter({ inspect, run })` from the library:

- `inspect(product)` returns `{ name, version?, path?, recommended?, upgrade?, unavailable? }`. It runs without a task, so
  it must never start work: `version(command)` from the library runs `<cli> --version` and gives `{ version }` or
  `{ unavailable }`.
- `run(task, host)` does one task and returns `{ text, sessionId? }`. `task` has `prompt`, `cwd`, `mode`
  (`"readonly" | "ask" | "auto"`), `resume` (the `sessionId` the CLI returned last time, to continue its session),
  `product` (`command`, `args` from the user's config) and `signal` (aborts when the user stops the group).
- `host` is MerakCode, passed to `run` by the library. Its type is `Host`; import it with `type Host` only to pass `host`
  on to a function of your own.
- `host.step({ tool, detail? })` shows what the CLI is doing. It does not wait.
- `host.permission(request)` asks whether the CLI may do something and waits for `{ allow: true }` or
  `{ allow: false, message }`. `request` is one of: `{ kind: "write", paths }`, `{ kind: "command", command }`,
  `{ kind: "network", host, url? }`, `{ kind: "read", paths }`, `{ kind: "tool", name, detail? }`. Send a refusal's
  `message` back to the CLI as its reason.
- `host.question([{ question, header, options: [{ label, description }], multiple? }])` asks the user and waits for the
  answers, one list of labels per question.

The library also has `spawn`, to start the CLI (unlike `node:child_process` it also starts a CLI that npm installed on
Windows, a `.cmd`), and `stop(child)`, which ends the CLI with everything it started. console.log goes to stderr
(MerakCode's log), so stray output cannot break the protocol.

## Steps

Work through these in order. Tell the user briefly what you found at each step.

### 1. Learn the CLI

Ask the user which CLI, if they have not said. Then run `<cli> --version`, `<cli> --help` and the help of its
subcommands. Find a way to talk to it **both ways** while it works, so it can ask before acting. CLIs offer one of these
three, each with an example:

| The CLI offers                                                                        | Like                                                     | Example                   |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------- |
| JSON lines on stdin and stdout, with permission prompts                               | `claude -p --input-format stream-json --output-format …` | `example-claude-code.mts` |
| JSON-RPC on stdin and stdout                                                          | `codex app-server`                                       | `example-codex.mts`       |
| A local HTTP server with an event stream, and endpoints to answer permission requests | `opencode serve`                                         | `example-opencode.mts`    |

Choose the way the CLI offers by reading its help. The help lists options, not messages: take the exact messages from
the CLI's official documentation (fetching asks the user first) or from a schema the CLI itself provides (a local server
often serves its OpenAPI document). Never guess them, and do not reuse an example's messages for another CLI: they are
that example's CLI's. Write them to `NOTES.md` in the adapter's folder (step 2) before any code, each with the page or
schema it comes from: how to start a task, how a task is continued, which events it prints, how it asks for permission
and questions, and how to answer. If you cannot find them, stop and tell the user what is missing.

If the CLI talks both ways but in none of these three, you write the adapter yourself: take from the examples how they
start the CLI, map its requests to the five kinds, answer it, report steps, continue its session and stop it.

If the CLI can only run a task to the end with no way to ask anything, do not write an adapter. Tell the user it can
still be added in Settings › Collaboration as a one-shot command, without approvals or questions.

### 2. Write the adapter

Create `<MerakCode home>/adapters/<id>/` (the home is `~/.merakcode` unless MERAKCODE_HOME is set; `<id>` is lower-case
letters, digits and `-`). Put there:

- `merakcode-adapter.mjs` and `merakcode-adapter.d.mts`: the library and its types, copied with `cp`
- `NOTES.md`: what you learned in step 1 with its sources, then the version you tested with, how each mode maps to the
  CLI's options, and the test result, so the adapter can be fixed when the CLI changes
- `adapter.mts`: when the CLI talks in one of the three ways, copy that way's example here with `cp` and change what
  differs for this CLI: its name, command and arguments, how the modes map to its options, and its messages as in
  NOTES.md. Otherwise write it yourself, following the examples.

Rules for `adapter.mts`:

- Write TypeScript that Node can run by removing the types: type annotations, `type` and `interface`, `as`, `!` and
  generics are fine. Do not use `enum`, `namespace` or constructor parameter properties (`constructor(private x)`):
  Node cannot run them.
- Import what is only a type with `type` (`import { adapter, type Host } from "./merakcode-adapter.mjs"`), and write
  relative imports with their full extension.
- Start the CLI with `spawn` from the library, and stop it with `stop`.
- Map the modes to the CLI's options so that it **asks about everything it is unsure of** and MerakCode decides:
  read-only must not edit files; ask and auto hand the decisions to MerakCode. Never pass options that skip approvals.
- Map every permission request of the CLI to one of the five kinds. Prefer the most specific kind; use `tool` only for
  what is none of the others. Map its questions to `host.question`.
- Report each tool the CLI starts as a step, once.
- Continue the CLI's session from `task.resume`, and return its session id as `sessionId`.
- On `task.signal` abort, and when the task is done, `stop` the CLI.
- Keep secrets out of arguments and logs.

### 3. Test it

1. Handshake, no task: `node merakcode-adapter.mjs check -- node adapter.mts` must print the name and version.
2. A real task, only after the user agrees (it uses the CLI's own model and may cost money). In a new empty temporary
   directory, with a timeout of several minutes, run:

   ```sh
   node <adapter folder>/merakcode-adapter.mjs test -- node <adapter folder>/adapter.mts "Run node --version, then create hello.txt containing hi, then reply OK"
   ```

   Test mode prints every step, permission request and question, allows each request and picks the first option of
   each question, then prints the result.

3. Fix the adapter until the command and the file write each arrive as one request of the right kind and the result
   comes back. Run step 2 again after each fix.

A passing check proves only the handshake. The adapter is done when the real task of step 2 passes; until then, do not
register it.

### 4. Register it

Add the product under `collaboration.products.<id>` to the user's global MerakCode config: `merakcode.jsonc` in the
MerakCode home, or `merakcode.json` when that is the one there. Keep everything else in the file. Show the user the
entry and get their agreement first:

```json
{ "title": "<CLI name>", "adapter": "member", "command": "node", "args": ["<absolute path>/adapter.mts"] }
```

`node` there is the Node MerakCode runs on, so the adapter runs even where Node is not installed.

Then tell the user the adapter is ready: they can check it in Settings › Collaboration and add it to a group as a
member themselves.
