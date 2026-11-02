import { expect, test } from "vitest"
import { SessionMode } from "@merakcode/engine/agent/permission/mode"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Session } from "@merakcode/engine/agent/session/index"
import { SessionStore } from "@merakcode/engine/agent/session/store"
import { tmpdir } from "../fixture/fixture"
import { PermissionNext } from "@merakcode/engine/agent/permission/next"
import { PermissionPolicy } from "@merakcode/engine/agent/permission/policy"
import { Question } from "@merakcode/engine/agent/session/question/index"
import { Server } from "@merakcode/engine/app/server/server"
import { ModeOperations } from "@merakcode/engine/agent/permission/operations"

test("explicit child mode selection changes the effective root policy and child prompts preserve it", async () => {
  const { Loop } = await import("../../src/agent/loop")
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const root = await Session.create({})
      const child = await Session.create({ parentID: root.id })
      await Session.setMode({ sessionID: root.id, sessionMode: "auto" })
      const response = await Server.App().request(
        `/session/${child.id}/mode?directory=${encodeURIComponent(tmp.path)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionMode: "plan" }),
        },
      )
      expect(response.status).toBe(200)
      expect((await Session.get(root.id)).sessionMode).toBe("plan")
      expect((await Session.get(child.id)).sessionMode).toBe("plan")
      await Loop.prompt({
        sessionID: child.id,
        sessionMode: "auto",
        noReply: true,
        model: { providerID: "openai", modelID: "gpt-4" },
        parts: [{ type: "text", text: "Inherited task" }],
      })
      expect((await Session.get(root.id)).sessionMode).toBe("plan")
      expect((await Session.get(child.id)).sessionMode).toBe("plan")
    },
  })
})

test("an asynchronous permission reevaluation cannot approve after a newer execute switch", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await Session.setMode({ sessionID: session.id, sessionMode: "auto" })
      // An in-flight caller may register checks from its earlier execute policy.
      let allowed = false
      const waiting = PermissionNext.ask({
        sessionID: session.id,
        executionID: "external-race",
        permission: "external_write",
        metadata: {},
        checks: [{ permission: "external_write", pattern: "/outside/file", grants: [] }],
        ruleset: PermissionPolicy.ruleset("execute"),
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
        return PermissionPolicy.ruleset("auto")
      })
      try {
        await entered.promise
        await Session.setMode({ sessionID: session.id, sessionMode: "execute" })
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

test.each(["auto", "execute"] as const)(
  "an older plan switch cannot cancel operations allowed by newer %s",
  async (latestMode) => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await Session.setMode({ sessionID: session.id, sessionMode: "auto" })
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
        const older = Session.setMode({ sessionID: session.id, sessionMode: "plan" })
        try {
          await entered.promise
          await Session.setMode({ sessionID: session.id, sessionMode: latestMode })
          release.resolve()
          await older
          expect((await Session.get(session.id)).sessionMode).toBe(latestMode)
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
  expect(SessionMode.Schema.options).toEqual(["plan", "execute", "auto"])
  expect(SessionMode.normalize()).toBe("execute")
  expect(SessionMode.Schema.safeParse("readonly").success).toBe(false)
  expect(SessionMode.Schema.safeParse("ask").success).toBe(false)
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
      expect((await request(`/session/${session.id}/permission-mode`, { permissionMode: "readonly" })).status).toBe(200)
      expect((await Session.get(session.id)).sessionMode).toBe("plan")
      expect(
        (
          await request(`/session/${session.id}/message`, {
            permissionMode: "auto",
            noReply: true,
            parts: [{ type: "text", text: "Legacy request" }],
          })
        ).status,
      ).toBe(400)
      expect((await Session.get(session.id)).sessionMode).toBe("plan")
    },
  })
})

test("auto refuses new questions without publishing a pending interaction", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await Session.setMode({ sessionID: session.id, sessionMode: "auto" })
      await expect(Question.ask({ sessionID: session.id, questions: [] })).rejects.toThrow(/interaction/i)
      expect(await Question.list()).toEqual([])
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
      await Session.setMode({ sessionID: session.id, sessionMode: "auto" })
      expect((await Question.list())[0]?.id).toBe(pending[0]!.id)
      await Question.reply({ requestID: pending[0]!.id, answers: [["Keep"]] })
      expect(await answering).toEqual([["Keep"]])
      expect((await Session.get(session.id)).sessionMode).toBe("auto")
    },
  })
})

test("auto permits a denied sensitive operation without creating approval requests or grants", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await expect(
        PermissionNext.ask({
          sessionID: session.id,
          permission: "sensitive_read",
          metadata: {},
          checks: [{ permission: "sensitive_read", pattern: "/secret", grants: [] }],
          ruleset: PermissionPolicy.ruleset("auto", PermissionNext.fromConfig({ "*": "deny" })),
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
        ["readonly", "plan"],
        ["ask", "execute"],
        ["auto", "execute"],
      ]) {
        const session = await Session.create({})
        SessionStore.put({ ...session, permissionMode: legacy } as Session.Info)
        expect((await Session.get(session.id)).sessionMode).toBe(expected)
      }
    },
  })
})

test("a stale prompt mode cannot overwrite a newer manual mode change", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await Session.setMode({ sessionID: session.id, sessionMode: "plan" })
      const current = await Session.get(session.id)
      const saved = await Session.setMode({
        sessionID: session.id,
        sessionMode: "auto",
        expectedRevision: session.modeRevision ?? 0,
      })
      expect(saved.sessionMode).toBe("plan")
      expect(saved.modeRevision).toBe(current.modeRevision)
    },
  })
})

test("execute excludes plan mutation tools while plan and auto can update the artifact", () => {
  for (const tool of ["plan_write", "plan_edit"]) {
    expect(SessionMode.allowsTool("plan", tool)).toBe(true)
    expect(SessionMode.allowsTool("execute", tool)).toBe(false)
    expect(SessionMode.allowsTool("auto", tool)).toBe(true)
  }
})
