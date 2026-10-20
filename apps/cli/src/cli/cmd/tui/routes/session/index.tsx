import {
  batch,
  createContext,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  useContext,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import path from "path"
import { useRoute } from "../../context/route"
import { useSync } from "../../context/sync"
import { useProject } from "../../context/project"
import { EmptyBorder, SplitBorder } from "../../component/border"
import { Spinner, SPINNER_FRAMES } from "../../component/spinner"
import { selectedForeground, useTheme } from "../../context/theme"
import {
  BoxRenderable,
  ScrollBoxRenderable,
  addDefaultParsers,
  MacOSScrollAccel,
  type ScrollAcceleration,
  TextAttributes,
  RGBA,
} from "@opentui/core"
import { Prompt, type PromptRef } from "../../component/prompt"
import { ThinkingWord } from "../../component/thinking-word"
import type { AssistantMessage, Part, ToolPart, UserMessage, TextPart } from "@merakcode/sdk/client"
import { useLocal } from "../../context/local"
import { useLocale } from "../../context/locale"
import { useArgs } from "../../context/args"
import { useDirectory } from "../../context/directory"
import { Logo } from "../../component/logo"
import { logo as logoGlyphs } from "../../../../logo"
import { Locale } from "@merakcode/util/locale"
import { errorCode } from "@merakcode/util/error"
import { Log } from "@merakcode/log/logger"
import { useKeyboard, useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import { useSDK } from "../../context/sdk"
import { useCommandDialog } from "../../component/dialog-command"
import { useKeybind } from "../../context/keybind"
import { Header } from "./header"
import { Sidebar } from "./sidebar"
import { useDialog } from "../../ui/dialog"
import { TodoItem } from "../../component/todo-item"
import { DialogMessage } from "./dialog-message"
import { DialogSelect } from "../../ui/dialog-select"
import type { PromptInfo } from "../../component/prompt/history"
import { DialogTimeline } from "./dialog-timeline"
import { DialogForkFromTimeline } from "./dialog-fork-from-timeline"
import { DialogSessionRename } from "../../component/dialog-session-rename"
import { DialogWorkflow } from "../../component/dialog-workflow"
import { LANGUAGE_EXTENSIONS } from "@merakcode/util/language"
import parsers from "../../../../../../parsers-config.ts"
import { Clipboard } from "../../util/clipboard"
import { Toast, useToast } from "../../ui/toast"
import { homeRouteIfSessionNotFound } from "../../util/session-not-found"
import { failure } from "@merakcode/log"
import { useKV } from "../../context/kv.tsx"
import "opentui-spinner/solid"
import { Editor } from "../../util/editor"
import stripAnsi from "strip-ansi"
import { usePromptRef } from "../../context/prompt"
import { useExit } from "../../context/exit"
import { useEvent } from "../../context/event"
import { Filesystem } from "@merakcode/util/filesystem"
import { Paths } from "@merakcode/util/paths"
import { PermissionPrompt } from "./permission"
import { QuestionPrompt } from "./question"
import { DialogExportOptions } from "../../ui/dialog-export-options"
import { DialogPrompt } from "../../ui/dialog-prompt"
import { formatTranscript } from "@merakcode/sdk/transcript"
import { UI } from "../../../../ui.ts"
import { OverlayProvider } from "../../context/overlay"

import type { WorkflowRunRecord } from "../../workflow-types"
import { assistantMessageTokens, assistantModelName, tokenPercentage, visibleMessages } from "./session-usage"
import { handleNestedVerticalScroll } from "./nested-scroll"
import { createSubsessionDisclosure, SubsessionDisclosure } from "./subsession-disclosure"
import type { SessionMessageLoadState } from "../../context/session-message-loader"
import type { ToolInput, ToolMetadata, ToolView } from "../../../tool-view"
import { VERSION } from "../../../../../product-version"
import { TuiFlags } from "../../flags"

addDefaultParsers(parsers.parsers)

class CustomSpeedScroll implements ScrollAcceleration {
  constructor(private speed: number) {}

  tick(_now?: number): number {
    return this.speed
  }

  reset(): void {}
}

const context = createContext<{
  width: number
  sessionID: string | undefined
  conceal: () => boolean
  showTimestamps: () => boolean
  showDetails: () => boolean
  diffWrapMode: () => "word" | "none"
  sync: ReturnType<typeof useSync>
}>()

function use() {
  const ctx = useContext(context)
  if (!ctx) throw new Error("useContext must be used within a Session component")
  return ctx
}

function WelcomeHeader() {
  const { theme } = useTheme()
  const directory = useDirectory()
  const locale = useLocale()
  return (
    <box alignItems="center" paddingLeft={2} paddingRight={2} marginBottom={1}>
      <box flexShrink={0}>
        <Logo />
      </box>
      <box height={1} minHeight={0} flexShrink={1} />
      <box flexShrink={0} alignItems="center">
        <text fg={theme.secondary}>{locale.t("welcome.title", { version: VERSION })}</text>
      </box>
      <box height={0} minHeight={0} flexShrink={1} />
      <box flexShrink={0} alignItems="center">
        <text fg={theme.textMuted}>{locale.t("welcome.workdir", { directory: directory() })}</text>
      </box>
      <box height={1} minHeight={0} flexShrink={1} />
    </box>
  )
}

function workflowElapsed(start: number | undefined, end: number | undefined = Date.now()) {
  if (!start) return ""
  const seconds = Math.max(0, Math.round((end - start) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}m ${rest}s`
}

function workflowStats(run: WorkflowRunStatusSource) {
  const total = run.agentCount ?? run.agents.length
  const running = run.runningAgentCount ?? run.agents.filter((agent) => agent.status === "running").length
  const queued = run.queuedAgentCount ?? run.agents.filter((agent) => agent.status === "queued").length
  const done =
    (run.completedAgentCount ?? run.agents.filter((agent) => agent.status === "completed").length) +
    (run.cachedAgentCount ?? run.agents.filter((agent) => agent.status === "cached").length)
  const failed = run.failedAgentCount ?? run.agents.filter((agent) => agent.status === "failed").length
  return { total, running, queued, done, failed }
}

function workflowStatusLine(run: WorkflowRunStatusSource, hint: string) {
  const stats = workflowStats(run)
  const progress = stats.total > 0 ? `${stats.done}/${stats.total} agents` : `${stats.running} running`
  return [
    run.workflowName,
    run.phase ?? "running",
    progress,
    stats.running ? `${stats.running} active` : "",
    stats.queued ? `${stats.queued} queued` : "",
    stats.failed ? `${stats.failed} failed` : "",
    workflowElapsed(run.createdAt),
    hint,
  ]
    .filter(Boolean)
    .join(" · ")
}

function WorkflowStatusBar(props: { sessionID?: string }) {
  const sdk = useSDK()
  const sync = useSync()
  const event = useEvent()
  const dialog = useDialog()
  const { theme } = useTheme()
  const locale = useLocale()
  const [tick, setTick] = createSignal(0)

  async function fetchRuns() {
    if (!props.sessionID) return []
    const url = new URL("/workflow", sdk.baseUrl)
    url.searchParams.set("sessionID", props.sessionID)
    const res = await sdk.fetch(url)
    if (!res.ok) return []
    return (await res.json()) as WorkflowRunRecord[]
  }

  const [runs, { refetch }] = createResource(() => `${props.sessionID ?? ""}:${tick()}`, fetchRuns, {
    initialValue: [],
  })
  const localRuns = createMemo<WorkflowRunStatusSource[]>(() => {
    if (!props.sessionID) return []
    const messages = sync.data.message[props.sessionID] ?? []
    return messages.flatMap((message) =>
      (sync.data.part[message.id] ?? []).flatMap((part) => {
        if (part.type !== "tool" || part.tool !== "workflow_run" || part.state.status === "pending") return []
        const metadata = part.state.metadata as Partial<WorkflowRunRecord> | undefined
        if (!metadata || metadata.status !== "running" || !metadata.runId) return []
        return [
          {
            runId: metadata.runId,
            status: metadata.status,
            workflowName:
              metadata.workflowName ?? (part.state.input as { name?: string | undefined }).name ?? "workflow",
            phase: metadata.phase,
            agents: Array.isArray(metadata.agents) ? metadata.agents : [],
            createdAt: metadata.createdAt ?? part.state.time.start,
            agentCount: metadata.agentCount,
            queuedAgentCount: metadata.queuedAgentCount,
            runningAgentCount: metadata.runningAgentCount,
            completedAgentCount: metadata.completedAgentCount,
            failedAgentCount: metadata.failedAgentCount,
            cachedAgentCount: metadata.cachedAgentCount,
          },
        ]
      }),
    )
  })
  const running = createMemo(() => {
    const persisted = new Map(runs().map((run) => [run.runId, run]))
    const byId = new Map<string, WorkflowRunStatusSource>()
    for (const run of localRuns()) {
      const saved = persisted.get(run.runId)
      if (saved && saved.status !== "running") continue
      byId.set(run.runId, run)
    }
    for (const run of runs().filter((run) => run.status === "running")) byId.set(run.runId, run)
    return [...byId.values()].toSorted((a, b) => b.createdAt - a.createdAt)
  })
  const status = createMemo(() => {
    const first = running()[0]
    if (!first) return ""
    const suffix = running().length > 1 ? ` · +${running().length - 1} more` : ""
    return workflowStatusLine(first, locale.t("session.workflowHint")) + suffix
  })

  const timer = setInterval(() => {
    if (running().length > 0) setTick((value) => value + 1)
  }, 3000)
  onCleanup(() => clearInterval(timer))

  const unsubscribe = event.on("workflow.updated" as any, (evt: any) => {
    if (!props.sessionID || evt.properties.sessionID !== props.sessionID) return
    void refetch()
  }) as unknown as (() => void) | undefined
  onCleanup(() => unsubscribe?.())

  return (
    <Show when={status()}>
      <box flexDirection="row" gap={1} minWidth={0} onMouseUp={() => dialog.replace(() => <DialogWorkflow />)}>
        <text fg={theme.primary} flexShrink={0}>
          workflow
        </text>
        <text fg={theme.textMuted} wrapMode="none" overflow="hidden" flexGrow={1}>
          {status()}
        </text>
      </box>
    </Show>
  )
}

let once = false

export function Session() {
  const { data: routeData, navigate } = useRoute()
  const sync = useSync()
  const kv = useKV()
  const args = useArgs()
  const { theme } = useTheme()
  const promptRef = usePromptRef()
  const locale = useLocale()
  const sessionID = createMemo(() => (routeData.type === "session" ? routeData.sessionID : undefined))
  const session = createMemo(() => {
    const id = sessionID()
    return id ? sync.session.get(id) : undefined
  })
  const children = createMemo(() => {
    const s = session()
    if (!s) return []
    const parentID = s.parentID ?? s.id
    return sync.data.session
      .filter((x) => x.parentID === parentID || x.id === parentID)
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  })
  const messages = createMemo(() => {
    const id = sessionID()
    if (!id) return []
    const msgs = sync.data.message[id] ?? []
    // Read the store array directly; the session() memo's reference equality would break reactivity.
    const s = sync.data.session.find((x) => x.id === id)
    return visibleMessages(msgs, s)
  })
  // Number of undos: the depth of undoRedo.stack (one entry per undo). hiddenMessages is not counted because one undo
  // hides a whole turn of assistant and tool messages, so a single undo would show up as several.
  // Like messages() above, this reads sync.data.session directly, not the session() memo, or undoRedo changes would not
  // trigger updates. When > 0 a redo hint is shown below the conversation; it resets to 0 once redo empties the stack
  // or a new message is sent (the server discards the stack).
  const revertedCount = createMemo(() => {
    const id = sessionID()
    if (!id) return 0
    const s = sync.data.session.find((x) => x.id === id)
    return s?.undoRedo?.stack?.length ?? 0
  })
  const permissions = createMemo(() => {
    if (session()?.parentID) return []
    return children().flatMap((x) => sync.data.permission[x.id] ?? [])
  })
  const questions = createMemo(() => {
    if (session()?.parentID) return []
    return children().flatMap((x) => sync.data.question[x.id] ?? [])
  })

  const pending = createMemo(() => {
    return messages().findLast((x) => x.role === "assistant" && !x.time.completed)?.id
  })

  const lastAssistant = createMemo(() => {
    return messages().findLast((x) => x.role === "assistant")
  })

  const dimensions = useTerminalDimensions()
  const [conceal, setConceal] = createSignal(true)
  const [timestamps, setTimestamps] = kv.signal<"hide" | "show">("timestamps", "hide")
  const [showDetails, setShowDetails] = kv.signal("tool_details_visibility", true)
  const [showAssistantMetadata] = kv.signal("assistant_metadata_visibility", true)
  const [showScrollbar, setShowScrollbar] = kv.signal("scrollbar_visible", false)
  const [showHeader, setShowHeader] = kv.signal("header_visible", true)
  const [diffWrapMode] = kv.signal<"word" | "none">("diff_wrap_mode", "word")
  // Sidebar preference: hide = off, auto = open on wide screens. sidebarOpen is the manual toggle for this session.
  const [sidebar, setSidebar] = kv.signal<"auto" | "hide">("sidebar", "hide")
  const [sidebarOpen, setSidebarOpen] = createSignal(false)

  const wide = createMemo(() => dimensions().width > 120)
  // Whether the sidebar is enabled; stays enabled on narrow screens and shows again once wide enough.
  const sidebarEnabled = createMemo(() => {
    if (sidebarOpen()) return true
    if (sidebar() === "auto") return true
    return false
  })
  // Whether it renders: only side by side on wide screens, hidden on narrow ones (like opencode's auto mode).
  const sidebarVisible = createMemo(() => {
    if (!sessionID()) return false
    if (session()?.parentID) return false
    if (!wide()) return false
    return sidebarEnabled()
  })

  const showTimestamps = createMemo(() => timestamps() === "show")
  const contentWidth = createMemo(() => dimensions().width - (sidebarVisible() ? 42 : 0) - 4)

  const scrollAcceleration = createMemo(() => {
    const tui = sync.data.config.tui
    if (tui?.scroll_acceleration?.enabled) {
      return new MacOSScrollAccel()
    }
    if (tui?.scroll_speed) {
      return new CustomSpeedScroll(tui.scroll_speed)
    }

    return new CustomSpeedScroll(3)
  })

  createEffect(async () => {
    const id = sessionID()
    if (!id) return
    Log.Product.info("tui session load started", { sessionID: id })
    await sync.session
      .sync(id)
      .then(() => {
        Log.Product.info("tui session load completed", { sessionID: id })
        if (scroll) scroll.scrollBy(100_000)
      })
      .catch((e) => {
        const home = homeRouteIfSessionNotFound(e)
        Log.Product.warn("tui session load failed", { sessionID: id, ...failure(e), missing: !!home })
        const data = e && typeof e === "object" ? (e as { data?: { message?: string }; message?: string }) : undefined
        if (home) navigate(home)
        toast.show({
          message: home
            ? locale.t("toast.sessionNotFound", { id })
            : data?.data?.message || data?.message || (e instanceof Error ? e.message : locale.t("error.unknown")),
          variant: "error",
        })
      })
  })

  const toast = useToast()
  const sdk = useSDK()

  onMount(() => {
    if (once) return
    if (routeData.type === "home" && routeData.initialPrompt) {
      prompt.set(routeData.initialPrompt)
      once = true
    } else if (args.prompt) {
      prompt.set({ input: args.prompt, parts: [] })
      once = true
      prompt.submit()
    }
  })

  // Handle initial prompt from fork
  createEffect(() => {
    const initial = routeData.type === "home" || routeData.type === "session" ? routeData.initialPrompt : undefined
    if (initial && prompt) {
      prompt.set(initial)
    }
  })

  const sessionIDRef = { current: undefined as string | undefined }
  createEffect(() => {
    sessionIDRef.current = sessionID()
  })

  // The session's permission mode can change in the engine (plan_enter / plan_exit, other clients). Follow it locally,
  // otherwise the next message would send the old mode and switch the session back.
  createEffect(
    on(
      () => session()?.permissionMode,
      (mode) => {
        if (mode && mode !== local.permissionMode.current()) local.permissionMode.set(mode)
      },
    ),
  )

  let scroll: ScrollBoxRenderable
  let prompt: PromptRef
  const keybind = useKeybind()

  // Keep the scroll position when loadMore inserts older messages at the top. Compensate only while loading_more is
  // true; otherwise content appended at the bottom while streaming would knock the user out of follow-to-bottom.
  // skipScrollCompensation skips it for timeline jumps (loadAll/loadMore), where scrollBy should reach the target
  // message instead.
  let skipScrollCompensation = false
  let prevScrollHeight = 0
  createEffect(
    on(messages, () => {
      if (!scroll || scroll.isDestroyed) return
      const curr = scroll.scrollHeight
      const grew = curr - prevScrollHeight
      const sid = sessionID()
      const loadingMore = sid ? sync.data.loading_more[sid] : false
      if (grew > 0 && prevScrollHeight > 0 && loadingMore && !skipScrollCompensation) {
        scroll.scrollTo(scroll.scrollTop + grew)
      }
      prevScrollHeight = curr
    }),
  )

  // Load older messages when a scroll-up command reaches the top.
  const maybeLoadMore = () => {
    const sid = sessionID()
    if (!sid) return
    if (!scroll || scroll.isDestroyed) return
    if (scroll.scrollTop > 0) return
    void sync.session.loadMore(sid)
  }

  // Allow exit when in child session (prompt is hidden)
  const exit = useExit()

  createEffect(() => {
    const s = session()
    if (!s?.id) return
    const title = Locale.truncate(s.title ?? "", 50)
    // Convert the theme's primary color (RGBA floats 0-1) to a 24-bit ANSI sequence: the exit message is printed to
    // the raw terminal, not through the TUI renderer.
    const p = theme.primary
    const fg = `\x1b[38;2;${Math.round(p.r * 255)};${Math.round(p.g * 255)};${Math.round(p.b * 255)}m\x1b[1m`
    // The divider matches the width of the longest logo line instead of a hard-coded width.
    const divider = "─".repeat(Math.max(...logoGlyphs.lines.map((l) => l.length)))
    return exit.message.set(
      [
        ``,
        ...logoGlyphs.lines.map((l) => `  ${fg}${l}${UI.Style.TEXT_NORMAL}`),
        `  ${UI.Style.TEXT_DIM}${divider}${UI.Style.TEXT_NORMAL}`,
        ...(title ? [`  ${UI.Style.TEXT_DIM}${title}${UI.Style.TEXT_NORMAL}`] : []),
        `  ${UI.Style.TEXT_DIM}merak -s ${s.id}${UI.Style.TEXT_NORMAL}`,
        ``,
      ].join("\n"),
    )
  })

  useKeyboard((evt) => {
    if (!session()?.parentID) return
    if (keybind.match("app_exit", evt)) {
      exit()
    }
  })

  // Helper: Find next visible message boundary in direction
  const findNextVisibleMessage = (direction: "next" | "prev"): string | null => {
    const children = scroll.getChildren()
    const messagesList = messages()
    const scrollTop = scroll.y

    // Get visible messages sorted by position, filtering for valid non-synthetic, non-ignored content
    const visibleMessages = children
      .filter((c) => {
        if (!c.id) return false
        const message = messagesList.find((m) => m.id === c.id)
        if (!message) return false

        // Check if message has valid non-synthetic, non-ignored text parts
        const parts = sync.data.part[message.id]
        if (!parts || !Array.isArray(parts)) return false

        return parts.some((part) => part && part.type === "text" && !part.synthetic && !part.ignored)
      })
      .sort((a, b) => a.y - b.y)

    if (visibleMessages.length === 0) return null

    if (direction === "next") {
      // Find first message below current position
      return visibleMessages.find((c) => c.y > scrollTop + 10)?.id ?? null
    }
    // Find last message above current position
    return [...visibleMessages].reverse().find((c) => c.y < scrollTop - 10)?.id ?? null
  }

  // Helper: Scroll to message in direction or fallback to page scroll
  const scrollToMessage = (direction: "next" | "prev", dialog: ReturnType<typeof useDialog>) => {
    const targetID = findNextVisibleMessage(direction)

    if (!targetID) {
      scroll.scrollBy(direction === "next" ? scroll.height : -scroll.height)
      dialog.clear()
      return
    }

    const child = scroll.getChildren().find((c) => c.id === targetID)
    if (child) scroll.scrollBy(child.y - scroll.y - 1)
    dialog.clear()
  }

  function toBottom() {
    setTimeout(() => {
      if (!scroll || scroll.isDestroyed) return
      scroll.scrollTo(scroll.scrollHeight)
    }, 50)
  }

  const local = useLocal()

  // Send permission mode changes to the session right away (deferred so mounting does not trigger it). The engine
  // re-evaluates pending approvals and later tool calls under the new mode without waiting for the next message;
  // sending while idle keeps the session mode in sync with the toggle.
  createEffect(
    on(
      () => local.permissionMode.current(),
      (mode) => {
        const id = sessionID()
        if (!id) return
        sdk.client.session.setPermissionMode({ sessionID: id, permissionMode: mode }).catch(() => {})
      },
      { defer: true },
    ),
  )

  function moveChild(direction: number) {
    if (children().length === 1) return
    let next = children().findIndex((x) => x.id === session()?.id) + direction
    if (next >= children().length) next = 0
    if (next < 0) next = children().length - 1
    if (children()[next]) {
      navigate({
        type: "session",
        sessionID: children()[next].id,
      })
    }
  }

  const command = useCommandDialog()
  command.register(() => [
    {
      title: sidebarEnabled() ? locale.t("session.sidebar.hide") : locale.t("session.sidebar.show"),
      value: "session.sidebar.toggle",
      keybind: "sidebar_toggle",
      category: locale.t("command.category.session"),
      onSelect: (dialog) => {
        batch(() => {
          const on = sidebarEnabled()
          setSidebar(() => (on ? "hide" : "auto"))
          setSidebarOpen(!on)
        })
        dialog.clear()
      },
    },
    {
      title: locale.t("session.rename"),
      value: "session.rename",
      keybind: "session_rename",
      category: locale.t("command.category.session"),
      slash: {
        name: "rename",
      },
      onSelect: (dialog) => {
        dialog.replace(() => <DialogSessionRename session={sessionID()!} />)
      },
    },
    {
      title: locale.t("session.timeline"),
      value: "session.timeline",
      keybind: "session_timeline",
      category: locale.t("command.category.session"),
      slash: {
        name: "timeline",
      },
      onSelect: (dialog) => {
        dialog.replace(() => (
          <DialogTimeline
            onMove={(messageID) => {
              // After the full load the older message is already rendered; skip scroll compensation so the effect does
              // not pull the view back.
              skipScrollCompensation = true
              const child = scroll.getChildren().find((child) => {
                return child.id === messageID
              })
              if (child) scroll.scrollBy(child.y - scroll.y - 1)
              setTimeout(() => {
                skipScrollCompensation = false
              }, 0)
            }}
            sessionID={sessionID()!}
            setPrompt={(promptInfo) => prompt.set(promptInfo)}
          />
        ))
      },
    },
    {
      title: locale.t("session.fork"),
      value: "session.fork",
      keybind: "session_fork",
      category: locale.t("command.category.session"),
      slash: {
        name: "fork",
      },
      onSelect: (dialog) => {
        dialog.replace(() => (
          <DialogForkFromTimeline
            onMove={(messageID) => {
              const child = scroll.getChildren().find((child) => {
                return child.id === messageID
              })
              if (child) scroll.scrollBy(child.y - scroll.y - 1)
            }}
            sessionID={sessionID()!}
          />
        ))
      },
    },
    {
      title: locale.t("session.compact"),
      value: "session.compact",
      keybind: "session_compact",
      category: locale.t("command.category.session"),
      slash: {
        name: "compact",
        aliases: ["summarize"],
      },
      onSelect: (dialog) => {
        const selectedModel = local.model.current()
        if (!selectedModel) {
          toast.show({
            variant: "warning",
            message: locale.t("session.compactNeedsProvider"),
            duration: 3000,
          })
          return
        }
        sdk.client.session.summarize({
          sessionID: sessionID()!,
          modelID: selectedModel.modelID,
          providerID: selectedModel.providerID,
        })
        dialog.clear()
      },
    },
    {
      title: locale.t("session.undoMessage"),
      value: "session.undo",
      keybind: "messages_undo",
      category: locale.t("command.category.session"),
      slash: {
        name: "undo",
      },
      onSelect: async (dialog) => {
        const status = sync.data.session_status?.[sessionID()!]
        if (status?.type !== "idle") await sdk.client.session.abort({ sessionID: sessionID()! }).catch(() => {})

        const allMsgs = messages()
        const userMessages = allMsgs.filter((x) => {
          if (x.role !== "user") return false
          const parts = sync.data.part[x.id] ?? []
          // Skip messages without user-typed text (e.g. turns started automatically by compaction).
          const textPart = parts.find((p) => p.type === "text" && !p.synthetic && !p.ignored) as
            { text?: string } | undefined
          return !!textPart?.text?.trim()
        })
        if (userMessages.length === 0) return

        const now = Date.now()
        function getRelativeTime(timestamp: number): string {
          const diff = now - timestamp
          const seconds = Math.floor(diff / 1000)
          const minutes = Math.floor(seconds / 60)
          const hours = Math.floor(minutes / 60)
          const days = Math.floor(hours / 24)
          if (seconds < 60) return locale.t("common.justNow")
          if (minutes < 60) return locale.t("common.minutesAgo", { minutes })
          if (hours < 24) return locale.t("common.hoursAgo", { hours })
          if (days < 7) return locale.t("common.daysAgo", { days })
          return Locale.datetime(timestamp)
        }

        dialog.replace(() => (
          <DialogSelect
            title={locale.t("dialog.undoSelect")}
            options={userMessages.map((msg) => {
              const parts = sync.data.part[msg.id] ?? []
              const textPart = parts.find((p) => p.type === "text" && !p.synthetic && !p.ignored) as
                { text?: string } | undefined
              const text = (textPart?.text ?? "").replace(/\n/g, " ").slice(0, 80)
              const title = text || locale.t("common.emptyMessage")

              // Line changes made during this turn.
              let additions = 0
              let deletions = 0
              const msgIndex = allMsgs.findIndex((m) => m.id === msg.id)
              for (let i = msgIndex; i < allMsgs.length; i++) {
                if (i > msgIndex && allMsgs[i].role === "user") break
                const msgParts = sync.data.part[allMsgs[i].id] ?? []
                for (const part of msgParts) {
                  if (part.type === "patch") {
                    additions += (part as any).additions || 0
                    deletions += (part as any).deletions || 0
                  }
                }
              }

              const diffText = additions || deletions ? `+${additions} -${deletions}` : "+0 -0"

              return {
                title,
                value: msg.id,
                footer: `${getRelativeTime(msg.time.created)}  ·  ${diffText}`,
                onSelect: (innerDialog) => {
                  const promptInfo = parts.reduce(
                    (agg, part) => {
                      if (part.type === "text" && !part.synthetic) agg.input += part.text
                      if (part.type === "file") agg.parts.push(part)
                      return agg
                    },
                    { input: "", parts: [] as PromptInfo["parts"] },
                  )
                  sdk.client.session
                    .revert({
                      sessionID: sessionID()!,
                      messageID: msg.id,
                    })
                    .then(() => {
                      prompt.set(promptInfo)
                      toBottom()
                    })
                    .catch((err: unknown) => {
                      toast.show({
                        message: err instanceof Error ? err.message : String(err),
                        variant: "error",
                      })
                    })
                  innerDialog.clear()
                },
              }
            })}
          />
        ))
        dialog.setSize("large")
      },
    },
    {
      title: locale.t("session.redo"),
      value: "session.redo",
      keybind: "messages_redo",
      category: locale.t("command.category.session"),
      enabled: !!session()?.undoRedo?.stack?.length,
      slash: {
        name: "redo",
      },
      onSelect: (dialog) => {
        dialog.clear()
        const sid = sessionID()!
        sdk.client.session
          .unrevert({ sessionID: sid })
          .then(() => sync.session.reloadMessages(sid))
          .then(() => {
            prompt.set({ input: "", parts: [] })
          })
      },
    },
    {
      title: conceal() ? locale.t("session.conceal.disable") : locale.t("session.conceal.enable"),
      value: "session.toggle.conceal",
      keybind: "messages_toggle_conceal" as any,
      category: locale.t("command.category.session"),
      onSelect: (dialog) => {
        setConceal((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showTimestamps() ? locale.t("session.hideTimestamps") : locale.t("session.showTimestamps"),
      value: "session.toggle.timestamps",
      category: locale.t("command.category.session"),
      slash: {
        name: "timestamps",
        aliases: ["toggle-timestamps"],
      },
      onSelect: (dialog) => {
        setTimestamps((prev) => (prev === "show" ? "hide" : "show"))
        dialog.clear()
      },
    },
    {
      title: showDetails() ? locale.t("session.toolDetails.hide") : locale.t("session.toolDetails.show"),
      value: "session.toggle.actions",
      keybind: "tool_details",
      category: locale.t("command.category.session"),
      onSelect: (dialog) => {
        setShowDetails((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: locale.t("session.toggleScrollbar"),
      value: "session.toggle.scrollbar",
      keybind: "scrollbar_toggle",
      category: locale.t("command.category.session"),
      onSelect: (dialog) => {
        setShowScrollbar((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showHeader() ? locale.t("session.header.hide") : locale.t("session.header.show"),
      value: "session.toggle.header",
      category: locale.t("command.category.session"),
      onSelect: (dialog) => {
        setShowHeader((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: locale.t("keys.messagesPageUp"),
      value: "session.page.up",
      keybind: "messages_page_up",
      category: locale.t("command.category.session"),
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(-scroll.height / 2)
        maybeLoadMore()
        dialog.clear()
      },
    },
    {
      title: locale.t("keys.messagesPageDown"),
      value: "session.page.down",
      keybind: "messages_page_down",
      category: locale.t("command.category.session"),
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(scroll.height / 2)
        dialog.clear()
      },
    },
    {
      title: locale.t("session.lineUp"),
      value: "session.line.up",
      keybind: "messages_line_up",
      category: locale.t("command.category.session"),
      disabled: true,
      onSelect: (dialog) => {
        scroll.scrollBy(-1)
        dialog.clear()
      },
    },
    {
      title: locale.t("session.lineDown"),
      value: "session.line.down",
      keybind: "messages_line_down",
      category: locale.t("command.category.session"),
      disabled: true,
      onSelect: (dialog) => {
        scroll.scrollBy(1)
        dialog.clear()
      },
    },
    {
      title: locale.t("session.halfPageUp"),
      value: "session.half.page.up",
      keybind: "messages_half_page_up",
      category: locale.t("command.category.session"),
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(-scroll.height / 4)
        maybeLoadMore()
        dialog.clear()
      },
    },
    {
      title: locale.t("session.halfPageDown"),
      value: "session.half.page.down",
      keybind: "messages_half_page_down",
      category: locale.t("command.category.session"),
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(scroll.height / 4)
        dialog.clear()
      },
    },
    {
      title: locale.t("keys.messagesFirst"),
      value: "session.first",
      keybind: "messages_first",
      category: locale.t("command.category.session"),
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollTo(0)
        maybeLoadMore()
        dialog.clear()
      },
    },
    {
      title: locale.t("keys.messagesLast"),
      value: "session.last",
      keybind: "messages_last",
      category: locale.t("command.category.session"),
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollTo(scroll.scrollHeight)
        dialog.clear()
      },
    },
    {
      title: locale.t("session.lastUserMessage"),
      value: "session.messages_last_user",
      keybind: "messages_last_user",
      category: locale.t("command.category.session"),
      hidden: true,
      onSelect: () => {
        const messages = sync.data.message[sessionID()!]
        if (!messages || !messages.length) return

        // Find the most recent user message with non-ignored, non-synthetic text parts
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]
          if (!message || message.role !== "user") continue

          const parts = sync.data.part[message.id]
          if (!parts || !Array.isArray(parts)) continue

          const hasValidTextPart = parts.some(
            (part) => part && part.type === "text" && !part.synthetic && !part.ignored,
          )

          if (hasValidTextPart) {
            const child = scroll.getChildren().find((child) => {
              return child.id === message.id
            })
            if (child) scroll.scrollBy(child.y - scroll.y - 1)
            break
          }
        }
      },
    },
    {
      title: locale.t("session.nextMessage"),
      value: "session.message.next",
      keybind: "messages_next",
      category: locale.t("command.category.session"),
      hidden: true,
      onSelect: (dialog) => scrollToMessage("next", dialog),
    },
    {
      title: locale.t("session.previousMessage"),
      value: "session.message.previous",
      keybind: "messages_previous",
      category: locale.t("command.category.session"),
      hidden: true,
      onSelect: (dialog) => scrollToMessage("prev", dialog),
    },
    {
      title: locale.t("session.copyLastAssistant"),
      value: "messages.copy",
      keybind: "messages_copy",
      category: locale.t("command.category.session"),
      onSelect: (dialog) => {
        const lastAssistantMessage = messages().findLast((msg) => msg.role === "assistant")
        if (!lastAssistantMessage) {
          toast.show({ message: locale.t("error.noAssistantMessage"), variant: "error" })
          dialog.clear()
          return
        }

        const parts = sync.data.part[lastAssistantMessage.id] ?? []
        const textParts = parts.filter((part) => part.type === "text")
        if (textParts.length === 0) {
          toast.show({ message: locale.t("error.noAssistantText"), variant: "error" })
          dialog.clear()
          return
        }

        const text = textParts
          .map((part) => part.text)
          .join("\n")
          .trim()
        if (!text) {
          toast.show({
            message: locale.t("error.noAssistantText"),
            variant: "error",
          })
          dialog.clear()
          return
        }

        Clipboard.copy(text)
          .then(() => toast.show({ message: locale.t("success.messageCopied"), variant: "success" }))
          .catch(() => toast.show({ message: locale.t("error.clipboardCopyFailed"), variant: "error" }))
        dialog.clear()
      },
    },
    {
      title: locale.t("session.copy"),
      value: "session.copy",
      category: locale.t("command.category.session"),
      slash: {
        name: "copy",
      },
      onSelect: async (dialog) => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()
          const transcript = formatTranscript(
            sessionData,
            sessionMessages.map((msg) => ({ info: msg, parts: sync.data.part[msg.id] ?? [] })),
            {
              // Thinking is not shown in the UI, but copies and exports include it by default.
              thinking: true,
              toolDetails: showDetails(),
              assistantMetadata: showAssistantMetadata(),
              lang: locale.current === "en-US" ? "en" : "zh",
            },
          )
          await Clipboard.copy(transcript)
          toast.show({ message: locale.t("success.transcriptCopied"), variant: "success" })
        } catch (error) {
          toast.show({ message: locale.t("error.transcriptCopyFailed"), variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: locale.t("session.exportRecord"),
      value: "session.export",
      keybind: "session_export",
      category: locale.t("command.category.session"),
      slash: {
        name: "export",
      },
      onSelect: async (dialog) => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()

          const defaultFilename = `session-${sessionData.id.slice(0, 8)}.md`

          const options = await DialogExportOptions.show(
            dialog,
            defaultFilename,
            // "Include thinking" defaults to on; exports are independent of what the UI shows.
            true,
            showDetails(),
            showAssistantMetadata(),
            false,
          )

          if (options === null) return

          const transcript = formatTranscript(
            sessionData,
            sessionMessages.map((msg) => ({ info: msg, parts: sync.data.part[msg.id] ?? [] })),
            {
              thinking: options.thinking,
              toolDetails: options.toolDetails,
              assistantMetadata: options.assistantMetadata,
              lang: locale.current === "en-US" ? "en" : "zh",
            },
          )

          if (options.openWithoutSaving) {
            // Just open in editor without saving
            await Editor.open({ value: transcript, renderer })
          } else {
            const exportDir = process.cwd()
            const filename = options.filename.trim()
            const filepath = path.join(exportDir, filename)

            await Filesystem.write(filepath, transcript)

            // Open with EDITOR if available
            const result = await Editor.open({ value: transcript, renderer })
            if (result !== undefined) {
              await Filesystem.write(filepath, result)
            }

            toast.show({ message: locale.t("success.sessionExported", { filename }), variant: "success" })
          }
        } catch (error) {
          toast.show({ message: locale.t("error.sessionExportFailed"), variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: locale.t("session.exportRecordFull"),
      value: "session.exportFull",
      keybind: "session_export_full",
      category: locale.t("command.category.session"),
      slash: {
        name: "export-full",
      },
      onSelect: async (dialog) => {
        try {
          const sessionData = session()
          if (!sessionData) return

          const defaultFilename = `session-${sessionData.id.slice(0, 8)}-full.json`
          const filename = await DialogPrompt.show(dialog, locale.t("export.full.filename"), {
            value: defaultFilename,
            placeholder: locale.t("export.full.placeholder"),
          })
          if (filename === null) return

          const res = await sdk.fetch(new URL(`/session/${sessionData.id}/export-full`, sdk.baseUrl))
          if (!res.ok) throw new Error(`export-full failed: ${res.status}`)
          const data = await res.json()

          const exportDir = process.cwd()
          const trimmedFilename = filename.trim()
          const filepath = path.join(exportDir, trimmedFilename)
          await Filesystem.write(filepath, JSON.stringify(data, null, 2))

          toast.show({
            message: locale.t("success.sessionExportedFull", { filename: trimmedFilename }),
            variant: "success",
          })
        } catch (error) {
          toast.show({ message: locale.t("error.sessionExportFullFailed"), variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: locale.t("session.child.next"),
      value: "session.child.next",
      keybind: "session_child_cycle",
      category: locale.t("command.category.session"),
      hidden: true,
      onSelect: (dialog) => {
        moveChild(1)
        dialog.clear()
      },
    },
    {
      title: locale.t("session.child.previous"),
      value: "session.child.previous",
      keybind: "session_child_cycle_reverse",
      category: locale.t("command.category.session"),
      hidden: true,
      onSelect: (dialog) => {
        moveChild(-1)
        dialog.clear()
      },
    },
    {
      title: locale.t("keys.sessionParent"),
      value: "session.parent",
      keybind: "session_parent",
      category: locale.t("command.category.session"),
      hidden: true,
      onSelect: (dialog) => {
        const parentID = session()?.parentID
        if (parentID) {
          navigate({
            type: "session",
            sessionID: parentID,
          })
        }
        dialog.clear()
      },
    },
  ])

  const dialog = useDialog()
  const renderer = useRenderer()

  createEffect(
    on(sessionID, (id) => {
      if (id) toBottom()
    }),
  )

  return (
    <context.Provider
      value={{
        get width() {
          return contentWidth()
        },
        get sessionID() {
          return sessionID()
        },
        conceal,
        showTimestamps,
        showDetails,
        diffWrapMode,
        sync,
      }}
    >
      <box flexDirection="row" flexGrow={1} minHeight={0}>
        <box flexGrow={1} minHeight={0} paddingBottom={1} paddingTop={1} paddingLeft={2} paddingRight={2} gap={1}>
          <OverlayProvider>
            <Show
              when={routeData.type === "session" ? sessionID() : undefined}
              fallback={
                <scrollbox flexGrow={1} scrollAcceleration={scrollAcceleration()}>
                  <WelcomeHeader />
                </scrollbox>
              }
            >
              <scrollbox
                ref={(r) => (scroll = r)}
                viewportOptions={{
                  paddingRight: showScrollbar() ? 1 : 0,
                }}
                verticalScrollbarOptions={{
                  paddingLeft: 1,
                  visible: showScrollbar(),
                  trackOptions: {
                    backgroundColor: theme.backgroundElement,
                    foregroundColor: theme.border,
                  },
                }}
                stickyScroll={true}
                stickyStart="bottom"
                flexGrow={1}
                scrollAcceleration={scrollAcceleration()}
              >
                <WelcomeHeader />
                <Show when={showHeader()}>
                  <Header />
                </Show>
                <For each={messages()}>
                  {(message, index) => (
                    <Switch>
                      <Match when={message.role === "user"}>
                        <UserMessage
                          index={index()}
                          onMouseUp={() => {
                            if (renderer.getSelection()?.getSelectedText()) return
                            dialog.replace(() => (
                              <DialogMessage
                                messageID={message.id}
                                sessionID={sessionID()!}
                                setPrompt={(promptInfo) => prompt.set(promptInfo)}
                              />
                            ))
                          }}
                          message={message as UserMessage}
                          parts={sync.data.part[message.id] ?? []}
                          pending={pending()}
                        />
                      </Match>
                      <Match when={message.role === "assistant"}>
                        <AssistantMessage
                          last={lastAssistant()?.id === message.id}
                          message={message as AssistantMessage}
                          parts={sync.data.part[message.id] ?? []}
                        />
                      </Match>
                    </Switch>
                  )}
                </For>
                <Show when={revertedCount() > 0}>
                  <box
                    marginTop={1}
                    flexShrink={0}
                    flexDirection="column"
                    border={["left"]}
                    customBorderChars={SplitBorder.customBorderChars}
                    borderColor={theme.backgroundElement}
                  >
                    <box paddingTop={1} paddingBottom={1} paddingLeft={2} backgroundColor={theme.backgroundPanel}>
                      <text fg={theme.textMuted}>{locale.t("session.revertedCount", { count: revertedCount() })}</text>
                      <text fg={theme.textMuted}>
                        <span style={{ fg: theme.text }}>{keybind.print("messages_redo")}</span>{" "}
                        {locale.t("session.revertedRestore")}
                      </text>
                    </box>
                  </box>
                </Show>
              </scrollbox>
            </Show>
            <box flexShrink={0}>
              <Show when={permissions().length > 0}>
                <PermissionPrompt request={permissions()[0]} pendingTotal={permissions().length} />
              </Show>
              <Show when={permissions().length === 0 && questions().length > 0}>
                <QuestionPrompt request={questions()[0]} />
              </Show>
              <Prompt
                visible={!session()?.parentID && permissions().length === 0 && questions().length === 0}
                ref={(r) => {
                  prompt = r
                  promptRef.set(r)
                  // Apply initial prompt when prompt component mounts (e.g., from fork)
                  const initial =
                    routeData.type === "home" || routeData.type === "session" ? routeData.initialPrompt : undefined
                  if (initial) {
                    r.set(initial)
                  }
                }}
                disabled={permissions().length > 0 || questions().length > 0}
                onSubmit={() => {
                  toBottom()
                }}
                sessionID={sessionID()}
                status={
                  <box flexDirection="column">
                    <WorkflowStatusBar sessionID={sessionID()} />
                  </box>
                }
              />
              <Show when={!session()?.parentID && permissions().length === 0 && questions().length === 0}>
                <box flexDirection="row" justifyContent="center">
                  <text fg={theme.textMuted}>{locale.t("session.aiDisclaimer")}</text>
                </box>
              </Show>
            </box>
          </OverlayProvider>
          <Toast />
        </box>
        <Show when={sidebarVisible() && sessionID()}>
          <Sidebar sessionID={sessionID()!} />
        </Show>
      </box>
    </context.Provider>
  )
}

const MIME_BADGE: Record<string, string> = {
  "text/plain": "txt",
  "image/png": "img",
  "image/jpeg": "img",
  "image/gif": "img",
  "image/webp": "img",
  "application/pdf": "pdf",
  "application/x-directory": "dir",
}

function UserMessage(props: {
  message: UserMessage
  parts: Part[]
  onMouseUp: () => void
  index: number
  pending?: string
}) {
  const ctx = use()
  const local = useLocal()
  const locale = useLocale()
  const text = createMemo(() => props.parts.flatMap((x) => (x.type === "text" && !x.synthetic ? [x] : []))[0])
  const files = createMemo(() => props.parts.flatMap((x) => (x.type === "file" ? [x] : [])))
  const sync = useSync()
  const { theme } = useTheme()
  const color = createMemo(() => local.agent.color(props.message.agent))
  const queued = createMemo(() => {
    const list = sync.data.message[props.message.sessionID] ?? []
    // An assistant reply to this message means it is running or done, so it is not queued.
    const hasAssistant = list.some(
      (m) => m.role === "assistant" && (m as AssistantMessage).parentID === props.message.id,
    )
    if (hasAssistant) return false

    // Another assistant message is still running.
    const activeAssistant = list.find((m) => m.role === "assistant" && !m.time.completed) as
      AssistantMessage | undefined

    if (activeAssistant && activeAssistant.parentID !== props.message.id) {
      return true
    }

    // The session is busy and an earlier user message is still unanswered.
    const isBusy = sync.data.session_status?.[props.message.sessionID]?.type === "busy"
    if (isBusy) {
      const earlierUser = list.find(
        (m) =>
          m.role === "user" &&
          m.id < props.message.id &&
          !list.some(
            (a) => a.role === "assistant" && (a as AssistantMessage).parentID === m.id && Boolean(a.time.completed),
          ),
      )
      if (earlierUser) return true
    }

    return Boolean(props.pending && props.message.id > props.pending)
  })
  const queuedFg = createMemo(() => selectedForeground(theme, color()))

  const compaction = createMemo(() => props.parts.find((x) => x.type === "compaction"))

  return (
    <>
      <Show when={text()}>
        <box id={props.message.id} marginTop={1} paddingLeft={2} onMouseUp={props.onMouseUp} flexShrink={0}>
          <text fg={theme.text}>
            <span style={{ fg: color(), bold: true }}>▎ </span>
            {text()?.text}
          </text>
          <Show when={files().length}>
            <box flexDirection="row" paddingTop={1} gap={1} flexWrap="wrap">
              <For each={files()}>
                {(file) => {
                  const bg = createMemo(() => {
                    if (file.mime.startsWith("image/")) return theme.accent
                    if (file.mime === "application/pdf") return theme.primary
                    return theme.secondary
                  })
                  return (
                    <text fg={theme.text}>
                      <span style={{ bg: bg(), fg: theme.background }}> {MIME_BADGE[file.mime] ?? file.mime} </span>
                      <span style={{ bg: theme.backgroundElement, fg: theme.textMuted }}> {file.filename} </span>
                    </text>
                  )
                }}
              </For>
            </box>
          </Show>
          <Show
            when={queued()}
            fallback={
              <Show when={ctx.showTimestamps()}>
                <text fg={theme.textMuted} paddingTop={1}>
                  {Locale.todayTimeOrDateTime(props.message.time.created)}
                </text>
              </Show>
            }
          >
            <text fg={theme.textMuted} paddingTop={1}>
              <span style={{ bg: color(), fg: queuedFg(), bold: true }}> {locale.t("session.queued")} </span>
            </text>
          </Show>
        </box>
      </Show>
      <Show when={compaction()}>
        <box
          marginTop={1}
          border={["top"]}
          title={` ${locale.t("session.compaction")} `}
          titleAlignment="center"
          borderColor={theme.borderActive}
        />
      </Show>
    </>
  )
}

function AssistantMessage(props: { message: AssistantMessage; parts: Part[]; last: boolean }) {
  const local = useLocal()
  const locale = useLocale()
  const { theme } = useTheme()
  const sync = useSync()
  const messages = createMemo(() => sync.data.message[props.message.sessionID] ?? [])

  const final = createMemo(() => {
    return props.message.finish && !["tool-calls", "unknown"].includes(props.message.finish)
  })

  const duration = createMemo(() => {
    if (!final()) return 0
    if (!props.message.time.completed) return 0
    const user = messages().find((x) => x.role === "user" && x.id === props.message.parentID)
    if (!user || !user.time) return 0
    return props.message.time.completed - user.time.created
  })
  const permissionMode = createMemo(() => {
    const user = messages().find((x) => x.role === "user" && x.id === props.message.parentID)
    if (!user || user.role !== "user") return undefined
    return user.permissionMode ?? "ask"
  })

  const totalTokens = createMemo(() => assistantMessageTokens(props.message))

  const modelName = createMemo(() => assistantModelName(props.message, sync.data.provider))

  const tokenPct = createMemo(() =>
    tokenPercentage(totalTokens(), props.message.providerID, props.message.modelID, sync.data.provider),
  )

  const percentColor = createMemo(() => {
    const pct = tokenPct()
    if (pct === null) return theme.textMuted
    if (pct >= 80) return theme.error
    if (pct >= 50) return theme.warning
    return theme.textMuted
  })

  return (
    <>
      <For each={props.parts}>
        {(part, index) => {
          const component = createMemo(() => PART_MAPPING[part.type as keyof typeof PART_MAPPING])
          return (
            <Show when={component()}>
              <Dynamic
                last={index() === props.parts.length - 1}
                component={component()}
                part={part as any}
                message={props.message}
              />
            </Show>
          )
        }}
      </For>
      <Show when={props.message.error && props.message.error.name !== "MessageAbortedError"}>
        <box
          border={["left"]}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          marginTop={1}
          backgroundColor={theme.backgroundPanel}
          customBorderChars={SplitBorder.customBorderChars}
          borderColor={theme.error}
        >
          <text fg={theme.textMuted}>
            {[
              errorCode(props.message.error) && `[${errorCode(props.message.error)}]`,
              props.message.error?.data.message,
            ]
              .filter(Boolean)
              .join(" ")}
          </text>
        </box>
      </Show>
      <Switch>
        <Match when={props.last || final() || props.message.error?.name === "MessageAbortedError"}>
          <>
            <Show when={props.last && sync.data.session_status?.[props.message.sessionID]?.type === "busy"}>
              <box paddingLeft={3} marginTop={1}>
                <ThinkingWord />
              </box>
            </Show>
            <box paddingLeft={3}>
              <text marginTop={1}>
                <span
                  style={{
                    fg:
                      props.message.error?.name === "MessageAbortedError"
                        ? theme.textMuted
                        : local.agent.color(props.message.agent),
                  }}
                >
                  ▣{" "}
                </span>{" "}
                <span style={{ fg: theme.text }}>{Locale.titlecase(props.message.mode)}</span>
                <Show when={permissionMode()}>
                  {(mode) => (
                    <span style={{ fg: mode() === "auto" ? theme.warning : theme.textMuted }}>
                      {" "}
                      · {locale.t(`status.mode.${mode()}`)}
                    </span>
                  )}
                </Show>
                <span style={{ fg: theme.textMuted }}> · {modelName()}</span>
                <Show when={duration()}>
                  <span style={{ fg: theme.textMuted }}> · {Locale.duration(duration())}</span>
                </Show>
                <Show when={final() && totalTokens() > 0}>
                  <span style={{ fg: theme.textMuted }}> · {totalTokens().toLocaleString()} tokens</span>
                  <Show when={tokenPct() !== null}>
                    <span style={{ fg: percentColor() }}> {tokenPct()}%</span>
                  </Show>
                </Show>
                <Show when={final() && props.message.cost > 0}>
                  <span style={{ fg: theme.textMuted }}>
                    {" "}
                    ·{" "}
                    {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(props.message.cost)}
                  </span>
                </Show>
                <Show when={props.message.error?.name === "MessageAbortedError"}>
                  <span style={{ fg: theme.textMuted }}> · {locale.t("session.interrupted")}</span>
                </Show>
              </text>
            </box>
          </>
        </Match>
      </Switch>
    </>
  )
}

const PART_MAPPING = {
  text: TextPart,
  tool: ToolPart,
  // Reasoning parts are not rendered in the UI (thinking is toggled with /thinking).
}

function TextPart(props: { last: boolean; part: TextPart; message: AssistantMessage }) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  return (
    <Show when={props.part.text.trim()}>
      <box id={"text-" + props.part.id} paddingLeft={3} marginTop={1} flexShrink={0}>
        <Switch>
          <Match when={TuiFlags.markdown}>
            <markdown
              syntaxStyle={syntax()}
              streaming={true}
              content={props.part.text.trim()}
              conceal={ctx.conceal()}
            />
          </Match>
          <Match when={!TuiFlags.markdown}>
            <code
              filetype="markdown"
              drawUnstyledText={false}
              streaming={true}
              syntaxStyle={syntax()}
              content={props.part.text.trim()}
              conceal={ctx.conceal()}
              fg={theme.text}
            />
          </Match>
        </Switch>
      </box>
    </Show>
  )
}

// Pending messages moved to individual tool pending functions

function ToolPart(props: { last: boolean; part: ToolPart; message: AssistantMessage }) {
  const ctx = use()
  const sync = useSync()

  // Hide tool if showDetails is false and tool completed successfully
  const shouldHide = createMemo(() => {
    if (ctx.showDetails()) return false
    if (props.part.state.status !== "completed") return false
    return true
  })

  const toolprops = {
    get metadata() {
      return props.part.state.status === "pending" ? {} : (props.part.state.metadata ?? {})
    },
    get input() {
      return props.part.state.input ?? {}
    },
    get output() {
      return props.part.state.status === "completed" ? props.part.state.output : undefined
    },
    get permission() {
      const permissions = sync.data.permission[props.message.sessionID] ?? []
      const permissionIndex = permissions.findIndex((x) => x.tool?.callID === props.part.callID)
      return permissions[permissionIndex]
    },
    get tool() {
      return props.part.tool
    },
    get part() {
      return props.part
    },
  }

  return (
    <Show when={!shouldHide()}>
      <Switch>
        <Match when={props.part.tool === "bash"}>
          <Bash {...toolprops} />
        </Match>
        <Match when={props.part.tool === "glob"}>
          <Glob {...toolprops} />
        </Match>
        <Match when={props.part.tool === "read"}>
          <Read {...toolprops} />
        </Match>
        <Match when={props.part.tool === "grep"}>
          <Grep {...toolprops} />
        </Match>
        <Match when={props.part.tool === "ls"}>
          <List {...toolprops} />
        </Match>
        <Match when={props.part.tool === "webfetch"}>
          <WebFetch {...toolprops} />
        </Match>
        <Match when={props.part.tool === "codesearch"}>
          <CodeSearch {...toolprops} />
        </Match>
        <Match when={props.part.tool === "websearch"}>
          <WebSearch {...toolprops} />
        </Match>
        <Match when={props.part.tool === "write"}>
          <Write {...toolprops} />
        </Match>
        <Match when={props.part.tool === "edit"}>
          <Edit {...toolprops} />
        </Match>
        <Match when={props.part.tool === "multi_edit"}>
          <MultiEdit {...toolprops} />
        </Match>
        {/* Subagent calls; `task` is the legacy name of `subagent` */}
        <Match when={props.part.tool === "task" || props.part.tool === "subagent"}>
          <SubAgent {...toolprops} />
        </Match>
        <Match when={props.part.tool === "todowrite"}>
          <TodoWrite {...toolprops} />
        </Match>
        <Match when={props.part.tool === "question"}>
          <Question {...toolprops} />
        </Match>
        <Match when={props.part.tool === "skill"}>
          <Skill {...toolprops} />
        </Match>
        <Match when={props.part.tool === "rule"}>
          <RuleFetch {...toolprops} />
        </Match>
        <Match when={props.part.tool === "workflow_run"}>
          <WorkflowRun {...toolprops} />
        </Match>
        <Match when={true}>
          <GenericTool {...toolprops} />
        </Match>
      </Switch>
    </Show>
  )
}

type ToolProps<Name extends keyof ToolView | any> = {
  input: Name extends keyof ToolView ? ToolInput<Name> : Record<string, any>
  metadata: Name extends keyof ToolView ? ToolMetadata<Name> : Record<string, any>
  permission: Record<string, any>
  tool: string
  output?: string
  part: ToolPart
}

type WorkflowRunStatusSource = Pick<
  WorkflowRunRecord,
  | "status"
  | "runId"
  | "workflowName"
  | "phase"
  | "agents"
  | "createdAt"
  | "agentCount"
  | "queuedAgentCount"
  | "runningAgentCount"
  | "completedAgentCount"
  | "failedAgentCount"
  | "cachedAgentCount"
>

function GenericTool(props: ToolProps<any>) {
  const locale = useLocale()
  return (
    <InlineTool icon="⚙" pending={locale.t("tool.pending.default")} complete={true} part={props.part}>
      {props.tool} {input(props.input)}
    </InlineTool>
  )
}

function InlineTool(props: {
  icon: string
  iconColor?: RGBA
  complete: any
  pending: string
  displayName?: string // overrides the tool name shown in the fallback branch
  children: JSX.Element
  part: ToolPart
}) {
  const [margin, setMargin] = createSignal(0)
  const { theme } = useTheme()
  const kv = useKV()
  const ctx = use()
  const sync = useSync()

  const permission = createMemo(() => {
    const callID = ctx.sessionID ? sync.data.permission[ctx.sessionID]?.at(0)?.tool?.callID : undefined
    if (!callID) return false
    return callID === props.part.callID
  })

  const fg = createMemo(() => {
    if (permission()) return theme.warning
    if (props.complete) return theme.textMuted
    return theme.text
  })

  const error = createMemo(() => (props.part.state.status === "error" ? props.part.state.error : undefined))

  const denied = createMemo(
    () =>
      error()?.includes("rejected permission") ||
      error()?.includes("specified a rule") ||
      error()?.includes("user dismissed"),
  )

  return (
    <box
      marginTop={margin()}
      paddingLeft={3}
      renderBefore={function () {
        const el = this as BoxRenderable
        const parent = el.parent
        if (!parent) {
          return
        }
        if (el.height > 1) {
          setMargin(1)
          return
        }
        const children = parent.getChildren()
        const index = children.indexOf(el)
        const previous = children[index - 1]
        if (!previous) {
          setMargin(0)
          return
        }
        if (previous.height > 1 || previous.id.startsWith("text-")) {
          setMargin(1)
          return
        }
      }}
    >
      <Show
        when={props.complete}
        fallback={
          <Show
            when={kv.get("animations_enabled", true)}
            fallback={
              <text paddingLeft={3} fg={fg()} attributes={denied() ? TextAttributes.STRIKETHROUGH : undefined}>
                <span style={{ fg: theme.textMuted }}>⋯</span> {props.displayName ?? props.part.tool} ·{" "}
                <span style={{ fg: theme.textMuted }}>{props.pending}</span>
              </text>
            }
          >
            <box flexDirection="row" gap={1} paddingLeft={3}>
              <spinner frames={SPINNER_FRAMES} interval={80} color={theme.textMuted} />
              <text fg={fg()} attributes={denied() ? TextAttributes.STRIKETHROUGH : undefined}>
                {props.displayName ?? props.part.tool} · <span style={{ fg: theme.textMuted }}>{props.pending}</span>
              </text>
            </box>
          </Show>
        }
      >
        <text paddingLeft={3} fg={fg()} attributes={denied() ? TextAttributes.STRIKETHROUGH : undefined}>
          <span style={{ fg: props.iconColor }}>{props.icon}</span> {props.children}
        </text>
      </Show>
      <Show when={error() && !denied()}>
        <text fg={theme.error}>{error()}</text>
      </Show>
    </box>
  )
}

function BlockTool(props: {
  title: string
  children: JSX.Element
  onClick?: () => void
  part?: ToolPart
  spinner?: boolean
}) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const error = createMemo(() => (props.part?.state.status === "error" ? props.part.state.error : undefined))
  return (
    <box
      border={["left"]}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      marginTop={1}
      gap={1}
      customBorderChars={{ ...EmptyBorder, vertical: "┃" }}
      borderColor={theme.borderSubtle}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        props.onClick?.()
      }}
    >
      <Show
        when={props.spinner}
        fallback={
          <text paddingLeft={3} fg={theme.textMuted}>
            {props.title}
          </text>
        }
      >
        <Spinner color={theme.textMuted}>{props.title.replace(/^# /, "")}</Spinner>
      </Show>
      {props.children}
      <Show when={error()}>
        <text fg={theme.error}>{error()}</text>
      </Show>
    </box>
  )
}

function Bash(props: ToolProps<"bash">) {
  const { theme } = useTheme()
  const locale = useLocale()
  const project = useProject()
  const isRunning = createMemo(() => props.part.state.status === "running")
  const output = createMemo(() => stripAnsi(props.metadata.output?.trim() ?? ""))
  const [expanded, setExpanded] = createSignal(false)
  const lines = createMemo(() => output().split("\n"))
  const overflow = createMemo(() => lines().length > 10)
  const limited = createMemo(() => {
    if (expanded() || !overflow()) return output()
    return [...lines().slice(0, 10), "…"].join("\n")
  })

  const workdirDisplay = createMemo(() => {
    const workdir = props.input.workdir
    if (!workdir || workdir === ".") return undefined

    const base = project.directory()
    if (!base) return undefined

    const absolute = path.resolve(base, workdir)
    if (absolute === base) return undefined

    const home = Paths.home
    if (!home) return absolute

    const match = absolute === home || absolute.startsWith(home + path.sep)
    return match ? absolute.replace(home, "~") : absolute
  })

  const title = createMemo(() => {
    const desc = props.input.description ?? locale.t("tool.name.bash")
    const wd = workdirDisplay()
    if (!wd) return `# ${desc}`
    if (desc.includes(wd)) return `# ${desc}`
    return `# ${desc} in ${wd}`
  })

  return (
    <Switch>
      <Match when={props.metadata.output !== undefined}>
        <BlockTool
          title={title()}
          part={props.part}
          spinner={isRunning()}
          onClick={overflow() ? () => setExpanded((prev) => !prev) : undefined}
        >
          <box
            backgroundColor={theme.backgroundPanel}
            border={["top", "bottom", "left", "right"]}
            borderColor={theme.borderSubtle}
            customBorderChars={{
              ...EmptyBorder,
              topLeft: "┌",
              topRight: "┐",
              bottomLeft: "└",
              bottomRight: "┘",
              horizontal: "─",
              vertical: "│",
            }}
            paddingLeft={1}
            paddingRight={1}
            paddingTop={1}
            paddingBottom={1}
            gap={1}
          >
            <text fg={theme.text}>
              <span style={{ fg: theme.accent }}>$</span> {props.input.command}
            </text>
            <Show when={output()}>
              <text fg={theme.textMuted}>{limited()}</text>
            </Show>
            <Show when={overflow()}>
              <text fg={theme.textMuted}>
                {expanded() ? locale.t("tool.misc.collapse") : locale.t("tool.misc.expand")}
              </text>
            </Show>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="$" pending={locale.t("tool.pending.bash")} complete={props.input.command} part={props.part}>
          {props.input.command}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Write(props: ToolProps<"write">) {
  const { theme, syntax } = useTheme()
  const locale = useLocale()
  const code = createMemo(() => {
    if (!props.input.content) return ""
    return props.input.content
  })

  const diagnostics = createMemo(() => {
    const filePath = Filesystem.normalizePath(props.input.filePath ?? "")
    return props.metadata.diagnostics?.[filePath] ?? []
  })

  return (
    <Switch>
      <Match when={props.metadata.diagnostics !== undefined}>
        <BlockTool
          title={`# ${locale.t("tool.block.write", { path: normalizePath(props.input.filePath!) })}`}
          part={props.part}
        >
          <line_number fg={theme.textMuted} minWidth={3} paddingRight={1}>
            <code
              conceal={false}
              fg={theme.text}
              filetype={filetype(props.input.filePath!)}
              syntaxStyle={syntax()}
              content={code()}
            />
          </line_number>
          <Show when={diagnostics().length}>
            <For each={diagnostics()}>
              {(diagnostic) => (
                <text fg={theme.error}>
                  Error [{diagnostic.range.start.line}:{diagnostic.range.start.character}]: {diagnostic.message}
                </text>
              )}
            </For>
          </Show>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending={locale.t("tool.pending.write")} complete={props.input.filePath} part={props.part}>
          {locale.t("tool.name.write")} {normalizePath(props.input.filePath!)}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Glob(props: ToolProps<"glob">) {
  const locale = useLocale()
  return (
    <InlineTool icon="✱" pending={locale.t("tool.pending.glob")} complete={props.input.pattern} part={props.part}>
      {locale.t("tool.name.glob")} "{props.input.pattern}"
      <Show when={props.input.path}>
        {" "}
        {locale.t("tool.misc.in")} {normalizePath(props.input.path)}{" "}
      </Show>
      <Show when={props.metadata.count}>({locale.t("tool.misc.matches", { count: props.metadata.count })})</Show>
    </InlineTool>
  )
}

function Read(props: ToolProps<"read">) {
  const { theme } = useTheme()
  const locale = useLocale()
  const loaded = createMemo(() => {
    if (props.part.state.status !== "completed") return []
    if (props.part.state.time.compacted) return []
    const value = props.metadata.loaded
    if (!value || !Array.isArray(value)) return []
    return value.filter((p): p is string => typeof p === "string")
  })
  return (
    <>
      <InlineTool icon="→" pending={locale.t("tool.pending.read")} complete={props.input.filePath} part={props.part}>
        {locale.t("tool.name.read")} {normalizePath(props.input.filePath!)} {input(props.input, ["filePath"])}
      </InlineTool>
      <For each={loaded()}>
        {(filepath) => (
          <box paddingLeft={3}>
            <text paddingLeft={3} fg={theme.textMuted}>
              ↳ {locale.t("tool.misc.loaded", { path: normalizePath(filepath) })}
            </text>
          </box>
        )}
      </For>
    </>
  )
}

function Grep(props: ToolProps<"grep">) {
  const locale = useLocale()
  return (
    <InlineTool icon="✱" pending={locale.t("tool.pending.grep")} complete={props.input.pattern} part={props.part}>
      {locale.t("tool.name.grep")} "{props.input.pattern}"
      <Show when={props.input.path}>
        {" "}
        {locale.t("tool.misc.in")} {normalizePath(props.input.path)}{" "}
      </Show>
      <Show when={props.metadata.matches}>({locale.t("tool.misc.matches", { count: props.metadata.matches })})</Show>
    </InlineTool>
  )
}

function List(props: ToolProps<"ls">) {
  const locale = useLocale()
  const dir = createMemo(() => {
    if (props.input.path) {
      return normalizePath(props.input.path)
    }
    return ""
  })
  return (
    <InlineTool
      icon="→"
      pending={locale.t("tool.pending.list")}
      complete={props.input.path !== undefined}
      part={props.part}
    >
      {locale.t("tool.name.list")} {dir()}
    </InlineTool>
  )
}

function WebFetch(props: ToolProps<"webfetch">) {
  const locale = useLocale()
  return (
    <InlineTool
      icon="%"
      pending={locale.t("tool.pending.webfetch")}
      complete={(props.input as any).url}
      part={props.part}
    >
      {locale.t("tool.name.webfetch")} {(props.input as any).url}
    </InlineTool>
  )
}

function CodeSearch(props: ToolProps<any>) {
  const locale = useLocale()
  const input = props.input as any
  const metadata = props.metadata as any
  return (
    <InlineTool icon="◇" pending={locale.t("tool.pending.codesearch")} complete={input.query} part={props.part}>
      {locale.t("tool.name.codesearch")} "{input.query}"
      <Show when={metadata.results}>({locale.t("tool.misc.results", { count: metadata.results })})</Show>
    </InlineTool>
  )
}

function WebSearch(props: ToolProps<any>) {
  const locale = useLocale()
  const input = props.input as any
  const metadata = props.metadata as any
  return (
    <InlineTool icon="◈" pending={locale.t("tool.pending.websearch")} complete={input.query} part={props.part}>
      {locale.t("tool.name.websearch")} "{input.query}"
      <Show when={metadata.numResults}>({locale.t("tool.misc.results", { count: metadata.numResults })})</Show>
    </InlineTool>
  )
}

const SUBAGENT_MAX_HEIGHT = 20

function SubAgentMessageView(props: { message: UserMessage | AssistantMessage; parts: Part[] }) {
  const { theme } = useTheme()
  const local = useLocal()

  return (
    <box flexDirection="column" gap={0} paddingLeft={1} marginTop={1}>
      <Show when={props.message.role === "user"}>
        <box flexShrink={0}>
          <text fg={theme.text}>
            <span style={{ fg: local.agent.color(props.message.agent ?? ""), bold: true }}>▎ </span>
            {(props.parts.find((p) => p.type === "text" && !("synthetic" in p && p.synthetic)) as TextPart | undefined)
              ?.text ?? ""}
          </text>
        </box>
      </Show>
      <Show when={props.message.role === "assistant"}>
        <For each={props.parts}>
          {(part, index) => {
            const component = createMemo(() => PART_MAPPING[part.type as keyof typeof PART_MAPPING])
            return (
              <Show when={component()}>
                <Dynamic
                  last={index() === props.parts.length - 1}
                  component={component()}
                  part={part as any}
                  message={props.message as AssistantMessage}
                />
              </Show>
            )
          }}
        </For>
      </Show>
    </box>
  )
}

function createSessionDisclosure(sessionID: () => string | undefined) {
  const sync = useSync()
  const disclosure = createSubsessionDisclosure({
    sessionID,
    ensure: (id) => sync.session.ensureMessages(id),
    onError: (error, id) =>
      Log.Product.warn("failed to load nested session messages", {
        sessionID: id,
        error: error instanceof Error ? error.message : String(error),
      }),
  })
  const state = createMemo(() => {
    const id = sessionID()
    return id ? sync.session.messageLoadState(id) : ({ status: "idle" } as const)
  })
  return { ...disclosure, state }
}

function SubsessionDetails(props: {
  id: string
  sessionID: string
  expanded: boolean
  state: SessionMessageLoadState
  expand: string
  collapse: string
  borderColor: RGBA
  onToggle(): void
  onRetry(): void
}) {
  const sync = useSync()
  const locale = useLocale()
  const { theme } = useTheme()
  const messages = createMemo(() => sync.data.message[props.sessionID] ?? [])

  return (
    <SubsessionDisclosure
      id={props.id}
      expanded={props.expanded}
      state={props.state}
      hasContent={messages().length > 0}
      labels={{
        expand: props.expand,
        collapse: props.collapse,
        loading: locale.t("tool.misc.subsession.loading"),
        empty: locale.t("tool.misc.subsession.empty"),
        failed: locale.t("tool.misc.subsession.loadFailed"),
        retry: locale.t("tool.misc.subsession.retry"),
      }}
      colors={{
        text: theme.text,
        muted: theme.textMuted,
        error: theme.error,
        action: theme.primary,
      }}
      onToggle={props.onToggle}
      onRetry={props.onRetry}
    >
      <scrollbox
        onMouseScroll={handleNestedVerticalScroll}
        maxHeight={SUBAGENT_MAX_HEIGHT}
        border={["left"]}
        paddingLeft={2}
        customBorderChars={{ ...EmptyBorder, vertical: "┃" }}
        borderColor={props.borderColor}
        scrollbarOptions={{ visible: true }}
      >
        <For each={messages()}>
          {(message) => (
            <SubAgentMessageView
              message={message as UserMessage | AssistantMessage}
              parts={sync.data.part[message.id] ?? []}
            />
          )}
        </For>
      </scrollbox>
    </SubsessionDisclosure>
  )
}

function SubAgent(props: ToolProps<"subagent">) {
  const { theme } = useTheme()
  const local = useLocal()
  const sync = useSync()
  const locale = useLocale()

  // Subagent phase, which drives the title prefix:
  // - queued / executing: from metadata.phase, pushed by subagent-scheduler before/after acquiring the semaphore
  // - completed: inferred from part.state.status === "completed", which takes precedence over the phase
  // - other states (pending, error, etc.) use the default prefix
  const rawPhase = createMemo(() => props.metadata.phase as "queued" | "executing" | undefined)
  const displayPhase = createMemo<"queued" | "executing" | "completed" | undefined>(() => {
    if (props.part.state.status === "completed") return "completed"
    return rawPhase()
  })
  const phasePrefix = createMemo(() => {
    const p = displayPhase()
    if (p === "queued") return "⏳ "
    if (p === "executing") return "▶ "
    if (p === "completed") return "✓ "
    return "# "
  })

  const childSessionID = () => {
    const id = props.metadata.sessionId
    return typeof id === "string" && id ? id : undefined
  }
  const details = createSessionDisclosure(childSessionID)
  const agentColor = createMemo(() => local.agent.color(props.input.subagent_type ?? "general"))

  const tools = createMemo(() => {
    const sessionID = childSessionID()
    const msgs = sync.data.message[sessionID ?? ""] ?? []
    return msgs.flatMap((msg) =>
      (sync.data.part[msg.id] ?? [])
        .filter((part): part is ToolPart => part.type === "tool")
        .map((part) => ({ tool: part.tool, state: part.state })),
    )
  })

  const current = createMemo(() => tools().findLast((x) => x.state.status !== "pending"))

  const isRunning = createMemo(() => props.part.state.status === "running")

  return (
    <Switch>
      <Match when={props.input.description || props.input.subagent_type}>
        <BlockTool
          title={
            phasePrefix() +
            locale.t("tool.block.subagent", { type: Locale.titlecase(props.input.subagent_type ?? "unknown") })
          }
          part={props.part}
          spinner={isRunning()}
        >
          <box flexDirection="column" gap={1}>
            <text style={{ fg: theme.textMuted }}>
              {props.input.description}
              <Show when={tools().length > 0 || details.state().status === "loaded"}>
                {" ("}
                {locale.t("tool.misc.toolCalls", { count: tools().length })}
                {")"}
              </Show>
            </text>
            <Show when={current()}>
              {(item) => {
                const title = item().state.status === "completed" ? (item().state as any).title : ""
                return (
                  <text style={{ fg: item().state.status === "error" ? theme.error : theme.textMuted }}>
                    └ {Locale.titlecase(item().tool)} {title}
                  </text>
                )
              }}
            </Show>
            <Show when={childSessionID()}>
              {(sessionID) => (
                <SubsessionDetails
                  id={`subagent-${props.part.id}`}
                  sessionID={sessionID()}
                  expanded={details.expanded()}
                  state={details.state()}
                  expand={locale.t("tool.misc.subagent.expand")}
                  collapse={locale.t("tool.misc.subagent.collapse")}
                  borderColor={agentColor()}
                  onToggle={details.toggle}
                  onRetry={details.retry}
                />
              )}
            </Show>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool
          icon="#"
          pending={locale.t("tool.pending.subagent")}
          complete={props.input.subagent_type}
          part={props.part}
        >
          {props.input.subagent_type} {locale.t("tool.name.subagent")} {props.input.description}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function WorkflowRun(props: ToolProps<any>) {
  const { theme } = useTheme()
  const status = createMemo(() => props.metadata.status as string | undefined)
  const isError = createMemo(() => props.part.state.status === "error")
  const error = createMemo(() =>
    props.part.state.status === "error" ? props.part.state.error : (props.metadata.error as string | undefined),
  )

  return (
    <Show when={isError() || status() === "failed" || error()}>
      <box flexDirection="column" marginTop={1} gap={0}>
        <box flexDirection="row" gap={1}>
          <text fg={theme.error}>Workflow failed</text>
          <text fg={theme.textMuted}>/workflow</text>
        </box>
        <Show when={error()}>
          <text paddingLeft={2} fg={theme.error}>
            {error()}
          </text>
        </Show>
      </box>
    </Show>
  )
}

function Edit(props: ToolProps<"edit">) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const locale = useLocale()

  const view = createMemo(() => {
    const diffStyle = ctx.sync.data.config.tui?.diff_style
    if (diffStyle === "stacked") return "unified"
    // Default to "auto" behavior
    return ctx.width > 120 ? "split" : "unified"
  })

  const ft = createMemo(() => filetype(props.input.filePath))

  const diffContent = createMemo(() => props.metadata.diff)

  const diagnostics = createMemo(() => {
    const filePath = Filesystem.normalizePath(props.input.filePath ?? "")
    const arr = props.metadata.diagnostics?.[filePath] ?? []
    return arr.filter((x) => x.severity === 1).slice(0, 3)
  })

  return (
    <Switch>
      <Match when={props.metadata.diff !== undefined}>
        <BlockTool
          title={`← ${locale.t("tool.block.edit", { path: normalizePath(props.input.filePath!) })}`}
          part={props.part}
        >
          <box paddingLeft={1}>
            <diff
              diff={diffContent()}
              view={view()}
              filetype={ft()}
              syntaxStyle={syntax()}
              showLineNumbers={true}
              width="100%"
              wrapMode={ctx.diffWrapMode()}
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
          </box>
          <Show when={diagnostics().length}>
            <box>
              <For each={diagnostics()}>
                {(diagnostic) => (
                  <text fg={theme.error}>
                    Error [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}]{" "}
                    {diagnostic.message}
                  </text>
                )}
              </For>
            </box>
          </Show>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending={locale.t("tool.pending.edit")} complete={props.input.filePath} part={props.part}>
          {locale.t("tool.name.edit")} {normalizePath(props.input.filePath!)}{" "}
          {input({ replaceAll: props.input.replaceAll })}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function MultiEdit(props: ToolProps<"multi_edit">) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const locale = useLocale()

  const view = createMemo(() => {
    const diffStyle = ctx.sync.data.config.tui?.diff_style
    if (diffStyle === "stacked") return "unified"
    return ctx.width > 120 ? "split" : "unified"
  })

  const ft = createMemo(() => filetype(props.input.filePath))
  const diffContent = createMemo(() => props.metadata.diff)

  const diagnostics = createMemo(() => {
    const filePath = Filesystem.normalizePath(props.input.filePath ?? "")
    const arr = props.metadata.diagnostics?.[filePath] ?? []
    return arr.filter((x: any) => x.severity === 1).slice(0, 3)
  })

  return (
    <Switch>
      <Match when={props.metadata.diff !== undefined}>
        <BlockTool
          title={`← ${locale.t("tool.block.edit", { path: normalizePath(props.input.filePath!) })}`}
          part={props.part}
        >
          <box paddingLeft={1}>
            <diff
              diff={diffContent()}
              view={view()}
              filetype={ft()}
              syntaxStyle={syntax()}
              showLineNumbers={true}
              width="100%"
              wrapMode={ctx.diffWrapMode()}
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
          </box>
          <Show when={diagnostics().length}>
            <box>
              <For each={diagnostics()}>
                {(diagnostic: any) => (
                  <text fg={theme.error}>
                    Error [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}]{" "}
                    {diagnostic.message}
                  </text>
                )}
              </For>
            </box>
          </Show>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending={locale.t("tool.pending.edit")} complete={props.input.filePath} part={props.part}>
          {locale.t("tool.name.edit")} {normalizePath(props.input.filePath!)} [
          {locale.t("tool.misc.multiEditCount", { count: props.input.edits?.length ?? 0 })}]
        </InlineTool>
      </Match>
    </Switch>
  )
}

function TodoWrite(props: ToolProps<"todowrite">) {
  const locale = useLocale()
  return (
    <Switch>
      <Match when={props.metadata.todos?.length}>
        <BlockTool title={`# ${locale.t("tool.block.todowrite")}`} part={props.part}>
          <box>
            <For each={props.input.todos ?? []}>
              {(todo) => <TodoItem status={todo.status} content={todo.content} />}
            </For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="⚙" pending={locale.t("tool.pending.todowrite")} complete={false} part={props.part}>
          {locale.t("tool.pending.todowrite")}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Question(props: ToolProps<"question">) {
  const { theme } = useTheme()
  const locale = useLocale()
  const count = createMemo(() => props.input.questions?.length ?? 0)

  function format(answer?: string[]) {
    if (!answer?.length) return locale.t("tool.misc.question.unanswered")
    return answer.join(", ")
  }

  return (
    <Switch>
      <Match when={props.metadata.answers}>
        <BlockTool title={`# ${locale.t("tool.block.question")}`} part={props.part}>
          <box gap={1}>
            <For each={props.input.questions ?? []}>
              {(q, i) => (
                <box flexDirection="column">
                  <text fg={theme.textMuted}>{q.question}</text>
                  <text fg={theme.text}>{format(props.metadata.answers?.[i()])}</text>
                </box>
              )}
            </For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="→" pending={locale.t("tool.pending.question")} complete={count()} part={props.part}>
          {locale.t("tool.misc.question.asked", { count: count() })}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function RuleFetch(props: ToolProps<"rule">) {
  const locale = useLocale()
  const complete = createMemo(() => props.part.state.status !== "pending" && props.part.state.status !== "running")
  const title = createMemo(() => {
    const name = typeof props.input.name === "string" ? props.input.name.trim() : ""
    if (name) return locale.t("tool.misc.ruleLine", { name })
    const filepath = typeof props.input.filepath === "string" ? props.input.filepath.trim() : ""
    if (filepath) return locale.t("tool.misc.ruleLine", { name: path.basename(filepath) })
    return locale.t("tool.name.rule")
  })

  return (
    <InlineTool
      icon="⚙"
      pending={locale.t("tool.pending.rule")}
      complete={complete()}
      part={props.part}
      displayName={locale.t("tool.name.rule")}
    >
      {title()}
    </InlineTool>
  )
}

function Skill(props: ToolProps<"skill">) {
  const locale = useLocale()
  const complete = createMemo(() => props.part.state.status !== "pending" && props.part.state.status !== "running")
  const title = createMemo(() => {
    if (props.input.name) return locale.t("tool.misc.skillLine", { name: props.input.name })
    if (props.input.query) return locale.t("tool.misc.skillSearch", { query: props.input.query })
    return locale.t("tool.misc.skillList")
  })

  return (
    <InlineTool icon="→" pending={locale.t("tool.pending.skill")} complete={complete()} part={props.part}>
      {title()}
      <Show when={props.metadata.matched !== undefined}>
        {" "}
        ({locale.t("tool.misc.results", { count: props.metadata.matched })})
      </Show>
    </InlineTool>
  )
}

// Must match normalizePath in permission.tsx: relative paths are resolved against process.cwd() and fall back to ~ or
// an absolute path outside cwd, so tool cards and permission prompts show the same string.
function normalizePath(input?: string) {
  if (!input) return ""
  const cwd = process.cwd()
  const home = Paths.home
  const absolute = path.isAbsolute(input) ? input : path.resolve(cwd, input)
  const relative = path.relative(cwd, absolute)
  if (!relative) return "."
  if (!relative.startsWith("..")) return relative
  if (home && (absolute === home || absolute.startsWith(home + path.sep))) {
    return absolute.replace(home, "~")
  }
  return absolute
}

function input(input: Record<string, any>, omit?: string[]): string {
  const primitives = Object.entries(input).filter(([key, value]) => {
    if (omit?.includes(key)) return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  if (primitives.length === 0) return ""
  return `[${primitives.map(([key, value]) => `${key}=${value}`).join(", ")}]`
}

function filetype(input?: string) {
  if (!input) return "none"
  const ext = path.extname(input)
  const language = LANGUAGE_EXTENSIONS[ext]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}
