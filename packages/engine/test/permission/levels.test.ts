import { expect, test } from "vitest"
import path from "node:path"
import { PermissionPolicy } from "@merakcode/engine/agent/permission/policy"
import { PermissionNext } from "@merakcode/engine/agent/permission/next"
import { Loop } from "@merakcode/engine/agent/loop/index"
import { Session } from "@merakcode/engine/agent/session/index"
import { Agent } from "@merakcode/engine/agent/agent"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Bus } from "@merakcode/engine/infra/bus/index"
import { PermissionExecution } from "@merakcode/engine/agent/permission/execution"
import { readySandbox } from "../fixture/sandbox-ready"

test("a session reply cannot invent a grant scope that the operation does not offer", async () => {
  using _isolation = readySandbox()
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const waiting = PermissionNext.askCurrent(
        {
          sessionID: session.id,
          permission: "sensitive_read",
          metadata: {},
          checks: [{ permission: "sensitive_read", pattern: "secret-link", grants: [] }],
        },
        async () => PermissionPolicy.ruleset("ask"),
      )
      waiting.catch(() => {})
      try {
        await expect.poll(async () => (await PermissionNext.list()).length).toBe(1)
        const request = (await PermissionNext.list())[0]!
        expect(request.sandboxReady).toBe(true)
        await expect(
          PermissionNext.reply({ requestID: request.id, reply: "session", scope: "file" }),
        ).rejects.toMatchObject({ name: "PermissionGrantUnavailableError" })
        expect(await PermissionNext.grants(session.id)).toEqual([])
      } finally {
        await PermissionNext.abortPending(session.id)
        await waiting.catch(() => {})
      }
    },
  })
})

test("ask requires approval for ordinary project reads despite old allow rules", () => {
  const root = path.resolve("project")
  const read = PermissionPolicy.file({ op: "read", path: path.join(root, "README.md"), workspace: [root], home: root })
  const rules = PermissionPolicy.ruleset("ask", [{ permission: "*", pattern: "*", action: "allow" }])
  expect(PermissionNext.evaluate(read.permission, read.pattern, rules).action).toBe("ask")
})

test("a forged conversation grant cannot bypass per-operation approval", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const waiting = PermissionNext.askCurrent(
        {
          sessionID: session.id,
          executionID: "unisolated",
          permission: "read",
          metadata: {},
          checks: [{ permission: "read", pattern: "README.md", grants: [{ scope: "file", pattern: "README.md" }] }],
        },
        async () => PermissionPolicy.ruleset("ask"),
      ).catch(() => {})
      try {
        await expect.poll(async () => (await PermissionNext.list()).length).toBe(1)
        const requestID = (await PermissionNext.list())[0]!.id
        await expect(PermissionNext.reply({ requestID, reply: "session" })).rejects.toMatchObject({
          name: "PermissionGrantUnavailableError",
        })
        expect(await PermissionNext.grants(session.id)).toEqual([])
        expect((await PermissionNext.list())[0]!.id).toBe(requestID)
      } finally {
        await PermissionNext.abortPending(session.id)
        await waiting
      }
    },
  })
})

test("conversation grants apply only while this operation has a ready sandbox", async () => {
  await using tmp = await tmpdir({ git: true })
  const previousMode = process.env.MERAKCODE_SANDBOX_MODE
  process.env.MERAKCODE_SANDBOX_MODE = "preferred"
  let ready = true
  PermissionExecution.useBackendForTest({
    status: async () => (ready ? { status: "on", backend: "landlock" } : { status: "unsupported" }),
    wrap: async () => {
      throw new Error("This test does not launch commands")
    },
  })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        let approvals = 0
        const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, (event) => {
          approvals++
          void PermissionNext.reply({
            requestID: event.properties.id,
            reply: ready ? "session" : "once",
            scope: "file",
          })
        })
        const read = () =>
          PermissionNext.askCurrent(
            {
              sessionID: session.id,
              permission: "read",
              metadata: {},
              checks: [{ permission: "read", pattern: "README.md", grants: [{ scope: "file", pattern: "README.md" }] }],
            },
            async () => PermissionPolicy.ruleset("ask"),
          )
        try {
          await read()
          await read()
          expect(approvals).toBe(1)
          ready = false
          await read()
          expect(approvals).toBe(2)
        } finally {
          unsubscribe()
        }
      },
    })
  } finally {
    if (previousMode === undefined) delete process.env.MERAKCODE_SANDBOX_MODE
    else process.env.MERAKCODE_SANDBOX_MODE = previousMode
    PermissionExecution.useBackendForTest(undefined)
  }
})

test.each([
  "network-not-enforced",
  "loopback-not-restricted",
  "tcp-matched-by-port",
  "udp-not-restricted",
  "unix-socket-not-restricted",
  "ambient-world-writable",
])("%s disables dependent grants while ordinary reads keep isolation", async (degraded) => {
  const previous = process.env.MERAKCODE_SANDBOX_MODE
  process.env.MERAKCODE_SANDBOX_MODE = "preferred"
  PermissionExecution.useBackendForTest({
    status: async () => ({ status: "on", backend: "landlock", degraded: [degraded] }),
    wrap: async () => {
      throw new Error("No command expected")
    },
  })
  try {
    expect(await PermissionExecution.ready([{ permission: "network", pattern: "localhost", grants: [] }])).toBe(false)
    expect(await PermissionExecution.ready([{ permission: "bash", pattern: "node script.js", grants: [] }])).toBe(false)
    expect(await PermissionExecution.ready([{ permission: "read", pattern: "README.md", grants: [] }])).toBe(true)
  } finally {
    PermissionExecution.useBackendForTest(undefined)
    if (previous === undefined) delete process.env.MERAKCODE_SANDBOX_MODE
    else process.env.MERAKCODE_SANDBOX_MODE = previous
  }
})

test("an unavailable sandbox requires a new approval for every autoApprove operation", async () => {
  await using tmp = await tmpdir({ git: true, config: { sandbox: { mode: "off" } } })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await Session.setPermissionLevel({ sessionID: session.id, permissionLevel: "autoApprove", expectedRevision: 0 })
      PermissionExecution.useBackendForTest({
        status: async () => ({ status: "unsupported", reason: "Unavailable for this test" }),
        wrap: async () => {
          throw new Error("Unavailable")
        },
      })
      const requests: PermissionNext.Request[] = []
      const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, (event) => {
        requests.push(event.properties)
        void PermissionNext.reply({ requestID: event.properties.id, reply: "once" })
      })
      try {
        for (let index = 0; index < 2; index++)
          await PermissionNext.askCurrent(
            {
              sessionID: session.id,
              permission: "read",
              checks: [{ permission: "read", pattern: "README.md", grants: [{ scope: "file", pattern: "README.md" }] }],
              metadata: {},
            },
            async () => PermissionPolicy.ruleset("autoApprove"),
          )
        expect(requests).toHaveLength(2)
        expect(requests.every((request) => !request.grants?.length && !request.always)).toBe(true)
      } finally {
        unsubscribe()
        PermissionExecution.useBackendForTest(undefined)
      }
    },
  })
})

test("tool admission reads the selected permission level instead of a legacy mode", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const agent = (await Agent.get("build"))!
      const rules = Loop.buildToolExecutionRuleset({ agent, session })
      expect(PermissionNext.evaluate("read", "README.md", rules).action).toBe("ask")
    },
  })
})

test("fullTakeover preserves agent restrictions and prevents nested subagents", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const root = await Session.create({})
      await Session.setPermissionLevel({ sessionID: root.id, permissionLevel: "fullTakeover", expectedRevision: 0 })
      const child = await Session.create({ parentID: root.id })
      const agent = (await Agent.get("build"))!
      const restricted = { ...agent, profile: { ...agent.profile!, restrictedRules: PermissionPolicy.deny("edit") } }
      expect(
        PermissionNext.evaluate(
          "read",
          "README.md",
          PermissionPolicy.execution({ agent: restricted, session: child, permissionLevel: "fullTakeover" }),
        ).action,
      ).toBe("allow")
      const rules = async () =>
        PermissionPolicy.execution({ agent: restricted, session: { ...child, permissionLevel: "fullTakeover" } })
      for (const permission of ["edit", "subagent"])
        await expect(
          PermissionNext.askCurrent(
            { sessionID: child.id, root: root.id, permission, patterns: ["target"], metadata: {} },
            rules,
          ),
        ).rejects.toBeInstanceOf(PermissionNext.DeniedError)
      expect(await PermissionNext.list()).toEqual([])
    },
  })
})

test("fullTakeover skips safety rules without granting persistent permission", () => {
  const rules = PermissionPolicy.ruleset("fullTakeover", [{ permission: "*", pattern: "*", action: "deny" }])
  expect(PermissionNext.evaluate("external_write", "outside", rules).action).toBe("allow")
})

test("autoApprove allows controlled project work and asks for dangerous or unknown operations", () => {
  const rules = PermissionPolicy.ruleset("autoApprove", [
    { permission: "*", pattern: "*", action: "allow" },
    { permission: "sensitive_read", pattern: "*", action: "deny" },
  ])
  for (const permission of ["read", "edit", "bash_readonly", "plan_generate"])
    expect(PermissionNext.evaluate(permission, "target", rules).action, permission).toBe("allow")
  for (const permission of ["bash", "bash_risky", "bash_delete", "external_write", "config_write", "mcp", "unknown"])
    expect(PermissionNext.evaluate(permission, "target", rules).action, permission).toBe("ask")
  expect(PermissionNext.evaluate("sensitive_read", "target", rules).action).toBe("deny")
})
