import { readFile, rm } from "node:fs/promises"
import { describe, expect, test } from "vitest"
import { createToolOutputSink } from "@merakcode/engine/tool/output-sink"

describe("tool output sink", () => {
  test("strips color codes, including escape sequences split across chunks", async () => {
    const sink = await createToolOutputSink()
    sink.append("\x1b[3")
    sink.append("3mwarn\x1b")
    sink.append("[39m done\n")
    sink.append("\x1b]0;title\x07next")
    await sink.close()
    expect(sink.tail()).toBe("warn done\nnext")
    expect(await readFile(sink.path, "utf8")).toBe("warn done\nnext")
    await rm(sink.path, { force: true })
  })

  test("keeps an incomplete escape sequence at the end of the output as is", async () => {
    const sink = await createToolOutputSink()
    sink.append("tail \x1b[")
    await sink.close()
    expect(await readFile(sink.path, "utf8")).toBe("tail \x1b[")
    await rm(sink.path, { force: true })
  })
})
