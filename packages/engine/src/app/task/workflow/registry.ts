import path from "path"
import { Config } from "../../config/files/config"
import { Instance } from "../../../infra/project/instance"
import { Log } from "@merakcode/log/logger"
import { WorkflowScriptParser } from "./script"
import type { WorkflowScript } from "./types"
import { Filesystem } from "@merakcode/util/filesystem"
import { Glob } from "@merakcode/util/glob"

export type WorkflowLoadError = {
  name: string
  path: string
  error: string
}

type WorkflowRegistrySnapshot = {
  scripts: WorkflowScript[]
  errors: WorkflowLoadError[]
}

export namespace WorkflowRegistry {
  const log = Log.create({ service: "workflow.registry" })
  const glob = new Glob("workflows/*.js")

  function message(error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }

  export async function snapshot(): Promise<WorkflowRegistrySnapshot> {
    const result = new Map<string, WorkflowScript>()
    const errors: WorkflowLoadError[] = []
    for (const dir of await Config.directories()) {
      for await (const item of glob.scan({ cwd: dir, absolute: true, followSymlinks: true, dot: true })) {
        const source = path.resolve(item).startsWith(path.resolve(Instance.worktree)) ? "project" : "global"
        const script = await Filesystem.readText(item)
        try {
          const parsed = WorkflowScriptParser.parse({ script, scriptPath: item, source })
          result.set(parsed.name, parsed)
        } catch (error) {
          errors.push({
            name: path.basename(item, path.extname(item)),
            path: item,
            error: message(error),
          })
          log.error("failed to load workflow", { path: item, error })
        }
      }
    }
    return { scripts: [...result.values()], errors }
  }

  export async function list() {
    return snapshot().then((item) => item.scripts)
  }

  export async function get(name: string) {
    const normalized = name.trim().replace(/^\//, "")
    return snapshot().then(
      (item) =>
        item.scripts.find((script) => script.name === normalized) ??
        item.scripts.find(
          (script) =>
            script.scriptPath && path.basename(script.scriptPath, path.extname(script.scriptPath)) === normalized,
        ),
    )
  }

  export async function getLoadError(name: string) {
    const normalized = name.trim().replace(/^\//, "")
    return snapshot().then((item) => item.errors.find((error) => error.name === normalized))
  }
}
