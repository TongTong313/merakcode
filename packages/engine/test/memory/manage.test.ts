// Integration tests against the real filesystem and the real memory directory (MemoryPath resolves by worktree).
import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "vitest"
import { MemoryManage } from "@merakcode/engine/memory/manage"
import { MemoryPath } from "@merakcode/engine/memory/path"
import { Instance } from "@merakcode/engine/project/instance"
import { WriteTool } from "@merakcode/engine/tool/write"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

Log.init({ print: false })

/** Writes memory entries and an optional index into the current Instance's memory directory. */
async function seed(entries: { rel: string; body: string }[], index?: string) {
  const root = MemoryPath.directory()
  for (const entry of entries) {
    const target = path.join(root, entry.rel)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await Filesystem.write(target, entry.body)
  }
  if (index !== undefined) await Filesystem.write(MemoryPath.entrypoint(), index)
  return root
}

const frontmatter = (name: string, description: string, type: string, body = "正文") =>
  ["---", `name: ${name}`, `description: ${description}`, `type: ${type}`, "---", "", body].join("\n")

describe("MemoryManage.list", () => {
  test("lists the directory, index text and memory entries with parsed frontmatter", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await seed(
          [
            { rel: "user/user_role.md", body: frontmatter("用户角色", "数据科学家", "user") },
            { rel: "feedback/testing.md", body: frontmatter("测试约定", "集成测试打真库", "feedback") },
          ],
          "- [用户角色](user/user_role.md) - 数据科学家",
        )

        const snapshot = await MemoryManage.list()

        expect(snapshot.directory).toBe(MemoryPath.directory())
        expect(snapshot.entrypoint).toBe(MemoryPath.entrypoint())
        expect(snapshot.index).toContain("用户角色")

        const byName = new Map(snapshot.entries.map((entry) => [entry.name, entry]))
        expect(byName.get("用户角色")).toMatchObject({ type: "user", description: "数据科学家" })
        expect(byName.get("测试约定")).toMatchObject({ type: "feedback" })
        // Relative paths use forward slashes like index links, even though path.relative gives backslashes on Windows.
        expect(byName.get("用户角色")!.filename).toBe("user/user_role.md")
      },
    })
  })

  test("index is an empty string without throwing when MEMORY.md is missing", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const snapshot = await MemoryManage.list()
        expect(snapshot.index).toBe("")
        expect(snapshot.entries).toEqual([])
      },
    })
  })

  test("MEMORY.md is not listed as an entry because it is the index", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await seed([{ rel: "user/a.md", body: frontmatter("A", "a", "user") }], "- [A](user/a.md) - a")
        const snapshot = await MemoryManage.list()
        expect(snapshot.entries.map((entry) => entry.filename)).toEqual(["user/a.md"])
      },
    })
  })
})

describe("MemoryManage.read", () => {
  test("reads the body", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await seed([{ rel: "user/a.md", body: frontmatter("A", "a", "user", "我是正文") }])
        const result = await MemoryManage.read(path.join(root, "user/a.md"))
        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.data.content).toContain("我是正文")
      },
    })
  })

  test("rejects paths outside the memory directory (path traversal guard)", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const outside = path.join(MemoryPath.directory(), "..", "..", "..", "secret.md")
        const result = await MemoryManage.read(outside)
        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.error).toContain("拒绝")
      },
    })
  })

  test("returns ok:false instead of throwing for a missing file", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await MemoryManage.read(path.join(MemoryPath.directory(), "user/none.md"))
        expect(result.ok).toBe(false)
      },
    })
  })
})

describe("MemoryManage.remove", () => {
  test("deletes the file and its index line, so no dangling link is injected into every turn", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await seed(
          [
            { rel: "user/a.md", body: frontmatter("A", "a", "user") },
            { rel: "user/b.md", body: frontmatter("B", "b", "user") },
          ],
          ["- [A](user/a.md) - a", "- [B](user/b.md) - b"].join("\n"),
        )

        const result = await MemoryManage.remove(path.join(root, "user/a.md"))
        expect(result.ok).toBe(true)

        const snapshot = await MemoryManage.list()
        expect(snapshot.entries.map((entry) => entry.filename)).toEqual(["user/b.md"])
        expect(snapshot.index).not.toContain("user/a.md")
        expect(snapshot.index).toContain("user/b.md")
      },
    })
  })

  test("removes the entry from the list and the file from disk", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await seed(
          [{ rel: "user/a.md", body: frontmatter("用户角色", "数据科学家", "user") }],
          "- [用户角色](user/a.md) - 数据科学家",
        )

        const result = await MemoryManage.remove(path.join(root, "user/a.md"))
        expect(result.ok).toBe(true)
        expect((await MemoryManage.list()).entries).toEqual([])
        expect(await Filesystem.isFile(path.join(root, "user/a.md"))).toBe(false)
      },
    })
  })

  test("refuses to delete MEMORY.md (the index itself)", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await seed([], "- [A](user/a.md) - a")
        const result = await MemoryManage.remove(MemoryPath.entrypoint())
        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.error).toContain("索引本体")
        expect(await Filesystem.readText(MemoryPath.entrypoint())).toContain("user/a.md")
      },
    })
  })

  test("rejects paths outside the memory directory", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const outside = path.join(tmp.path, "victim.md")
        await Filesystem.write(outside, "别删我")
        const result = await MemoryManage.remove(outside)
        expect(result.ok).toBe(false)
        expect(await Filesystem.readText(outside)).toBe("别删我")
      },
    })
  })

  test("allows rewriting the same name after deletion (deleting does not block remembering it again)", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await seed(
          [{ rel: "feedback/use-bun.md", body: frontmatter("使用Bun作为包管理器", "本项目用 bun", "feedback") }],
          "- [使用Bun作为包管理器](feedback/use-bun.md) - bun",
        )
        await MemoryManage.remove(path.join(root, "feedback/use-bun.md"))

        const rewrite = frontmatter("使用Bun作为包管理器", "本项目用 bun", "feedback", "再用 bun")
        const write = await WriteTool.init()
        const result = await write.execute(
          { filePath: path.join(root, "feedback/bun.md"), content: rewrite },
          {
            sessionID: "test",
            messageID: "",
            callID: "",
            agent: "build",
            kind: "ask",
            abort: AbortSignal.any([]),
            messages: [],
            ruleset: [],
            metadata: () => {},
            ask: async () => {},
          },
        )
        expect(result.output).toContain("successfully")
        expect((await MemoryManage.list()).entries.some((entry) => entry.name === "使用Bun作为包管理器")).toBe(true)
      },
    })
  })

  test("returns ok:false and leaves the index alone for a missing file", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await seed([], "- [A](user/a.md) - a")
        const result = await MemoryManage.remove(path.join(MemoryPath.directory(), "user/none.md"))
        expect(result.ok).toBe(false)
        expect(await Filesystem.readText(MemoryPath.entrypoint())).toContain("user/a.md")
      },
    })
  })
})
