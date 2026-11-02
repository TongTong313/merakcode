# Session modes and the session plan

MerakCode uses `plan`, `execute` (the default), and `auto`. The composer places the mode beside the attachment
button. Auto uses the danger color. The sandbox control continues to show its configured on/off state.

## Execution contract

- Plan permits research, read-only commands and the one official session plan. It cannot modify project files.
- Execute retains the existing file, command, external-directory, sensitive-path and network safety rules.
- Auto directly allows MerakCode authorization requests, including configured safety denials, and skips the
  command sandbox. It creates no permission popup and writes no permanent grants. Switching back restores the
  rules. Parameter validation, cancellation and concurrency coordination still apply.
- Already sandboxed processes retain their OS restrictions. Allowing a host request cannot remove those restrictions.
- Modes update the root conversation and its children immediately. Pending and newly admitted operations use the
  latest policy. Incompatible active operations are cancelled; the conversation is not restarted and operations are
  not automatically replayed. Finished writes are not automatically rolled back.
- Compound approvals retain every operation check, including checks allowed before a mode switch. Replies and grant
  persistence are rechecked against the current mode. The desktop orders mode changes before subsequent messages;
  ordinary messages inherit server policy instead of submitting a cached mode.
- The next model request uses the current tool pool. The execution entry point also rejects stale calls. Dynamic
  mode context follows stable instructions. Tool-schema changes can still affect provider prefix caches.

## Human interaction

Permission requests and questions have different lifecycles. Switching to auto releases pending permissions, but
questions already registered still wait for the human. New question-class tools are excluded and the question
entry point rejects late requests. Answering an old question never overwrites a later manual mode selection.
Other parallel operations immediately use auto. Entering plan through a suggestion has a 15-second timeout;
submitting a finished plan has no review timeout. Choosing plan directly needs no extra confirmation.

## One collaborative plan

Each root conversation and its children share one editable plan. There is no user-facing version list. Its card says “Plan generated” and
“Awaiting review”, with View plan, Start execution and Continue editing. The side panel's Plan tab opens the same
document in the existing code editor. Continue editing returns to a draft and focuses the composer without sending
a message or starting another model generation.

Human saves win over an agent result generated from an earlier document. Late results are rejected and must not
automatically retry over human changes. Another explicit instruction lets the agent edit the latest document.
Conflicting human buffers are not silently overwritten. An unsaved buffer is preserved during refreshes.
The revision counter coordinates writers and is not plan history. Plan API saves do not broaden the project file API.
Repeated external-editor saves each advance that counter when observed. Session deletion validates all owned plan
paths before clearing records and removes a legacy copy only after its last owner is deleted.

The start button and an explicit chat instruction use one execution flow: save the open plan buffer, obtain the
execution slot, read the latest saved content and persist the execution's fixed plan before doing project work.
Failed saves prevent execution. A queued start does not freeze the plan early. Duplicate starts must not duplicate
the task. An empty plan cannot start. Normal plan execution enters execute mode.

After execution begins, edits remain possible but do not change that execution's fixed plan. Compaction, child
tasks and recovery must use the same execution content. The editor explains this behavior. Editing the document
does not restart, stop or append work. To execute changed content, end the current execution and explicitly start
again.
Built-in grep searches the fixed content through direct paths, directory scans and file aliases, using ripgrep's
regular-expression semantics. The editable document remains available in the editor.

## External products and groups

External products keep their native tools. The shared adapter protocol governs only reported operations and
questions. Unreported actions and native sandbox limits remain outside MerakCode's control. Direct chats and group
members use the root conversation policy. Mode notifications update `task.mode`; optional `modeChanged` handles a
native runtime that supports policy updates. Coverage, live updates, cancellation granularity and limitations are
reported through `capabilities.control`. Missing information is unknown, not complete control. Auto allows reported
permissions, suppresses new questions and preserves existing questions. Settings state these limits for builtin,
custom and generated adapters alike.

The adapter generator, copied runtime, declarations, examples and bilingual SDK documentation share this contract.
Generated copies come from `pnpm generate:adapter-library`.

## Migration and acceptance

Legacy read-only maps to plan, ask maps to execute, and persisted legacy auto maps to execute rather than silently
expanding authorization. Legacy API input must not silently acquire new auto semantics. New modes are used in
session data, SDKs, CLI, tasks and adapters; compatibility translation stays at ingress and persistence boundaries.

Behavior tests use the session API, real tools, plan saving/starting, question and permission lifecycles, local fake
models, fake external CLIs and the desktop. Cancellation is observed through processes and effects, not only abort
calls. Races use controlled readiness points. Destructive command classification is tested without executing those
commands. Safety behavior remains covered in plan/execute when older auto expectations are replaced.

Required validation remains `pnpm check`, repository scripts, package tests, real sandbox conformance, CLI and
desktop E2E, builds/npm consumption and production desktop smoke on Windows, macOS and Linux. New tests must be
included in the applicable jobs; the `CI passed` aggregator retains every required job.

The regression suite covers compound approvals through grant persistence and reply microtasks, delayed path
plugins, shared legacy file identities, and plan observers that re-read or reject a notification. Desktop submissions
cover stale HTTP/event ordering and saving the root plan buffer before a child's start message.

## TDD evidence

The following behavior tests were observed failing before their implementation and passing afterward:

- `session-mode.test.ts`: new mode schema/default; legacy stored authorization; auto bypass of a safety deny;
  auto rejection of newly created questions.
- `plan-collaboration.test.ts`: human-save precedence; fixed execution content and repeated-start identity.
- `runner-permission-mode-live.test.ts`: a real active command stops when the session switches to plan.
- Desktop `composer.test.tsx`: mode control follows the attachment button and displays Execute.
- Desktop `plan.test.tsx`: one generated plan with review actions.
- `scheduler/loop.test.ts`: live root mode and conservative legacy recovery through real model requests.
- Editor `state.test.ts`: keep human content paired with the revision returned by its save.
- Adapter `adapter.test.ts`: a mode notification during initialization replaces stale launch mode.
- `session-import-full.test.ts`: conservative legacy mode migration before import validation.
- `runner-permission-mode-live.test.ts`: same-mode prompts preserve once-approved active processes.
- `session-mode.test.ts`: stale prompt mode persistence cannot overwrite a later manual choice.

These are slice-level results, not a substitute for final regression and CI results.

## Acceptance regression repairs

The follow-up acceptance fixes use these behavior boundaries, with failing runs captured before the fixes:

- A real background process and local fake model reproduce an automatic plan overwrite. Engine notifications now
  remain synthetic, preserve the human-edit block, and still allow a later explicit human revision request.
- Controlled operation readiness reproduces an old plan switch cancelling work after a newer auto/execute switch.
  Cancellation and pending-approval decisions now check the session mode revision again after asynchronous rule
  evaluation. A delayed auto approval must remain pending after the user switches back to execute.
- Real adapter subprocesses reproduce queued tasks starting with stale modes in three switch directions. Startup
  reads the current root mode, and the subscribed adapter receives an initial authoritative mode snapshot.
- Malformed imported message parts reproduce internal errors. Migration now leaves invalid shapes for Zod to reject
  with structured `MRK-1009` input errors, while conservative legacy mode migration remains covered.

Before consolidating file commits, behavior tests cover write, both edit branches and multi-edit. The shared commit
boundary preserves human precedence and cancellation, and runs inside the existing file locks after authorization
and content validation. The same behavior tests and ordinary-file, concurrency, path and secret-scan tests run after
the consolidation. No product API or adapter protocol shape changes are needed for these repairs; the existing full
engine CI suite discovers the regressions on every platform.

The second acceptance pass exercises all four file-writer paths through real case and hardlink aliases. A `.MD`
spelling of the same plan must preserve human edits just like `.md`; identity follows the actual file, including
case-insensitive macOS volumes. Case-sensitive volumes skip only the nonexistent uppercase alias, not I/O errors.
It also drives real background workflows and commands through a local fake model:
the main turn returns, a human edits the document, and the child's next request still receives the approved plan.
The plan stays executing until all background workflows and commands have reached a terminal state; their existing completion
notifications settle the execution without an additional lifecycle manager. Child command notifications also settle
the root plan after its main loop has returned. Repeated start instructions share the current execution until that
completion event; the cache belongs to the instance. Empty-plan errors are checked in both
locales, and the generator instructions use execute/plan terminology.

The repeated renderer image-fixture failure exposed an asynchronous prerequisite inside a one-second DOM wait:
loading the SDK's Node transport and completing HTTP. The fixture now awaits the actual HTTP response before the
unchanged image-content and path assertions. It adds no retry or relaxed assertion/timeout. Full renderer runs
must pass with this readiness boundary; previous failures remain in the audit logs.

Windows full-suite diagnostics also reproduced 30-second timeouts in the dependency and Git-status fixtures. The
dependency archive keeps real Zod JavaScript, CommonJS, exports and npm installation while omitting unused TypeScript
sources/declarations. It additionally verifies that the damaged ESM import fails before recovery. The status fixture
uses real commits and tracking refs; push transport remains covered by integration and desktop tests. Windows caps
file workers at two and at most half the available CPUs; concurrency inside a test and all deadlines are unchanged.
The final discovery still contains exactly the same 364 unique test files. The complete final run passed 2,787 tests
in 1,099.71 seconds, with the original five expected failures and three skips. Original failed-run logs are retained.

## Local validation (Windows, 2026-11-02)

| Check                                               | Result                                                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Repository quality gates (`pnpm check`)             | Passed, including generated SDK/schema/errors/adapter library, API, types, boundaries and docs      |
| Engine, excluding the separate OS conformance entry | 364 files; 2,787 passed, 5 existing expected failures, 3 existing skips                             |
| SDK                                                 | 25 files; 168 passed                                                                                |
| CLI                                                 | 34 files; 116 passed                                                                                |
| Renderer                                            | 52 files; 300 passed; final settings/plan/editor checks also passed                                 |
| Desktop main                                        | 9 files; 28 passed                                                                                  |
| Util / log / repository scripts                     | 92 / 43 / 66 passed                                                                                 |
| CLI end-to-end sequences                            | 10 files; 21 passed                                                                                 |
| Desktop end-to-end                                  | 99 passed, including editing the plan before starting execution                                     |
| Real Windows sandbox conformance                    | 11 passed; no conformance skip                                                                      |
| Builds and npm consumption                          | CLI Windows x64, desktop main/renderer, and isolated CLI/SDK npm consumption passed on Node 26.12.0 |
| Production Windows desktop directory                | Packaged app smoke passed; negative control rejected a failed main reply despite a successful title |

The plan-enter timeout also has a controlled-clock check: it remains pending immediately before its 15-second
boundary and expires at that boundary. The completed-plan review has no timed question. These tests do not replace
`Question.ask` with another implementation.

Earlier runs with several large suites at once observed SDK worktree `ECONNRESET` failures and a 30-second timeout
in the existing locked-ESM-dependency startup test. The two VCS cases, complete SDK suite, dependency file and complete
engine suite subsequently passed. No retry, skipped assertion or relaxed dependency-test deadline was added to hide
those failures. The root cause of the connection reset has not been established; these results do not claim it was
fixed. Keep the original failure logs when assessing Windows concurrency stability.

The follow-up repair run passed the complete engine suite with 16 additional regressions, all other package suites,
both complete E2E suites, strict Windows sandbox conformance and production builds. The first renderer run had a
local-image fixture assertion failure while OS conformance was also running. The fixture passed on its own and the
complete isolated renderer rerun passed all 300 tests. The original failure log is retained; no assertion, timeout
or retry configuration was changed, and this does not establish the failure's root cause.

The second repair adds 12 further behavior regressions. After the readiness correction, two complete renderer runs
passed all 300 tests. The Windows production directory package, its normal smoke, its failure control and isolated
npm consumption also passed. The final complete engine run includes all 2,787 passing tests.

Windows/macOS/Linux CI matrices and required aggregate dependencies remain in place. Mode/plan acceptance cases
run once within the full engine suite. Linux/macOS execution (including their production desktop
packaging/smoke) and minimum-runtime npm consumption remain CI gates not executed locally. No repository commit or
push was made for this change.

## 中文说明

会话统一为计划、执行、自动三种模式，默认执行。模式放在附件按钮右侧；自动使用危险色。沙箱只显示配置的开关。
计划限制智能体的写入能力；执行保留现有安全规则；自动在后端放行审批并绕过命令沙箱。切换立即约束可控操作，
不合规的活动操作被取消，整个任务不重启。已有系统隔离不能靠自动同意解除。

自动禁止新增问答，但切换前已经提出的问题仍需人类回答；其他并行操作立即使用自动权限。旧回答不能覆盖新选择。
进入计划的建议保留 15 秒，计划审核没有超时。

根会话与子会话共用一份可编辑计划，人工保存优先，旧 AI 结果不得覆盖人工内容。卡片和侧栏打开相同编辑器。
开始执行先保存、再读取最新内容并固定本次执行计划；执行开始后的修改不改变当前任务，也不自动重启或追加任务。
内置搜索通过文件路径、目录和别名读取批准快照。连续外部保存会递增内部修订号，旧缓冲区保存返回冲突。
删除会话先校验整组计划路径，最后一个引用释放后才清理旧计划副本。

外部产品使用自己的工具，只对上报行为统一审批；未上报行为、原生沙箱和取消限制在设置中明确说明。适配器生成提示词、
库、示例与中英文文档同步更新。全部变更保留三平台测试、沙箱、构建与 E2E 门禁，不提交或推送。

本地验收：Windows 下引擎 2,787 项、SDK 168 项、CLI 116 项、渲染器 300 项、桌面主进程 28 项通过；
CLI 端到端 21 项、桌面端到端 99 项、真实沙箱 11 项通过，构建与独立 npm 消费验证通过。
并行回归曾出现工作树连接重置和依赖修复超时，独立完整复跑通过；未通过重试或放宽该超时来隐藏失败，连接重置根因尚未确定。
本轮四项缺陷均保留先失败、后修复通过的回归证据，并补齐旧自动审批晚到的同类竞态；四条计划写入路径已共用提交边界。
渲染器首次运行有一项本地图片夹具失败，单文件及隔离完整复跑通过；未改断言、超时或重试配置，首次失败根因未确认。
第二轮新增 12 项行为回归，补齐计划路径别名、后台工作流/命令及子会话收尾、重复启动等边界。图片夹具改为等待真实 HTTP
响应；依赖夹具保留真实运行文件与 npm 安装，Git 状态夹具使用真实提交和 tracking ref，全部原有断言保留。
Windows 文件级 worker 上限收敛为 2，且不超过可用 CPU 的一半；用例内部并发与测试时限不变。最终完整引擎 2,787 项通过。
Windows 生产桌面目录包、正向冒烟及故障对照均已通过。三平台 CI 门禁均保留，macOS/Linux 与最低 Node 运行时仍以 CI 为准。
本次没有提交或推送工作区改动。

## Final acceptance repairs

New authorization requests now retry policy resolution when the root mode revision changes before admission.
The same permission boundary serves native tools, external chats and group members. Explicit mode changes from
child sessions address the root; child task prompts inherit policy without changing it. SDK session reads and
the desktop child selector show the effective root mode. MCP calls forward both operation and parent cancellation
to the native protocol, so a compatible server stops its operation when plan removes that tool.

Plans use session identity for filenames. Safe legacy plan files are copied on first access while retaining human
conflict metadata and the fixed execution. Imports receive independent identities and never reuse untrusted slug
paths. Path validation precedes directory creation. Real file identity protects human saves through directory links,
case aliases and hardlinks. Execution tool reads use the frozen plan; compaction restores it once without rereading
the later editable document. Human API/editor reads still expose the latest editable plan.

OpenCode settles a rejected host question through its native rejection endpoint. Existing questions still forward
real human answers after switching to auto. The generator contract requires this terminal handling for all adapters.
The shared explicit-start matcher is exposed by the SDK client and reused by the engine and desktop save boundary.

本轮回归覆盖新审批准入期间切换模式、子会话显式选择、MCP 实际取消、目录联接保护、导入计划隔离、旧计划迁移、
固定执行计划的读取与压缩恢复、字面替换，以及 OpenCode 拒绝新问题和转发已有人工回答。每个核心问题均保存失败和
修复后的日志。计划仍只有一个可编辑文档，人工修改与执行快照分别通过原有接口使用。

## Final repair verification (Windows, 2026-11-02)

The final engine run passed 2,803 tests across 365 files in 945.68 seconds, retaining the original five expected
failures and three skips. SDK passed 168, CLI 116, renderer 301, desktop main 28, util 101, log 43 and repository
scripts 66. These package and script suites total 3,626 passing tests. Required real Windows sandbox conformance
passed all 11 tests. CLI end-to-end passed 21 and desktop end-to-end passed 99. The rebuilt production desktop
directory passed its normal smoke and the failed-main negative control. Independently installed CLI/SDK npm
artifacts passed consumption on Node 26.12.0. The final root quality gate passed, with 1,279 files and no dependency
boundary violations.

Core behavior repairs retain their failing and passing logs. Authorization timing tests now control the declared
asynchronous policy supplier, observing actual approval events and file effects, without replacing internal Agent
or grant methods. Disabling the new admission checks makes all four contract cases fail. Native MCP cancellation
and builtin OpenCode question rejection are exercised through real local protocol processes.

The original broad run exposed ordinary reads with nonpersistent contexts being incorrectly subjected to session
ID validation. The original SDK package test exposed a private util re-export in type declarations. Both were fixed
with the existing assertions intact. The final complete engine, SDK and renderer suites subsequently passed.
Original failed, interrupted and preflight logs are retained separately from final results.

The OpenCode rejection route was checked against the upstream generated SDK.
[Upstream question rejection](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/sdk/js/src/v2/gen/sdk.gen.ts#L2969)

本轮新增 16 项引擎回归、9 项共享判断测试和 1 项渲染器回归，最终全部包与脚本合计 3,626 项通过。
Windows 真实沙箱 11 项、CLI E2E 21 项、桌面 E2E 99 项通过，生产目录包正反冒烟与独立 npm 消费均通过。
已有读取兼容性和 SDK 声明依赖断言捕获的回归均已修复并完整复跑，未放宽断言、超时或重试设置。
旧计划文件名继续作为受控别名参与固定执行视图，导入会话拥有独立计划身份。所有既有修改保留，没有提交或推送。
macOS/Linux 和最低 Node 运行时仍需相应 CI 验证。
