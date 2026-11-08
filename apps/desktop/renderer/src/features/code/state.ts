import type * as Monaco from "monaco-editor"
import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { client } from "../../state/client"
import { checkoutOf, gitDirectory, onCheckoutChange } from "../../state/git"
import { sameDir } from "../../lib/route"
import { t } from "../../i18n"
import { toast } from "../../ui/toast"

type Tab = { path: string; binary: boolean; model?: Monaco.editor.ITextModel }
const buffers = new Map<string, ReturnType<typeof createBuffers>>()
let monaco: Promise<typeof import("../../lib/monaco")> | undefined
export const loadMonaco = () => (monaco ??= import("../../lib/monaco"))
export function buffersFor(directory: string) {
  const key = gitDirectory(directory)
  const existing = buffers.get(key)
  if (existing) return existing
  const created = createBuffers(directory)
  buffers.set(key, created)
  return created
}
export function releaseBuffers(directory: string) {
  const key = gitDirectory(directory)
  buffers.get(key)?.release()
  buffers.delete(key)
  return true
}
function createBuffers(directory: string) {
  const [tabs, setTabs] = createStore<Tab[]>([])
  const [active, setActive] = createSignal<string>()
  let closed = false
  let epoch = 0
  const pending = new Map<string, Promise<void>>()
  const close = (path: string) => {
    tabs.find((tab) => tab.path === path)?.model?.dispose()
    setTabs((list) => list.filter((tab) => tab.path !== path))
    if (active() === path) setActive(tabs.at(-1)?.path)
  }
  const open = async (path: string): Promise<void> => {
    if (closed) return
    if (tabs.some((tab) => tab.path === path)) return void setActive(path)
    if (pending.has(path)) return pending.get(path)
    const generation = epoch
    const token = checkoutOf(directory)
    let retry = false
    const request = (async () => {
      const content = await (await client()).file.read({ directory, path })
      const { monaco: loaded } = await loadMonaco()
      if (closed) return
      if (epoch !== generation || checkoutOf(directory) !== token) {
        retry = true
        return
      }
      const binary = content.type === "binary"
      const uri = loaded.Uri.parse(
        `merakcode://editor/${encodeURIComponent(directory)}/${path.split(/[\\/]/).map(encodeURIComponent).join("/")}`,
      )
      const model = binary ? undefined : loaded.editor.createModel(content.content, undefined, uri)
      setTabs((list) => [...list, { path, binary, model }])
      setActive(path)
    })()
    pending.set(path, request)
    try {
      await request
    } catch (error) {
      toast({ kind: "error", title: t("code.loadFailed"), error })
    } finally {
      pending.delete(path)
    }
    if (retry) await open(path)
  }
  const stop = onCheckoutChange((changed) => {
    if (!sameDir(changed, directory)) return
    epoch++
    const paths = tabs.map((tab) => tab.path)
    paths.forEach(close)
    for (const path of paths) void open(path)
  })
  return {
    tabs,
    active,
    setActive,
    open,
    close,
    release: () => {
      closed = true
      stop()
      tabs.forEach((tab) => tab.model?.dispose())
      setTabs([])
    },
  }
}
