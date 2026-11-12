import type * as Monaco from "monaco-editor"
import type { EngineFileContent as FileContent } from "@merakcode/sdk"
import { createStore } from "solid-js/store"
import { t } from "../../i18n"
import { client } from "../../state/client"
import { codeOf, MerakCodeError } from "../../state/error"
import {
  checkoutOf,
  gitDirectory,
  identityOf,
  onCheckoutChange,
  refreshBranches,
  registerDirty,
  switching,
} from "../../state/git"
import { planDrafts, readDraft, writeDraft, type Draft } from "./draft"
import { fileAddress, resolveFile, sameFileDirectory, type RecoveryMode } from "./identity"
import { toast } from "../../ui/toast"
import { listen } from "../../state/store"

type Tab = {
  path: string
  planSessionID?: string
  planRootSessionID?: string
  identity?: Draft["identity"]
  alternatives?: Draft["alternatives"]
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
  for (const [directory, buffer] of buffers) if (sameFileDirectory(directory, key)) return buffer
  const created = createBuffers(key)
  buffers.set(key, created)
  return created
}

/** Closing a project releases clean models; dirty models require an explicit save or discard first. */
export function releaseBuffers(directory: string) {
  for (const [key, buffer] of buffers) {
    if (!sameFileDirectory(key, directory)) continue
    if (buffer.tabs.some((tab) => tab.dirty)) return false
    if (!buffer.release()) return false
    buffers.delete(key)
  }
  return true
}

function createBuffers(directory: string) {
  const identity = (): Draft["identity"] => {
    const value = identityOf(directory)
    return value ? { directory: gitDirectory(directory), branch: value.branch, head: value.head } : value
  }
  const matchesBranch = (saved: Draft["identity"]) => {
    const current = identity()
    if (saved === undefined || current === undefined) return false
    if (saved === null || current === null) return saved === current
    return (
      sameFileDirectory(saved.directory, current.directory) &&
      saved.branch === current.branch &&
      (saved.branch !== null || saved.head === current.head)
    )
  }
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

  const read = async (path: string, planSessionID?: string): Promise<FileContent & { planRootSessionID?: string }> => {
    const connection = await client()
    if (!planSessionID) return connection.file.read({ directory: gitDirectory(directory), path })
    const plan = await connection.plan.get({ session: planSessionID })
    return { type: "text", content: plan.content, checksum: String(plan.revision), planRootSessionID: plan.session }
  }

  const exists = async (path: string) => {
    const slash = path.lastIndexOf("/")
    const nodes = await (
      await client()
    ).file
      .list({ directory: gitDirectory(directory), path: slash < 0 ? "." : path.slice(0, slash) })
      .catch(() => undefined)
    return !nodes || nodes.some((node) => node.path === path)
  }

  const open = async (path: string, planSessionID?: string) => {
    path = fileAddress(gitDirectory(directory), path, planSessionID).path
    const source = path
    if (closed) return
    setErrors(path, undefined)
    if (tabs.some((tab) => tab.path === path)) return
    const known = pending.get(path)
    if (known) return known
    const epoch = epochs.get(path) ?? 0
    let retry = false
    const request = Promise.resolve().then(async () => {
      if (!planSessionID && !path.startsWith("merakcode-plan://")) await resolveFile(directory, path)
      if (closed || (epochs.get(source) ?? 0) !== epoch) return
      path = fileAddress(gitDirectory(directory), path, planSessionID).path
      pending.set(path, request)
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
      const draft = await readDraft(gitDirectory(directory), path)
      const binary = content.type === "binary"
      const preview =
        binary && content.mime?.startsWith("image/") && content.content
          ? `data:${content.mime};base64,${content.content}`
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
        setTabs((item) => item.path === path, "dirty", model.getValue() !== tab.saved || !!tab.alternatives?.length)
        sync()
        void writeDraft(
          gitDirectory(directory),
          path,
          tab.dirty
            ? {
                content: model.getValue(),
                saved: tab.saved,
                checksum: tab.checksum,
                identity: tab.identity,
                planSessionID: tab.planSessionID,
                planRootSessionID: tab.planRootSessionID,
                alternatives: tab.alternatives,
              }
            : undefined,
        ).catch(() => toast({ kind: "error", title: t("panel.persistError") }))
      })
      setTabs((list) => [
        ...list,
        {
          path,
          planSessionID,
          planRootSessionID: content.planRootSessionID,
          identity: draft ? draft.identity : identity(),
          alternatives: draft?.alternatives,
          checksum: draft?.checksum ?? content.checksum,
          saved: draft?.saved ?? content.content,
          dirty: !binary && !!draft,
          conflict:
            !!draft && (draft.checksum !== content.checksum || (!planSessionID && !matchesBranch(draft.identity))),
          original: content.head ?? content.content,
          missing: content.missing,
          binary,
          preview,
          model,
        },
      ])
      sync()
    })
    pending.set(path, request)
    try {
      await request
    } catch (error) {
      setErrors(path, String(error))
    } finally {
      if (pending.get(source) === request) pending.delete(source)
      if (pending.get(path) === request) pending.delete(path)
    }
    if (retry && !closed && (epochs.get(path) ?? 0) === epoch) await open(path, planSessionID)
  }

  const reload = async (branchChanged = false) => {
    await Promise.all(saving.values())
    const token = checkoutOf(directory)
    await Promise.all(
      tabs.map(async (tab) => {
        const fresh = await read(tab.path, tab.planSessionID).catch(async () =>
          // A file that is gone and was never committed cannot be read; the open tab then shows it as deleted
          !tab.planSessionID && !(await exists(tab.path))
            ? ({ type: tab.binary ? "binary" : "text", content: "", missing: true } as FileContent & {
                planRootSessionID?: string
              })
            : undefined,
        )
        if (
          closed ||
          token !== checkoutOf(directory) ||
          tabs.find((item) => item.path === tab.path)?.model !== tab.model
        )
          return
        if (fresh && tab.binary) {
          setTabs((item) => item.path === tab.path, {
            preview:
              !fresh.missing && fresh.mime?.startsWith("image/") && fresh.content
                ? `data:${fresh.mime};base64,${fresh.content}`
                : undefined,
            checksum: fresh.checksum,
            missing: fresh.missing,
          })
          return
        }
        if (fresh)
          setTabs((item) => item.path === tab.path, {
            original: fresh.head ?? fresh.content,
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
          identity: identity(),
          binary: fresh.type === "binary",
          conflict: false,
          original: fresh.head ?? fresh.content,
          missing: fresh.missing,
        })
        tab.model?.setValue(fresh.content)
        setTabs((item) => item.path === tab.path, "dirty", false)
        sync()
      }),
    )
  }

  const saveFile = async (force = false, path?: string, confirmedCheckout?: string | null) => {
    if (closed || switching(directory)) return
    const tab = tabs.find((item) => item.path === path)
    if (!tab?.model || !tab.dirty || tab.binary || tab.missing) return
    if (!tab.planSessionID) {
      const options = await refreshBranches(directory)
      if (!options) return
      if (!matchesBranch(tab.identity)) {
        const current = checkoutOf(directory) ?? null
        if (confirmedCheckout === undefined || confirmedCheckout !== current) {
          setTabs((item) => item.path === tab.path, "conflict", true)
          toast({
            kind: "error",
            title: t("code.branchConflict"),
            error: new MerakCodeError({ code: "MRK-4029", message: t("code.branchConflict") }),
            action: {
              label: t("code.saveCurrentBranch"),
              run: () => void save(force, path, current),
            },
          })
          return
        }
        setTabs((item) => item.path === tab.path, "identity", identity())
      }
    }
    const token = checkoutOf(directory)
    const content = tab.model.getValue()
    const connection = await client()
    const written = await (
      tab.planSessionID
        ? connection.plan.save({ session: tab.planSessionID, content, revision: Number(tab.checksum ?? 0) })
        : connection.file.write({
            directory: gitDirectory(directory),
            path: tab.path,
            content,
            ...(force || !tab.checksum ? {} : { checksum: tab.checksum }),
            ...(force ? { force: true } : {}),
          })
    ).then(
      (data) => ({ data }),
      (error: unknown) => ({ error }),
    )
    if ("error" in written) {
      const code = codeOf(written.error)
      if (code === "MRK-4029" || code === "MRK-4011") {
        toast({
          kind: "error",
          title: t("code.conflict"),
          error: written.error,
          action: tab.planSessionID ? undefined : { label: t("code.overwrite"), run: () => void save(true, path) },
        })
        return
      }
      const message = written.error instanceof Error ? written.error.message : String(written.error)
      return toast({ kind: "error", title: t("error.request", { message }), error: written.error })
    }
    if (token !== checkoutOf(directory)) return
    const checksum = "revision" in written.data ? String(written.data.revision) : written.data.checksum
    setTabs((item) => item.path === tab.path, {
      saved: content,
      dirty: tab.model.getValue() !== content || !!tab.alternatives?.length,
      checksum,
      conflict: false,
    })
    await writeDraft(
      gitDirectory(directory),
      tab.path,
      tab.dirty
        ? {
            content: tab.model.getValue(),
            saved: content,
            checksum,
            identity: tab.identity,
            planSessionID: tab.planSessionID,
            planRootSessionID: tab.planRootSessionID,
            alternatives: tab.alternatives,
          }
        : undefined,
    )
    sync()
  }

  const save = (force = false, path?: string, confirmedCheckout?: string | null) => {
    if (!path) return Promise.resolve()
    path = fileAddress(gitDirectory(directory), path).path
    const request = (saving.get(path) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        await saveFile(force, path, confirmedCheckout)
      })
    saving.set(path, request)
    void request
      .finally(() => {
        if (saving.get(path) === request) saving.delete(path)
      })
      .catch(() => {})
    return request
  }

  const close = async (path: string, mode?: RecoveryMode) => {
    path = fileAddress(gitDirectory(directory), path).path
    if (mode === "cached" && saving.has(path)) throw new Error(t("panel.persistError"))
    epochs.set(path, (epochs.get(path) ?? 0) + 1)
    pending.delete(path)
    await saving.get(path)
    await writeDraft(gitDirectory(directory), path, undefined, mode)
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
    path = fileAddress(gitDirectory(directory), path).path
    const references = views.get(path) ?? new Set<string>()
    references.add(id)
    views.set(path, references)
  }
  const suspend = async (path: string, id: string) => {
    path = fileAddress(gitDirectory(directory), path).path
    views.get(path)?.delete(id)
    await pending.get(path)
    await saving.get(path)
    if (views.get(path)?.size) return
    const tab = tabs.find((item) => item.path === path)
    if (!tab) return
    if (tab.dirty && tab.model)
      await writeDraft(gitDirectory(directory), path, {
        content: tab.model.getValue(),
        saved: tab.saved,
        checksum: tab.checksum,
        identity: tab.identity,
        planSessionID: tab.planSessionID,
        planRootSessionID: tab.planRootSessionID,
        alternatives: tab.alternatives,
      })
    if (views.get(path)?.size || tabs.find((item) => item.path === path)?.model !== tab.model) return
    setTabs((list) => list.filter((item) => item.path !== path))
    tab.model?.dispose()
  }
  const savePlan = async (sessionID: string) => {
    const connection = await client()
    const plan = await connection.plan.get({ session: sessionID })
    const ids = [sessionID, plan.session]
    for (const draft of await planDrafts(directory)) {
      const root = draft.root ?? (await connection.plan.get({ session: draft.sessionID })).session
      if (!ids.includes(draft.sessionID) && root !== plan.session) continue
      await open(draft.path, draft.sessionID)
      if (!tabs.some((tab) => tab.path === draft.path && tab.planSessionID === draft.sessionID)) return false
    }
    const pending = tabs.filter(
      (item) =>
        item.dirty &&
        ((item.planSessionID && ids.includes(item.planSessionID)) || item.planRootSessionID === plan.session),
    )
    for (const tab of pending) await save(false, tab.path)
    return pending.every((tab) => !tab.dirty)
  }
  const selectDraft = (path: string, index: number) => {
    const tab = tabs.find((item) => item.path === fileAddress(gitDirectory(directory), path).path)
    const draft = tab?.alternatives?.[index]
    if (!tab?.model || !draft) return
    const alternatives = tab.alternatives!.filter((_, i) => i !== index)
    if (tab.model.getValue() !== tab.saved)
      alternatives.push({
        content: tab.model.getValue(),
        saved: tab.saved,
        checksum: tab.checksum,
        identity: tab.identity,
        planSessionID: tab.planSessionID,
        planRootSessionID: tab.planRootSessionID,
      })
    setTabs((item) => item.path === tab.path, { ...draft, alternatives, conflict: true, dirty: true })
    tab.model.setValue(draft.content)
    void writeDraft(gitDirectory(directory), tab.path, { ...draft, alternatives }).catch(() =>
      toast({ kind: "error", title: t("panel.persistError") }),
    )
    sync()
  }
  return {
    tabs,
    errors,
    open,
    save,
    savePlan,
    close,
    reload,
    release,
    suspend,
    retain,
    selectDraft,
    idle: (path: string) => saving.get(fileAddress(gitDirectory(directory), path).path) ?? Promise.resolve(),
  }
}

onCheckoutChange((directory, change) => {
  for (const [key, buffer] of buffers) if (sameFileDirectory(key, directory)) void buffer.reload(change.branchChanged)
})

listen((_directory, event) => {
  if (event.type !== "plan.updated") return
  for (const buffer of buffers.values())
    if (
      buffer.tabs.some(
        (tab) => tab.planSessionID === event.payload.session || tab.planRootSessionID === event.payload.session,
      )
    )
      void buffer.reload()
})
