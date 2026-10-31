import { afterEach, expect, test, type Mock, vi } from "vitest"
import { Bus } from "@merakcode/engine/infra/bus/index"
import { PermissionNext } from "@merakcode/engine/agent/permission/next"
import { Plugin } from "@merakcode/engine/agent/plugin/index"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { tmpdir } from "../fixture/fixture"

/**
 * The `permission.ask` plugin hook may override a decision only when the rules say ask; config-level allow/deny is
 * not affected. Plugin.trigger is replaced with a spy to avoid wiring a real plugin chain; the subject is how
 * PermissionNext.ask handles the hook result.
 */

let spy: Mock<typeof Plugin.trigger> | undefined
afterEach(() => {
  spy?.mockRestore()
  spy = undefined
})

function stub(status: "ask" | "allow" | "deny", seen: string[] = []) {
  spy?.mockRestore()
  spy = vi.spyOn(Plugin, "trigger").mockImplementation((async (name: string, input: unknown, output: unknown) => {
    if (name === "permission.ask") {
      seen.push((input as { permission: string }).permission)
      ;(output as { status: string }).status = status
    }
    return output
  }) as typeof Plugin.trigger)
  return seen
}

const base = {
  sessionID: "session_plugin_ask",
  permission: "bash",
  patterns: ["ls"],
  metadata: {},
  // An explicit ask rule, so the hook fires whatever the default rules are
  ruleset: [{ permission: "bash", pattern: "*", action: "ask" }] as PermissionNext.Ruleset,
}

test("hook returning allow resolves the ask without emitting permission.asked", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const seen = stub("allow")
      let asked = 0
      const unsub = Bus.subscribe(PermissionNext.Event.Asked, () => asked++)
      await expect(PermissionNext.ask({ ...base, id: "permission_plugin_allow" })).resolves.toBeUndefined()
      unsub()
      expect(seen).toEqual(["bash"])
      expect(asked).toBe(0)
      expect(await PermissionNext.list()).toEqual([])
    },
  })
})

test("hook returning deny throws DeniedError and leaves nothing pending", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      stub("deny")
      await expect(PermissionNext.ask({ ...base, id: "permission_plugin_deny" })).rejects.toBeInstanceOf(
        PermissionNext.DeniedError,
      )
      expect(await PermissionNext.list()).toEqual([])
    },
  })
})

test("hook that does not override emits permission.asked and waits for a reply", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      stub("ask")
      const asked = Promise.withResolvers<string>()
      const unsub = Bus.subscribe(PermissionNext.Event.Asked, (e) => asked.resolve(e.properties.id))
      const pending = PermissionNext.ask({ ...base, id: "permission_plugin_ask" })
      expect(await asked.promise).toBe("permission_plugin_ask")
      unsub()
      await PermissionNext.reply({ requestID: "permission_plugin_ask", reply: "once" })
      await expect(pending).resolves.toBeUndefined()
    },
  })
})

test("config-level allow or deny skips the hook so plugins cannot override user config", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const seen = stub("deny")
      await expect(
        PermissionNext.ask({ ...base, ruleset: [{ permission: "bash", pattern: "*", action: "allow" }] }),
      ).resolves.toBeUndefined()
      stub("allow", seen)
      await expect(
        PermissionNext.ask({ ...base, ruleset: [{ permission: "bash", pattern: "*", action: "deny" }] }),
      ).rejects.toBeInstanceOf(PermissionNext.DeniedError)
      expect(seen).toEqual([])
    },
  })
})

test("a reply received while the hook runs is neither lost nor registered twice", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const gate = Promise.withResolvers<void>()
      spy = vi.spyOn(Plugin, "trigger").mockImplementation((async (name: string, _input: unknown, output: unknown) => {
        if (name === "permission.ask") await gate.promise
        return output
      }) as typeof Plugin.trigger)
      const pending = PermissionNext.ask({ ...base, id: "permission_plugin_race" })
      // The request is registered as pending before the hook runs, so the reply finds it
      await PermissionNext.reply({ requestID: "permission_plugin_race", reply: "once" })
      gate.resolve()
      await expect(pending).resolves.toBeUndefined()
      expect(await PermissionNext.list()).toEqual([])
    },
  })
})
