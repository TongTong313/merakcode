import { createStore } from "solid-js/store"
import { createEffect, createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { Portal, useKeyboard, useTerminalDimensions, type JSX } from "@opentui/solid"
import type { TextareaRenderable } from "@opentui/core"
import { useKeybind } from "../../context/keybind"
import { useTheme, selectedForeground } from "../../context/theme"
import type { PermissionRequest } from "@merakcode/sdk/client"
import { useSDK } from "../../context/sdk"
import { useSync } from "../../context/sync"
import path from "path"
import { LANGUAGE_EXTENSIONS } from "@merakcode/util/language"
import { Keybind } from "@merakcode/util/keybind"
import { Locale } from "@merakcode/util/locale"
import { Paths } from "@merakcode/util/paths"
import { useDialog } from "../../ui/dialog"
import { useLocale } from "../../context/locale"
import { useTextareaKeybindings } from "../../component/textarea-keybindings"
import { isFeedbackSubmit } from "./permission-feedback"
import { permissionChoices, permissionKind, permissionTags } from "@merakcode/client-core/permission"

function normalizePath(input?: string) {
  if (!input) return ""

  const cwd = process.cwd()
  const home = Paths.home
  const absolute = path.isAbsolute(input) ? input : path.resolve(cwd, input)
  const relative = path.relative(cwd, absolute)

  if (!relative) return "."
  if (!relative.startsWith("..")) return relative

  // outside cwd - use ~ or absolute
  if (home && (absolute === home || absolute.startsWith(home + path.sep))) {
    return absolute.replace(home, "~")
  }
  return absolute
}

function filetype(input?: string) {
  if (!input) return "none"
  const ext = path.extname(input)
  const language = LANGUAGE_EXTENSIONS[ext]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}

function EditBody(props: { request: PermissionRequest }) {
  const themeState = useTheme()
  const theme = themeState.theme
  const syntax = themeState.syntax
  const sync = useSync()
  const dimensions = useTerminalDimensions()
  const locale = useLocale()

  const filepath = createMemo(() => (props.request.metadata?.filepath as string) ?? "")
  const diff = createMemo(() => (props.request.metadata?.diff as string) ?? "")

  const view = createMemo(() => {
    const diffStyle = sync.data.config.tui?.diff_style
    if (diffStyle === "stacked") return "unified"
    return dimensions().width > 120 ? "split" : "unified"
  })

  const ft = createMemo(() => filetype(filepath()))

  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="row" gap={1} paddingLeft={1}>
        <text fg={theme.textMuted}>{"→"}</text>
        <text fg={theme.textMuted}>{locale.t("permission.edit", { path: normalizePath(filepath()) })}</text>
      </box>
      <Show when={diff()}>
        <scrollbox height="100%">
          <diff
            diff={diff()}
            view={view()}
            filetype={ft()}
            syntaxStyle={syntax()}
            showLineNumbers={true}
            width="100%"
            wrapMode="word"
            fg={theme.text}
            addedBg={theme.diffAddedBg}
            removedBg={theme.diffRemovedBg}
            contextBg={theme.diffContextBg}
            addedSignColor={theme.diffHighlightAdded}
            removedSignColor={theme.diffHighlightRemoved}
            lineNumberFg={theme.diffLineNumber}
            lineNumberBg={theme.diffContextBg}
            addedLineNumberBg={theme.diffAddedLineNumberBg}
            removedLineNumberBg={theme.diffRemovedLineNumberBg}
          />
        </scrollbox>
      </Show>
    </box>
  )
}

function TextBody(props: { title: string; description?: string; icon?: string }) {
  const { theme } = useTheme()
  return (
    <>
      <box flexDirection="row" gap={1} paddingLeft={1}>
        <Show when={props.icon}>
          <text fg={theme.textMuted} flexShrink={0}>
            {props.icon}
          </text>
        </Show>
        <text fg={theme.textMuted}>{props.title}</text>
      </box>
      <Show when={props.description}>
        <box paddingLeft={1}>
          <text fg={theme.text}>{props.description}</text>
        </box>
      </Show>
    </>
  )
}

export function PermissionPrompt(props: { request: PermissionRequest; pendingTotal?: number }) {
  const sdk = useSDK()
  const sync = useSync()
  const locale = useLocale()
  const { theme } = useTheme()
  const [error, setError] = createSignal("")

  const input = createMemo(() => {
    const tool = props.request.tool
    if (!tool) return {}
    const parts = sync.data.part[tool.messageID] ?? []
    for (const part of parts) {
      if (part.type === "tool" && part.callID === tool.callID && part.state.status !== "pending") {
        return part.state.input ?? {}
      }
    }
    return {}
  })
  const meta = createMemo(() => props.request.metadata ?? {})
  const kind = createMemo(() => permissionKind(props.request.permission))
  const choices = createMemo(() => permissionChoices(props.request))
  const options = createMemo(() =>
    Object.fromEntries(choices().map((choice) => [choice.id, locale.t(choice.label.key, choice.label.vars)])),
  )
  const title = createMemo(() => {
    const base =
      kind() === "tool"
        ? locale.t("permission.title.tool", { tool: props.request.permission })
        : locale.t(`permission.title.${kind()}`)
    const source = props.request.source
      ? " · " + locale.t("permission.source", { agent: props.request.source.agent })
      : ""
    const more =
      (props.pendingTotal ?? 0) > 1 ? " · " + locale.t("permission.pending", { count: props.pendingTotal! - 1 }) : ""
    return base + source + more
  })
  const tags = createMemo(() => permissionTags(props.request).map((tag) => locale.t(`permission.tag.${tag}`)))

  const send = async (body: { reply: "once" | "session" | "always" | "reject"; scope?: string; message?: string }) => {
    setError("")
    await sdk.client.permission
      .reply({ requestID: props.request.id, ...body } as Parameters<typeof sdk.client.permission.reply>[0])
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  return (
    <Prompt
      title={title()}
      body={
        <box flexDirection="column" gap={1}>
          <Switch>
            <Match when={kind() === "command"}>
              <TextBody
                icon="#"
                title={((meta().description ?? input().description) as string) ?? ""}
                description={"$ " + ((meta().command ?? input().command) as string)}
              />
              <box flexDirection="row" gap={2} paddingLeft={1}>
                <Show when={meta().cwd}>
                  <text fg={theme.textMuted}>
                    {locale.t("permission.cwd", { dir: normalizePath(meta().cwd as string) })}
                  </text>
                </Show>
                <Show when={tags().length > 0}>
                  <text fg={theme.warning}>
                    {locale.t("permission.risk", { tags: tags().join(locale.t("permission.tagSeparator")) })}
                  </text>
                </Show>
              </box>
            </Match>
            <Match when={kind() === "edit"}>
              <EditBody request={props.request} />
            </Match>
            <Match when={kind() === "read"}>
              <TextBody
                icon="→"
                title={locale.t("permission.read", {
                  path: normalizePath(((meta().filepath ?? input().filePath) as string) ?? props.request.patterns[0]),
                })}
              />
            </Match>
            <Match when={kind() === "network"}>
              <TextBody
                icon="%"
                title={locale.t("permission.network", { domain: props.request.patterns.join(", ") })}
                description={((input().url ?? input().query) as string) ?? undefined}
              />
            </Match>
            <Match when={kind() === "subagent"}>
              <TextBody
                icon="#"
                title={locale.t("permission.subagent", {
                  type: Locale.titlecase((input().subagent_type as string) ?? "Unknown"),
                })}
                description={
                  "◉ " +
                  ((meta().description ?? input().description ?? "") as string) +
                  (meta().model ? "  ·  " + locale.t("permission.model", { model: meta().model as string }) : "")
                }
              />
            </Match>
            <Match when={kind() === "workflow"}>
              <TextBody
                icon="⚙"
                title={(meta().workflowName as string) ?? ""}
                description={(meta().description as string) ?? undefined}
              />
            </Match>
            <Match when={kind() === "mcp"}>
              <TextBody icon="⚙" title={(meta().toolName as string) ?? props.request.patterns[0]} />
            </Match>
            <Match when={props.request.permission === "glob"}>
              <TextBody icon="✱" title={locale.t("permission.glob", { pattern: input().pattern ?? "" })} />
            </Match>
            <Match when={props.request.permission === "grep"}>
              <TextBody icon="✱" title={locale.t("permission.grep", { pattern: input().pattern ?? "" })} />
            </Match>
            <Match when={props.request.permission === "ls"}>
              <TextBody icon="→" title={locale.t("permission.list", { path: normalizePath(input().path as string) })} />
            </Match>
            <Match when={true}>
              <TextBody icon="⚙" title={props.request.patterns.join(", ")} />
            </Match>
          </Switch>
          <Show when={error()}>
            <box paddingLeft={1}>
              <text fg={theme.error}>{"⚠ " + error()}</text>
            </box>
          </Show>
        </box>
      }
      options={options()}
      feedback={{
        key: props.request.id,
        placeholder: locale.t("permission.feedback"),
        onSubmit: (message) => send({ reply: "reject", message }),
      }}
      escapeKey="reject"
      fullscreen
      onSelect={(id) => {
        const choice = choices().find((item) => item.id === id)
        if (choice) void send({ reply: choice.reply, scope: choice.scope })
      }}
    />
  )
}

function Prompt(props: {
  title: string
  body: JSX.Element
  /** Option id → label; options differ per request. */
  options: Record<string, string>
  feedback?: {
    key: string
    placeholder: string
    onSubmit: (message: string) => Promise<void>
  }
  escapeKey?: string
  fullscreen?: boolean
  /** Extra keybindings (key name → handler). */
  footerKeys?: Record<string, () => void>
  onSelect: (option: string) => void
}) {
  const { theme } = useTheme()
  const keybind = useKeybind()
  const locale = useLocale()
  const dimensions = useTerminalDimensions()
  const bindings = useTextareaKeybindings()
  const keys = createMemo(() => Object.keys(props.options))
  const [store, setStore] = createStore({
    selected: 0,
    expanded: false,
    feedbackOpen: false,
    feedbackBusy: false,
    feedbackError: "",
  })
  let textarea: TextareaRenderable | undefined
  const diffKey = Keybind.parse("ctrl+f")[0]
  const dialog = useDialog()

  createEffect(() => {
    void props.feedback?.key
    textarea?.setText("")
    textarea?.blur()
    setStore("selected", 0)
    setStore("feedbackOpen", false)
    setStore("feedbackBusy", false)
    setStore("feedbackError", "")
  })

  const openFeedback = () => {
    if (!props.feedback) return
    setStore("selected", keys().length)
    setStore("feedbackOpen", true)
    setTimeout(() => {
      textarea?.focus()
      textarea?.gotoLineEnd()
    }, 1)
  }

  const select = () => {
    const option = keys()[store.selected]
    if (!option) {
      openFeedback()
      return
    }
    props.onSelect(option)
  }

  const submitFeedback = async () => {
    if (!props.feedback || store.feedbackBusy) return
    const message = textarea?.plainText.trim().slice(0, 2000) ?? ""
    if (!message) return
    setStore("feedbackBusy", true)
    setStore("feedbackError", "")
    try {
      await props.feedback.onSubmit(message)
    } catch (e) {
      console.error(e)
      setStore("feedbackError", locale.t("permission.feedbackFailed"))
    } finally {
      setStore("feedbackBusy", false)
    }
  }

  useKeyboard((evt) => {
    if (dialog.stack.length > 0) return

    if (textarea?.focused) {
      if (isFeedbackSubmit(evt)) {
        evt.preventDefault()
        evt.stopPropagation()
        void submitFeedback()
        return
      }
      if (evt.name === "escape") {
        evt.preventDefault()
        textarea.blur()
        setStore("feedbackOpen", false)
      }
      return
    }

    if (props.feedback && (evt.name === "i" || evt.name === "tab")) {
      evt.preventDefault()
      openFeedback()
      return
    }

    const digit = Number(evt.name)
    const count = keys().length + (props.feedback ? 1 : 0)
    if (Number.isInteger(digit) && digit >= 1 && digit <= count) {
      evt.preventDefault()
      setStore("selected", digit - 1)
      if (digit === keys().length + 1) {
        openFeedback()
        return
      }
      props.onSelect(keys()[digit - 1])
      return
    }

    if (evt.name === "up" || evt.name === "left" || evt.name === "k" || evt.name === "h") {
      evt.preventDefault()
      setStore("selected", (store.selected - 1 + count) % count)
    }

    if (evt.name === "down" || evt.name === "right" || evt.name === "j" || evt.name === "l") {
      evt.preventDefault()
      setStore("selected", (store.selected + 1) % count)
    }

    if (evt.name === "return" || evt.name === "enter") {
      evt.preventDefault()
      select()
    }

    if (props.escapeKey && (evt.name === "escape" || keybind.match("app_exit", evt))) {
      evt.preventDefault()
      props.onSelect(props.escapeKey)
    }

    const fk = props.footerKeys
    if (fk) {
      const handler = fk[evt.name]
      if (handler) {
        evt.preventDefault()
        handler()
        return
      }
    }

    if (props.fullscreen && diffKey && Keybind.match(diffKey, keybind.parse(evt))) {
      evt.preventDefault()
      evt.stopPropagation()
      setStore("expanded", (v) => !v)
    }
  })

  const content = () => (
    <box
      backgroundColor={theme.backgroundPanel}
      border={true}
      borderStyle="rounded"
      borderColor={theme.warning}
      {...(store.expanded
        ? { top: dimensions().height * -1 + 1, bottom: 1, left: 2, right: 2, position: "absolute" }
        : {
            top: 0,
            maxHeight: Math.min(34, dimensions().height - 2),
            bottom: 0,
            left: 0,
            right: 0,
            position: "relative",
          })}
    >
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1} flexGrow={1}>
        <box flexDirection="row" gap={1} paddingLeft={1} flexShrink={0}>
          <text fg={theme.warning}>{"△"}</text>
          <text fg={theme.text}>{props.title}</text>
        </box>
        {props.body}
      </box>
      <box
        flexDirection="column"
        flexShrink={0}
        gap={1}
        paddingTop={1}
        paddingLeft={2}
        paddingRight={3}
        paddingBottom={1}
        backgroundColor={theme.backgroundElement}
      >
        <For each={keys()}>
          {(option, index) => (
            <box
              width="100%"
              border={true}
              borderStyle="rounded"
              borderColor={index() === store.selected ? theme.warning : theme.borderSubtle}
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={index() === store.selected ? theme.warning : theme.backgroundMenu}
              onMouseOver={() => setStore("selected", index())}
              onMouseUp={() => {
                setStore("selected", index())
                props.onSelect(option)
              }}
            >
              <text fg={index() === store.selected ? selectedForeground(theme, theme.warning) : theme.textMuted}>
                {`${index() + 1} ${props.options[option]}`}
              </text>
            </box>
          )}
        </For>
        <Show when={props.feedback}>
          {(feedback) => (
            <Show
              when={store.feedbackOpen}
              fallback={
                <box
                  width="100%"
                  border={true}
                  borderStyle="rounded"
                  borderColor={keys().length === store.selected ? theme.warning : theme.borderSubtle}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={keys().length === store.selected ? theme.warning : theme.backgroundMenu}
                  onMouseOver={() => setStore("selected", keys().length)}
                  onMouseUp={openFeedback}
                >
                  <text
                    fg={keys().length === store.selected ? selectedForeground(theme, theme.warning) : theme.textMuted}
                  >
                    {`${keys().length + 1} ${feedback().placeholder}`}
                  </text>
                </box>
              }
            >
              <box
                width="100%"
                border={true}
                borderStyle="rounded"
                borderColor={theme.warning}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={theme.backgroundMenu}
                onMouseUp={() => {
                  textarea?.focus()
                  textarea?.gotoLineEnd()
                }}
              >
                <textarea
                  ref={(value: TextareaRenderable) => (textarea = value)}
                  initialValue=""
                  placeholder={feedback().placeholder}
                  minHeight={1}
                  maxHeight={4}
                  textColor={theme.text}
                  focusedTextColor={theme.text}
                  cursorColor={theme.warning}
                  keyBindings={bindings()}
                  onSubmit={() => void submitFeedback()}
                />
              </box>
            </Show>
          )}
        </Show>
        <Show when={store.feedbackBusy}>
          <text fg={theme.textMuted}>{locale.t("permission.feedbackSubmitting")}</text>
        </Show>
        <Show when={store.feedbackError}>
          <text fg={theme.error}>{store.feedbackError}</text>
        </Show>
      </box>
    </box>
  )

  return (
    <Show when={!store.expanded} fallback={<Portal>{content()}</Portal>}>
      {content()}
    </Show>
  )
}
