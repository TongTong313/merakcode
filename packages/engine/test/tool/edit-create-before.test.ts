import { describe, expect, test } from "vitest"
import { EditTool } from "@merakcode/engine/tool/edit"
import { Instance } from "@merakcode/engine/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

// An empty oldString creates or overwrites the whole file. If the file exists, filediff.before must hold the old
// content; otherwise the review baseline is empty and rejecting the change wipes the file.
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

describe("tool.edit with an empty oldString on an existing file", () => {
  test("filediff.before holds the original content so rejecting restores it", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const filePath = `${tmp.path}/a.txt`
        await Filesystem.write(filePath, "1222222222222")
        const edit = await EditTool.init()
        const result = await edit.execute({ filePath, oldString: "", newString: "1222222222222\n1111111111" }, ctx)
        const filediff = (result.metadata as { filediff: { before: string; after: string } }).filediff
        expect(filediff.before).toBe("1222222222222")
        expect(filediff.after).toBe("1222222222222\n1111111111")
      },
    })
  })

  test("filediff.before is empty for a new file", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const filePath = `${tmp.path}/new.txt`
        const edit = await EditTool.init()
        const result = await edit.execute({ filePath, oldString: "", newString: "HELLO" }, ctx)
        const filediff = (result.metadata as { filediff: { before: string } }).filediff
        expect(filediff.before).toBe("")
      },
    })
  })
})
