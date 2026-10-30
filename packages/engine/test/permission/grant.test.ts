import { expect, test } from "vitest"
import path from "path"
import { PermissionNext } from "@merakcode/engine/agent/permission/next"
import { PermissionPolicy } from "@merakcode/engine/agent/permission/policy"
import { Config } from "@merakcode/engine/app/config/files/config"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Session } from "@merakcode/engine/agent/session/index"
import { tmpdir } from "../fixture/fixture"

// Approval center: the segments of one command share a single approval; "this session" grants are stored on the main
// session and shared with subagents; "always allow" is written to project config. Grants only answer "ask"; they
// cannot override "deny".

const command = (text: string, level: PermissionPolicy.CommandLevel, prefix: string) =>
  PermissionPolicy.command({ command: text, level, prefix })

/** Same as the runner: mode defaults plus the main session's grants (in the user rule layer) */
const chain = async (root: string, mode: PermissionPolicy.Mode = "ask") =>
  PermissionPolicy.ruleset(mode, await PermissionNext.grants(root))

const ask = async (input: {
  id: string
  sessionID: string
  root?: string
  checks: PermissionPolicy.Ask[]
  mode?: PermissionPolicy.Mode
}) => {
  const ruleset = await chain(input.root ?? input.sessionID, input.mode)
  return PermissionNext.ask({
    id: input.id,
    sessionID: input.sessionID,
    root: input.root,
    permission: "bash",
    patterns: input.checks.map((check) => check.pattern),
    checks: input.checks,
    metadata: {},
    ruleset,
  })
}

/** Waits for pending approvals; building the ruleset reads the session, so they do not appear synchronously */
const pending = async (count = 1) => {
  for (let i = 0; i < 100; i++) {
    const list = await PermissionNext.list()
    if (list.length >= count) return list
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return PermissionNext.list()
}

const project = async (fn: (main: Session.Info) => Promise<void>) => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({ directory: tmp.path, fn: async () => fn(await Session.create({})) })
}

test("a multi-segment command shows one approval listing only the segments that need asking", () =>
  project(async (main) => {
    const running = ask({
      id: "permission_multi",
      sessionID: main.id,
      checks: [
        command("git status", "readonly", "git status"),
        command("npm install", "normal", "npm install"),
        command("rm -rf dist", "delete", "rm"),
      ],
    })
    const [request] = await pending()
    expect(request!.patterns).toEqual(["npm install", "rm -rf dist"])
    expect(request!.grants).toEqual([
      { scope: "prefix", pattern: "npm install *" },
      { scope: "prefix", pattern: "rm *" },
    ])
    await PermissionNext.reply({ requestID: "permission_multi", reply: "once" })
    await running
  }))

test("denies the whole command without an approval when any segment is denied", () =>
  project(async (main) => {
    await expect(
      ask({
        id: "permission_denied",
        sessionID: main.id,
        checks: [command("ls", "readonly", "ls"), command("npm test", "normal", "npm test")],
        mode: "readonly",
      }),
    ).rejects.toBeInstanceOf(PermissionNext.DeniedError)
    expect(await PermissionNext.list()).toEqual([])
  }))

test("session prefix grant is stored on the main session, covers subagents and not other sessions", () =>
  project(async (main) => {
    const child = await Session.create({ parentID: main.id })
    const other = await Session.create({})
    const first = ask({
      id: "permission_grant",
      sessionID: main.id,
      checks: [command("npm install lodash", "normal", "npm install")],
    })
    await pending()
    await PermissionNext.reply({ requestID: "permission_grant", reply: "session", scope: "prefix" })
    await first
    expect(await PermissionNext.grants(main.id)).toEqual([
      { permission: "bash", pattern: "npm install *", action: "allow" },
    ])

    await expect(
      ask({
        id: "permission_child",
        sessionID: child.id,
        root: main.id,
        checks: [command("npm install -D vitest", "normal", "npm install")],
      }),
    ).resolves.toBeUndefined()

    const elsewhere = ask({
      id: "permission_other",
      sessionID: other.id,
      checks: [command("npm install lodash", "normal", "npm install")],
    })
    expect((await pending()).map((item) => item.id)).toEqual(["permission_other"])
    await PermissionNext.reply({ requestID: "permission_other", reply: "reject" })
    await expect(elsewhere).rejects.toBeInstanceOf(PermissionNext.RejectedError)
  }))

test("a grant also resolves waiting approvals in the same main session that it covers", () =>
  project(async (main) => {
    const child = await Session.create({ parentID: main.id })
    const a = ask({ id: "permission_a", sessionID: main.id, checks: [command("npm test", "normal", "npm test")] })
    const b = ask({
      id: "permission_b",
      sessionID: child.id,
      root: main.id,
      checks: [command("npm test -- --watch", "normal", "npm test")],
    })
    const c = ask({ id: "permission_c", sessionID: main.id, checks: [command("cargo build", "normal", "cargo build")] })
    await pending(3)
    await PermissionNext.reply({ requestID: "permission_a", reply: "session", scope: "prefix" })
    await a
    await b
    expect((await PermissionNext.list()).map((item) => item.id)).toEqual(["permission_c"])
    await PermissionNext.reply({ requestID: "permission_c", reply: "once" })
    await c
  }))

test("grants cannot override deny: a granted command is still denied in readonly mode", () =>
  project(async (main) => {
    const first = ask({
      id: "permission_then_readonly",
      sessionID: main.id,
      checks: [command("npm test", "normal", "npm test")],
    })
    await pending()
    await PermissionNext.reply({ requestID: "permission_then_readonly", reply: "session" })
    await first
    await expect(
      ask({
        id: "permission_readonly",
        sessionID: main.id,
        checks: [command("npm test", "normal", "npm test")],
        mode: "readonly",
      }),
    ).rejects.toBeInstanceOf(PermissionNext.DeniedError)
  }))

test("file grants cover this file or this directory and ask again after revocation", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const main = await Session.create({})
      const home = path.join(tmp.path, "home")
      const file = (name: string) =>
        PermissionPolicy.file({
          op: "read",
          path: path.join(home, "docs", name),
          workspace: [path.join(tmp.path, "ws")],
          home,
        })
      const read = async (id: string, name: string) =>
        PermissionNext.ask({
          id,
          sessionID: main.id,
          permission: "read",
          patterns: [file(name).pattern],
          checks: [file(name)],
          metadata: {},
          ruleset: await chain(main.id),
        })

      const first = read("permission_dir", "a.md")
      await pending()
      await PermissionNext.reply({ requestID: "permission_dir", reply: "session", scope: "directory" })
      await first
      await expect(read("permission_sibling", "b.md")).resolves.toBeUndefined()

      const [rule] = await PermissionNext.grants(main.id)
      await PermissionNext.revoke(main.id, rule!)
      expect(await PermissionNext.grants(main.id)).toEqual([])
      const again = read("permission_again", "b.md")
      expect((await pending()).map((item) => item.id)).toEqual(["permission_again"])
      await PermissionNext.reply({ requestID: "permission_again", reply: "once" })
      await again
    },
  })
})

test("always allow writes to the permission section of project .merakcode config and applies immediately", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const main = await Session.create({})
      const other = await Session.create({})
      const first = ask({
        id: "permission_always",
        sessionID: main.id,
        checks: [command("pnpm build", "normal", "pnpm build")],
      })
      const [request] = await pending()
      expect(request!.always).toBe(true)
      await PermissionNext.reply({ requestID: "permission_always", reply: "always" })
      await first

      expect(Config.projectMerakCodeFile()).toBe(path.join(tmp.path, ".merakcode", "merakcode.json"))
      const saved = await Config.loadProjectMerakCodeFile()
      expect(saved.permission).toEqual({ bash: { "pnpm build *": "allow" } })
      await expect(
        ask({
          id: "permission_always_again",
          sessionID: other.id,
          checks: [command("pnpm build --watch", "normal", "pnpm build")],
        }),
      ).resolves.toBeUndefined()
    },
  })
})

test("subagent approvals do not offer always allow", () =>
  project(async (main) => {
    const check = PermissionPolicy.subagent("explore")
    const running = PermissionNext.ask({
      id: "permission_subagent",
      sessionID: main.id,
      permission: "subagent",
      patterns: [check.pattern],
      checks: [check],
      metadata: {},
      ruleset: PermissionPolicy.ruleset("ask"),
    })
    const [request] = await pending()
    expect(request!.always).toBe(false)
    await PermissionNext.reply({ requestID: "permission_subagent", reply: "once" })
    await running
  }))
