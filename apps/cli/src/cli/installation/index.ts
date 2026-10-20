/**
 * This merak installation: version, channel and install method (npm or install script), plus looking up the latest
 * version and self-upgrading. Upgrading is handled by the CLI itself, not the engine.
 */
import { randomUUID } from "node:crypto"
import semver from "semver"
import z from "zod"
import { Build } from "@merakcode/util/build"
import { NamedError } from "@merakcode/util/error"
import { Project } from "@merakcode/util/project"
import { Process } from "@merakcode/util/process"
import { withTrustedTls } from "@merakcode/util/tls"
import { Log } from "@merakcode/log/logger"
import { VERSION as PRODUCT_VERSION } from "../../product-version"
import { Release } from "./release"
import pkg from "../../../package.json"

export namespace Installation {
  const updateLog = Log.create({ service: "updater", channel: "update" })

  export const VERSION = PRODUCT_VERSION

  /** Main package name on npm. */
  export const NPM_PACKAGE = pkg.name

  export function channel() {
    return Build.channel
  }

  export function isLocal() {
    return channel() === "local"
  }

  /**
   * Timeout for version lookups. They run in the post-startup upgrade check, where a bare fetch on a dead network
   * hangs until the OS TCP timeout; 3 seconds is enough for a normal metadata response, and a timeout means no update.
   */
  const VERSION_QUERY_TIMEOUT_MS = 3_000

  /** MERAKCODE_NPM_REGISTRY takes precedence; otherwise npm's own config applies. */
  export function npmRegistry(): string | undefined {
    const registry = process.env.MERAKCODE_NPM_REGISTRY?.trim()
    if (!registry) return undefined
    return registry.endsWith("/") ? registry.slice(0, -1) : registry
  }

  /** npm: global npm install; release: GitHub Releases archive from the install script; unknown: source, etc. */
  export type Method = "npm" | "release" | "unknown"

  /**
   * Install method, based on where the running code lives (all release code is under lib/). The first merakcode on
   * PATH is not necessarily the running copy, so it is not used.
   */
  export function method(here = import.meta.dirname): Method {
    if (Release.installed(here)) return "release"
    if (/[\\/]node_modules[\\/]merakcode-[a-z]+-[a-z0-9]+[\\/]lib([\\/]|$)/.test(here)) return "npm"
    return "unknown"
  }

  export const UpgradeFailedError = NamedError.create(
    "UpgradeFailedError",
    z.object({
      stderr: z.string(),
    }),
  )

  export async function upgrade(method: Method, target: string, id?: string) {
    const updateID = id ?? randomUUID()
    const started = Date.now()
    updateLog.info("update started", {
      updateID,
      stage: "install",
      status: "started",
      method,
      current: VERSION,
      target,
    })
    if (method === "release") {
      await Release.install(target).catch((error: unknown) => {
        updateLog.error("update failed", {
          updateID,
          stage: "install",
          status: "failed",
          method,
          current: VERSION,
          target,
          duration: Date.now() - started,
          error,
        })
        throw error
      })
      updateLog.info("update completed", {
        updateID,
        stage: "install",
        status: "completed",
        method,
        current: VERSION,
        target,
        duration: Date.now() - started,
      })
      return
    }
    if (method !== "npm") {
      updateLog.warn("update method unavailable", {
        updateID,
        stage: "install",
        status: "unsupported",
        method,
        current: VERSION,
        target,
      })
      throw new Error(`This installation cannot upgrade itself. Download ${target} from ${Project.RELEASES}`)
    }

    // Use the npm on PATH that the user installed with, not a bundled one, so the global prefix matches.
    const registry = npmRegistry()
    const cmd = [
      "npm",
      "install",
      "-g",
      `${NPM_PACKAGE}@${target}`,
      ...(registry ? [`--registry=${registry}`] : []),
      "--foreground-scripts",
      "--loglevel",
      "verbose",
    ]
    updateLog.info("update prepared", {
      updateID,
      stage: "install",
      status: "running",
      summary: `npm ${NPM_PACKAGE}@${target} registry=${registry ?? "(npm default)"}`,
    })
    const result = await Process.run(cmd, { nothrow: true })
    if (result.exitCode !== 0) {
      const stdout = result.stdout.toString("utf8")
      const stderr = result.stderr.toString("utf8")
      updateLog.error("update failed", {
        updateID,
        stage: "install",
        status: "failed",
        method,
        current: VERSION,
        target,
        exitCode: result.exitCode,
        duration: Date.now() - started,
        ...commandErrorEvidence(stderr || stdout),
      })
      if (stdout.trim()) process.stdout.write(stdout)
      if (stderr.trim()) process.stderr.write(stderr)
      throw new UpgradeFailedError({ stderr })
    }
    updateLog.info("update completed", {
      updateID,
      stage: "install",
      status: "completed",
      method,
      current: VERSION,
      target,
      duration: Date.now() - started,
    })
  }

  function commandErrorEvidence(output: string) {
    return {
      errorCodes: [...new Set(output.match(/\b(?:E[A-Z0-9]{3,}|ERR_[A-Z0-9_]+)\b/g) ?? [])].slice(0, 20),
      httpStatuses: [
        ...new Set(Array.from(output.matchAll(/\b(?:HTTP\s*)?([45]\d\d)\b/gi), (match) => match[1])),
      ].slice(0, 20),
      outputBytes: Buffer.byteLength(output),
    }
  }

  /** Release track of a version: latest for releases, the pre-release name (beta, rc …) otherwise */
  export function track(version = VERSION) {
    return version.split("-")[1]?.split(".")[0] || "latest"
  }

  /** GitHub API of the repository; MERAKCODE_RELEASES_API points it at a mirror or a test server */
  export function releasesApi() {
    return (process.env.MERAKCODE_RELEASES_API?.trim() || `https://api.github.com/repos/${Project.REPOSITORY}`).replace(
      /\/$/,
      "",
    )
  }

  /** Nothing has been published on this release track yet */
  export class NoReleaseError extends Error {
    constructor(readonly track: string) {
      super(`No ${track} release has been published yet`)
      this.name = "NoReleaseError"
    }
  }

  /** undefined when GitHub answers 404 (for /releases/latest that means nothing is published yet) */
  async function github(path: string) {
    const res = await fetch(
      `${releasesApi()}${path}`,
      withTrustedTls({
        headers: { Accept: "application/vnd.github+json", "User-Agent": `merakcode/${channel()}/${VERSION}/cli` },
        signal: AbortSignal.timeout(VERSION_QUERY_TIMEOUT_MS),
      }),
    )
    if (res.status === 404) return undefined
    if (!res.ok) throw new Error(`GitHub release query failed: HTTP ${res.status}`)
    return res.json() as Promise<unknown>
  }

  /**
   * Newest version on GitHub Releases for a track: the latest release, or for a pre-release track the highest
   * published version of that track (drafts left out)
   */
  export async function latestRelease(release = track()) {
    if (release === "latest") {
      const data = (await github("/releases/latest")) as { tag_name?: unknown } | undefined
      if (!data) throw new NoReleaseError(release)
      if (typeof data.tag_name !== "string" || !data.tag_name.trim()) throw new Error("GitHub release has no tag")
      return data.tag_name.trim().replace(/^v/, "")
    }
    const list = ((await github("/releases?per_page=50")) ?? []) as { tag_name?: unknown; draft?: unknown }[]
    const versions = list
      .filter((item) => item.draft !== true && typeof item.tag_name === "string")
      .map((item) => String(item.tag_name).replace(/^v/, ""))
      .filter((version) => semver.valid(version) && track(version) === release)
    const best = versions.sort(semver.rcompare)[0]
    if (!best) throw new NoReleaseError(release)
    return best
  }

  export async function latest(installMethod?: Method) {
    if ((installMethod ?? method()) === "npm") {
      // Read-only query: use the public registry when none is configured.
      const res = await fetch(`${npmRegistry() ?? "https://registry.npmjs.org"}/${NPM_PACKAGE}/${track()}`, {
        signal: AbortSignal.timeout(VERSION_QUERY_TIMEOUT_MS),
      })
      if (res.status === 404) throw new NoReleaseError(track())
      if (!res.ok) throw new Error(res.statusText)
      const data = (await res.json()) as { version?: string }
      if (!data.version) throw new Error(`npm registry returned no version for ${NPM_PACKAGE}`)
      return data.version
    }

    return latestRelease()
  }
}
