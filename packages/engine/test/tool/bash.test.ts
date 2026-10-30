import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { mkdir, mkdtemp, rm } from "fs/promises"
import os from "os"
import path from "path"
import { BashTool, prepareBashCommand } from "@merakcode/engine/agent/tools/bash"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Config } from "@merakcode/engine/app/config/files/config"
import { tmpdir } from "../fixture/fixture"
import { PermissionNext } from "@merakcode/engine/agent/permission/next"
import { PermissionPolicy } from "@merakcode/engine/agent/permission/policy"
import type { Tool } from "@merakcode/engine/agent/tools/tool"
import { Bus } from "@merakcode/engine/infra/bus/index"
import { Truncate } from "@merakcode/engine/agent/tools/truncation"
import { clearSessionDeltaCache } from "@merakcode/engine/agent/tools/bash-output-compaction/index"
import { Filesystem } from "@merakcode/util/filesystem"

const ctx = {
  sessionID: "ses_bash_test",
  messageID: "",
  callID: "",
  agent: "build",
  kind: "ask" as const,
  abort: AbortSignal.any([]),
  messages: [],
  ruleset: [],
  metadata: () => {},
  ask: async () => {},
}

type AskRequest = Parameters<Tool.Context["ask"]>[0]

/**
 * ctx.ask wired to the real permission center like the runner (ask-mode ruleset by default). It records every
 * permission.asked request and replies "once" right away, so tests can assert which approvals were shown.
 */
function permissionCtx(input: { ruleset?: PermissionNext.Ruleset; sessionID?: string } = {}) {
  const requests: PermissionNext.Request[] = []
  const sessionID = input.sessionID ?? ctx.sessionID
  const ruleset = input.ruleset ?? PermissionPolicy.ruleset("ask")
  const ask = async (req: AskRequest) => {
    const asked = Promise.withResolvers<PermissionNext.Request>()
    const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, (event) => {
      if (event.properties.sessionID !== sessionID) return
      asked.resolve(event.properties)
      void PermissionNext.reply({ requestID: event.properties.id, reply: "once" })
    })
    const running = PermissionNext.ask({ ...req, sessionID, ruleset })
    const winner = await Promise.race([
      asked.promise.then((request) => ({ request })),
      running.then(() => undefined),
    ]).finally(unsubscribe)
    if (winner) requests.push(winner.request)
    await running
  }
  return { ctx: { ...ctx, sessionID, ruleset, ask }, requests }
}

const projectRoot = path.join(__dirname, "../..")
const shellPath = (p: string) => (process.platform === "win32" ? p.replace(/\\/g, "/") : p)
const previousConfigDir = process.env.MERAKCODE_CONFIG_DIR
let testConfigDir: string | undefined

beforeAll(async () => {
  testConfigDir = await mkdtemp(path.join(os.tmpdir(), "merakcode-test-config-"))
  await Filesystem.write(path.join(testConfigDir, "merakcode.json"), JSON.stringify({}))
  process.env.MERAKCODE_CONFIG_DIR = testConfigDir
  Config.global.reset()
})

afterAll(async () => {
  if (previousConfigDir === undefined) delete process.env.MERAKCODE_CONFIG_DIR
  else process.env.MERAKCODE_CONFIG_DIR = previousConfigDir
  Config.global.reset()
  if (testConfigDir) await rm(testConfigDir, { recursive: true, force: true }).catch(() => undefined)
})

describe("tool.bash", () => {
  test("basic", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await BashTool.init()
        const result = await bash.execute(
          {
            command: "echo 'test'",
            description: "Echo test message",
          },
          ctx,
        )
        expect(result.metadata.exit).toBe(0)
        expect(result.metadata.output).toContain("test")
      },
    })
  })

  test("commands never see the engine password or inline config", async () => {
    const saved = { password: process.env.MERAKCODE_SERVER_PASSWORD, config: process.env.MERAKCODE_CONFIG_CONTENT }
    process.env.MERAKCODE_SERVER_PASSWORD = "leak-check"
    process.env.MERAKCODE_CONFIG_CONTENT = "{}"
    try {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const bash = await BashTool.init()
          const result = await bash.execute(
            {
              command: `node -e "process.stdout.write([process.env.MERAKCODE_SERVER_PASSWORD, process.env.MERAKCODE_CONFIG_CONTENT].join(','))"`,
              description: "Print engine variables",
            },
            ctx,
          )
          expect(result.metadata.exit).toBe(0)
          expect(result.metadata.output).not.toContain("leak-check")
          expect(result.metadata.output).toContain(",")
          expect(result.metadata.output).not.toContain("{}")
        },
      })
    } finally {
      for (const [key, value] of [
        ["MERAKCODE_SERVER_PASSWORD", saved.password],
        ["MERAKCODE_CONFIG_CONTENT", saved.config],
      ] as const)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    }
  })

  test("reading credentials asks even in auto mode; reading workspace files does not", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await BashTool.init()
        const auto = permissionCtx({ ruleset: PermissionPolicy.ruleset("auto"), sessionID: "ses_bash_sensitive" })
        await bash.execute({ command: "cat package.json", description: "Read a workspace file" }, auto.ctx)
        expect(auto.requests).toHaveLength(0)
        await bash
          .execute({ command: "cat ~/.ssh/merak-test-key", description: "Read a key" }, auto.ctx)
          .catch(() => undefined)
        expect(auto.requests).toHaveLength(1)
        expect(auto.requests[0]!.metadata.tags).toContain("sensitive-path")
      },
    })
  })

  test("secrets in the output are hidden from the model", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await BashTool.init()
        const result = await bash.execute(
          { command: `node -e "console.log('API_KEY=abc123')"`, description: "Print a key" },
          ctx,
        )
        expect(result.output).toContain("API_KEY=<redacted>")
        expect(result.output).not.toContain("abc123")
      },
    })
  })

  test("commands that wipe the system are refused without asking, in every mode", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await BashTool.init()
        for (const mode of ["ask", "auto"] as const) {
          const asked = permissionCtx({
            ruleset: PermissionPolicy.ruleset(mode),
            sessionID: `ses_bash_forbidden_${mode}`,
          })
          const error = await bash.execute({ command: "rm -rf /", description: "Wipe" }, asked.ctx).then(
            () => undefined,
            (error: unknown) => error,
          )
          expect(error instanceof PermissionNext.DeniedError, mode).toBe(true)
          expect(asked.requests).toHaveLength(0)
        }
      },
    })
  })

  test("strips terminal color codes from output for both the model and the UI", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await BashTool.init()
        const result = await bash.execute(
          {
            command: `node -e "process.stdout.write('\\x1b[33m42\\x1b[39m\\n')"`,
            description: "Print colored output",
          },
          ctx,
        )
        expect(result.output).toContain("42")
        expect(result.output).not.toContain("\x1b")
        expect(result.metadata.output).not.toContain("\x1b")
      },
    })
  })

  test("compacts output when experimental compaction is enabled", async () => {
    const prevEnabled = process.env.MERAKCODE_EXPERIMENTAL_BASH_OUTPUT_COMPACTION
    const prevMin = process.env.MERAKCODE_EXPERIMENTAL_BASH_OUTPUT_COMPACTION_MIN_BYTES
    process.env.MERAKCODE_EXPERIMENTAL_BASH_OUTPUT_COMPACTION = "1"
    process.env.MERAKCODE_EXPERIMENTAL_BASH_OUTPUT_COMPACTION_MIN_BYTES = "1"
    clearSessionDeltaCache()

    try {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const bash = await BashTool.init()
          const result = await bash.execute(
            {
              command: 'for i in $(seq 1 80); do echo "ERROR 2026-01-01T00:00:00 failed request id $i"; done',
              description: "Emit repeated error logs",
            },
            ctx,
          )

          expect((result.metadata as any).compacted).toBe(true)
          expect((result.metadata as any).truncated).toBe(false)
          expect((result.metadata as any).compactionFilter).toBe("logs")
          expect(result.output).toContain("[output compacted: logs")
          expect(result.output).toContain("[full output saved:")
          const rawOutputPath = (result.metadata as any).rawOutputPath
          expect(typeof rawOutputPath).toBe("string")
          expect(await Filesystem.readText(rawOutputPath)).toContain("failed request id 80")
        },
      })
    } finally {
      if (prevEnabled === undefined) delete process.env.MERAKCODE_EXPERIMENTAL_BASH_OUTPUT_COMPACTION
      else process.env.MERAKCODE_EXPERIMENTAL_BASH_OUTPUT_COMPACTION = prevEnabled
      if (prevMin === undefined) delete process.env.MERAKCODE_EXPERIMENTAL_BASH_OUTPUT_COMPACTION_MIN_BYTES
      else process.env.MERAKCODE_EXPERIMENTAL_BASH_OUTPUT_COMPACTION_MIN_BYTES = prevMin
      clearSessionDeltaCache()
    }
  })

  test("compacts output when enabled through project config", async () => {
    const prevEnabled = process.env.MERAKCODE_EXPERIMENTAL_BASH_OUTPUT_COMPACTION
    const prevMin = process.env.MERAKCODE_EXPERIMENTAL_BASH_OUTPUT_COMPACTION_MIN_BYTES
    delete process.env.MERAKCODE_EXPERIMENTAL_BASH_OUTPUT_COMPACTION
    delete process.env.MERAKCODE_EXPERIMENTAL_BASH_OUTPUT_COMPACTION_MIN_BYTES
    clearSessionDeltaCache()

    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const configDir = path.join(dir, ".merakcode")
          await mkdir(configDir, { recursive: true })
          await Filesystem.write(
            path.join(configDir, "merakcode.jsonc"),
            JSON.stringify({
              experimental: {
                bash_output_compaction: {
                  enabled: true,
                  min_bytes: 1,
                },
              },
            }),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const bash = await BashTool.init()
          const result = await bash.execute(
            {
              command: 'for i in $(seq 1 80); do echo "ERROR 2026-01-01T00:00:00 failed request id $i"; done',
              description: "Emit repeated error logs",
            },
            ctx,
          )

          expect((result.metadata as any).compacted).toBe(true)
          expect((result.metadata as any).compactionFilter).toBe("logs")
          expect(result.output).toContain("[output compacted: logs")
        },
      })
    } finally {
      if (prevEnabled === undefined) delete process.env.MERAKCODE_EXPERIMENTAL_BASH_OUTPUT_COMPACTION
      else process.env.MERAKCODE_EXPERIMENTAL_BASH_OUTPUT_COMPACTION = prevEnabled
      if (prevMin === undefined) delete process.env.MERAKCODE_EXPERIMENTAL_BASH_OUTPUT_COMPACTION_MIN_BYTES
      else process.env.MERAKCODE_EXPERIMENTAL_BASH_OUTPUT_COMPACTION_MIN_BYTES = prevMin
      clearSessionDeltaCache()
    }
  })
})

describe("tool.bash permissions", () => {
  test("ask mode runs read-only commands without asking", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await BashTool.init()
        const { ctx: testCtx, requests } = permissionCtx()
        const result = await bash.execute({ command: "echo no-card && git status -s", description: "Echo" }, testCtx)
        expect(requests).toEqual([])
        expect(result.metadata.exit).toBe(0)
        expect(result.metadata.output).toContain("no-card")
      },
    })
  })

  test("ask mode asks for other commands with the raw command, a prefix grant and the working directory", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await BashTool.init()
        const { ctx: testCtx, requests } = permissionCtx()
        await bash.execute({ command: "node -e 1", description: "Run node" }, testCtx)
        expect(requests).toHaveLength(1)
        expect(requests[0]).toMatchObject({
          permission: "bash",
          patterns: ["node -e 1"],
          grants: [{ scope: "prefix", pattern: "node *" }],
          always: true,
          metadata: { command: "node -e 1", cwd: tmp.path, tags: [] },
        })
      },
    })
  })

  test("chained commands produce one approval listing only the segments that ask, with their redirects", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { ctx: testCtx, requests } = permissionCtx()
        await prepareBashCommand({ command: "ls && rm -rf build && echo hi > out.txt", description: "x" }, testCtx)
        expect(requests).toHaveLength(1)
        expect(requests[0]!.patterns).toEqual(["rm -rf build", "echo hi > out.txt"])
        expect(requests[0]!.metadata.tags).toEqual(["delete"])
      },
    })
  })

  test("cd alone does not ask", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { ctx: testCtx, requests } = permissionCtx()
        await prepareBashCommand({ command: "cd ../", description: "x" }, testCtx)
        expect(requests).toEqual([])
      },
    })
  })

  test("read-only mode runs read-only commands and denies the rest", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { ctx: testCtx, requests } = permissionCtx({ ruleset: PermissionPolicy.ruleset("readonly") })
        await prepareBashCommand({ command: "ls -la && git log -1", description: "x" }, testCtx)
        await expect(
          prepareBashCommand({ command: "ls && npm test", description: "x" }, testCtx),
        ).rejects.toBeInstanceOf(PermissionNext.DeniedError)
        expect(requests).toEqual([])
      },
    })
  })

  test("auto mode asks only for high-risk commands like push, publish and sudo, not for deletes", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { ctx: testCtx, requests } = permissionCtx({ ruleset: PermissionPolicy.ruleset("auto") })
        await prepareBashCommand({ command: "npm test && rm -rf dist", description: "x" }, testCtx)
        expect(requests).toEqual([])
        await prepareBashCommand({ command: "npm test && git push origin main", description: "x" }, testCtx)
        expect(requests).toHaveLength(1)
        expect(requests[0]!.patterns).toEqual(["git push origin main"])
        expect(requests[0]!.metadata.tags).toEqual(expect.arrayContaining(["network", "publish"]))
      },
    })
  })

  test("paths outside the workspace are tagged on the approval and the command still runs", async () => {
    await using outer = await tmpdir()
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await BashTool.init()
        const file = path.join(outer.path, "out.txt")
        const { ctx: testCtx, requests } = permissionCtx()
        const result = await bash.execute({ command: `echo secret > ${shellPath(file)}`, description: "x" }, testCtx)
        expect(result.metadata.exit).toBe(0)
        expect(await Filesystem.readText(file)).toContain("secret")
        expect(requests).toHaveLength(1)
        expect(requests[0]!.metadata.tags).toEqual(["external-path"])
      },
    })
  })

  test("user command rules: allowed prefixes do not ask and denied ones are refused", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const user = PermissionNext.fromConfig({ bash: { "node *": "allow", "curl *": "deny" } })
        const { ctx: testCtx, requests } = permissionCtx({ ruleset: PermissionPolicy.ruleset("ask", user) })
        await prepareBashCommand({ command: "node -e 1", description: "x" }, testCtx)
        expect(requests).toEqual([])
        await expect(
          prepareBashCommand({ command: "curl https://example.com", description: "x" }, testCtx),
        ).rejects.toBeInstanceOf(PermissionNext.DeniedError)
      },
    })
  })
})

describe("tool.bash truncation", () => {
  test("truncates output exceeding line limit", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await BashTool.init()
        const lineCount = Truncate.MAX_LINES + 500
        const result = await bash.execute(
          {
            command: `node -e "for (let i = 1; i <= ${lineCount}; i++) console.log(i)"`,
            description: "Generate lines exceeding limit",
          },
          ctx,
        )
        expect((result.metadata as any).truncated).toBe(true)
        expect(result.output).toContain("truncated")
        expect(result.output).toContain("The tool call succeeded but the output was truncated")
      },
    })
  })

  test("truncates output exceeding byte limit", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await BashTool.init()
        const byteCount = Truncate.MAX_BYTES + 10000
        const result = await bash.execute(
          {
            command: `node -e "process.stdout.write('a'.repeat(${byteCount}))"`,
            description: "Generate bytes exceeding limit",
          },
          ctx,
        )
        expect((result.metadata as any).truncated).toBe(true)
        expect(result.output).toContain("truncated")
        expect(result.output).toContain("The tool call succeeded but the output was truncated")
      },
    })
  })

  test("does not truncate small output", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await BashTool.init()
        const result = await bash.execute(
          {
            command: "echo hello",
            description: "Echo hello",
          },
          ctx,
        )
        expect((result.metadata as any).truncated).toBe(false)
        expect(result.output.startsWith("hello")).toBe(true)
        expect(result.output).toContain("无法通过 undo 撤销")
      },
    })
  })

  test("full output is saved to file when truncated", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await BashTool.init()
        const lineCount = Truncate.MAX_LINES + 100
        const result = await bash.execute(
          {
            command: `node -e "for (let i = 1; i <= ${lineCount}; i++) console.log(i)"`,
            description: "Generate lines for file check",
          },
          ctx,
        )
        expect((result.metadata as any).truncated).toBe(true)

        const filepath = (result.metadata as any).outputPath
        expect(filepath).toBeTruthy()

        const saved = await Filesystem.readText(filepath)
        const lines = saved.trim().split("\n")
        // Every generated line plus trailing notes such as the undo hint
        expect(lines.length).toBeGreaterThanOrEqual(lineCount)
        expect(lines[0]).toBe("1")
        expect(lines[lineCount - 1]).toBe(String(lineCount))
      },
    })
  })
})
