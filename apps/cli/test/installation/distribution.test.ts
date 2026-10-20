import { describe, expect, test } from "vitest"
import { Project } from "@merakcode/util/project"
import { Installation } from "../../src/cli/installation"
import { Http } from "@merakcode/util/http"

function serve(handler: (req: Request) => Response | Promise<Response>) {
  return Http.serve({ port: 0, hostname: "127.0.0.1", fetch: handler })
}

describe("npm distribution", () => {
  test("the package name is merakcode", () => {
    expect(Installation.NPM_PACKAGE).toBe("merakcode")
  })
})

describe("GitHub Releases version lookup", () => {
  /** Points the GitHub API at the local server for one call */
  async function query(url: URL) {
    process.env.MERAKCODE_RELEASES_API = url.href
    try {
      return await Installation.latestRelease("latest")
    } finally {
      delete process.env.MERAKCODE_RELEASES_API
    }
  }

  test("reads the version from the latest release's tag", async () => {
    await using server = await serve(() => Response.json({ tag_name: "v0.3.1", html_url: "https://example.test/r" }))
    expect(await query(server.url)).toBe("0.3.1")
  })

  test("throws when there is no tag", async () => {
    await using server = await serve(() => Response.json({}))
    await expect(query(server.url)).rejects.toThrow()
  })

  test("fails within 3 seconds when the server does not respond", async () => {
    await using server = await serve(() => new Promise<Response>(() => {}))
    const started = Date.now()
    await expect(query(server.url)).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(4_000)
  }, 10_000)
})

describe("upgrade with an unknown install method", () => {
  test("cannot upgrade in place and the error gives the download URL", async () => {
    await expect(Installation.upgrade("unknown", "9.9.9")).rejects.toThrow(Project.RELEASES)
  })
})
