import { expect, test } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { PermissionNext } from "../../src/agent/permission/next"
import { PermissionPolicy } from "../../src/agent/permission/policy"
import { Session } from "../../src/agent/session"
import { Instance } from "../../src/infra/project/instance"
import { Bus } from "../../src/infra/bus"
import { tmpdir } from "../fixture/fixture"
import { decideExternal } from "../../src/agent/external/runtime"

test("a mode change observed while approval is pending wins across reply microtask interleavings", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      let checked = 0
      for (let turns = 0; turns < 80; turns++) {
        const root = await Session.create({})
        await Session.update(root.id, (draft) => {
          draft.permission = [{ permission: "bash", pattern: "*", action: "allow" }]
        })
        const asked = Promise.withResolvers<string>()
        const offAsked = Bus.subscribe(PermissionNext.Event.Asked, (e) => {
          if (e.properties.sessionID === root.id) asked.resolve(e.properties.id)
        })
        let pendingAtSwitch: Promise<PermissionNext.Request[]> | undefined
        const offSession = Bus.subscribe(Session.Event.Updated, (e) => {
          if (e.properties.info.id === root.id && e.properties.info.sessionMode === "plan")
            pendingAtSwitch = PermissionNext.list()
        })
        const running = decideExternal(
          { sessionID: root.id, executionID: `reply-gap-${turns}`, cwd: tmp.path },
          { kind: "command", command: "npm test .env" },
        )
        try {
          const reply = PermissionNext.reply({ requestID: await asked.promise, reply: "once" })
          for (let i = 0; i < turns; i++) await Promise.resolve()
          const change = Session.setMode({ sessionID: root.id, sessionMode: "plan" })
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
  "mixed external approvals are denied after switching the root to plan (child %s)",
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
          await Session.setMode({ sessionID: root.id, sessionMode: "plan" })
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

test("switching to plan while an always grant is being saved cannot release the external command", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const root = await Session.create({})
      await Session.update(root.id, (draft) => {
        draft.permission = [{ permission: "bash", pattern: "*", action: "allow" }]
      })
      const asked = Promise.withResolvers<string>()
      const offAsked = Bus.subscribe(PermissionNext.Event.Asked, (e) => asked.resolve(e.properties.id))
      let switched: Promise<unknown> | undefined
      const offSession = Bus.subscribe(Session.Event.Updated, (e) => {
        if (
          e.properties.info.id !== root.id ||
          !e.properties.info.permission?.some((rule) => rule.permission === "sensitive_read" && rule.action === "allow")
        )
          return
        if (!switched) switched = Session.setMode({ sessionID: root.id, sessionMode: "plan" })
      })
      const running = decideExternal(
        { sessionID: root.id, executionID: "grant-save-regression", cwd: tmp.path },
        { kind: "command", command: "npm test .env" },
      )
      try {
        await PermissionNext.reply({ requestID: await asked.promise, reply: "always" })
        await switched
        expect((await running).allow).toBe(false)
        expect((await Session.get(root.id)).sessionMode).toBe("plan")
      } finally {
        offAsked()
        offSession()
        await PermissionNext.abortPending(root.id)
      }
    },
  })
})

test.each([
  { initial: "auto", next: "execute", expected: "reject", cancel: false },
  { initial: "auto", next: "plan", expected: "reject", cancel: false },
  { initial: "execute", next: "auto", expected: "allow", cancel: false },
  { initial: "execute", next: "execute", expected: "reject", cancel: true },
] as const)(
  "admission $initial to $next respects cancellation=$cancel",
  async ({ initial, next, expected, cancel }) => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({})
        const child = await Session.create({ parentID: root.id })
        await Session.setMode({ sessionID: root.id, sessionMode: initial })
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
              session.sessionMode ?? "execute",
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
          await Session.setMode({ sessionID: root.id, sessionMode: next })
          release.resolve()
          expect(await running).toBe(expected)
          expect(popups).toBe(!cancel && next === "execute" ? 1 : 0)
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
