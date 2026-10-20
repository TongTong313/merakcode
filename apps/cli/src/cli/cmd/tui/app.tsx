import { render, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { Clipboard } from "./util/clipboard"
import { Selection } from "./util/selection"
import { CliRenderEvents, createCliRenderer, MouseButton, TextAttributes } from "@opentui/core"
import { RouteProvider, useRoute } from "./context/route"
import { Switch, Match, createEffect, ErrorBoundary, createSignal, onMount, batch } from "solid-js"
import { DialogProvider, useDialog } from "./ui/dialog"
import { DialogProvider as DialogProviderList } from "./component/dialog-provider"
import { SDKProvider, useSDK } from "./context/sdk"
import { ProjectProvider } from "./context/project"
import { SyncProvider, useSync } from "./context/sync"
import { LocalProvider, useLocal } from "./context/local"
import { DialogModel, useConnected } from "./component/dialog-model"
import { DialogMcp } from "./component/dialog-mcp"
import { DialogPermissions } from "./component/dialog-permissions"
import { DialogStatus } from "./component/dialog-status"
import { DialogPlugins } from "./component/dialog-plugins"
import { DialogThemeList } from "./component/dialog-theme-list"
import { DialogLanguage } from "./component/dialog-language"
import { DialogHelp } from "./ui/dialog-help"
import { DialogTips } from "./ui/dialog-tips"
import { DialogKeys } from "./ui/dialog-keys"
import { CommandProvider, useCommandDialog } from "./component/dialog-command"
import { DialogAgent } from "./component/dialog-agent"
import { DialogWorkflow } from "./component/dialog-workflow"
import { DialogSkills } from "./component/dialog-skills"

import { DialogSessionList } from "./component/dialog-session-list"
import { KeybindProvider } from "./context/keybind"
import { ThemeProvider, useTheme } from "./context/theme"
import { Session } from "./routes/session"
import { DiffViewer } from "./routes/diff"
import { PromptHistoryProvider } from "./component/prompt/history"
import { FrecencyProvider } from "./component/prompt/frecency"
import { PromptStashProvider } from "./component/prompt/stash"
import { DialogPrompt } from "./ui/dialog-prompt"
import { ToastProvider, useToast } from "./ui/toast"
import { ExitProvider, useExit } from "./context/exit"
import { useEvent } from "./context/event"
import { errorCode, isMessageAbortedError, localizeError, localizeToast } from "@merakcode/util/error"
import { KVProvider, useKV } from "./context/kv"
import { ArgsProvider, useArgs, type Args } from "./context/args"
import open from "open"
import { writeHeapSnapshot } from "v8"
import { PromptRefProvider, usePromptRef } from "./context/prompt"
import { LocaleProvider, useLocale } from "./context/locale"
import { reconcile } from "solid-js/store"
import { destroyRenderer } from "./util/renderer"
import { Log } from "@merakcode/log/logger"
import { TuiStartupDiagnostics } from "./startup-diagnostics"
import { Project } from "@merakcode/util/project"
import { I18n } from "../../i18n"

const renderLog = Log.create({ source: "product", service: "tui.render" })

function safeStdin(stdin: NodeJS.ReadStream): NodeJS.ReadStream {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") return stdin

  return new Proxy(stdin, {
    get(target, prop, receiver) {
      if (prop === "setRawMode") {
        return (mode: boolean) => {
          try {
            return target.setRawMode?.(mode)
          } catch {
            return target
          }
        }
      }

      const value = Reflect.get(target, prop, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  }) as NodeJS.ReadStream
}

async function getTerminalBackgroundColor(): Promise<"dark" | "light"> {
  // can't set raw mode if not a TTY
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") return "dark"

  return new Promise((resolve) => {
    let timeout: NodeJS.Timeout
    let raw = false

    const cleanup = () => {
      if (raw) {
        try {
          process.stdin.setRawMode(false)
        } catch {
          // fall back to the default theme when raw mode cannot be restored
        }
      }
      process.stdin.removeListener("data", handler)
      clearTimeout(timeout)
    }

    const handler = (data: Buffer) => {
      const str = data.toString()
      const match = str.match(/\x1b]11;([^\x07\x1b]+)/)
      if (match) {
        cleanup()
        const color = match[1]
        // Parse RGB values from color string
        // Formats: rgb:RR/GG/BB or #RRGGBB or rgb(R,G,B)
        let r = 0,
          g = 0,
          b = 0

        if (color.startsWith("rgb:")) {
          const parts = color.substring(4).split("/")
          r = parseInt(parts[0], 16) >> 8 // Convert 16-bit to 8-bit
          g = parseInt(parts[1], 16) >> 8 // Convert 16-bit to 8-bit
          b = parseInt(parts[2], 16) >> 8 // Convert 16-bit to 8-bit
        } else if (color.startsWith("#")) {
          r = parseInt(color.substring(1, 3), 16)
          g = parseInt(color.substring(3, 5), 16)
          b = parseInt(color.substring(5, 7), 16)
        } else if (color.startsWith("rgb(")) {
          const parts = color.substring(4, color.length - 1).split(",")
          r = parseInt(parts[0])
          g = parseInt(parts[1])
          b = parseInt(parts[2])
        }

        // Calculate luminance using relative luminance formula
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255

        // Determine if dark or light based on luminance threshold
        resolve(luminance > 0.5 ? "light" : "dark")
      }
    }

    try {
      process.stdin.setRawMode(true)
      raw = true
    } catch {
      resolve("dark")
      return
    }
    process.stdin.on("data", handler)
    process.stdout.write("\x1b]11;?\x07")

    timeout = setTimeout(() => {
      cleanup()
      resolve("dark")
    }, 1000)
  })
}

import type { EventSource } from "./context/sdk"
import { Filesystem } from "@merakcode/util/filesystem"
import { parseModel } from "@merakcode/util/model"
import { SessionTitle } from "@merakcode/util/session-title"
import { VERSION } from "../../../product-version"
import { TuiFlags } from "./flags"

export async function tui(input: {
  url: string
  args: Args
  directory?: string
  fetch?: typeof fetch
  headers?: RequestInit["headers"]
  events?: EventSource
  /** Result of the background upgrade check (new version available or already installed), shown once the UI is up. */
  update?: Promise<{ version: string; installed: boolean } | undefined>
  onExit?: () => Promise<void>
}) {
  const started = Date.now()
  const checkpoint = (stage: string, extra: Record<string, unknown> = {}) =>
    renderLog.info("checkpoint", { stage, elapsed: Date.now() - started, ...extra })

  checkpoint("render.started", TuiStartupDiagnostics.environment(input.directory))

  const backgroundStarted = Date.now()
  checkpoint("terminal-background.started")
  let backgroundDetected = false
  const backgroundWarning = setTimeout(() => {
    if (backgroundDetected) return
    renderLog.warn("startup stalled", {
      stage: "terminal-background",
      elapsed: Date.now() - started,
      waiting: Date.now() - backgroundStarted,
    })
  }, 5_000)
  const mode = await getTerminalBackgroundColor()
  backgroundDetected = true
  clearTimeout(backgroundWarning)
  checkpoint("terminal-background.completed", { duration: Date.now() - backgroundStarted, mode })

  const rendererStarted = Date.now()
  checkpoint("renderer.create.started")
  let rendererCreated = false
  const rendererWarning = setTimeout(() => {
    if (rendererCreated) return
    renderLog.warn("startup stalled", {
      stage: "renderer.create",
      elapsed: Date.now() - started,
      waiting: Date.now() - rendererStarted,
    })
  }, 5_000)
  const renderer = await createCliRenderer({
    stdin: safeStdin(process.stdin),
    externalOutputMode: "passthrough",
    targetFps: 60,
    gatherStats: false,
    exitOnCtrlC: false,
    useKittyKeyboard: {},
    autoFocus: false,
    openConsoleOnError: false,
    consoleOptions: {
      keyBindings: [{ name: "y", ctrl: true, action: "copy-selection" }],
      onCopySelection: (text) => {
        Clipboard.copy(text).catch((error) => {
          console.error(`Failed to copy console selection to clipboard: ${error}`)
        })
      },
    },
  })
  rendererCreated = true
  clearTimeout(rendererWarning)
  checkpoint("renderer.create.completed", {
    duration: Date.now() - rendererStarted,
    width: renderer.terminalWidth,
    height: renderer.terminalHeight,
  })

  let frames = 0
  let sampledFrames = 0
  let contentFrame = false
  let lastFrame: ReturnType<typeof TuiStartupDiagnostics.frame> | undefined
  const frameStarted = Date.now()
  let sampledAt = 0
  const onFrame = () => {
    frames++
    const now = Date.now()
    if (sampledAt && now - sampledAt < 250) return
    sampledAt = now
    sampledFrames++
    try {
      lastFrame = TuiStartupDiagnostics.frame(renderer)
    } catch (error) {
      if (frames === 1) {
        renderLog.warn("frame diagnostics failed", {
          stage: "renderer.first-frame",
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return
    }
    if (frames === 1) checkpoint("renderer.first-frame", lastFrame)
    if (contentFrame || lastFrame.visibleCharacters === 0) return
    contentFrame = true
    clearTimeout(frameWarning)
    clearTimeout(frameError)
    renderer.off(CliRenderEvents.FRAME, onFrame)
    checkpoint("renderer.first-content-frame", {
      duration: Date.now() - frameStarted,
      frames,
      sampledFrames,
      ...lastFrame,
    })
  }
  renderer.on(CliRenderEvents.FRAME, onFrame)
  const frameWarning = setTimeout(() => {
    if (contentFrame) return
    renderLog.warn("startup stalled", {
      stage: "renderer.first-content-frame",
      elapsed: Date.now() - started,
      waiting: Date.now() - frameStarted,
      frames,
      sampledFrames,
      lastFrame,
    })
  }, 5_000)
  const frameError = setTimeout(() => {
    if (contentFrame) return
    renderLog.error("possible white screen", {
      stage: "renderer.first-content-frame",
      elapsed: Date.now() - started,
      waiting: Date.now() - frameStarted,
      frames,
      sampledFrames,
      lastFrame,
    })
    renderer.off(CliRenderEvents.FRAME, onFrame)
  }, 15_000)

  let resolveExit: () => void
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve
  })
  let closing: Promise<void> | undefined
  const onExit = () => {
    if (closing) return closing

    closing = (async () => {
      try {
        clearTimeout(rendererWarning)
        clearTimeout(backgroundWarning)
        clearTimeout(frameWarning)
        clearTimeout(frameError)
        renderer.off(CliRenderEvents.FRAME, onFrame)
        checkpoint("renderer.destroy.started", { frames, sampledFrames, contentFrame })
        destroyRenderer(renderer)
        await input.onExit?.()
      } finally {
        checkpoint("renderer.destroy.completed")
        resolveExit()
      }
    })()
    return closing
  }
  renderer.once("destroy", () => {
    void onExit()
  })

  try {
    checkpoint("solid.mount.started")
    await render(() => {
      return (
        <ErrorBoundary
          fallback={(error, reset) => {
            renderLog.error("component error", {
              stage: "solid.error-boundary",
              error: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            })
            return <ErrorComponent error={error} reset={reset} onExit={onExit} mode={mode} />
          }}
        >
          <ArgsProvider {...input.args}>
            <ExitProvider onExit={onExit}>
              <KVProvider>
                <ToastProvider>
                  <RouteProvider>
                    <SDKProvider
                      url={input.url}
                      directory={input.directory}
                      fetch={input.fetch}
                      headers={input.headers}
                      events={input.events}
                    >
                      <ProjectProvider>
                        <SyncProvider>
                          <ThemeProvider mode={mode}>
                            <LocaleProvider>
                              <LocalProvider>
                                <KeybindProvider>
                                  <PromptStashProvider>
                                    <DialogProvider>
                                      <CommandProvider>
                                        <FrecencyProvider>
                                          <PromptHistoryProvider>
                                            <PromptRefProvider>
                                              <App update={input.update} />
                                            </PromptRefProvider>
                                          </PromptHistoryProvider>
                                        </FrecencyProvider>
                                      </CommandProvider>
                                    </DialogProvider>
                                  </PromptStashProvider>
                                </KeybindProvider>
                              </LocalProvider>
                            </LocaleProvider>
                          </ThemeProvider>
                        </SyncProvider>
                      </ProjectProvider>
                    </SDKProvider>
                  </RouteProvider>
                </ToastProvider>
              </KVProvider>
            </ExitProvider>
          </ArgsProvider>
        </ErrorBoundary>
      )
    }, renderer)
    checkpoint("solid.mount.completed")
    await exited
  } catch (error) {
    renderLog.error("render failed", {
      stage: "render.failed",
      elapsed: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    })
    await onExit().catch(() => undefined)
    throw error
  }
}

function App(props: { update?: Promise<{ version: string; installed: boolean } | undefined> }) {
  const route = useRoute()
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  const dialog = useDialog()
  const local = useLocal()
  const kv = useKV()
  const command = useCommandDialog()
  const sdk = useSDK()
  const toast = useToast()
  const { theme, mode, setMode } = useTheme()
  const sync = useSync()
  const exit = useExit()
  const promptRef = usePromptRef()
  const locale = useLocale()
  const event = useEvent()

  useKeyboard((evt) => {
    if (!TuiFlags.copyOnSelectDisabled) return
    if (!renderer.getSelection()) return

    // Windows Terminal-like behavior:
    // - Ctrl+C copies and dismisses selection
    // - Esc dismisses selection
    // - Most other key input dismisses selection and is passed through
    if (evt.ctrl && evt.name === "c") {
      if (!Selection.copy(renderer, toast)) {
        renderer.clearSelection()
        return
      }

      evt.preventDefault()
      evt.stopPropagation()
      return
    }

    if (evt.name === "escape") {
      renderer.clearSelection()
      evt.preventDefault()
      evt.stopPropagation()
      return
    }

    renderer.clearSelection()
  })

  // Wire up console copy-to-clipboard via opentui's onCopySelection callback
  renderer.console.onCopySelection = async (text: string) => {
    if (!text || text.length === 0) return

    await Clipboard.copy(text)
      .then(() => toast.show({ message: locale.t("common.copied"), variant: "info" }))
      .catch(toast.error)

    renderer.clearSelection()
  }
  const [terminalTitleEnabled, setTerminalTitleEnabled] = createSignal(kv.get("terminal_title_enabled", true))

  // Update terminal window title based on current route and session
  createEffect(() => {
    if (!terminalTitleEnabled() || TuiFlags.terminalTitleDisabled) return

    if (route.data.type === "home") {
      renderer.setTerminalTitle("MerakCode")
      return
    }

    if (route.data.type === "diff") {
      renderer.setTerminalTitle("MerakCode | Diff")
      return
    }

    if (route.data.type === "session") {
      const session = sync.session.get(route.data.sessionID)
      if (!session || SessionTitle.isDefault(session.title)) {
        renderer.setTerminalTitle("MerakCode")
        return
      }

      // Truncate title to 40 chars max
      const title = session.title.length > 40 ? session.title.slice(0, 37) + "..." : session.title
      renderer.setTerminalTitle(`MC | ${title}`)
    }
  })

  const args = useArgs()
  onMount(() => {
    renderLog.info("checkpoint", {
      stage: "app.mounted",
      route: route.data.type,
      sync: sync.status,
      dimensions: dimensions(),
    })
    batch(() => {
      if (args.agent) local.agent.set(args.agent)
      if (args.model) {
        const { providerID, modelID } = parseModel(args.model)
        if (!providerID || !modelID)
          return toast.show({
            variant: "warning",
            message: locale.t("error.invalidModelFormat", { model: args.model }),
            duration: 3000,
          })
        local.model.set({ providerID, modelID }, { recent: true })
      }
      // Handle --session without --fork immediately (fork is handled in createEffect below)
      if (args.sessionID && !args.fork) {
        route.navigate({
          type: "session",
          sessionID: args.sessionID,
        })
      }
    })
  })

  let continued = false
  createEffect(() => {
    // When using -c, session list is loaded in blocking phase, so we can navigate at "partial"
    if (continued || sync.status === "loading" || !args.continue) return
    const match = sync.data.session
      .toSorted((a, b) => b.time.updated - a.time.updated)
      .find((x) => x.parentID === undefined)?.id
    if (match) {
      continued = true
      if (args.fork) {
        sdk.client.session.fork({ sessionID: match }).then((result) => {
          if (result.data?.id) {
            route.navigate({ type: "session", sessionID: result.data.id })
          } else {
            toast.show({ message: locale.t("error.forkFailed"), variant: "error" })
          }
        })
      } else {
        route.navigate({ type: "session", sessionID: match })
      }
    }
  })

  // Handle --session with --fork: wait for sync to be fully complete before forking
  // (session list loads in non-blocking phase for --session, so we must wait for "complete"
  // to avoid a race where reconcile overwrites the newly forked session)
  let forked = false
  createEffect(() => {
    if (forked || sync.status !== "complete" || !args.sessionID || !args.fork) return
    forked = true
    sdk.client.session.fork({ sessionID: args.sessionID }).then((result) => {
      if (result.data?.id) {
        route.navigate({ type: "session", sessionID: result.data.id })
      } else {
        toast.show({ message: locale.t("error.forkFailed"), variant: "error" })
      }
    })
  })

  const connected = useConnected()

  // Register skill commands from the server.
  command.register(() => {
    return sync.data.command
      .filter((cmd) => cmd.source === "skill")
      .map((cmd) => ({
        title: cmd.description || cmd.name,
        value: `skill.${cmd.name}`,
        category: "Skill",
        slash: { name: cmd.name },
        onSelect: () => {
          promptRef.current?.set({
            input: `/${cmd.name} `,
            parts: [],
          })
          dialog.clear()
        },
      }))
  })

  command.register(() => [
    {
      title: locale.t("diff.open"),
      value: "diff.open",
      category: locale.t("command.category.session"),
      slash: {
        name: "diff",
      },
      onSelect: () => {
        route.navigate({
          type: "diff",
          mode: "git",
          sessionID: route.data.type === "session" ? route.data.sessionID : undefined,
          returnRoute: { ...route.data },
        })
        dialog.clear()
      },
    },
    {
      title: locale.t("session.list"),
      value: "session.list",
      keybind: "session_list",
      category: locale.t("command.category.session"),
      suggested: sync.data.session.length > 0,
      slash: {
        name: "sessions",
        aliases: ["resume", "continue"],
      },
      onSelect: () => {
        dialog.replace(() => <DialogSessionList />)
      },
    },
    {
      title: locale.t("session.new"),
      value: "session.new",
      keybind: "session_new",
      category: locale.t("command.category.session"),
      slash: {
        name: "new",
        aliases: ["clear"],
      },
      onSelect: () => {
        route.navigate({ type: "home" })
        dialog.clear()
        promptRef.current?.reset()
      },
    },
    {
      title: locale.t("session.importRecordFull"),
      value: "session.importFull",
      keybind: "session_import_full",
      category: locale.t("command.category.session"),
      slash: {
        name: "import-full",
      },
      onSelect: async () => {
        try {
          const filepath = await DialogPrompt.show(dialog, locale.t("import.full.filepath"), {
            placeholder: locale.t("import.full.placeholder"),
          })
          if (filepath === null) return
          // Close the dialog first: it is a full-screen overlay drawn above toasts, so error toasts shown later would
          // be hidden behind it.
          dialog.clear()

          const data = await Filesystem.readJson(filepath.trim()).catch(() => undefined)
          if (!data || typeof data !== "object") {
            toast.show({
              message: locale.t("error.invalidImportFile", { reason: locale.t("error.invalidImportFile.unreadable") }),
              variant: "error",
            })
            return
          }
          if (!("info" in data)) {
            toast.show({
              message: locale.t("error.invalidImportFile", { reason: locale.t("error.invalidImportFile.missingInfo") }),
              variant: "error",
            })
            return
          }
          if (!("messages" in data)) {
            toast.show({
              message: locale.t("error.invalidImportFile", {
                reason: locale.t("error.invalidImportFile.missingMessages"),
              }),
              variant: "error",
            })
            return
          }

          const res = await sdk.fetch(new URL("/session/import-full", sdk.baseUrl), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(data),
          })
          if (!res.ok) {
            // Server-side zod validation returns structured field errors; show the first one so the user knows which
            // field is wrong instead of a bare failure.
            let reason = `HTTP ${res.status}`
            const body = await res.json().catch(() => undefined)
            const firstIssue = (body as { error?: Array<{ path?: (string | number)[]; message: string }> } | undefined)
              ?.error?.[0]
            if (firstIssue) {
              reason = firstIssue.path?.length
                ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
                : firstIssue.message
            }
            toast.show({ message: locale.t("error.sessionImportFullFailed", { reason }), variant: "error" })
            return
          }
          const result = (await res.json()) as { info: { id: string } }

          toast.show({ message: locale.t("success.sessionImportedFull"), variant: "success" })
          route.navigate({ type: "session", sessionID: result.info.id })
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          toast.show({ message: locale.t("error.sessionImportFullFailed", { reason }), variant: "error" })
        }
      },
    },
    {
      title: "Workflow",
      description: "Inspect dynamic workflow runs",
      value: "workflow.panel",
      category: locale.t("command.category.session"),
      slash: {
        name: "workflow",
      },
      onSelect: () => {
        dialog.replace(() => <DialogWorkflow />)
      },
    },
    {
      title: locale.t("model.list"),
      value: "model.list",
      keybind: "model_list",
      suggested: true,
      category: locale.t("command.category.agent"),
      slash: {
        name: "models",
      },
      onSelect: () => {
        dialog.replace(() => <DialogModel />)
      },
    },
    {
      title: locale.t("model.list"),
      value: "model.cycle_recent",
      keybind: "model_cycle_recent",
      category: locale.t("command.category.agent"),
      hidden: true,
      onSelect: () => {
        local.model.cycle(1)
      },
    },
    {
      title: locale.t("model.cycleReverse"),
      value: "model.cycle_recent_reverse",
      keybind: "model_cycle_recent_reverse",
      category: locale.t("command.category.agent"),
      hidden: true,
      onSelect: () => {
        local.model.cycle(-1)
      },
    },
    {
      title: locale.t("model.cycleFavorite"),
      value: "model.cycle_favorite",
      keybind: "model_cycle_favorite",
      category: locale.t("command.category.agent"),
      hidden: true,
      onSelect: () => {
        local.model.cycleFavorite(1)
      },
    },
    {
      title: locale.t("model.cycleFavoriteReverse"),
      value: "model.cycle_favorite_reverse",
      keybind: "model_cycle_favorite_reverse",
      category: locale.t("command.category.agent"),
      hidden: true,
      onSelect: () => {
        local.model.cycleFavorite(-1)
      },
    },
    {
      title: locale.t("agent.list"),
      value: "agent.list",
      keybind: "agent_list",
      category: locale.t("command.category.agent"),
      slash: {
        name: "agents",
      },
      onSelect: () => {
        dialog.replace(() => <DialogAgent />)
      },
    },
    {
      title: locale.t("permissions.title"),
      value: "permissions",
      category: locale.t("command.category.agent"),
      slash: {
        name: "permissions",
        aliases: ["sandbox"],
      },
      onSelect: () => {
        dialog.replace(() => (
          <DialogPermissions sessionID={route.data.type === "session" ? route.data.sessionID : undefined} />
        ))
      },
    },
    {
      title: locale.t("mcp.list"),
      value: "mcp.list",
      category: locale.t("command.category.agent"),
      slash: {
        name: "mcps",
      },
      onSelect: () => {
        dialog.replace(() => <DialogMcp />)
      },
    },
    {
      title: locale.t("dialog.status"),
      value: "status.view",
      keybind: "status_view",
      category: locale.t("command.category.system"),
      slash: {
        name: "status",
      },
      onSelect: () => {
        dialog.replace(() => <DialogStatus />)
      },
    },
    {
      title: locale.t("status.plugin.title"),
      value: "plugin.list",
      category: locale.t("command.category.system"),
      slash: {
        name: "plugins",
        aliases: ["plugin"],
      },
      onSelect: () => {
        dialog.replace(() => <DialogPlugins />)
      },
    },
    {
      title: locale.t("agent.list"),
      value: "agent.cycle",
      keybind: "agent_cycle",
      category: locale.t("command.category.agent"),
      hidden: true,
      onSelect: () => {
        local.agent.move(1)
      },
    },
    {
      title: locale.t("model.variantCycle"),
      value: "variant.cycle",
      keybind: "variant_cycle",
      category: locale.t("command.category.agent"),
      hidden: true,
      onSelect: () => {
        local.model.variant.cycle()
      },
    },
    {
      // /thinking toggles thinking for the current model (shows a toast if the model has no toggle).
      title: locale.t("session.toggleThinking"),
      value: "thinking.toggle",
      category: locale.t("command.category.session"),
      slash: {
        name: "thinking",
        aliases: ["toggle-thinking"],
      },
      onSelect: () => {
        if (!local.model.thinking.toggle()) {
          toast.show({
            message: locale.t("error.noThinkingToggle"),
            variant: "warning",
            duration: 3000,
          })
        }
      },
    },
    {
      title: locale.t("keys.permissionModeCycle"),
      value: "permission.mode.cycle",
      keybind: "permission_mode_cycle",
      category: locale.t("command.category.agent"),
      hidden: true,
      onSelect: () => {
        local.permissionMode.cycle()
      },
    },
    {
      title: locale.t("agent.cycleReverse"),
      value: "agent.cycle.reverse",
      keybind: "agent_cycle_reverse",
      category: locale.t("command.category.agent"),
      hidden: true,
      onSelect: () => {
        local.agent.move(-1)
      },
    },
    {
      title: locale.t("provider.connect"),
      value: "provider.connect",
      suggested: !connected(),
      slash: {
        name: "provider",
      },
      onSelect: () => {
        dialog.replace(() => <DialogProviderList />)
      },
      category: locale.t("command.category.system"),
    },
    {
      title: locale.t("app.theme"),
      value: "theme.switch",
      keybind: "theme_list",
      slash: {
        name: "themes",
      },
      onSelect: () => {
        dialog.replace(() => <DialogThemeList />)
      },
      category: locale.t("command.category.system"),
    },
    {
      title: locale.t("app.language"),
      value: "language.switch",
      slash: {
        name: "language",
        aliases: ["lang"],
      },
      onSelect: () => {
        dialog.replace(() => <DialogLanguage />)
      },
      category: locale.t("command.category.system"),
    },
    {
      title: locale.t("app.themeMode"),
      value: "theme.switch_mode",
      onSelect: (dialog) => {
        setMode(mode() === "dark" ? "light" : "dark")
        dialog.clear()
      },
      category: locale.t("command.category.system"),
    },
    {
      title: locale.t("app.help"),
      value: "help.show",
      slash: {
        name: "help",
      },
      onSelect: () => {
        dialog.replace(() => <DialogHelp />)
      },
      category: locale.t("command.category.system"),
    },
    {
      title: locale.t("skills.title"),
      value: "skills.manage",
      slash: {
        name: "skills",
      },
      onSelect: () => {
        dialog.replace(() => <DialogSkills />)
      },
      category: locale.t("command.category.system"),
    },
    {
      title: locale.t("app.tips"),
      value: "tips.show",
      slash: {
        name: "tips",
      },
      onSelect: () => {
        dialog.replace(() => <DialogTips />)
      },
      category: locale.t("command.category.system"),
    },
    {
      title: locale.t("app.keys"),
      value: "keys.show",
      slash: {
        name: "keys",
      },
      onSelect: () => {
        dialog.replace(() => <DialogKeys />)
      },
      category: locale.t("command.category.system"),
    },
    {
      title: locale.t("app.docs"),
      value: "docs.open",
      onSelect: () => {
        open(Project.HOMEPAGE).catch(() => {})
        dialog.clear()
      },
      category: locale.t("command.category.system"),
    },
    {
      title: locale.t("model.refresh"),
      value: "model.refresh",
      slash: {
        name: "refresh-model",
      },
      onSelect: async () => {
        dialog.clear()
        await sdk.client.provider.refresh()
        const [providers, providerList] = await Promise.all([sdk.client.config.providers(), sdk.client.provider.list()])
        if (providers.data) {
          sync.set("provider", reconcile(providers.data.providers))
          sync.set("provider_default", reconcile(providers.data.default))
        }
        if (providerList.data) sync.set("provider_next", reconcile(providerList.data))
        toast.show({ variant: "info", message: locale.t("model.refreshed"), duration: 2000 })
      },
      category: locale.t("command.category.system"),
    },
    {
      title: locale.t("app.exit"),
      value: "app.exit",
      slash: {
        name: "exit",
        aliases: ["quit", "q"],
      },
      onSelect: () => exit(),
      category: locale.t("command.category.system"),
    },
    {
      title: locale.t("app.debug"),
      category: locale.t("command.category.system"),
      value: "app.debug",
      onSelect: (dialog) => {
        renderer.toggleDebugOverlay()
        dialog.clear()
      },
    },
    {
      title: locale.t("app.console"),
      category: locale.t("command.category.system"),
      value: "app.console",
      onSelect: (dialog) => {
        renderer.console.toggle()
        dialog.clear()
      },
    },
    {
      title: locale.t("app.heapSnapshot"),
      category: locale.t("command.category.system"),
      value: "app.heap_snapshot",
      onSelect: (dialog) => {
        const path = writeHeapSnapshot()
        toast.show({
          variant: "info",
          message: locale.t("app.heapSnapshotWritten", { path }),
          duration: 5000,
        })
        dialog.clear()
      },
    },
    {
      title: locale.t("app.suspend"),
      value: "terminal.suspend",
      keybind: "terminal_suspend",
      category: locale.t("command.category.system"),
      hidden: true,
      onSelect: () => {
        process.once("SIGCONT", () => {
          renderer.resume()
        })

        renderer.suspend()
        // pid=0 means send the signal to all processes in the process group
        process.kill(0, "SIGTSTP")
      },
    },
    {
      title: terminalTitleEnabled() ? locale.t("app.terminalTitle.disable") : locale.t("app.terminalTitle.enable"),
      value: "terminal.title.toggle",
      keybind: "terminal_title_toggle",
      category: locale.t("command.category.system"),
      onSelect: (dialog) => {
        setTerminalTitleEnabled((prev) => {
          const next = !prev
          kv.set("terminal_title_enabled", next)
          if (!next) renderer.setTerminalTitle("")
          return next
        })
        dialog.clear()
      },
    },
    {
      title: kv.get("animations_enabled", true)
        ? locale.t("app.animations.disable")
        : locale.t("app.animations.enable"),
      value: "app.toggle.animations",
      category: locale.t("command.category.system"),
      onSelect: (dialog) => {
        kv.set("animations_enabled", !kv.get("animations_enabled", true))
        dialog.clear()
      },
    },
    {
      title:
        kv.get("diff_wrap_mode", "word") === "word"
          ? locale.t("app.diffWrap.disable")
          : locale.t("app.diffWrap.enable"),
      value: "app.toggle.diffwrap",
      category: locale.t("command.category.system"),
      onSelect: (dialog) => {
        const current = kv.get("diff_wrap_mode", "word")
        kv.set("diff_wrap_mode", current === "word" ? "none" : "word")
        dialog.clear()
      },
    },
  ])

  event.on("notify.toast.show", (evt) => {
    const { title, message } = localizeToast(evt.properties, locale.t)
    toast.show({
      title: title || undefined,
      message,
      variant: evt.properties.variant,
      duration: evt.properties.duration,
    })
  })

  event.on("session.deleted", (evt) => {
    if (route.data.type === "session" && route.data.sessionID === evt.properties.info.id) {
      route.navigate({ type: "home" })
      toast.show({
        variant: "info",
        message: locale.t("info.sessionDeleted"),
      })
    }
  })

  event.on("session.error", (evt) => {
    const error = evt.properties.error
    if (isMessageAbortedError(error)) return
    const code = errorCode(error)
    const text = localizeError(error, locale.t)
    const message = code ? `[${code}] ${text}` : text
    toast.show({
      variant: "error",
      message,
      duration: 5000,
    })
  })

  void props.update?.then((update) => {
    if (!update) return
    toast.show({
      variant: "info",
      title: locale.t(update.installed ? "info.updated.title" : "info.updateAvailable.title"),
      message: locale.t(update.installed ? "info.updated.message" : "info.updateAvailable.message", {
        version: update.version,
      }),
      duration: 10000,
    })
  })

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      backgroundColor={theme.background}
      onMouseDown={(evt) => {
        if (!TuiFlags.copyOnSelectDisabled) return
        if (evt.button !== MouseButton.RIGHT) return

        if (!Selection.copy(renderer, toast)) return
        evt.preventDefault()
        evt.stopPropagation()
      }}
      onMouseUp={TuiFlags.copyOnSelectDisabled ? undefined : () => Selection.copy(renderer, toast)}
    >
      <Switch>
        <Match when={route.data.type === "diff"}>
          <DiffViewer />
        </Match>
        <Match when={true}>
          <Session />
        </Match>
      </Switch>
    </box>
  )
}

function ErrorComponent(props: {
  error: Error
  reset: () => void
  onExit: () => Promise<void>
  mode?: "dark" | "light"
}) {
  const term = useTerminalDimensions()
  const renderer = useRenderer()

  const handleExit = async () => {
    destroyRenderer(renderer)
    await props.onExit()
  }

  useKeyboard((evt) => {
    if (evt.ctrl && evt.name === "c") {
      handleExit()
    }
  })
  const [copied, setCopied] = createSignal(false)

  // The error boundary sits outside LocaleProvider, so useLocale is unavailable; use the synchronous I18n.
  const errorInfo = I18n.t("app.error.report", {
    message: props.error.message,
    stack: props.error.stack?.substring(0, 5000) || "",
    version: VERSION,
  })

  // Choose safe fallback colors per mode since theme context may not be available
  const isLight = props.mode === "light"
  const colors = {
    bg: isLight ? "#ffffff" : "#0a0a0a",
    text: isLight ? "#1a1a1a" : "#eeeeee",
    muted: isLight ? "#8a8a8a" : "#808080",
    primary: isLight ? "#3b7dd8" : "#fab283",
  }

  const copyErrorInfo = () => {
    Clipboard.copy(errorInfo).then(() => {
      setCopied(true)
    })
  }

  return (
    <box flexDirection="column" gap={1} backgroundColor={colors.bg}>
      <box flexDirection="row" gap={1} alignItems="center">
        <text attributes={TextAttributes.BOLD} fg={colors.text}>
          {I18n.t("app.error.reportIssue", { url: Project.ISSUES })}
        </text>
        <box onMouseUp={copyErrorInfo} backgroundColor={colors.primary} padding={1}>
          <text attributes={TextAttributes.BOLD} fg={colors.bg}>
            {I18n.t("app.error.copy")}
          </text>
        </box>
        {copied() && <text fg={colors.muted}>{I18n.t("app.error.copied")}</text>}
      </box>
      <box flexDirection="row" gap={2} alignItems="center">
        <text fg={colors.text}>{I18n.t("app.error.title")}</text>
        <box onMouseUp={props.reset} backgroundColor={colors.primary} padding={1}>
          <text fg={colors.bg}>{I18n.t("app.error.reset")}</text>
        </box>
        <box onMouseUp={handleExit} backgroundColor={colors.primary} padding={1}>
          <text fg={colors.bg}>{I18n.t("app.error.exit")}</text>
        </box>
      </box>
      <scrollbox height={Math.floor(term().height * 0.7)}>
        <text fg={colors.muted}>{props.error.stack}</text>
      </scrollbox>
      <text fg={colors.text}>{props.error.message}</text>
    </box>
  )
}
