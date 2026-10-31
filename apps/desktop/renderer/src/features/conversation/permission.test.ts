import { describe, expect, test } from "vitest"
import { permissionChoices, permissionKind, permissionTags } from "./permission"

const command = {
  permission: "bash",
  patterns: ["npm install -D vitest"],
  grants: [{ scope: "prefix" as const, pattern: "npm install *" }],
  always: true,
  metadata: { tags: ["network"] },
}

describe("choices", () => {
  test("command: allow once, allow this prefix for the session, always allow, reject", () => {
    expect(permissionChoices(command).map((choice) => [choice.reply, choice.scope, choice.label])).toEqual([
      ["once", undefined, { key: "permission.option.once" }],
      ["session", "prefix", { key: "permission.option.prefix", vars: { pattern: "npm install" } }],
      ["always", undefined, { key: "permission.option.always" }],
      ["reject", undefined, { key: "permission.option.reject" }],
    ])
  })

  test("file: trust this file or directory for the session, dropping the trailing /* from directories", () => {
    const choices = permissionChoices({
      permission: "read",
      patterns: ["/home/dev/docs/a.md"],
      grants: [
        { scope: "file", pattern: "/home/dev/docs/a.md" },
        { scope: "directory", pattern: "/home/dev/docs/*" },
      ],
      always: true,
    })
    expect(choices.filter((choice) => choice.reply === "session").map((choice) => choice.label)).toEqual([
      { key: "permission.option.file", vars: { pattern: "/home/dev/docs/a.md" } },
      { key: "permission.option.directory", vars: { pattern: "/home/dev/docs" } },
    ])
  })

  test("subagent offers no always-allow; without grants only allow and reject remain", () => {
    const agent = permissionChoices({
      permission: "subagent",
      patterns: ["explore"],
      grants: [{ scope: "agent", pattern: "explore" }],
      always: false,
    })
    expect(agent.map((choice) => choice.reply)).toEqual(["once", "session", "reject"])
    expect(permissionChoices({ permission: "my_tool", patterns: ["*"] }).map((choice) => choice.reply)).toEqual([
      "once",
      "reject",
    ])
  })

  test("choice ids are unique (the UI uses them as keys)", () => {
    const ids = permissionChoices(command).map((choice) => choice.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe("kind and risk", () => {
  test("maps permissions to a kind for the title", () => {
    expect(permissionKind("bash")).toBe("command")
    expect(permissionKind("edit")).toBe("edit")
    expect(permissionKind("read")).toBe("read")
    expect(permissionKind("network")).toBe("network")
    expect(permissionKind("subagent")).toBe("subagent")
    expect(permissionKind("workflow_run")).toBe("workflow")
    expect(permissionKind("mcp")).toBe("mcp")
    expect(permissionKind("my_plugin_tool")).toBe("tool")
  })

  test("keeps only known risk tags, in a fixed order", () => {
    expect(permissionTags({ metadata: { tags: ["network", "bogus", "delete", "external-path"] } })).toEqual([
      "external-path",
      "delete",
      "network",
    ])
    expect(permissionTags({})).toEqual([])
  })

  test("the most serious tags come first; no-sandbox comes last", () => {
    expect(permissionTags({ metadata: { tags: ["no-sandbox", "network", "sensitive-path", "forbidden"] } })).toEqual([
      "forbidden",
      "sensitive-path",
      "network",
      "no-sandbox",
    ])
  })
})
