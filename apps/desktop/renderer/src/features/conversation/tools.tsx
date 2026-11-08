import type { ToolView } from "@merakcode/sdk"
import ChevronRight from "lucide-solid/icons/chevron-right"
import CircleCheck from "lucide-solid/icons/circle-check"
import LoaderCircle from "lucide-solid/icons/loader-circle"
import Terminal from "lucide-solid/icons/terminal"
import FileText from "lucide-solid/icons/file-text"
import { createEffect, createSignal, Show } from "solid-js"
import { t, type Key } from "../../i18n"
import { relative } from "../../lib/route"

const labels: Record<string, Key> = {
  read_file: "tool.read",
  write_file: "tool.write",
  edit_file: "tool.edit",
  bash: "tool.bash",
  bash_output: "tool.bash",
  glob: "tool.glob",
  grep: "tool.grep",
  list_dir: "tool.list",
  web_fetch: "tool.webfetch",
  web_search: "tool.websearch",
}

/** Displays the tool call and the actual result emitted by the engine. */
export function Tool(props: { part: ToolView; directory: string; onReview?: (file: string) => void }) {
  return (
    <Show when={props.part.name === "bash" || props.part.name === "bash_output"} fallback={<Operation {...props} />}>
      <Bash part={props.part} />
    </Show>
  )
}

function Bash(props: { part: ToolView }) {
  const output = () =>
    props.part.parts
      .map((part) => part.text ?? "")
      .filter(Boolean)
      .join("\n")
  const command = () => {
    const input = props.part.input
    return input && typeof input === "object" && "command" in input && typeof input.command === "string"
      ? input.command
      : props.part.name
  }
  const duration = () => {
    if (!props.part.startedAt || !props.part.endedAt) return ""
    const seconds = (Date.parse(props.part.endedAt) - Date.parse(props.part.startedAt)) / 1000
    return seconds < 1 ? "" : seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds / 60)}m`
  }
  const [open, setOpen] = createSignal(false)
  let result: HTMLPreElement | undefined
  let pinned = true
  createEffect(() => {
    output()
    open()
    if (result && pinned) result.scrollTop = result.scrollHeight
  })
  return (
    <div class="tool-card">
      <button
        type="button"
        class="tool-card-head"
        aria-expanded={output().trim() ? open() : undefined}
        aria-label={t("tool.bash")}
        onClick={() => output().trim() && setOpen((value) => !value)}
      >
        <ChevronRight class="icon icon-sm chevron" />
        <Terminal class="icon icon-sm muted" />
        <code class="name ellipsis selectable" title={command()}>
          {command()}
        </code>
        <span class="spacer" />
        <Show
          when={
            props.part.result?.exitCode !== undefined &&
            props.part.result?.exitCode !== null &&
            props.part.result.exitCode !== 0
          }
        >
          <span class="badge danger">{t("tool.exit", { code: props.part.result!.exitCode! })}</span>
        </Show>
        <Show when={props.part.status === "running"}>
          <LoaderCircle class="icon icon-sm spinner muted" aria-label={t("tool.running")} />
        </Show>
        <Show when={props.part.status === "error"}>
          <span class="badge danger">{t("tool.failed")}</span>
        </Show>
        <span class="subtle">{duration()}</span>
      </button>
      <Show when={open() && output().trim()}>
        <pre
          ref={result}
          class="code-block tool-output selectable"
          onScroll={() => {
            if (result) pinned = result.scrollHeight - result.clientHeight - result.scrollTop <= 8
          }}
          textContent={output().replace(/\s+$/, "")}
        />
      </Show>
    </div>
  )
}

function Operation(props: { part: ToolView; directory: string; onReview?: (file: string) => void }) {
  const [open, setOpen] = createSignal(false)
  const input = () =>
    props.part.input && typeof props.part.input === "object" ? (props.part.input as Record<string, unknown>) : {}
  const subject = () => {
    const value = input().command ?? input().path ?? input().pattern ?? input().query
    return typeof value === "string" ? relative(props.directory, value) : props.part.name
  }
  const output = () =>
    props.part.parts
      .map((part) => part.text ?? "")
      .filter(Boolean)
      .join("\n")
  return (
    <div class="tool-card">
      <button type="button" class="tool-card-head" aria-expanded={open()} onClick={() => setOpen(!open())}>
        <ChevronRight class="icon icon-sm chevron" />
        <Show when={props.part.name.startsWith("bash")} fallback={<FileText class="icon icon-sm muted" />}>
          <Terminal class="icon icon-sm muted" />
        </Show>
        <span class="muted">{labels[props.part.name] ? t(labels[props.part.name]!) : props.part.name}</span>
        <code class="name ellipsis selectable">{subject()}</code>
        <span class="spacer" />
        <Show when={props.part.status === "running"}>
          <LoaderCircle class="icon icon-sm spinner" />
          <span>{t("tool.running")}</span>
        </Show>
        <Show when={props.part.status === "completed"}>
          <CircleCheck class="icon icon-sm add" />
        </Show>
        <Show when={props.part.status === "error"}>
          <span class="badge danger">{t("tool.failed")}</span>
        </Show>
        <Show when={props.part.result?.exitCode !== undefined && props.part.result.exitCode !== 0}>
          <span class="badge danger">{t("tool.exit", { code: props.part.result!.exitCode! })}</span>
        </Show>
      </button>
      <Show when={open()}>
        <div class="step-detail">
          <pre class="code-block selectable">{JSON.stringify(props.part.input, null, 2)}</pre>
          <Show when={output()}>
            <pre class="code-block tool-output selectable">{output()}</pre>
          </Show>
          <Show when={props.part.result?.code}>
            <span class="subtle">{props.part.result?.code}</span>
          </Show>
          <Show
            when={
              props.onReview &&
              ["write_file", "edit_file"].includes(props.part.name) &&
              typeof input().path === "string"
            }
          >
            <button class="button ghost sm" onClick={() => props.onReview?.(String(input().path))}>
              {t("conversation.changes")}
            </button>
          </Show>
        </div>
      </Show>
    </div>
  )
}
