import type { ToolPart } from "@merakcode/sdk/client"
import Bot from "lucide-solid/icons/bot"
import ChevronRight from "lucide-solid/icons/chevron-right"
import CircleCheck from "lucide-solid/icons/circle-check"
import CircleX from "lucide-solid/icons/circle-x"
import FilePen from "lucide-solid/icons/file-pen"
import FilePlus from "lucide-solid/icons/file-plus"
import Globe from "lucide-solid/icons/globe"
import ListChecks from "lucide-solid/icons/list-checks"
import ListTree from "lucide-solid/icons/list-tree"
import LoaderCircle from "lucide-solid/icons/loader-circle"
import Sparkles from "lucide-solid/icons/sparkles"
import Square from "lucide-solid/icons/square"
import SquareCheck from "lucide-solid/icons/square-check"
import Terminal from "lucide-solid/icons/terminal"
import WorkflowIcon from "lucide-solid/icons/workflow"
import Wrench from "lucide-solid/icons/wrench"
import { createSignal, For, Match, Show, Switch, type JSX } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { t } from "../../i18n"
import { relative, sessionPath, decodeDir } from "../../lib/route"
import { call, client } from "../../state/client"
import { toast } from "../../ui/toast"
import { explored } from "./turns"

const text = (value: unknown) => (typeof value === "string" ? value : "")
const duration = (part: ToolPart) => {
  const state = part.state
  if (state.status !== "completed" && state.status !== "error") return ""
  const seconds = (state.time.end - state.time.start) / 1000
  return seconds < 1 ? "" : seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds / 60)}m`
}

function StatusBadge(props: { part: ToolPart }) {
  return (
    <Switch>
      <Match when={props.part.state.status === "running" || props.part.state.status === "pending"}>
        <LoaderCircle class="icon icon-sm spinner muted" aria-label={t("tool.running")} />
      </Match>
      <Match when={props.part.state.status === "error"}>
        <span class="badge danger">{t("tool.failed")}</span>
      </Match>
    </Switch>
  )
}

/** Title row of a step; click to expand the details */
function Step(props: {
  icon: JSX.Element
  title: JSX.Element
  detail?: JSX.Element
  open?: boolean
  running?: boolean
}) {
  const [open, setOpen] = createSignal(props.open ?? false)
  return (
    <div class="step">
      <button class="step-head" aria-expanded={open()} onClick={() => setOpen(!open())} disabled={!props.detail}>
        <ChevronRight class="icon icon-sm chevron" />
        {props.icon}
        <span class="step-title ellipsis">{props.title}</span>
      </button>
      <Show when={open() && props.detail}>
        <div class="step-detail">{props.detail}</div>
      </Show>
    </div>
  )
}

/** Consecutive file reads and searches */
export function Explore(props: { parts: ToolPart[]; directory: string }) {
  const running = () => props.parts.some((part) => part.state.status === "running" || part.state.status === "pending")
  const counts = () => explored(props.parts)
  return (
    <Step
      icon={<ListTree class="icon icon-sm subtle" />}
      title={
        <>
          <b>{running() ? t("conversation.exploring") : t("conversation.explored")}</b>
          <span class="muted"> {t("tool.explore", counts())}</span>
        </>
      }
      detail={
        <ul class="explore-list">
          <For each={props.parts}>
            {(part) => (
              <li class="row">
                <span class="muted">
                  {t(
                    part.tool === "read"
                      ? "tool.read"
                      : part.tool === "glob"
                        ? "tool.glob"
                        : part.tool === "list" || part.tool === "ls"
                          ? "tool.list"
                          : "tool.grep",
                  )}
                </span>
                <span class="mono ellipsis">
                  {part.tool === "read"
                    ? relative(props.directory, text(part.state.input.filePath))
                    : text(part.state.input.pattern) || text(part.state.input.path) || text(part.state.input.query)}
                </span>
                <StatusBadge part={part} />
              </li>
            )}
          </For>
        </ul>
      }
    />
  )
}

/** A shell command and its output (the last lines stream live while it runs) */
function Bash(props: { part: ToolPart }) {
  const output = () => {
    const state = props.part.state
    if (state.status === "completed") return text(state.metadata.output) || state.output
    if (state.status === "running") return text(state.metadata?.output)
    if (state.status === "error") return state.error
    return ""
  }
  const exit = () => {
    const state = props.part.state
    return state.status === "completed" && typeof state.metadata.exit === "number" ? state.metadata.exit : undefined
  }
  const [expanded, setExpanded] = createSignal(false)
  const lines = () => output().replace(/\s+$/, "").split("\n")
  const shown = () => (expanded() ? lines() : lines().slice(-12))
  return (
    <div class="tool-card">
      <div class="tool-card-head">
        <Terminal class="icon icon-sm muted" />
        <span class="muted">{t("tool.bash")}</span>
        <code class="name ellipsis selectable">{text(props.part.state.input.command)}</code>
        <span class="spacer" />
        <Show when={exit() !== undefined && exit() !== 0}>
          <span class="badge danger">{t("tool.exit", { code: exit()! })}</span>
        </Show>
        <StatusBadge part={props.part} />
        <span class="subtle">{duration(props.part)}</span>
      </div>
      <Show when={output().trim()}>
        <pre class="code-block tool-output selectable">{shown().join("\n")}</pre>
        <Show when={lines().length > 12}>
          <button class="button ghost sm more" onClick={() => setExpanded(!expanded())}>
            {expanded() ? t("review.collapse") : t("review.expand")} ({lines().length})
          </button>
        </Show>
      </Show>
    </div>
  )
}

/** A file edit: file name and lines added / removed; click to see it in the review */
function FileChange(props: { part: ToolPart; directory: string; onReview?: (file: string) => void }) {
  const file = () => relative(props.directory, text(props.part.state.input.filePath))
  const stats = () => {
    const state = props.part.state
    const diff = (state.status === "completed" ? state.metadata.filediff : undefined) as
      { additions?: number; deletions?: number } | undefined
    return diff
  }
  return (
    <button class="file-change" onClick={() => props.onReview?.(file())}>
      {props.part.tool === "write" ? <FilePlus class="icon icon-sm subtle" /> : <FilePen class="icon icon-sm subtle" />}
      <span class="muted">{props.part.tool === "write" ? t("tool.write") : t("tool.edit")}</span>
      <span class="mono ellipsis">{file()}</span>
      <Show when={stats()}>
        {(diff) => (
          <>
            <span class="add">+{diff().additions ?? 0}</span>
            <span class="del">−{diff().deletions ?? 0}</span>
          </>
        )}
      </Show>
      <StatusBadge part={props.part} />
    </button>
  )
}

/** A subagent: description and status; click to open its conversation */
function Subagent(props: { part: ToolPart }) {
  const params = useParams()
  const navigate = useNavigate()
  const child = () => {
    const state = props.part.state
    return text((state.status === "running" || state.status === "completed" ? state.metadata : undefined)?.sessionId)
  }
  const open = () => {
    const dir = decodeDir(params.dir ?? "")
    if (dir && child()) navigate(sessionPath(dir, child()))
  }
  return (
    <button class="agent-card" onClick={open} disabled={!child()}>
      <span class="avatar">
        <Bot class="icon icon-sm" />
      </span>
      <span class="body">
        <span class="title ellipsis">{text(props.part.state.input.description) || t("conversation.subagent")}</span>
        <span class="meta subtle">{text(props.part.state.input.subagent_type)}</span>
      </span>
      <Switch>
        <Match when={props.part.state.status === "completed"}>
          <CircleCheck class="icon icon-sm add" />
        </Match>
        <Match when={props.part.state.status === "error"}>
          <CircleX class="icon icon-sm del" />
        </Match>
        <Match when={true}>
          <LoaderCircle class="icon icon-sm spinner muted" />
        </Match>
      </Switch>
    </button>
  )
}

type WorkflowRun = {
  status: "running" | "completed" | "failed" | "aborted"
  workflowName: string
  description?: string
  runId: string
  error?: string
  agents: { id: string; label: string; status: string; sessionId?: string; error?: string }[]
}

/** A workflow: status of each subtask (click to open its conversation); can be cancelled while running */
function Workflow(props: { part: ToolPart; directory: string }) {
  const params = useParams()
  const navigate = useNavigate()
  const run = () => {
    const state = props.part.state
    const metadata = state.status === "running" || state.status === "completed" ? state.metadata : undefined
    return metadata && typeof metadata.runId === "string" ? (metadata as unknown as WorkflowRun) : undefined
  }
  const name = () => run()?.workflowName || text(props.part.state.input.name)
  const status = () => run()?.status ?? (props.part.state.status === "error" ? "failed" : "running")
  const agents = () => run()?.agents ?? []
  const done = () => agents().filter((agent) => agent.status === "completed" || agent.status === "cached").length
  const label = () =>
    ({
      running: t("workflow.running"),
      completed: t("workflow.completed"),
      failed: t("workflow.failed"),
      aborted: t("workflow.aborted"),
    })[status()]
  const cancel = () => {
    const value = run()
    if (!value) return
    void call(client(props.directory).workflow.cancel({ sessionID: props.part.sessionID, runId: value.runId })).catch(
      (error: Error) => toast({ kind: "error", title: t("error.request", { message: error.message }), error: error }),
    )
  }
  const open = (sessionID?: string) => {
    const dir = decodeDir(params.dir ?? "")
    if (dir && sessionID) navigate(sessionPath(dir, sessionID))
  }
  return (
    <div class="workflow-card" role="group" aria-label={`${t("workflow.label")} ${name()}`}>
      <div class="workflow-head">
        <WorkflowIcon class="icon icon-sm muted" />
        <b>{name()}</b>
        <span class={`badge ${status() === "running" ? "accent" : status() === "completed" ? "success" : "danger"}`}>
          {label()}
        </span>
        <Show when={agents().length}>
          <span class="subtle">{t("workflow.progress", { done: done(), total: agents().length })}</span>
        </Show>
        <span class="spacer" />
        <Show when={status() === "running" && run()}>
          <button class="button secondary sm" onClick={cancel}>
            {t("workflow.cancel")}
          </button>
        </Show>
      </div>
      <Show when={run()?.description}>
        <div class="muted workflow-desc">{run()!.description}</div>
      </Show>
      <For each={agents()}>
        {(agent) => (
          <button class="workflow-agent" disabled={!agent.sessionId} onClick={() => open(agent.sessionId)}>
            <Switch fallback={<span class="dot" />}>
              <Match when={agent.status === "running"}>
                <LoaderCircle class="icon icon-xs spinner muted" />
              </Match>
              <Match when={agent.status === "completed" || agent.status === "cached"}>
                <CircleCheck class="icon icon-xs add" />
              </Match>
              <Match when={agent.status === "failed"}>
                <CircleX class="icon icon-xs del" />
              </Match>
            </Switch>
            <span class="ellipsis">{agent.label}</span>
          </button>
        )}
      </For>
      <Show when={run()?.error}>
        <div class="del workflow-desc selectable">{run()!.error}</div>
      </Show>
    </div>
  )
}

function Todos(props: { part: ToolPart }) {
  const todos = () =>
    (Array.isArray(props.part.state.input.todos) ? props.part.state.input.todos : []) as {
      content: string
      status: string
    }[]
  return (
    <div class="todo-card">
      <div class="row muted">
        <ListChecks class="icon icon-sm" />
        {t("tool.todo")}
      </div>
      <For each={todos()}>
        {(todo) => (
          <div class={`todo ${todo.status}`}>
            {todo.status === "completed" ? (
              <SquareCheck class="icon icon-sm add" />
            ) : (
              <Square class="icon icon-sm subtle" />
            )}
            <span>{todo.content}</span>
          </div>
        )}
      </For>
    </div>
  )
}

/** Any other tool: name and title; click to see the input and output */
function Generic(props: { part: ToolPart }) {
  const title = () => {
    const state = props.part.state
    return (state.status === "completed" || state.status === "running" ? state.title : undefined) ?? ""
  }
  const output = () => {
    const state = props.part.state
    return state.status === "completed" ? state.output : state.status === "error" ? state.error : ""
  }
  const icon = () =>
    props.part.tool.startsWith("web") ? (
      <Globe class="icon icon-sm subtle" />
    ) : props.part.tool === "skill" ? (
      <Sparkles class="icon icon-sm subtle" />
    ) : (
      <Wrench class="icon icon-sm subtle" />
    )
  const label = () =>
    ({ webfetch: t("tool.webfetch"), websearch: t("tool.websearch"), skill: t("tool.skill") })[props.part.tool] ??
    props.part.tool
  return (
    <Step
      icon={icon()}
      title={
        <>
          <b>{label()}</b>
          <span class="muted">
            {" "}
            {title() ||
              text(props.part.state.input.url) ||
              text(props.part.state.input.query) ||
              text(props.part.state.input.name)}
          </span>
          <StatusBadge part={props.part} />
        </>
      }
      detail={
        <Show when={output()}>
          <pre class="code-block tool-output selectable">{output().slice(0, 4000)}</pre>
        </Show>
      }
    />
  )
}

export function Tool(props: { part: ToolPart; directory: string; onReview?: (file: string) => void }) {
  return (
    <Switch fallback={<Generic part={props.part} />}>
      <Match when={props.part.tool === "bash" || props.part.tool === "bash_background"}>
        <Bash part={props.part} />
      </Match>
      <Match when={["edit", "write", "multi_edit"].includes(props.part.tool)}>
        <FileChange part={props.part} directory={props.directory} onReview={props.onReview} />
      </Match>
      <Match when={props.part.tool === "subagent"}>
        <Subagent part={props.part} />
      </Match>
      <Match when={props.part.tool === "workflow_run"}>
        <Workflow part={props.part} directory={props.directory} />
      </Match>
      <Match when={props.part.tool === "todowrite"}>
        <Todos part={props.part} />
      </Match>
      <Match when={["question", "plan_exit", "plan_enter", "invalid"].includes(props.part.tool)}>
        <></>
      </Match>
    </Switch>
  )
}
