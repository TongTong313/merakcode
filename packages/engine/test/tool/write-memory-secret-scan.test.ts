import { describe, expect, test } from "vitest"
import { WriteTool } from "@merakcode/engine/tool/write"
import { Instance } from "@merakcode/engine/project/instance"
import { MemoryPath } from "@merakcode/engine/memory/path"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "build",
  kind: "ask" as const,
  abort: AbortSignal.any([]),
  messages: [],
  ruleset: [],
  metadata: () => {},
  ask: async () => {},
  askExternalDirectory: async () => {},
}

describe("tool.write memory secret scan", () => {
  test("refuses to write likely credentials into the memory directory", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const write = await WriteTool.init()
        const memoryFile = MemoryPath.topic("user", "leaked-key-note")
        await expect(
          write.execute({ filePath: memoryFile, content: "aws key: AKIAABCDEFGHIJKLMNOP" }, ctx),
        ).rejects.toThrow()
      },
    })
  })

  test("writes ordinary content into the memory directory", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const write = await WriteTool.init()
        const memoryFile = MemoryPath.topic("user", "normal-note")
        const result = await write.execute({ filePath: memoryFile, content: "用户偏好使用中文交流" }, ctx)
        expect(result.output).toContain("successfully")
      },
    })
  })

  test("paths outside the memory directory are not scanned, even with the same content", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const write = await WriteTool.init()
        const target = `${tmp.path}/notes.txt`
        const result = await write.execute({ filePath: target, content: "aws key: AKIAABCDEFGHIJKLMNOP" }, ctx)
        expect(result.output).toContain("successfully")
      },
    })
  })
})
