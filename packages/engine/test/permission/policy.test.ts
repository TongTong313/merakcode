import { describe, expect, test } from "vitest"
import path from "path"
import { Global } from "@merakcode/engine/infra/global/index"
import { PermissionNext } from "@merakcode/engine/agent/permission/next"
import { PermissionPolicy } from "@merakcode/engine/agent/permission/policy"

// Default decisions for each kind of operation in the three modes. User rules come after the mode defaults and can
// override them; read-only mode denials come after user rules and cannot be overridden.

const root = path.resolve("/work/demo")
const home = path.resolve("/home/dev")
const at = (...parts: string[]) => path.join(root, ...parts)
const ctx = { workspace: [root], home }

const decide = (mode: PermissionPolicy.Mode, ask: PermissionPolicy.Ask, user: PermissionNext.Ruleset = []) =>
  PermissionNext.evaluate(ask.permission, ask.pattern, PermissionPolicy.ruleset(mode, user)).action

describe("file operation classification", () => {
  test("read: inside workspace, outside workspace, sensitive files", () => {
    expect(PermissionPolicy.file({ ...ctx, op: "read", path: at("src/a.ts") }).permission).toBe("read")
    expect(PermissionPolicy.file({ ...ctx, op: "read", path: path.join(home, "notes.md") }).permission).toBe(
      "external_read",
    )
    for (const sensitive of [
      at(".env"),
      at("config/.env.local"),
      path.join(home, ".ssh", "id_ed25519"),
      at("cert.pem"),
    ])
      expect(PermissionPolicy.file({ ...ctx, op: "read", path: sensitive }).permission, sensitive).toBe(
        "sensitive_read",
      )
    expect(PermissionPolicy.file({ ...ctx, op: "read", path: at(".env.example") }).permission).toBe("read")
  })

  test("write: inside workspace, .git and dotfiles, outside workspace", () => {
    expect(PermissionPolicy.file({ ...ctx, op: "write", path: at("src/a.ts") }).permission).toBe("edit")
    expect(PermissionPolicy.file({ ...ctx, op: "write", path: at(".git", "config") }).permission).toBe(
      "protected_write",
    )
    expect(PermissionPolicy.file({ ...ctx, op: "write", path: at(".gitignore") }).permission).toBe("protected_write")
    expect(PermissionPolicy.file({ ...ctx, op: "write", path: path.join(home, ".npmrc") }).permission).toBe(
      "external_write",
    )
  })

  test("write: MerakCode's config files, global or a project's, are config_write", () => {
    for (const file of [
      at("merakcode.json"),
      at("merakcode.jsonc"),
      at(".merakcode", "merakcode.json"),
      path.join(home, ".merakcode", "merakcode.jsonc"),
    ])
      expect(PermissionPolicy.file({ ...ctx, op: "write", path: file }).permission, file).toBe("config_write")
    expect(PermissionPolicy.file({ ...ctx, op: "write", path: at(".merakcode", "agent", "a.md") }).permission).toBe(
      "protected_write",
    )
  })

  test("config writes retain execute approval and are allowed in auto", () => {
    const config = PermissionPolicy.file({ ...ctx, op: "write", path: at(".merakcode", "merakcode.json") })
    expect(decide("ask", config)).toBe("ask")
    expect(decide("autoApprove", config)).toBe("ask")
    expect(decide("fullTakeover", config)).toBe("allow")
    expect(
      decide("fullTakeover", PermissionPolicy.file({ ...ctx, op: "write", path: at(".git", "hooks", "pre-commit") })),
    ).toBe("allow")
  })

  test("MerakCode's store of provider keys is a sensitive file", () => {
    const auth = path.join(Global.Path.data, "auth.json")
    expect(PermissionPolicy.file({ ...ctx, op: "read", path: auth }).permission).toBe("sensitive_read")
  })

  test("offers grant scopes: trust this file or this directory for the session", () => {
    const ask = PermissionPolicy.file({ ...ctx, op: "read", path: path.join(home, "docs", "a.md") })
    expect(ask.grants.map((grant) => grant.scope)).toEqual(["file", "directory"])
    expect(ask.grants[1]!.pattern).toBe(PermissionNext.normalizePath(path.join(home, "docs")) + "/*")
  })
})

describe("default decisions in the three modes", () => {
  const read = PermissionPolicy.file({ ...ctx, op: "read", path: at("a.ts") })
  const external = PermissionPolicy.file({ ...ctx, op: "read", path: path.join(home, "a.md") })
  const sensitive = PermissionPolicy.file({ ...ctx, op: "read", path: at(".env") })
  const edit = PermissionPolicy.file({ ...ctx, op: "write", path: at("a.ts") })
  const dotfile = PermissionPolicy.file({ ...ctx, op: "write", path: at(".gitignore") })
  const outside = PermissionPolicy.file({ ...ctx, op: "write", path: path.join(home, "a.md") })
  const ls = PermissionPolicy.command({ command: "ls -la", level: "readonly", prefix: "ls" })
  const npmTest = PermissionPolicy.command({ command: "npm test", level: "normal", prefix: "npm test" })
  const remove = PermissionPolicy.command({ command: "rm -rf dist", level: "delete", prefix: "rm" })
  const push = PermissionPolicy.command({ command: "git push", level: "risky", prefix: "git push" })
  const agent = PermissionPolicy.subagent("explore")
  const mcp = PermissionPolicy.mcp("github", "create_issue")
  const network = PermissionPolicy.network("example.com")
  const npm = PermissionPolicy.network("registry.npmjs.org")

  test.each([
    [
      "ask",
      [
        [read, "ask"],
        [external, "ask"],
        [sensitive, "ask"],
        [edit, "ask"],
        [dotfile, "ask"],
        [outside, "ask"],
      ],
    ],
    [
      "autoApprove",
      [
        [read, "allow"],
        [external, "ask"],
        [sensitive, "ask"],
        [edit, "allow"],
        [dotfile, "ask"],
        [outside, "ask"],
      ],
    ],
    [
      "fullTakeover",
      [
        [read, "allow"],
        [external, "allow"],
        [sensitive, "allow"],
        [edit, "allow"],
        [dotfile, "allow"],
        [outside, "allow"],
      ],
    ],
  ] as const)("%s: files", (mode, cases) => {
    for (const [ask, action] of cases) expect(decide(mode, ask), `${mode} ${ask.permission}`).toBe(action)
  })

  test.each([
    [
      "ask",
      [
        [ls, "ask"],
        [npmTest, "ask"],
        [remove, "ask"],
        [push, "ask"],
      ],
    ],
    [
      "autoApprove",
      [
        [ls, "allow"],
        [npmTest, "ask"],
        [remove, "ask"],
        [push, "ask"],
      ],
    ],
    [
      "fullTakeover",
      [
        [ls, "allow"],
        [npmTest, "allow"],
        [remove, "allow"],
        [push, "allow"],
      ],
    ],
  ] as const)("%s: commands", (mode, cases) => {
    for (const [ask, action] of cases) expect(decide(mode, ask), `${mode} ${ask.pattern}`).toBe(action)
  })

  test.each([
    [
      "ask",
      [
        [agent, "ask"],
        [mcp, "ask"],
        [network, "ask"],
        [npm, "ask"],
      ],
    ],
    [
      "autoApprove",
      [
        [agent, "ask"],
        [mcp, "ask"],
        [network, "ask"],
        [npm, "ask"],
      ],
    ],
    [
      "fullTakeover",
      [
        [agent, "allow"],
        [mcp, "allow"],
        [network, "allow"],
        [npm, "allow"],
      ],
    ],
  ] as const)("%s: subagents, MCP, network", (mode, cases) => {
    for (const [ask, action] of cases) expect(decide(mode, ask), `${mode} ${ask.permission}`).toBe(action)
  })

  test("unregistered (plugin) tools ask in readonly and ask modes and are allowed in auto mode", () => {
    const plugin = { permission: "my_plugin_tool", pattern: "*", grants: [] }
    expect(decide("ask", plugin)).toBe("ask")
    expect(decide("autoApprove", plugin)).toBe("ask")
    expect(decide("fullTakeover", plugin)).toBe("allow")
  })
})

describe("precedence of user rules and modes", () => {
  test("legacy allows cannot approve a risky command and explicit denies still apply", () => {
    const npmTest = PermissionPolicy.command({ command: "npm test", level: "normal", prefix: "npm test" })
    const user = PermissionNext.fromConfig({ bash: { "npm test*": "allow" }, edit: { "*.lock": "deny" } })
    expect(decide("autoApprove", npmTest, user)).toBe("ask")
    expect(decide("autoApprove", PermissionPolicy.file({ ...ctx, op: "write", path: at("pnpm.lock") }), user)).toBe(
      "deny",
    )
  })

  test("ask still requests approval for commands and files covered by legacy allows", () => {
    const npmTest = PermissionPolicy.command({ command: "npm test", level: "normal", prefix: "npm test" })
    const user = PermissionNext.fromConfig({ bash: { "npm test*": "allow" }, edit: "allow" })
    expect(decide("ask", npmTest, user)).toBe("ask")
    expect(decide("ask", PermissionPolicy.file({ ...ctx, op: "write", path: at("a.ts") }), user)).toBe("ask")
  })

  test("auto mode allows risky operations without grants", () => {
    const push = PermissionPolicy.command({ command: "git push origin main", level: "risky", prefix: "git push" })
    expect(decide("fullTakeover", push)).toBe("allow")
    expect(decide("fullTakeover", push, PermissionNext.fromConfig({ bash_risky: { "git push*": "allow" } }))).toBe(
      "allow",
    )
  })
})
