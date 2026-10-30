import { Log } from "@merakcode/log/logger"
import { Context } from "../scope/context"
import { Project } from "./project"
import { State } from "../scope/state"
import { iife } from "@merakcode/util/iife"
import { GlobalBus } from "../bus/global"
import { Filesystem } from "@merakcode/util/filesystem"
import { Workspace } from "./workspace"

interface Context {
  directory: string
  worktree: string
  project: Project.Info
  workspace: Workspace.Info
  resolveProject: typeof Project.fromDirectory
  bootstrapping: boolean
  pending?: Promise<Context>
}
const context = Context.create<Context>("instance")
const cache = new Map<string, Promise<Context>>()

const disposal = {
  all: undefined as Promise<void> | undefined,
}

export const Instance = {
  async provide<R>(input: {
    directory: string
    /** Multi-root workspace folders; when omitted it is a single root (CLI, older clients) */
    workspace?: { folders: Workspace.FolderInput[] }
    init?: () => Promise<any>
    resolveProject?: typeof Project.fromDirectory
    fn: () => R
  }): Promise<R> {
    const directory = Filesystem.normalize(input.directory)
    const identity = Workspace.identity({ directory, folders: input.workspace?.folders })
    const folderPaths = Workspace.normalizeFolderPaths(directory, input.workspace?.folders)
    const cacheKey = Workspace.key(directory, folderPaths, identity?.id)
    const current = (() => {
      try {
        return context.use()
      } catch {
        return undefined
      }
    })()
    // A plugin's in-process request may re-enter its own project before bootstrap completes.
    if (current?.workspace.key === cacheKey && current.bootstrapping && cache.get(cacheKey) === current.pending)
      return input.fn()
    const resolveProject = input.resolveProject ?? current?.resolveProject ?? Project.fromDirectory

    let existing = cache.get(cacheKey)
    if (!existing) {
      Log.Default.info("creating instance", { directory, cacheKey: cacheKey === directory ? undefined : "multi-root" })
      existing = iife(async () => {
        // The primary still goes through fromDirectory so Instance.worktree / sandbox keep their meaning; with multiple
        // roots the session container is replaced by a ws_ project afterwards
        const { project: primary, sandbox } = await resolveProject(directory)
        const workspace = await Workspace.build({
          directory,
          primaryWorktree: sandbox,
          folders: input.workspace?.folders,
        })
        const project = workspace.identity
          ? await Project.forWorkspace({
              id: workspace.identity.id,
              primary,
              folders: workspace.folders.map((f) => f.path),
            })
          : primary
        const ctx: Context = {
          directory,
          worktree: sandbox,
          project,
          workspace,
          resolveProject,
          bootstrapping: true,
          pending: existing,
        }
        try {
          await context.provide(ctx, async () => {
            await input.init?.()
          })
        } finally {
          ctx.bootstrapping = false
          ctx.pending = undefined
        }
        return ctx
      })
      cache.set(cacheKey, existing)
    }
    const ctx = await existing
    return context.provide(ctx, async () => {
      return input.fn()
    })
  },
  /**
   * Whether we are inside Instance.provide, without throwing. Config.updateGlobal uses it to skip Bus.publish on
   * paths without a context, such as PATCH /global.
   */
  has(): boolean {
    try {
      context.use()
      return true
    } catch {
      return false
    }
  },
  get directory() {
    return context.use().directory
  },
  get worktree() {
    return context.use().worktree
  },
  get project() {
    return context.use().project
  },
  get workspace() {
    return context.use().workspace
  },
  /**
   * Check if a path is within the workspace boundary.
   * Returns true if path is inside any workspace folder OR that folder's git worktree.
   * With a single root this is directory ∪ worktree (the worktree is skipped when it is "/").
   */
  containsPath(filepath: string) {
    return Workspace.containsPath(Instance.workspace, filepath)
  },
  state<S>(init: () => S, dispose?: (state: Awaited<S>) => Promise<void>): State.StateFn<S> {
    return State.create(() => Instance.workspace.key, init, dispose)
  },
  async dispose() {
    const key = Instance.workspace.key
    Log.Default.info("disposing instance", {
      directory: Instance.directory,
      key: key === Instance.directory ? undefined : "multi-root",
    })
    await State.dispose(key)
    cache.delete(key)
    GlobalBus.emit("event", {
      directory: Instance.directory,
      payload: {
        type: "server.instance.disposed",
        properties: {
          directory: Instance.directory,
        },
      },
    })
  },
  /** Runs `fn` once inside every live instance (instance-scoped state is only reachable from its own context) */
  async forEach(fn: () => Promise<unknown>) {
    for (const value of [...cache.values()]) {
      const ctx = await value.catch(() => undefined)
      if (ctx) await context.provide(ctx, fn)
    }
  },
  async disposeAll() {
    if (disposal.all) return disposal.all

    disposal.all = iife(async () => {
      Log.Default.info("disposing all instances")
      const entries = [...cache.entries()]
      for (const [key, value] of entries) {
        if (cache.get(key) !== value) continue

        const ctx = await value.catch((error) => {
          Log.Default.warn("instance dispose failed", { key, error })
          return undefined
        })

        if (!ctx) {
          if (cache.get(key) === value) cache.delete(key)
          continue
        }

        if (cache.get(key) !== value) continue

        await context.provide(ctx, async () => {
          await Instance.dispose()
        })
      }
    }).finally(() => {
      disposal.all = undefined
    })

    return disposal.all
  },
}
