import { describe, expect, test } from "vitest"
import path from "node:path"
import { prepareBashCommand } from "@merakcode/engine/tool/bash"
import { PermissionNext } from "@merakcode/engine/permission/next"
import { Identifier } from "@merakcode/util/id"
import { Bus } from "@merakcode/engine/bus/index"
import { Instance } from "@merakcode/engine/project/instance"
import type { Tool } from "@merakcode/engine/tool/tool"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

const shellPath = (value: string) => value.replace(/\\/g, "/")

/** The fallback no longer asks; only explicit ask rules do, so the fixture adds one for bash to expose its patterns */
const ASK_BASH = PermissionNext.fromConfig({ bash: "ask" })

async function fixture(
  run: (input: {
    directory: string
    outside: string
    target: string
    prepare: (command: string, ruleset?: PermissionNext.Ruleset) => Promise<void>
    asked: PermissionNext.Request[]
  }) => Promise<void>,
) {
  await using outer = await tmpdir()
  await using project = await tmpdir({ git: true })
  const outside = path.join(outer.path, "outside folder")
  const target = path.join(outside, "file with spaces.txt")
  await Filesystem.write(target, "unchanged fixture")
  await Instance.provide({
    directory: project.path,
    fn: async () => {
      const sessionID = Identifier.ascending("session")
      const asked: PermissionNext.Request[] = []
      const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, (event) => {
        asked.push(event.properties)
        void PermissionNext.reply({ requestID: event.properties.id, reply: "once" })
      })
      try {
        await run({
          directory: project.path,
          outside,
          target,
          asked,
          prepare: async (command, ruleset = ASK_BASH) => {
            const context: Tool.Context = {
              sessionID,
              messageID: "message",
              agent: "build",
              permissionMode: "ask",
              abort: new AbortController().signal,
              messages: [],
              ruleset,
              metadata: () => {},
              ask: (request) => PermissionNext.ask({ ...request, sessionID, ruleset }),
            }
            await prepareBashCommand({ command, description: "Check quoted paths" }, context)
          },
        })
      } finally {
        unsubscribe()
        await Instance.dispose()
      }
    },
  })
}

/**
 * Quoted paths outside the workspace only affect static parsing; they never raise external_directory requests, even
 * when the ruleset has explicit deny or ask rules for it.
 */
describe("prepareBashCommand static shell paths", () => {
  test("a quoted outside path does not raise external_directory, even with an explicit deny rule", async () => {
    await fixture(async ({ target, prepare, asked }) => {
      await prepare(`cat '${shellPath(target)}'`, [{ permission: "external_directory", pattern: "*", action: "deny" }])
      expect(asked.filter((request) => request.permission === "external_directory")).toEqual([])
    })
  })

  const forms: Array<[string, (target: string) => string]> = [
    ["single quotes", (target) => `'${shellPath(target)}'`],
    ["double quotes", (target) => `"${shellPath(target)}"`],
    ["escaped spaces", (target) => shellPath(target).replaceAll(" ", "\\ ")],
    [
      "adjacent quoted segments",
      (target) => `'${shellPath(path.dirname(path.dirname(target)))}/'"outside folder/"'file with spaces.txt'`,
    ],
  ]
  for (const [name, argument] of forms) {
    test(`asks for bash with ${name} and never for external_directory`, async () => {
      await fixture(async ({ target, prepare, asked }) => {
        const command = `cat ${argument(target)}`
        await prepare(command)
        expect(asked.find((request) => request.permission === "bash")?.patterns).toContain(command)
        expect(asked.filter((request) => request.permission === "external_directory")).toEqual([])
      })
    })
  }

  for (const operator of [">", ">>", "2>", "<"]) {
    test(`checks a quoted ${operator} redirection target without executing the command`, async () => {
      await fixture(async ({ target, prepare, asked }) => {
        const command = `${operator === "<" ? "cat" : "printf changed"} ${operator} '${shellPath(target)}'`
        await prepare(command)
        expect(asked.find((request) => request.permission === "bash")?.patterns).toContain(command)
        expect(asked.filter((request) => request.permission === "external_directory")).toEqual([])
        expect(await Filesystem.readText(target)).toBe("unchanged fixture")
      })
    })
  }

  for (const quote of ["single", "escaped double"]) {
    test(`treats dollar substitutions and backticks as literal path text in ${quote} quotes`, async () => {
      await fixture(async ({ directory, prepare, asked }) => {
        const literal = path.join(directory, "literal $(touch injected-dollar) `touch injected-backtick`.txt")
        await Filesystem.write(literal, "literal fixture")
        const argument =
          quote === "single" ? `'${shellPath(literal)}'` : `"${shellPath(literal).replace(/([$`"\\])/g, "\\$1")}"`
        const command = `cat ${argument}`
        await prepare(command)
        expect(asked.find((request) => request.permission === "bash")?.patterns).toContain(command)
        expect(asked.filter((request) => request.permission === "external_directory")).toEqual([])
        expect(await Filesystem.isFile(path.join(directory, "injected-dollar"))).toBe(false)
        expect(await Filesystem.isFile(path.join(directory, "injected-backtick"))).toBe(false)
        expect(await Filesystem.readText(literal)).toBe("literal fixture")
      })
    })
  }

  test("leaves dynamic substitutions for bash approval without evaluating them during preparation", async () => {
    await fixture(async ({ directory, prepare, asked }) => {
      const command = 'cat "$(touch injected-dynamic)" "`touch injected-dynamic-backtick`"'
      await prepare(command)
      expect(asked.find((request) => request.permission === "bash")?.patterns).toContain(command)
      expect(await Filesystem.isFile(path.join(directory, "injected-dynamic"))).toBe(false)
      expect(await Filesystem.isFile(path.join(directory, "injected-dynamic-backtick"))).toBe(false)
    })
  })

  for (const argument of ["'~/file.txt'", '"~/file.txt"', "\\~/file.txt", "'~'/file.txt"]) {
    test(`keeps the quoted or escaped tilde in ${argument} relative to the project`, async () => {
      await fixture(async ({ directory, prepare, asked }) => {
        await Filesystem.write(path.join(directory, "~", "file.txt"), "literal tilde fixture")
        const command = `cat ${argument}`
        await prepare(command)
        expect(asked.find((request) => request.permission === "bash")?.patterns).toContain(command)
        expect(asked.filter((request) => request.permission === "external_directory")).toEqual([])
      })
    })
  }

  test("an unquoted leading tilde no longer raises external_directory either", async () => {
    await fixture(async ({ prepare, asked }) => {
      const command = "cat ~/quoted-path-fixture.txt"
      await prepare(command)
      expect(asked.find((request) => request.permission === "bash")?.patterns).toContain(command)
      expect(asked.filter((request) => request.permission === "external_directory")).toEqual([])
    })
  })
})
