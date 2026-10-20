import path from "path"
import os from "os"
import { existsSync } from "fs"
import fs from "fs/promises"
import { Bus } from "../bus"
import { GlobalBus } from "../bus/global"
import { Instance } from "../project/instance"
import { Global } from "../global"
import { Log } from "@merakcode/log/logger"
import { Flag } from "../flag/flag"
import { Filesystem } from "@merakcode/util/filesystem"
import { Config } from "../config/config"
import { Skill } from "./skill"
import { Command } from "../command"
import { configDirScope } from "./scope"
import { parcelWatcher, parcelWatcherBackend } from "../file/parcel-binding"
import type ParcelWatcher from "@parcel/watcher"
import { Glob } from "@merakcode/util/glob"

const log = Log.create({ service: "skill.watch" })

/**
 * Watches skill directories: when SKILL.md files are added, changed or removed externally (editor, file manager, CLI),
 * the skill/command caches are invalidated and `skill.updated` is broadcast, so clients refresh the settings list and
 * slash commands without reopening settings or restarting.
 *
 * Mirrors ConfigWatch: native parcel watching, mtime polling as fallback, and global/project event routing.
 *
 * Only skill root directories are watched (e.g. .claude/skills, .merakcode/skill(s)), not their parents (e.g.
 * ~/.claude): those would recursively watch huge subtrees such as projects/ and easily hit the inotify watch limit on
 * Linux. The cost is that creating a skills root for the first time is not seen live; the server rescans on /skill the
 * next time settings open.
 */
export namespace SkillWatch {
  const DEBOUNCE_MS = 150
  const POLL_MS = 1_500
  const SKILL_FILE = "SKILL.md"
  const SKILL_GLOB = new Glob("**/SKILL.md")

  type Pending = { timer?: ReturnType<typeof setTimeout>; count: number }
  const pendingGlobal: Pending = { count: 0 }
  const pendingProject = new Map<string, Pending>()

  let globalInit = false
  let globalSubs: ParcelWatcher.AsyncSubscription[] = []
  let globalPoll: ReturnType<typeof setInterval> | undefined
  let globalSnapshot = new Map<string, number>()

  /** Global skill roots; no Instance context needed */
  function globalRoots(): string[] {
    const home = Global.Path.home
    return [
      ...new Set([
        path.join(home, ".claude", "skills"),
        path.join(home, ".agents", "skills"),
        path.join(Global.Path.config, "skill"),
        path.join(Global.Path.config, "skills"),
        path.join(home, ".config", "merakcode", "skill"),
        path.join(home, ".config", "merakcode", "skills"),
        // ~/.merakcode/skill(s) is not a global skill directory: it coincides with the project directory when started
        // from home (see Config.directories). In that case projectRoots() watches it through the project branch of
        // Config.directories(), so it does not fire twice.
      ]),
    ]
  }

  /** Project skill roots; needs the Instance context. Must match the Skill scan logic. */
  async function projectRoots(): Promise<string[]> {
    const roots = new Set<string>()
    // .claude/skills and .agents/skills, walking up to the worktree
    for await (const dir of Filesystem.up({
      targets: [".claude", ".agents"],
      start: Instance.directory,
      stop: Instance.worktree,
    })) {
      roots.add(path.join(dir, "skills"))
    }
    // .merakcode/skill and .merakcode/skills, project config directories only
    for (const dir of await Config.directories()) {
      if (configDirScope(dir) !== "project") continue
      roots.add(path.join(dir, "skill"))
      roots.add(path.join(dir, "skills"))
    }
    // Custom paths from config.skills.paths
    const config = await Config.get()
    for (const skillPath of config.skills?.paths ?? []) {
      const expanded = skillPath.startsWith("~/") ? path.join(os.homedir(), skillPath.slice(2)) : skillPath
      roots.add(path.isAbsolute(expanded) ? expanded : path.join(Instance.directory, expanded))
    }
    return [...roots]
  }

  function queueGlobal() {
    pendingGlobal.count++
    if (pendingGlobal.timer) clearTimeout(pendingGlobal.timer)
    pendingGlobal.timer = setTimeout(() => void flushGlobal(), DEBOUNCE_MS)
  }

  function queueProject(directory: string) {
    const pending = pendingProject.get(directory) ?? { count: 0 }
    pending.count++
    if (pending.timer) clearTimeout(pending.timer)
    pending.timer = setTimeout(() => void flushProject(directory), DEBOUNCE_MS)
    pendingProject.set(directory, pending)
  }

  /** @returns whether a refresh and broadcast happened; false when nothing was pending */
  async function flushGlobal(): Promise<boolean> {
    const count = pendingGlobal.count
    pendingGlobal.count = 0
    pendingGlobal.timer = undefined
    if (count === 0) return false

    log.info("global skill dir changed", { count })
    Skill.state.invalidateAll()
    Command.state.invalidateAll()
    void Bus.publishGlobal(Skill.Event.Updated, {})
    if (Instance.has()) void Bus.publish(Skill.Event.Updated, {}).catch(() => undefined)
    return true
  }

  /** @returns whether a refresh and broadcast happened; false when nothing was pending */
  async function flushProject(directory: string): Promise<boolean> {
    const pending = pendingProject.get(directory)
    if (!pending || pending.count === 0) return false
    pending.count = 0
    pending.timer = undefined

    log.info("project skill dir changed", { directory })
    Skill.state.invalidate()
    Command.state.invalidate()
    GlobalBus.emit("event", {
      directory,
      payload: { type: Skill.Event.Updated.type, properties: {} },
    })
    return true
  }

  /** mtime snapshot of all SKILL.md files under the roots, used by the polling fallback to detect changes */
  async function snapshot(roots: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>()
    for (const root of roots) {
      if (!existsSync(root)) continue
      try {
        for await (const match of SKILL_GLOB.scan({
          cwd: root,
          absolute: true,
          onlyFiles: true,
          followSymlinks: true,
        })) {
          const mtime = (await fs.stat(match)).mtimeMs ?? 0
          result.set(match, mtime)
        }
      } catch {
        // A failing root does not affect the others
      }
    }
    return result
  }

  /** Whether two snapshots differ (a file added, removed or with a changed mtime) */
  function differs(a: Map<string, number>, b: Map<string, number>): boolean {
    if (a.size !== b.size) return true
    for (const [k, v] of a) if (b.get(k) !== v) return true
    return false
  }

  export function initGlobal() {
    if (Flag.MERAKCODE_DISABLE_SKILL_WATCH) return
    if (globalInit) return
    globalInit = true

    const backend = parcelWatcherBackend()
    const w = parcelWatcher()
    const roots = globalRoots()

    void (async () => {
      if (w && backend) {
        for (const root of roots) {
          if (!existsSync(root)) continue
          try {
            const sub = await w.subscribe(
              root,
              (err, evts) => {
                if (err) return
                for (const evt of evts) {
                  if (path.basename(evt.path) === SKILL_FILE) {
                    queueGlobal()
                    break
                  }
                }
              },
              { backend, ignore: [] },
            )
            globalSubs.push(sub)
          } catch (error) {
            log.error("skill watch: global native subscribe failed", { root, error })
          }
        }
      }

      // Poll when there is no native subscription (no binding, or none of the roots exist)
      if (globalSubs.length === 0) {
        log.warn("skill watch: global fallback to mtime poll")
        globalSnapshot = await snapshot(roots) // only polling needs a baseline
        globalPoll = setInterval(() => {
          void (async () => {
            const next = await snapshot(globalRoots())
            if (differs(globalSnapshot, next)) queueGlobal()
            globalSnapshot = next
          })()
        }, POLL_MS)
      }
    })()
  }

  export async function disposeGlobal() {
    for (const sub of globalSubs) await sub.unsubscribe().catch(() => undefined)
    globalSubs = []
    if (globalPoll) clearInterval(globalPoll)
    globalPoll = undefined
    globalInit = false
  }

  // Each instance watches its project skill roots
  const instanceState = Instance.state(
    async (): Promise<{
      subs: ParcelWatcher.AsyncSubscription[]
      poll?: ReturnType<typeof setInterval>
    }> => {
      if (Flag.MERAKCODE_DISABLE_SKILL_WATCH) return { subs: [] }
      const directory = Instance.directory
      const roots = await projectRoots()
      const backend = parcelWatcherBackend()
      const w = parcelWatcher()
      const subs: ParcelWatcher.AsyncSubscription[] = []

      if (w && backend) {
        for (const root of roots) {
          if (!existsSync(root)) continue
          const sub = await w
            .subscribe(
              root,
              (err, evts) => {
                if (err) return
                for (const evt of evts) {
                  if (path.basename(evt.path) === SKILL_FILE) {
                    queueProject(directory)
                    break
                  }
                }
              },
              { backend, ignore: [] },
            )
            .catch((error) => {
              log.error("skill watch: project native subscribe failed", { root, error })
              return undefined
            })
          if (sub) subs.push(sub)
        }
      }

      // Poll the project roots when native watching is unavailable
      if (subs.length === 0 && roots.length > 0) {
        log.warn("skill watch: project fallback to mtime poll", { directory })
        let snap = await snapshot(roots)
        const poll = setInterval(() => {
          void (async () => {
            const next = await snapshot(await projectRoots())
            if (differs(snap, next)) queueProject(directory)
            snap = next
          })()
        }, POLL_MS)
        return { subs, poll }
      }
      return { subs }
    },
    async (state) => {
      for (const sub of state.subs) await sub.unsubscribe().catch(() => undefined)
      if (state.poll) clearInterval(state.poll)
    },
  )

  export function initInstance() {
    if (Flag.MERAKCODE_DISABLE_SKILL_WATCH) return
    void instanceState()
  }

  /** Test only: queues one global change without a timer, so no timer is left dangling */
  export function __testingQueueGlobal() {
    pendingGlobal.count++
  }

  /** Test only: runs the global flush and returns whether it broadcast */
  export async function __testingFlushGlobal() {
    return flushGlobal()
  }

  /** Test only: queues one project change */
  export function __testingQueueProject(directory: string) {
    const pending = pendingProject.get(directory) ?? { count: 0 }
    pending.count++
    pendingProject.set(directory, pending)
  }

  /** Test only: runs the project flush and returns whether it broadcast */
  export async function __testingFlushProject(directory: string) {
    return flushProject(directory)
  }
}
