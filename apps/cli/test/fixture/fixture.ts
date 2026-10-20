import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"
import { Project } from "@merakcode/util/project"
import type { Config } from "@merakcode/sdk/client"

// Strip null bytes from paths (defensive fix for CI environment issues)
function sanitizePath(p: string): string {
  return p.replace(/\0/g, "")
}

type TmpDirOptions<T> = {
  git?: boolean
  config?: Partial<Config>
  init?: (dir: string) => Promise<T>
  dispose?: (dir: string) => Promise<T>
}
/** Temporary directories being removed in the background (see tmpdir's dispose) */
const removals = new Set<Promise<void>>()

/** Waits until every temporary directory is removed; preload calls it at the end of each test file */
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
        $schema: `https://raw.githubusercontent.com/${Project.REPOSITORY}/main/schema/config.json`,
        ...options.config,
      }),
    )
  }
  const extra = await options?.init?.(dir)
  const result = {
    [Symbol.asyncDispose]: async () => {
      await options?.dispose?.(dir)
      // On Windows antivirus often holds freshly written files, so removal retries and can take a second or two. Do it
      // outside the test's time and wait for all removals before the test file ends
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

// On Windows --import only accepts file:// URLs, not drive-letter paths
const register = new URL("../../../../script/node/register.mjs", import.meta.url).href

/** Command prefix that runs a TypeScript source file with the current runtime: `[...runtime, "src/index.ts", ...args]` */
export const runtime = [process.execPath, "--import", register, "--disable-warning=ExperimentalWarning"]

/** Command prefix that runs the CLI from source: `[...cli, "debug", "paths"]` */
export const cli = [...runtime, path.resolve(import.meta.dirname, "../../src/index.ts")]
