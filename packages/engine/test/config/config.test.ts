import { test, expect, describe, afterEach, vi } from "vitest"
import { Config } from "@merakcode/engine/config/config"
import { PermissionNext } from "@merakcode/engine/permission/next"
import { Instance } from "@merakcode/engine/project/instance"
import { Server } from "@merakcode/engine/server/server"
import { Auth } from "@merakcode/engine/auth/index"
import { tmpdir } from "../fixture/fixture"
import path from "path"
import fs from "fs/promises"
import { pathToFileURL } from "url"
import { Global } from "@merakcode/engine/global/index"
import { Filesystem } from "@merakcode/util/filesystem"

// Get managed config directory from environment (set in preload.ts)
const managedConfigDir = process.env.MERAKCODE_TEST_MANAGED_CONFIG_DIR!

afterEach(async () => {
  await fs.rm(managedConfigDir, { force: true, recursive: true }).catch(() => {})
})

async function writeManagedSettings(settings: object, filename = "merakcode.json") {
  await fs.mkdir(managedConfigDir, { recursive: true })
  await Filesystem.write(path.join(managedConfigDir, filename), JSON.stringify(settings))
}

async function writeConfig(dir: string, config: object, name = "merakcode.json") {
  await Filesystem.write(path.join(dir, name), JSON.stringify(config))
}

test("loads config with defaults when no files exist", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.keybinds).toBeDefined()
    },
  })
})

test("skips dependency install when zod is already available", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await fs.mkdir(path.join(dir, "node_modules", "zod"), { recursive: true })
    },
  })

  await Config.installDependencies(tmp.path)

  expect(
    await Filesystem.readJson(path.join(tmp.path, "node_modules", "@merakcode", "sdk", "package.json")),
  ).toMatchObject({
    name: "@merakcode/sdk",
    exports: { "./plugin": "./plugin.js" },
    dependencies: { zod: "*" },
  })
  expect(await Filesystem.isFile(path.join(tmp.path, "package.json"))).toBe(false)
  expect(await Filesystem.isFile(path.join(tmp.path, "bun.lock"))).toBe(false)
})

test("loads JSON config file", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        $schema: Config.SCHEMA,
        model: "test/model",
        theme: "testuser",
      })
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.model).toBe("test/model")
      expect(config.theme).toBe("testuser")
    },
  })
})

test("loads JSONC config file", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.jsonc"),
        `{
        // This is a comment
        "$schema": "${Config.SCHEMA}",
        "model": "test/model",
        "theme": "testuser"
      }`,
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.model).toBe("test/model")
      expect(config.theme).toBe("testuser")
    },
  })
})

test("merges multiple config files with correct precedence", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(
        dir,
        {
          $schema: Config.SCHEMA,
          model: "base",
          theme: "base",
        },
        "merakcode.jsonc",
      )
      await writeConfig(dir, {
        $schema: Config.SCHEMA,
        model: "override",
      })
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.model).toBe("override")
      expect(config.theme).toBe("base")
    },
  })
})

test("handles environment variable substitution", async () => {
  const originalEnv = process.env["TEST_VAR"]
  process.env["TEST_VAR"] = "test_theme"

  try {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await writeConfig(dir, {
          $schema: Config.SCHEMA,
          theme: "{env:TEST_VAR}",
        })
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        expect(config.theme).toBe("test_theme")
      },
    })
  } finally {
    if (originalEnv !== undefined) {
      process.env["TEST_VAR"] = originalEnv
    } else {
      delete process.env["TEST_VAR"]
    }
  }
})

test("preserves env variables when adding $schema to config", async () => {
  const originalEnv = process.env["PRESERVE_VAR"]
  process.env["PRESERVE_VAR"] = "secret_value"

  try {
    await using tmp = await tmpdir({
      init: async (dir) => {
        // Config without $schema - should trigger auto-add
        await Filesystem.write(
          path.join(dir, "merakcode.json"),
          JSON.stringify({
            theme: "{env:PRESERVE_VAR}",
          }),
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        expect(config.theme).toBe("secret_value")

        // Read the file to verify the env variable was preserved
        const content = await Filesystem.readText(path.join(tmp.path, "merakcode.json"))
        expect(content).toContain("{env:PRESERVE_VAR}")
        expect(content).not.toContain("secret_value")
        expect(content).toContain("$schema")
      },
    })
  } finally {
    if (originalEnv !== undefined) {
      process.env["PRESERVE_VAR"] = originalEnv
    } else {
      delete process.env["PRESERVE_VAR"]
    }
  }
})

test("handles file inclusion substitution", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(path.join(dir, "included.txt"), "test_theme")
      await writeConfig(dir, {
        $schema: Config.SCHEMA,
        theme: "{file:included.txt}",
      })
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.theme).toBe("test_theme")
    },
  })
})

test("handles file inclusion with replacement tokens", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(path.join(dir, "included.md"), "const out = await $`echo hi`")
      await writeConfig(dir, {
        $schema: Config.SCHEMA,
        theme: "{file:included.md}",
      })
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.theme).toBe("const out = await $`echo hi`")
    },
  })
})

test("degrades missing file inclusion without rewriting config", async () => {
  const configPath = { value: "" }
  const source = {
    $schema: Config.SCHEMA,
    model: "keep/me",
    theme: "{file:missing.md}",
  }
  await using tmp = await tmpdir({
    init: async (dir) => {
      configPath.value = path.join(dir, "merakcode.json")
      await Filesystem.write(configPath.value, JSON.stringify(source, null, 2))
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.model).toBe("keep/me")
      expect(config.theme).toBe("")
      const onDisk = await Filesystem.readText(configPath.value)
      expect(JSON.parse(onDisk)).toEqual(source)
      const warnings = await Config.warnings()
      expect(warnings.some((w) => w.path === configPath.value && w.item.includes("{file:"))).toBe(true)
    },
  })
})

test("degrade warnings follow the configured UI language", async () => {
  for (const [locale, expected] of [
    [undefined, "已临时跳过该引用"],
    ["en-US", "this reference is skipped for now"],
  ] as const) {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await writeConfig(dir, {
          $schema: Config.SCHEMA,
          ...(locale ? { locale } : {}),
          theme: "{file:missing.md}",
        })
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const warning = (await Config.warnings()).find((w) => w.item.includes("{file:"))
        expect(warning?.reason).toContain(expected)
      },
    })
  }
})

test("degrades invalid MERAKCODE_CONFIG_CONTENT without failing Config.get", async () => {
  const prev = process.env.MERAKCODE_CONFIG_CONTENT
  process.env.MERAKCODE_CONFIG_CONTENT = "{ not-json"
  try {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await writeConfig(dir, {
          $schema: Config.SCHEMA,
          model: "from-file/model",
        })
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        expect(config.model).toBe("from-file/model")
        const warnings = await Config.warnings()
        expect(warnings.some((w) => w.item.includes("MERAKCODE_CONFIG_CONTENT"))).toBe(true)
      },
    })
  } finally {
    if (prev === undefined) delete process.env.MERAKCODE_CONFIG_CONTENT
    else process.env.MERAKCODE_CONFIG_CONTENT = prev
  }
})

test("degrades invalid MERAKCODE_PERMISSION without failing Config.get", async () => {
  const prev = process.env.MERAKCODE_PERMISSION
  process.env.MERAKCODE_PERMISSION = "{ not-json"
  try {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await writeConfig(dir, {
          $schema: Config.SCHEMA,
          model: "ok/model",
        })
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        expect(config.model).toBe("ok/model")
        const warnings = await Config.warnings()
        expect(warnings.some((w) => w.item.includes("MERAKCODE_PERMISSION"))).toBe(true)
      },
    })
  } finally {
    if (prev === undefined) delete process.env.MERAKCODE_PERMISSION
    else process.env.MERAKCODE_PERMISSION = prev
  }
})

test("strips unknown config fields for backwards compatibility", async () => {
  const configPath = { value: "" }
  const invalid = {
    $schema: Config.SCHEMA,
    invalid_field: "should cause error",
  }
  await using tmp = await tmpdir({
    init: async (dir) => {
      configPath.value = path.join(dir, "merakcode.json")
      await Filesystem.write(configPath.value, JSON.stringify(invalid, null, 2))
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect((config as any).invalid_field).toBeUndefined()

      // The file on disk is untouched (the stripped config is not written back)
      const onDisk = await Filesystem.readText(configPath.value)
      expect(JSON.parse(onDisk)).toEqual(invalid)

      // Unknown top-level keys are stripped but still reported as warnings for the UI
      const warnings = await Config.warnings()
      expect(warnings.some((w) => w.path === configPath.value && w.item === "invalid_field")).toBe(true)
      expect(warnings.some((w) => w.reason.includes("invalid_field"))).toBe(true)
    },
  })
})

test("keeps global unknown top-level key warnings after getGlobal warms the lazy cache", async () => {
  // Mirrors desktop startup: bootstrapGlobal calls getGlobal() before the instance fetches /config/warnings.
  // global() is lazy; if the first load does not attach activeWarnings, the warnings are lost and the UI never
  // reports the misspelled keys.
  await using tmp = await tmpdir()
  const globalConfigPath = path.join(Global.Path.config, "merakcode.jsonc")
  const previous = await Filesystem.readText(globalConfigPath).catch(() => undefined)
  await fs.mkdir(Global.Path.config, { recursive: true })
  try {
    await Filesystem.write(
      globalConfigPath,
      JSON.stringify({
        $schema: Config.SCHEMA,
        agnet: {
          build: { model: "test/model" },
        },
        model: "keep/me",
      }),
    )
    Config.global.reset()
    Config.state.invalidateAll()

    const warmed = await Config.getGlobal()
    expect((warmed as any)["agnet"]).toBeUndefined()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        expect(config.model).toBe("keep/me")
        const warnings = await Config.warnings()
        expect(warnings.some((w) => w.path === globalConfigPath && w.item === "agnet")).toBe(true)
      },
    })
  } finally {
    if (previous === undefined) await fs.rm(globalConfigPath, { force: true }).catch(() => {})
    else await Filesystem.write(globalConfigPath, previous)
    Config.global.reset()
    Config.state.invalidateAll()
  }
})

test("degrades invalid nested fields without rewriting the config file", async () => {
  const invalid = {
    $schema: Config.SCHEMA,
    model: "test/model",
    mcp: {
      broken: {
        type: "local",
        command: ["echo", "hi"],
        typo_timeout: 1000,
      },
    },
  }
  const configPath = { value: "" }
  await using tmp = await tmpdir({
    init: async (dir) => {
      configPath.value = path.join(dir, "merakcode.json")
      await Filesystem.write(configPath.value, JSON.stringify(invalid, null, 2))
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.model).toBe("test/model")

      const onDisk = await Filesystem.readText(configPath.value)
      expect(JSON.parse(onDisk)).toEqual(invalid)

      const warnings = await Config.warnings()
      expect(warnings.length).toBeGreaterThan(0)
      expect(warnings.some((w) => w.path === configPath.value && w.item.includes("mcp"))).toBe(true)
      expect(warnings.every((w) => typeof w.reason === "string" && w.reason.length > 0)).toBe(true)
    },
  })
})

test("keeps valid config items when a sibling mcp entry is invalid", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        $schema: Config.SCHEMA,
        model: "keep/me",
        mcp: {
          good: {
            type: "local",
            command: ["echo", "ok"],
          },
          bad: {
            type: "local",
            command: "not-an-array",
          },
        },
      })
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.model).toBe("keep/me")
      expect(config.mcp?.good).toEqual(
        expect.objectContaining({
          type: "local",
          command: ["echo", "ok"],
        }),
      )
      expect(config.mcp?.bad).toBeUndefined()
      const warnings = await Config.warnings()
      expect(warnings.some((w) => w.item.includes("mcp.bad"))).toBe(true)
    },
  })
})

test("warns about unknown top-level keys without reading them or modifying the file", async () => {
  const configPath = { value: "" }
  let written = ""
  await using tmp = await tmpdir({
    init: async (dir) => {
      configPath.value = path.join(dir, "merakcode.json")
      written = JSON.stringify({
        $schema: Config.SCHEMA,
        model: "keep/me",
        typo_field: 1,
      })
      await Filesystem.write(configPath.value, written)
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.model).toBe("keep/me")
      expect((config as unknown as Record<string, unknown>).typo_field).toBeUndefined()
      const warnings = await Config.warnings()
      expect(warnings).toContainEqual(
        expect.objectContaining({
          path: configPath.value,
          item: "typo_field",
          reason: 'Unrecognized key: "typo_field"',
        }),
      )
      expect(await Filesystem.readText(configPath.value)).toBe(written)
    },
  })
})

test("degrades invalid JSON to empty config without rewriting the file", async () => {
  const broken = "{ invalid json }"
  const configPath = { value: "" }
  await using tmp = await tmpdir({
    init: async (dir) => {
      configPath.value = path.join(dir, "merakcode.json")
      await Filesystem.write(configPath.value, broken)
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.keybinds).toBeDefined()

      const onDisk = await Filesystem.readText(configPath.value)
      expect(onDisk).toBe(broken)

      const warnings = await Config.warnings()
      expect(warnings.some((w) => w.path === configPath.value)).toBe(true)
    },
  })
})

test("handles agent configuration", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        $schema: Config.SCHEMA,
        agent: {
          test_agent: {
            model: "test/model",
            temperature: 0.7,
            description: "test agent",
          },
        },
      })
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.agent?.["test_agent"]).toEqual(
        expect.objectContaining({
          model: "test/model",
          temperature: 0.7,
          description: "test agent",
        }),
      )
    },
  })
})

test("treats agent variant as model-scoped setting (not provider option)", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        $schema: Config.SCHEMA,
        agent: {
          test_agent: {
            model: "openai/gpt-5.2",
            variant: "xhigh",
            max_tokens: 123,
          },
        },
      })
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      const agent = config.agent?.["test_agent"]

      expect(agent?.variant).toBe("xhigh")
      expect(agent?.options).toMatchObject({
        max_tokens: 123,
      })
      expect(agent?.options).not.toHaveProperty("variant")
    },
  })
})

test("handles command configuration", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        $schema: Config.SCHEMA,
        command: {
          test_command: {
            template: "test template",
            description: "test command",
            agent: "test_agent",
          },
        },
      })
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.command?.["test_command"]).toEqual({
        template: "test template",
        description: "test command",
        agent: "test_agent",
      })
    },
  })
})

test("migrates mode field to agent field", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          mode: {
            test_mode: {
              model: "test/model",
              temperature: 0.5,
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.agent?.["test_mode"]).toEqual({
        model: "test/model",
        temperature: 0.5,
        mode: "primary",
        options: {},
        permission: {},
      })
    },
  })
})

test("loads config from .merakcode directory", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const merakCodeDir = path.join(dir, ".merakcode")
      await fs.mkdir(merakCodeDir, { recursive: true })
      const agentDir = path.join(merakCodeDir, "agent")
      await fs.mkdir(agentDir, { recursive: true })

      await Filesystem.write(
        path.join(agentDir, "test.md"),
        `---
model: test/model
---
Test agent prompt`,
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.agent?.["test"]).toEqual(
        expect.objectContaining({
          name: "test",
          model: "test/model",
          prompt: "Test agent prompt",
        }),
      )
    },
  })
})

test("skips invalid agent files without failing Config.get", async () => {
  const badAgentPath = { value: "" }
  await using tmp = await tmpdir({
    init: async (dir) => {
      const agentsDir = path.join(dir, ".merakcode", "agents")
      await fs.mkdir(agentsDir, { recursive: true })
      badAgentPath.value = path.join(agentsDir, "broken.md")
      await Filesystem.write(
        badAgentPath.value,
        `---
model: test/model
mode: not-a-valid-mode
---
Broken agent`,
      )
      await Filesystem.write(
        path.join(agentsDir, "ok.md"),
        `---
model: test/model
mode: subagent
---
Good agent`,
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.agent?.ok).toMatchObject({
        name: "ok",
        mode: "subagent",
      })
      expect(config.agent?.broken).toBeUndefined()
      const warnings = await Config.warnings()
      expect(warnings.some((w) => w.path === badAgentPath.value)).toBe(true)
      const onDisk = await Filesystem.readText(badAgentPath.value)
      expect(onDisk).toContain("not-a-valid-mode")
    },
  })
})

test("skips invalid command files without failing Config.get", async () => {
  const badCommandPath = { value: "" }
  await using tmp = await tmpdir({
    init: async (dir) => {
      const commandDir = path.join(dir, ".merakcode", "commands")
      await fs.mkdir(commandDir, { recursive: true })
      badCommandPath.value = path.join(commandDir, "broken.md")
      await Filesystem.write(
        badCommandPath.value,
        `---
description: broken
subtask: not-a-boolean
---
Broken command`,
      )
      await Filesystem.write(
        path.join(commandDir, "ok.md"),
        `---
description: ok
---
Good command`,
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.command?.ok).toMatchObject({
        description: "ok",
        template: "Good command",
      })
      expect(config.command?.broken).toBeUndefined()
      const warnings = await Config.warnings()
      expect(warnings.some((w) => w.path === badCommandPath.value)).toBe(true)
    },
  })
})

test("skips invalid mode files with warnings without failing Config.get", async () => {
  const badModePath = { value: "" }
  await using tmp = await tmpdir({
    init: async (dir) => {
      const modesDir = path.join(dir, ".merakcode", "modes")
      await fs.mkdir(modesDir, { recursive: true })
      badModePath.value = path.join(modesDir, "broken.md")
      await Filesystem.write(
        badModePath.value,
        `---
temperature: not-a-number
---
Broken mode`,
      )
      await Filesystem.write(
        path.join(modesDir, "ok.md"),
        `---
description: ok mode
---
Good mode`,
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.agent?.ok).toMatchObject({
        name: "ok",
        mode: "primary",
        prompt: "Good mode",
      })
      expect(config.agent?.broken).toBeUndefined()
      const warnings = await Config.warnings()
      expect(warnings.some((w) => w.path === badModePath.value)).toBe(true)
    },
  })
})

test("loads agents from .merakcode/agents (plural)", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const merakCodeDir = path.join(dir, ".merakcode")
      await fs.mkdir(merakCodeDir, { recursive: true })

      const agentsDir = path.join(merakCodeDir, "agents")
      await fs.mkdir(path.join(agentsDir, "nested"), { recursive: true })

      await Filesystem.write(
        path.join(agentsDir, "helper.md"),
        `---
model: test/model
mode: subagent
---
Helper agent prompt`,
      )

      await Filesystem.write(
        path.join(agentsDir, "nested", "child.md"),
        `---
model: test/model
mode: subagent
---
Nested agent prompt`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()

      expect(config.agent?.["helper"]).toMatchObject({
        name: "helper",
        model: "test/model",
        mode: "subagent",
        prompt: "Helper agent prompt",
      })

      expect(config.agent?.["nested/child"]).toMatchObject({
        name: "nested/child",
        model: "test/model",
        mode: "subagent",
        prompt: "Nested agent prompt",
      })
    },
  })
})

test("loads commands from .merakcode/command (singular)", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const merakCodeDir = path.join(dir, ".merakcode")
      await fs.mkdir(merakCodeDir, { recursive: true })

      const commandDir = path.join(merakCodeDir, "command")
      await fs.mkdir(path.join(commandDir, "nested"), { recursive: true })

      await Filesystem.write(
        path.join(commandDir, "hello.md"),
        `---
description: Test command
---
Hello from singular command`,
      )

      await Filesystem.write(
        path.join(commandDir, "nested", "child.md"),
        `---
description: Nested command
---
Nested command template`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()

      expect(config.command?.["hello"]).toEqual({
        description: "Test command",
        template: "Hello from singular command",
      })

      expect(config.command?.["nested/child"]).toEqual({
        description: "Nested command",
        template: "Nested command template",
      })
    },
  })
})

test("loads commands from .merakcode/commands (plural)", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const merakCodeDir = path.join(dir, ".merakcode")
      await fs.mkdir(merakCodeDir, { recursive: true })

      const commandsDir = path.join(merakCodeDir, "commands")
      await fs.mkdir(path.join(commandsDir, "nested"), { recursive: true })

      await Filesystem.write(
        path.join(commandsDir, "hello.md"),
        `---
description: Test command
---
Hello from plural commands`,
      )

      await Filesystem.write(
        path.join(commandsDir, "nested", "child.md"),
        `---
description: Nested command
---
Nested command template`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()

      expect(config.command?.["hello"]).toEqual({
        description: "Test command",
        template: "Hello from plural commands",
      })

      expect(config.command?.["nested/child"]).toEqual({
        description: "Nested command",
        template: "Nested command template",
      })
    },
  })
})

test("PATCH /config writes project config and takes effect immediately", async () => {
  await using tmp = await tmpdir()
  const response = await Server.App().request("http://localhost/config", {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-merakcode-directory": encodeURIComponent(tmp.path) },
    body: JSON.stringify({ model: "updated/model" }),
  })
  expect(response.status).toBe(200)
  const written = JSON.parse(await Filesystem.readText(path.join(tmp.path, ".merakcode", "merakcode.json")))
  expect(written.model).toBe("updated/model")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => expect((await Config.get()).model).toBe("updated/model"),
  })
})

test("gets config directories", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dirs = await Config.directories()
      expect(dirs.length).toBeGreaterThanOrEqual(1)
    },
  })
})

test.skipIf(process.platform === "win32")(
  "does not try to install dependencies in read-only MERAKCODE_CONFIG_DIR",
  async () => {
    await using tmp = await tmpdir<string>({
      init: async (dir) => {
        const ro = path.join(dir, "readonly")
        await fs.mkdir(ro, { recursive: true })
        await fs.chmod(ro, 0o555)
        return ro
      },
      dispose: async (dir) => {
        const ro = path.join(dir, "readonly")
        await fs.chmod(ro, 0o755).catch(() => {})
        return ro
      },
    })

    const prev = process.env.MERAKCODE_CONFIG_DIR
    process.env.MERAKCODE_CONFIG_DIR = tmp.extra

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Config.get()
        },
      })
    } finally {
      if (prev === undefined) delete process.env.MERAKCODE_CONFIG_DIR
      else process.env.MERAKCODE_CONFIG_DIR = prev
    }
  },
)

// The timeout must exceed DEPENDENCY_INSTALL_TIMEOUT_MS (30s in config.ts). waitForDependencies waits on a real
// `npm install`, and production code aborts and degrades when it is slow. With the default 30s test timeout both
// deadlines hit together and the test dies before reaching the degraded state it asserts on.
test("installs dependencies in writable MERAKCODE_CONFIG_DIR", async () => {
  await using tmp = await tmpdir<string>({
    init: async (dir) => {
      const cfg = path.join(dir, "configdir")
      await fs.mkdir(cfg, { recursive: true })
      return cfg
    },
  })

  const prev = process.env.MERAKCODE_CONFIG_DIR
  process.env.MERAKCODE_CONFIG_DIR = tmp.extra

  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Config.get()
        await Config.waitForDependencies()
      },
    })

    expect(await Filesystem.isFile(path.join(tmp.extra, "package.json"))).toBe(true)
    expect(await Filesystem.isFile(path.join(tmp.extra, ".gitignore"))).toBe(true)
  } finally {
    if (prev === undefined) delete process.env.MERAKCODE_CONFIG_DIR
    else process.env.MERAKCODE_CONFIG_DIR = prev
  }
}, 60_000)

test("resolves scoped npm plugins in config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const pluginDir = path.join(dir, "node_modules", "@scope", "plugin")
      await fs.mkdir(pluginDir, { recursive: true })

      await Filesystem.write(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "config-fixture", version: "1.0.0", type: "module" }, null, 2),
      )

      await Filesystem.write(
        path.join(pluginDir, "package.json"),
        JSON.stringify(
          {
            name: "@scope/plugin",
            version: "1.0.0",
            type: "module",
            main: "./index.js",
          },
          null,
          2,
        ),
      )

      await Filesystem.write(path.join(pluginDir, "index.js"), "export default {}\n")

      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({ $schema: Config.SCHEMA, plugin: ["@scope/plugin"] }, null, 2),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      const pluginEntries = config.plugin ?? []

      const expected = pathToFileURL(path.join(tmp.path, "node_modules", "@scope", "plugin", "index.js")).href

      expect(pluginEntries.includes(expected)).toBe(true)

      const scopedEntry = pluginEntries.find((entry) => entry === expected)
      expect(scopedEntry).toBeDefined()
      expect(scopedEntry).toContain("/node_modules/@scope/plugin/")
    },
  })
})

test("merges plugin arrays from global and local configs", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      // Create a nested project structure with local .merakcode config
      const projectDir = path.join(dir, "project")
      const merakCodeDir = path.join(projectDir, ".merakcode")
      await fs.mkdir(merakCodeDir, { recursive: true })

      // Global config with plugins
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          plugin: ["global-plugin-1", "global-plugin-2"],
        }),
      )

      // Local .merakcode config with different plugins
      await Filesystem.write(
        path.join(merakCodeDir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          plugin: ["local-plugin-1"],
        }),
      )
    },
  })

  await Instance.provide({
    directory: path.join(tmp.path, "project"),
    fn: async () => {
      const config = await Config.get()
      const plugins = config.plugin ?? []

      // Should contain both global and local plugins
      expect(plugins.some((p) => p.includes("global-plugin-1"))).toBe(true)
      expect(plugins.some((p) => p.includes("global-plugin-2"))).toBe(true)
      expect(plugins.some((p) => p.includes("local-plugin-1"))).toBe(true)

      // Should have all 3 plugins (not replaced, but merged)
      const pluginNames = plugins.filter((p) => p.includes("global-plugin") || p.includes("local-plugin"))
      expect(pluginNames.length).toBeGreaterThanOrEqual(3)
    },
  })
})

test("does not error when only custom agent is a subagent", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const merakCodeDir = path.join(dir, ".merakcode")
      await fs.mkdir(merakCodeDir, { recursive: true })
      const agentDir = path.join(merakCodeDir, "agent")
      await fs.mkdir(agentDir, { recursive: true })

      await Filesystem.write(
        path.join(agentDir, "helper.md"),
        `---
model: test/model
mode: subagent
---
Helper subagent prompt`,
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.agent?.["helper"]).toMatchObject({
        name: "helper",
        model: "test/model",
        mode: "subagent",
        prompt: "Helper subagent prompt",
      })
    },
  })
})

test("merges instructions arrays from global and local configs", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const projectDir = path.join(dir, "project")
      const merakCodeDir = path.join(projectDir, ".merakcode")
      await fs.mkdir(merakCodeDir, { recursive: true })

      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          instructions: ["global-instructions.md", "shared-rules.md"],
        }),
      )

      await Filesystem.write(
        path.join(merakCodeDir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          instructions: ["local-instructions.md"],
        }),
      )
    },
  })

  await Instance.provide({
    directory: path.join(tmp.path, "project"),
    fn: async () => {
      const config = await Config.get()
      const instructions = config.instructions ?? []

      expect(instructions).toContain("global-instructions.md")
      expect(instructions).toContain("shared-rules.md")
      expect(instructions).toContain("local-instructions.md")
      expect(instructions.length).toBe(3)
    },
  })
})

test("deduplicates duplicate instructions from global and local configs", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const projectDir = path.join(dir, "project")
      const merakCodeDir = path.join(projectDir, ".merakcode")
      await fs.mkdir(merakCodeDir, { recursive: true })

      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          instructions: ["duplicate.md", "global-only.md"],
        }),
      )

      await Filesystem.write(
        path.join(merakCodeDir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          instructions: ["duplicate.md", "local-only.md"],
        }),
      )
    },
  })

  await Instance.provide({
    directory: path.join(tmp.path, "project"),
    fn: async () => {
      const config = await Config.get()
      const instructions = config.instructions ?? []

      expect(instructions).toContain("global-only.md")
      expect(instructions).toContain("local-only.md")
      expect(instructions).toContain("duplicate.md")

      const duplicates = instructions.filter((i) => i === "duplicate.md")
      expect(duplicates.length).toBe(1)
      expect(instructions.length).toBe(3)
    },
  })
})

test("deduplicates duplicate plugins from global and local configs", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      // Create a nested project structure with local .merakcode config
      const projectDir = path.join(dir, "project")
      const merakCodeDir = path.join(projectDir, ".merakcode")
      await fs.mkdir(merakCodeDir, { recursive: true })

      // Global config with plugins
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          plugin: ["duplicate-plugin", "global-plugin-1"],
        }),
      )

      // Local .merakcode config with some overlapping plugins
      await Filesystem.write(
        path.join(merakCodeDir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          plugin: ["duplicate-plugin", "local-plugin-1"],
        }),
      )
    },
  })

  await Instance.provide({
    directory: path.join(tmp.path, "project"),
    fn: async () => {
      const config = await Config.get()
      const plugins = config.plugin ?? []

      // Should contain all unique plugins
      expect(plugins.some((p) => p.includes("global-plugin-1"))).toBe(true)
      expect(plugins.some((p) => p.includes("local-plugin-1"))).toBe(true)
      expect(plugins.some((p) => p.includes("duplicate-plugin"))).toBe(true)

      // Should deduplicate the duplicate plugin
      const duplicatePlugins = plugins.filter((p) => p.includes("duplicate-plugin"))
      expect(duplicatePlugins.length).toBe(1)

      // Should have exactly 3 unique plugins
      const pluginNames = plugins.filter(
        (p) => p.includes("global-plugin") || p.includes("local-plugin") || p.includes("duplicate-plugin"),
      )
      expect(pluginNames.length).toBe(3)
    },
  })
})

// Legacy tools migration tests

test("migrates legacy tools config to permissions - allow", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          agent: {
            test: {
              tools: {
                bash: true,
                read: true,
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.agent?.["test"]?.permission).toEqual({
        bash: "allow",
        read: "allow",
      })
    },
  })
})

test("migrates legacy tools config to permissions - deny", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          agent: {
            test: {
              tools: {
                bash: false,
                webfetch: false,
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.agent?.["test"]?.permission).toEqual({
        bash: "deny",
        webfetch: "deny",
      })
    },
  })
})

test("migrates legacy write tool to edit permission", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          agent: {
            test: {
              tools: {
                write: true,
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.agent?.["test"]?.permission).toEqual({
        edit: "allow",
      })
    },
  })
})

// Managed settings tests
// Note: preload.ts sets MERAKCODE_TEST_MANAGED_CONFIG which Global.Path.managedConfig uses

test("managed settings override user settings", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        $schema: Config.SCHEMA,
        model: "user/model",
        theme: "testuser",
      })
    },
  })

  await writeManagedSettings({
    $schema: Config.SCHEMA,
    model: "managed/model",
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.model).toBe("managed/model")
      expect(config.theme).toBe("testuser")
    },
  })
})

test("managed settings override project settings", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        $schema: Config.SCHEMA,
        autoupdate: true,
        disabled_providers: [],
        theme: "dark",
      })
    },
  })

  await writeManagedSettings({
    $schema: Config.SCHEMA,
    autoupdate: false,
    disabled_providers: ["openai"],
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.autoupdate).toBe(false)
      expect(config.disabled_providers).toEqual(["openai"])
      expect(config.theme).toBe("dark")
    },
  })
})

test("missing managed settings file is not an error", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        $schema: Config.SCHEMA,
        model: "user/model",
      })
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.model).toBe("user/model")
    },
  })
})

test("migrates legacy edit tool to edit permission", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          agent: {
            test: {
              tools: {
                edit: false,
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.agent?.["test"]?.permission).toEqual({
        edit: "deny",
      })
    },
  })
})

test("migrates legacy patch tool to edit permission", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          agent: {
            test: {
              tools: {
                patch: true,
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.agent?.["test"]?.permission).toEqual({
        edit: "allow",
      })
    },
  })
})

test("migrates mixed legacy tools config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          agent: {
            test: {
              tools: {
                bash: true,
                write: true,
                read: false,
                webfetch: true,
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.agent?.["test"]?.permission).toEqual({
        bash: "allow",
        edit: "allow",
        read: "deny",
        webfetch: "allow",
      })
    },
  })
})

test("merges legacy tools with existing permission config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          agent: {
            test: {
              permission: {
                glob: "allow",
              },
              tools: {
                bash: true,
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.agent?.["test"]?.permission).toEqual({
        bash: "allow",
        glob: "allow",
      })
    },
  })
})

test("migrates deprecated permission.list from global config", async () => {
  await using tmp = await tmpdir()
  const globalConfigPath = path.join(Global.Path.config, "merakcode.json")
  await fs.mkdir(Global.Path.config, { recursive: true })
  await Filesystem.write(
    globalConfigPath,
    JSON.stringify({
      $schema: Config.SCHEMA,
      permission: {
        list: "ask",
      },
    }),
  )
  Config.global.reset()
  Config.state.invalidateAll()

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.permission?.ls).toBe("ask")
      expect((config.permission as any)?.list).toBeUndefined()
    },
  })
})

test("migrates deprecated permission.list to permission.ls while loading config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          permission: {
            list: "deny",
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect((config.permission as any)?.list).toBeUndefined()
      expect(config.permission?.ls).toBe("deny")
    },
  })
})

test("keeps permission.ls when deprecated permission.list also exists", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          permission: {
            list: "deny",
            ls: "allow",
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect((config.permission as any)?.list).toBeUndefined()
      expect(config.permission?.ls).toBe("allow")
    },
  })
})

test("preserves permission.bash deny through config loading", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          permission: {
            bash: "deny",
            read: "deny",
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.permission?.bash).toBe("deny")
      expect(config.permission?.read).toBe("deny")
      expect(
        PermissionNext.evaluate("bash", "echo review", PermissionNext.fromUserConfig(config.permission ?? {})).action,
      ).toBe("deny")
    },
  })
})

test("migrates legacy agent.tools.list to permission.ls", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          agent: {
            test: {
              tools: {
                list: false,
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.agent?.test?.permission?.ls).toBe("deny")
      expect((config.agent?.test?.permission as any)?.list).toBeUndefined()
    },
  })
})

test("migrates deprecated permission.task to permission.subagent while loading config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          permission: {
            task: "deny",
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect((config.permission as any)?.task).toBeUndefined()
      expect(config.permission?.subagent).toBe("deny")
    },
  })
})

test("keeps permission.subagent when deprecated permission.task also exists", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          permission: {
            task: "deny",
            subagent: "allow",
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect((config.permission as any)?.task).toBeUndefined()
      expect(config.permission?.subagent).toBe("allow")
    },
  })
})

test("removes deprecated internal permission keys while loading config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          permission: {
            todoread: "allow",
            todowrite: "allow",
            doom_loop: "allow",
            plan_enter: "allow",
            plan_exit: "allow",
            read: "deny",
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      const perm = config.permission as Record<string, unknown> | undefined
      expect(perm?.todoread).toBeUndefined()
      expect(perm?.todowrite).toBeUndefined()
      expect(perm?.doom_loop).toBeUndefined()
      expect(perm?.plan_enter).toBeUndefined()
      expect(perm?.plan_exit).toBeUndefined()
      expect(perm?.read).toBe("deny")
    },
  })
})

test("preserves permission.question (not a deprecated field)", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          permission: {
            question: "ask",
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect((config.permission as any)?.question).toBe("ask")
    },
  })
})

test("migrates deprecated agent.permission.list/task and removes internal keys", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          agent: {
            myagent: {
              permission: {
                list: "deny",
                task: "deny",
                bash: "deny",
                todowrite: "allow",
                doom_loop: "allow",
                plan_enter: "allow",
                read: "ask",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      const perm = config.agent?.myagent?.permission as Record<string, unknown> | undefined
      expect(perm?.list).toBeUndefined()
      expect(perm?.task).toBeUndefined()
      expect(perm?.bash).toBe("deny")
      expect(perm?.todowrite).toBeUndefined()
      expect(perm?.doom_loop).toBeUndefined()
      expect(perm?.plan_enter).toBeUndefined()
      expect(perm?.ls).toBe("deny")
      expect(perm?.subagent).toBe("deny")
      expect(perm?.read).toBe("ask")
    },
  })
})

test("migrates legacy agent.tools.task to permission.subagent", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          agent: {
            test: {
              tools: {
                task: false,
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.agent?.test?.permission?.subagent).toBe("deny")
      expect((config.agent?.test?.permission as any)?.task).toBeUndefined()
    },
  })
})

test("migrates legacy agent.tools.multiedit to edit", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          agent: {
            test: {
              tools: {
                multiedit: false,
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.agent?.test?.permission).toEqual({
        edit: "deny",
      })
    },
  })
})

test("migrates legacy top-level tools.list/task to permission.ls/subagent", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          tools: {
            list: false,
            task: true,
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.permission?.ls).toBe("deny")
      expect(config.permission?.subagent).toBe("allow")
      expect((config.permission as any)?.list).toBeUndefined()
      expect((config.permission as any)?.task).toBeUndefined()
    },
  })
})

test("migrates legacy top-level tools.multiedit to permission.edit", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          tools: {
            multiedit: false,
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.permission?.edit).toBe("deny")
    },
  })
})

test("modern config without deprecated fields is preserved as-is on load", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          permission: {
            read: "allow",
            write: "ask",
            edit: "ask",
            multi_edit: "ask",
            ls: "allow",
            grep: "allow",
            glob: "allow",
            external_directory: "ask",
            webfetch: "allow",
            websearch: "allow",
            codesearch: "allow",
            lsp: "ask",
            skill: "ask",
            mcp: "ask",
            cron: "ask",
            subagent: "ask",
            question: "ask",
          },
          agent: {
            myagent: {
              prompt: "custom",
              permission: {
                read: "deny",
                ls: "deny",
                subagent: "deny",
              },
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()

      expect(config.permission?.read).toBe("allow")
      expect(config.permission?.write).toBe("ask")
      expect(config.permission?.edit).toBe("ask")
      expect(config.permission?.multi_edit).toBe("ask")
      expect(config.permission?.ls).toBe("allow")
      expect(config.permission?.grep).toBe("allow")
      expect(config.permission?.glob).toBe("allow")
      expect(config.permission?.external_directory).toBe("ask")
      expect(config.permission?.webfetch).toBe("allow")
      expect(config.permission?.websearch).toBe("allow")
      expect(config.permission?.codesearch).toBe("allow")
      expect(config.permission?.lsp).toBe("ask")
      expect(config.permission?.skill).toBe("ask")
      expect(config.permission?.mcp).toBe("ask")
      expect(config.permission?.cron).toBe("ask")
      expect(config.permission?.subagent).toBe("ask")
      expect((config.permission as any)?.question).toBe("ask")

      expect(config.agent?.myagent?.permission?.read).toBe("deny")
      expect(config.agent?.myagent?.permission?.ls).toBe("deny")
      expect(config.agent?.myagent?.permission?.subagent).toBe("deny")
    },
  })
})

test("modern JSONC config is not rewritten beyond the requested partial", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.jsonc"),
        `{
  "$schema": "${Config.SCHEMA}",
  "permission": {
    "read": "allow",
    "ls": "allow",
    "subagent": "ask",
    "question": "ask"
  },
  "agent": {
    "myagent": {
      "permission": {
        "ls": "deny",
        "subagent": "deny"
      }
    }
  }
}`,
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Triggers the write-back path with a partial that only adds theme
      await Config.updateProjectMerakCode({ theme: "tester" }, { skipDispose: true })
      const content = await Filesystem.readText(path.join(tmp.path, "merakcode.jsonc"))

      expect(content).toMatch(/"read"\s*:\s*"allow"/)
      expect(content).toMatch(/"ls"\s*:\s*"allow"/)
      expect(content).toMatch(/"subagent"\s*:\s*"ask"/)
      expect(content).toMatch(/"question"\s*:\s*"ask"/)

      expect(content).toMatch(/"theme"\s*:\s*"tester"/)

      // Nested agent.permission is left intact
      expect(content).toMatch(/"ls"\s*:\s*"deny"/)
      expect(content).toMatch(/"subagent"\s*:\s*"deny"/)

      const config = await Config.loadProjectMerakCodeFile()
      expect(config.theme).toBe("tester")
      expect(config.permission?.read).toBe("allow")
      expect(config.permission?.ls).toBe("allow")
      expect(config.permission?.subagent).toBe("ask")
      expect((config.permission as any)?.question).toBe("ask")
      expect(config.agent?.myagent?.permission?.ls).toBe("deny")
      expect(config.agent?.myagent?.permission?.subagent).toBe("deny")
    },
  })
})

test("normalizes deprecated JSONC fields on project config write", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.jsonc"),
        `{
  "$schema": "${Config.SCHEMA}",
  "permission": {
    "list": "deny",
    "task": "allow",
    "bash": "deny",
    "todowrite": "allow"
  },
  "agent": {
    "myagent": {
      "permission": {
        "list": "deny",
        "task": "deny",
        "bash": "deny",
        "todowrite": "allow"
      }
    }
  }
}`,
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Config.updateProjectMerakCode({ theme: "tester" }, { skipDispose: true })
      const content = await Filesystem.readText(path.join(tmp.path, "merakcode.jsonc"))

      // Deprecated top-level keys are migrated (list -> ls, task -> subagent) or removed (todowrite); bash deny stays.
      expect(content).not.toMatch(/"list"\s*:/)
      expect(content).not.toMatch(/"task"\s*:/)
      expect(content).not.toMatch(/"todowrite"\s*:/)
      expect(content).toMatch(/"bash"\s*:\s*"deny"/)

      expect(content).toMatch(/"ls"\s*:\s*"deny"/)
      expect(content).toMatch(/"subagent"\s*:\s*"allow"/)

      const config = await Config.loadProjectMerakCodeFile()
      expect(config.theme).toBe("tester")
      expect(config.permission?.ls).toBe("deny")
      expect(config.permission?.subagent).toBe("allow")
      expect(config.permission?.bash).toBe("deny")
      expect((config.permission as any)?.todowrite).toBeUndefined()

      // Nested agent.permission is migrated the same way and keeps bash deny
      const agentPerm = config.agent?.myagent?.permission as Record<string, unknown> | undefined
      expect(agentPerm?.ls).toBe("deny")
      expect(agentPerm?.subagent).toBe("deny")
      expect(agentPerm?.list).toBeUndefined()
      expect(agentPerm?.task).toBeUndefined()
      expect(agentPerm?.bash).toBe("deny")
      expect(agentPerm?.todowrite).toBeUndefined()
    },
  })
})

test("permission config preserves key order", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          permission: {
            "*": "deny",
            edit: "ask",
            write: "ask",
            external_directory: "ask",
            read: "allow",
            "thoughts_*": "allow",
            "reasoning_model_*": "allow",
            "tools_*": "allow",
            "pr_comments_*": "allow",
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(Object.keys(config.permission!)).toEqual([
        "ls",
        "*",
        "edit",
        "write",
        "external_directory",
        "read",
        "thoughts_*",
        "reasoning_model_*",
        "tools_*",
        "pr_comments_*",
      ])
    },
  })
})

// MCP config merging tests

test("project config can override MCP server enabled status", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      // Simulates a base config (like from remote .well-known) with disabled MCP
      await Filesystem.write(
        path.join(dir, "merakcode.jsonc"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          mcp: {
            jira: {
              type: "remote",
              url: "https://jira.example.com/mcp",
              enabled: false,
            },
            wiki: {
              type: "remote",
              url: "https://wiki.example.com/mcp",
              enabled: false,
            },
          },
        }),
      )
      // Project config enables just jira
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          mcp: {
            jira: {
              type: "remote",
              url: "https://jira.example.com/mcp",
              enabled: true,
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      // jira should be enabled (overridden by project config)
      expect(config.mcp?.jira).toEqual({
        type: "remote",
        url: "https://jira.example.com/mcp",
        enabled: true,
      })
      // wiki should still be disabled (not overridden)
      expect(config.mcp?.wiki).toEqual({
        type: "remote",
        url: "https://wiki.example.com/mcp",
        enabled: false,
      })
    },
  })
})

test("MCP config deep merges preserving base config properties", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      // Base config with full MCP definition
      await Filesystem.write(
        path.join(dir, "merakcode.jsonc"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          mcp: {
            myserver: {
              type: "remote",
              url: "https://myserver.example.com/mcp",
              enabled: false,
              headers: {
                "X-Custom-Header": "value",
              },
            },
          },
        }),
      )
      // Override just enables it, should preserve other properties
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          mcp: {
            myserver: {
              type: "remote",
              url: "https://myserver.example.com/mcp",
              enabled: true,
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.mcp?.myserver).toEqual({
        type: "remote",
        url: "https://myserver.example.com/mcp",
        enabled: true,
        headers: {
          "X-Custom-Header": "value",
        },
      })
    },
  })
})

test("local .merakcode config can override MCP from project config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      // Project config with disabled MCP
      await Filesystem.write(
        path.join(dir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          mcp: {
            docs: {
              type: "remote",
              url: "https://docs.example.com/mcp",
              enabled: false,
            },
          },
        }),
      )
      // Local .merakcode directory config enables it
      const merakCodeDir = path.join(dir, ".merakcode")
      await fs.mkdir(merakCodeDir, { recursive: true })
      await Filesystem.write(
        path.join(merakCodeDir, "merakcode.json"),
        JSON.stringify({
          $schema: Config.SCHEMA,
          mcp: {
            docs: {
              type: "remote",
              url: "https://docs.example.com/mcp",
              enabled: true,
            },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.mcp?.docs?.enabled).toBe(true)
    },
  })
})

test("project config overrides remote well-known config", async () => {
  const originalFetch = globalThis.fetch
  let fetchedUrl: string | undefined
  const mockFetch = vi.fn((url: string | URL | Request) => {
    const urlStr = url.toString()
    if (urlStr.includes(".well-known/merakcode")) {
      fetchedUrl = urlStr
      return Promise.resolve(
        new Response(
          JSON.stringify({
            config: {
              mcp: {
                jira: {
                  type: "remote",
                  url: "https://jira.example.com/mcp",
                  enabled: false,
                },
              },
            },
          }),
          { status: 200 },
        ),
      )
    }
    return originalFetch(url)
  })
  globalThis.fetch = mockFetch as unknown as typeof fetch

  const originalAuthAll = Auth.all
  Auth.all = vi.fn(() =>
    Promise.resolve({
      "https://example.com": {
        type: "wellknown" as const,
        key: "TEST_TOKEN",
        token: "test-token",
      },
    }),
  )

  try {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        // Project config enables jira (overriding remote default)
        await Filesystem.write(
          path.join(dir, "merakcode.json"),
          JSON.stringify({
            $schema: Config.SCHEMA,
            mcp: {
              jira: {
                type: "remote",
                url: "https://jira.example.com/mcp",
                enabled: true,
              },
            },
          }),
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        // Verify fetch was called for wellknown config
        expect(fetchedUrl).toBe("https://example.com/.well-known/merakcode")
        // Project config (enabled: true) should override remote (enabled: false)
        expect(config.mcp?.jira?.enabled).toBe(true)
      },
    })
  } finally {
    globalThis.fetch = originalFetch
    Auth.all = originalAuthAll
  }
})

describe("getPluginName", () => {
  test("extracts name from file:// URL", () => {
    expect(Config.getPluginName("file:///path/to/plugin/foo.js")).toBe("foo")
    expect(Config.getPluginName("file:///path/to/plugin/bar.ts")).toBe("bar")
    expect(Config.getPluginName("file:///some/path/my-plugin.js")).toBe("my-plugin")
  })

  test("extracts name from npm package with version", () => {
    expect(Config.getPluginName("oh-my-merakcode@2.4.3")).toBe("oh-my-merakcode")
    expect(Config.getPluginName("some-plugin@1.0.0")).toBe("some-plugin")
    expect(Config.getPluginName("plugin@latest")).toBe("plugin")
  })

  test("extracts name from scoped npm package", () => {
    expect(Config.getPluginName("@scope/pkg@1.0.0")).toBe("@scope/pkg")
    expect(Config.getPluginName("@acme/merakcode-plugin@2.0.0")).toBe("@acme/merakcode-plugin")
  })

  test("returns full string for package without version", () => {
    expect(Config.getPluginName("some-plugin")).toBe("some-plugin")
    expect(Config.getPluginName("@scope/pkg")).toBe("@scope/pkg")
  })
})

describe("deduplicatePlugins", () => {
  test("removes duplicates keeping higher priority (later entries)", () => {
    const plugins = ["global-plugin@1.0.0", "shared-plugin@1.0.0", "local-plugin@2.0.0", "shared-plugin@2.0.0"]

    const result = Config.deduplicatePlugins(plugins)

    expect(result).toContain("global-plugin@1.0.0")
    expect(result).toContain("local-plugin@2.0.0")
    expect(result).toContain("shared-plugin@2.0.0")
    expect(result).not.toContain("shared-plugin@1.0.0")
    expect(result.length).toBe(3)
  })

  test("prefers local file over npm package with same name", () => {
    const plugins = ["oh-my-merakcode@2.4.3", "file:///project/.merakcode/plugin/oh-my-merakcode.js"]

    const result = Config.deduplicatePlugins(plugins)

    expect(result.length).toBe(1)
    expect(result[0]).toBe("file:///project/.merakcode/plugin/oh-my-merakcode.js")
  })

  test("preserves order of remaining plugins", () => {
    const plugins = ["a-plugin@1.0.0", "b-plugin@1.0.0", "c-plugin@1.0.0"]

    const result = Config.deduplicatePlugins(plugins)

    expect(result).toEqual(["a-plugin@1.0.0", "b-plugin@1.0.0", "c-plugin@1.0.0"])
  })

  test("local plugin directory overrides global merakcode.json plugin", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const projectDir = path.join(dir, "project")
        const merakCodeDir = path.join(projectDir, ".merakcode")
        const pluginDir = path.join(merakCodeDir, "plugin")
        await fs.mkdir(pluginDir, { recursive: true })

        await Filesystem.write(
          path.join(dir, "merakcode.json"),
          JSON.stringify({
            $schema: Config.SCHEMA,
            plugin: ["my-plugin@1.0.0"],
          }),
        )

        await Filesystem.write(path.join(pluginDir, "my-plugin.js"), "export default {}")
      },
    })

    await Instance.provide({
      directory: path.join(tmp.path, "project"),
      fn: async () => {
        const config = await Config.get()
        const plugins = config.plugin ?? []

        const myPlugins = plugins
          .map((entry) => Config.pluginSpecifier(entry))
          .filter((spec) => Config.getPluginName(spec) === "my-plugin")
        expect(myPlugins.length).toBe(1)
        expect(myPlugins[0]!.startsWith("file://")).toBe(true)
      },
    })
  })
})

describe("MERAKCODE_DISABLE_PROJECT_CONFIG", () => {
  test("skips project config files when flag is set", async () => {
    const originalEnv = process.env["MERAKCODE_DISABLE_PROJECT_CONFIG"]
    process.env["MERAKCODE_DISABLE_PROJECT_CONFIG"] = "true"

    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          // Create a project config that would normally be loaded
          await Filesystem.write(
            path.join(dir, "merakcode.json"),
            JSON.stringify({
              $schema: Config.SCHEMA,
              model: "project/model",
              theme: "project-user",
            }),
          )
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const config = await Config.get()
          // Project config should NOT be loaded - model should be default, not "project/model"
          expect(config.model).not.toBe("project/model")
          expect(config.theme).not.toBe("project-user")
        },
      })
    } finally {
      if (originalEnv === undefined) {
        delete process.env["MERAKCODE_DISABLE_PROJECT_CONFIG"]
      } else {
        process.env["MERAKCODE_DISABLE_PROJECT_CONFIG"] = originalEnv
      }
    }
  })

  test("skips project .merakcode/ directories when flag is set", async () => {
    const originalEnv = process.env["MERAKCODE_DISABLE_PROJECT_CONFIG"]
    process.env["MERAKCODE_DISABLE_PROJECT_CONFIG"] = "true"

    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          // Create a .merakcode directory with a command
          const merakCodeDir = path.join(dir, ".merakcode", "command")
          await fs.mkdir(merakCodeDir, { recursive: true })
          await Filesystem.write(path.join(merakCodeDir, "test-cmd.md"), "# Test Command\nThis is a test command.")
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const directories = await Config.directories()
          // Project .merakcode should NOT be in directories list
          const hasProjectMerakCode = directories.some((d) => d.startsWith(tmp.path))
          expect(hasProjectMerakCode).toBe(false)
        },
      })
    } finally {
      if (originalEnv === undefined) {
        delete process.env["MERAKCODE_DISABLE_PROJECT_CONFIG"]
      } else {
        process.env["MERAKCODE_DISABLE_PROJECT_CONFIG"] = originalEnv
      }
    }
  })

  test("still loads global config when flag is set", async () => {
    const originalEnv = process.env["MERAKCODE_DISABLE_PROJECT_CONFIG"]
    process.env["MERAKCODE_DISABLE_PROJECT_CONFIG"] = "true"

    try {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // Should still get default config (from global or defaults)
          const config = await Config.get()
          expect(config).toBeDefined()
          expect(config.keybinds).toBeDefined()
        },
      })
    } finally {
      if (originalEnv === undefined) {
        delete process.env["MERAKCODE_DISABLE_PROJECT_CONFIG"]
      } else {
        process.env["MERAKCODE_DISABLE_PROJECT_CONFIG"] = originalEnv
      }
    }
  })

  test("skips relative instructions with warning when flag is set but no config dir", async () => {
    const originalDisable = process.env["MERAKCODE_DISABLE_PROJECT_CONFIG"]
    const originalConfigDir = process.env["MERAKCODE_CONFIG_DIR"]

    try {
      // Ensure no config dir is set
      delete process.env["MERAKCODE_CONFIG_DIR"]
      process.env["MERAKCODE_DISABLE_PROJECT_CONFIG"] = "true"

      await using tmp = await tmpdir({
        init: async (dir) => {
          // Create a config with relative instruction path
          await Filesystem.write(
            path.join(dir, "merakcode.json"),
            JSON.stringify({
              $schema: Config.SCHEMA,
              instructions: ["./CUSTOM.md"],
            }),
          )
          // Create the instruction file (should be skipped)
          await Filesystem.write(path.join(dir, "CUSTOM.md"), "# Custom Instructions")
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // The relative instruction should be skipped without error
          // We're mainly verifying this doesn't throw and the config loads
          const config = await Config.get()
          expect(config).toBeDefined()
          // The instruction should have been skipped (warning logged)
          // We can't easily test the warning was logged, but we verify
          // the relative path didn't cause an error
        },
      })
    } finally {
      if (originalDisable === undefined) {
        delete process.env["MERAKCODE_DISABLE_PROJECT_CONFIG"]
      } else {
        process.env["MERAKCODE_DISABLE_PROJECT_CONFIG"] = originalDisable
      }
      if (originalConfigDir === undefined) {
        delete process.env["MERAKCODE_CONFIG_DIR"]
      } else {
        process.env["MERAKCODE_CONFIG_DIR"] = originalConfigDir
      }
    }
  })

  test("MERAKCODE_CONFIG_DIR still works when flag is set", async () => {
    const originalDisable = process.env["MERAKCODE_DISABLE_PROJECT_CONFIG"]
    const originalConfigDir = process.env["MERAKCODE_CONFIG_DIR"]

    try {
      await using configDirTmp = await tmpdir({
        init: async (dir) => {
          // Create config in the custom config dir
          await Filesystem.write(
            path.join(dir, "merakcode.json"),
            JSON.stringify({
              $schema: Config.SCHEMA,
              model: "configdir/model",
            }),
          )
        },
      })

      await using projectTmp = await tmpdir({
        init: async (dir) => {
          // Create config in project (should be ignored)
          await Filesystem.write(
            path.join(dir, "merakcode.json"),
            JSON.stringify({
              $schema: Config.SCHEMA,
              model: "project/model",
            }),
          )
        },
      })

      process.env["MERAKCODE_DISABLE_PROJECT_CONFIG"] = "true"
      process.env["MERAKCODE_CONFIG_DIR"] = configDirTmp.path

      await Instance.provide({
        directory: projectTmp.path,
        fn: async () => {
          const config = await Config.get()
          // Should load from MERAKCODE_CONFIG_DIR, not project
          expect(config.model).toBe("configdir/model")
        },
      })
    } finally {
      if (originalDisable === undefined) {
        delete process.env["MERAKCODE_DISABLE_PROJECT_CONFIG"]
      } else {
        process.env["MERAKCODE_DISABLE_PROJECT_CONFIG"] = originalDisable
      }
      if (originalConfigDir === undefined) {
        delete process.env["MERAKCODE_CONFIG_DIR"]
      } else {
        process.env["MERAKCODE_CONFIG_DIR"] = originalConfigDir
      }
    }
  })
})

describe("deleteProvider", () => {
  test("removes the provider key from project config", async () => {
    await using tmp = await tmpdir({
      config: {
        provider: {
          myllm: {
            npm: "@ai-sdk/openai-compatible",
            name: "My LLM",
            models: { m1: { name: "M1" } },
          },
          other: {
            npm: "@ai-sdk/openai-compatible",
            name: "Other",
            models: { x: { name: "X" } },
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Config.deleteProvider("myllm", "project")
        const written = await Filesystem.readText(path.join(tmp.path, "merakcode.json"))
        expect(written).not.toContain("myllm")
        expect(written).toContain("other")
        const config = await Config.get()
        expect(config.provider?.["myllm"]).toBeUndefined()
        expect(config.provider?.["other"]).toBeDefined()
      },
    })
  })

  test("deleteProvider clears model references to it and leaves other providers alone", async () => {
    await using tmp = await tmpdir({
      config: {
        model: "myllm/m1",
        small_model: "other/x",
        provider: {
          myllm: {
            npm: "@ai-sdk/openai-compatible",
            name: "My LLM",
            models: { m1: { name: "M1" }, m2: { name: "M2" } },
          },
          other: { npm: "@ai-sdk/openai-compatible", name: "O", models: { x: { name: "X" } } },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Config.deleteProvider("myllm", "project")
        const config = await Config.get()
        expect(config.model).toBeUndefined()
        expect(config.small_model).toBe("other/x")
      },
    })
  })

  test("deleteProvider clears dangling agent model references", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          build: { model: "myllm/m1" },
          custom: { model: "other/x" },
        },
        provider: {
          myllm: {
            npm: "@ai-sdk/openai-compatible",
            name: "My LLM",
            models: { m1: { name: "M1" }, m2: { name: "M2" }, m3: { name: "M3" } },
          },
          other: { npm: "@ai-sdk/openai-compatible", name: "O", models: { x: { name: "X" }, y: { name: "Y" } } },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Config.deleteProvider("myllm", "project")
        const config = await Config.get()
        expect(config.agent?.build?.model).toBeUndefined()
        expect(config.agent?.custom?.model).toBe("other/x")
      },
    })
  })

  test("deleteProvider preserves JSONC comments", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(
          path.join(dir, "merakcode.json"),
          `{
  // provider block
  "provider": {
    "myllm": { "npm": "@ai-sdk/openai-compatible", "name": "My", "models": { "m": { "name": "M" } } }
  }
}`,
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Config.deleteProvider("myllm", "project")
        const written = await Filesystem.readText(path.join(tmp.path, "merakcode.json"))
        expect(written).toContain("// provider block")
        expect(written).not.toContain("myllm")
      },
    })
  })

  test("clearReferences=false keeps references (edit flow deletes then rewrites)", async () => {
    await using tmp = await tmpdir({
      config: {
        model: "myllm/m1",
        small_model: "myllm/m2",
        agent: { build: { model: "myllm/m1" } },
        provider: {
          myllm: {
            npm: "@ai-sdk/openai-compatible",
            name: "My LLM",
            models: { m1: { name: "M1" }, m2: { name: "M2" } },
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Config.deleteProvider("myllm", "project", { clearReferences: false })
        const config = await Config.get()
        expect(config.provider?.["myllm"]).toBeUndefined()
        expect(config.model).toBe("myllm/m1")
        expect(config.small_model).toBe("myllm/m2")
        expect(config.agent?.build?.model).toBe("myllm/m1")
      },
    })
  })
})

describe("deleteProviderModel", () => {
  test("deletes a single model under a provider and clears its references", async () => {
    await using tmp = await tmpdir({
      config: {
        model: "myllm/m1",
        small_model: "myllm/m2",
        provider: {
          myllm: {
            npm: "@ai-sdk/openai-compatible",
            name: "My LLM",
            models: { m1: { name: "M1" }, m2: { name: "M2" } },
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Config.deleteProviderModel("myllm", "m1", "project")
        const config = await Config.get()
        expect(config.provider?.["myllm"]?.models?.["m1"]).toBeUndefined()
        expect(config.provider?.["myllm"]?.models?.["m2"]).toBeDefined()
        expect(config.model).toBeUndefined()
        expect(config.small_model).toBe("myllm/m2")
      },
    })
  })

  test("deleting a missing model is a no-op", async () => {
    await using tmp = await tmpdir({
      config: {
        provider: {
          myllm: { npm: "@ai-sdk/openai-compatible", name: "My", models: { m: { name: "M" } } },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Config.deleteProviderModel("myllm", "ghost", "project")
        expect(Object.keys((await Config.get()).provider?.["myllm"]?.models ?? {})).toEqual(["m"])
      },
    })
  })
})
