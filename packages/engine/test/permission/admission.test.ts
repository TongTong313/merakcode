import { expect, test } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { PermissionNext } from "../../src/agent/permission/next"
import { PermissionPolicy } from "../../src/agent/permission/policy"
import { Session } from "../../src/agent/session"
import { Instance } from "../../src/infra/project/instance"
import { Bus } from "../../src/infra/bus"
import { tmpdir, selectPermissionLevel } from "../fixture/fixture"
import { decideExternal } from "../../src/agent/external/runtime"

test("an explicit deny observed while approval is pending wins across reply microtask interleavings", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      let checked = 0
      for (let turns = 0; turns < 80; turns++) {
        const root = await Session.create({})
        await selectPermissionLevel({ sessionID: root.id, permissionLevel: "autoApprove" })
        await Session.update(root.id, (draft) => {
          draft.permission = [{ permission: "bash", pattern: "*", action: "allow" }]
        })
        const asked = Promise.withResolvers<string>()
        const offAsked = Bus.subscribe(PermissionNext.Event.Asked, (e) => {
          if (e.properties.sessionID === root.id) asked.resolve(e.properties.id)
        })
        let pendingAtSwitch: Promise<PermissionNext.Request[]> | undefined
        const offSession = Bus.subscribe(Session.Event.Updated, (e) => {
          if (e.properties.info.id === root.id && e.properties.info.permissionLevel === "ask")
            pendingAtSwitch = PermissionNext.list()
        })
        const running = decideExternal(
          { sessionID: root.id, executionID: `reply-gap-${turns}`, cwd: tmp.path },
          { kind: "command", command: "npm test .env" },
        )
        try {
          const reply = PermissionNext.reply({ requestID: await asked.promise, reply: "once" })
          for (let i = 0; i < turns; i++) await Promise.resolve()
          await Session.update(root.id, (draft) => {
            draft.permission = [{ permission: "sensitive_read", pattern: "*", action: "deny" }]
          })
          const change = selectPermissionLevel({ sessionID: root.id, permissionLevel: "ask" })
          await Promise.all([reply, change])
          const verdict = await running
          if ((await pendingAtSwitch)?.some((request) => request.sessionID === root.id)) {
            checked++
            expect(verdict.allow, `mode changed while pending at microtask ${turns}`).toBe(false)
          }
        } finally {
          offAsked()
          offSession()
          await PermissionNext.abortPending(root.id)
        }
      }
      expect(checked).toBeGreaterThan(0)
    },
  })
}, 30_000)

test.each([false, true])(
  "an explicit deny in a mixed external approval applies after switching the root to ask (child %s)",
  async (child) => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({})
        const session = child ? await Session.create({ parentID: root.id }) : root
        await Session.update(root.id, (draft) => {
          draft.permission = [
            { permission: "bash", pattern: "*", action: "allow" },
            { permission: "sensitive_read", pattern: "*", action: "ask" },
          ]
        })
        const asked = Promise.withResolvers<string>()
        const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, (e) => asked.resolve(e.properties.id))
        const running = decideExternal(
          { sessionID: session.id, executionID: "mixed-regression", cwd: tmp.path },
          { kind: "command", command: "npm test .env" },
        )
        try {
          const id = await asked.promise
          await Session.update(root.id, (draft) => {
            draft.permission = [{ permission: "sensitive_read", pattern: "*", action: "deny" }]
          })
          await selectPermissionLevel({ sessionID: root.id, permissionLevel: "ask" })
          await PermissionNext.reply({ requestID: id, reply: "once" })
          expect((await running).allow).toBe(false)
          expect(await PermissionNext.list()).toEqual([])
        } finally {
          await PermissionNext.abortPending(session.id)
          unsubscribe()
        }
      },
    })
  },
)

test("unisolated external approvals cannot save a conversation grant", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const root = await Session.create({})
      const asked = Promise.withResolvers<string>()
      const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, (event) => asked.resolve(event.properties.id))
      const running = decideExternal(
        { sessionID: root.id, executionID: "grant-save", cwd: tmp.path },
        { kind: "command", command: "npm test .env" },
      )
      try {
        const requestID = await asked.promise
        await expect(PermissionNext.reply({ requestID, reply: "session" })).rejects.toBeInstanceOf(
          PermissionNext.GrantUnavailableError,
        )
        expect(await PermissionNext.grants(root.id)).toEqual([])
        await PermissionNext.reply({ requestID, reply: "reject" })
        expect((await running).allow).toBe(false)
      } finally {
        unsubscribe()
        await PermissionNext.abortPending(root.id)
      }
    },
  })
})

test.each([
  { initial: "fullTakeover", next: "autoApprove", expected: "reject", cancel: false },
  { initial: "fullTakeover", next: "ask", expected: "reject", cancel: false },
  { initial: "autoApprove", next: "fullTakeover", expected: "allow", cancel: false },
  { initial: "autoApprove", next: "autoApprove", expected: "reject", cancel: true },
] as const)(
  "admission $initial to $next respects cancellation=$cancel",
  async ({ initial, next, expected, cancel }) => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({})
        const child = await Session.create({ parentID: root.id })
        await selectPermissionLevel({ sessionID: root.id, permissionLevel: initial })
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const stop = new AbortController()
        const target = path.join(tmp.path, "effect")
        let first = true
        let popups = 0
        const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, (event) => {
          popups++
          void PermissionNext.reply({ requestID: event.properties.id, reply: "reject" })
        })
        const running = PermissionNext.askCurrent(
          {
            sessionID: child.id,
            root: root.id,
            executionID: "admission",
            permission: "external_write",
            metadata: {},
            checks: [{ permission: "external_write", pattern: "/outside/file", grants: [] }],
          },
          async () => {
            const session = await Session.get(root.id)
            const rules = PermissionPolicy.ruleset(
              session.permissionLevel ?? "autoApprove",
              await PermissionNext.grants(root.id),
            )
            if (first) {
              first = false
              entered.resolve()
              await release.promise
            }
            return rules
          },
          stop.signal,
        ).then(
          async () => {
            await fs.writeFile(target, "allowed")
            return "allow"
          },
          () => "reject",
        )
        try {
          await entered.promise
          if (cancel) stop.abort()
          await selectPermissionLevel({ sessionID: root.id, permissionLevel: next })
          release.resolve()
          expect(await running).toBe(expected)
          expect(popups).toBe(!cancel && next !== "fullTakeover" ? 1 : 0)
          expect(
            await fs.stat(target).then(
              () => true,
              () => false,
            ),
          ).toBe(expected === "allow")
        } finally {
          release.resolve()
          stop.abort()
          await running
          unsubscribe()
        }
      },
    })
  },
)
