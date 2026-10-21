import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { Config } from "@merakcode/engine/config/config"
import { Global } from "@merakcode/engine/global/index"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"

// Strip null bytes from paths (defensive fix for CI environment issues)
function sanitizePath(p: string): string {
  return p.replace(/\0/g, "")
}

type TmpDirOptions<T> = {
  git?: boolean
  config?: Partial<Config.Info>
  init?: (dir: string) => Promise<T>
  dispose?: (dir: string) => Promise<T>
}
/** Temporary directories being removed in the background (see the dispose of tmpdir) */
const removals = new Set<Promise<void>>()

/** Waits until every temporary directory is removed; preload calls this at the end of each test file */
export function removing() {
  return Promise.all(removals)
}

export async function tmpdir<T>(options?: TmpDirOptions<T>) {
  const dirpath = sanitizePath(path.join(os.tmpdir(), "merakcode-test-" + Math.random().toString(36).slice(2)))
  await fs.mkdir(dirpath, { recursive: true })
  const dir = sanitizePath(await fs.realpath(dirpath))
  if (options?.git) {
    await Process.run(["git", "init"], { cwd: dir })
    await Process.run(["git", "config", "user.name", "MerakCode Test"], { cwd: dir })
    await Process.run(["git", "config", "user.email", "merakcode-test@example.com"], { cwd: dir })
    await Process.run(["git", "commit", "--allow-empty", "-m", `root commit ${dir}`], { cwd: dir })
  }
  if (options?.config) {
    await Filesystem.write(
      path.join(dir, "merakcode.json"),
      JSON.stringify({
        $schema: Config.SCHEMA,
        ...options.config,
      }),
    )
  }
  const extra = await options?.init?.(dir)
  const result = {
    [Symbol.asyncDispose]: async () => {
      await options?.dispose?.(dir)
      // On Windows, antivirus often holds freshly written files and removal needs retries that can take a second or
      // two. Keep that out of the test's time and wait for all removals before the test file ends.
      const removal = fs
        .rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        .catch(() => undefined)
        .finally(() => removals.delete(removal))
      removals.add(removal)
    },
    path: dir,
    extra: extra as T,
  }
  return result
}

/**
 * Points the global config root (Global.Path.config) at dir until disposed, so the global config and skills a test
 * writes do not leak into the other tests of the process
 */
export function globalConfig(dir: string) {
  const previous = Global.Path.config
  const point = (to: string) => {
    Global.Path.config = to
    Config.global.reset()
  }
  point(dir)
  return { [Symbol.dispose]: () => point(previous) }
}

/**
 * Source loader that lets Node run .ts directly (TypeScript, extensionless imports, text imports); see
 * script/node/register.mjs
 */
const register = new URL("../../../../script/node/register.mjs", import.meta.url).href

/** Command prefix to run a TypeScript source file with the current runtime: `[...runtime, "file.ts", ...args]` */
export const runtime = [process.execPath, "--import", register, "--disable-warning=ExperimentalWarning"]

/** Runs ESM code with the current runtime (can import .ts and use top-level await): `[...evaluate(code), ...args]` */
export const evaluate = (code: string) => [...runtime, "--input-type=module", "--eval", code]
