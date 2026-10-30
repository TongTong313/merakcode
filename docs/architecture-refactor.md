# Architecture refactor

Approved source baseline: `8b1b8b5e6d4869148e09aec101e7f3c20c34bf25`.

## Decisions

- Engine code converges on `agent`, `infra`, and `app`. `app` means engine-side composition; desktop and CLI product features call the SDK.
- `agent/loop` will own the complete execution lifecycle. Persistent session and message facts remain in `agent/session`.
- `agent/permission` owns authorization and policy. `infra/sandbox` enforces supplied constraints and receives a per-command approval callback.
- Configuration IO and validation mechanisms belong to `infra/config`; field schemas and defaults belong to their modules.
- Host calls server in one direction. Project initialization belongs to engine application composition.
- Existing configuration, persisted data, HTTP/event contracts, and SDK interfaces remain compatible. The terminal connection will move into the SDK before its client-side network exception is removed.
- Remove code only with consumer/entry-point evidence and equivalent behavior checks. Preserve real OS isolation and independent conformance tests.

## Batches

1. **Permission and sandbox** — authorization under `agent/permission`, mechanisms under `infra/sandbox`; preserve platform resources, strict typechecking, and OS test isolation. Migrate consumers and remove the private sandbox package shell.
2. **Configuration and project composition** — separate module definitions from IO and project resource mechanisms from initialization/reload operations.
3. **Loop** — unify request dispatch, queueing, running state, cancellation, and completion; share tool preparation and consolidate duplicated completion scheduling.
4. **Engine application composition** — task tools retain builtin identity; host/server/project initialization follow the approved dependency direction.
5. **SDK and remaining consolidation** — move terminal transport into the SDK, remove the direct-connect exception, and complete evidence-backed removals.

Keep each batch reviewable, with its validation and limitations recorded here. Intermediate paths can coexist while their batch is pending; do not add compatibility forwarding modules for internal source paths.

All batches are uncommitted on approved baseline `8b1b8b5`. The earlier Batch 1 commit `beb9b78` was withdrawn locally with `git reset --mixed`, preserving its files in the worktree, and withdrawn from `origin/dev-v0.3.0` with an exact expected-SHA lease. No new commit will be created before the user reviews one commit message for the complete change.

## Batch 1 evidence

- Only the engine declared a production dependency on the private `@merakcode/sandbox` workspace. Its two production imports were the former engine sandbox entry and permission policy.
- All production backends, helper resources, tests, and CI setup/reset operations were moved. The Windows experiment was retained under `script/sandbox-spike`, since redundancy has not been established.
- The removed files are the obsolete package manifest, package tsconfig, and package Vitest config. Their responsibilities are covered by the engine dependency manifest, `tsconfig.sandbox.json`, and the sandbox Vitest project.
- pnpm regenerated the lockfile; its only changes remove the old sandbox importer and engine dependency.
- Permissions now supply the same credential denials and cache grants for Windows setup and command execution. The OS layer imports no agent, configuration, session, tool, or server implementation. `check:deps` enforces that direction, including type and dynamic imports.
- Permission and sandbox schemas retain their existing metadata, event names, HTTP paths, and SDK contract. No generated SDK files were edited.

### Validation

- Final complete engine run: **355 files passed**, **2,700 tests passed**, 5 expected failures and 3 existing skips; no unexpected failures. The machine-readable report was retained with the task artifacts.
- Complete `pnpm check` passed, including the stricter sandbox typecheck and SDK public API checks. Maintenance scripts: 12 files / 59 tests passed.
- Sandbox tests passed after migration. A separate Windows conformance run with `MERAKCODE_SANDBOX_REQUIRED=1` passed all 12 scenarios without skipping. Linux and macOS enforcement remain CI requirements.
- The current-platform CLI release build and its bundled smoke test passed.
- The CI release-package smoke gate also passed against the built Windows launcher: startup, HTTP/OpenAPI, tools, providers, SDK session listing, built-in member adapters, and adapter-generator resources. Real model calls were disabled.
- CLI/SDK end-to-end suite: 10 files / 21 tests passed, using real processes and local fake models.
- Generated SDK verification ran outside the repository: all 15 client files were byte-identical. OpenAPI structure was identical; the stored spec's existing `info.version` is `0.1.2`, whereas the unchanged baseline/current CLI product version is `0.2.0`. Repository-generated files were not overwritten.
- Compared the policy builder against the approved source baseline for 72 combinations, including multiple workspace roots, Unicode/space paths, extra grants, duplicate rules, and network patterns. Policy output and Windows setup/execution defaults matched.
- Independent standards review found a live-test configuration inheritance regression; it was fixed by inheriting the engine project rather than the project aggregator. Configuration assertions verified live selection and sandbox isolation without loading live tests. Spec review found no deviation in this batch.
- The first complete engine run reached 2,698 passes with one external-session HTTP 500. A subsequent file-level run captured a Windows `EPERM` from the unchanged `ConfigEdit.commit` rename. The original test file also passed all 44 tests in an isolated copy of the approved baseline.
- A real Windows reader-lock regression reproduced the rename failure. Extending it with a concurrent external edit also rejected a naive rename retry that would lose that edit. The configuration write guard now lives in `infra/config`, retries sharing conflicts with a finite limit, and rechecks its snapshot before each replacement. Configuration and external-session regression runs passed 48 tests; the fix was included in the final complete run.
- A subsequent full run exposed two test-oracle problems: the sandbox setup test imposed a 1-second process completion gate, and the context accounting test sampled live Git state a second time (each Git command has an existing 500ms production timeout). The tests now verify approval release plus actual file output, and account for the context captured in the actual model input. Production timeouts are unchanged. Reverse experiments confirmed that removing approval release or tail token accounting still makes the respective assertion fail; the production sources were restored byte-for-byte afterward. The focused tests passed 27 cases, followed by the complete passing run.
- An unchanged native watcher test reported a cancellation during its asynchronous write loop under load; the original baseline passed its 6 tests in isolation. Its fixture now makes real writes in a separate thread, waits for its first write, and stops and joins the writer in `finally`. The original quiet windows, cancellation/event assertions, and production watcher implementation are unchanged. Its 6 tests passed in isolation and in the final complete run.

The test environment uses the installed Git Bash and an ASCII temporary directory outside the repository. The inherited Windows PowerShell 5 rejects POSIX test commands, and existing end-to-end fixtures put raw temporary paths into HTTP headers. A trial directory under `node_modules` also affected non-Git discovery and plugin loading; it was replaced before the final full runs. No assertions or production behavior were relaxed for those environment failures.

## Batch 2 evidence: configuration and project composition

- Field schemas were moved beside their owners: agent, permission, model/provider, MCP, external agent, collaboration, commands, skills, rules, and server. `app/config.ts` composes the same schema objects; `Config.*` continues to expose the existing names and types. The generated config schema was byte-identical under `pnpm check:schema`.
- `infra/config/source.ts` now parses JSONC and resolves env/file references; `infra/config/recover.ts` handles generic recovery. `app/project/reload.ts` owns workflow-aware deferred disposal and change notification. `app/project/bootstrap.ts` owns instance initialization; `infra/project/workspace.ts` and `infra/scope/state.ts` provide their underlying mechanisms.
- Focused configuration, project, and permission runs passed 383 tests with one existing skip. Engine typecheck and dependency checks passed after these moves.
- At the Batch 2 checkpoint, configuration was still partly coupled to application behavior in `config/config.ts`. File watching, cache ownership, and source-order composition remained pending at that checkpoint; the completion phase below separates those responsibilities from the generic infrastructure mechanisms. No config field, default, path, or persisted format was removed.

## Batch 3 evidence: agent loop and capabilities

- Request dispatch, execution scope, status, cancellation tree, and the former runner now live under `agent/loop`. `Loop.run`, `Loop.Request`, and `Loop.Status` give callers a single execution entry. Three repeated final-turn memory schedules now call `agent/loop/completion.ts`.
- Session facts, model catalog, tools, memory, prompts, skills, MCP, plugins, rules, and external agent adapters were grouped under `agent`. Text prompt resources were moved with their owners. Typecheck and targeted real-behavior tests passed, including 26 session/model and 16 tool/memory cases.
- At this checkpoint, tool visibility was still derived separately for execution and context reporting. The completion phase replaces that calculation with one prepared result and adds child/readonly/model-report equivalence regressions.

## Batch 4 evidence: application composition

- Host and HTTP/WebSocket server now live under `app/host` and `app/server`. The existing `@merakcode/engine/host` export points to the new host entry. Host owns process-level watchers, sandbox wake, actual listener address, and cache cleanup; server owns routes, protocol, listening, and connection cleanup. Server has no host import.
- Workflow, collaboration, cron tasks, and the instance-scoped scheduler are grouped under `app/task`. The internal cron implementation is named `CronScheduler`; the `/loop` command, storage key, event and SDK contract are unchanged. Scheduler registration moved to `app/project/bootstrap.ts`, because `Scheduler.register` depends on `Instance.state` and is not an independent infra timer.
- Representative server/host tests passed 239 and 11 cases at their respective checkpoints; task, workflow, collaboration, and scheduler tests passed 49 cases. The final independent engine run passed 356/356 files and 2,701 tests, with 5 expected failures and 3 existing skips. An earlier run passed 355/356 files and 2,700 tests; the sole failure was the log-route test's 30-second timeout while `pnpm check` ran concurrently. That same test passed in 3.32 seconds alone before the final complete pass.
- The checkpoint retained mixed project/file/LSP/snapshot/PTY responsibilities and agent-to-app imports. The completion phase below separates those implementations and enforces the previously deferred directions. Model credentials remain separate from HTTP local authentication; product features use the SDK.

## Batch 5 evidence: SDK and evidence-backed removals

- The hand-written SDK now exports `connectPty`, `PtyConnection`, and `PtyConnectionOptions`; the desktop terminal uses it and the direct WebSocket exception in `check:deps` is gone. HTTP routes, PTY frames, same-origin authentication, and the existing generated client are unchanged. A real listener and shell PTY test passed with input sent before the socket opened and output received through the SDK.
- Three engine `util` forwarding files (`fn.ts`, `iife.ts`, `lazy.ts`) contained only comments and re-exports of the real `@merakcode/util` implementations. Every source/test import was switched to those implementations; no old-path references remain, engine typecheck passed, and representative affected tests passed. No speculative deletion from the original candidate list was made.
- SDK public API snapshot and bilingual guide were updated for this additive method. `check:deps` reports zero violations; `check:adapter-library` passes after regenerating the moved built-in adapter examples; script tests pass 60/60. The complete `pnpm check` passes. CLI unit tests pass 110/110, and real-process CLI end-to-end tests pass 21/21. Desktop main and renderer unit tests pass 28/28 and 265/265; both builds pass. The 99-case desktop end-to-end run passed 97 and failed two: a clipboard read remained empty, and a review test lost its page during an approximately 86-minute test-host interruption. Both failed tests passed when rerun together in isolation (2/2). The original full run is not recorded as green.
- The SDK suite passes 24/24 files and 164/164 tests at default parallelism after the test fix; it had also passed with two workers before the fix. The original default run twice failed the same two VCS background-job checks, which had a one-second default poll after stopping processes; that file passed 12/12 alone. The two checks now allow up to ten seconds for real checkout release while still requiring a successful branch switch. Production timing is unchanged.
- A fresh SDK generation into a temporary directory produced 15/15 byte-identical generated client files. The OpenAPI JSON structure was identical after normalizing the already-known stored `info.version` 0.1.2 versus current product 0.2.0. The comparison caught an accidental `LoopStatus` schema rename; the internal loop name remains, while the public `SessionStatus` ref was restored before the passing comparison.
- The current-platform CLI release build passed its launcher version check. The CI release-package smoke gate also passed startup, OpenAPI, tools, providers, SDK session listing, member adapters, and adapter-generator resources against the built Windows package.

## Completion phase after acceptance audit

- The only populated engine source roots are now `agent`, `infra` and `app`. Context construction, compaction and model input live in `agent/context`; execution/processor/recovery and undo operations live in `agent/loop`. Session records, messages, transcript and persistent notification facts remain in `agent/session`.
- Application task tools retain their original IDs, order, builtin origin and reserved-name protection. `app/task/install.ts` supplies task tools, workflow commands, collaboration context and workflow cancellation through the existing module interfaces. Agent production code imports no application implementation. The app/server adapter supplies plugins with the authenticated in-process SDK client.
- `app/session.ts` owns recovery reads, initialization, takeover and stop-before-delete orchestration. Native prompt/run/shell/command and external prompt entries reconcile crashed turns before accepting new work, without requiring a prior HTTP GET. New direct-entry tests first reproduced missing recovery and now pass.
- `agent/tools/prepare.ts` owns catalog loading, deferred activation, tool visibility and search construction. The production loop passes one preparation result to both the context view and execution builder. Context reports use the same preparation implementation; execution still rereads live authorization at every tool invocation. Regression tests compare model and report tool names for root, readonly child and automatic root sessions.
- Configuration field definitions are colocated with memory, context, tools, permission, models, plugins, MCP, rules, skills, LSP, formatting, file watching and storage. App configuration statically composes those schema objects. `infra/config` owns JSONC substitution, recovery/validation and guarded editing. `app/config/files` owns source ordering, cache lifetime, application notifications and reload. The agent settings interface binds that one existing loader and adds no cache, schema registry or configuration container.
- The final field-ownership review also moved the unchanged locale schema to `Text.LocaleConfig` and the unchanged log-level option to `Log.ConfigLevel`. Generic configuration fields retain only `$schema` file-format metadata. The generated configuration schema remains byte-identical; no registry, cache or new directory was introduced.
- Project identity/context, file IO, LSP process/protocol, native PTY, document primitives and snapshot mechanisms are infrastructure. Workspace-aware file/LSP/formatter orchestration is under agent, while terminal and worktree operations are under app. Document tools retain their internal DOCX/Excel implementations. Snapshot cleanup receives an application policy that settles undo state before removing expired backups.
- `app/project/discover.ts` owns idempotent adoption of global history, including when resource discovery already created project metadata. Infra discovery does not initiate session migration. Application entry points supply discovery to the existing instance scope, which carries it into nested scopes; like initialization, it runs when the scope is created. Regressions prove resource discovery preserves the global history partition while application discovery adopts it, including the metadata-first sequence.
- A real configured plugin awaiting its authenticated SDK client during project bootstrap reproduced a self-wait cycle (Node exited with unsettled top-level await). Instance scope permits same-context reentry only during bootstrap, when the complete workspace key and cached bootstrap promise match; it clears both temporary markers afterward. The isolated process regression passes. A dispose-then-nested-provide regression first rejected a broader shortcut and now confirms fresh initialization, with multi-root identity rules retained.
- Dependency tests first failed for forbidden agent-to-app and session-record-to-loop imports, then passed after enforcement. These directions now join infra-only, host/server and product SDK checks.

### Additional removal evidence

- Env had zero production consumers; its three old test calls changed an unused environment copy. Provider tests now set real process environment sentinel values and restore them after every test; they still verify saved credentials and custom-provider behavior. All three tests passed before the unused wrapper was removed.
- The private client-core package had one production consumer. Its approval implementation and seven tests moved byte-for-byte to that desktop feature and passed there. Only an unused exported type marker was then removed. The obsolete manifest, package tsconfig and package Vitest config were deleted; pnpm regenerated the lockfile, and the CI package matrix and documentation now use the desktop suite.
- Speculative candidates (different PID error handling, pending writes, historical data readers and the Windows sandbox spike) retain behavior or lack deletion evidence and are retained.

### Completion validation

- Module typechecks, full configuration schema comparison and all dependency rules pass. Focused configuration tests passed 224 cases with one existing skip; targeted tool, lifecycle, plugin, project migration and snapshot regressions were also run during implementation.
- The first completion-phase full engine run exposed 26 failures in four files. Test preload had eagerly imported task/server capabilities before test modules registered their external AI/MCP replacements; those bindings now run in `beforeAll`. A separate member-host process exposed a synchronous throw from an unbound configuration interface, bypassing its existing Promise rejection fallback; runtime methods now preserve asynchronous rejection. A new standalone language-fallback regression failed before that fix, then passed together with the four affected files and plugin bootstrap regressions (six files / 53 tests). Assertions and production timeouts were not relaxed.
- Removing that eager preload exposed a request-first module loading cycle: `Loop.Request` had copied the uninitialized request namespace. The facade now invokes the three live request bindings, preserving synchronous request admission and sharing the original request state. The external-session test first reproduced HTTP 500 and then passed with the existing reply assertions plus an explicit success-status assertion. Five affected files passed 88 tests; native queue, recovery and target-guard tests passed another 18 cases.
- A subsequent full engine run passed 356 files and 2,711 tests, with only the delayed JSONC schema-insertion fixture timing out; that whole file passed 94 tests with one existing skip alone. The fixture now explicitly simulates a warm cache during preparation, then resets it after its files and read gate are ready. The concurrent patch and original data-preservation assertions are unchanged. In a reverse experiment, temporarily removing the production overwrite guard immediately failed both JSON and JSONC cases at the locale-preservation assertion; restoring the exact source passed both. Production timeouts are unchanged.
- The next default-concurrency run completed all 2,712 passing assertions but reported one Windows worker access violation (`0xC0000005`) in `test/server/agent-connection.test.ts`; it is not counted as a passing run. That file passed all 25 cases alone. A complete four-worker run then bounded concurrent native-process activity; no test, assertion, production timeout or sandbox scenario was excluded. The final-tree default-concurrency run below also passed without an unhandled error.
- The complete four-worker engine run passed **357/357 files and 2,712 tests**, with five expected failures and three existing skips; there were no unhandled errors. An independent Windows sandbox conformance run with `MERAKCODE_SANDBOX_REQUIRED=1` passed **12/12 scenarios** without the engine preload and without skipping. Linux and macOS enforcement remain CI requirements.
- The real-process CLI/SDK end-to-end suite passed **10/10 files and 21/21 tests**. Desktop main and renderer production builds passed before starting the complete desktop end-to-end suite.
- The complete desktop end-to-end suite passed **99/99 tests** in one run (13.1 minutes), including terminal transport, approvals, collaboration, restart recovery, review, settings and worktree operations. The Windows CLI release build and every release-package smoke gate passed. These replace the earlier Batch 5 checkpoint's 97/99 result; the historical failed run remains recorded above.
- SDK generation to a separate artifact directory preserves all methods and type shapes. Fourteen of 15 generated files are byte-identical; AST comparison confirms the remaining type file is identical after declaration and union ordering. The existing stored OpenAPI version difference remains; the only additional schema difference is ordering of the same 47 event-union members caused by module load order. Repository generated files are untouched.
- After the last two pure schema definitions moved to their owners, `pnpm check` passed all gates, including fresh typechecks of all seven packages, strict sandbox types, **1,242 files / zero dependency violations**, unchanged SDK API and no unused files/exports/dependencies.
- Every workspace unit suite and the maintenance scripts then passed again on that final source tree, at their default concurrency:

| Suite            | Files passed | Tests passed |
| ---------------- | ------------ | ------------ |
| Root scripts     | 12           | 61           |
| Util             | 12           | 92           |
| Log              | 7            | 43           |
| TypeScript SDK   | 24           | 164          |
| CLI              | 33           | 110          |
| Desktop main     | 9            | 28           |
| Desktop renderer | 47           | 272          |
| Engine           | 357          | 2,712        |
| **Total**        | **501**      | **3,482**    |

The engine retains five existing expected failures and three existing skips; the final run has no unexpected failure or unhandled error. Its default-concurrency run took 513.86 seconds. Substantive lifecycle and boundary fixes have observed failing-then-passing behavior regressions; pure file/schema relocations reuse existing behavioral tests and exact schema comparisons. This records available TDD evidence rather than asserting a fully reconstructable history for every earlier change.

Final SDK generation into the separate artifact directory confirmed **15 generated files: 14 byte-identical, the remaining type file AST-equivalent after declaration/union ordering**. OpenAPI is identical after ordering the same 47 event-union members and normalizing the existing stored `info.version` difference (`0.1.2` versus product `0.2.0`). Repository-generated files and `schema/config.json` remain untouched. The current-source Windows release was rebuilt and passed every smoke gate, with real model calls disabled.

Independent spec and standards reviews have no remaining concrete architecture blockers. Local acceptance is complete: only `agent`, `infra` and `app` contain engine source, product capabilities use the SDK, and removals have the evidence recorded above. Linux/macOS runtime enforcement still requires the retained CI matrix. All changes remain unstaged and uncommitted on `8b1b8b5`; one commit message is provided for user review before any commit is created.

### Post-review migration cleanup

- A follow-up review found that code-level acceptance had omitted physical directory cleanup and two repository path updates. Those completion claims did not cover the entire local checkout.
- Removed 42 empty engine source directory nodes, including the 29 old top-level module trees and the unused `infra/scheduler` and `infra/process/environment` directories. The engine source root now physically contains only `agent`, `infra`, `app` and the existing `runtime.d.ts` declaration file.
- Removed the obsolete `packages/client-core` and `packages/sandbox` directories, including their nine empty source/script directory nodes. Their only remaining files were ignored dependency launchers, test caches and typecheck logs; neither had a package manifest or appeared in the workspace package inventory. Cleanup removed local dependency links without traversing their targets, preserving shared dependencies and util sources.
- Updated `.github/CODEOWNERS` to cover `packages/engine/src/app/host/`, restoring the intended owner assignment for the relocated public host implementation. Updated the pi-mono notice to point to `packages/engine/src/agent/model/error.ts`; attribution and license text remain intact.
- A fresh recursive inventory finds no empty directory outside dependency, build and cache trees. Repository files contain no obsolete `packages/engine/src/<old-root>` references. Historical removal evidence and intentionally synthetic boundary-test paths remain valid.
- The same 1,392 implementation, test, script, schema and dependency-manifest files have an identical combined SHA-256 before and after cleanup: `38a8c5455666351f32cff0460d86733172de6fd2144891674481f0519ef17e7e`. No executable source or contract changed in this cleanup, so the complete behavioral results above remain applicable; those heavy suites were not rerun.
- The maintenance script suite passed again: 12 files / 61 tests. The complete `pnpm check` passed after cleanup and documentation updates, including dependency boundaries, schema/API checks and unused-code analysis. `git diff --check` also passed. The work remains unstaged and uncommitted on the approved baseline.
