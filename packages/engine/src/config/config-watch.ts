import path from "path"
import { existsSync } from "fs"
import fs from "fs/promises"
import { Filesystem } from "@merakcode/util/filesystem"
import { Bus } from "../bus"
import { GlobalBus } from "../bus/global"
import { Instance } from "../project/instance"
import { Global } from "../global"
import { Log } from "@merakcode/log/logger"
import { Flag } from "../flag/flag"
import { Config } from "./config"
import { ConfigWriteGuard } from "./config-write-guard"
import { parcelWatcher, parcelWatcherBackend } from "../file/parcel-binding"
import type ParcelWatcher from "@parcel/watcher"

const log = Log.create({ service: "config.watch" })

/**
 * Watches config files so that writes by other engine processes sharing the same config also invalidate the cache
 * and broadcast an update.
 */
export namespace ConfigWatch {
  const DEBOUNCE_MS = 150
  const POLL_MS = 1_500
  const GLOBAL_FILES = ["merakcode.json", "merakcode.jsonc"]

  type Pending = { timer?: ReturnType<typeof setTimeout>; paths: Set<string> }
  const pendingGlobal: Pending = { paths: new Set<string>() }
  const pendingProject = new Map<string, Pending>()

  // Synchronous init guard: server.listen and bootstrap may call initGlobal concurrently, before the async flow has
  // assigned globalSub, which would subscribe twice.
  let globalInit = false
  let globalSub: ParcelWatcher.AsyncSubscription | undefined
  let globalPoll: ReturnType<typeof setInterval> | undefined
  const globalMtimes = new Map<string, number>()

  // Each instance watches its project config directory, falling back to mtime polling without the native watcher.
  const instanceState = Instance.state(
    async (): Promise<{ sub?: ParcelWatcher.AsyncSubscription; poll?: ReturnType<typeof setInterval> }> => {
      if (Flag.MERAKCODE_DISABLE_CONFIG_WATCH) return {}
      const filepath = Config.projectMerakCodeFile()
      const dir = ConfigWriteGuard.configDir(filepath)
      if (!existsSync(dir)) return {}

      const backend = parcelWatcherBackend()
      const w = parcelWatcher()
      const directory = Instance.directory

      if (w && backend) {
        const sub = await w
          .subscribe(
            dir,
            (err, evts) => {
              if (err) return
              for (const evt of evts) {
                if (ConfigWriteGuard.matchesConfigPath(evt.path, filepath)) queueProject(directory, evt.path)
              }
            },
            { backend, ignore: [] },
          )
          .catch((error) => {
            log.error("config watch: project native subscribe failed", { error })
            return undefined
          })
        if (sub) return { sub }
      }

      // Platforms without the native binding (e.g. Windows ARM64) poll the project config mtime instead.
      log.warn("config watch: project fallback to mtime poll", { dir })
      let last = 0
      const poll = setInterval(() => {
        void (async () => {
          if (!(await Filesystem.isFile(filepath))) return
          const mtime = (await fs.stat(filepath)).mtimeMs ?? 0
          if (last !== 0 && mtime !== last) queueProject(directory, filepath)
          last = mtime
        })()
      }, POLL_MS)
      return { poll }
    },
    async (state) => {
      await state.sub?.unsubscribe().catch(() => undefined)
      if (state.poll) clearInterval(state.poll)
    },
  )

  function queueGlobal(changed: string) {
    pendingGlobal.paths.add(changed)
    if (pendingGlobal.timer) clearTimeout(pendingGlobal.timer)
    pendingGlobal.timer = setTimeout(() => void flushGlobal(), DEBOUNCE_MS)
  }

  function queueProject(directory: string, changed: string) {
    const pending = pendingProject.get(directory) ?? { paths: new Set<string>() }
    pending.paths.add(changed)
    if (pending.timer) clearTimeout(pending.timer)
    pending.timer = setTimeout(() => void flushProject(directory), DEBOUNCE_MS)
    pendingProject.set(directory, pending)
  }

  async function readIfConfig(pathname: string) {
    if (!(await Filesystem.isFile(pathname))) return undefined
    return Filesystem.readText(pathname).catch(() => undefined)
  }

  /**
   * Whether this batch of changes contains a real external write. Consumes the self-write records one by one; any
   * path not just written by this process counts as external. Returns false when all are self-writes, so callers
   * skip the reset and broadcast and do not trigger themselves in a loop.
   */
  async function hasExternalChange(paths: string[]) {
    let external = false
    for (const p of paths) {
      const text = await readIfConfig(p)
      const isSelf =
        text !== undefined ? ConfigWriteGuard.consumeSelfWrite(p, text) : ConfigWriteGuard.consumeSelfWrite(p)
      if (!isSelf) external = true
    }
    return external
  }

  /** @returns whether a refresh and broadcast happened (false when all changes were self-writes) */
  async function flushGlobal(): Promise<boolean> {
    const paths = [...pendingGlobal.paths]
    pendingGlobal.paths.clear()
    pendingGlobal.timer = undefined
    if (paths.length === 0) return false
    if (!(await hasExternalChange(paths))) return false

    log.info("global config file changed externally", { paths })
    Config.global.reset()
    Config.state.invalidateAll()
    void Bus.publishGlobal(Config.UpdatedEvent, {})
    if (Instance.has()) {
      void Bus.publish(Config.UpdatedEvent, {}).catch(() => undefined)
    }
    return true
  }

  /** @returns whether a refresh and broadcast happened (false when all changes were self-writes) */
  async function flushProject(directory: string): Promise<boolean> {
    const pending = pendingProject.get(directory)
    if (!pending) return false
    const paths = [...pending.paths]
    pending.paths.clear()
    pending.timer = undefined
    if (paths.length === 0) return false
    if (!(await hasExternalChange(paths))) return false

    log.info("project config file changed externally", { directory, paths })
    Config.state.invalidate()
    GlobalBus.emit("event", {
      directory,
      payload: { type: Config.UpdatedEvent.type, properties: {} },
    })
    return true
  }

  async function pollGlobalConfig() {
    for (const f of GLOBAL_FILES) {
      const file = path.join(Global.Path.config, f)
      if (!(await Filesystem.isFile(file))) continue
      const mtime = (await fs.stat(file)).mtimeMs ?? 0
      const prev = globalMtimes.get(file) ?? 0
      if (prev !== 0 && mtime !== prev) queueGlobal(file)
      globalMtimes.set(file, mtime)
    }
  }

  export function initGlobal() {
    if (Flag.MERAKCODE_DISABLE_CONFIG_WATCH) return
    if (globalInit) return
    globalInit = true

    const dir = Global.Path.config
    const backend = parcelWatcherBackend()
    const w = parcelWatcher()

    void (async () => {
      await pollGlobalConfig() // mtime baseline

      if (w && backend && existsSync(dir)) {
        try {
          globalSub = await w.subscribe(
            dir,
            (err, evts) => {
              if (err) return
              for (const evt of evts) {
                if (GLOBAL_FILES.includes(path.basename(evt.path))) queueGlobal(evt.path)
              }
            },
            { backend, ignore: [] },
          )
          log.info("config watch: global native", { dir, backend })
        } catch (error) {
          log.error("config watch: global native subscribe failed", { error })
        }
      }

      if (!globalSub) {
        log.warn("config watch: global fallback to mtime poll", { dir })
        globalPoll = setInterval(() => void pollGlobalConfig(), POLL_MS)
      }
    })()
  }

  export function initInstance() {
    if (Flag.MERAKCODE_DISABLE_CONFIG_WATCH) return
    void instanceState()
  }

  export async function disposeGlobal() {
    await globalSub?.unsubscribe().catch(() => undefined)
    globalSub = undefined
    if (globalPoll) clearInterval(globalPoll)
    globalPoll = undefined
    globalInit = false
  }

  /** For tests: flushes the global queue and returns whether it broadcast */
  export async function __testingFlushGlobal() {
    return flushGlobal()
  }

  /** For tests: queues a changed global config path */
  export function __testingQueueGlobal(changed: string) {
    pendingGlobal.paths.add(changed)
  }
}
