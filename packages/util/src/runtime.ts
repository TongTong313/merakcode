import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

/**
 * Runtime arguments to pass when spawning a child process with the current runtime.
 *
 * The child must inherit the parent's runtime arguments (such as the dev source loader `--import ...`), otherwise it
 * behaves differently. Relative module paths become absolute: the child's cwd is usually the session directory, not
 * the parent's.
 */
export namespace Runtime {
  type Current = Pick<NodeJS.Process, "execArgv" | "argv" | "cwd">

  /** Runtime flags whose value may be a separate token (everything else is treated as a single --k=v token) */
  const WITH_VALUE = new Set(["--import", "--require", "-r", "--loader", "--conditions", "-C"])
  /** Flags whose value is a module path */
  const MODULE = new Set(["--import", "--require", "-r", "--loader"])

  export function execArgv(current: Current = process): string[] {
    const out: string[] = []
    const args = current.execArgv
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!
      if (!arg.startsWith("-")) continue // ignore stray non-flag tokens
      const eq = arg.indexOf("=")
      const flag = eq > 0 ? arg.slice(0, eq) : arg
      if (eq > 0) {
        out.push(MODULE.has(flag) ? `${flag}=${module(flag, arg.slice(eq + 1), current)}` : arg)
        continue
      }
      out.push(arg)
      if (WITH_VALUE.has(arg) && args[i + 1] !== undefined) {
        const value = args[++i]!
        out.push(MODULE.has(arg) ? module(arg, value, current) : value)
      }
    }
    return out
  }

  /**
   * Module path arguments: relative paths (starting with ./ or ../) become absolute; package names, file:// URLs and
   * absolute paths stay as is. On Windows, --import and --loader accept only file:// URLs, not drive-letter paths.
   */
  function module(flag: string, value: string, current: Current) {
    if (!value.startsWith(".")) return value
    const resolved = locate(value, current)
    if (!resolved) return value
    return flag === "--require" || flag === "-r" ? resolved : pathToFileURL(resolved).href
  }

  /**
   * The base of a relative path is no longer reliable (cwd may have changed), so the first existing match wins:
   *  1) the current cwd;
   *  2) the directory of the entry point (process.argv[1]) and its ancestors: the dev loader is relative to the
   *     startup cwd, and after a chdir only the entry path can recover it;
   *  3) the directory of this file and its ancestors.
   * If nothing matches, the value is passed through and the runtime reports the error.
   */
  function locate(value: string, current: Current) {
    const roots = [current.cwd(), ...(current.argv[1] ? [path.dirname(current.argv[1])] : []), import.meta.dirname]
    return roots
      .flatMap((root) => {
        const dirs = [path.resolve(root)]
        while (path.dirname(dirs.at(-1)!) !== dirs.at(-1)) dirs.push(path.dirname(dirs.at(-1)!))
        return dirs
      })
      .map((dir) => path.resolve(dir, value))
      .find((candidate) => fs.existsSync(candidate))
  }
}
