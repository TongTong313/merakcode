/** Where a member's CLI is on this machine */
import { statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Process } from "@merakcode/util/process"

/** Where installers put CLIs that are often not on PATH: Claude Code's ~/.local/bin, npm's global folder */
function installDirs() {
  const home = os.homedir()
  const dirs = [path.join(home, ".local", "bin")]
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, "npm"))
  if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, "npm"))
  return dirs
}

export function whichInstalled(
  command: string,
  which: (command: string) => string | null = (name) => Process.which(name),
  dirs: string[] = installDirs(),
) {
  return which(command) ?? (process.platform === "win32" ? which(`${command}.cmd`) : null) ?? findOnDisk(command, dirs)
}

function findOnDisk(command: string, dirs: string[]) {
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", "", ".ps1"] : [""]
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, `${command}${suffix}`)
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        continue
      }
    }
  }
  return null
}
