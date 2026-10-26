import type * as Monaco from "monaco-editor"
import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { t } from "../../i18n"
import { sameDir } from "../../lib/route"
import { call, client } from "../../state/client"
import { checkoutOf, gitDirectory, onCheckoutChange, refreshBranches, registerDirty, switching } from "../../state/git"
import { toast } from "../../ui/toast"

type Tab = {
  path: string
  checksum?: string
  saved: string
  dirty: boolean
  binary: boolean
  conflict?: boolean
  model?: Monaco.editor.ITextModel
}
const buffers = new Map<string, ReturnType<typeof createBuffers>>()
let monaco: Promise<typeof import("../../lib/monaco")> | undefined
export const loadMonaco = () => (monaco ??= import("../../lib/monaco"))

/** Buffers belong to the checkout, independently of whether the code panel is mounted. */
export function buffersFor(directory: string) {
  const key = gitDirectory(directory)
  const known = buffers.get(key)
  if (known) return known
  for (const [directory, buffer] of buffers) if (sameDir(gitDirectory(directory), key)) return buffer
  const created = createBuffers(directory)
  buffers.set(key, created)
  return created
}

/** Closing a project releases clean models; dirty models require an explicit save or discard first. */
export function releaseBuffers(directory: string) {
  for (const [key, buffer] of buffers) {
    if (!sameDir(gitDirectory(key), gitDirectory(directory))) continue
    if (buffer.tabs.some((tab) => tab.dirty)) return false
    buffer.release()
    buffers.delete(key)
  }
  return true
}

function createBuffers(directory: string) {
  let closed = false
  const [tabs, setTabs] = createStore<Tab[]>([])
  const [active, setActive] = createSignal<string>()
  const pending = new Map<string, Promise<void>>()
  const sync = () => registerDirty(directory, `editor:${directory}`, tabs.filter((tab) => tab.dirty).length)

  const open = async (path: string) => {
    if (closed) return
    if (tabs.some((tab) => tab.path === path)) return void setActive(path)
    const known = pending.get(path)
    if (known) return known
    let retry = false
    const request = (async () => {
      if (checkoutOf(directory) === undefined) await refreshBranches(directory)
      const token = checkoutOf(directory)
      const content = await call(client(directory).file.read({ path })).catch((error: Error) => {
        toast({ kind: "error", title: t("error.request", { message: error.message }), error })
        return undefined
      })
      if (!content || closed) return
      if (checkoutOf(directory) !== token) {
        retry = true
        return
      }
      const binary = content.type === "binary"
      const { monaco: loaded } = await loadMonaco()
      if (checkoutOf(directory) !== token) {
        retry = true
        return
      }
      if (closed || tabs.some((tab) => tab.path === path)) return
      const uri = loaded.Uri.parse(
        `merakcode://editor/${encodeURIComponent(gitDirectory(directory))}/${path.split(/[\\/]/).map(encodeURIComponent).join("/")}`,
      )
      const model = binary ? undefined : loaded.editor.createModel(content.content, undefined, uri)
      model?.onDidChangeContent(() => {
        const tab = tabs.find((item) => item.path === path)
        if (!tab) return
        setTabs((item) => item.path === path, "dirty", model.getValue() !== tab.saved)
        sync()
      })
      setTabs((list) => [
        ...list,
        { path, checksum: content.checksum, saved: content.content, dirty: false, binary, model },
      ])
      setActive(path)
    })()
    pending.set(path, request)
    try {
      await request
    } finally {
      pending.delete(path)
    }
    if (retry && !closed) await open(path)
  }

  const reload = async (branchChanged = false) => {
    const token = checkoutOf(directory)
    await Promise.all(
      tabs.map(async (tab) => {
        const fresh = await call(client(directory).file.read({ path: tab.path })).catch(() => undefined)
        if (closed || token !== checkoutOf(directory) || !tabs.some((item) => item.path === tab.path)) return
        if (branchChanged && tab.dirty) {
          const conflict = tab.conflict
          setTabs((item) => item.path === tab.path, "conflict", true)
          if (!conflict) toast({ kind: "info", title: t("code.branchConflict") })
          return
        }
        if (fresh?.checksum === tab.checksum) return
        if (tab.dirty || !fresh) {
          const conflict = tab.conflict
          setTabs((item) => item.path === tab.path, "conflict", true)
          if (!conflict) toast({ kind: "info", title: t("code.branchConflict") })
          return
        }
        // Update the saved baseline before setValue emits its content-change event.
        setTabs((item) => item.path === tab.path, {
          checksum: fresh.checksum,
          saved: fresh.content,
          binary: fresh.type === "binary",
          conflict: false,
        })
        tab.model?.setValue(fresh.content)
        setTabs((item) => item.path === tab.path, "dirty", false)
        sync()
      }),
    )
  }

  const save = async (force = false) => {
    if (closed || switching(directory)) return
    const tab = tabs.find((item) => item.path === active())
    if (!tab?.model) return
    const token = checkoutOf(directory)
    const content = tab.model.getValue()
    const result = await client(directory).file.write({
      path: tab.path,
      content,
      ...(force || !tab.checksum ? {} : { checksum: tab.checksum }),
    })
    if (result.response?.status === 409) {
      toast({
        kind: "error",
        title: t("code.conflict"),
        action: { label: t("code.overwrite"), run: () => void save(true) },
      })
      return
    }
    if (result.error) return toast({ kind: "error", title: t("error.request", { message: String(result.error) }) })
    if (token !== checkoutOf(directory)) return
    const fresh = await call(client(directory).file.read({ path: tab.path })).catch(() => undefined)
    if (token !== checkoutOf(directory)) return
    setTabs((item) => item.path === tab.path, {
      saved: content,
      dirty: tab.model.getValue() !== content,
      checksum: fresh?.checksum,
      conflict: false,
    })
    sync()
  }

  const close = (path: string) => {
    const tab = tabs.find((item) => item.path === path)
    tab?.model?.dispose()
    setTabs((list) => list.filter((item) => item.path !== path))
    if (active() === path) setActive(tabs.at(-1)?.path)
    sync()
  }
  const release = () => {
    closed = true
    for (const tab of tabs) tab.model?.dispose()
    registerDirty(directory, `editor:${directory}`, 0)
  }
  return { tabs, active, setActive, open, save, close, reload, release }
}

onCheckoutChange((directory, change) => {
  for (const [key, buffer] of buffers)
    if (sameDir(gitDirectory(key), directory)) void buffer.reload(change.branchChanged)
})
