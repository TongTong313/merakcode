import path from "path"
import { Global } from "../../infra/global"
import { Instance } from "../../infra/project/instance"
import { Filesystem } from "@merakcode/util/filesystem"

export type ConfigDirScope = "global" | "project"

/**
 * The global config directory (the parent of SkillInstall.globalSkillsDir). When the home directory is the project,
 * its .merakcode is this same directory and counts as global.
 */
function isGlobalConfigDir(dir: string): boolean {
  const resolved = path.resolve(dir)
  const root = path.resolve(Global.Path.config)
  return resolved === root || resolved.startsWith(root + path.sep)
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
