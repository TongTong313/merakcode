import { describe, test, expect } from "vitest"
import { Http } from "@merakcode/util/http"
import { Discovery } from "@merakcode/engine/agent/skill/discovery"
import path from "path"
import { Filesystem } from "@merakcode/util/filesystem"
import { Glob } from "@merakcode/util/glob"

async function fixtureServer() {
  const server = await Http.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/.well-known/skills/index.json") {
        return Response.json({
          skills: [
            {
              name: "agents-sdk",
              description: "Agents SDK",
              files: ["SKILL.md", "references/guide.md"],
            },
          ],
        })
      }
      if (url.pathname === "/.well-known/skills/agents-sdk/SKILL.md") {
        return new Response("---\nname: agents-sdk\ndescription: Agents SDK\n---\n# Agents SDK\n")
      }
      if (url.pathname === "/.well-known/skills/agents-sdk/references/guide.md") {
        return new Response("# Guide\n")
      }
      return new Response("not found", { status: 404 })
    },
  })
  return {
    url: `${server.url.origin}/.well-known/skills/`,
    stop: () => server.stop(true),
  }
}

describe("Discovery.pull", () => {
  test("downloads skills from discovery url", async () => {
    const server = await fixtureServer()
    try {
      const dirs = await Discovery.pull(server.url)
      expect(dirs.length).toBeGreaterThan(0)
      for (const dir of dirs) {
        expect(dir).toSatisfy((value: string) => value.startsWith(Discovery.dir()))
        const md = path.join(dir, "SKILL.md")
        expect(await Filesystem.isFile(md)).toBe(true)
      }
    } finally {
      await server.stop()
    }
  })

  test("url without trailing slash works", async () => {
    const server = await fixtureServer()
    try {
      const dirs = await Discovery.pull(server.url.replace(/\/$/, ""))
      expect(dirs.length).toBeGreaterThan(0)
      for (const dir of dirs) {
        const md = path.join(dir, "SKILL.md")
        expect(await Filesystem.isFile(md)).toBe(true)
      }
    } finally {
      await server.stop()
    }
  })

  test("returns empty array for invalid url", async () => {
    const dirs = await Discovery.pull("https://example.invalid/.well-known/skills/")
    expect(dirs).toEqual([])
  })

  test("returns empty array for non-json response", async () => {
    const dirs = await Discovery.pull("https://example.com/")
    expect(dirs).toEqual([])
  })

  test("downloads reference files alongside SKILL.md", async () => {
    const server = await fixtureServer()
    try {
      const dirs = await Discovery.pull(server.url)
      const agentsSdk = dirs.find((d) => d.replace(/\\/g, "/").endsWith("/agents-sdk"))
      expect(agentsSdk).toBeDefined()
      if (!agentsSdk) throw new Error("agents-sdk skill was not downloaded")
      const refs = path.join(agentsSdk, "references")
      expect(await Filesystem.isFile(path.join(agentsSdk, "SKILL.md"))).toBe(true)
      const refDir = await Array.fromAsync(new Glob("**/*.md").scan({ cwd: refs, onlyFiles: true }))
      expect(refDir.length).toBeGreaterThan(0)
    } finally {
      await server.stop()
    }
  })

  test("caches downloaded files on second pull", async () => {
    const server = await fixtureServer()
    try {
      const first = await Discovery.pull(server.url)
      expect(first.length).toBeGreaterThan(0)

      const second = await Discovery.pull(server.url)
      expect(second.length).toBe(first.length)
      expect(second.sort()).toEqual(first.sort())
    } finally {
      await server.stop()
    }
  })
})
