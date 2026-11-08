import type { GitState } from "@merakcode/sdk"
import { createEffect, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { client } from "../../state/client"
import { checkoutOf, gitDirectory, updateCheckout } from "../../state/git"
import { listen } from "../../state/store"
import { sameDir } from "../../lib/route"

type Entry = { data?: GitState; error?: Error; loading: boolean }
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
    setEntries(target, (previous) => ({ ...previous, loading: true, error: undefined }))
    try {
      const result = await (await client()).repo.status({ directory: dir })
      if (requests.get(target) !== request) return
      setEntries(target, { data: result, loading: false, error: undefined })
      updateCheckout(dir, {
        branch: result.branch || null,
        head: result.head || null,
        checkout: `${result.branch}:${result.head}`,
      })
    } catch (error) {
      if (requests.get(target) === request) setEntries(target, { loading: false, error: error as Error })
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending = false
  const reload = () => {
    if (entry()?.loading) {
      pending = true
      return
    }
    pending = false
    void refresh()
  }
  createEffect(on([directory, () => checkoutOf(directory())], reload))
  createEffect(
    on(
      () => entry()?.loading,
      (loading) => {
        if (!loading && pending) reload()
      },
    ),
  )
  onCleanup(
    listen((dir, event) => {
      if (!sameDir(dir, directory()) || !["turn.finished", "repo.changed", "file.changed"].includes(event.type)) return
      clearTimeout(timer)
      timer = setTimeout(reload, 250)
    }),
  )
  onCleanup(() => clearTimeout(timer))
  return { data: () => entry()?.data, error: () => entry()?.error, loading: () => !!entry()?.loading, refresh }
}
