import { describe, expect, test } from "vitest"
import { Http } from "@merakcode/util/http"
import fs from "node:fs/promises"
import path from "node:path"
import { createMerakCodeClient, type Session } from "@merakcode/sdk/client"
import { startEngine } from "@merakcode/sdk/process"
import { selectContinueSession, runDirectoryFailure } from "../../src/cli/cmd/run.shared"
import { cli, runtime, tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"

const root = path.resolve(import.meta.dirname, "../..")
const session = (id: string, directory: string, updated = 1, created = 1): Session => ({
  id,
  directory,
  slug: id,
  projectID: "global",
  title: id,
  version: "1.4.0",
  time: { created, updated },
})

describe("continue selection", () => {
  test("filters directories, children and archived sessions before sorting by update time", () => {
    const sessions = [
      session("ses_other", "/deleted/project", 100),
      { ...session("ses_child", "/work/app", 90), parentID: "ses_parent" },
      { ...session("ses_archived", "/work/app", 80), time: { created: 1, updated: 80, archived: 0 } },
      session("ses_newer_id", "/work/app", 5, 5),
      session("ses_updated", "/work/app", 10, 1),
    ]
    expect(selectContinueSession(sessions, "/work/app")?.id).toBe("ses_updated")
    expect(selectContinueSession(sessions, "/work/missing")).toBeUndefined()
    expect(sessions[0].id).toBe("ses_other")
  })

  test("ties are deterministic; Windows path spelling matches and worktrees stay separate", () => {
    const sessions = [
      session("ses_old", "D:\\work\\app\\", 10, 1),
      session("ses_a", "d:/work/app", 10, 2),
      session("ses_z", "D:/work/app/", 10, 2),
      session("ses_worktree", "D:/work/other-tree", 100),
    ]
    expect(selectContinueSession(sessions, "d:/work/app")?.id).toBe("ses_z")
    expect(selectContinueSession(sessions.toReversed(), "D:\\work\\app")?.id).toBe("ses_z")
    expect(selectContinueSession(sessions, "D:/work/other-tree")?.id).toBe("ses_worktree")
  })

  test("directory failures distinguish missing paths, files and inaccessible directories", () => {
    expect(runDirectoryFailure({ code: "ENOENT" }).reason).toBe("directory_missing")
    expect(runDirectoryFailure({ code: "ENOTDIR" }).reason).toBe("not_directory")
    for (const code of ["EACCES", "EPERM", "EIO"]) {
      expect(runDirectoryFailure({ code }).reason).toBe("directory_unavailable")
      expect(runDirectoryFailure({ code }).message).not.toContain("不存在")
    }
  })

  test("real session storage in two non-Git directories does not resume the deleted directory", async () => {
    await using tmp = await tmpdir()
    const a = path.join(tmp.path, "a")
    const b = path.join(tmp.path, "b")
    await fs.mkdir(a)
    await fs.mkdir(b)
    const engine = await startEngine({ cwd: a, executablePath: cli })
    try {
      const client = (directory: string) =>
        createMerakCodeClient({ baseUrl: engine.url, headers: engine.headers, directory })
      const current = (await client(a).session.create({ title: "current" })).data!
      const other = (await client(b).session.create({ title: "deleted" })).data!
      expect(current.projectID).toBe(other.projectID)
      await client(b).instance.dispose()
      // Windows keeps the directory busy for a moment after the engine releases it
      await fs.rm(b, { recursive: true, maxRetries: 20, retryDelay: 100 })
      const sessions = (await client(a).session.list()).data ?? []
      expect(sessions.some((item) => item.id === other.id)).toBe(true)
      expect(selectContinueSession(sessions, a)?.id).toBe(current.id)
    } finally {
      await engine.close()
    }
  }, 60_000)
})

// Real dev entrypoint + real SDK transport; only the remote backend is a local HTTP fixture.
async function invoke(
  args: string[],
  options?: { directory: string; sessions: Session[]; failure?: "path" | "list" | "get" },
) {
  const requests: {
    method: string
    path: string
    directory: string | null
    roots: string | null
    limit: string | null
  }[] = []
  const server = options
    ? await Http.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(request) {
          const url = new URL(request.url)
          requests.push({
            method: request.method,
            path: url.pathname,
            directory: url.searchParams.get("directory") ?? request.headers.get("x-merakcode-directory"),
            roots: url.searchParams.get("roots"),
            limit: url.searchParams.get("limit"),
          })
          if (
            (options.failure === "path" && url.pathname === "/path") ||
            (options.failure === "list" && url.pathname === "/session") ||
            (options.failure === "get" && url.pathname.startsWith("/session/"))
          )
            return Response.json(
              { name: "UnknownError", data: { message: "synthetic backend failure" } },
              { status: 500 },
            )
          if (url.pathname === "/path") return Response.json({ directory: options.directory })
          if (url.pathname === "/session" && request.method === "GET") return Response.json(options.sessions)
          if (url.pathname === "/session" && request.method === "POST") {
            return Response.json(session("ses_created", options.directory))
          }
          if (url.pathname === "/event") {
            return new Response('data: {"type":"server.connected","properties":{}}\n\n', {
              headers: { "content-type": "text/event-stream" },
            })
          }
          if (url.pathname.endsWith("/fork")) return Response.json(session("ses_forked", options.directory))
          if (url.pathname.endsWith("/message") || url.pathname.endsWith("/command"))
            return Response.json({ parts: [] })
          const found = options.sessions.find((item) => url.pathname === `/session/${item.id}`)
          if (found) return Response.json(found)
          return Response.json({ name: "NotFoundError", data: { message: "session missing" } }, { status: 404 })
        },
      })
    : undefined
  const proc = Process.spawn(
    [...runtime, "src/index.ts", "run", "继续", ...(server ? ["--attach", server.url.origin] : []), ...args],
    {
      cwd: root,
      env: {
        ...process.env,
        MERAKCODE_DISABLE_MODELS_FETCH: "1",
        MERAKCODE_DISABLE_AUTOUPDATE: "1",
        MERAKCODE_DISABLE_EXTERNAL_SKILLS: "1",
        MERAKCODE_DISABLE_PROJECT_CONFIG: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const timeout = setTimeout(() => proc.kill(), 15_000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { stdout, stderr, code, requests }
  } finally {
    clearTimeout(timeout)
    if (proc.exitCode === null) proc.kill()
    await server?.stop(true)
  }
}

describe("run resume preflight", () => {
  test("-c uses the remote scope, not local cwd; ignores newer foreign sessions", async () => {
    const result = await invoke(["-c"], {
      directory: "/remote/current",
      sessions: [session("ses_wrong", "/remote/deleted", 10), session("ses_right", "/remote/current", 2)],
    })
    expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 })
    expect(result.requests.find((item) => item.path === "/session")).toMatchObject({
      directory: "/remote/current",
      roots: "true",
      limit: null,
    })
    expect(result.requests.some((item) => item.path === "/session/ses_right/message")).toBe(true)
    expect(result.requests.some((item) => item.path.includes("ses_wrong"))).toBe(false)
  }, 20_000)

  test("no matching session exits 1 with one JSON error before SSE, fork or create", async () => {
    const result = await invoke(["-c", "--fork", "--format", "json"], {
      directory: "/remote/current",
      sessions: [session("ses_other", "/remote/other")],
    })
    expect(result.code).toBe(1)
    const error = JSON.parse(result.stdout.trim())
    expect(error.type).toBe("error")
    expect(error.error.data.message).toContain("当前目录没有可继续的会话")
    expect(result.requests.map((item) => item.path)).toEqual(["/path", "/session"])
  }, 20_000)

  test("-s rejects another directory and supplies --dir guidance", async () => {
    const result = await invoke(["-s", "ses_other", "--fork"], {
      directory: "/remote/current",
      sessions: [session("ses_other", "/remote/other")],
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("--dir")
    expect(result.stderr).toContain("/remote/other")
    expect(result.requests.map((item) => item.path)).toEqual(["/path", "/session/ses_other"])
  }, 20_000)

  test("-s with the matching --dir can fork and send a command despite no local directory", async () => {
    const result = await invoke(["-s", "ses_target", "--dir", "/remote/other", "--fork", "--command", "test"], {
      directory: "/remote/other",
      sessions: [session("ses_target", "/remote/other")],
    })
    expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 })
    expect(result.requests[0]).toMatchObject({ path: "/path", directory: "/remote/other" })
    expect(result.requests.some((item) => item.path === "/session/ses_target/fork")).toBe(true)
    expect(result.requests.some((item) => item.path === "/session/ses_forked/command")).toBe(true)
  }, 20_000)

  test.each(["path", "list", "get"] as const)(
    "%s lookup failure is not reported as no session",
    async (failure) => {
      const result = await invoke(failure === "get" ? ["-s", "ses_target"] : ["-c"], {
        directory: "/remote/current",
        sessions: [],
        failure,
      })
      expect(result.code).toBe(1)
      expect(result.stderr).toContain("无法查询")
      expect(result.stderr).not.toContain("没有可继续的会话")
      expect(result.stderr).not.toContain("找不到指定会话")
      expect(result.requests.every((item) => item.method === "GET" && item.path !== "/event")).toBe(true)
    },
    20_000,
  )

  test("-s missing session reports a missing ID without starting SSE", async () => {
    const result = await invoke(["-s", "ses_missing"], { directory: "/remote/current", sessions: [] })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("找不到指定会话")
    expect(result.stderr).toContain("--dir")
    expect(result.requests.map((item) => item.path)).toEqual(["/path", "/session/ses_missing"])
  }, 20_000)

  test("conflicting flags fail as JSON before contacting a backend", async () => {
    const result = await invoke(["-c", "-s", "ses_target", "--format", "json"], {
      directory: "/remote/current",
      sessions: [],
    })
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout.trim()).error.data.message).toContain("不能同时使用")
    expect(result.requests).toEqual([])
  }, 20_000)

  test("deleted local --dir rejects continuation with JSON instead of starting a session", async () => {
    await using tmp = await tmpdir()
    const deleted = path.join(tmp.path, "deleted")
    await fs.mkdir(deleted)
    await fs.rmdir(deleted)
    const result = await invoke(["-c", "--dir", deleted, "--format", "json"])
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout.trim()).error.data.message).toContain("不存在")
  }, 20_000)

  test("a local directory replaced by a file rejects -s before sending", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "not-directory")
    await Filesystem.write(file, "fixture")
    const result = await invoke(["-s", "ses_target", "--dir", file])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("不是目录")
  }, 20_000)

  test("run without resume flags preserves the new-session flow", async () => {
    const result = await invoke([], { directory: "/remote/current", sessions: [] })
    expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 })
    expect(result.requests.some((item) => item.path === "/path")).toBe(false)
    expect(result.requests.some((item) => item.path === "/session" && item.method === "POST")).toBe(true)
    expect(result.requests.some((item) => item.path === "/session/ses_created/message")).toBe(true)
  }, 20_000)
})
