import { BoxRenderable, TextareaRenderable, MouseEvent, PasteEvent } from "@opentui/core"
import { createEffect, createMemo, type JSX, onMount, createSignal, onCleanup, on, Show, For } from "solid-js"
import { useLocal } from "../../context/local"
import { useTheme } from "../../context/theme"
import { useSDK } from "../../context/sdk"
import { useRoute } from "../../context/route"
import { useSync } from "../../context/sync"
import { Identifier } from "@merakcode/util/id"
import { createStore, produce } from "solid-js/store"
import { useKeybind } from "../../context/keybind"
import { usePromptHistory, type PromptInfo } from "./history"
import { usePromptStash } from "./stash"
import { DialogStash } from "../dialog-stash"
import { type AutocompleteRef, Autocomplete } from "./autocomplete"
import { useCommandDialog } from "../dialog-command"
import { useRenderer } from "@opentui/solid"
import { useExit } from "../../context/exit"
import { Clipboard } from "../../util/clipboard"
import type { FilePart } from "@merakcode/sdk/client"
import { iife } from "@merakcode/util/iife"
import { Locale } from "@merakcode/util/locale"
import { formatDuration } from "@merakcode/util/format"
import { useDialog } from "../../ui/dialog"
import { DialogProvider as DialogProviderConnect } from "../dialog-provider"
import { DialogAlert } from "../../ui/dialog-alert"
import { useToast } from "../../ui/toast"
import { useTextareaKeybindings } from "../textarea-keybindings"
import { DialogLanguage } from "../dialog-language"
import { DialogWorkflow } from "../dialog-workflow"
import { useLocale } from "../../context/locale"
import { WORKFLOW_RAINBOW_SCOPES } from "../../workflow-rainbow"
import { findWorkflowTriggerDisplayPositions } from "./workflow-trigger"
import { homeRouteIfSessionNotFound } from "../../util/session-not-found"
import { Log } from "@merakcode/log/logger"
import { failure } from "@merakcode/log"
import { isMessageAbortedError } from "@merakcode/util/error"
import { Filesystem } from "@merakcode/util/filesystem"

const promptLog = Log.create({ source: "product", service: "tui.prompt" })

export type PromptProps = {
  sessionID?: string
  visible?: boolean
  disabled?: boolean
  onSubmit?: () => void
  ref?: (ref: PromptRef) => void
  hint?: JSX.Element
  status?: JSX.Element
  showPlaceholder?: boolean
}

export type PromptRef = {
  focused: boolean
  current: PromptInfo
  set(prompt: PromptInfo): void
  reset(): void
  blur(): void
  focus(): void
  submit(): void
}

const SHELL_PLACEHOLDERS = ["ls -la", "git status", "pwd"]

export function Prompt(props: PromptProps) {
  let input: TextareaRenderable
  let anchor: BoxRenderable
  let autocomplete: AutocompleteRef

  const keybind = useKeybind()
  const local = useLocal()
  const sdk = useSDK()
  const route = useRoute()
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()
  const submitError = (error: unknown, sessionID: string, messageID: string, operation: string) => {
    sync.requests.settle(sessionID, messageID, true)
    if (isMessageAbortedError(error)) {
      promptLog.info("submission cancelled", { sessionID, messageID, operation, ...failure(error, true) })
      return
    }
    promptLog.warn("submission failed", { sessionID, messageID, operation, ...failure(error) })
    const home = homeRouteIfSessionNotFound(error)
    toast.show({
      message: home ? locale.t("toast.sessionNotFound", { id: sessionID }) : locale.t("toast.submitFailed"),
      variant: "error",
    })
    if (home) route.navigate(home)
  }
  const status = createMemo(() => sync.data.session_status?.[props.sessionID ?? ""] ?? { type: "idle" })
  const promptStatus = createMemo(() => props.status)

  const history = usePromptHistory()
  const stash = usePromptStash()
  const command = useCommandDialog()
  const renderer = useRenderer()
  const { theme, syntax } = useTheme()
  const locale = useLocale()

  const PLACEHOLDERS = createMemo(() => [
    locale.t("placeholder.fixTodo"),
    locale.t("placeholder.techStack"),
    locale.t("placeholder.fixTest"),
  ])

  function promptModelWarning() {
    toast.show({
      variant: "warning",
      message: locale.t("toast.connectProvider"),
      duration: 3000,
    })
    if (sync.data.provider.length === 0) {
      dialog.replace(() => <DialogProviderConnect />)
    }
  }

  const textareaKeybindings = useTextareaKeybindings()

  const fileStyleId = syntax().getStyleId("extmark.file")!
  const agentStyleId = syntax().getStyleId("extmark.agent")!
  const pasteStyleId = syntax().getStyleId("extmark.paste")!
  const workflowStyleIds = WORKFLOW_RAINBOW_SCOPES.map((scope) => syntax().getStyleId(scope)!)
  let promptPartTypeId = 0
  let workflowTriggerTypeId = 0
  const workflowExtmarkIds = new Set<number>()

  function clearWorkflowHighlights() {
    if (!input || input.isDestroyed || workflowTriggerTypeId === 0) {
      workflowExtmarkIds.clear()
      return false
    }
    let changed = false
    for (const id of [...workflowExtmarkIds]) {
      workflowExtmarkIds.delete(id)
      try {
        input.extmarks.delete(id)
        changed = true
      } catch {}
    }
    for (const extmark of [...input.extmarks.getAllForTypeId(workflowTriggerTypeId)]) {
      try {
        input.extmarks.delete(extmark.id)
        changed = true
      } catch {}
    }
    return changed
  }

  function updateWorkflowHighlights(value = input?.plainText ?? "", mode: "normal" | "shell" = "normal") {
    if (!input || input.isDestroyed || workflowTriggerTypeId === 0) return
    let changed = clearWorkflowHighlights()
    if (mode !== "normal") {
      if (changed) {
        input.invalidateIntrinsicSize()
        renderer.requestRender()
      }
      return
    }
    for (const trigger of findWorkflowTriggerDisplayPositions(value)) {
      for (let offset = trigger.start; offset < trigger.end; offset++) {
        const id = input.extmarks.create({
          start: offset,
          end: offset + 1,
          styleId: workflowStyleIds[(offset - trigger.start) % workflowStyleIds.length],
          priority: 10,
          typeId: workflowTriggerTypeId,
        })
        workflowExtmarkIds.add(id)
        changed = true
      }
    }
    if (!changed) return
    input.invalidateIntrinsicSize()
    renderer.requestRender()
  }

  createEffect(() => {
    if (props.disabled) input.cursorColor = theme.backgroundElement
    if (!props.disabled) input.cursorColor = theme.text
  })

  const lastUserMessage = createMemo(() => {
    if (!props.sessionID) return undefined
    const messages = sync.data.message[props.sessionID]
    if (!messages) return undefined
    return messages.findLast((m) => m.role === "user")
  })

  const [store, setStore] = createStore<{
    prompt: PromptInfo
    mode: "normal" | "shell"
    extmarkToPartIndex: Map<number, number>
    interrupt: number
    placeholder: number
  }>({
    placeholder: Math.floor(Math.random() * PLACEHOLDERS.length),
    prompt: {
      input: "",
      parts: [],
    },
    mode: "normal",
    extmarkToPartIndex: new Map(),
    interrupt: 0,
  })

  createEffect(() => {
    updateWorkflowHighlights(store.prompt.input, store.mode)
  })

  createEffect(
    on(
      () => props.sessionID,
      () => {
        setStore("placeholder", Math.floor(Math.random() * PLACEHOLDERS.length))
      },
      { defer: true },
    ),
  )

  // When a session loads, sync the local agent, permissionMode, model and variant to the session's current values so
  // the status bar and composer match the session.
  //
  // Synthetic user messages sent on the plan agent's behalf (by plan_enter / plan_exit) often record agent "build",
  // so the agent is taken from the latest message the user actually typed: scan user messages backwards and skip those
  // whose text parts are all synthetic. If there is none, fall back to lastUserMessage().
  let syncedSessionID: string | undefined
  createEffect(() => {
    const sessionID = props.sessionID
    if (sessionID === syncedSessionID) return
    if (!sessionID) return

    syncedSessionID = sessionID

    const allUserMsgs = sync.data.message[sessionID]?.filter((m) => m.role === "user") ?? []
    // A user message is genuine if it has at least one text part that is neither synthetic nor ignored.
    function isGenuineUserMsg(msgId: string) {
      const parts = sync.data.part[msgId] ?? []
      return parts.some((p) => p && p.type === "text" && !p.synthetic && !p.ignored)
    }
    const genuineUserMsg = [...allUserMsgs].reverse().find((m) => isGenuineUserMsg(m.id)) ?? lastUserMessage()

    const isPrimaryAgent = (id: string | undefined) => !!id && local.agent.list().some((x) => x.id === id)

    const msg = genuineUserMsg
    if (msg && isPrimaryAgent(msg.agent)) {
      local.agent.set(msg.agent)
      if (msg.permissionMode) local.permissionMode.set(msg.permissionMode)
      if (msg.model) local.model.set(msg.model)
      if (msg.variant) local.model.variant.set(msg.variant)
    }
  })

  command.register(() => {
    return [
      {
        title: locale.t("command.clearInput"),
        value: "prompt.clear",
        category: locale.t("command.category.input"),
        hidden: true,
        onSelect: (dialog) => {
          input.extmarks.clear()
          input.clear()
          dialog.clear()
        },
      },
      {
        title: locale.t("command.submit"),
        value: "prompt.submit",
        keybind: "input_submit",
        category: locale.t("command.category.input"),
        hidden: true,
        onSelect: (dialog) => {
          if (!input.focused) return
          submit()
          dialog.clear()
        },
      },
      {
        title: locale.t("command.paste"),
        value: "prompt.paste",
        keybind: "input_paste",
        category: locale.t("command.category.input"),
        hidden: true,
        onSelect: async () => {
          const content = await Clipboard.read()
          if (content?.mime.startsWith("image/")) {
            await pasteImage({
              filename: "clipboard",
              mime: content.mime,
              content: content.data,
            })
          }
        },
      },
      {
        title: locale.t("command.interrupt"),
        value: "session.interrupt",
        keybind: "session_interrupt",
        category: locale.t("command.category.session"),
        hidden: true,
        enabled: status().type !== "idle",
        onSelect: (dialog) => {
          if (!input.focused) return
          // TODO: this should be its own command
          if (store.mode === "shell") {
            setStore("mode", "normal")
            return
          }
          if (!props.sessionID) return

          setStore("interrupt", store.interrupt + 1)

          setTimeout(() => {
            setStore("interrupt", 0)
          }, 5000)

          if (store.interrupt >= 2) {
            sdk.client.session.abort({
              sessionID: props.sessionID,
            })
            setStore("interrupt", 0)
          }
          dialog.clear()
        },
      },
    ]
  })

  const ref: PromptRef = {
    get focused() {
      return input.focused
    },
    get current() {
      return store.prompt
    },
    focus() {
      input.focus()
    },
    blur() {
      input.blur()
    },
    set(prompt) {
      input.setText(prompt.input)
      setStore("prompt", prompt)
      restoreExtmarksFromParts(prompt.parts)
      input.gotoBufferEnd()
    },
    reset() {
      input.clear()
      input.extmarks.clear()
      setStore("prompt", {
        input: "",
        parts: [],
      })
      setStore("extmarkToPartIndex", new Map())
    },
    submit() {
      submit()
    },
  }

  createEffect(() => {
    if (props.visible !== false) input?.focus()
    if (props.visible === false) input?.blur()
  })

  function restoreExtmarksFromParts(parts: PromptInfo["parts"]) {
    input.extmarks.clear()
    setStore("extmarkToPartIndex", new Map())

    parts.forEach((part, partIndex) => {
      let start = 0
      let end = 0
      let virtualText = ""
      let styleId: number | undefined

      if (part.type === "file" && part.source?.text) {
        start = part.source.text.start
        end = part.source.text.end
        virtualText = part.source.text.value
        styleId = fileStyleId
      } else if (part.type === "agent" && part.source) {
        start = part.source.start
        end = part.source.end
        virtualText = part.source.value
        styleId = agentStyleId
      } else if (part.type === "text" && part.source?.text) {
        start = part.source.text.start
        end = part.source.text.end
        virtualText = part.source.text.value
        styleId = pasteStyleId
      }

      if (virtualText) {
        const extmarkId = input.extmarks.create({
          start,
          end,
          virtual: true,
          styleId,
          typeId: promptPartTypeId,
        })
        setStore("extmarkToPartIndex", (map: Map<number, number>) => {
          const newMap = new Map(map)
          newMap.set(extmarkId, partIndex)
          return newMap
        })
      }
    })

    updateWorkflowHighlights(input.plainText, store.mode)
  }

  function syncExtmarksWithPromptParts() {
    const allExtmarks = input.extmarks.getAllForTypeId(promptPartTypeId)
    setStore(
      produce((draft) => {
        const newMap = new Map<number, number>()
        const newParts: typeof draft.prompt.parts = []

        for (const extmark of allExtmarks) {
          const partIndex = draft.extmarkToPartIndex.get(extmark.id)
          if (partIndex !== undefined) {
            const part = draft.prompt.parts[partIndex]
            if (part) {
              if (part.type === "agent" && part.source) {
                part.source.start = extmark.start
                part.source.end = extmark.end
              } else if (part.type === "file" && part.source?.text) {
                part.source.text.start = extmark.start
                part.source.text.end = extmark.end
              } else if (part.type === "text" && part.source?.text) {
                part.source.text.start = extmark.start
                part.source.text.end = extmark.end
              }
              newMap.set(extmark.id, newParts.length)
              newParts.push(part)
            }
          }
        }

        draft.extmarkToPartIndex = newMap
        draft.prompt.parts = newParts
      }),
    )
  }

  command.register(() => [
    {
      title: locale.t("command.stash"),
      value: "prompt.stash",
      category: locale.t("command.category.input"),
      enabled: !!store.prompt.input,
      onSelect: (dialog) => {
        if (!store.prompt.input) return
        stash.push({
          input: store.prompt.input,
          parts: store.prompt.parts,
        })
        input.extmarks.clear()
        input.clear()
        setStore("prompt", { input: "", parts: [] })
        setStore("extmarkToPartIndex", new Map())
        dialog.clear()
      },
    },
    {
      title: locale.t("command.stashPop"),
      value: "prompt.stash.pop",
      category: locale.t("command.category.input"),
      enabled: stash.list().length > 0,
      onSelect: (dialog) => {
        const entry = stash.pop()
        if (entry) {
          input.setText(entry.input)
          setStore("prompt", { input: entry.input, parts: entry.parts })
          restoreExtmarksFromParts(entry.parts)
          input.gotoBufferEnd()
        }
        dialog.clear()
      },
    },
    {
      title: locale.t("command.stashList"),
      value: "prompt.stash.list",
      category: locale.t("command.category.input"),
      enabled: stash.list().length > 0,
      onSelect: (dialog) => {
        dialog.replace(() => (
          <DialogStash
            onSelect={(entry) => {
              input.setText(entry.input)
              setStore("prompt", { input: entry.input, parts: entry.parts })
              restoreExtmarksFromParts(entry.parts)
              input.gotoBufferEnd()
            }}
          />
        ))
      },
    },
  ])

  async function submit() {
    if (props.disabled) return
    if (autocomplete?.visible) return
    if (!store.prompt.input) return
    const trimmed = store.prompt.input.trim()
    if (trimmed === "exit" || trimmed === "quit" || trimmed === ":q") {
      exit()
      return
    }
    const slash = trimmed.startsWith("/") ? trimmed.split("\n")[0].split(" ")[0].slice(1) : undefined
    if (slash === "new" || slash === "clear") {
      route.navigate({ type: "home" })
      dialog.clear()
      input.clear()
      input.extmarks.clear()
      setStore("prompt", {
        input: "",
        parts: [],
      })
      setStore("extmarkToPartIndex", new Map())
      return
    }
    if (slash === "language" || slash === "lang") {
      dialog.replace(() => <DialogLanguage />)
      input.clear()
      return
    }
    if (slash === "workflow") {
      dialog.replace(() => <DialogWorkflow />)
      input.clear()
      return
    }
    const selectedModel = local.model.current()
    if (!selectedModel) {
      promptModelWarning()
      return
    }
    const sessionID = props.sessionID
      ? props.sessionID
      : await (async () => {
          const sessionID = await sdk.client.session.create({}).then((x) => x.data!.id)
          return sessionID
        })()
    const messageID = Identifier.ascending("message")
    let inputText = store.prompt.input

    // Expand pasted text inline before submitting
    const allExtmarks = input.extmarks.getAllForTypeId(promptPartTypeId)
    const sortedExtmarks = allExtmarks.sort((a: { start: number }, b: { start: number }) => b.start - a.start)

    for (const extmark of sortedExtmarks) {
      const partIndex = store.extmarkToPartIndex.get(extmark.id)
      if (partIndex !== undefined) {
        const part = store.prompt.parts[partIndex]
        if (part?.type === "text" && part.text) {
          const before = inputText.slice(0, extmark.start)
          const after = inputText.slice(extmark.end)
          inputText = before + part.text + after
        }
      }
    }

    // Filter out text parts (pasted content) since they're now expanded inline
    const nonTextParts = store.prompt.parts.filter((part) => part.type !== "text")

    // Capture mode before it gets reset
    const currentMode = store.mode
    const agentID = local.agent.current().id
    const variant = local.model.variant.current()

    if (store.mode === "shell") {
      sdk.client.session.shell({
        sessionID,
        agent: agentID,
        permissionMode: local.permissionMode.current(),
        model: {
          providerID: selectedModel.providerID,
          modelID: selectedModel.modelID,
        },
        command: inputText,
      })
      setStore("mode", "normal")
    } else if (
      inputText.startsWith("/") &&
      iife(() => {
        const firstLine = inputText.split("\n")[0]
        const command = firstLine.split(" ")[0].slice(1)
        return sync.data.command.some((x) => x.name === command)
      })
    ) {
      // Parse command from first line, preserve multi-line content in arguments
      const firstLineEnd = inputText.indexOf("\n")
      const firstLine = firstLineEnd === -1 ? inputText : inputText.slice(0, firstLineEnd)
      const [command, ...firstLineArgs] = firstLine.split(" ")
      const restOfInput = firstLineEnd === -1 ? "" : inputText.slice(firstLineEnd + 1)
      const args = firstLineArgs.join(" ") + (restOfInput ? "\n" + restOfInput : "")

      if (status().type !== "idle") {
        toast.show({
          message: locale.t("toast.promptQueued"),
          variant: "info",
        })
      }
      sync.requests.claim(sessionID, messageID)
      const started = Date.now()
      promptLog.info("submission started", { sessionID, messageID, operation: "session.command" })
      sdk.client.session
        .command(
          {
            sessionID,
            command: command.slice(1),
            arguments: args,
            agent: agentID,
            permissionMode: local.permissionMode.current(),
            model: `${selectedModel.providerID}/${selectedModel.modelID}`,
            messageID,
            variant,
            parts: nonTextParts
              .filter((x) => x.type === "file")
              .map((x) => ({
                id: Identifier.ascending("part"),
                ...x,
              })),
          },
          { throwOnError: true },
        )
        .catch((error) => {
          submitError(error, sessionID, messageID, "session.command")
        })
        .finally(() => {
          sync.requests.settle(sessionID, messageID, true)
          promptLog.info("submission settled", {
            sessionID,
            messageID,
            operation: "session.command",
            duration: Date.now() - started,
          })
        })
    } else {
      if (status().type !== "idle") {
        toast.show({
          message: locale.t("toast.promptQueued"),
          variant: "info",
        })
      }
      sync.requests.claim(sessionID, messageID)
      sdk.client.session
        .prompt(
          {
            sessionID,
            ...selectedModel,
            messageID,
            permissionMode: local.permissionMode.current(),
            agent: agentID,
            model: selectedModel,
            variant,
            parts: [
              {
                id: Identifier.ascending("part"),
                type: "text",
                text: inputText,
              },
              ...nonTextParts.map((x) => ({
                id: Identifier.ascending("part"),
                ...x,
              })),
            ],
          },
          { throwOnError: true },
        )
        .catch((error) => {
          submitError(error, sessionID, messageID, "session.prompt")
        })
        .finally(() => sync.requests.settle(sessionID, messageID))
    }
    history.append({
      ...store.prompt,
      mode: currentMode,
    })
    input.extmarks.clear()
    setStore("prompt", {
      input: "",
      parts: [],
    })
    setStore("extmarkToPartIndex", new Map())
    props.onSubmit?.()

    // temporary hack to make sure the message is sent
    if (!props.sessionID)
      setTimeout(() => {
        route.navigate({
          type: "session",
          sessionID,
        })
      }, 50)
    input.clear()
  }
  const exit = useExit()

  function pasteText(text: string, virtualText: string) {
    const currentOffset = input.visualCursor.offset
    const extmarkStart = currentOffset
    const extmarkEnd = extmarkStart + virtualText.length

    input.insertText(virtualText + " ")

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    setStore(
      produce((draft) => {
        const partIndex = draft.prompt.parts.length
        draft.prompt.parts.push({
          type: "text" as const,
          text,
          source: {
            text: {
              start: extmarkStart,
              end: extmarkEnd,
              value: virtualText,
            },
          },
        })
        draft.extmarkToPartIndex.set(extmarkId, partIndex)
      }),
    )
  }

  async function pasteImage(file: { filename?: string; content: string; mime: string }) {
    const currentOffset = input.visualCursor.offset
    const extmarkStart = currentOffset
    const count = store.prompt.parts.filter((x) => x.type === "file").length
    const virtualText = locale.t("prompt.imagePlaceholder", { index: count + 1 })
    const extmarkEnd = extmarkStart + virtualText.length
    const textToInsert = virtualText + " "

    input.insertText(textToInsert)

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    const part: Omit<FilePart, "id" | "messageID" | "sessionID"> = {
      type: "file" as const,
      mime: file.mime,
      filename: file.filename,
      url: `data:${file.mime};base64,${file.content}`,
      source: {
        type: "file",
        path: file.filename ?? "",
        text: {
          start: extmarkStart,
          end: extmarkEnd,
          value: virtualText,
        },
      },
    }
    setStore(
      produce((draft) => {
        const partIndex = draft.prompt.parts.length
        draft.prompt.parts.push(part)
        draft.extmarkToPartIndex.set(extmarkId, partIndex)
      }),
    )
    return
  }

  const highlight = createMemo(() => {
    if (keybind.leader) return theme.border
    if (store.mode === "shell") return theme.primary
    return local.agent.color(local.agent.current().id)
  })

  // The status bar shows only effort variants; off/on is conveyed by the color of the ·thinking indicator.
  const showVariant = createMemo(() => {
    const current = local.model.variant.current()
    return !!current && current !== "off" && current !== "on"
  })

  // Models with only an off/on toggle (no effort levels) get the "toggle thinking" hint instead of "switch effort".
  const variantToggleOnly = createMemo(() => {
    const variants = local.model.variant.list()
    return variants.length > 0 && variants.every((v) => v === "off" || v === "on")
  })

  const placeholderText = createMemo(() => {
    if (props.sessionID) return ""
    if (store.mode === "shell") {
      const example = SHELL_PLACEHOLDERS[store.placeholder % SHELL_PLACEHOLDERS.length]
      return locale.t("prompt.shellPlaceholder", { example })
    }
    return locale.t("prompt.inputMessage", { placeholder: PLACEHOLDERS()[store.placeholder % PLACEHOLDERS().length] })
  })

  const hasVariant = createMemo(() => local.model.variant.list().length > 0)

  const hintParts = createMemo(() => {
    const parts: { text: string; highlight: boolean }[] = []
    if (props.sessionID) return parts
    const agentKey = keybind.print("agent_cycle")
    const modeKey = keybind.print("permission_mode_cycle")
    const variantKey = keybind.print("variant_cycle")
    if (agentKey) {
      parts.push({ text: agentKey, highlight: true })
      parts.push({ text: locale.t("prompt.agent"), highlight: false })
    }
    if (modeKey) {
      if (parts.length) parts.push({ text: " · ", highlight: false })
      parts.push({ text: modeKey, highlight: true })
      parts.push({ text: locale.t("prompt.permissionMode"), highlight: false })
    }
    if (variantKey && hasVariant()) {
      if (parts.length) parts.push({ text: " · ", highlight: false })
      parts.push({ text: variantKey, highlight: true })
      parts.push({
        text: variantToggleOnly() ? locale.t("prompt.variantToggle") : locale.t("prompt.variantCycle"),
        highlight: false,
      })
    }
    if (parts.length) parts.push({ text: " · ", highlight: false })
    parts.push({ text: "/", highlight: true })
    parts.push({ text: locale.t("hint.useCommand"), highlight: false })
    if (parts.length) parts.push({ text: " · ", highlight: false })
    parts.push({ text: "/keys", highlight: true })
    parts.push({ text: locale.t("hint.viewAllKeys"), highlight: false })
    return parts
  })

  return (
    <>
      <Autocomplete
        sessionID={props.sessionID}
        ref={(r) => (autocomplete = r)}
        anchor={() => anchor}
        input={() => input}
        setPrompt={(cb) => {
          setStore("prompt", produce(cb))
        }}
        setExtmark={(partIndex, extmarkId) => {
          setStore("extmarkToPartIndex", (map: Map<number, number>) => {
            const newMap = new Map(map)
            newMap.set(extmarkId, partIndex)
            return newMap
          })
        }}
        value={store.prompt.input}
        fileStyleId={fileStyleId}
        agentStyleId={agentStyleId}
        promptPartTypeId={() => promptPartTypeId}
      />
      <box ref={(r) => (anchor = r)} visible={props.visible !== false}>
        <box paddingLeft={2} flexGrow={1}>
          <box flexDirection="row" paddingTop={1} flexShrink={0}>
            <text fg={highlight()} flexShrink={0}>
              ▍{" "}
            </text>
            <box flexGrow={1} flexShrink={1} minWidth={0}>
              <textarea
                placeholder={placeholderText()}
                textColor={keybind.leader ? theme.textMuted : theme.text}
                focusedTextColor={keybind.leader ? theme.textMuted : theme.text}
                minHeight={1}
                maxHeight={6}
                onContentChange={() => {
                  const value = input.plainText
                  setStore("prompt", "input", value)
                  autocomplete.onInput(value)
                  syncExtmarksWithPromptParts()
                  updateWorkflowHighlights(value, store.mode)
                }}
                keyBindings={textareaKeybindings()}
                onKeyDown={async (e) => {
                  if (props.disabled) {
                    e.preventDefault()
                    return
                  }
                  // Handle clipboard paste (Ctrl+V) - check for images first on Windows
                  // This is needed because Windows terminal doesn't properly send image data
                  // through bracketed paste, so we need to intercept the keypress and
                  // directly read from clipboard before the terminal handles it
                  if (keybind.match("input_paste", e)) {
                    const content = await Clipboard.read()
                    if (content?.mime.startsWith("image/")) {
                      e.preventDefault()
                      await pasteImage({
                        filename: "clipboard",
                        mime: content.mime,
                        content: content.data,
                      })
                      return
                    }
                    // If no image, let the default paste behavior continue
                  }
                  if (keybind.match("input_clear", e) && store.prompt.input !== "") {
                    input.clear()
                    input.extmarks.clear()
                    setStore("prompt", {
                      input: "",
                      parts: [],
                    })
                    setStore("extmarkToPartIndex", new Map())
                    return
                  }
                  if (keybind.match("app_exit", e)) {
                    if (store.prompt.input === "") {
                      await exit()
                      // Don't preventDefault - let textarea potentially handle the event
                      e.preventDefault()
                      return
                    }
                  }
                  if (e.name === "!" && input.visualCursor.offset === 0) {
                    setStore("placeholder", Math.floor(Math.random() * SHELL_PLACEHOLDERS.length))
                    setStore("mode", "shell")
                    e.preventDefault()
                    return
                  }
                  if (store.mode === "shell") {
                    if ((e.name === "backspace" && input.visualCursor.offset === 0) || e.name === "escape") {
                      setStore("mode", "normal")
                      e.preventDefault()
                      return
                    }
                  }
                  const wasAutocompleteVisible = autocomplete.visible
                  if (store.mode === "normal") autocomplete.onKeyDown(e)
                  if (wasAutocompleteVisible && e.name === "escape" && keybind.match("session_interrupt", e))
                    command.trigger("session.interrupt")
                  if (!autocomplete.visible) {
                    if (
                      (keybind.match("history_previous", e) && input.cursorOffset === 0) ||
                      (keybind.match("history_next", e) && input.cursorOffset === input.plainText.length)
                    ) {
                      const direction = keybind.match("history_previous", e) ? -1 : 1
                      const item = history.move(direction, input.plainText)

                      if (item) {
                        input.setText(item.input)
                        setStore("prompt", item)
                        setStore("mode", item.mode ?? "normal")
                        restoreExtmarksFromParts(item.parts)
                        e.preventDefault()
                        if (direction === -1) input.cursorOffset = 0
                        if (direction === 1) input.cursorOffset = input.plainText.length
                      }
                      return
                    }

                    if (keybind.match("history_previous", e) && input.visualCursor.visualRow === 0)
                      input.cursorOffset = 0
                    if (keybind.match("history_next", e) && input.visualCursor.visualRow === input.height - 1)
                      input.cursorOffset = input.plainText.length
                  }
                }}
                onSubmit={submit}
                onPaste={async (event: PasteEvent) => {
                  if (props.disabled) {
                    event.preventDefault()
                    return
                  }

                  // Normalize line endings at the boundary
                  // Windows ConPTY/Terminal often sends CR-only newlines in bracketed paste
                  // Replace CRLF first, then any remaining CR
                  const normalizedText = new TextDecoder()
                    .decode(event.bytes)
                    .replace(/\r\n/g, "\n")
                    .replace(/\r/g, "\n")
                  const pastedContent = normalizedText.trim()
                  if (!pastedContent) {
                    command.trigger("prompt.paste")
                    return
                  }

                  // trim ' from the beginning and end of the pasted content. just
                  // ' and nothing else
                  const filepath = pastedContent.replace(/^'+|'+$/g, "").replace(/\\ /g, " ")
                  const isUrl = /^(https?):\/\//.test(filepath)
                  if (!isUrl) {
                    try {
                      // The type comes from the extension; unreadable files are pasted as plain text.
                      const mime = Filesystem.mimeType(filepath)
                      // Handle SVG as raw text content, not as base64 image
                      if (mime === "image/svg+xml") {
                        event.preventDefault()
                        const content = await Filesystem.readText(filepath).catch(() => {})
                        if (content) {
                          pasteText(content, `[SVG: ${filepath}]`)
                          return
                        }
                      }
                      if (mime.startsWith("image/")) {
                        event.preventDefault()
                        const content = await Filesystem.readBytes(filepath)
                          .then((bytes) => Buffer.from(bytes).toString("base64"))
                          .catch(() => {})
                        if (content) {
                          await pasteImage({
                            filename: filepath,
                            mime,
                            content,
                          })
                          return
                        }
                      }
                    } catch {}
                  }

                  const lineCount = (pastedContent.match(/\n/g)?.length ?? 0) + 1
                  if (
                    (lineCount >= 3 || pastedContent.length > 150) &&
                    !sync.data.config.experimental?.disable_paste_summary
                  ) {
                    event.preventDefault()
                    pasteText(pastedContent, locale.t("prompt.pastedLines", { count: lineCount }))
                    return
                  }

                  // Force layout update and render for the pasted content
                  setTimeout(() => {
                    // setTimeout is a workaround and needs to be addressed properly
                    if (!input || input.isDestroyed) return
                    input.invalidateIntrinsicSize()
                    renderer.requestRender()
                  }, 0)
                }}
                ref={(r: TextareaRenderable) => {
                  input = r
                  if (promptPartTypeId === 0) {
                    promptPartTypeId = input.extmarks.registerType("prompt-part")
                  }
                  if (workflowTriggerTypeId === 0) {
                    workflowTriggerTypeId = input.extmarks.registerType("workflow-trigger")
                  }
                  props.ref?.(ref)
                  setTimeout(() => {
                    // setTimeout is a workaround and needs to be addressed properly
                    if (!input || input.isDestroyed) return
                    input.cursorColor = theme.text
                    updateWorkflowHighlights(input.plainText, store.mode)
                  }, 0)
                }}
                onMouseDown={(r: MouseEvent) => r.target?.focus()}
                focusedBackgroundColor={theme.background}
                cursorColor={theme.text}
                syntaxStyle={syntax()}
              />
              <box flexDirection="column" flexShrink={0} paddingTop={1} gap={1}>
                <box flexDirection="row" justifyContent="space-between">
                  <box flexDirection="row" gap={0}>
                    <text fg={theme.textMuted}>{locale.t("status.agent")}</text>
                    <text fg={highlight()}>
                      {store.mode === "shell" ? "Shell" : Locale.titlecase(local.agent.current().name)}
                    </text>
                    {/* Permission mode (read-only / ask / auto), toggled by click or shortcut */}
                    <text
                      fg={
                        local.permissionMode.current() === "auto"
                          ? theme.warning
                          : local.permissionMode.current() === "readonly"
                            ? theme.info
                            : theme.textMuted
                      }
                      onMouseDown={() => local.permissionMode.cycle()}
                    >
                      {" · " + locale.t(`status.mode.${local.permissionMode.current()}`)}
                    </text>
                    <Show when={store.mode === "normal"}>
                      <text fg={theme.textMuted}>{locale.t("status.model")}</text>
                      <text flexShrink={0} fg={keybind.leader ? theme.textMuted : theme.text}>
                        {local.model.parsed().model}
                      </text>
                      {/* Thinking toggle, only for models with an off variant: green = on, gray = off */}
                      <Show when={local.model.thinking.has()}>
                        <text
                          fg={local.model.thinking.on() ? theme.success : theme.textMuted}
                          onMouseDown={() => local.model.thinking.toggle()}
                        >
                          {" · " + locale.t("status.thinking")}
                        </text>
                      </Show>
                      {/* Effort variant only; off/on is shown by the ·thinking color */}
                      <Show when={showVariant()}>
                        <text fg={theme.warning}> ({local.model.variant.current()})</text>
                      </Show>
                      <text fg={theme.textMuted}> · {local.model.parsed().provider}</text>
                    </Show>
                  </box>
                </box>
                <Show when={promptStatus()}>{(status) => status()}</Show>
                <Show when={hintParts().length}>
                  <box flexDirection="column" gap={0}>
                    <box
                      border={["top"]}
                      title={" " + locale.t("tips.button") + " "}
                      titleAlignment="center"
                      borderColor={theme.borderActive}
                    />
                    <box
                      flexDirection="row"
                      justifyContent="center"
                      paddingTop={1}
                      paddingBottom={0}
                      paddingLeft={1}
                      paddingRight={1}
                      backgroundColor={theme.backgroundElement}
                      border={["left", "right", "bottom"]}
                      borderColor={theme.borderActive}
                    >
                      <text>
                        <For each={hintParts()}>
                          {(part) => (
                            <span style={{ fg: part.highlight ? theme.accent : theme.textMuted }}>{part.text}</span>
                          )}
                        </For>
                      </text>
                    </box>
                  </box>
                </Show>
              </box>
            </box>
          </box>
          <box flexDirection="row" justifyContent="space-between">
            <Show when={status().type !== "idle"}>
              <box
                flexDirection="row"
                gap={1}
                flexGrow={1}
                justifyContent={status().type === "retry" ? "space-between" : "flex-start"}
              >
                <text marginLeft={1} fg={store.interrupt > 0 ? theme.primary : theme.text}>
                  esc{" "}
                  <span style={{ fg: store.interrupt > 0 ? theme.primary : theme.textMuted }}>
                    {store.interrupt > 0 ? locale.t("session.interruptAgain") : locale.t("session.interrupt")}
                  </span>
                </text>
                <Show when={status().type === "retry"}>
                  {(() => {
                    const retry = createMemo(() => {
                      const s = status()
                      if (s.type !== "retry") return
                      return s
                    })
                    const message = createMemo(() => {
                      const r = retry()
                      if (!r) return
                      if (r.message.includes("exceeded your current quota") && r.message.includes("gemini"))
                        return locale.t("prompt.geminiRateLimit")
                      if (r.message.length > 80) return r.message.slice(0, 80) + "..."
                      return r.message
                    })
                    const isTruncated = createMemo(() => {
                      const r = retry()
                      if (!r) return false
                      return r.message.length > 120
                    })
                    const [seconds, setSeconds] = createSignal(0)
                    onMount(() => {
                      const timer = setInterval(() => {
                        const next = retry()?.next
                        if (next) setSeconds(Math.round((next - Date.now()) / 1000))
                      }, 1000)

                      onCleanup(() => {
                        clearInterval(timer)
                      })
                    })
                    const handleMessageClick = () => {
                      const r = retry()
                      if (!r) return
                      if (isTruncated()) {
                        DialogAlert.show(dialog, locale.t("prompt.retryError"), r.message)
                      }
                    }

                    const retryText = () => {
                      const r = retry()
                      if (!r) return ""
                      const baseMessage = message()
                      const truncatedHint = isTruncated() ? locale.t("prompt.clickToExpand") : ""
                      const duration = formatDuration(seconds())
                      const retryInfo = duration
                        ? locale.t("prompt.retrying", { duration, attempt: r.attempt })
                        : locale.t("prompt.retryingNow", { attempt: r.attempt })
                      return baseMessage + truncatedHint + retryInfo
                    }

                    return (
                      <box flexDirection="row" gap={1} flexShrink={0} onMouseUp={handleMessageClick}>
                        <text fg={theme.error}>{retryText()}</text>
                      </box>
                    )
                  })()}
                </Show>
              </box>
            </Show>
          </box>
        </box>
      </box>
    </>
  )
}
