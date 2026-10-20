/**
 * Test helpers: run source code with the current runtime (with the source loader, so .ts imports work) and
 * self-deleting temporary directories. This package does not depend on @merakcode/util, so processes and file I/O
 * use Node built-ins.
 */
import { spawn as spawnChild } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"

const register = new URL("../../../script/node/register.mjs", import.meta.url).href

export const runtime = [process.execPath, "--import", register, "--disable-warning=ExperimentalWarning"]

export const evaluate = (code: string) => [...runtime, "--input-type=module", "--eval", code]

export async function tmpdir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "merakcode-log-test-"))
  return { path: dir, [Symbol.asyncDispose]: () => rm(dir, { recursive: true, force: true, maxRetries: 5 }) }
}

/** Spawns a child process: exited resolves with the exit code; stdout/stderr are web streams (usable with Response) */
export function spawn(
  command: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; stdout?: "pipe"; stderr?: "pipe" } = {},
) {
  const [file, ...args] = command
  const child = spawnChild(file!, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] })
  return {
    exited: new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? 1))),
    stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
  }
}

export const files = {
  readText: (file: string) => readFile(file, "utf8"),
  write: async (file: string, text: string) => {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, text)
  },
  isFile: (file: string) =>
    stat(file).then(
      (info) => info.isFile(),
      () => false,
    ),
  size: (file: string) => stat(file).then((info) => info.size),
}
