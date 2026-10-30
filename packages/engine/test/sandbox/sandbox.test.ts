import { describe, expect, test } from "vitest"
import path from "path"
import { PermissionExecution } from "@merakcode/engine/agent/permission/execution"
import { PermissionPolicy } from "@merakcode/engine/agent/permission/policy"
import { PermissionNext } from "@merakcode/engine/agent/permission/next"

// What a sandboxed command may do comes from the session: the workspace, temp dir and approved folders are
// writable; credential folders are unreadable; the network goes through the proxy with the allow list and the
// user's domain rules. Approvals and modes are tested in permission/ and tool/bash.

const workspace = [path.resolve("/work/demo")]
const home = path.resolve("/home/dev")
const tmp = path.resolve("/tmp/merakcode")

describe("sandbox policy", () => {
  test("writable: workspace, temp dir, package caches, approved and configured folders; never the home itself", () => {
    const policy = PermissionExecution.policy({
      workspace,
      home,
      tmp,
      writable: [path.join(home, "out")],
      config: { write: { allow: [path.join(home, "builds")] } },
    })
    expect(policy.write.allow).toEqual(
      expect.arrayContaining([
        ...workspace,
        tmp,
        path.join(home, ".npm"),
        path.join(home, ".cache"),
        path.join(home, "out"),
        path.join(home, "builds"),
      ]),
    )
    expect(policy.write.allow).not.toContain(home)
    expect(policy.write.protect).toEqual([
      path.join(workspace[0]!, ".git", "hooks"),
      path.join(workspace[0]!, ".git", "config"),
      path.join(workspace[0]!, "merakcode.json"),
      path.join(workspace[0]!, "merakcode.jsonc"),
      path.join(workspace[0]!, ".merakcode", "merakcode.json"),
      path.join(workspace[0]!, ".merakcode", "merakcode.jsonc"),
    ])
  })

  test("approved sandbox folders (written as dir/*) are writable; command prefixes and later denials are not", () => {
    const dir = (name: string) => PermissionNext.normalizePath(path.join(home, name)) + "/*"
    const ruleset = [
      ...PermissionNext.fromConfig({
        sandbox: { [dir("out")]: "allow", [dir("blocked")]: "allow", "npm publish *": "allow" },
      }),
      ...PermissionNext.fromConfig({ sandbox: { [dir("blocked")]: "deny" } }),
    ]
    const writable = PermissionExecution.policy({ workspace, home, tmp, ruleset }).write.allow
    expect(writable).toContain(path.join(home, "out"))
    expect(writable).not.toContain(path.join(home, "blocked"))
    expect(writable.some((item) => item.includes("npm publish"))).toBe(false)
  })

  test("credential folders and configured folders cannot be read", () => {
    const policy = PermissionExecution.policy({ workspace, home, tmp, config: { read: { deny: ["~/private"] } } })
    for (const dir of PermissionPolicy.SENSITIVE_HOME_DIRS)
      expect(policy.read.deny, dir).toContain(path.join(home, dir))
    expect(policy.read.deny).toContain(path.join(home, "private"))
  })

  test("network: the default allow list plus the user's allowed domains; denied domains are refused", () => {
    const ruleset = PermissionNext.fromConfig({
      network: { "github.com": "deny", "*.example.com": "deny", "exa*mple.org": "deny", "gitee.cn": "allow" },
    })
    const policy = PermissionExecution.policy({ workspace, home, tmp, ruleset })
    expect(policy.network.allow).toEqual(expect.arrayContaining([...PermissionPolicy.NETWORK_ALLOW, "gitee.cn"]))
    expect(policy.network.deny).toEqual(["github.com", "*.example.com"])
  })

  test('network: "deny" refuses every host', () => {
    const ruleset = PermissionNext.fromConfig({ network: "deny" })
    expect(PermissionExecution.policy({ workspace, home, tmp, ruleset }).network.deny).toEqual(["*"])
  })

  test("the engine's own port is never reachable; configured local ports are", () => {
    const policy = PermissionExecution.policy({
      workspace,
      home,
      tmp,
      enginePort: 4096,
      config: { network: { allowLocalPorts: [5432] } },
    })
    expect(policy.network.blockPorts).toEqual([4096])
    expect(policy.network.localPorts).toEqual([5432])
  })
})
