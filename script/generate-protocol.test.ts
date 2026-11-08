import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { renderTypes, saveGenerated } from "./generate-protocol"

describe("protocol generation", () => {
  it("generates method types and discriminated event payloads", async () => {
    const text = await renderTypes({
      $defs: {
        EventEvent: {
          type: "object",
          properties: { type: { type: "string" }, payload: {} },
          required: ["type", "payload"],
        },
        Reply: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      },
      "x-protocol": 1,
      "x-methods": { hello: { params: { type: "object", properties: {} }, result: { $ref: "#/$defs/Reply" } } },
      "x-events": { "message.completed": { $ref: "#/$defs/Reply" } },
      "x-envelope": { $ref: "#/$defs/EventEvent" },
    })
    expect(text).toContain('type: "message.completed"')
    expect(text).toContain("payload: Reply")
    expect(text).toContain("result: Reply")
    expect(text).toContain('z.literal("message.completed")')
    expect(text).toContain("PROTOCOL_VERSION = 1")
  })

  it("reports stale generated content without changing the file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "merakcode-protocol-"))
    try {
      const file = path.join(dir, "protocol.gen.ts")
      await writeFile(file, "old type\n")
      await expect(saveGenerated(file, "new type\n", true)).rejects.toThrow("out of date")
      expect(await readFile(file, "utf8")).toBe("old type\n")
      await saveGenerated(file, "new type\n", false)
      await expect(saveGenerated(file, "new type\n", true)).resolves.toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
