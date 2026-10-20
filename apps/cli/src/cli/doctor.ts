/**
 * Checks behind `merak doctor` and `merak bug-report`. Every check runs even if an earlier one failed; checks that
 * need the engine are skipped when it does not start.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import os from "os"
import path from "path"
import { createMerakCodeClient, type MerakCodeClient } from "@merakcode/sdk/client"
import { fromResponse, isMerakCodeError } from "@merakcode/sdk/errors"
import type { Engine } from "@merakcode/sdk/process"
import { Log } from "@merakcode/log/logger"
import { resolveLogRoot } from "@merakcode/log/node"
import { configSyntaxError } from "@merakcode/util/config-peek"
import { ErrorCode } from "@merakcode/util/error-code"
import { globalConfigFile } from "@merakcode/util/paths"
import { Installation } from "./installation"
import { launchEngine } from "./engine"
import { I18n } from "./i18n"

export namespace Doctor {
  export type Status = "pass" | "warn" | "fail" | "skip"
  export type Check = { id: string; status: Status; detail: string; code?: string; hint?: string }

  const failure = (id: string, status: "warn" | "fail", code: string, detail: string): Check => {
    const spec = ErrorCode.spec(code)
    const zh = I18n.current() === "zh-CN"
    return {
      id,
      status,
      code,
      detail: detail || (spec ? (zh ? spec.title.zh : spec.title.en) : ""),
      hint: spec ? (zh ? spec.hint.zh : spec.hint.en) : undefined,
    }
  }

  const caught = (id: string, error: unknown) =>
    failure(
      id,
      "fail",
      isMerakCodeError(error) ? error.code : ErrorCode.CATALOG.INTERNAL.code,
      error instanceof Error ? error.message.split("\n")[0]! : String(error),
    )

  function config(cwd: string): Check {
    const files = [
      globalConfigFile(),
      ...["merakcode.json", "merakcode.jsonc"].flatMap((name) => [
        path.join(cwd, name),
        path.join(cwd, ".merakcode", name),
      ]),
    ].filter((file) => existsSync(file))
    for (const file of files) {
      const error = configSyntaxError(file)
      if (error) return failure("config", "fail", ErrorCode.CATALOG.CONFIG_JSON_INVALID.code, `${file}:${error.line}`)
    }
    return { id: "config", status: "pass", detail: files.length ? files.join(", ") : I18n.t("cli.doctor.noConfig") }
  }

  async function call<T>(request: Promise<{ data?: T; error?: unknown; response?: Response }>) {
    const result = await request
    if (result.error !== undefined || result.data === undefined) throw fromResponse(result.error, result.response)
    return result.data
  }

  async function providers(client: MerakCodeClient): Promise<Check> {
    const list = await call(client.provider.list())
    if (!list.connected.length) return failure("providers", "warn", ErrorCode.CATALOG.NO_MODEL.code, "")
    return { id: "providers", status: "pass", detail: list.connected.join(", ") }
  }

  async function sandbox(client: MerakCodeClient): Promise<Check> {
    const info = await call(client.sandbox.status())
    if (info.status === "on") return { id: "sandbox", status: "pass", detail: I18n.t("cli.doctor.sandboxOn") }
    if (info.status === "off") return { id: "sandbox", status: "warn", detail: I18n.t("cli.doctor.sandboxOff") }
    const detail = info.installable ? I18n.t("cli.doctor.sandboxNotSetUp") : (info.reason ?? "")
    return failure("sandbox", "warn", ErrorCode.CATALOG.SANDBOX_UNAVAILABLE.code, detail)
  }

  /** Searches an empty folder so the check does not scan the user's project */
  async function ripgrep(client: MerakCodeClient, dir: string): Promise<Check> {
    await call(client.find.files({ query: "doctor", directory: dir }))
    return { id: "ripgrep", status: "pass", detail: "ripgrep" }
  }

  function logs(): Check {
    const root = resolveLogRoot()
    try {
      mkdirSync(root, { recursive: true })
      const probe = path.join(root, `.doctor-${process.pid}`)
      writeFileSync(probe, "")
      rmSync(probe, { force: true })
      return { id: "logs", status: "pass", detail: root }
    } catch (error) {
      return failure(
        "logs",
        "fail",
        ErrorCode.CATALOG.LOG_DIR_NOT_WRITABLE.code,
        `${root}: ${(error as Error).message}`,
      )
    }
  }

  async function network(): Promise<Check> {
    const hosts = [
      `${Installation.releasesApi()}/releases/latest`,
      Installation.npmRegistry() ?? "https://registry.npmjs.org/",
    ]
    const failed = (
      await Promise.all(
        hosts.map((url) =>
          fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) }).then(
            (response) => (response.status >= 500 ? new URL(url).host : undefined),
            () => new URL(url).host,
          ),
        ),
      )
    ).filter((host): host is string => !!host)
    if (failed.length) return failure("network", "fail", ErrorCode.CATALOG.NETWORK_UNREACHABLE.code, failed.join(", "))
    return { id: "network", status: "pass", detail: hosts.map((url) => new URL(url).host).join(", ") }
  }

  export async function run(input: { cwd: string; network?: boolean }): Promise<Check[]> {
    const checks: Check[] = [
      {
        id: "version",
        status: "pass",
        detail: `${Installation.VERSION} · ${Installation.channel()} · ${Installation.method()}`,
      },
      {
        id: "system",
        status: "pass",
        detail: `${process.platform} ${process.arch} ${os.release()} · ${process.release.name} ${process.version}`,
      },
      config(input.cwd),
    ]
    const started = Date.now()
    const engine = await launchEngine({ cwd: input.cwd, client: "cli" }).then(
      (engine): Engine | undefined => engine,
      (error: unknown) => {
        checks.push(caught("engine", error))
        return undefined
      },
    )
    const client = engine
      ? createMerakCodeClient({
          baseUrl: engine.url,
          headers: engine.headers,
          directory: input.cwd,
          clientRun: Log.id(),
        })
      : undefined
    const empty = mkdtempSync(path.join(os.tmpdir(), "merak-doctor-"))
    try {
      if (client) {
        const health = await call(client.global.health()).then(
          (health): Check => ({
            id: "engine",
            status: "pass",
            detail: `${health.version} · ${Date.now() - started} ms`,
          }),
          (error: unknown) => caught("engine", error),
        )
        checks.push(health)
      }
      for (const [id, check] of [
        ["providers", providers],
        ["sandbox", sandbox],
        ["ripgrep", (client: MerakCodeClient) => ripgrep(client, empty)],
      ] as const) {
        if (!client) {
          checks.push({ id, status: "skip", detail: I18n.t("cli.doctor.needsEngine") })
          continue
        }
        checks.push(await check(client).catch((error: unknown) => caught(id, error)))
      }
    } finally {
      await engine?.close()
      // Windows keeps the folder locked for a moment after the engine exits
      rmSync(empty, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
    checks.push(logs())
    if (input.network) checks.push(await network())
    return checks
  }
}
