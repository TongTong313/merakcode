import { describe, expect, test } from "vitest"
import os from "os"
import path from "path"
import fs from "fs/promises"
import { Identifier } from "@merakcode/util/id"
import { Instance } from "../project/instance"
import { Message } from "../session/message"
import { MemoryManage } from "./manage"
import { MemoryPath } from "./path"
import { MemoryExtract } from "./extract"
import { Filesystem } from "@merakcode/util/filesystem"

// A completed write tool part for building hasMemoryWritesSince messages
function completedWrite(filePath: string): Message.ToolPart {
  return {
    id: "part",
    messageID: "assistant",
    sessionID: "session",
    type: "tool",
    callID: "call",
    tool: "write",
    state: {
      status: "completed",
      input: { filePath },
      title: "write",
      output: "ok",
      metadata: {},
      time: { start: 0, end: 1 },
    },
  }
}

// No module mocking: a fake Instance could leak into later test files, and extract.ts may already have been
// evaluated against the real Instance, so a module mock would not take effect. Like tool/registry.test.ts, use the
// real Instance.provide with a temp directory. prompt()/drain() only read (a missing memory directory reads as
// empty), so temp directories keep the tests isolated.

// Instance.provide() sets up the AsyncLocalStorage context; a temp directory per test avoids per-directory cache leaks
async function withInstance<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "merakcode-extract-test-"))
  return Instance.provide({ directory: dir, fn })
}

describe("MemoryExtract.prompt", () => {
  test("describes the extraction agent and its job", async () => {
    await withInstance(async () => {
      const prompt = await MemoryExtract.prompt()
      expect(prompt).toContain("# Automatic memory extraction")
      expect(prompt).toContain("You are MerakCode's post-turn memory extraction pass")
    })
  })

  test("includes today's date so relative dates can be made absolute", async () => {
    await withInstance(async () => {
      const prompt = await MemoryExtract.prompt()
      expect(prompt).toMatch(/Today is \d{4}-\d{2}-\d{2}/)
    })
  })

  test("names the memory directory and index", async () => {
    await withInstance(async () => {
      const prompt = await MemoryExtract.prompt()
      // The directory derives from the Instance temp directory, so it cannot be hardcoded
      expect(prompt).toContain(`Memory directory: \`${MemoryPath.directory()}\``)
      expect(prompt).toContain(`Memory index: \`${MemoryPath.entrypoint()}\``)
    })
  })

  test("specifies the exact no-update reply to save turns", async () => {
    await withInstance(async () => {
      const prompt = await MemoryExtract.prompt()
      expect(prompt).toContain("No memory updates.")
    })
  })

  test("sets a turn budget and forbids daily logs and dream artifacts", async () => {
    await withInstance(async () => {
      const prompt = await MemoryExtract.prompt()
      expect(prompt).toContain("## Turn budget")
      expect(prompt).toContain("Do not create daily logs, dreams, rollups, summaries, or auto-dream artifacts.")
    })
  })

  test("with newMessageCount, uses only the last N messages and dedupes against existing files", async () => {
    await withInstance(async () => {
      const prompt = await MemoryExtract.prompt({ newMessageCount: 4 })
      expect(prompt).toContain("most recent ~4 messages")
      expect(prompt).toContain("last ~4 messages")
      expect(prompt).toContain("avoid duplicates")
      expect(prompt).not.toContain("since the last extraction")
    })
  })

  test("with newMessageCount, does not ask the model to review the whole conversation", async () => {
    await withInstance(async () => {
      const prompt = await MemoryExtract.prompt({ newMessageCount: 4 })
      expect(prompt).not.toContain("Review the conversation above")
    })
  })

  test("after deletion, the prompt neither lists the deleted entry nor forbids recreating it", async () => {
    await withInstance(async () => {
      const rel = "feedback/use-bun.md"
      const root = MemoryPath.directory()
      await fs.mkdir(path.join(root, "feedback"), { recursive: true })
      await Filesystem.write(
        path.join(root, rel),
        ["---", "name: 使用Bun作为包管理器", "description: 本项目用 bun", "type: feedback", "---", "", "用 bun"].join(
          "\n",
        ),
      )
      await MemoryManage.remove(path.join(root, rel))

      const prompt = await MemoryExtract.prompt()
      expect(prompt).not.toContain("User-deleted")
      expect(prompt).not.toContain("使用Bun作为包管理器")
    })
  })
})

describe("MemoryExtract.visibleCountSince", () => {
  test("counts all user and assistant messages without a cursor", () => {
    expect(
      MemoryExtract.visibleCountSince([
        { id: "a", role: "user" },
        { id: "b", role: "assistant" },
        { id: "c", role: "user" },
        { id: "d", role: "assistant" },
      ]),
    ).toBe(4)
  })

  test("counts only user and assistant messages after the cursor", () => {
    expect(
      MemoryExtract.visibleCountSince(
        [
          { id: "a", role: "user" },
          { id: "b", role: "assistant" },
          { id: "c", role: "user" },
          { id: "d", role: "assistant" },
        ],
        "b",
      ),
    ).toBe(2)
  })

  test("falls back to all visible messages when the cursor is not in the list", () => {
    expect(
      MemoryExtract.visibleCountSince(
        [
          { id: "a", role: "user" },
          { id: "b", role: "assistant" },
          { id: "c", role: "user" },
          { id: "d", role: "assistant" },
        ],
        "missing",
      ),
    ).toBe(4)
  })
})

describe("MemoryExtract.hasMemoryWritesSince", () => {
  test("is true without a cursor when the window has a completed memory write", async () => {
    await withInstance(async () => {
      const file = path.join(MemoryPath.typeDir("feedback"), "testing.md")
      expect(
        MemoryExtract.hasMemoryWritesSince([
          {
            id: "a",
            parts: [completedWrite(file)],
          },
        ]),
      ).toBe(true)
    })
  })

  test("ignores writes before the cursor", async () => {
    await withInstance(async () => {
      const file = path.join(MemoryPath.typeDir("feedback"), "testing.md")
      expect(
        MemoryExtract.hasMemoryWritesSince(
          [
            {
              id: "a",
              parts: [completedWrite(file)],
            },
            {
              id: "b",
              parts: [],
            },
          ],
          "a",
        ),
      ).toBe(false)
    })
  })

  test("is true when a write follows the cursor", async () => {
    await withInstance(async () => {
      const file = path.join(MemoryPath.typeDir("feedback"), "testing.md")
      expect(
        MemoryExtract.hasMemoryWritesSince(
          [
            {
              id: "a",
              parts: [],
            },
            {
              id: "b",
              parts: [completedWrite(file)],
            },
          ],
          "a",
        ),
      ).toBe(true)
    })
  })

  test("is false when the cursor is not in the list", async () => {
    await withInstance(async () => {
      const file = path.join(MemoryPath.typeDir("feedback"), "testing.md")
      expect(
        MemoryExtract.hasMemoryWritesSince(
          [
            {
              id: "a",
              parts: [completedWrite(file)],
            },
          ],
          "missing",
        ),
      ).toBe(false)
    })
  })
})

describe("MemoryExtract cursor persist", () => {
  test("reads back a written cursor", async () => {
    await withInstance(async () => {
      const sessionID = Identifier.ascending("session")
      await MemoryExtract.writeCursor(sessionID, "asst_1")
      expect(await MemoryExtract.readCursor(sessionID)).toBe("asst_1")
      await MemoryExtract.removeCursor(sessionID)
    })
  })

  test("reads undefined when no cursor was written", async () => {
    await withInstance(async () => {
      expect(await MemoryExtract.readCursor(Identifier.ascending("session"))).toBeUndefined()
    })
  })

  test("reads undefined after the cursor is removed", async () => {
    await withInstance(async () => {
      const sessionID = Identifier.ascending("session")
      await MemoryExtract.writeCursor(sessionID, "asst_1")
      await MemoryExtract.removeCursor(sessionID)
      expect(await MemoryExtract.readCursor(sessionID)).toBeUndefined()
    })
  })
})

describe("MemoryExtract.drain", () => {
  test("returns immediately without throwing when no extraction is in flight", async () => {
    await withInstance(async () => {
      await expect(MemoryExtract.drain(10)).resolves.toBeUndefined()
    })
  })
})
