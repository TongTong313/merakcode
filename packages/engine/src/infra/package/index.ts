import z from "zod"
import { existsSync, readFileSync, statSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import semver from "semver"
import { NamedError } from "@merakcode/util/error"
import { Process } from "@merakcode/util/process"
import { Filesystem } from "@merakcode/util/filesystem"
import { Text } from "@merakcode/util/text"
import { Global } from "../global"
import { Log } from "@merakcode/log/logger"
import { Lock } from "@merakcode/engine/infra/concurrency/lock"
import { containProcess } from "../process/tree"

/**
 * Installs packages at runtime: plugins, provider SDKs, language servers and formatters.
 *
 * Uses the npm bundled with the release (next to node), run by the current runtime, so the user does not need Node
 * installed; when it is missing (development) it falls back to npm on PATH. Registry, proxy and similar settings come
 * from npm's own config (.npmrc, environment variables).
 */
export namespace Npm {
  const log = Log.create({ service: "npm" })

  export const InstallFailedError = NamedError.create(
    "PackageInstallFailedError",
    z.object({
      pkg: z.string(),
      version: z.string(),
    }),
  )

  /** Full command prefix for running npm, e.g. [node, .../npm-cli.js] or ["npm"] */
  export function command(): string[] {
    const cli = process.env.MERAKCODE_NPM_CLI ?? bundled()
    if (cli) return [process.execPath, cli]
    return ["npm"]
  }

  /** Where official Node distributions put npm: next to node.exe on Windows, under ../lib on Unix */
  function bundled() {
    const dir = path.dirname(process.execPath)
    return [
      path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"),
      path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ].find((file) => existsSync(file))
  }

  /**
   * Runs a package's command line tool (like npx); returns the command prefix for the caller to append arguments to.
   * Without --no-audit, npm waits for an audit report from the registry before running the tool it just installed.
   */
  export function exec(pkg: string, bin?: string): string[] {
    return [...command(), "exec", "--yes", "--no-audit", `--package=${pkg}`, "--", bin ?? pkg]
  }

  /**
   * Installs a spec (name@version, tgz path, etc.) into prefix and returns the installed package directory.
   * name is the installed package name; it is required when spec is not a package name.
   */
  export async function install(spec: string, options: { prefix: string; name?: string; signal?: AbortSignal }) {
    const name = options.name ?? nameOf(spec)
    await fs.mkdir(options.prefix, { recursive: true })
    log.info("installing", { spec, prefix: options.prefix })
    const result = await Process.run(
      [...command(), "install", "--save-exact", "--no-audit", "--no-fund", "--prefix", options.prefix, spec],
      { cwd: options.prefix, signal: options.signal, nothrow: true },
    )
    if (result.exitCode !== 0) {
      log.error("install failed", { spec, code: result.exitCode, stderr: result.stderr.toString() })
      throw new InstallFailedError(
        { pkg: name, version: versionOf(spec) },
        { cause: new Error(result.stderr.toString().trim() || `npm exited with ${result.exitCode}`) },
      )
    }
    return path.join(options.prefix, "node_modules", name)
  }

  /** Installs the dependencies listed in package.json under cwd */
  export async function installDependencies(cwd: string, signal?: AbortSignal, track?: (pid: number) => Promise<void>) {
    const commandLine = command()
    const executable = commandLine[0]!
    const cli = commandLine[1] ?? (await fs.realpath(Process.which(executable) ?? executable))
    const script =
      commandLine.length > 1
        ? cli
        : process.platform === "win32"
          ? path.join(path.dirname(cli), "node_modules/npm/bin/npm-cli.js")
          : cli
    const args = ["install", "--no-audit", "--no-fund"]
    // npm starts only after its own process has been durably registered by the directory owner.
    const bootstrap = `
      let permission = "";
      for await (const chunk of process.stdin) permission += chunk;
      if (permission !== "go\\n") process.exit(1);
      process.env.MERAKCODE_DEPENDENCY_RUN = String(process.pid);
      process.argv = ${JSON.stringify([process.execPath, script, ...args])};
      await import(${JSON.stringify(pathToFileURL(script).href)});
    `
    const cmd = [process.execPath, "--input-type=module", "--eval", bootstrap]
    const child = Process.spawn(cmd, { cwd, detached: true, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    let dispose = async () => {
      child.kill()
      await child.exited
    }
    let stopping: Promise<void> | undefined
    const stop = () => (stopping ??= dispose())
    const abort = () => {
      void stop().catch(() => {})
    }
    try {
      dispose = await containProcess(
        child,
        { name: "MERAKCODE_DEPENDENCY_RUN", value: String(child.pid) },
        async (text, params) => Text.format(text, "en", params),
      )
      if (child.pid) await track?.(child.pid)
      signal?.addEventListener("abort", abort, { once: true })
      if (signal?.aborted) {
        await stop()
        signal.throwIfAborted()
      }
      void child.exited.then(stop, stop).catch(() => {})
      child.stdin!.end("go\n")
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).arrayBuffer(),
        new Response(child.stderr).arrayBuffer(),
      ])
      if (code !== 0) throw new Process.RunError(cmd, code, Buffer.from(stdout), Buffer.from(stderr))
    } finally {
      signal?.removeEventListener("abort", abort)
      await stop()
      await child.exited
    }
  }

  /** Reads a field (such as version) from the registry; returns null on failure */
  export async function view(pkg: string, field: string, cwd?: string) {
    const result = await Process.run([...command(), "view", pkg, field], { cwd, nothrow: true })
    if (result.exitCode !== 0) {
      log.warn("npm view failed", { pkg, field, code: result.exitCode })
      return null
    }
    return result.text().trim() || null
  }

  /**
   * Installs into the global cache directory (Global.Path.cache) and returns the package directory, reusing an
   * existing install whose version matches. For "latest" it checks the registry and reinstalls only when newer.
   */
  export async function cached(pkg: string, version = "latest") {
    using _ = await Lock.write("npm-install")
    const prefix = Global.Path.cache
    const manifest = path.join(prefix, "package.json")
    const parsed = await Filesystem.readJson(manifest).catch(() => ({ dependencies: {} }))
    const dependencies: Record<string, string> = parsed.dependencies ?? {}
    const mod = path.join(prefix, "node_modules", pkg)
    const current = dependencies[pkg]
    if (current && (await Filesystem.exists(mod))) {
      if (version !== "latest" && current === version) return mod
      if (version === "latest" && !(await outdated(pkg, current, prefix))) return mod
    }
    return install(`${pkg}@${version}`, { prefix, name: pkg })
  }

  async function outdated(pkg: string, current: string, cwd: string) {
    const latest = await view(pkg, "version", cwd)
    if (!latest) return false
    if (semver.validRange(current) && !semver.valid(current)) return !semver.satisfies(latest, current)
    return semver.valid(current) ? semver.lt(current, latest) : false
  }

  /**
   * Turns a package directory, file path or file:// URL into a file:// URL that import() accepts.
   * Node's ESM cannot import a directory and rejects bare absolute paths on Windows. For a package directory the ESM
   * entry is resolved from package.json: exports (import → node → default → require conditions), module, main (with
   * .js or /index.js appended), then index.js.
   */
  export function entry(target: string) {
    return find(target) ?? (target.startsWith("file://") ? target : pathToFileURL(target).href)
  }

  /** Like entry, but returns undefined when the path does not exist or the package directory has no entry file */
  export function find(target: string): string | undefined {
    if (target.startsWith("file://")) return target
    const stat = statSync(target, { throwIfNoEntry: false })
    if (!stat) return
    if (!stat.isDirectory()) return pathToFileURL(target).href
    const manifest = (() => {
      try {
        return JSON.parse(readFileSync(path.join(target, "package.json"), "utf8"))
      } catch {
        return {}
      }
    })()
    const candidates = [pick(manifest.exports), manifest.module, manifest.main, "index.js"].filter(
      (item): item is string => typeof item === "string",
    )
    for (const candidate of candidates) {
      const base = path.join(target, candidate)
      for (const file of [base, `${base}.js`, path.join(base, "index.js")]) {
        if (statSync(file, { throwIfNoEntry: false })?.isFile()) return pathToFileURL(file).href
      }
    }
  }

  const CONDITIONS = ["import", "node", "default", "require"]

  /** Resolves the root entry of exports, recursing through conditions in priority order */
  function pick(exports: unknown): string | undefined {
    if (typeof exports === "string") return exports
    if (Array.isArray(exports)) return exports.map(pick).find(Boolean)
    if (!exports || typeof exports !== "object") return
    const map = exports as Record<string, unknown>
    if (Object.keys(map).some((key) => key.startsWith("."))) return pick(map["."])
    for (const condition of CONDITIONS) {
      const found = pick(map[condition])
      if (found) return found
    }
  }

  function nameOf(spec: string) {
    const at = spec.lastIndexOf("@")
    return at > 0 ? spec.slice(0, at) : spec
  }

  function versionOf(spec: string) {
    const at = spec.lastIndexOf("@")
    return at > 0 ? spec.slice(at + 1) : "latest"
  }
}
