import type * as Monaco from "monaco-editor"
import type { FileContent } from "@merakcode/sdk/client"
import { createStore } from "solid-js/store"
import { t } from "../../i18n"
import { sameDir } from "../../lib/route"
import { call, client } from "../../state/client"
import { checkoutOf, gitDirectory, onCheckoutChange, refreshBranches, registerDirty, switching } from "../../state/git"
import { readDraft, writeDraft } from "./draft"
import { toast } from "../../ui/toast"
import { listen } from "../../state/store"

type Tab = {
  path: string
  planSessionID?: string
  checksum?: string
  saved: string
  dirty: boolean
  binary: boolean
  preview?: string
  conflict?: boolean
  original?: string
  missing?: boolean
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
    if (!buffer.release()) return false
    buffers.delete(key)
  }
  return true
}

function createBuffers(directory: string) {
  let closed = false
  const [tabs, setTabs] = createStore<Tab[]>([])
  const [errors, setErrors] = createStore<Record<string, string | undefined>>({})
  const pending = new Map<string, Promise<void>>()
  const saving = new Map<string, Promise<void>>()
  const views = new Map<string, Set<string>>()
  const dirty = new Map<string, boolean>()
  const epochs = new Map<string, number>()
  const sync = () => {
    for (const tab of tabs) dirty.set(tab.path, tab.dirty)
    registerDirty(directory, `editor:${directory}`, [...dirty.values()].filter(Boolean).length)
  }

  const read = async (path: string, planSessionID?: string): Promise<FileContent> => {
    if (!planSessionID) return call(client(directory).file.read({ path }))
    const plan = await call(client(directory).session.planGet({ sessionID: planSessionID }))
    return { type: "text" as const, content: plan.content, checksum: String(plan.revision) }
  }

  const open = async (path: string, planSessionID?: string) => {
    if (closed) return
    setErrors(path, undefined)
    if (tabs.some((tab) => tab.path === path)) return
    const known = pending.get(path)
    if (known) return known
    const epoch = epochs.get(path) ?? 0
    let retry = false
    const request = (async () => {
      if (checkoutOf(directory) === undefined) await refreshBranches(directory)
      const token = checkoutOf(directory)
      const content = await read(path, planSessionID).catch((error: Error) => {
        setErrors(path, error.message)
        return undefined
      })
      if (!content || closed) return
      if (checkoutOf(directory) !== token) {
        retry = true
        return
      }
      const draft = await readDraft(directory, path)
      const binary = content.type === "binary" || content.encoding === "base64"
      const preview =
        content.encoding === "base64" && content.mimeType?.startsWith("image/")
          ? `data:${content.mimeType};base64,${content.content}`
          : undefined
      const { monaco: loaded } = await loadMonaco()
      if (checkoutOf(directory) !== token) {
        retry = true
        return
      }
      if (closed || (epochs.get(path) ?? 0) !== epoch || tabs.some((tab) => tab.path === path)) return
      const uri = loaded.Uri.parse(
        `merakcode://editor/${encodeURIComponent(gitDirectory(directory))}/${path.split(/[\\/]/).map(encodeURIComponent).join("/")}`,
      )
      const model = binary ? undefined : loaded.editor.createModel(draft?.content ?? content.content, undefined, uri)
      model?.onDidChangeContent(() => {
        const tab = tabs.find((item) => item.path === path)
        if (!tab) return
        setTabs((item) => item.path === path, "dirty", model.getValue() !== tab.saved)
        sync()
        void writeDraft(
          directory,
          path,
          tab.dirty ? { content: model.getValue(), saved: tab.saved, checksum: tab.checksum } : undefined,
        ).catch(() => toast({ kind: "error", title: t("panel.persistError") }))
      })
      setTabs((list) => [
        ...list,
        {
          path,
          planSessionID,
          checksum: draft?.checksum ?? content.checksum,
          saved: draft?.saved ?? content.content,
          dirty: !binary && !!draft,
          conflict: !!draft && draft.checksum !== content.checksum,
          original: content.baselines?.head ?? content.content,
          missing: content.missing,
          binary,
          preview,
          model,
        },
      ])
      sync()
    })()
    pending.set(path, request)
    try {
      await request
    } catch (error) {
      setErrors(path, String(error))
    } finally {
      if (pending.get(path) === request) pending.delete(path)
    }
    if (retry && !closed && (epochs.get(path) ?? 0) === epoch) await open(path, planSessionID)
  }

  const reload = async (branchChanged = false) => {
    await Promise.all(saving.values())
    const token = checkoutOf(directory)
    await Promise.all(
      tabs.map(async (tab) => {
        const fresh = await read(tab.path, tab.planSessionID).catch(() => undefined)
        if (
          closed ||
          token !== checkoutOf(directory) ||
          tabs.find((item) => item.path === tab.path)?.model !== tab.model
        )
          return
        if (fresh && tab.binary) {
          setTabs((item) => item.path === tab.path, {
            preview:
              !fresh.missing && fresh.encoding === "base64" && fresh.mimeType?.startsWith("image/")
                ? `data:${fresh.mimeType};base64,${fresh.content}`
                : undefined,
            checksum: fresh.checksum,
            missing: fresh.missing,
          })
          return
        }
        if (fresh)
          setTabs((item) => item.path === tab.path, {
            original: fresh.baselines?.head ?? fresh.content,
            missing: fresh.missing,
          })
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
          original: fresh.baselines?.head ?? fresh.content,
          missing: fresh.missing,
        })
        tab.model?.setValue(fresh.content)
        setTabs((item) => item.path === tab.path, "dirty", false)
        sync()
      }),
    )
  }

  const saveFile = async (force = false, path?: string) => {
    if (closed || switching(directory)) return
    const tab = tabs.find((item) => item.path === path)
    if (!tab?.model || !tab.dirty || tab.binary || tab.missing) return
    const token = checkoutOf(directory)
    const content = tab.model.getValue()
    const result = tab.planSessionID
      ? await client(directory).session.planSave({
          sessionID: tab.planSessionID,
          content,
          expectedRevision: Number(tab.checksum ?? 0),
        })
      : await client(directory).file.write({
          path: tab.path,
          content,
          ...(force || !tab.checksum ? {} : { checksum: tab.checksum }),
        })
    if (result.response?.status === 409) {
      toast({
        kind: "error",
        title: t("code.conflict"),
        action: tab.planSessionID ? undefined : { label: t("code.overwrite"), run: () => void save(true, path) },
      })
      return
    }
    if (result.error) return toast({ kind: "error", title: t("error.request", { message: String(result.error) }) })
    if (token !== checkoutOf(directory)) return
    const checksum = "revision" in result.data! ? String(result.data.revision) : result.data!.checksum
    setTabs((item) => item.path === tab.path, {
      saved: content,
      dirty: tab.model.getValue() !== content,
      checksum,
      conflict: false,
    })
    await writeDraft(
      directory,
      tab.path,
      tab.dirty ? { content: tab.model.getValue(), saved: content, checksum } : undefined,
    )
    sync()
  }

  const save = (force = false, path?: string) => {
    if (!path) return Promise.resolve()
    const request = (saving.get(path) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        await saveFile(force, path)
      })
    saving.set(path, request)
    void request
      .finally(() => {
        if (saving.get(path) === request) saving.delete(path)
      })
      .catch(() => {})
    return request
  }

  const close = async (path: string) => {
    epochs.set(path, (epochs.get(path) ?? 0) + 1)
    pending.delete(path)
    await saving.get(path)
    await writeDraft(directory, path)
    const tab = tabs.find((item) => item.path === path)
    setTabs((list) => list.filter((item) => item.path !== path))
    tab?.model?.dispose()
    dirty.delete(path)
    sync()
  }
  const release = () => {
    if (saving.size) return false
    closed = true
    const previous = [...tabs]
    setTabs([])
    for (const tab of previous) tab.model?.dispose()
    registerDirty(directory, `editor:${directory}`, 0)
    return true
  }
  const retain = (path: string, id: string) => {
    const references = views.get(path) ?? new Set<string>()
    references.add(id)
    views.set(path, references)
  }
  const suspend = async (path: string, id: string) => {
    views.get(path)?.delete(id)
    await pending.get(path)
    await saving.get(path)
    if (views.get(path)?.size) return
    const tab = tabs.find((item) => item.path === path)
    if (!tab) return
    if (tab.dirty && tab.model)
      await writeDraft(directory, path, { content: tab.model.getValue(), saved: tab.saved, checksum: tab.checksum })
    if (views.get(path)?.size || tabs.find((item) => item.path === path)?.model !== tab.model) return
    setTabs((list) => list.filter((item) => item.path !== path))
    tab.model?.dispose()
  }
  const savePlan = async (sessionID: string) => {
    const plan = await call(client(directory).session.planGet({ sessionID }))
    const tab = tabs.find((item) => item.planSessionID === plan.sessionID)
    if (!tab?.dirty) return true
    await save(false, tab.path)
    return !tab.dirty
  }
  return { tabs, errors, open, save, savePlan, close, reload, release, suspend, retain }
}

onCheckoutChange((directory, change) => {
  for (const [key, buffer] of buffers)
    if (sameDir(gitDirectory(key), directory)) void buffer.reload(change.branchChanged)
})

listen((_directory, event) => {
  if (event.type !== "session.plan.updated") return
  for (const buffer of buffers.values())
    if (buffer.tabs.some((tab) => tab.planSessionID === event.properties.sessionID)) void buffer.reload()
})
