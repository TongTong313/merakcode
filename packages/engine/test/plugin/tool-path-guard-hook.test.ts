import { afterEach, describe, expect, test, type Mock, vi } from "vitest"
import { Plugin } from "@merakcode/engine/plugin/index"
import { Instance } from "@merakcode/engine/project/instance"
import { ReadTool } from "@merakcode/engine/tool/read"
import { ListTool } from "@merakcode/engine/tool/ls"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

/**
 * Tool-level path guard hook.
 *
 * `tool.execute.before` is not enough: it sees the raw arguments (relative paths, glob patterns, or no path at all,
 * since grep's `path` is optional), while disclosure protection must judge the absolute paths each tool resolves. The
 * hook fires after a tool has resolved its target paths and before it reads or writes.
 *
 * - The hook receives `paths` and writes back `denied: string[]`; it can only deny, never allow.
 * - Single-path tools (read/write/edit) throw `REFUSAL_MESSAGE` on a match; multi-path tools (ls/glob/grep) drop the
 *   matching entries and keep going.
 *
 * These tests run real tool `execute()` calls to prove the seam is wired; the deny rules belong to plugin tests.
 */

let spy: Mock<typeof Plugin.trigger> | undefined

afterEach(() => {
  spy?.mockRestore()
  spy = undefined
})

/** Make the path guard hook deny paths containing "secret" and pass every other hook through */
function denySecretPaths(seen: { tool?: string; paths?: string[] }) {
  spy = vi.spyOn(Plugin, "trigger").mockImplementation((async (name: string, input: unknown, output: unknown) => {
    if (name === "experimental.tool.path.guard") {
      const typed = input as { tool: string; paths: string[] }
      seen.tool = typed.tool
      seen.paths = typed.paths
      ;(output as { denied: string[] }).denied = typed.paths.filter((path) => path.includes("secret"))
    }
    return output
  }) as typeof Plugin.trigger)
}

function ctx(text: string) {
  return {
    sessionID: "ses_h15",
    messageID: "msg_h15",
    callID: "call_h15",
    agent: "build",
    abort: new AbortController().signal,
    metadata: () => {},
    // Real tools also call these; approve both since only the path guard is under test
    askExternalDirectory: async () => {},
    ask: async () => {},
    messages: [{ info: { role: "user" as const }, parts: [{ type: "text" as const, text }] }],
  } as unknown as Parameters<Awaited<ReturnType<typeof ReadTool.init>>["execute"]>[1]
}

describe("experimental.tool.path.guard", () => {
  test("a single-path tool (read) throws a refusal when the plugin denies the resolved absolute path", async () => {
    Log.init({ print: false })
    await using tmp = await tmpdir({ git: true })
    await Filesystem.write(`${tmp.path}/secret-notes.txt`, "内容")
    const seen: { tool?: string; paths?: string[] } = {}
    denySecretPaths(seen)

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const result = await read
          .execute({ filePath: `${tmp.path}/secret-notes.txt` }, ctx("看看这个文件"))
          .then(() => "allowed" as const)
          .catch((error: Error) => error.message)

        // The hook got the resolved absolute path, not the raw argument
        expect(seen.tool).toBe("read")
        expect(seen.paths?.[0]).toContain("secret-notes.txt")
        expect(seen.paths?.[0]?.startsWith("/") || /^[A-Za-z]:/.test(seen.paths?.[0] ?? "")).toBe(true)
        expect(result).not.toBe("allowed")
      },
    })
  })

  test("a multi-path tool (ls) drops denied entries and returns the rest", async () => {
    Log.init({ print: false })
    await using tmp = await tmpdir({ git: true })
    await Filesystem.write(`${tmp.path}/normal.txt`, "x")
    await Filesystem.write(`${tmp.path}/secret.txt`, "y")
    denySecretPaths({})

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ls = await ListTool.init()
        const result = await ls.execute({ path: tmp.path }, ctx("列一下目录"))

        expect(result.output).toContain("normal.txt")
        expect(result.output).not.toContain("secret.txt")
      },
    })
  })

  test("without the hook, paths are allowed as usual", async () => {
    Log.init({ print: false })
    await using tmp = await tmpdir({ git: true })
    await Filesystem.write(`${tmp.path}/secret-notes.txt`, "内容")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const result = await read.execute({ filePath: `${tmp.path}/secret-notes.txt` }, ctx("看看这个文件"))
        expect(result.output).toContain("内容")
      },
    })
  })
})
