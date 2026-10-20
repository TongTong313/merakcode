import path from "path"
import { existsSync } from "fs"
import fs from "fs/promises"
import { Bus } from "../bus"
import { GlobalBus } from "../bus/global"
import { Instance } from "../project/instance"
import { Log } from "@merakcode/log/logger"
import { Flag } from "../flag/flag"
import { Config } from "../config/config"
import { InstructionPrompt } from "../session/instruction"
import { Rule } from "./rule"
import { parcelWatcher, parcelWatcherBackend } from "../file/parcel-binding"
import type ParcelWatcher from "@parcel/watcher"
import { Glob } from "@merakcode/util/glob"

const log = Log.create({ service: "rule.watch" })

/**
 * Watches rule directories and, on external changes, invalidates the rule cache and broadcasts `rule.updated`.
 *
 * Mirrors SkillWatch (native parcel watcher, mtime poll, global/project event routing).
 *
 * Existing `.merakcode/rule(s)` and `.cursor/rules` directories use parcel. Rule directories missing at startup and
 * AGENTS.md / CLAUDE.md along the project chain are covered by a light poll that detects their creation; parcel
 * subscribes once a new directory appears. The workspace root is not watched, to avoid watching the whole tree.
 *
 * Global user rules live only in `rules.user` in the json config and are invalidated on Config.UpdatedEvent.
 * Global instruction files are read-only in settings and are not watched.
 */
export namespace RuleWatch {
  const DEBOUNCE_MS = 150
  const POLL_MS = 1_500
  const RULE_GLOB = new Glob("**/*.mdc")
  const INSTRUCTION_NAMES = new Set(InstructionPrompt.FILENAMES.map((name) => name.toLowerCase()))

  type Pending = { timer?: ReturnType<typeof setTimeout>; count: number }
  const pendingGlobal: Pending = { count: 0 }
  const pendingProject = new Map<string, Pending>()

  function isRuleFile(filepath: string) {
    const base = path.basename(filepath).toLowerCase()
    return base.endsWith(".mdc") || INSTRUCTION_NAMES.has(base)
  }

  function projectRoots() {
    return Rule.projectWatchRoots()
  }

  function instructionWatchPaths() {
    if (Flag.MERAKCODE_DISABLE_PROJECT_CONFIG) return [] as string[]
    const paths: string[] = []
    for (const dir of Rule.projectChainDirs()) {
      for (const name of InstructionPrompt.FILENAMES) {
        paths.push(path.join(dir, name))
      }
    }
    return paths
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

  /** @returns whether a refresh was broadcast (false when no change was pending) */
  async function flushGlobal(): Promise<boolean> {
    const count = pendingGlobal.count
    pendingGlobal.count = 0
    pendingGlobal.timer = undefined
    if (count === 0) return false

    log.info("global user rules changed", { count })
    Rule.invalidateAll()
    void Bus.publishGlobal(Rule.Event.Updated, {})
    if (Instance.has()) void Bus.publish(Rule.Event.Updated, {}).catch(() => undefined)
    return true
  }

  /** @returns whether a refresh was broadcast (false when no change was pending) */
  async function flushProject(directory: string): Promise<boolean> {
    const pending = pendingProject.get(directory)
    if (!pending || pending.count === 0) return false
    pending.count = 0
    pending.timer = undefined

    log.info("project rule dir changed", { directory })
    Rule.invalidate()
    GlobalBus.emit("event", {
      directory,
      payload: { type: Rule.Event.Updated.type, properties: {} },
    })
    return true
  }

  async function snapshot(input: { mdcRoots: string[]; instructionPaths: string[] }): Promise<Map<string, number>> {
    const result = new Map<string, number>()
    for (const root of input.mdcRoots) {
      if (!existsSync(root)) continue
      try {
        for await (const match of RULE_GLOB.scan({
          cwd: root,
          absolute: true,
          onlyFiles: true,
          followSymlinks: true,
        })) {
          const mtime = (await fs.stat(match)).mtimeMs ?? 0
          result.set(match, mtime)
        }
      } catch {
        // a failing root does not affect the others
      }
    }
    for (const filepath of input.instructionPaths) {
      if (!existsSync(filepath)) continue
      try {
        const mtime = (await fs.stat(filepath)).mtimeMs ?? 0
        result.set(filepath, mtime)
      } catch {
        // a failing stat does not affect the other instruction files
      }
    }
    return result
  }

  function differs(a: Map<string, number>, b: Map<string, number>): boolean {
    if (a.size !== b.size) return true
    for (const [k, v] of a) if (b.get(k) !== v) return true
    return false
  }

  function pollMdcRoots(subscribed: Set<string>) {
    const all = projectRoots()
    if (subscribed.size === 0) return all
    return all.filter((root) => !subscribed.has(root))
  }

  function currentSnapshot(subscribed: Set<string>) {
    return snapshot({
      mdcRoots: pollMdcRoots(subscribed),
      instructionPaths: instructionWatchPaths(),
    })
  }

  /** Global user rules have no directory to watch; the call site stays to keep the startup sequence intact. */
  export function initGlobal() {
    return
  }

  export async function disposeGlobal() {
    return
  }

  const instanceState = Instance.state(
    async (): Promise<{
      subs: ParcelWatcher.AsyncSubscription[]
      poll?: ReturnType<typeof setInterval>
    }> => {
      if (Flag.MERAKCODE_DISABLE_RULES || Flag.MERAKCODE_DISABLE_RULE_WATCH) return { subs: [] }
      const directory = Instance.directory
      const backend = parcelWatcherBackend()
      const w = parcelWatcher()
      const subs: ParcelWatcher.AsyncSubscription[] = []
      const subscribed = new Set<string>()

      const onEvent: ParcelWatcher.SubscribeCallback = (err, evts) => {
        if (err) return
        for (const evt of evts) {
          if (isRuleFile(evt.path)) {
            queueProject(directory)
            break
          }
        }
      }

      async function subscribeRoot(root: string) {
        if (!w || !backend || subscribed.has(root) || !existsSync(root)) return false
        const sub = await w.subscribe(root, onEvent, { backend, ignore: [] }).catch((error) => {
          log.error("rule watch: project native subscribe failed", { root, error })
          return undefined
        })
        if (!sub) return false
        subs.push(sub)
        subscribed.add(root)
        return true
      }

      if (w && backend) {
        for (const root of projectRoots()) {
          await subscribeRoot(root)
        }
      }

      if (subscribed.size === 0 && projectRoots().length > 0) {
        log.warn("rule watch: project fallback to mtime poll", { directory })
      }

      let snap = await currentSnapshot(subscribed)
      const poll = setInterval(() => {
        void (async () => {
          let appeared = false
          if (w && backend) {
            for (const root of projectRoots()) {
              if (subscribed.has(root) || !existsSync(root)) continue
              if (await subscribeRoot(root)) appeared = true
            }
          }
          const next = await currentSnapshot(subscribed)
          if (appeared || differs(snap, next)) queueProject(directory)
          snap = next
        })()
      }, POLL_MS)
      return { subs, poll }
    },
    async (current) => {
      for (const sub of current.subs) await sub.unsubscribe().catch(() => undefined)
      if (current.poll) clearInterval(current.poll)
    },
  )

  export function initInstance() {
    if (Flag.MERAKCODE_DISABLE_RULES) return
    // rules.user lives in the global json, invisible to directory watching, so every config change invalidates rules.
    // Subscribed on every Bootstrap, since disposing the Instance clears that directory's Bus subscriptions.
    Bus.subscribe(Config.UpdatedEvent, () => {
      queueProject(Instance.directory)
      queueGlobal()
    })
    if (Flag.MERAKCODE_DISABLE_RULE_WATCH) return
    void instanceState()
  }

  /** Test only: queues one global change without a timer, so no timer is left pending. */
  export function __testingQueueGlobal() {
    pendingGlobal.count++
  }

  /** Test only: flushes global changes immediately and returns whether a refresh was broadcast. */
  export async function __testingFlushGlobal() {
    return flushGlobal()
  }

  /** Test only: queues one project change. */
  export function __testingQueueProject(directory: string) {
    const pending = pendingProject.get(directory) ?? { count: 0 }
    pending.count++
    pendingProject.set(directory, pending)
  }

  /** Test only: flushes project changes immediately and returns whether a refresh was broadcast. */
  export async function __testingFlushProject(directory: string) {
    return flushProject(directory)
  }

  export function __testingIsRuleFile(filepath: string) {
    return isRuleFile(filepath)
  }

  export function __testingDiffers(a: Map<string, number>, b: Map<string, number>) {
    return differs(a, b)
  }

  /** Test only: snapshot of the polled .mdc roots and project instruction files (requires an Instance). */
  export async function __testingSnapshot() {
    return snapshot({
      mdcRoots: projectRoots(),
      instructionPaths: instructionWatchPaths(),
    })
  }
}
