/**
 * merak skill: lists the installable skills from a skill index URL and installs one by name; an unrecognized source
 * is reported with a reason. The index is a local fake server (the /.well-known/skills/index.json protocol)
 */
import { expect, test } from "vitest"
import path from "path"
import { Filesystem } from "@merakcode/util/filesystem"
import { Http } from "@merakcode/util/http"
import { Process } from "@merakcode/util/process"
import { cli, tmpdir } from "../fixture/fixture"

async function index() {
  const server = await Http.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/.well-known/skills/index.json") {
        return Response.json({
          skills: [
            { name: "review", files: ["SKILL.md"] },
            { name: "release", files: ["SKILL.md"] },
          ],
        })
      }
      const descriptions: Record<string, string> = {
        review: "Review a change   before merging",
        release: "Cut a release",
      }
      const skill = url.pathname.match(/^\/\.well-known\/skills\/(\w+)\/SKILL\.md$/)?.[1]
      if (skill) return new Response(`---\nname: ${skill}\ndescription: ${descriptions[skill]}\n---\n# ${skill}\n`)
      return new Response("not found", { status: 404 })
    },
  })
  return {
    url: `${server.url.origin}/.well-known/skills/`,
    [Symbol.asyncDispose]: () => server.stop(true),
  }
}

async function merak(cwd: string, ...args: string[]) {
  const proc = Process.spawn([...cli, ...args], {
    cwd,
    env: { ...process.env, MERAKCODE_LOCALE: "en", MERAKCODE_DISABLE_CATALOG_FETCH: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, output: stdout + stderr, code }
}

test(
  "list shows names and descriptions (extra whitespace collapsed); install --name --global installs into the global skills directory",
  { timeout: 120_000 },
  async () => {
    await using tmp = await tmpdir()
    await using skills = await index()

    const listed = await merak(tmp.path, "skill", "list", skills.url)
    expect(listed.code).toBe(0)
    // Skills download in parallel, so the listing order varies
    expect(listed.stdout.split(/\r?\n/).filter(Boolean).toSorted()).toEqual([
      "release\tCut a release",
      "review\tReview a change before merging",
    ])

    // Without --global the target is picked in a prompt; the test is non-interactive, so it passes --global
    const installed = await merak(tmp.path, "skill", "install", skills.url, "--name", "review", "--global")
    expect(installed.code).toBe(0)
    expect(installed.output).toMatch(/review → .*skills[\\/]review[\\/]/)
    const file = installed.output.match(/review → (.*skills[\\/]review)[\\/]/)?.[1]
    expect(await Filesystem.readText(path.join(file!, "SKILL.md"))).toContain("name: review")
  },
)

test("an unrecognized source fails and explains the expected format", { timeout: 60_000 }, async () => {
  await using tmp = await tmpdir()
  const result = await merak(tmp.path, "skill", "list", "not a source")
  expect(result.code).toBe(1)
  expect(result.output).toContain("Unrecognized format")
})
