import { expect, test } from "vitest"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Server } from "@merakcode/engine/app/server/server"
import { Session } from "@merakcode/engine/agent/session/index"
import { Loop } from "@merakcode/engine/agent/loop/index"
import { PermissionNext } from "@merakcode/engine/agent/permission/next"
import { PermissionPolicy } from "@merakcode/engine/agent/permission/policy"
import { tmpdir } from "../fixture/fixture"
import { Bus } from "@merakcode/engine/infra/bus/index"

test("new sessions expose ask permission without inheriting another conversation", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const app = Server.App()
      const response = await app.request(`/session?directory=${encodeURIComponent(tmp.path)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "New conversation" }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ permissionLevel: "ask", permissionRevision: 0 })
    },
  })
})

test("switching to autoApprove preserves an unisolated pending request and its id", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const waiting = PermissionNext.askCurrent(
        {
          sessionID: session.id,
          executionID: "external-read",
          permission: "read",
          metadata: {},
          checks: [{ permission: "read", pattern: "README.md", grants: [] }],
        },
        async () => PermissionPolicy.ruleset((await Session.get(session.id)).permissionLevel ?? "ask"),
      ).catch(() => {})
      try {
        await expect.poll(async () => (await PermissionNext.list()).length).toBe(1)
        const requestID = (await PermissionNext.list())[0]!.id
        const response = await Server.App().request(
          `/session/${session.id}/permission-level?directory=${encodeURIComponent(tmp.path)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ permissionLevel: "autoApprove", expectedRevision: 0 }),
          },
        )
        expect(response.status).toBe(200)
        expect((await PermissionNext.list()).map((request) => request.id)).toEqual([requestID])
      } finally {
        await PermissionNext.abortPending(session.id)
        await waiting
      }
    },
  })
})

test("switching to fullTakeover releases a pending approval once", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      let approvals = 0
      const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, () => {
        approvals++
      })
      const waiting = PermissionNext.askCurrent(
        {
          sessionID: session.id,
          executionID: "waiting-task",
          permission: "external_write",
          metadata: {},
          checks: [{ permission: "external_write", pattern: "outside", grants: [] }],
        },
        async () => PermissionPolicy.ruleset((await Session.get(session.id)).permissionLevel ?? "ask"),
      ).catch(() => {})
      try {
        await expect.poll(async () => (await PermissionNext.list()).length).toBe(1)
        const response = await Server.App().request(
          `/session/${session.id}/permission-level?directory=${encodeURIComponent(tmp.path)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ permissionLevel: "fullTakeover", expectedRevision: 0 }),
          },
        )
        expect(response.status).toBe(200)
        expect(await PermissionNext.list()).toEqual([])
        expect(await PermissionNext.grants(session.id)).toEqual([])
        expect(approvals).toBe(1)
      } finally {
        unsubscribe()
        await PermissionNext.abortPending(session.id)
        await waiting
      }
    },
  })
})

test("legacy always replies return a recognizable upgrade error", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const response = await Server.App().request(
        `/permission/per_legacy/reply?directory=${encodeURIComponent(tmp.path)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reply: "always" }),
        },
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: "MRK-1009", message: expect.stringMatching(/升级|upgrade/i) })
    },
  })
})

test("ordinary messages cannot replace an explicit permission selection", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await Session.setPermissionLevel({ sessionID: session.id, permissionLevel: "fullTakeover", expectedRevision: 0 })
      await Loop.prompt({
        sessionID: session.id,
        permissionLevel: "ask",
        noReply: true,
        model: { providerID: "openai", modelID: "gpt-4" },
        parts: [{ type: "text", text: "Discuss the current task" }],
      })
      expect(await Session.get(session.id)).toMatchObject({ permissionLevel: "fullTakeover", permissionRevision: 1 })
    },
  })
})

test("imported history cannot restore takeover or old session grants", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const app = Server.App()
      const session = await Session.create({})
      const exported = await (
        await app.request(`/session/${session.id}/export-full?directory=${encodeURIComponent(tmp.path)}`)
      ).json()
      exported.info.permissionLevel = "fullTakeover"
      exported.info.permissionRevision = 12
      exported.info.permission = [
        { permission: "*", pattern: "*", action: "allow" },
        { permission: "sensitive_read", pattern: "*", action: "deny" },
      ]
      const response = await app.request(`/session/import-full?directory=${encodeURIComponent(tmp.path)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(exported),
      })
      expect(response.status).toBe(200)
      const imported = (await response.json()).info
      expect(imported).toMatchObject({ permissionLevel: "ask", permissionRevision: 0 })
      expect(imported.permission).toEqual([{ permission: "sensitive_read", pattern: "*", action: "deny" }])
    },
  })
})

test("permission selection updates the root and rejects stale revisions and legacy values", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const app = Server.App()
      const root = await Session.create({})
      const child = await Session.create({ parentID: root.id })
      const select = (permissionLevel: string, expectedRevision: number) =>
        app.request(`/session/${child.id}/permission-level?directory=${encodeURIComponent(tmp.path)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ permissionLevel, expectedRevision }),
        })
      const selected = await select("autoApprove", 0)
      expect(selected.status).toBe(200)
      expect(await selected.json()).toMatchObject({ permissionLevel: "autoApprove", permissionRevision: 1 })
      expect(await Session.get(root.id)).toMatchObject({ permissionLevel: "autoApprove", permissionRevision: 1 })
      expect(await Session.get(child.id)).toMatchObject({ permissionLevel: "autoApprove", permissionRevision: 1 })
      expect((await select("fullTakeover", 0)).status).toBe(409)
      for (const legacy of ["plan", "execute", "auto", "fullAccess", "readonly"])
        expect((await select(legacy, 1)).status, legacy).toBe(400)
      expect((await select("fullTakeover", 1)).status).toBe(200)
      expect((await select("ask", 2)).status).toBe(200)
      expect(await Session.get(root.id)).toMatchObject({ permissionLevel: "ask", permissionRevision: 3 })
    },
  })
})
