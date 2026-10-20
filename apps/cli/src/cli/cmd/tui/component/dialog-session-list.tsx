import { useDialog } from "../ui/dialog"
import { DialogSelect, type DialogSelectRef } from "../ui/dialog-select"
import { useRoute } from "../context/route"
import { useSync } from "../context/sync"
import { useLocal } from "../context/local"
import { createEffect, createMemo, createSignal, createResource, onCleanup, onMount } from "solid-js"
import { reconcile } from "solid-js/store"
import { Locale } from "@merakcode/util/locale"
import { useKeybind } from "../context/keybind"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import { DialogSessionRename } from "./dialog-session-rename"
import { createDebouncedSignal } from "../util/signal"
import { Spinner } from "./spinner"
import { useLocale } from "../context/locale"
import { buildSessionListOptions } from "./session-list-options"
import {
  moveSessionDelete,
  removeSessionTree,
  retainSessionDelete,
  sessionRouteAfterDelete,
  triggerSessionDelete,
} from "./session-delete-state"
import { useToast } from "../ui/toast"

export function DialogSessionList() {
  const dialog = useDialog()
  const route = useRoute()
  const sync = useSync()
  const local = useLocal()
  const keybind = useKeybind()
  const { theme } = useTheme()
  const sdk = useSDK()
  const locale = useLocale()
  const toast = useToast()

  const [pendingDelete, setPendingDelete] = createSignal<string>()
  const [removed, setRemoved] = createSignal<string[]>([])
  const [search, setSearch] = createDebouncedSignal("", 150)
  let selectRef: DialogSelectRef<string> | undefined
  let active = true

  const deleting = () => local.session.deleting()

  onMount(() => {
    const start = Date.now() - 30 * 24 * 60 * 60 * 1000
    void sdk.client.session
      .list({ start })
      .then((x) => {
        if (!active) return
        const sessions = (x.data ?? []).toSorted((a, b) => a.id.localeCompare(b.id))
        sync.set("session", reconcile(sessions))
      })
      .catch(() => {})
  })

  const [searchResults, { mutate: mutateSearchResults }] = createResource(search, async (query) => {
    if (!query) return undefined
    const result = await sdk.client.session.list({ search: query, limit: 30 })
    return result.data ?? []
  })

  const currentSessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))

  const sessions = createMemo(() => {
    const source = searchResults() ?? sync.data.session
    if (removed().length === 0) return source
    const ids = new Set(removed())
    return source.filter((session) => !ids.has(session.id))
  })

  const options = createMemo(() => {
    const today = new Date().toDateString()
    const source = sessions()
    const session = new Map(source.map((item) => [item.id, item]))
    return buildSessionListOptions({
      sessions: source,
      pinnedIds: local.session.pinned(),
      today,
      todayLabel: locale.t("common.today"),
      pinnedSectionLabel: locale.t("session.pinnedSection"),
    }).map((option) => {
      const item = session.get(option.value)
      const isPending = pendingDelete() === option.value
      const isDeleting = deleting() === option.value
      const status = item ? sync.data.session_status?.[item.id] : undefined
      const isWorking = status?.type === "busy"
      return {
        title: isDeleting
          ? locale.t("session.deleting")
          : isPending
            ? locale.t("session.deleteConfirm", { key: keybind.print("session_delete") })
            : option.title,
        bg: isPending || isDeleting ? theme.error : undefined,
        value: option.value,
        category: option.category,
        footer: item ? Locale.time(item.time.updated) : undefined,
        gutter: isDeleting || isWorking ? <Spinner /> : undefined,
      }
    })
  })

  createEffect(() => {
    setPendingDelete(
      retainSessionDelete(
        pendingDelete(),
        options().map((option) => option.value),
      ),
    )
  })

  onMount(() => {
    dialog.setSize("large")
    const start = Date.now() - 30 * 24 * 60 * 60 * 1000
    void sdk.client.session.list({ start }).then((res) => {
      if (!active) return
      const sessions = (res.data ?? []).toSorted((a, b) => a.id.localeCompare(b.id))
      sync.set("session", reconcile(sessions))
    })
  })
  onCleanup(() => {
    active = false
  })

  return (
    <DialogSelect
      ref={(ref) => {
        selectRef = ref
      }}
      title={locale.t("dialog.sessions")}
      options={options()}
      skipFilter={true}
      preserveSelection={true}
      current={currentSessionID()}
      onFilter={(query) => {
        if (deleting()) return
        setPendingDelete(undefined)
        setSearch(query)
      }}
      onMove={(option) => {
        setPendingDelete(moveSessionDelete(pendingDelete(), option.value))
      }}
      onSelect={(option) => {
        if (deleting()) return
        route.navigate({
          type: "session",
          sessionID: option.value,
        })
        dialog.clear()
      }}
      keybind={[
        {
          keybind: keybind.all.session_delete?.[0],
          title: locale.t("common.delete"),
          onTrigger: (option) => {
            if (deleting()) return
            const action = triggerSessionDelete(pendingDelete(), option.value)
            if (action.type === "pending") {
              setPendingDelete(action.sessionID)
              return
            }

            const target = sessionRouteAfterDelete(
              currentSessionID(),
              action.sessionID,
              options().map((item) => item.value),
            )
            if (!local.session.beginDelete(action.sessionID)) return
            void sdk.client.session
              .delete({ sessionID: action.sessionID }, { throwOnError: true })
              .then((response) => {
                if (response.data !== true) throw new Error(locale.t("error.sessionDeleteFailed"))

                if (active) setRemoved((ids) => [...ids, action.sessionID])
                sync.set("session", removeSessionTree(sync.data.session, action.sessionID))
                if (active)
                  mutateSearchResults((results) => (results ? removeSessionTree(results, action.sessionID) : results))
                if (!target) return
                if (route.data.type === "session" && route.data.sessionID === action.sessionID) route.navigate(target)
              })
              .catch((error) => {
                const message =
                  error instanceof Error && error.message ? error.message : locale.t("error.sessionDeleteFailed")
                toast.show({ variant: "error", message })
              })
              .finally(() => {
                local.session.finishDelete(action.sessionID)
                if (!active) return
                setPendingDelete(undefined)
              })
          },
        },
        {
          keybind: keybind.all.session_pin_toggle?.[0],
          title: locale.t("session.pinToggle"),
          disabled: !local.session.ready,
          onTrigger: (option) => {
            if (deleting()) return
            setPendingDelete(undefined)
            // Pin the selection to this value without centering; preserveSelection follows it after the reorder.
            selectRef?.moveTo(option.value, false)
            local.session.togglePin(option.value)
          },
        },
        {
          keybind: keybind.all.session_rename?.[0],
          title: locale.t("common.rename"),
          onTrigger: async (option) => {
            if (deleting()) return
            dialog.replace(() => <DialogSessionRename session={option.value} />)
          },
        },
      ]}
    />
  )
}
