import { existsSync } from "fs"
import fs from "fs/promises"
import { Instance } from "../project/instance"
import { Log } from "@merakcode/log/logger"
import { Flag } from "../flag/flag"
import { parcelWatcher, parcelWatcherBackend } from "../file/parcel-binding"
import { MemoryPath } from "./path"
import { MemoryScan } from "./scan"
import type ParcelWatcher from "@parcel/watcher"
import { Glob } from "@merakcode/util/glob"

const log = Log.create({ service: "memory.watch" })

/**
 * Watches the memory directory and invalidates the {@link MemoryScan} mtime cache when memory files are edited in
 * place from outside (editor, file manager, CLI).
 *
 * MemoryScan keys its cache on the mtimes of the four type directories, which only change on add, delete or rename.
 * Editing an existing file in place (e.g. its frontmatter description) leaves the directory mtime unchanged, so the
 * cached name/description used for ranking (and thus whether and where a memory is recalled) stays stale until the
 * next add/delete or a restart. File bodies are read by path on demand and are unaffected. File-level watching
 * closes this gap.
 *
 * Mirrors SkillWatch (native parcel watcher with an mtime poll fallback), but per Instance only: the memory directory
 * is a single per-Instance directory (Global.Path.data/memory/projects/<key>), with no separate global and project
 * roots.
 */
export namespace MemoryWatch {
  const DEBOUNCE_MS = 150
  const POLL_MS = 1_500
  const MEMORY_GLOB = new Glob("**/*.md")

  type Pending = { timer?: ReturnType<typeof setTimeout>; count: number }
  const pending = new Map<string, Pending>()

  function queue(memoryDir: string) {
    const entry = pending.get(memoryDir) ?? { count: 0 }
    entry.count++
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => void flush(memoryDir), DEBOUNCE_MS)
    pending.set(memoryDir, entry)
  }

  /** @returns whether the cache was invalidated (false when no change was pending) */
  async function flush(memoryDir: string): Promise<boolean> {
    const entry = pending.get(memoryDir)
    if (!entry || entry.count === 0) return false
    entry.count = 0
    entry.timer = undefined

    log.info("memory dir changed", { memoryDir })
    MemoryScan.invalidate(memoryDir)
    return true
  }

  /** mtimes of all .md files under memoryDir, used by the poll fallback to detect adds, deletes and in-place edits */
  async function snapshot(memoryDir: string): Promise<Map<string, number>> {
    const result = new Map<string, number>()
    if (!existsSync(memoryDir)) return result
    try {
      for await (const match of MEMORY_GLOB.scan({
        cwd: memoryDir,
        absolute: true,
        onlyFiles: true,
        followSymlinks: true,
      })) {
        try {
          result.set(match, (await fs.stat(match)).mtimeMs)
        } catch {
          // deleted between the scan and the stat
        }
      }
    } catch {
      // memoryDir is unreadable; return what was collected so far
    }
    return result
  }

  /** Whether files were added or removed or any mtime changed */
  function differs(a: Map<string, number>, b: Map<string, number>): boolean {
    if (a.size !== b.size) return true
    for (const [k, v] of a) if (b.get(k) !== v) return true
    return false
  }

  const instanceState = Instance.state(
    async (): Promise<{
      subs: ParcelWatcher.AsyncSubscription[]
      poll?: ReturnType<typeof setInterval>
    }> => {
      if (Flag.MERAKCODE_DISABLE_MEMORY_WATCH) return { subs: [] }
      const memoryDir = MemoryPath.directory()
      const backend = parcelWatcherBackend()
      const w = parcelWatcher()
      const subs: ParcelWatcher.AsyncSubscription[] = []

      if (w && backend && existsSync(memoryDir)) {
        const sub = await w
          .subscribe(
            memoryDir,
            (err, evts) => {
              if (err) return
              for (const evt of evts) {
                if (evt.path.toLowerCase().endsWith(".md")) {
                  queue(memoryDir)
                  break
                }
              }
            },
            { backend, ignore: [] },
          )
          .catch((error) => {
            log.error("memory watch: native subscribe failed", { memoryDir, error })
            return undefined
          })
        if (sub) subs.push(sub)
      }

      // Poll when native watching is unavailable (no binding, or memoryDir does not exist yet). If the directory is
      // created later, the next poll sees the difference and invalidates, but never upgrades to a native
      // subscription; SkillWatch makes the same trade-off.
      if (subs.length === 0) {
        log.warn("memory watch: fallback to mtime poll", { memoryDir })
        let snap = await snapshot(memoryDir)
        const poll = setInterval(() => {
          void (async () => {
            const next = await snapshot(memoryDir)
            if (differs(snap, next)) queue(memoryDir)
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
    if (Flag.MERAKCODE_DISABLE_MEMORY_WATCH) return
    void instanceState()
  }

  /** Test only: queues one change without a timer, so no timer is left pending. */
  export function __testingQueue(memoryDir: string) {
    const entry = pending.get(memoryDir) ?? { count: 0 }
    entry.count++
    pending.set(memoryDir, entry)
  }

  /** Test only: flushes immediately and returns whether the cache was invalidated. */
  export async function __testingFlush(memoryDir: string) {
    return flush(memoryDir)
  }
}
