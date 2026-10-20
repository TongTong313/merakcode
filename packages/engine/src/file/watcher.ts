import { BusEvent } from "../bus/bus-event"
import { Bus } from "../bus"
import z from "zod"
import { Instance } from "../project/instance"
import { Workspace } from "../project/workspace"
import { Filesystem } from "@merakcode/util/filesystem"
import { Log } from "@merakcode/log/logger"
import { FileIgnore } from "./ignore"
import { Config } from "../config/config"
import path from "path"
import { withTimeout } from "../util/timeout"
import type ParcelWatcher from "@parcel/watcher"
import { Process } from "@merakcode/util/process"
import { Flag } from "../flag/flag"
import { readdir } from "fs/promises"
import { parcelWatcher, parcelWatcherBackend } from "./parcel-binding"

const SUBSCRIBE_TIMEOUT_MS = 10_000

export namespace FileWatcher {
  const log = Log.create({ service: "file.watcher" })

  export const Event = {
    Updated: BusEvent.define(
      "file.watcher.updated",
      z.object({
        file: z.string(),
        event: z.union([z.literal("add"), z.literal("change"), z.literal("unlink")]),
      }),
    ),
  }

  /**
   * Deduplicated worktrees whose .git should be watched. In multi-root setups each folder may be its own repository,
   * so the primary folder's vcs cannot decide for all: changes in a second root must flow back even when the primary
   * is not a git repository.
   */
  export function vcsRoots(workspace: Workspace.Info): string[] {
    const roots: string[] = []
    const seen = new Set<string>()
    for (const folder of workspace.folders) {
      if (folder.worktree === "/") continue
      const key = Filesystem.canonicalDirectory(folder.worktree)
      if (seen.has(key)) continue
      seen.add(key)
      roots.push(folder.worktree)
    }
    return roots
  }

  const state = Instance.state(
    async () => {
      const vcs = vcsRoots(Instance.workspace)
      if (vcs.length === 0) return {}
      log.info("init")
      const cfg = await Config.get()
      const backend = parcelWatcherBackend()
      if (!backend) {
        log.error("watcher backend not supported", { platform: process.platform })
        return {}
      }
      log.info("watcher backend", { platform: process.platform, backend })

      const w = parcelWatcher()
      if (!w) return {}

      // The callback runs in the subscriber's context (restored by parcelWatcher), so Bus.publish finds the instance
      const subscribe: ParcelWatcher.SubscribeCallback = (err, evts) => {
        if (err) return
        for (const evt of evts) {
          if (evt.type === "create") Bus.publish(Event.Updated, { file: evt.path, event: "add" })
          if (evt.type === "update") Bus.publish(Event.Updated, { file: evt.path, event: "change" })
          if (evt.type === "delete") Bus.publish(Event.Updated, { file: evt.path, event: "unlink" })
        }
      }

      const subs: ParcelWatcher.AsyncSubscription[] = []
      const cfgIgnores = cfg.watcher?.ignore ?? []

      if (Flag.MERAKCODE_EXPERIMENTAL_FILEWATCHER) {
        // Subscribe to every workspace folder (just Instance.directory in single-root setups)
        for (const folder of Instance.workspace.folders) {
          const pending = w.subscribe(folder.path, subscribe, {
            ignore: [...FileIgnore.PATTERNS, ...cfgIgnores],
            backend,
          })
          const sub = await withTimeout(pending, SUBSCRIBE_TIMEOUT_MS).catch((err) => {
            log.error("failed to subscribe to workspace folder", { path: folder.path, error: err })
            pending.then((s) => s.unsubscribe()).catch(() => {})
            return undefined
          })
          if (sub) subs.push(sub)
        }
      }

      // Subscribe to .git of every git worktree
      for (const wt of vcs) {
        const vcsDir = await Process.run(["git", "rev-parse", "--git-dir"], { cwd: wt, nothrow: true })
          .then((x) => path.resolve(wt, x.text().trim()))
          .catch(() => undefined)
        if (vcsDir && !cfgIgnores.includes(".git") && !cfgIgnores.includes(vcsDir)) {
          const gitDirContents = await readdir(vcsDir).catch(() => [])
          const ignoreList = gitDirContents.filter((entry) => entry !== "HEAD")
          const pending = w.subscribe(vcsDir, subscribe, {
            ignore: ignoreList,
            backend,
          })
          const sub = await withTimeout(pending, SUBSCRIBE_TIMEOUT_MS).catch((err) => {
            log.error("failed to subscribe to vcsDir", { error: err })
            pending.then((s) => s.unsubscribe()).catch(() => {})
            return undefined
          })
          if (sub) subs.push(sub)
        }
      }

      return { subs }
    },
    async (state) => {
      if (!state.subs) return
      await Promise.all(state.subs.map((sub) => sub?.unsubscribe()))
    },
  )

  export function init() {
    if (Flag.MERAKCODE_EXPERIMENTAL_DISABLE_FILEWATCHER) {
      return
    }
    state()
  }
}
