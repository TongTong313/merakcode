import type {
  Message,
  Agent,
  Provider,
  Session,
  Part,
  Config,
  Todo,
  Command,
  PermissionRequest,
  QuestionRequest,
  LspStatus,
  McpStatus,
  McpResource,
  FormatterStatus,
  SessionStatus,
  ProviderListResponse,
  ProviderAuthMethod,
  VcsInfo,
  PluginListResponse,
  Event,
  FileDiff,
} from "@merakcode/sdk/client"
import { createStore, produce, reconcile } from "solid-js/store"
import { applyEvent, type Change, type SessionsState } from "@merakcode/sdk/store"
import { useSDK } from "./sdk"
import { Binary } from "@merakcode/util/binary"
import { createSimpleContext } from "./helper"

import { useExit } from "./exit"
import { useArgs } from "./args"
import { batch, onMount } from "solid-js"
import { Log } from "@merakcode/log/logger"
import { createSingleFlight } from "../util/single-flight"
import { useProject } from "./project"
import { useEvent } from "./event"
import {
  createSessionMessageLoader,
  limitSessionSnapshot,
  mergeSessionSnapshot,
  type SessionMessageLoadState,
} from "./session-message-loader"
import { failure } from "@merakcode/log"
import { createSessionRequests } from "./session-requests"

const syncLog = Log.create({ source: "product", service: "tui.sync" })

interface SessionMessage {
  info: Message
  parts: Part[]
}

export const { use: useSync, provider: SyncProvider } = createSimpleContext({
  name: "Sync",
  init: () => {
    const [store, setStore] = createStore<{
      status: "loading" | "partial" | "complete"
      provider: Provider[]
      provider_default: Record<string, string>
      provider_next: ProviderListResponse
      provider_auth: Record<string, ProviderAuthMethod[]>
      agent: Agent[]
      command: Command[]
      permission: {
        [sessionID: string]: PermissionRequest[]
      }
      question: {
        [sessionID: string]: QuestionRequest[]
      }
      config: Config
      session: Session[]
      session_status: {
        [sessionID: string]: SessionStatus
      }
      session_diff: {
        [sessionID: string]: FileDiff[]
      }
      todo: {
        [sessionID: string]: Todo[]
      }
      message: {
        [sessionID: string]: Message[]
      }
      message_load: {
        [sessionID: string]: SessionMessageLoadState
      }
      part: {
        [messageID: string]: Part[]
      }
      // Per-session cap on loaded messages. Defaults to 100 and grows on demand; Infinity after loadAll means fully
      // loaded and never trimmed.
      loaded_limit: {
        [sessionID: string]: number
      }
      // Reentrancy guard for on-demand loading so rapid scrolling does not send duplicate requests.
      loading_more: {
        [sessionID: string]: boolean
      }
      lsp: LspStatus[]
      mcp: {
        [key: string]: McpStatus
      }
      mcp_resource: {
        [key: string]: McpResource
      }
      formatter: FormatterStatus[]
      plugin: PluginListResponse
      vcs: VcsInfo | undefined
    }>({
      provider_next: {
        all: [],
        default: {},
        connected: [],
      },
      provider_auth: {},
      config: {},
      status: "loading",
      agent: [],
      permission: {},
      question: {},
      command: [],
      provider: [],
      provider_default: {},
      session: [],
      session_status: {},
      session_diff: {},
      todo: {},
      message: {},
      message_load: {},
      part: {},
      loaded_limit: {},
      loading_more: {},
      lsp: [],
      mcp: {},
      mcp_resource: {},
      formatter: [],
      plugin: [],
      vcs: undefined,
    })

    const sdk = useSDK()
    const event = useEvent()
    const project = useProject()
    let bootstrapID = 0
    let liveRevision = 0
    const messageLiveRevision = new Map<string, number>()
    const partLiveRevision = new Map<string, number>()
    const activeMessageSnapshots = new Set<{ revision: number }>()

    function markLiveMessage(id: string) {
      const revision = ++liveRevision
      if (activeMessageSnapshots.size > 0) messageLiveRevision.set(id, revision)
    }

    function markLivePart(id: string) {
      const revision = ++liveRevision
      if (activeMessageSnapshots.size > 0) partLiveRevision.set(id, revision)
    }

    function finishMessageSnapshot(request: { revision: number }) {
      activeMessageSnapshots.delete(request)
      if (activeMessageSnapshots.size === 0) {
        messageLiveRevision.clear()
        partLiveRevision.clear()
        return
      }
      let oldest = Infinity
      for (const item of activeMessageSnapshots) oldest = Math.min(oldest, item.revision)
      for (const [id, revision] of messageLiveRevision) {
        if (revision <= oldest) messageLiveRevision.delete(id)
      }
      for (const [id, revision] of partLiveRevision) {
        if (revision <= oldest) partLiveRevision.delete(id)
      }
    }

    async function syncProviders() {
      const [providers, providerList] = await Promise.all([
        sdk.client.config.providers({}, { throwOnError: true }),
        sdk.client.provider.list({}, { throwOnError: true }),
      ])
      batch(() => {
        if (providers.data) {
          setStore("provider", reconcile(providers.data.providers))
          setStore("provider_default", reconcile(providers.data.default))
        }
        if (providerList.data) setStore("provider_next", reconcile(providerList.data))
      })
    }

    function refreshProviders(source: string) {
      void syncProviders().catch((error) => {
        Log.Product.warn(`tui ${source} provider refresh failed`, {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }

    let permissionChanges: Map<string, PermissionRequest | null> | undefined
    let questionChanges: Map<string, QuestionRequest | null> | undefined
    let interactionGeneration = 0

    event.subscribe((event) => {
      switch (event.type) {
        case "server.instance.disposed":
          interactionGeneration++
          permissionChanges?.clear()
          questionChanges?.clear()
          batch(() => {
            setStore("permission", reconcile({}))
            setStore("question", reconcile({}))
          })
          bootstrap()
          return
        case "provider.changed":
          refreshProviders("Provider")
          return
        case "config.updated": {
          void Promise.all([
            sdk.client.config.get({}, { throwOnError: true }).then((x) => {
              if (x.data) setStore("config", reconcile(x.data))
            }),
            sdk.client.app.agents({}, { throwOnError: true }).then((x) => {
              if (x.data) setStore("agent", reconcile(x.data))
            }),
            // Refresh commands after skill install/uninstall so skill commands in the slash menu stay current.
            sdk.client.command.list().then((x) => {
              if (x.data) setStore("command", reconcile(x.data))
            }),
            sdk.client.plugin.list().then((x) => {
              if (x.data) setStore("plugin", reconcile(x.data))
            }),
          ]).catch((e) =>
            Log.Product.warn("tui config.updated refresh failed", {
              error: e instanceof Error ? e.message : String(e),
            }),
          )
          return
        }
        case "lsp.updated":
          sdk.client.lsp.status().then((x) => setStore("lsp", x.data!))
          return
      }

      // Record permissions and questions that arrive during the initial load and merge them into the result, so the
      // stale snapshot does not overwrite them.
      if (event.type === "permission.asked") permissionChanges?.set(event.properties.id, event.properties)
      if (event.type === "permission.replied") permissionChanges?.set(event.properties.requestID, null)
      if (event.type === "question.asked") questionChanges?.set(event.properties.id, event.properties)
      if (event.type === "question.replied" || event.type === "question.rejected")
        questionChanges?.set(event.properties.requestID, null)
      // Mark messages updated while a snapshot is loading so the snapshot does not overwrite them with stale data.
      if (event.type === "message.updated") markLiveMessage(event.properties.info.id)
      if (event.type === "message.removed") markLiveMessage(event.properties.messageID)
      if (event.type === "message.part.updated") markLivePart(event.properties.part.id)
      if (event.type === "message.part.removed") markLivePart(event.properties.partID)

      // Shared state (sessions, messages, permissions) is reduced by the SDK store.
      const change = reduce(event)
      if (event.type !== "message.updated" || change !== "insert") return
      // Keep only the most recent messages per session, up to the loaded limit (Infinity after loadAll).
      const sessionID = event.properties.info.sessionID
      const cap = store.loaded_limit[sessionID] ?? 100
      const messages = store.message[sessionID] ?? []
      if (cap === Infinity || messages.length <= cap) return
      const oldest = messages[0]!
      setStore(
        produce((draft) => {
          draft.message[sessionID]!.shift()
          delete draft.part[oldest.id]
        }),
      )
    })

    /** Runs the SDK reducer on the Solid store: produce yields a mutable draft that applyEvent edits in place. */
    function reduce(event: Event): Change {
      let change: Change = "ignored"
      setStore(produce((draft) => void (change = applyEvent(draft as unknown as SessionsState, event))))
      return change
    }

    const exit = useExit()
    const args = useArgs()

    const bootstrap = createSingleFlight(async () => {
      const id = ++bootstrapID
      const started = Date.now()
      const pending = new Set<string>()
      let finished = false
      const request = <T,>(name: string, run: () => Promise<T>) => {
        const requestStarted = Date.now()
        pending.add(name)
        syncLog.info("request started", { id, name })
        return Promise.resolve()
          .then(run)
          .then(
            (result) => {
              syncLog.info("request completed", { id, name, duration: Date.now() - requestStarted })
              return result
            },
            (error) => {
              syncLog.error("request failed", {
                id,
                name,
                duration: Date.now() - requestStarted,
                error: error instanceof Error ? error.message : String(error),
                errorName: error instanceof Error ? error.name : undefined,
              })
              throw error
            },
          )
          .finally(() => pending.delete(name))
      }
      const stalled = (threshold: number) => {
        if (finished) return
        syncLog.warn("startup stalled", {
          id,
          stage: "sync.bootstrap",
          elapsed: Date.now() - started,
          threshold,
          status: store.status,
          pending: [...pending],
        })
      }
      const warning = setTimeout(() => stalled(5_000), 5_000)
      const error = setTimeout(() => stalled(15_000), 15_000)
      const finish = (status: "complete" | "partial" | "failed") => {
        if (finished) return
        finished = true
        clearTimeout(warning)
        clearTimeout(error)
        syncLog.info("bootstrap finished", {
          id,
          status,
          duration: Date.now() - started,
          pending: [...pending],
        })
      }

      syncLog.info("bootstrap started", { id, continue: args.continue === true })
      const start = Date.now() - 30 * 24 * 60 * 60 * 1000
      const sessionListPromise = request("session.list", () => sdk.client.session.list({ start: start })).then((x) =>
        (x.data ?? []).toSorted((a, b) => a.id.localeCompare(b.id)),
      )

      // blocking - include session.list when continuing a session
      const providersPromise = request("config.providers", () =>
        sdk.client.config.providers({}, { throwOnError: true }),
      )
      const providerListPromise = request("provider.list", () => sdk.client.provider.list({}, { throwOnError: true }))
      const agentsPromise = request("app.agents", () => sdk.client.app.agents({}, { throwOnError: true }))
      const configPromise = request("config.get", () => sdk.client.config.get({}, { throwOnError: true }))
      const projectPromise = request("path.get", () => project.sync())
      const pendingPromise = request("interaction.list", async () => {
        const generation = interactionGeneration
        const permissions = new Map<string, PermissionRequest | null>()
        const questions = new Map<string, QuestionRequest | null>()
        permissionChanges = permissions
        questionChanges = questions
        try {
          const [permission, question] = await Promise.all([
            sdk.client.permission.list({}, { throwOnError: true }).catch((error) => {
              syncLog.warn("interaction list failed", { operation: "permission.list", ...failure(error) })
              return undefined
            }),
            sdk.client.question.list({}, { throwOnError: true }).catch((error) => {
              syncLog.warn("interaction list failed", { operation: "question.list", ...failure(error) })
              return undefined
            }),
          ])
          if (generation !== interactionGeneration) return
          const currentPermissions = permission
            ? new Map((permission.data ?? []).map((item) => [item.id, item]))
            : undefined
          const currentQuestions = question ? new Map((question.data ?? []).map((item) => [item.id, item])) : undefined
          permissions.forEach((item, id) => (item ? currentPermissions?.set(id, item) : currentPermissions?.delete(id)))
          questions.forEach((item, id) => (item ? currentQuestions?.set(id, item) : currentQuestions?.delete(id)))
          const groupedPermissions = [...(currentPermissions?.values() ?? [])].reduce<
            Record<string, PermissionRequest[]>
          >((groups, item) => {
            const entries = groups[item.sessionID] ?? []
            entries.push(item)
            groups[item.sessionID] = entries
            return groups
          }, {})
          const groupedQuestions = [...(currentQuestions?.values() ?? [])].reduce<Record<string, QuestionRequest[]>>(
            (groups, item) => {
              const entries = groups[item.sessionID] ?? []
              entries.push(item)
              groups[item.sessionID] = entries
              return groups
            },
            {},
          )
          Object.values(groupedPermissions).forEach((items) => items.sort((a, b) => a.id.localeCompare(b.id)))
          Object.values(groupedQuestions).forEach((items) => items.sort((a, b) => a.id.localeCompare(b.id)))
          batch(() => {
            if (currentPermissions) setStore("permission", reconcile(groupedPermissions))
            if (currentQuestions) setStore("question", reconcile(groupedQuestions))
          })
          syncLog.info("interaction snapshot completed", {
            permissions: currentPermissions?.size,
            questions: currentQuestions?.size,
          })
        } finally {
          if (permissionChanges === permissions) permissionChanges = undefined
          if (questionChanges === questions) questionChanges = undefined
        }
      })
      const blockingRequests: Promise<unknown>[] = [
        providersPromise,
        providerListPromise,
        agentsPromise,
        configPromise,
        projectPromise,
        pendingPromise,
        ...(args.continue ? [sessionListPromise] : []),
      ]

      await Promise.all(blockingRequests)
        .then(() => {
          const providersResponse = providersPromise.then((x) => x.data!)
          const providerListResponse = providerListPromise.then((x) => x.data!)
          const agentsResponse = agentsPromise.then((x) => x.data ?? [])
          const configResponse = configPromise.then((x) => x.data!)
          const sessionListResponse = args.continue ? sessionListPromise : undefined

          return Promise.all([
            providersResponse,
            providerListResponse,
            agentsResponse,
            configResponse,
            ...(sessionListResponse ? [sessionListResponse] : []),
          ]).then((responses) => {
            const providers = responses[0]
            const providerList = responses[1]
            const agents = responses[2]
            const config = responses[3]
            const sessions = responses[4]

            batch(() => {
              setStore("provider", reconcile(providers.providers))
              setStore("provider_default", reconcile(providers.default))
              setStore("provider_next", reconcile(providerList))
              setStore("agent", reconcile(agents))
              setStore("config", reconcile(config))
              if (sessions !== undefined) setStore("session", reconcile(sessions))
            })
          })
        })
        .then(() => {
          if (store.status !== "complete") setStore("status", "partial")
          syncLog.info("bootstrap partial", { id, duration: Date.now() - started })
          // non-blocking
          Promise.all([
            ...(args.continue ? [] : [sessionListPromise.then((sessions) => setStore("session", reconcile(sessions)))]),
            request("command.list", () => sdk.client.command.list()).then((x) =>
              setStore("command", reconcile(x.data ?? [])),
            ),
            request("lsp.status", () => sdk.client.lsp.status()).then((x) => setStore("lsp", reconcile(x.data!))),
            request("mcp.status", () => sdk.client.mcp.status()).then((x) => setStore("mcp", reconcile(x.data!))),
            request("mcp.resources", () => sdk.client.experimental.resource.list()).then((x) =>
              setStore("mcp_resource", reconcile(x.data ?? {})),
            ),
            request("formatter.status", () => sdk.client.formatter.status()).then((x) =>
              setStore("formatter", reconcile(x.data!)),
            ),
            request("plugin.list", () => sdk.client.plugin.list()).then((x) =>
              setStore("plugin", reconcile(x.data ?? [])),
            ),
            request("session.status", () => sdk.client.session.status()).then((x) => {
              setStore("session_status", reconcile(x.data!))
            }),
            request("provider.auth", () => sdk.client.provider.auth()).then((x) =>
              setStore("provider_auth", reconcile(x.data ?? {})),
            ),
            request("vcs.get", () => sdk.client.vcs.get()).then((x) => setStore("vcs", reconcile(x.data))),
          ])
            .then(() => {
              setStore("status", "complete")
              finish("complete")
            })
            // A failure in the non-blocking phase must not crash: an unhandled rejection (e.g. a native TimeoutError
            // from a network probe) can escalate into an exit or segfault. Stay in partial mode (the first screen is
            // usable) and only log.
            .catch((e) => {
              Log.Product.warn("tui non-blocking sync failed, staying in partial mode", {
                error: e instanceof Error ? e.message : String(e),
                name: e instanceof Error ? e.name : undefined,
              })
              finish("partial")
            })
        })
        .catch(async (e) => {
          Log.Product.error("tui bootstrap failed", {
            error: e instanceof Error ? e.message : String(e),
            name: e instanceof Error ? e.name : undefined,
            stack: e instanceof Error ? e.stack : undefined,
          })
          finish("failed")
          await exit(e)
        })
    })

    onMount(() => {
      bootstrap()
    })

    const fullSyncedSessions = new Set<string>()

    function commitMessages(sessionID: string, messages: SessionMessage[], requestedAt?: number) {
      setStore(
        produce((draft) => {
          const snapshot = messages.map((message) => message.info)
          const merged = mergeSessionSnapshot(
            snapshot,
            draft.message[sessionID] ?? [],
            (id) => requestedAt !== undefined && (messageLiveRevision.get(id) ?? 0) > requestedAt,
          )
          const limit = draft.loaded_limit[sessionID] ?? 100
          draft.message[sessionID] = limitSessionSnapshot(merged, limit)
          const retained = new Set(draft.message[sessionID].map((message) => message.id))
          for (const message of messages) {
            if (!retained.has(message.info.id)) continue
            draft.part[message.info.id] = mergeSessionSnapshot(
              message.parts,
              draft.part[message.info.id] ?? [],
              (id) => requestedAt !== undefined && (partLiveRevision.get(id) ?? 0) > requestedAt,
            )
          }
        }),
      )
    }

    const messageLoader = createSessionMessageLoader({
      get: (sessionID) => store.message_load[sessionID] ?? { status: "idle" },
      set: (sessionID, state) => setStore("message_load", sessionID, state),
      load: async (sessionID, context) => {
        const request = { revision: liveRevision }
        activeMessageSnapshots.add(request)
        try {
          const limit = store.loaded_limit[sessionID] ?? 100
          const response = await sdk.client.session.messages({ sessionID, limit }, { throwOnError: true })
          if (!context.isCurrent()) return
          commitMessages(sessionID, response.data ?? [], request.revision)
        } finally {
          finishMessageSnapshot(request)
        }
      },
    })

    function setSessionStatus(sessionID: string, info: SessionStatus) {
      if (info.type === "idle") {
        setStore(
          "session_status",
          produce((draft) => {
            delete draft[sessionID]
          }),
        )
      } else {
        setStore("session_status", sessionID, info)
      }
    }

    const result = {
      requests: createSessionRequests(
        (sessionID) => setSessionStatus(sessionID, { type: "idle" }),
        (sessionID) => setSessionStatus(sessionID, { type: "busy" }),
      ),
      data: store,
      set: setStore,
      setSessionStatus,
      get status() {
        return store.status
      },
      get ready() {
        return store.status !== "loading"
      },
      session: {
        get(sessionID: string) {
          // Use find over the whole array so Solid tracks every visited index. When setStore("session", index,
          // reconcile(...)) updates a session, find re-triggers even if that index is off the Binary.search path.
          return store.session.find((s) => s.id === sessionID)
        },
        status(sessionID: string) {
          const session = result.session.get(sessionID)
          if (!session) return "idle"
          if (session.time.compacting) return "compacting"
          const messages = store.message[sessionID] ?? []
          const last = messages.at(-1)
          if (!last) return "idle"
          if (last.role === "user") return "working"
          return last.time.completed ? "idle" : "working"
        },
        messageLoadState(sessionID: string) {
          return store.message_load[sessionID] ?? ({ status: "idle" } as const)
        },
        ensureMessages(sessionID: string) {
          return messageLoader.ensure(sessionID)
        },
        async reloadMessages(sessionID: string) {
          const limit = store.loaded_limit[sessionID] ?? 100
          const messages = await sdk.client.session.messages({ sessionID, limit })
          setStore(
            produce((draft) => {
              draft.message[sessionID] = messages.data!.map((x) => x.info)
              for (const message of messages.data!) {
                draft.part[message.info.id] = message.parts
              }
            }),
          )
          messageLoader.loaded(sessionID)
        },
        // Loads older messages on demand: raises the limit by 50 and refetches the whole list. The session view's
        // scroll-preserving effect keeps the view steady when messages are inserted at the top.
        async loadMore(sessionID: string) {
          if (store.loading_more[sessionID]) return
          setStore("loading_more", sessionID, true)
          try {
            const next = (store.loaded_limit[sessionID] ?? 100) + 50
            const messages = await sdk.client.session.messages({ sessionID, limit: next })
            setStore(
              produce((draft) => {
                draft.message[sessionID] = messages.data!.map((x) => x.info)
                for (const message of messages.data!) {
                  draft.part[message.info.id] = message.parts
                }
                draft.loaded_limit[sessionID] = next
              }),
            )
            messageLoader.loaded(sessionID)
          } finally {
            setStore("loading_more", sessionID, false)
          }
        },
        // Loads every message of the session (called when the timeline opens) and sets loaded_limit to Infinity, so
        // message.updated never trims older messages and timeline entries can always be found.
        async loadAll(sessionID: string) {
          if (store.loading_more[sessionID]) return
          setStore("loading_more", sessionID, true)
          try {
            const messages = await sdk.client.session.messages({ sessionID, limit: 100000 })
            setStore(
              produce((draft) => {
                draft.message[sessionID] = messages.data!.map((x) => x.info)
                for (const message of messages.data!) {
                  draft.part[message.info.id] = message.parts
                }
                draft.loaded_limit[sessionID] = Infinity
              }),
            )
            messageLoader.loaded(sessionID)
          } finally {
            setStore("loading_more", sessionID, false)
          }
        },
        async sync(sessionID: string) {
          if (fullSyncedSessions.has(sessionID)) return
          const [session, , todo, diff] = await Promise.all([
            sdk.client.session.get({ sessionID }, { throwOnError: true }),
            messageLoader.ensure(sessionID),
            sdk.client.session.todo({ sessionID }),
            sdk.client.session.diff({ sessionID }),
          ])
          setStore(
            produce((draft) => {
              const match = Binary.search(draft.session, sessionID, (s) => s.id)
              if (match.found) draft.session[match.index] = session.data!
              if (!match.found) draft.session.splice(match.index, 0, session.data!)
              draft.todo[sessionID] = todo.data ?? []
              draft.session_diff[sessionID] = diff.data ?? []
            }),
          )
          fullSyncedSessions.add(sessionID)
        },
      },
      bootstrap,
    }
    return result
  },
})
