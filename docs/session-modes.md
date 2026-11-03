# Permission levels and official plans

The November 3, 2026 permission-and-plan specification supersedes the old plan/execute/auto contract.
New root conversations use `permissionLevel: "ask"` and `permissionRevision: 0`.

## Authorization

- `ask`: ask before each real operation. A human may authorize the displayed scope for this root conversation while the required isolation is ready.
- `autoApprove`: allow controlled ordinary project reads and edits, provably read-only commands and dedicated official-plan writes. Dangerous, unknown, sensitive and external operations still ask.
- `fullTakeover`: skip safety approvals. Select isolation or the current account before launching; preserve task scope, input validation and real process outcomes. Never automatically replay a failed command with another account.

Missing isolation preserves the selected level. Ask and Auto approve then ask per operation and offer only allow once or reject. Old permanent allows do not answer new Ask requests. Explicit applicable denies still apply in the first two levels. Conversation grants remain separate from persistent configuration.

Only the explicit setter changes the root selection. Clients call the generated SDK `session.setPermissionLevel` with the expected revision. Ordinary messages preserve that selection. The approval card's switch action calls the setter and re-evaluates the original request; it never also replies allow once. Legacy `always` replies fail without writing configuration.

The permission service binds an admission receipt to the call and execution conditions. Actual human authorization is recorded separately from automatic policy. Root changes re-evaluate queued and active work. Real stop receipts determine whether work stopped. Completed effects are not rolled back or replayed.

## Sandbox lifecycle

The engine probes installed isolation at startup. Windows desktop setup requests administrator approval once after an interactive window becomes available. Cancellation leaves per-operation approval active and exposes retry. Concurrent setup requests share initialization. Status reports actual capability and reason; individual protection gaps affect dependent operations.

Products use SDK status/setup calls. The composer offers status and repair rather than a product on/off switch. `sandbox status` and `sandbox setup` remain diagnostic commands. Plugins, MCP, LSP and external native tools have independent coverage; a shell backend does not prove their isolation.

## One official plan

The root conversation owns one editable Markdown document. Only trusted root `plan_generate` and `plan_edit` submissions save agent content. They use the read revision and recheck after approval. Human edits win. A successful call has an idempotent receipt and a server-owned first message identity. General file tools cannot replace the official file through aliases or hard links, including after a rejected plan request.

The model chooses whether to answer in chat or submit a plan. A draft-only request permits necessary research and official-plan work, without authorizing project implementation. Child work retains its originating task scope.

The Plan tab renders full Markdown. Edit plan opens the existing editor. Human saves need no agent approval. The card stays with the first successful assistant submission, including group replies and folded turns. Turn actions precede the changed-files card.

Button and explicit chat starts save an open human buffer and use the latest saved revision when admitted. The execution keeps an immutable snapshot, source and identifier. Startup preserves permission level. A successful button execution locks the button only while the normalized-line-ending text matches. Editing A to B enables it; returning B to A locks it again. Chat reruns remain separate explicit requests.

`plan_read_chunk` reads complete character ranges, including long single lines. `plan_simplify` proposes a read-only candidate with token estimates and all ordered differences. Human adoption saves it without starting execution. Check commands, identifiers, numbers, prohibitions and acceptance conditions before adoption.

## Context and external adapters

The shared reserve is `P + max(ceil(0.1 * P), 1000)`, where P is the complete plan estimate. Native request validation includes final system messages, tool schemas, structured-output definitions and instructions. Cached input still occupies the context window. Snapshot persistence rechecks the revision after request preparation.

Dynamic plan material follows the effective conversation input. Execution uses its fixed snapshot. Relevant discussion and edits use the latest document. Long plans start at 2048 estimated tokens. After three completed unrelated real user turns, the next ordinary input keeps a resolvable reference instead of the body. Passive page reads do not reset that counter; explicit viewing and relevant user input do.

Adapters use protocol 3 and `Task.permissionLevel`. Verify the protocol before task messages. The SDK validates external task and revision parameters. Plan-dependent work requires declared complete-input and capacity support. Ordinary tasks do not require plan capability. Unknown isolation, cancellation or operation coverage remains unknown. A native restriction is never removed merely because the host allows an operation.

## Migration

Legacy `permissionMode` and `sessionMode` values migrate to Ask. Historical allows do not become new conversation grants. Preserve history, documents and explicit denies. Imported history always starts with Ask and cannot launch execution. `fullAccess` is not an alias. Trusted new stored selections restore their explicit legal level. Existing `session.takeover` remains a separate target-transfer operation.

## Validation status

Implementation and regression validation are in progress. The attached specification remains the acceptance scope.
Run root `pnpm check`, root script tests, every package suite, real sandbox conformance, CLI and desktop E2E, builds, isolated npm consumption and production-package smoke before release.
Windows checks are local evidence. macOS and Linux require their corresponding CI jobs.
