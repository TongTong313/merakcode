import { describe, expect, test } from "vitest"
import type { Policy } from "../policy"
import { Seatbelt } from "./profile"

const policy: Policy = {
  read: { deny: ["/Users/u/.ssh", "/Users/u/.aws"] },
  write: {
    allow: ["/Users/u/work", "/private/tmp/merak"],
    protect: ["/Users/u/work/.git/hooks", "/Users/u/work/.git/config"],
  },
  network: { allow: [], deny: [], blockPorts: [4096], localPorts: [] },
}

describe("Seatbelt.profile", () => {
  const { profile, params } = Seatbelt.profile(policy)

  test("every path travels as a -D parameter, never inside the profile text", () => {
    expect(params).toEqual([
      "-D",
      "W0=/Users/u/work",
      "-D",
      "W1=/private/tmp/merak",
      "-D",
      "P0=/Users/u/work/.git/hooks",
      "-D",
      "P1=/Users/u/work/.git/config",
      "-D",
      "R0=/Users/u/.ssh",
      "-D",
      "R1=/Users/u/.aws",
      "-D",
      "E0=localhost:4096",
    ])
    expect(profile).not.toContain("/Users/u")
  })

  test("writes outside the allowed folders and the usual devices are denied", () => {
    expect(profile).toContain('(subpath (param "W0"))')
    expect(profile).toContain('(subpath (param "W1"))')
    expect(profile).toContain('(literal "/dev/null")')
    expect(profile).toMatch(/\(deny file-write\* \(require-not \(require-any/)
  })

  test("protected git paths, denied reads and the engine port come after the rules they override", () => {
    const order = [
      "(deny file-write* (require-not",
      '(param "P0")',
      "(deny file-read*",
      "(deny network-outbound)",
      "(allow network-outbound",
      '(remote ip (param "E0"))',
    ]
    const positions = order.map((part) => profile.indexOf(part))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  test("nothing to protect or deny leaves those rules out", () => {
    const bare = Seatbelt.profile({
      ...policy,
      read: { deny: [] },
      write: { allow: ["/w"], protect: [] },
      network: { ...policy.network, blockPorts: [] },
    })
    expect(bare.profile).not.toContain("(deny file-read*")
    expect(bare.profile).not.toContain('(param "P0")')
    expect(bare.profile).not.toContain('(param "E0")')
  })
})

describe("Seatbelt.command", () => {
  test("runs the shell under sandbox-exec with the profile and its parameters", () => {
    expect(
      Seatbelt.command({ profile: "(version 1)", params: ["-D", "W0=/w"], shell: "/bin/zsh", command: "ls -la" }),
    ).toEqual(["/usr/bin/sandbox-exec", "-D", "W0=/w", "-p", "(version 1)", "/bin/zsh", "-c", "ls -la"])
  })
})
