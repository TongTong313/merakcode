import { expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PermissionExecution } from "../../src/agent/permission/execution"
import { Instance } from "../../src/infra/project/instance"
import { tmpdir } from "../fixture/fixture"

test("a backend private temp directory governs both command access and its environment", async () => {
  await using tmp = await tmpdir()
  const privateTemp = path.join(tmp.path, "sandbox-temp")
  await fs.mkdir(privateTemp)
  const previous = process.env.MERAKCODE_SANDBOX_MODE
  process.env.MERAKCODE_SANDBOX_MODE = "preferred"
  PermissionExecution.useBackendForTest({
    status: async () => ({ status: "on", backend: "windows-account" }),
    tmp: () => privateTemp,
    wrap: async (input) => {
      expect(input.env.TMP).toBe(privateTemp)
      expect(input.policy.write.allow).toContain(privateTemp)
      expect(input.policy.write.allow).not.toContain(os.tmpdir())
      return { file: input.shell, args: ["-c", input.command], env: input.env }
    },
  })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const prepared = await PermissionExecution.wrap({
          command: "echo private-temp",
          shell: "/bin/sh",
          cwd: tmp.path,
          env: {},
          ctx: {
            sessionID: "private-temp",
            messageID: "",
            agent: "build",
            permissionLevel: "fullTakeover",
            abort: new AbortController().signal,
            messages: [],
            ruleset: [],
            metadata: () => {},
            ask: async () => {},
          },
          workspace: [tmp.path],
          canIsolate: true,
        })
        expect(prepared).toBeDefined()
        prepared?.finish("", 0)
      },
    })
  } finally {
    PermissionExecution.useBackendForTest(undefined)
    if (previous === undefined) delete process.env.MERAKCODE_SANDBOX_MODE
    else process.env.MERAKCODE_SANDBOX_MODE = previous
  }
})
