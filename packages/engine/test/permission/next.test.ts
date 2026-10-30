import { test, expect } from "vitest"
import os from "os"
import { PermissionNext } from "@merakcode/engine/agent/permission/next"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Bus } from "@merakcode/engine/infra/bus/index"
import { Session } from "@merakcode/engine/agent/session/index"
import { Loop } from "@merakcode/engine/agent/loop/index"
import { tmpdir } from "../fixture/fixture"

// fromConfig tests

test("fromConfig - string value becomes wildcard rule", () => {
  const result = PermissionNext.fromConfig({ bash: "allow" })
  expect(result).toEqual([{ permission: "bash", pattern: "*", action: "allow" }])
})

test("fromConfig - object value converts to rules array", () => {
  const result = PermissionNext.fromConfig({ bash: { "*": "allow", rm: "deny" } })
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "deny" },
  ])
})

test("fromConfig - mixed string and object values", () => {
  const result = PermissionNext.fromConfig({
    bash: { "*": "allow", rm: "deny" },
    edit: "allow",
    webfetch: "ask",
  })
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "deny" },
    { permission: "edit", pattern: "*", action: "allow" },
    { permission: "webfetch", pattern: "*", action: "ask" },
  ])
})

test("fromConfig - empty object", () => {
  const result = PermissionNext.fromConfig({})
  expect(result).toEqual([])
})

test("fromUserConfig - drops internal protocol keys and the deprecated task key, keeps the rest", () => {
  const result = PermissionNext.fromUserConfig({
    bash: "allow",
    subagent: "ask",
    todowrite: "allow",
    plan_enter: "allow",
    doom_loop: "ask",
    task: "allow",
    network: { "example.com": "allow" },
  })
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "subagent", pattern: "*", action: "ask" },
    { permission: "network", pattern: "example.com", action: "allow" },
  ])
})

test("INTERNAL_PERMISSION_KEYS contains expected internal tools", () => {
  const keys = Array.from(PermissionNext.INTERNAL_PERMISSION_KEYS).sort()
  expect(keys).toEqual(["delegate", "doom_loop", "plan_enter", "plan_exit", "todowrite"])
})

test("appendForbidNestedSubagentRule only adds a subagent deny", () => {
  const merged = PermissionNext.merge(PermissionNext.appendForbidNestedSubagentRule())
  expect(PermissionNext.evaluate("subagent", "*", merged).action).toBe("deny")
  expect(PermissionNext.evaluate("read", "*", merged).action).toBe("ask")
})

test("fromConfig - expands tilde to home directory", () => {
  const result = PermissionNext.fromConfig({ external_directory: { "~/projects/*": "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: `${os.homedir()}/projects/*`, action: "allow" }])
})

test("fromConfig - expands $HOME to home directory", () => {
  const result = PermissionNext.fromConfig({ external_directory: { "$HOME/projects/*": "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: `${os.homedir()}/projects/*`, action: "allow" }])
})

test("fromConfig - expands $HOME without trailing slash", () => {
  const result = PermissionNext.fromConfig({ external_directory: { $HOME: "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: os.homedir(), action: "allow" }])
})

test("fromConfig - does not expand tilde in middle of path", () => {
  const result = PermissionNext.fromConfig({ external_directory: { "/some/~/path": "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: "/some/~/path", action: "allow" }])
})

test("fromConfig - expands exact tilde to home directory", () => {
  const result = PermissionNext.fromConfig({ external_directory: { "~": "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: os.homedir(), action: "allow" }])
})

test("evaluate - matches expanded tilde pattern", () => {
  const ruleset = PermissionNext.fromConfig({ external_directory: { "~/projects/*": "allow" } })
  const result = PermissionNext.evaluate("external_directory", `${os.homedir()}/projects/file.txt`, ruleset)
  expect(result.action).toBe("allow")
})

test("evaluate - matches expanded $HOME pattern", () => {
  const ruleset = PermissionNext.fromConfig({ external_directory: { "$HOME/projects/*": "allow" } })
  const result = PermissionNext.evaluate("external_directory", `${os.homedir()}/projects/file.txt`, ruleset)
  expect(result.action).toBe("allow")
})

// merge tests

test("merge - simple concatenation", () => {
  const result = PermissionNext.merge(
    [{ permission: "bash", pattern: "*", action: "allow" }],
    [{ permission: "bash", pattern: "*", action: "deny" }],
  )
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "*", action: "deny" },
  ])
})

test("merge - adds new permission", () => {
  const result = PermissionNext.merge(
    [{ permission: "bash", pattern: "*", action: "allow" }],
    [{ permission: "edit", pattern: "*", action: "deny" }],
  )
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "edit", pattern: "*", action: "deny" },
  ])
})

test("merge - concatenates rules for same permission", () => {
  const result = PermissionNext.merge(
    [{ permission: "bash", pattern: "foo", action: "ask" }],
    [{ permission: "bash", pattern: "*", action: "deny" }],
  )
  expect(result).toEqual([
    { permission: "bash", pattern: "foo", action: "ask" },
    { permission: "bash", pattern: "*", action: "deny" },
  ])
})

test("merge - multiple rulesets", () => {
  const result = PermissionNext.merge(
    [{ permission: "bash", pattern: "*", action: "allow" }],
    [{ permission: "bash", pattern: "rm", action: "ask" }],
    [{ permission: "edit", pattern: "*", action: "allow" }],
  )
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "ask" },
    { permission: "edit", pattern: "*", action: "allow" },
  ])
})

test("merge - empty ruleset does nothing", () => {
  const result = PermissionNext.merge([{ permission: "bash", pattern: "*", action: "allow" }], [])
  expect(result).toEqual([{ permission: "bash", pattern: "*", action: "allow" }])
})

test("merge - preserves rule order", () => {
  const result = PermissionNext.merge(
    [
      { permission: "edit", pattern: "src/*", action: "allow" },
      { permission: "edit", pattern: "src/secret/*", action: "deny" },
    ],
    [{ permission: "edit", pattern: "src/secret/ok.ts", action: "allow" }],
  )
  expect(result).toEqual([
    { permission: "edit", pattern: "src/*", action: "allow" },
    { permission: "edit", pattern: "src/secret/*", action: "deny" },
    { permission: "edit", pattern: "src/secret/ok.ts", action: "allow" },
  ])
})

test("merge - config permission overrides default ask", () => {
  // Simulates: defaults have "*": "ask", config sets bash: "allow"
  const defaults: PermissionNext.Ruleset = [{ permission: "*", pattern: "*", action: "ask" }]
  const config: PermissionNext.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
  const merged = PermissionNext.merge(defaults, config)

  // Config's bash allow should override default ask
  expect(PermissionNext.evaluate("bash", "ls", merged).action).toBe("allow")
  // Other permissions should still be ask (from defaults)
  expect(PermissionNext.evaluate("edit", "foo.ts", merged).action).toBe("ask")
})

test("merge - config ask overrides default allow", () => {
  // Simulates: defaults have bash: "allow", config sets bash: "ask"
  const defaults: PermissionNext.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
  const config: PermissionNext.Ruleset = [{ permission: "bash", pattern: "*", action: "ask" }]
  const merged = PermissionNext.merge(defaults, config)

  // Config's ask should override default allow
  expect(PermissionNext.evaluate("bash", "ls", merged).action).toBe("ask")
})

// evaluate tests

test("evaluate - exact pattern match", () => {
  const result = PermissionNext.evaluate("bash", "rm", [{ permission: "bash", pattern: "rm", action: "deny" }])
  expect(result.action).toBe("deny")
})

test("evaluate - wildcard pattern match", () => {
  const result = PermissionNext.evaluate("bash", "rm", [{ permission: "bash", pattern: "*", action: "allow" }])
  expect(result.action).toBe("allow")
})

test("evaluate - last matching rule wins", () => {
  const result = PermissionNext.evaluate("bash", "rm", [
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - last matching rule wins (wildcard after specific)", () => {
  const result = PermissionNext.evaluate("bash", "rm", [
    { permission: "bash", pattern: "rm", action: "deny" },
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - glob pattern match", () => {
  const result = PermissionNext.evaluate("edit", "src/foo.ts", [
    { permission: "edit", pattern: "src/*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - last matching glob wins", () => {
  const result = PermissionNext.evaluate("edit", "src/components/Button.tsx", [
    { permission: "edit", pattern: "src/*", action: "deny" },
    { permission: "edit", pattern: "src/components/*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - order matters for specificity", () => {
  // If more specific rule comes first, later wildcard overrides it
  const result = PermissionNext.evaluate("edit", "src/components/Button.tsx", [
    { permission: "edit", pattern: "src/components/*", action: "allow" },
    { permission: "edit", pattern: "src/*", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - asks when no rule matches", () => {
  expect(
    PermissionNext.evaluate("unknown_tool", "anything", [{ permission: "bash", pattern: "*", action: "allow" }]).action,
  ).toBe("ask")
  expect(PermissionNext.evaluate("bash", "rm", []).action).toBe("ask")
  expect(
    PermissionNext.evaluate("edit", "etc/passwd", [{ permission: "edit", pattern: "src/*", action: "allow" }]).action,
  ).toBe("ask")
})

test("evaluate - commands at every bash level match literally (backslash is not a path separator)", () => {
  const ruleset: PermissionNext.Ruleset = [{ permission: "bash_risky", pattern: "echo a\b*", action: "allow" }]
  expect(PermissionNext.evaluate("bash_risky", "echo a\b c", ruleset).action).toBe("allow")
})

test("evaluate - multiple matching patterns, last wins", () => {
  const result = PermissionNext.evaluate("edit", "src/secret.ts", [
    { permission: "edit", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "src/*", action: "allow" },
    { permission: "edit", pattern: "src/secret.ts", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - non-matching patterns are skipped", () => {
  const result = PermissionNext.evaluate("edit", "src/foo.ts", [
    { permission: "edit", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "test/*", action: "deny" },
    { permission: "edit", pattern: "src/*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - exact match at end wins over earlier wildcard", () => {
  const result = PermissionNext.evaluate("bash", "/bin/rm", [
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "/bin/rm", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - wildcard at end overrides earlier exact match", () => {
  const result = PermissionNext.evaluate("bash", "/bin/rm", [
    { permission: "bash", pattern: "/bin/rm", action: "deny" },
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

// wildcard permission tests

test("evaluate - wildcard permission matches any permission", () => {
  const result = PermissionNext.evaluate("bash", "rm", [{ permission: "*", pattern: "*", action: "deny" }])
  expect(result.action).toBe("deny")
})

test("evaluate - wildcard permission with specific pattern", () => {
  const result = PermissionNext.evaluate("bash", "rm", [{ permission: "*", pattern: "rm", action: "deny" }])
  expect(result.action).toBe("deny")
})

test("evaluate - glob permission pattern", () => {
  const result = PermissionNext.evaluate("mcp_server_tool", "anything", [
    { permission: "mcp_*", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - specific permission and wildcard permission combined", () => {
  const result = PermissionNext.evaluate("bash", "rm", [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - wildcard permission does not match when specific exists", () => {
  const result = PermissionNext.evaluate("edit", "src/foo.ts", [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "edit", pattern: "src/*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - multiple matching permission patterns combine rules", () => {
  const result = PermissionNext.evaluate("mcp_dangerous", "anything", [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "mcp_*", pattern: "*", action: "allow" },
    { permission: "mcp_dangerous", pattern: "*", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - wildcard permission fallback for unknown tool", () => {
  const result = PermissionNext.evaluate("unknown_tool", "anything", [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("ask")
})

test("evaluate - permission patterns sorted by length regardless of object order", () => {
  // specific permission listed before wildcard, but specific should still win
  const result = PermissionNext.evaluate("bash", "rm", [
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "*", pattern: "*", action: "deny" },
  ])
  // With flat list, last matching rule wins - so "*" matches bash and wins
  expect(result.action).toBe("deny")
})

test("evaluate - merges multiple rulesets", () => {
  const config: PermissionNext.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
  const approved: PermissionNext.Ruleset = [{ permission: "bash", pattern: "rm", action: "deny" }]
  // approved comes after config, so rm should be denied
  const result = PermissionNext.evaluate("bash", "rm", config, approved)
  expect(result.action).toBe("deny")
})

// ask tests

test("ask - resolves immediately when action is allow", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await PermissionNext.ask({
        sessionID: "ses_test",
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
      })
      expect(result).toBeUndefined()
    },
  })
})

test("ask - asks and stays pending when no rule matches", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const promise = PermissionNext.ask({
        id: "permission_nomatch",
        sessionID: "ses_test",
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        ruleset: [],
      })
      expect((await PermissionNext.list()).map((item) => item.id)).toEqual(["permission_nomatch"])
      await PermissionNext.reply({ requestID: "permission_nomatch", reply: "once" })
      await expect(promise).resolves.toBeUndefined()
    },
  })
})

test("ask - explicit ask rule prompts and stays pending", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const promise = PermissionNext.ask({
        id: "permission_explicit",
        sessionID: "ses_test",
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      })
      const pending = await PermissionNext.list()
      expect(pending.map((item) => item.id)).toEqual(["permission_explicit"])

      await PermissionNext.reply({ requestID: "permission_explicit", reply: "once" })
      await expect(promise).resolves.toBeUndefined()
      expect(await PermissionNext.list()).toEqual([])
    },
  })
})

test("ask - throws RejectedError when action is deny", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(
        PermissionNext.ask({
          sessionID: "ses_test",
          permission: "bash",
          patterns: ["rm -rf /"],
          metadata: {},
          ruleset: [{ permission: "bash", pattern: "*", action: "deny" }],
        }),
      ).rejects.toBeInstanceOf(PermissionNext.DeniedError)
    },
  })
})

test("ask - returns pending promise when action is ask", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const promise = PermissionNext.ask({
        id: "permission_pending",
        sessionID: "ses_test",
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      })
      // An explicit ask stays pending: the promise is unsettled and the request is in the pending list
      expect(promise).toBeInstanceOf(Promise)
      expect((await PermissionNext.list()).map((item) => item.id)).toEqual(["permission_pending"])
      await PermissionNext.reply({ requestID: "permission_pending", reply: "once" })
      await promise
    },
  })
})

// reply tests

test("reply - once resolves the pending ask", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ruleset: PermissionNext.Ruleset = [{ permission: "bash", pattern: "*", action: "ask" }]
      const askPromise = PermissionNext.ask({
        id: "permission_test1",
        sessionID: "ses_test",
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        ruleset,
      })

      await PermissionNext.reply({
        requestID: "permission_test1",
        reply: "once",
      })

      await expect(askPromise).resolves.toBeUndefined()
    },
  })
})

test("reply - reject throws RejectedError", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ruleset: PermissionNext.Ruleset = [{ permission: "bash", pattern: "*", action: "ask" }]
      const askPromise = PermissionNext.ask({
        id: "permission_test2",
        sessionID: "ses_test",
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        ruleset,
      })

      await PermissionNext.reply({
        requestID: "permission_test2",
        reply: "reject",
      })

      await expect(askPromise).rejects.toBeInstanceOf(PermissionNext.RejectedError)
    },
  })
})

test("reply - reject with message throws CorrectedError containing user feedback", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ruleset: PermissionNext.Ruleset = [{ permission: "bash", pattern: "*", action: "ask" }]
      const askPromise = PermissionNext.ask({
        id: "permission_feedback",
        sessionID: "ses_test",
        permission: "bash",
        patterns: ["cat package.json"],
        metadata: {},
        ruleset,
      })

      await PermissionNext.reply({
        requestID: "permission_feedback",
        reply: "reject",
        message: "不要使用 cat，改用 read 工具",
      })

      const error = await askPromise.then(
        () => undefined,
        (value: unknown) => value,
      )
      expect(error).toBeInstanceOf(PermissionNext.CorrectedError)
      if (!(error instanceof PermissionNext.CorrectedError)) throw new Error("expected CorrectedError")
      expect(error.message).toContain("不要使用 cat，改用 read 工具")
    },
  })
})

test("reply - reject rejects only the target request and keeps other pending ones", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ruleset: PermissionNext.Ruleset = [{ permission: "subagent", pattern: "*", action: "ask" }]
      const askPromise1 = PermissionNext.ask({
        id: "permission_test4a",
        sessionID: "ses_same",
        permission: "subagent",
        patterns: ["explore"],
        metadata: { description: "t1", subagent_type: "explore" },
        ruleset,
      })

      const askPromise2 = PermissionNext.ask({
        id: "permission_test4b",
        sessionID: "ses_same",
        permission: "subagent",
        patterns: ["explore"],
        metadata: { description: "t2", subagent_type: "explore" },
        ruleset,
      })

      const askPromise3 = PermissionNext.ask({
        id: "permission_test4c",
        sessionID: "ses_same",
        permission: "subagent",
        patterns: ["explore"],
        metadata: { description: "t3", subagent_type: "explore" },
        ruleset,
      })

      const result1 = askPromise1.catch((e) => e)

      await PermissionNext.reply({
        requestID: "permission_test4a",
        reply: "reject",
      })

      expect(await result1).toBeInstanceOf(PermissionNext.RejectedError)
      const pending = await PermissionNext.list()
      expect(pending.map((p) => p.id).sort()).toEqual(["permission_test4b", "permission_test4c"])

      await PermissionNext.reply({ requestID: "permission_test4b", reply: "reject" })
      await PermissionNext.reply({ requestID: "permission_test4c", reply: "reject" })
      await expect(askPromise2).rejects.toBeInstanceOf(PermissionNext.RejectedError)
      await expect(askPromise3).rejects.toBeInstanceOf(PermissionNext.RejectedError)
    },
  })
})

test("reply - with 3 parallel asks, rejecting one still lets the others be allowed once", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const base = {
        sessionID: "ses_parallel",
        permission: "subagent" as const,
        patterns: ["explore"],
        metadata: { description: "t", subagent_type: "explore" },
        ruleset: [{ permission: "subagent", pattern: "*", action: "ask" }] as PermissionNext.Ruleset,
      }

      const p1 = PermissionNext.ask({ ...base, id: "permission_par1" })
      const p2 = PermissionNext.ask({ ...base, id: "permission_par2" })
      const p3 = PermissionNext.ask({ ...base, id: "permission_par3" })

      const r1 = p1.catch((e) => e)

      await PermissionNext.reply({ requestID: "permission_par1", reply: "reject" })
      expect(await r1).toBeInstanceOf(PermissionNext.RejectedError)
      expect((await PermissionNext.list()).length).toBe(2)

      await PermissionNext.reply({ requestID: "permission_par2", reply: "once" })
      await PermissionNext.reply({ requestID: "permission_par3", reply: "once" })
      await expect(p2).resolves.toBeUndefined()
      await expect(p3).resolves.toBeUndefined()
      expect(await PermissionNext.list()).toEqual([])
    },
  })
})

test("ask - checks all patterns and stops on first deny", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(
        PermissionNext.ask({
          sessionID: "ses_test",
          permission: "bash",
          patterns: ["echo hello", "rm -rf /"],
          metadata: {},
          ruleset: [
            { permission: "bash", pattern: "*", action: "allow" },
            { permission: "bash", pattern: "rm *", action: "deny" },
          ],
        }),
      ).rejects.toBeInstanceOf(PermissionNext.DeniedError)
    },
  })
})

test("abortPending - stopping a session rejects its pending permissions and emits permission.replied", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ruleset: PermissionNext.Ruleset = [{ permission: "write", pattern: "*", action: "ask" }]
      const askPromise = PermissionNext.ask({
        id: "permission_abort_me",
        sessionID: "ses_abort",
        permission: "write",
        patterns: ["*"],
        metadata: {},
        ruleset,
      })
      // Pending requests of another session must survive
      const other = PermissionNext.ask({
        id: "permission_keep",
        sessionID: "ses_other",
        permission: "write",
        patterns: ["*"],
        metadata: {},
        ruleset,
      })

      const replied = Promise.withResolvers<{ sessionID: string; requestID: string; reply: string }>()
      const unsub = Bus.subscribe(PermissionNext.Event.Replied, (event) => {
        if (event.properties.requestID === "permission_abort_me") replied.resolve(event.properties)
      })

      await PermissionNext.abortPending("ses_abort")
      const event = await replied.promise
      unsub()

      await expect(askPromise).rejects.toBeInstanceOf(PermissionNext.AbortedError)
      expect(event).toMatchObject({
        sessionID: "ses_abort",
        requestID: "permission_abort_me",
        reply: "reject",
      })
      const pending = await PermissionNext.list()
      expect(pending.map((item) => item.id)).toEqual(["permission_keep"])

      await PermissionNext.reply({ requestID: "permission_keep", reply: "once" })
      await other
    },
  })
})

test("Loop.cancel clears the session's pending permissions so the approval bar goes away", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const askPromise = PermissionNext.ask({
        id: "permission_cancel",
        sessionID: session.id,
        permission: "write",
        patterns: ["*"],
        metadata: {},
        ruleset: [{ permission: "write", pattern: "*", action: "ask" }],
      })

      const replied = Promise.withResolvers<string>()
      const unsub = Bus.subscribe(PermissionNext.Event.Replied, (event) => {
        replied.resolve(event.properties.requestID)
      })
      Loop.cancel(session.id)
      expect(await replied.promise).toBe("permission_cancel")
      unsub()

      await expect(askPromise).rejects.toBeInstanceOf(PermissionNext.AbortedError)
      expect(await PermissionNext.list()).toEqual([])
    },
  })
})

test("ask - allows all patterns when all match allow rules", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await PermissionNext.ask({
        sessionID: "ses_test",
        permission: "bash",
        patterns: ["echo hello", "ls -la", "pwd"],
        metadata: {},
        ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
      })
      expect(result).toBeUndefined()
    },
  })
})
