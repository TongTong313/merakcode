import { expect, test } from "vitest"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Session } from "@merakcode/engine/agent/session/index"
import { SessionPlan } from "@merakcode/engine/agent/session/plan"
import { tmpdir } from "../fixture/fixture"
import { Message } from "@merakcode/engine/agent/session/message"
import { Identifier } from "@merakcode/util/id"
import { ReadTool } from "../../src/agent/tools/read"
import { SessionCompactionRestore } from "../../src/agent/session/compaction-restore"
import type { Provider } from "../../src/agent/model/provider"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../../src/infra/global"
import { Storage } from "../../src/infra/storage/storage"
import { GrepTool } from "../../src/agent/tools/grep"
import { Bus } from "../../src/infra/bus"

test("a rejected plan observer does not reject or lose a committed human save", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const unsubscribe = Bus.subscribe(SessionPlan.Updated, async () => {
        throw new Error("OBSERVER_FAILURE")
      })
      try {
        const saved = await SessionPlan.save({
          sessionID: session.id,
          source: "human",
          content: "HUMAN_SAVE",
          expectedRevision: 0,
        })
        await new Promise((resolve) => setImmediate(resolve))
        expect(saved.content).toBe("HUMAN_SAVE")
        expect(await fs.readFile(saved.path, "utf8")).toBe("HUMAN_SAVE")
      } finally {
        unsubscribe()
      }
    },
  })
})

test.each(["save", "start", "review", "external"])(
  "plan %s notifications let subscribers refresh the plan",
  async (kind) => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const a = await SessionPlan.save({ sessionID: session.id, source: "human", content: "A", expectedRevision: 0 })
        let seen: string | undefined
        const release = Promise.withResolvers<void>()
        const unsubscribe = Bus.subscribe(SessionPlan.Updated, async (event) => {
          if (event.properties.sessionID !== session.id) return
          const plan = await Promise.race([SessionPlan.get(session.id), release.promise.then(() => undefined)])
          seen = plan?.content
        })
        if (kind === "external") await fs.writeFile(a.path, "B")
        const operation =
          kind === "save"
            ? SessionPlan.save({ sessionID: session.id, source: "human", content: "B", expectedRevision: a.revision })
            : kind === "start"
              ? SessionPlan.start(session.id)
              : kind === "review"
                ? SessionPlan.setStatus(session.id, "review")
                : SessionPlan.get(session.id)
        try {
          await expect.poll(() => seen, { timeout: 5000 }).toBe(kind === "save" || kind === "external" ? "B" : "A")
          await operation
        } finally {
          release.resolve()
          await operation
          unsubscribe()
        }
      },
    })
  },
)

test.each(["file", "directory", "directory-link", "hardlink", "child"])(
  "grep searches the approved plan through %s",
  async (kind) => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({})
        const session = kind === "child" ? await Session.create({ parentID: root.id }) : root
        const marker = `STEP_${root.id}`
        const a = await SessionPlan.save({
          sessionID: root.id,
          source: "human",
          content: `${marker} APPROVED_A`,
          expectedRevision: 0,
        })
        await SessionPlan.start(root.id)
        await SessionPlan.save({
          sessionID: root.id,
          source: "human",
          content: `${marker} UNAPPROVED_B`,
          expectedRevision: a.revision,
        })
        let target = kind === "directory" || kind === "child" ? path.dirname(a.path) : a.path
        if (kind === "directory-link") {
          target = path.join(tmp.path, "linked-plans")
          await fs.symlink(path.dirname(a.path), target, process.platform === "win32" ? "junction" : "dir")
        }
        if (kind === "hardlink") {
          target = tmp.path
          await fs.link(a.path, path.join(tmp.path, "plan-alias.md"))
        }
        const grep = await GrepTool.init()
        const ctx = {
          sessionID: session.id,
          planExecution: true,
          messageID: "",
          agent: "build",
          permissionLevel: "fullTakeover" as const,
          abort: new AbortController().signal,
          messages: [],
          ruleset: [],
          metadata() {},
          async ask() {},
        }
        const result = await grep.execute({ path: target, pattern: marker }, ctx)
        expect(result.output).toContain("APPROVED_A")
        expect(result.output).not.toContain("UNAPPROVED_B")
        expect(
          (await grep.execute({ path: target, pattern: `${marker}.*APPROVED_A` }, ctx)).metadata.matches,
        ).toBeGreaterThan(0)
        expect((await grep.execute({ path: target, pattern: `${marker}.*UNAPPROVED_B` }, ctx)).metadata.matches).toBe(0)
        expect((await SessionPlan.get(root.id)).content).toBe(`${marker} UNAPPROVED_B`)
      },
    })
  },
)

test("consecutive external saves advance revisions and reject an older human buffer", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const a = await SessionPlan.save({ sessionID: session.id, content: "A", source: "human", expectedRevision: 0 })
      await SessionPlan.start(session.id)
      await fs.writeFile(a.path, "HUMAN_B")
      const b = await SessionPlan.get(session.id)
      await fs.writeFile(a.path, "HUMAN_C")
      const c = await SessionPlan.get(session.id)
      expect(c.revision).toBeGreaterThan(b.revision)
      expect((await SessionPlan.get(session.id)).revision).toBe(c.revision)
      await expect(
        SessionPlan.save({
          sessionID: session.id,
          content: "BUFFER_FROM_B",
          source: "human",
          expectedRevision: b.revision,
        }),
      ).rejects.toThrow(/conflict/i)
      expect(await fs.readFile(a.path, "utf8")).toBe("HUMAN_C")
      expect((await SessionPlan.get(session.id)).execution?.content).toBe("A")
    },
  })
})

test("legacy plans migrate independently while retaining human protection and the fixed execution", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const legacy = path.join(Global.Path.data, "plans", `${session.time.created}-${session.slug}.md`)
      await fs.mkdir(path.dirname(legacy), { recursive: true })
      await fs.writeFile(legacy, "HUMAN_B")
      await Storage.write(["session_plan", session.id], {
        sessionID: session.id,
        path: legacy,
        content: "HUMAN_B",
        revision: 4,
        humanRevision: 4,
        source: "human",
        status: "executing",
        activeUserID: "original",
        blockedUserID: "original",
        execution: { id: "execution", content: "APPROVED_A", startedAt: 1 },
      })
      const migrated = await SessionPlan.get(session.id)
      expect(migrated.path).not.toBe(legacy)
      expect(migrated.content).toBe("HUMAN_B")
      expect(migrated.execution?.content).toBe("APPROVED_A")
      const ctx = {
        sessionID: session.id,
        planExecution: true,
        messageID: "",
        agent: "build",
        permissionLevel: "fullTakeover" as const,
        abort: new AbortController().signal,
        messages: [],
        ruleset: [],
        metadata() {},
        async ask() {},
      }
      const legacyRead = await (await ReadTool.init()).execute({ filePath: legacy }, ctx)
      expect(legacyRead.output).toContain("APPROVED_A")
      expect(legacyRead.output).not.toContain("HUMAN_B")
      await expect(
        SessionPlan.save({ sessionID: session.id, source: "agent", content: "late AI", expectedRevision: 4 }),
      ).rejects.toThrow(/conflict/i)
      expect(await fs.readFile(legacy, "utf8")).toBe("HUMAN_B")
      expect(await fs.readFile(migrated.path, "utf8")).toBe("HUMAN_B")
    },
  })
})

test("execution reads and compaction restore never expose later editable plan content", async () => {
  await using tmp = await tmpdir({ git: true, config: { lsp: false, memory: { session_memory: false } } })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const a = await SessionPlan.save({
        sessionID: session.id,
        source: "human",
        expectedRevision: 0,
        content: "APPROVED_A",
      })
      await SessionPlan.start(session.id)
      const read = await ReadTool.init()
      const ctx = {
        sessionID: session.id,
        planExecution: true,
        messageID: "",
        agent: "build",
        permissionLevel: "fullTakeover" as const,
        abort: new AbortController().signal,
        messages: [],
        ruleset: [],
        metadata() {},
        async ask() {},
      }
      await read.execute({ filePath: a.path }, ctx)
      await SessionPlan.save({
        sessionID: session.id,
        source: "human",
        expectedRevision: a.revision,
        content: "UNAPPROVED_B",
      })
      const parts = await SessionCompactionRestore.attachments({
        sessionID: session.id,
        messageID: "restore",
        planExecution: true,
        messages: [],
        model: { id: "gpt-4", providerID: "openai", api: { id: "gpt-4" } } as Provider.Model,
        agent: "build",
      })
      expect(parts.map((p) => p.text).join("\n")).toContain("APPROVED_A")
      expect(parts.map((p) => p.text).join("\n")).not.toContain("UNAPPROVED_B")
      expect((await read.execute({ filePath: a.path }, ctx)).output).not.toContain("UNAPPROVED_B")
      expect((await SessionPlan.get(session.id)).content).toBe("UNAPPROVED_B")
      const discussion = await SessionCompactionRestore.attachments({
        sessionID: session.id,
        messageID: "restore-discussion",
        messages: [],
        planExecution: false,
        model: { id: "gpt-4", providerID: "openai", api: { id: "gpt-4" } } as Provider.Model,
        agent: "build",
      })
      expect(discussion.map((part) => part.text).join("\n")).toContain("UNAPPROVED_B")
      expect(discussion.map((part) => part.text).join("\n")).not.toContain("APPROVED_A")
      await SessionPlan.setStatus(session.id, "completed")
      expect((await read.execute({ filePath: a.path }, ctx)).output).toContain("UNAPPROVED_B")
    },
  })
})

test("a human save wins over an agent result generated from the previous plan", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const base = await SessionPlan.save({ sessionID: session.id, content: "A", source: "agent", expectedRevision: 0 })
      await SessionPlan.save({
        sessionID: session.id,
        content: "Human",
        source: "human",
        expectedRevision: base.revision,
      })
      await expect(
        SessionPlan.save({
          sessionID: session.id,
          content: "Late AI",
          source: "agent",
          expectedRevision: base.revision,
        }),
      ).rejects.toThrow(/conflict/i)
      expect((await SessionPlan.get(session.id)).content).toBe("Human")
    },
  })
})

test("an automatic agent retry cannot overwrite human edits even after rereading the revision", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const userMessageID = Identifier.ascending("message")
      await Session.updateInfo({
        id: userMessageID,
        sessionID: session.id,
        role: "user",
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-4" },
        time: { created: Date.now() },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: userMessageID,
        sessionID: session.id,
        type: "text",
        text: "Write a plan",
      } satisfies Message.TextPart)
      const human = await SessionPlan.save({
        sessionID: session.id,
        content: "Human choice",
        source: "human",
        expectedRevision: 0,
      })
      await expect(
        SessionPlan.save({
          sessionID: session.id,
          content: "Automatic retry",
          source: "agent",
          expectedRevision: human.revision,
          userMessageID,
        }),
      ).rejects.toThrow(/conflict/i)
      expect((await SessionPlan.get(session.id)).content).toBe("Human choice")
    },
  })
})

test("starting uses the latest plan once and later saves do not change its execution", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await SessionPlan.save({
        sessionID: session.id,
        content: "Latest human plan",
        source: "human",
        expectedRevision: 0,
      })
      const started = await SessionPlan.start(session.id)
      await SessionPlan.save({
        sessionID: session.id,
        content: "Edited during execution",
        source: "human",
        expectedRevision: started.revision,
      })
      const repeated = await SessionPlan.start(session.id)
      expect(repeated.execution).toEqual(started.execution)
      expect(repeated.execution?.content).toBe("Latest human plan")
      expect(repeated.content).toBe("Edited during execution")
    },
  })
})

test("compaction identifiers cannot bypass a human save before a new task", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await SessionPlan.beginTurn(session.id, "msg_real-user")
      const human = await SessionPlan.save({
        sessionID: session.id,
        source: "human",
        content: "Human choice",
        expectedRevision: 0,
      })
      await expect(
        SessionPlan.save({
          sessionID: session.id,
          source: "agent",
          content: "Compacted retry",
          expectedRevision: human.revision,
          userMessageID: "compaction-continuation",
        }),
      ).rejects.toThrow()
      await SessionPlan.beginTurn(session.id, "msg_next-real-user")
      await SessionPlan.save({
        sessionID: session.id,
        source: "agent",
        content: "Requested revision",
        expectedRevision: human.revision,
        userMessageID: "msg_next-real-user",
      })
      expect((await SessionPlan.get(session.id)).content).toBe("Requested revision")
    },
  })
})

test("concurrent human saves retain the first saved edit and report a conflict", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const first = await SessionPlan.save({
        sessionID: session.id,
        source: "human",
        content: "First",
        expectedRevision: 0,
      })
      await expect(
        SessionPlan.save({ sessionID: session.id, source: "human", content: "Stale", expectedRevision: 0 }),
      ).rejects.toThrow()
      expect((await SessionPlan.get(session.id)).revision).toBe(first.revision)
      expect((await SessionPlan.get(session.id)).content).toBe("First")
    },
  })
})

test("an interrupted agent plan save cannot commit after cancellation", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const saved = await SessionPlan.save({
        sessionID: session.id,
        source: "agent",
        content: "Original",
        expectedRevision: 0,
      })
      const stop = new AbortController()
      stop.abort(new Error("mode changed"))
      await expect(
        SessionPlan.save({
          sessionID: session.id,
          source: "agent",
          content: "Cancelled update",
          expectedRevision: saved.revision,
          abort: stop.signal,
        }),
      ).rejects.toThrow("mode changed")
      expect((await SessionPlan.get(session.id)).content).toBe("Original")
    },
  })
})
