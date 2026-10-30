import { expect, test, vi } from "vitest"
import { chmod, unlink } from "fs/promises"
import path from "path"
import { Filesystem } from "@merakcode/util/filesystem"
import { setTimeout as delay } from "node:timers/promises"

let connectFailures = 0
let closeFailures = 0
let transportFailures = 0
let connectWait: Promise<void> | undefined
let connectStarted = () => {}

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect() {
      connectStarted()
      await connectWait
      if (connectFailures > 0) {
        connectFailures--
        throw new Error("connect boom")
      }
    }
    setNotificationHandler() {}
    async listTools() {
      return { tools: [{ name: "read" }, { name: "write" }] }
    }
    async close() {
      if (closeFailures > 0) {
        closeFailures--
        throw new Error("close boom")
      }
    }
  },
}))

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    constructor() {
      if (transportFailures > 0) {
        transportFailures--
        throw new Error("transport boom")
      }
    }
    get stderr() {
      return null
    }
    async close() {}
  },
}))

const { McpManagement } = await import("@merakcode/engine/agent/mcp/management")
const { Config } = await import("@merakcode/engine/app/config/files/config")
const { Global } = await import("@merakcode/engine/infra/global/index")
const { MCP } = await import("@merakcode/engine/agent/mcp/index")
const { Instance } = await import("@merakcode/engine/infra/project/instance")
const { tmpdir } = await import("../fixture/fixture")

// Config layering, rollback and concurrency.

// Make the project config unwritable. A read-only directory is enough on POSIX; on Windows the directory read-only
// attribute does not block writes, so the config file itself is made read-only too (renaming over it fails with EPERM)
async function lockProject(dir: string) {
  await chmod(path.join(dir, "merakcode.json"), 0o444)
  await chmod(dir, 0o555)
}

async function unlockProject(dir: string) {
  await chmod(dir, 0o755)
  await chmod(path.join(dir, "merakcode.json"), 0o644)
}

async function withGlobalConfig(fn: (file: string) => Promise<void>) {
  const files = ["merakcode.jsonc", "merakcode.json"].map((file) => path.join(Global.Path.config, file))
  const saved = await Promise.all(files.map((file) => Filesystem.readText(file).catch(() => undefined)))
  await Promise.all(files.map((file) => unlink(file).catch(() => undefined)))
  Config.global.reset()
  Config.state.invalidateAll()

  try {
    await fn(files[0])
  } finally {
    await Instance.disposeAll()
    await Promise.all(
      files.map((file, index) =>
        saved[index] === undefined ? unlink(file).catch(() => undefined) : Filesystem.write(file, saved[index]!),
      ),
    )
    Config.global.reset()
    Config.state.invalidateAll()
  }
}

test("exposes only the read and change operations", () => {
  expect(Object.keys(McpManagement).sort()).toEqual(["change", "read"])
})

test("read returns one presentation-ready snapshot for configured MCP servers", async () => {
  await using tmp = await tmpdir({
    config: {
      mcp: {
        alpha: { type: "local", command: ["dummy"], enabled: true },
        beta: { type: "remote", url: "https://example.com/mcp", enabled: false },
      },
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect(await McpManagement.read()).toEqual({
        servers: [
          {
            name: "alpha",
            scope: "project",
            shadowed: [],
            enabled: true,
            config: { type: "local", command: ["dummy"], enabled: true },
            status: { status: "connected" },
            tools: { count: 2, tools: ["read", "write"] },
          },
          {
            name: "beta",
            scope: "project",
            shadowed: [],
            enabled: false,
            config: { type: "remote", url: "https://example.com/mcp", enabled: false },
            status: { status: "disabled" },
            tools: { count: 0, tools: [] },
          },
        ],
      })
    },
  })
})

test("runtime status prefers project configuration when reporting MCP source scope", async () => {
  await withGlobalConfig(async (globalFile) => {
    await Filesystem.write(
      globalFile,
      JSON.stringify({
        $schema: Config.SCHEMA,
        mcp: {
          global: { type: "local", command: ["global"], enabled: false },
          shared: { type: "local", command: ["global-shared"], enabled: true },
        },
      }),
    )
    await using tmp = await tmpdir({
      init: (dir) =>
        Filesystem.write(
          path.join(dir, "merakcode.json"),
          JSON.stringify({
            $schema: Config.SCHEMA,
            mcp: { shared: { enabled: false } },
          }),
        ),
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await MCP.status()).toEqual({
          global: { status: "disabled", scope: "global" },
          shared: { status: "disabled", scope: "project" },
        })
      },
    })
  })
})

test("change adds a manual MCP globally and returns the committed snapshot", async () => {
  await withGlobalConfig(async (globalFile) => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await McpManagement.change({
          type: "add",
          name: "manual",
          config: { type: "local", command: ["manual-server"], enabled: false },
        })

        expect(result).toMatchObject({
          ok: true,
          snapshot: {
            servers: [
              {
                name: "manual",
                scope: "global",
                enabled: false,
                status: { status: "disabled" },
                tools: { count: 0, tools: [] },
              },
            ],
          },
        })
        const global = (await Filesystem.readJson(globalFile)) as { mcp?: Record<string, unknown> }
        expect(global.mcp?.manual).toEqual({ type: "local", command: ["manual-server"], enabled: false })
        expect(await Filesystem.isFile(path.join(tmp.path, ".merakcode", "merakcode.json"))).toBe(false)
      },
    })
  })
})

test("change replaces local and remote in both directions without retaining union fields", async () => {
  await withGlobalConfig(async (globalFile) => {
    await Filesystem.write(
      globalFile,
      JSON.stringify({
        $schema: Config.SCHEMA,
        mcp: {
          server: {
            type: "local",
            command: ["old"],
            environment: { OLD: "value" },
            enabled: false,
          },
        },
      }),
    )
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await McpManagement.change({
          type: "replace",
          name: "server",
          config: { type: "remote", url: "https://example.com/new", headers: { NEXT: "value" }, enabled: false },
        })
        expect(result).toMatchObject({
          ok: true,
          snapshot: {
            servers: [
              {
                name: "server",
                config: {
                  type: "remote",
                  url: "https://example.com/new",
                  headers: { NEXT: "value" },
                  enabled: false,
                },
              },
            ],
          },
        })
        const written = await Filesystem.readText(globalFile)
        expect(written).not.toContain('"command"')
        expect(written).not.toContain('"environment"')

        const reversed = await McpManagement.change({
          type: "replace",
          name: "server",
          config: { type: "local", command: ["again"], environment: { NEW: "value" }, enabled: false },
        })
        expect(reversed).toMatchObject({
          ok: true,
          snapshot: {
            servers: [
              {
                name: "server",
                config: {
                  type: "local",
                  command: ["again"],
                  environment: { NEW: "value" },
                  enabled: false,
                },
              },
            ],
          },
        })
        const restored = await Filesystem.readText(globalFile)
        expect(restored).not.toContain('"url"')
        expect(restored).not.toContain('"headers"')
      },
    })
  })
})

test("change rolls back the first scope when the second scope cannot be removed", async () => {
  await withGlobalConfig(async (globalFile) => {
    const globalEntry = { type: "local" as const, command: ["global"], enabled: false }
    const projectEntry = { type: "local" as const, command: ["project"], enabled: false }
    await Filesystem.write(globalFile, JSON.stringify({ $schema: Config.SCHEMA, mcp: { shared: globalEntry } }))
    await using tmp = await tmpdir({
      init: (dir) =>
        Filesystem.write(
          path.join(dir, "merakcode.json"),
          JSON.stringify({ $schema: Config.SCHEMA, mcp: { shared: projectEntry } }),
        ),
    })

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await lockProject(tmp.path)
          const result = await McpManagement.change({ type: "remove", name: "shared" })
          expect(result).toMatchObject({
            ok: false,
            error: {
              code: "config_write_failed",
              facts: [
                { stage: "runtime", action: "disconnect", ok: true },
                { stage: "config", action: "remove_project", ok: false },
                { stage: "compensation", action: "restore_global_config", ok: true },
                { stage: "compensation", action: "restore_runtime", ok: true },
              ],
            },
            snapshot: { servers: [{ name: "shared", scope: "project" }] },
          })
          const global = (await Filesystem.readJson(globalFile)) as { mcp: { shared: unknown } }
          const project = (await Filesystem.readJson(path.join(tmp.path, "merakcode.json"))) as {
            mcp: { shared: unknown }
          }
          expect(global.mcp.shared).toEqual(globalEntry)
          expect(project.mcp.shared).toEqual(projectEntry)
        },
      })
    } finally {
      await unlockProject(tmp.path)
    }
  })
})

test("concurrent same-name mutations commit exactly one deterministic winner", async () => {
  await withGlobalConfig(async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const results = await Promise.all([
          McpManagement.change({
            type: "add",
            name: "race",
            config: { type: "local", command: ["first"], enabled: false },
          }),
          McpManagement.change({
            type: "add",
            name: "race",
            config: { type: "local", command: ["second"], enabled: false },
          }),
        ])

        expect(results.map((result) => result.ok)).toEqual([true, false])
        expect(results[1]).toMatchObject({ ok: false, error: { code: "already_exists" } })
        expect((await McpManagement.read()).servers[0]?.config).toEqual({
          type: "local",
          command: ["first"],
          enabled: false,
        })
      },
    })
  })
})

test("same-name global mutations remain deterministic across project instances", async () => {
  await withGlobalConfig(async () => {
    await using first = await tmpdir({ git: true })
    await using second = await tmpdir({ git: true })

    let entered = () => {}
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const leading = Instance.provide({
      directory: first.path,
      fn: () => {
        const changing = McpManagement.change({
          type: "add",
          name: "cross-project",
          config: { type: "local", command: ["first"], enabled: false },
        })
        entered()
        return changing
      },
    })
    await started
    const following = Instance.provide({
      directory: second.path,
      fn: () =>
        McpManagement.change({
          type: "add",
          name: "cross-project",
          config: { type: "local", command: ["second"], enabled: false },
        }),
    })
    const results = await Promise.all([leading, following])

    expect(results.map((result) => result.ok)).toEqual([true, false])
    expect(results[1]).toMatchObject({ ok: false, error: { code: "already_exists" } })
    await Instance.provide({
      directory: first.path,
      fn: async () => {
        expect((await McpManagement.read()).servers[0]?.config).toEqual({
          type: "local",
          command: ["first"],
          enabled: false,
        })
      },
    })
  })
})

test("read waits for an in-flight mutation and never exposes split config/runtime state", async () => {
  await withGlobalConfig(async () => {
    await using tmp = await tmpdir({ git: true })
    let release = () => {}
    const started = new Promise<void>((resolve) => {
      connectStarted = resolve
    })
    connectWait = new Promise<void>((resolve) => {
      release = resolve
    })

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const changing = McpManagement.change({
            type: "add",
            name: "consistent",
            config: { type: "local", command: ["server"], enabled: true },
          })
          await started

          const reading = McpManagement.read()
          const state = await Promise.race([
            reading.then(() => "read" as const),
            delay(10).then(() => "pending" as const),
          ])
          expect(state).toBe("pending")

          release()
          expect(await changing).toMatchObject({ ok: true })
          expect(await reading).toMatchObject({
            servers: [{ name: "consistent", enabled: true, status: { status: "connected" } }],
          })
        },
      })
    } finally {
      release()
      connectWait = undefined
      connectStarted = () => {}
    }
  })
})

test("set_enabled true succeeds only with connected runtime and persisted project state", async () => {
  await using tmp = await tmpdir({
    config: {
      mcp: {
        toggle: { type: "local", command: ["server"], enabled: false },
      },
    },
  })

  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await McpManagement.change({ type: "set_enabled", name: "toggle", enabled: true })
        expect(result).toMatchObject({
          ok: true,
          snapshot: {
            servers: [
              {
                name: "toggle",
                scope: "project",
                enabled: true,
                status: { status: "connected" },
                tools: { count: 2, tools: ["read", "write"] },
              },
            ],
          },
        })
        const config = (await Filesystem.readJson(path.join(tmp.path, "merakcode.json"))) as {
          mcp: { toggle: { enabled: boolean } }
        }
        expect(config.mcp.toggle.enabled).toBe(true)
      },
    })
  } finally {
    await Instance.disposeAll()
  }
})

test("set_enabled true reports connect failure without changing persisted state", async () => {
  await using tmp = await tmpdir({
    config: { mcp: { toggle: { type: "local", command: ["server"], enabled: false } } },
  })

  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        connectFailures = 1
        const result = await McpManagement.change({ type: "set_enabled", name: "toggle", enabled: true })
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: "runtime_connect_failed",
            facts: [
              { stage: "runtime", action: "connect", ok: false, message: "connect boom" },
              { stage: "compensation", action: "disconnect", ok: true },
            ],
          },
          snapshot: { servers: [{ name: "toggle", enabled: false, status: { status: "disabled" } }] },
        })
        const config = (await Filesystem.readJson(path.join(tmp.path, "merakcode.json"))) as {
          mcp: { toggle: { enabled: boolean } }
        }
        expect(config.mcp.toggle.enabled).toBe(false)
      },
    })
  } finally {
    connectFailures = 0
    await Instance.disposeAll()
  }
})

test("set_enabled true returns a typed result when runtime construction throws", async () => {
  await using tmp = await tmpdir({
    config: { mcp: { toggle: { type: "local", command: ["server"], enabled: false } } },
  })

  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        transportFailures = 1
        const result = await McpManagement.change({ type: "set_enabled", name: "toggle", enabled: true })
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: "runtime_connect_failed",
            message: "transport boom",
            facts: [
              { stage: "runtime", action: "connect", ok: false, message: "transport boom" },
              { stage: "compensation", action: "disconnect", ok: true },
            ],
          },
          snapshot: { servers: [{ name: "toggle", enabled: false, status: { status: "disabled" } }] },
        })
        const config = (await Filesystem.readJson(path.join(tmp.path, "merakcode.json"))) as {
          mcp: { toggle: { enabled: boolean } }
        }
        expect(config.mcp.toggle.enabled).toBe(false)
      },
    })
  } finally {
    transportFailures = 0
    await Instance.disposeAll()
  }
})

test("set_enabled true compensates runtime when atomic persistence fails", async () => {
  await using tmp = await tmpdir({
    config: { mcp: { toggle: { type: "local", command: ["server"], enabled: false } } },
  })

  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await lockProject(tmp.path)
        const result = await McpManagement.change({ type: "set_enabled", name: "toggle", enabled: true })
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: "config_write_failed",
            facts: [
              { stage: "runtime", action: "connect", ok: true },
              { stage: "config", action: "set_enabled", ok: false },
              { stage: "compensation", action: "disconnect", ok: true },
            ],
          },
          snapshot: { servers: [{ name: "toggle", enabled: false, status: { status: "disabled" } }] },
        })
        const config = (await Filesystem.readJson(path.join(tmp.path, "merakcode.json"))) as {
          mcp: { toggle: { enabled: boolean } }
        }
        expect(config.mcp.toggle.enabled).toBe(false)
      },
    })
  } finally {
    await unlockProject(tmp.path)
    await Instance.disposeAll()
  }
})

test("set_enabled reports both persistence and compensation failures", async () => {
  await using tmp = await tmpdir({
    config: { mcp: { toggle: { type: "local", command: ["server"], enabled: false } } },
  })

  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await lockProject(tmp.path)
        closeFailures = 1
        const result = await McpManagement.change({ type: "set_enabled", name: "toggle", enabled: true })
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: "compensation_failed",
            facts: [
              { stage: "runtime", action: "connect", ok: true },
              { stage: "config", action: "set_enabled", ok: false },
              {
                stage: "compensation",
                action: "disconnect",
                ok: false,
                message: "close boom",
              },
            ],
          },
        })
      },
    })
  } finally {
    closeFailures = 0
    await unlockProject(tmp.path)
    await Instance.disposeAll()
  }
})

test("set_enabled false succeeds only with disconnected runtime and persisted project state", async () => {
  await using tmp = await tmpdir({
    config: { mcp: { toggle: { type: "local", command: ["server"], enabled: true } } },
  })

  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await McpManagement.change({ type: "set_enabled", name: "toggle", enabled: false })
        expect(result).toMatchObject({
          ok: true,
          snapshot: {
            servers: [
              {
                name: "toggle",
                enabled: false,
                status: { status: "disabled" },
                tools: { count: 0, tools: [] },
              },
            ],
          },
        })
        const config = (await Filesystem.readJson(path.join(tmp.path, "merakcode.json"))) as {
          mcp: { toggle: { enabled: boolean } }
        }
        expect(config.mcp.toggle.enabled).toBe(false)
      },
    })
  } finally {
    await Instance.disposeAll()
  }
})

test("set_enabled false restores the connection when disconnect fails", async () => {
  await using tmp = await tmpdir({
    config: { mcp: { toggle: { type: "local", command: ["server"], enabled: true } } },
  })

  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await McpManagement.read()
        closeFailures = 1
        const result = await McpManagement.change({ type: "set_enabled", name: "toggle", enabled: false })
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: "runtime_disconnect_failed",
            facts: [
              { stage: "runtime", action: "disconnect", ok: false, message: "close boom" },
              { stage: "compensation", action: "connect", ok: true },
            ],
          },
          snapshot: { servers: [{ name: "toggle", enabled: true, status: { status: "connected" } }] },
        })
        const config = (await Filesystem.readJson(path.join(tmp.path, "merakcode.json"))) as {
          mcp: { toggle: { enabled: boolean } }
        }
        expect(config.mcp.toggle.enabled).toBe(true)
      },
    })
  } finally {
    closeFailures = 0
    await Instance.disposeAll()
  }
})

test("set_enabled false reports persistence and failed reconnect compensation", async () => {
  await using tmp = await tmpdir({
    config: { mcp: { toggle: { type: "local", command: ["server"], enabled: true } } },
  })

  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await McpManagement.read()
        await lockProject(tmp.path)
        connectFailures = 1
        const result = await McpManagement.change({ type: "set_enabled", name: "toggle", enabled: false })
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: "compensation_failed",
            facts: [
              { stage: "runtime", action: "disconnect", ok: true },
              { stage: "config", action: "set_enabled", ok: false },
              {
                stage: "compensation",
                action: "connect",
                ok: false,
                message: "connect boom",
              },
            ],
          },
          snapshot: { servers: [{ name: "toggle", enabled: true, status: { status: "failed" } }] },
        })
      },
    })
  } finally {
    connectFailures = 0
    await unlockProject(tmp.path)
    await Instance.disposeAll()
  }
})

test("set_enabled false reconnects a previously failed enabled runtime after persistence fails", async () => {
  await using tmp = await tmpdir({
    config: { mcp: { toggle: { type: "local", command: ["server"], enabled: true } } },
  })

  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        connectFailures = 1
        expect((await McpManagement.read()).servers[0]?.status).toEqual({ status: "failed", error: "connect boom" })
        await lockProject(tmp.path)

        const result = await McpManagement.change({ type: "set_enabled", name: "toggle", enabled: false })
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: "config_write_failed",
            facts: [
              { stage: "runtime", action: "disconnect", ok: true },
              { stage: "config", action: "set_enabled", ok: false },
              { stage: "compensation", action: "connect", ok: true },
            ],
          },
          snapshot: { servers: [{ name: "toggle", enabled: true, status: { status: "connected" } }] },
        })
      },
    })
  } finally {
    connectFailures = 0
    await unlockProject(tmp.path)
    await Instance.disposeAll()
  }
})

test("enabled add, replace, rename, and remove keep runtime aligned with configuration", async () => {
  await withGlobalConfig(async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const added = await McpManagement.change({
          type: "add",
          name: "lifecycle",
          config: { type: "local", command: ["first"], enabled: true },
        })
        expect(added).toMatchObject({
          ok: true,
          snapshot: { servers: [{ name: "lifecycle", status: { status: "connected" } }] },
        })

        const replaced = await McpManagement.change({
          type: "replace",
          name: "lifecycle",
          config: { type: "local", command: ["second"], enabled: true },
        })
        expect(replaced).toMatchObject({
          ok: true,
          snapshot: {
            servers: [
              {
                name: "lifecycle",
                config: { command: ["second"] },
                status: { status: "connected" },
              },
            ],
          },
        })

        const renamed = await McpManagement.change({ type: "rename", name: "lifecycle", newName: "renamed" })
        expect(renamed).toMatchObject({
          ok: true,
          snapshot: { servers: [{ name: "renamed", status: { status: "connected" } }] },
        })

        expect(await McpManagement.change({ type: "remove", name: "renamed" })).toEqual({
          ok: true,
          snapshot: { servers: [] },
        })
      },
    })
  })
})

test("replace and rename restore the prior global config and runtime after transition failures", async () => {
  await withGlobalConfig(async (globalFile) => {
    await Filesystem.write(
      globalFile,
      JSON.stringify({
        $schema: Config.SCHEMA,
        mcp: { stable: { type: "local", command: ["original"], enabled: true } },
      }),
    )
    await using tmp = await tmpdir({ git: true })

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect((await McpManagement.read()).servers[0]?.status).toEqual({ status: "connected" })

          closeFailures = 1
          const replaced = await McpManagement.change({
            type: "replace",
            name: "stable",
            config: { type: "remote", url: "https://example.com/replacement", enabled: false },
          })
          expect(replaced).toMatchObject({
            ok: false,
            error: {
              code: "runtime_disconnect_failed",
              facts: [
                { stage: "config", action: "replace", ok: true },
                { stage: "runtime", action: "disconnect", ok: false, message: "close boom" },
                { stage: "compensation", action: "restore_config", ok: true },
                { stage: "compensation", action: "restore_runtime", ok: true },
              ],
            },
            snapshot: {
              servers: [{ name: "stable", config: { command: ["original"] }, status: { status: "connected" } }],
            },
          })

          connectFailures = 1
          const renamed = await McpManagement.change({ type: "rename", name: "stable", newName: "temporary" })
          expect(renamed).toMatchObject({
            ok: false,
            error: {
              code: "runtime_connect_failed",
              facts: [
                { stage: "config", action: "rename", ok: true },
                { stage: "runtime", action: "connect_new", ok: false, message: "connect boom" },
                { stage: "compensation", action: "restore_config", ok: true },
                { stage: "compensation", action: "disconnect_new", ok: true },
                { stage: "compensation", action: "restore_old_runtime", ok: true },
              ],
            },
            snapshot: {
              servers: [{ name: "stable", config: { command: ["original"] }, status: { status: "connected" } }],
            },
          })

          expect((await Filesystem.readJson(globalFile)) as unknown).toMatchObject({
            mcp: { stable: { type: "local", command: ["original"], enabled: true } },
          })
          expect(await Filesystem.readText(globalFile)).not.toContain("temporary")
        },
      })
    } finally {
      closeFailures = 0
      connectFailures = 0
    }
  })
})

test("project configuration shadows a same-name global MCP without ambiguous mutation", async () => {
  await withGlobalConfig(async (globalFile) => {
    await Filesystem.write(
      globalFile,
      JSON.stringify({
        $schema: Config.SCHEMA,
        mcp: { shared: { type: "local", command: ["global"], enabled: false } },
      }),
    )
    await using tmp = await tmpdir({
      config: { mcp: { shared: { type: "local", command: ["project"], enabled: false } } },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const projectFile = path.join(tmp.path, "merakcode.json")
        const globalBefore = await Filesystem.readText(globalFile)
        const projectBefore = await Filesystem.readText(projectFile)
        expect(await McpManagement.read()).toMatchObject({
          servers: [
            {
              name: "shared",
              scope: "project",
              shadowed: ["global"],
              config: { command: ["project"] },
            },
          ],
        })

        const result = await McpManagement.change({
          type: "replace",
          name: "shared",
          config: { type: "local", command: ["replacement"], enabled: false },
        })
        expect(result).toMatchObject({ ok: false, error: { code: "shadowed" } })
        expect(await Filesystem.readText(globalFile)).toBe(globalBefore)
        expect(await Filesystem.readText(projectFile)).toBe(projectBefore)
      },
    })
  })
})

test("enabled add removes its committed config when runtime connection fails", async () => {
  await withGlobalConfig(async (globalFile) => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        transportFailures = 1
        const result = await McpManagement.change({
          type: "add",
          name: "failed",
          config: { type: "local", command: ["server"], enabled: true },
        })
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: "runtime_connect_failed",
            facts: [
              { stage: "config", action: "add", ok: true },
              { stage: "runtime", action: "connect", ok: false, message: "transport boom" },
              { stage: "compensation", action: "remove_config", ok: true },
              { stage: "compensation", action: "disconnect", ok: true },
            ],
          },
          snapshot: { servers: [] },
        })
        const config = (await Filesystem.readJson(globalFile)) as { mcp?: Record<string, unknown> }
        expect(config.mcp?.failed).toBeUndefined()
      },
    })
  })
  transportFailures = 0
})

test("internal MCP connect and disconnect remain runtime-only operations", async () => {
  await using tmp = await tmpdir({
    config: { mcp: { legacy: { type: "local", command: ["server"], enabled: false } } },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const file = path.join(tmp.path, "merakcode.json")
      const before = await Filesystem.readText(file)

      expect(await MCP.connect("legacy")).toBeUndefined()
      expect((await MCP.status()).legacy).toEqual({ status: "connected", scope: "project" })
      expect(await Filesystem.readText(file)).toBe(before)

      expect(await MCP.disconnect("legacy")).toBeUndefined()
      expect((await MCP.status()).legacy).toEqual({ status: "disabled", scope: "project" })
      expect(await Filesystem.readText(file)).toBe(before)
    },
  })
})
