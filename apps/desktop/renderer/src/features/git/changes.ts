import type { GitChangeFile, GitChangesResult } from "@merakcode/sdk/client"
import { createEffect, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { t } from "../../i18n"
import { sameDir } from "../../lib/route"
import { call, client } from "../../state/client"
import { checkoutOf, gitDirectory } from "../../state/git"
import { listen, refreshVcs } from "../../state/store"
import { toast } from "../../ui/toast"

type Entry = { data?: GitChangesResult; error?: Error; loading: boolean; working: boolean }
const [entries, setEntries] = createStore<Record<string, Entry>>({})
const requests = new Map<string, number>()

export function useGitChanges(directory: () => string) {
  const key = () => gitDirectory(directory())
  const entry = () => entries[key()]
  const refresh = async () => {
    const dir = directory()
    const target = gitDirectory(dir)
    const request = (requests.get(target) ?? 0) + 1
    requests.set(target, request)
    setEntries(target, (previous) => ({
      ...previous,
      working: previous?.working ?? false,
      loading: true,
      error: undefined,
    }))
    try {
      const result = await call(client(dir).vcs.changes.get())
      if (requests.get(target) !== request) return
      if (result.checkout !== (checkoutOf(dir) ?? null)) await refreshVcs(dir)
      if (requests.get(target) !== request || result.checkout !== (checkoutOf(dir) ?? null)) return
      setEntries(gitDirectory(dir), (previous) => ({ ...previous, data: result, loading: false, error: undefined }))
    } catch (error) {
      if (requests.get(target) === request) setEntries(target, { loading: false, error: error as Error })
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending = false
  const backgroundRefresh = () => {
    // Do not supersede the refresh awaited by an index action.
    if (entry()?.working) {
      pending = true
      return
    }
    pending = false
    void refresh()
  }
  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(backgroundRefresh, 250)
  }
  createEffect(on([directory, () => checkoutOf(directory())], backgroundRefresh))
  createEffect(
    on(
      () => entry()?.working,
      (working) => {
        if (!working && pending) backgroundRefresh()
      },
    ),
  )
  onCleanup(
    listen((dir, event) => {
      if (!sameDir(gitDirectory(dir), key())) return
      if (
        [
          "vcs.changes.updated",
          "vcs.head.updated",
          "file.watcher.updated",
          "review.updated",
          "message.part.updated",
        ].includes(event.type)
      )
        schedule()
    }),
  )
  window.addEventListener("focus", schedule)
  onCleanup(() => {
    clearTimeout(timer)
    window.removeEventListener("focus", schedule)
  })
  const change = async (action: "stage" | "unstage", files: GitChangeFile[]) => {
    const current = entry()?.data
    if (!current || entry()?.working || !files.length) return
    const dir = directory()
    const target = key()
    setEntries(target, "working", true)
    try {
      await call(client(dir).vcs.changes[action]({ expectedCheckout: current.checkout, files }))
    } catch (error) {
      toast({
        kind: (error as { status?: number }).status === 409 ? "info" : "error",
        title: (error as { status?: number }).status === 409 ? t("git.stale") : (error as Error).message,
        error,
      })
    } finally {
      try {
        await refreshVcs(dir)
        if (sameDir(directory(), dir)) await refresh()
      } finally {
        setEntries(target, "working", false)
      }
    }
  }
  return {
    data: () => entry()?.data,
    loading: () => !!entry()?.loading,
    error: () => entry()?.error,
    working: () => !!entry()?.working,
    setWorking: (value: boolean) => setEntries(key(), "working", value),
    refresh,
    change,
  }
}
