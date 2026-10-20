import type { PluginShell, PluginShellOutput, PluginShellPromise, ShellExpression } from "@merakcode/sdk/plugin"
import { Shell } from "../shell/shell"

type Defaults = { cwd?: string; env?: Record<string, string | undefined>; throws: boolean }

/** The plugin API's `$`: joins the template into one command line and runs it in the bash tool's shell (Shell.run) */
export function createPluginShell(defaults: Defaults = { throws: true }): PluginShell {
  const shell = ((strings: TemplateStringsArray, ...expressions: ShellExpression[]) =>
    run(command(strings, expressions), defaults)) as PluginShell
  shell.escape = Shell.quote
  shell.cwd = (cwd) => createPluginShell({ ...defaults, cwd })
  shell.env = (env) => createPluginShell({ ...defaults, env })
  shell.nothrow = () => createPluginShell({ ...defaults, throws: false })
  shell.throws = (throws) => createPluginShell({ ...defaults, throws })
  return shell
}

function command(strings: TemplateStringsArray, expressions: ShellExpression[]) {
  return strings.reduce(
    (line, text, index) => line + text + (index < expressions.length ? render(expressions[index]) : ""),
    "",
  )
}

function render(value: ShellExpression): string {
  if (Array.isArray(value)) return value.map(render).join(" ")
  if (typeof value === "object" && value !== null && "raw" in value) return value.raw
  return Shell.quote(String(value))
}

function run(line: string, defaults: Defaults): PluginShellPromise {
  const options = { ...defaults }
  // Runs only once awaited, so .cwd() / .env() / .nothrow() apply first
  let started: Promise<PluginShellOutput> | undefined
  const start = () =>
    (started ??= Shell.run(line, {
      cwd: options.cwd,
      env: options.env && complete(options.env),
      replaceEnv: options.env !== undefined,
    }).then((result) => {
      const output = wrap(result.stdout, result.stderr, result.exitCode)
      if (result.exitCode !== 0 && options.throws) {
        throw Object.assign(new Error(`Command failed with exit code ${result.exitCode}: ${line}`), output)
      }
      return output
    }))
  const promise = {
    then: (resolve?: (value: PluginShellOutput) => unknown, reject?: (error: unknown) => unknown) =>
      start().then(resolve, reject),
    catch: (reject?: (error: unknown) => unknown) => start().catch(reject),
    finally: (callback?: () => void) => start().finally(callback),
    [Symbol.toStringTag]: "PluginShellPromise",
    cwd(cwd: string) {
      options.cwd = cwd
      return promise
    },
    env(env: Record<string, string | undefined> | undefined) {
      options.env = env
      return promise
    },
    quiet: () => promise,
    nothrow() {
      options.throws = false
      return promise
    },
    throws(throws: boolean) {
      options.throws = throws
      return promise
    },
    text: async (encoding?: BufferEncoding) => (await start()).text(encoding),
    json: async () => (await start()).json(),
    arrayBuffer: async () => (await start()).arrayBuffer(),
    blob: async () => (await start()).blob(),
    async *lines() {
      const text = (await start()).text()
      yield* text.split(/\r?\n/).filter((line, index, all) => line !== "" || index < all.length - 1)
    },
  }
  return promise as unknown as PluginShellPromise
}

function complete(env: Record<string, string | undefined>) {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

function wrap(stdout: Buffer, stderr: Buffer, exitCode: number): PluginShellOutput {
  return {
    stdout,
    stderr,
    exitCode,
    text: (encoding) => stdout.toString(encoding),
    json: () => JSON.parse(stdout.toString()),
    arrayBuffer: () => stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.byteLength) as ArrayBuffer,
    bytes: () => new Uint8Array(stdout),
    blob: () => new Blob([new Uint8Array(stdout)]),
  }
}
