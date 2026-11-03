import { expect, test } from "vitest"
import { PermissionLevel } from "@merakcode/engine/agent/permission/level"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Session } from "@merakcode/engine/agent/session/index"
import { SessionStore } from "@merakcode/engine/agent/session/store"
import { tmpdir, selectPermissionLevel } from "../fixture/fixture"
import { PermissionNext } from "@merakcode/engine/agent/permission/next"
import { PermissionPolicy } from "@merakcode/engine/agent/permission/policy"
import { Question } from "@merakcode/engine/agent/session/question/index"
import { Server } from "@merakcode/engine/app/server/server"
import { ModeOperations } from "@merakcode/engine/agent/permission/operations"

test("repeating the selected level preserves an unfinished transition block", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await selectPermissionLevel({ sessionID: session.id, permissionLevel: "fullTakeover" })
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const controller = new AbortController()
      const finish = ModeOperations.register(session.id, "waiting", "write", controller, async () => {
        entered.resolve()
        await release.promise
        return PermissionPolicy.ruleset("ask")
      })
      controller.signal.addEventListener("abort", finish, { once: true })
      const switching = selectPermissionLevel({ sessionID: session.id, permissionLevel: "ask" })
      let cleanup = () => {}
      try {
        await entered.promise
        await selectPermissionLevel({ sessionID: session.id, permissionLevel: "ask" })
        expect(() => {
          cleanup = ModeOperations.register(session.id, "new-work", "write", new AbortController())
        }).toThrow(ModeOperations.PendingError)
      } finally {
        cleanup()
        release.resolve()
        finish()
        await switching
      }
    },
  })
})

test("explicit child mode selection changes the effective root policy and child prompts preserve it", async () => {
  const { Loop } = await import("../../src/agent/loop")
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const root = await Session.create({})
      const child = await Session.create({ parentID: root.id })
      await selectPermissionLevel({ sessionID: root.id, permissionLevel: "fullTakeover" })
      const response = await Server.App().request(
        `/session/${child.id}/permission-level?directory=${encodeURIComponent(tmp.path)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ permissionLevel: "ask", expectedRevision: 1 }),
        },
      )
      expect(response.status).toBe(200)
      expect((await Session.get(root.id)).permissionLevel).toBe("ask")
      expect((await Session.get(child.id)).permissionLevel).toBe("ask")
      await Loop.prompt({
        sessionID: child.id,
        permissionLevel: "fullTakeover",
        noReply: true,
        model: { providerID: "openai", modelID: "gpt-4" },
        parts: [{ type: "text", text: "Inherited task" }],
      })
      expect((await Session.get(root.id)).permissionLevel).toBe("ask")
      expect((await Session.get(child.id)).permissionLevel).toBe("ask")
    },
  })
})

test("an asynchronous permission reevaluation cannot approve after a newer execute switch", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await selectPermissionLevel({ sessionID: session.id, permissionLevel: "fullTakeover" })
      // An in-flight caller may register checks from its earlier execute policy.
      let allowed = false
      const waiting = PermissionNext.ask({
        sessionID: session.id,
        executionID: "external-race",
        permission: "external_write",
        metadata: {},
        checks: [{ permission: "external_write", pattern: "/outside/file", grants: [] }],
        ruleset: PermissionPolicy.ruleset("autoApprove"),
      }).then(
        () => {
          allowed = true
        },
        () => {},
      )
      await expect.poll(async () => (await PermissionNext.list()).length).toBe(1)
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const older = PermissionNext.recheck(async () => {
        entered.resolve()
        await release.promise
        return PermissionPolicy.ruleset("fullTakeover")
      })
      try {
        await entered.promise
        await selectPermissionLevel({ sessionID: session.id, permissionLevel: "autoApprove" })
        release.resolve()
        await older
        expect(allowed).toBe(false)
        expect(await PermissionNext.list()).toHaveLength(1)
      } finally {
        release.resolve()
        await older
        for (const pending of await PermissionNext.list())
          await PermissionNext.reply({ requestID: pending.id, reply: "reject" })
        await waiting
      }
    },
  })
})

test.each(["fullTakeover", "autoApprove"] as const)(
  "an older plan switch cannot cancel operations allowed by newer %s",
  async (latestMode) => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await selectPermissionLevel({ sessionID: session.id, permissionLevel: "fullTakeover" })
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const controller = new AbortController()
        let first = true
        const finish = ModeOperations.register(session.id, "mode-race", "write", controller, async () => {
          if (first) {
            first = false
            entered.resolve()
            await release.promise
          }
          return [{ permission: "*", pattern: "*", action: "allow" }]
        })
        controller.signal.addEventListener("abort", finish, { once: true })
        const older = selectPermissionLevel({ sessionID: session.id, permissionLevel: "ask" })
        try {
          await entered.promise
          await selectPermissionLevel({ sessionID: session.id, permissionLevel: latestMode })
          release.resolve()
          await older
          expect((await Session.get(session.id)).permissionLevel).toBe(latestMode)
          expect(controller.signal.aborted).toBe(false)
        } finally {
          release.resolve()
          finish()
          await older
        }
      },
    })
  },
)

test("sessions expose plan, execute and auto with execute as the default", () => {
  expect(PermissionLevel.Schema.options).toEqual(["ask", "autoApprove", "fullTakeover"])
  expect(PermissionLevel.DEFAULT).toBe("ask")
  expect(PermissionLevel.Schema.safeParse("readonly").success).toBe(false)
  expect(PermissionLevel.Schema.safeParse("plan").success).toBe(false)
})

test("legacy HTTP mode requests preserve read-only authorization and reject old auto", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const app = Server.App()
      const request = (url: string, body: unknown) =>
        app.request(`${url}?directory=${encodeURIComponent(tmp.path)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      expect((await request(`/session/${session.id}/permission-mode`, { permissionMode: "readonly" })).status).toBe(400)
      expect((await Session.get(session.id)).permissionLevel).toBe("ask")
      expect(
        (
          await request(`/session/${session.id}/message`, {
            permissionMode: "fullTakeover",
            noReply: true,
            parts: [{ type: "text", text: "Legacy request" }],
          })
        ).status,
      ).toBe(400)
      expect((await Session.get(session.id)).permissionLevel).toBe("ask")
    },
  })
})

test("fullTakeover preserves business questions and requires the actual human answer", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await selectPermissionLevel({ sessionID: session.id, permissionLevel: "fullTakeover" })
      const answering = Question.ask({
        sessionID: session.id,
        questions: [
          {
            header: "Database",
            question: "Choose a database",
            options: [{ label: "SQLite", description: "Local database" }],
          },
        ],
      })
      answering.catch(() => {})
      try {
        await expect.poll(async () => (await Question.list()).length).toBe(1)
        const request = (await Question.list())[0]!
        await Question.reply({ requestID: request.id, answers: [["SQLite"]] })
        expect(await answering).toEqual([["SQLite"]])
      } finally {
        for (const request of await Question.list()) await Question.reject(request.id)
        await answering.catch(() => {})
      }
    },
  })
})

test("switching to auto preserves an already registered question and its human answer", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const answering = Question.ask({
        sessionID: session.id,
        questions: [{ header: "Choice", question: "Choose", options: [{ label: "Keep", description: "Keep it" }] }],
      })
      const pending = await Question.list()
      expect(pending).toHaveLength(1)
      await selectPermissionLevel({ sessionID: session.id, permissionLevel: "fullTakeover" })
      expect((await Question.list())[0]?.id).toBe(pending[0]!.id)
      await Question.reply({ requestID: pending[0]!.id, answers: [["Keep"]] })
      expect(await answering).toEqual([["Keep"]])
      expect((await Session.get(session.id)).permissionLevel).toBe("fullTakeover")
    },
  })
})

test("fullTakeover permits a denied sensitive operation without creating approval requests or grants", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await selectPermissionLevel({ sessionID: session.id, permissionLevel: "fullTakeover" })
      await expect(
        PermissionNext.ask({
          sessionID: session.id,
          permission: "sensitive_read",
          metadata: {},
          checks: [{ permission: "sensitive_read", pattern: "/secret", grants: [] }],
          ruleset: PermissionPolicy.ruleset("fullTakeover", PermissionNext.fromConfig({ "*": "deny" })),
        }),
      ).resolves.toBeUndefined()
      expect(await PermissionNext.list()).toEqual([])
      expect(await PermissionNext.grants(session.id)).toEqual([])
    },
  })
})

test("reading legacy sessions migrates modes without expanding old auto authorization", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      for (const [legacy, expected] of [
        ["readonly", "ask"],
        ["ask", "ask"],
        ["auto", "ask"],
      ]) {
        const session = await Session.create({})
        SessionStore.put({ ...session, permissionMode: legacy } as Session.Info)
        expect((await Session.get(session.id)).permissionLevel).toBe(expected)
        expect(await Session.get(session.id)).toMatchObject({ permissionNotice: "legacy-permissions-reset" })
      }
    },
  })
})

test.each([undefined, -1, "1"])(
  "a persisted permission level without a valid revision %s restores ask",
  async (revision) => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        SessionStore.put({ ...session, permissionLevel: "fullTakeover", permissionRevision: revision } as Session.Info)
        expect(await Session.get(session.id)).toMatchObject({ permissionLevel: "ask", permissionRevision: 0 })
      },
    })
  },
)

test("a stale permission selection cannot overwrite a newer manual choice", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await selectPermissionLevel({ sessionID: session.id, permissionLevel: "autoApprove" })
      await expect(
        selectPermissionLevel({ sessionID: session.id, permissionLevel: "fullTakeover", expectedRevision: 0 }),
      ).rejects.toBeInstanceOf(PermissionLevel.ConflictError)
      expect((await Session.get(session.id)).permissionLevel).toBe("autoApprove")
    },
  })
})

test("all permission levels expose official plan tools and hide retired mode tools", () => {
  for (const level of PermissionLevel.Schema.options) {
    for (const tool of ["plan_generate", "plan_edit"]) expect(PermissionLevel.allowsTool(level, tool)).toBe(true)
    for (const tool of ["plan_enter", "plan_exit", "plan_write"])
      expect(PermissionLevel.allowsTool(level, tool)).toBe(false)
  }
})
