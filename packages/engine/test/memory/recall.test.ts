import { describe, expect, test } from "vitest"
import fs from "fs/promises"
import path from "path"
import { MemoryRecall } from "@merakcode/engine/memory/recall"
import { MemoryScan } from "@merakcode/engine/memory/scan"
import { SessionCompaction } from "@merakcode/engine/session/compaction"
import { Message } from "@merakcode/engine/session/message"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

const sessionID = "session"

function user(id: string, text: string): Message.FullMsg {
  return {
    info: {
      id,
      sessionID,
      role: "user",
      agent: "build",
      model: { providerID: "test", modelID: "test" },
      time: { created: 0 },
    } as Message.UserInfo,
    parts: [
      {
        id: `${id}_part`,
        messageID: id,
        sessionID,
        type: "text",
        text,
      },
    ],
  }
}

async function writeMemory(root: string, type: string, filename: string, content: string) {
  const filepath = path.join(root, type, filename)
  await fs.mkdir(path.dirname(filepath), { recursive: true })
  await Filesystem.write(filepath, content)
  return filepath
}

describe("MemoryScan", () => {
  test("scans typed memory dirs and excludes MEMORY.md", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "memory")
    await fs.mkdir(root, { recursive: true })
    await Filesystem.write(path.join(root, "MEMORY.md"), "- [Testing](feedback/testing.md)")
    await writeMemory(
      root,
      "feedback",
      "testing.md",
      `---
name: Testing feedback
description: Integration tests should use a real database
type: feedback
---

Use a real database in integration tests.`,
    )

    const files = await MemoryScan.files(root)

    expect(files).toHaveLength(1)
    expect(files[0].filename.replaceAll(path.sep, "/")).toBe("feedback/testing.md")
    expect(files[0].name).toBe("Testing feedback")
    expect(files[0].description).toBe("Integration tests should use a real database")
    expect(files[0].type).toBe("feedback")
  })
})

describe("MemoryRecall", () => {
  test("recalls relevant memory files as a synthetic reminder", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "memory")
    const file = await writeMemory(
      root,
      "feedback",
      "testing.md",
      `---
name: Real database tests
description: Database integration tests must not use mocks
type: feedback
---

Integration tests must use the real database instead of mocks.`,
    )
    await writeMemory(
      root,
      "user",
      "profile.md",
      `---
name: User profile
description: User works on observability
type: user
---

The user cares about logging.`,
    )
    const message = user("msg_user", "Please update the database integration tests")

    const attachment = await MemoryRecall.create({
      messages: [message],
      user: message.info as Message.UserInfo,
      memoryDir: root,
      limit: 1,
    })

    expect(attachment?.paths).toEqual([path.resolve(file)])
    expect(attachment?.text).toContain("<system-reminder>")
    expect(attachment?.text).toContain("Integration tests must use the real database")

    const part = await MemoryRecall.part({
      messages: [message],
      user: message.info as Message.UserInfo,
      memoryDir: root,
      limit: 1,
    })

    expect(part?.synthetic).toBe(true)
    expect(part?.metadata?.memory.kind).toBe(MemoryRecall.METADATA_KIND)
    expect(part?.metadata?.memory.paths).toEqual([path.resolve(file)])
  })

  test("does not recall ignored or already surfaced memories", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "memory")
    const file = await writeMemory(
      root,
      "feedback",
      "testing.md",
      `---
name: Real database tests
description: Database integration tests must not use mocks
type: feedback
---

Integration tests must use the real database instead of mocks.`,
    )
    const previous = user("msg_previous", "earlier")
    previous.parts.push({
      id: "part_memory",
      messageID: "msg_previous",
      sessionID,
      type: "text",
      text: "<system-reminder>Relevant memories</system-reminder>",
      synthetic: true,
      metadata: MemoryRecall.metadata({
        paths: [path.resolve(file)],
        bytes: 10,
        query: "database tests",
      }),
    })

    const current = user("msg_current", "Please update the database integration tests")
    const duplicate = await MemoryRecall.create({
      messages: [previous, current],
      user: current.info as Message.UserInfo,
      memoryDir: root,
    })
    const ignored = await MemoryRecall.create({
      messages: [user("msg_ignore", "ignore memory and update the database integration tests")],
      memoryDir: root,
    })

    expect(duplicate).toBeUndefined()
    expect(ignored).toBeUndefined()
  })

  test("keeps a prefix when truncating a large single-line memory", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "memory")
    await writeMemory(root, "reference", "large.md", "large ".repeat(2_000))
    const message = user("msg_large", "large")

    const attachment = await MemoryRecall.create({
      messages: [message],
      user: message.info as Message.UserInfo,
      memoryDir: root,
      limit: 1,
    })

    expect(attachment?.text).toContain("large large")
    expect(attachment?.text).toContain("This memory file was truncated (4096 byte limit)")
  })

  test("does not recall reference memories for internal plans and docs", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "memory")
    await writeMemory(
      root,
      "reference",
      "architecture-plan.md",
      `---
name: Architecture plan
description: Architecture migration plan and docs for the current repo
type: reference
---

This should not be surfaced for repo-internal architecture planning queries.`,
    )
    const message = user("msg_plan", "Please review the architecture migration plan docs")

    const attachment = await MemoryRecall.create({
      messages: [message],
      user: message.info as Message.UserInfo,
      memoryDir: root,
    })

    expect(attachment).toBeUndefined()
  })

  test("does not fallback to reference memories for explicit internal doc recall", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "memory")
    await writeMemory(
      root,
      "reference",
      "repo-plan.md",
      `---
name: Repo plan
description: Repo implementation plan docs
type: reference
---

This is internal planning noise.`,
    )
    const message = user("msg_memory_plan", "Recall memory about the repo implementation plan docs")

    const attachment = await MemoryRecall.create({
      messages: [message],
      user: message.info as Message.UserInfo,
      memoryDir: root,
    })

    expect(attachment).toBeUndefined()
  })

  test("recalls reference memories when the query names an external locator", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "memory")
    const file = await writeMemory(
      root,
      "reference",
      "api-latency.md",
      `---
name: API latency dashboard
description: grafana.internal/d/api-latency is the oncall latency dashboard
type: reference
---

Check grafana.internal/d/api-latency before changing request handling.`,
    )
    const message = user("msg_grafana", "Check the Grafana api latency dashboard")

    const attachment = await MemoryRecall.create({
      messages: [message],
      user: message.info as Message.UserInfo,
      memoryDir: root,
      limit: 1,
    })

    expect(attachment?.paths).toEqual([path.resolve(file)])
    expect(attachment?.text).toContain("grafana.internal/d/api-latency")
  })

  test("keeps external url reference memories even when the query mentions docs", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "memory")
    const file = await writeMemory(
      root,
      "reference",
      "partner-docs.md",
      `---
name: Partner API docs
description: https://partner.example.com/docs is the canonical partner API documentation
type: reference
---

Use https://partner.example.com/docs for live partner API behavior.`,
    )
    const message = user("msg_url", "Check the docs at https://partner.example.com/docs")

    const attachment = await MemoryRecall.create({
      messages: [message],
      user: message.info as Message.UserInfo,
      memoryDir: root,
      limit: 1,
    })

    expect(attachment?.paths).toEqual([path.resolve(file)])
    expect(attachment?.text).toContain("https://partner.example.com/docs")
  })

  test("respects the session memory byte budget", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "memory")
    await writeMemory(root, "reference", "large.md", "large ".repeat(200))
    const previous = user("msg_previous", "earlier")
    previous.parts.push({
      id: "part_memory",
      messageID: "msg_previous",
      sessionID,
      type: "text",
      text: "<system-reminder>Relevant memories</system-reminder>",
      synthetic: true,
      metadata: MemoryRecall.metadata({
        paths: [path.resolve(root, "reference", "previous.md")],
        bytes: MemoryRecall.MAX_SESSION_BYTES - 100,
        query: "earlier",
      }),
    })
    const current = user("msg_current", "large")

    const attachment = await MemoryRecall.create({
      messages: [previous, current],
      user: current.info as Message.UserInfo,
      memoryDir: root,
      limit: 1,
    })

    expect(attachment).toBeUndefined()
  })

  test("removes recalled memories from compaction input", () => {
    const message = user("msg_current", "Please update tests")
    message.parts.push({
      id: "part_memory",
      messageID: "msg_current",
      sessionID,
      type: "text",
      text: "<system-reminder>Relevant memories</system-reminder>",
      synthetic: true,
      metadata: MemoryRecall.metadata({
        paths: [path.resolve("feedback/testing.md")],
        bytes: 10,
        query: "tests",
      }),
    })

    const stripped = SessionCompaction.stripMemoryContext([message])

    expect(message.parts).toHaveLength(2)
    expect(stripped[0].parts).toHaveLength(1)
    expect(stripped[0].parts[0].type).toBe("text")
    expect((stripped[0].parts[0] as Message.TextPart).text).toBe("Please update tests")
  })
})
