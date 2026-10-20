import path from "path"
import { Global } from "../global"
import { Instance } from "../project/instance"
import { Filesystem } from "@merakcode/util/filesystem"

export type ConfigDirScope = "global" | "project"

/** Known global config roots, matching the parent of SkillInstall.globalSkillsDir and Config.directories */
function globalConfigDirs(): string[] {
  const home = Global.Path.home
  // Only ~/.config/merakcode (XDG config) is a global config directory. ~/.merakcode is a runtime/install directory
  // without merakcode.jsonc, agents or commands, and <home>/.merakcode is also the project directory when started from
  // home; treating it as global would make configDirScope classify skills installed to that project as global.
  return [Global.Path.config, path.join(home, ".config", "merakcode")]
}

function isGlobalConfigDir(dir: string): boolean {
  const resolved = path.resolve(dir)
  return globalConfigDirs().some((root) => {
    const r = path.resolve(root)
    return resolved === r || resolved.startsWith(r + path.sep)
  })
}

/**
 * Decides whether a directory from Config.directories() is global or project scope.
 * contains(worktree, dir) alone is not enough: for non-git projects the worktree is "/", which contains every absolute
 * path on Unix.
 */
export function configDirScope(dir: string): ConfigDirScope {
  if (isGlobalConfigDir(dir)) return "global"
  // Like Instance.containsPath: skip the worktree check when worktree is "/"
  if (Instance.worktree === "/") {
    return Filesystem.contains(Instance.directory, dir) ? "project" : "global"
  }
  return Filesystem.contains(Instance.worktree, dir) ? "project" : "global"
}
