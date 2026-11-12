import { createEffect, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { client } from "../../state/client"
import { checkoutOf, gitDirectory, updateCheckout } from "../../state/git"
import { listen } from "../../state/store"
import { sameDir } from "../../lib/route"
import { toast } from "../../ui/toast"

export type GitChangeFile = { file: string; status: string }
/** What the repository holds apart from the commit: the index and the working tree, with the facts a push needs. */
export type GitChangesResult = {
  checkout: string | null
  staged: GitChangeFile[]
  unstaged: GitChangeFile[]
  remote?: string
  upstream?: boolean
  ahead?: number
  behind?: number
}

type Entry = { data?: GitChangesResult; error?: Error; loading: boolean; working: boolean }
const [entries, setEntries] = createStore<Record<string, Entry>>({})
const requests = new Map<string, number>()

async function readChanges(directory: string): Promise<GitChangesResult> {
  const status = await (await client()).repo.status({ directory })
  const files = status.files ?? []
  const file = (item: (typeof files)[number]) => ({ file: item.path, status: item.status })
  return {
    checkout: `${status.branch}:${status.head}`,
    staged: files.filter((item) => item.staged).map(file),
    unstaged: files.filter((item) => item.unstaged || !item.staged).map(file),
    remote: status.remote,
    upstream: !!status.upstream,
    ahead: status.ahead ?? 0,
    behind: status.behind ?? 0,
  }
}

/** The repository summary of a directory, shared with the commit form. */
export const changesOf = (directory: string) => entries[gitDirectory(directory)]?.data

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
      const result = await readChanges(dir)
      if (requests.get(target) !== request) return
      setEntries(target, (previous) => ({ ...previous, data: result, loading: false, error: undefined }))
      const [branch, head] = [result.checkout?.split(":")[0], result.checkout?.split(":").slice(1).join(":")]
      updateCheckout(dir, { branch: branch || null, head: head || null, checkout: result.checkout })
    } catch (error) {
      if (requests.get(target) === request) setEntries(target, { loading: false, error: error as Error })
    } finally {
      if (requests.get(target) === request) setEntries(target, "loading", false)
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending = false
  const backgroundRefresh = () => {
    // Let an in-flight refresh publish before replaying background invalidations.
    if (entry()?.working || entry()?.loading) {
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
      () => entry()?.working || entry()?.loading,
      (busy) => {
        if (!busy && pending) backgroundRefresh()
      },
    ),
  )
  onCleanup(
    listen((dir, event) => {
      if (!sameDir(gitDirectory(dir), key())) return
      if (["turn.finished", "repo.changed", "file.changed"].includes(event.type)) schedule()
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
      const connection = await client()
      const paths = files.map((item) => item.file)
      if (action === "stage") await connection.repo.stage({ directory: dir, paths })
      else await connection.repo.unstage({ directory: dir, paths })
    } catch (error) {
      toast({ kind: "error", title: (error as Error).message, error })
    } finally {
      try {
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
