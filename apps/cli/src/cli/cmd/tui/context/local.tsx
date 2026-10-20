import { createStore } from "solid-js/store"
import { batch, createEffect, createMemo, onCleanup } from "solid-js"
import { useSync } from "./sync"
import { useEvent } from "./event"
import { useTheme } from "./theme"
import { uniqueBy } from "remeda"
import path from "path"
import { Paths } from "@merakcode/util/paths"
import { Log } from "@merakcode/log/logger"
import { failure } from "@merakcode/log"
import { iife } from "@merakcode/util/iife"
import { createSimpleContext } from "./helper"
import { useToast } from "../ui/toast"
import { useLocale } from "./locale"
import { useArgs } from "./args"
import { useSDK } from "./sdk"
import { RGBA } from "@opentui/core"
import { dedupePinned, parsePinnedFromFile, removePinnedId, togglePinnedIds } from "../component/session-pin-state"
import { Filesystem } from "@merakcode/util/filesystem"
import { parseModel } from "@merakcode/util/model"

type PermissionMode = import("@merakcode/sdk/client").PermissionMode

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const sync = useSync()
    const sdk = useSDK()
    const toast = useToast()
    const locale = useLocale()

    function isModelValid(model: { providerID: string; modelID: string }) {
      const provider = sync.data.provider.find((x) => x.id === model.providerID)
      return !!provider?.models[model.modelID]
    }

    function getFirstValidModel(...modelFns: (() => { providerID: string; modelID: string } | undefined)[]) {
      for (const modelFn of modelFns) {
        const model = modelFn()
        if (!model) continue
        if (isModelValid(model)) return model
      }
    }

    const agent = iife(() => {
      const agents = createMemo(() => sync.data.agent.filter((x) => x.mode !== "subagent" && !x.hidden))
      const visibleAgents = createMemo(() => sync.data.agent.filter((x) => !x.hidden))
      const [agentStore, setAgentStore] = createStore<{
        current: string
      }>({
        current: agents()[0].name,
      })
      const { theme } = useTheme()
      const colors = createMemo(() => [
        theme.secondary,
        theme.accent,
        theme.success,
        theme.warning,
        theme.primary,
        theme.error,
        theme.info,
      ])
      return {
        list() {
          return agents()
        },
        current() {
          return agents().find((x) => x.name === agentStore.current)!
        },
        set(name: string) {
          // Match by name or id; a custom agent's name may differ from its id.
          const agent = agents().find((x) => x.name === name || x.id === name)
          if (!agent)
            return toast.show({
              variant: "warning",
              message: locale.t("error.agentNotFound", { name }),
              duration: 3000,
            })
          setAgentStore("current", agent.name)
        },
        move(direction: 1 | -1) {
          batch(() => {
            let next = agents().findIndex((x) => x.name === agentStore.current) + direction
            if (next < 0) next = agents().length - 1
            if (next >= agents().length) next = 0
            const value = agents()[next]
            setAgentStore("current", value.name)
          })
        },
        color(name: string) {
          const index = visibleAgents().findIndex((x) => x.name === name)
          if (index === -1) return colors()[0]
          const agent = visibleAgents()[index]

          if (agent?.color) {
            const color = agent.color
            if (color.startsWith("#")) return RGBA.fromHex(color)
            // already validated by config, just satisfying TS here
            return theme[color as keyof typeof theme] as RGBA
          }
          return colors()[index % colors().length]
        },
      }
    })

    const model = iife(() => {
      const [modelStore, setModelStore] = createStore<{
        ready: boolean
        model: Record<
          string,
          {
            providerID: string
            modelID: string
          }
        >
        recent: {
          providerID: string
          modelID: string
        }[]
        favorite: {
          providerID: string
          modelID: string
        }[]
        variant: Record<string, string | undefined>
      }>({
        ready: false,
        model: {},
        recent: [],
        favorite: [],
        variant: {},
      })

      const file = path.join(Paths.state, "model.json")
      const state = {
        pending: false,
      }

      // Models the user picks are written to the global config `model` (the desktop app writes there too), so
      // fallbackModel restores the last choice after a restart. Writes are serialized; the last switch wins.
      let persisting: Promise<unknown> = Promise.resolve()
      function persistGlobal(value: { providerID: string; modelID: string }) {
        const id = `${value.providerID}/${value.modelID}`
        if (sync.data.config.model === id) return
        persisting = persisting
          .then(() =>
            sdk.client.global.config.update({ config: { model: id }, skipDispose: "true" }, { throwOnError: true }),
          )
          .catch((error) => Log.Product.warn("tui model persist failed", { model: id, ...failure(error) }))
      }

      function save() {
        if (!modelStore.ready) {
          state.pending = true
          return
        }
        state.pending = false
        void Filesystem.write(
          file,
          JSON.stringify({
            recent: modelStore.recent,
            favorite: modelStore.favorite,
            variant: modelStore.variant,
          }),
        ).catch((error) => Log.Product.warn("tui model list save failed", failure(error)))
      }

      Filesystem.readJson(file)
        .then((x) => {
          if (Array.isArray(x.recent)) setModelStore("recent", x.recent)
          if (Array.isArray(x.favorite)) setModelStore("favorite", x.favorite)
          if (typeof x.variant === "object" && x.variant !== null) setModelStore("variant", x.variant)
        })
        .catch(() => {})
        .finally(() => {
          setModelStore("ready", true)
          if (state.pending) save()
        })

      const args = useArgs()
      const fallbackModel = createMemo(() => {
        if (args.model) {
          const { providerID, modelID } = parseModel(args.model)
          if (isModelValid({ providerID, modelID })) {
            return {
              providerID,
              modelID,
            }
          }
        }

        if (sync.data.config.model) {
          const { providerID, modelID } = parseModel(sync.data.config.model)
          if (isModelValid({ providerID, modelID })) {
            return {
              providerID,
              modelID,
            }
          }
        }

        for (const item of modelStore.recent) {
          if (isModelValid(item)) {
            return item
          }
        }

        const provider = sync.data.provider[0]
        if (!provider) return undefined
        const defaultModel = sync.data.provider_default[provider.id]
        const firstModel = Object.values(provider.models)[0]
        const model = defaultModel ?? firstModel?.id
        if (!model) return undefined
        return {
          providerID: provider.id,
          modelID: model,
        }
      })

      const currentModel = createMemo(() => {
        const a = agent.current()
        return (
          getFirstValidModel(
            () => modelStore.model[a.name],
            () => a.model,
            fallbackModel,
          ) ?? undefined
        )
      })

      return {
        current: currentModel,
        get ready() {
          return modelStore.ready
        },
        recent() {
          return modelStore.recent
        },
        favorite() {
          return modelStore.favorite
        },
        parsed: createMemo(() => {
          const value = currentModel()
          if (!value) {
            return {
              provider: locale.t("provider.connectFirst"),
              model: locale.t("error.noModelSelected"),
              reasoning: false,
            }
          }
          const provider = sync.data.provider.find((x) => x.id === value.providerID)
          const info = provider?.models[value.modelID]
          return {
            provider: provider?.name ?? value.providerID,
            model: info?.name ?? value.modelID,
            reasoning: info?.capabilities?.reasoning ?? false,
          }
        }),
        cycle(direction: 1 | -1) {
          const current = currentModel()
          if (!current) return
          const recent = modelStore.recent
          const index = recent.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          if (index === -1) return
          let next = index + direction
          if (next < 0) next = recent.length - 1
          if (next >= recent.length) next = 0
          const val = recent[next]
          if (!val) return
          setModelStore("model", agent.current().name, { ...val })
          persistGlobal(val)
        },
        cycleFavorite(direction: 1 | -1) {
          const favorites = modelStore.favorite.filter((item) => isModelValid(item))
          if (!favorites.length) {
            toast.show({
              variant: "info",
              message: locale.t("error.noFavoriteModels"),
              duration: 3000,
            })
            return
          }
          const current = currentModel()
          let index = -1
          if (current) {
            index = favorites.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          }
          if (index === -1) {
            index = direction === 1 ? 0 : favorites.length - 1
          } else {
            index += direction
            if (index < 0) index = favorites.length - 1
            if (index >= favorites.length) index = 0
          }
          const next = favorites[index]
          if (!next) return
          setModelStore("model", agent.current().name, { ...next })
          const uniq = uniqueBy([next, ...modelStore.recent], (x) => `${x.providerID}/${x.modelID}`)
          if (uniq.length > 10) uniq.pop()
          setModelStore(
            "recent",
            uniq.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
          )
          save()
          persistGlobal(next)
        },
        /** `persist`: an explicit user choice (model picker), saved to global config; CLI args and resumes are not. */
        set(model: { providerID: string; modelID: string }, options?: { recent?: boolean; persist?: boolean }) {
          batch(() => {
            if (!isModelValid(model)) {
              toast.show({
                message: locale.t("error.invalidModel", { id: `${model.providerID}/${model.modelID}` }),
                variant: "warning",
                duration: 3000,
              })
              return
            }
            setModelStore("model", agent.current().name, model)
            if (options?.recent) {
              const uniq = uniqueBy([model, ...modelStore.recent], (x) => `${x.providerID}/${x.modelID}`)
              if (uniq.length > 10) uniq.pop()
              setModelStore(
                "recent",
                uniq.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
              )
              save()
            }
            if (options?.persist) persistGlobal(model)
          })
        },
        toggleFavorite(model: { providerID: string; modelID: string }) {
          batch(() => {
            if (!isModelValid(model)) {
              toast.show({
                message: locale.t("error.invalidModel", { id: `${model.providerID}/${model.modelID}` }),
                variant: "warning",
                duration: 3000,
              })
              return
            }
            const exists = modelStore.favorite.some(
              (x) => x.providerID === model.providerID && x.modelID === model.modelID,
            )
            const next = exists
              ? modelStore.favorite.filter((x) => x.providerID !== model.providerID || x.modelID !== model.modelID)
              : [model, ...modelStore.favorite]
            setModelStore(
              "favorite",
              next.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
            )
            save()
          })
        },
        variant: {
          current() {
            const m = currentModel()
            if (!m) return undefined
            const key = `${m.providerID}/${m.modelID}`
            return modelStore.variant[key]
          },
          list() {
            const m = currentModel()
            if (!m) return []
            const provider = sync.data.provider.find((x) => x.id === m.providerID)
            const info = provider?.models[m.modelID]
            if (!info?.variants) return []
            return Object.keys(info.variants)
          },
          set(value: string | undefined) {
            const m = currentModel()
            if (!m) return
            const key = `${m.providerID}/${m.modelID}`
            setModelStore("variant", key, value)
            save()
          },
          cycle() {
            const variants = this.list()
            if (variants.length === 0) return
            const current = this.current()
            if (!current) {
              this.set(variants[0])
              return
            }
            const index = variants.indexOf(current)
            if (index === -1 || index === variants.length - 1) {
              this.set(undefined)
              return
            }
            this.set(variants[index + 1])
          },
        },
        thinking: {
          /** True only when the model's variants include "off"; other models show no indicator. */
          has() {
            const m = currentModel()
            if (!m) return false
            const provider = sync.data.provider.find((x) => x.id === m.providerID)
            const info = provider?.models[m.modelID]
            if (!info) return false
            return Object.keys(info.variants ?? {}).includes("off")
          },
          /** Whether thinking is on: on unless "off" is selected (models think by default). */
          on() {
            const m = currentModel()
            if (!m) return true
            const key = `${m.providerID}/${m.modelID}`
            return modelStore.variant[key] !== "off"
          },
          /** Toggles thinking; returns false if the model has no off variant (the caller reports it as unsupported). */
          toggle() {
            const m = currentModel()
            if (!m) return false
            const provider = sync.data.provider.find((x) => x.id === m.providerID)
            const info = provider?.models[m.modelID]
            if (!info?.variants || !Object.keys(info.variants).includes("off")) return false
            const key = `${m.providerID}/${m.modelID}`
            setModelStore("variant", key, modelStore.variant[key] === "off" ? undefined : "off")
            save()
            return true
          },
        },
      }
    })

    const mcp = {
      isEnabled(name: string) {
        const status = sync.data.mcp[name]
        return status?.status === "connected"
      },
      async toggle(name: string) {
        const status = sync.data.mcp[name]
        if (status?.status === "connected") {
          // Disable: disconnect the MCP
          await sdk.client.mcp.disconnect({ name }, { throwOnError: true })
        } else {
          // Enable/Retry: connect the MCP (handles disabled, failed, and other states)
          await sdk.client.mcp.connect({ name }, { throwOnError: true })
        }
      },
    }

    const permissionMode = iife(() => {
      // --auto starts in auto mode; the first prompt sends it to the engine, and it can still be switched later.
      const args = useArgs()
      const [store, setStore] = createStore<{ current: PermissionMode }>({
        current: args.auto ? "auto" : "ask",
      })
      return {
        current() {
          return store.current
        },
        set(value: PermissionMode | undefined) {
          setStore("current", value ?? "ask")
        },
        /** readonly → ask → auto → readonly */
        cycle() {
          const order: PermissionMode[] = ["readonly", "ask", "auto"]
          setStore("current", order[(order.indexOf(store.current) + 1) % order.length]!)
        },
      }
    })

    const session = iife(() => {
      const event = useEvent()
      const log = Log.create({ source: "product", service: "tui.session" })
      const [sessionStore, setSessionStore] = createStore<{
        ready: boolean
        pinned: string[]
        deleting: string | undefined
      }>({
        ready: false,
        pinned: [],
        deleting: undefined,
      })

      const file = path.join(Paths.state, "session.json")
      const state = {
        pending: false,
      }

      function save() {
        if (!sessionStore.ready) {
          state.pending = true
          return
        }
        state.pending = false
        const pinned = dedupePinned(sessionStore.pinned)
        if (pinned.length !== sessionStore.pinned.length) {
          setSessionStore("pinned", pinned)
        }
        void Filesystem.write(file, JSON.stringify({ pinned })).catch((err) => {
          log.error("failed to save session pins", { err })
        })
      }

      Filesystem.readJson(file)
        .then((x) => {
          setSessionStore("pinned", parsePinnedFromFile(x))
        })
        .catch(() => {})
        .finally(() => {
          setSessionStore("ready", true)
          if (state.pending) save()
        })

      const unsubscribe = event.on("session.deleted", (evt) => {
        const sessionID = evt.properties.info.id
        if (!sessionStore.pinned.includes(sessionID)) return
        batch(() => {
          setSessionStore("pinned", removePinnedId(sessionStore.pinned, sessionID))
          save()
        })
      })
      onCleanup(unsubscribe)

      return {
        get ready() {
          return sessionStore.ready
        },
        pinned() {
          return sessionStore.pinned
        },
        isPinned(sessionID: string) {
          return sessionStore.pinned.includes(sessionID)
        },
        togglePin(sessionID: string) {
          batch(() => {
            setSessionStore("pinned", togglePinnedIds(sessionStore.pinned, sessionID))
            save()
          })
        },
        deleting() {
          return sessionStore.deleting
        },
        beginDelete(sessionID: string) {
          if (sessionStore.deleting) return false
          setSessionStore("deleting", sessionID)
          return true
        },
        finishDelete(sessionID: string) {
          if (sessionStore.deleting !== sessionID) return
          setSessionStore("deleting", undefined)
        },
      }
    })

    // Automatically update model when agent changes
    createEffect(() => {
      const value = agent.current()
      if (value.model) {
        if (isModelValid(value.model))
          model.set({
            providerID: value.model.providerID,
            modelID: value.model.modelID,
          })
        else
          toast.show({
            variant: "warning",
            message: locale.t("error.agentModelInvalid", {
              name: value.name,
              id: `${value.model.providerID}/${value.model.modelID}`,
            }),
            duration: 3000,
          })
      }
    })

    const result = {
      model,
      agent,
      permissionMode,
      mcp,
      session,
    }
    return result
  },
})
