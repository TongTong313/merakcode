/**
 * merak upgrade / merak update: version comparison, which release a channel gets, and the command's choices.
 * GitHub is replaced by a local server through MERAKCODE_RELEASES_API.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { Process } from "@merakcode/util/process"
import { newer } from "../../src/cli/upgrade"
import { Installation } from "../../src/cli/installation"
import { cli, tmpdir } from "../fixture/fixture"

const releases = [
  { tag_name: "v0.3.0-beta.2", draft: false, prerelease: true },
  { tag_name: "v0.3.0-rc.1", draft: false, prerelease: true },
  { tag_name: "v0.2.0", draft: false, prerelease: false },
  { tag_name: "v0.4.0-beta.1", draft: true, prerelease: true },
  { tag_name: "v0.2.0-beta.5", draft: false, prerelease: true },
]

let server: http.Server
let api = ""
/** A repository that has published nothing yet: GitHub answers 404 for the latest release */
let empty: http.Server
let none = ""
beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json")
    if (req.url?.startsWith("/releases/latest")) return res.end(JSON.stringify(releases[2]))
    if (req.url?.startsWith("/releases")) return res.end(JSON.stringify(releases))
    res.statusCode = 404
    res.end("{}")
  })
  empty = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json")
    if (req.url?.startsWith("/releases/latest")) {
      res.statusCode = 404
      return res.end(JSON.stringify({ message: "Not Found" }))
    }
    res.end("[]")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  await new Promise<void>((resolve) => empty.listen(0, "127.0.0.1", resolve))
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  none = `http://127.0.0.1:${(empty.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await new Promise<void>((resolve) => empty.close(() => resolve()))
})

describe("newer", () => {
  test("pre-releases come before their release; numbers compare as numbers", () => {
    expect(newer("0.2.0", "0.2.0-beta.1")).toBe(true)
    expect(newer("0.1.10", "0.1.9")).toBe(true)
    expect(newer("0.2.0-beta.1", "0.2.0")).toBe(false)
    expect(newer("0.2.0", "0.2.0")).toBe(false)
  })
})

describe("Installation.latestRelease", () => {
  test("the stable channel gets the latest release", async () => {
    process.env.MERAKCODE_RELEASES_API = api
    try {
      expect(await Installation.latestRelease("latest")).toBe("0.2.0")
    } finally {
      delete process.env.MERAKCODE_RELEASES_API
    }
  })

  test("a pre-release channel gets its highest version, ignoring drafts and other channels", async () => {
    process.env.MERAKCODE_RELEASES_API = api
    try {
      expect(await Installation.latestRelease("beta")).toBe("0.3.0-beta.2")
      expect(await Installation.latestRelease("rc")).toBe("0.3.0-rc.1")
    } finally {
      delete process.env.MERAKCODE_RELEASES_API
    }
  })

  test("a channel with nothing published is reported as such, not as an HTTP failure", async () => {
    process.env.MERAKCODE_RELEASES_API = none
    try {
      await expect(Installation.latestRelease("latest")).rejects.toBeInstanceOf(Installation.NoReleaseError)
      await expect(Installation.latestRelease("beta")).rejects.toBeInstanceOf(Installation.NoReleaseError)
    } finally {
      delete process.env.MERAKCODE_RELEASES_API
    }
    process.env.MERAKCODE_RELEASES_API = api
    try {
      await expect(Installation.latestRelease("alpha")).rejects.toBeInstanceOf(Installation.NoReleaseError)
    } finally {
      delete process.env.MERAKCODE_RELEASES_API
    }
  })
})

async function merak(...args: string[]) {
  return run(api, ...args)
}

async function run(releasesApi: string, ...args: string[]) {
  await using tmp = await tmpdir()
  const proc = Process.spawn([...cli, ...args], {
    cwd: tmp.path,
    env: {
      ...process.env,
      MERAKCODE_LOCALE: "en",
      MERAKCODE_RELEASES_API: releasesApi,
      MERAKCODE_DISABLE_AUTOUPDATE: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { output: stdout + stderr, code }
}

describe("merak upgrade", () => {
  test("--check shows the current and latest versions and installs nothing", { timeout: 60_000 }, async () => {
    const result = await merak("upgrade", "--check")
    expect(result.code, result.output).toBe(0)
    expect(result.output).toContain("0.2.0")
    expect(result.output).toContain(Installation.VERSION)
    expect(result.output).not.toMatch(/Upgrading|Upgraded/)
  })

  test("update is the same command", { timeout: 60_000 }, async () => {
    const result = await merak("update", "--check")
    expect(result.code, result.output).toBe(0)
    expect(result.output).toContain("0.2.0")
  })

  test(
    "without a terminal and without --yes it only checks, and says how to install",
    { timeout: 60_000 },
    async () => {
      const result = await merak("upgrade")
      expect(result.code, result.output).toBe(0)
      expect(result.output).toContain("--yes")
    },
  )

  test("before anything is published, --check says so in plain words", { timeout: 60_000 }, async () => {
    const result = await run(none, "upgrade", "--check")
    expect(result.code, result.output).toBe(0)
    expect(result.output).toContain("No release")
    expect(result.output).not.toContain("HTTP 404")
  })

  test("an invalid version is refused", { timeout: 60_000 }, async () => {
    const result = await merak("upgrade", "1.x")
    expect(result.code).toBe(1)
    expect(result.output).toContain("1.x")
  })
})
