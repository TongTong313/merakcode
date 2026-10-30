import { afterEach, beforeEach, describe, expect, test } from "vitest"
import path from "path"
import { InstructionPrompt } from "@merakcode/engine/agent/context/instruction"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { Global } from "@merakcode/engine/infra/global/index"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

describe("InstructionPrompt.resolve", () => {
  test("returns empty when AGENTS.md is at project root (already in systemPaths)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "AGENTS.md"), "# Root Instructions")
        await Filesystem.write(path.join(dir, "src", "file.ts"), "const x = 1")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const system = await InstructionPrompt.systemPaths()
        expect(system.has(path.join(tmp.path, "AGENTS.md"))).toBe(true)

        const results = await InstructionPrompt.resolve([], path.join(tmp.path, "src", "file.ts"), "test-message-1")
        expect(results).toEqual([])
      },
    })
  })

  test("returns AGENTS.md from subdirectory (not in systemPaths)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "subdir", "AGENTS.md"), "# Subdir Instructions")
        await Filesystem.write(path.join(dir, "subdir", "nested", "file.ts"), "const x = 1")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const system = await InstructionPrompt.systemPaths()
        expect(system.has(path.join(tmp.path, "subdir", "AGENTS.md"))).toBe(false)

        const results = await InstructionPrompt.resolve(
          [],
          path.join(tmp.path, "subdir", "nested", "file.ts"),
          "test-message-2",
        )
        expect(results.length).toBe(1)
        expect(results[0].filepath).toBe(path.join(tmp.path, "subdir", "AGENTS.md"))
      },
    })
  })

  test("doesn't reload AGENTS.md when reading it directly", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "subdir", "AGENTS.md"), "# Subdir Instructions")
        await Filesystem.write(path.join(dir, "subdir", "nested", "file.ts"), "const x = 1")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const filepath = path.join(tmp.path, "subdir", "AGENTS.md")
        const system = await InstructionPrompt.systemPaths()
        expect(system.has(filepath)).toBe(false)

        const results = await InstructionPrompt.resolve([], filepath, "test-message-2")
        expect(results).toEqual([])
      },
    })
  })

  test("multi-root: loads AGENTS.md from each workspace folder", async () => {
    await using a = await tmpdir({
      git: true,
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "AGENTS.md"), "# Alpha")
      },
    })
    await using b = await tmpdir({
      git: true,
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "AGENTS.md"), "# Beta")
      },
    })
    await Instance.provide({
      directory: a.path,
      workspace: {
        folders: [
          { name: "alpha", path: a.path },
          { name: "beta", path: b.path },
        ],
      },
      fn: async () => {
        const system = await InstructionPrompt.systemPaths()
        expect(system.has(path.join(a.path, "AGENTS.md"))).toBe(true)
        expect(system.has(path.join(b.path, "AGENTS.md"))).toBe(true)
      },
    })
  })

  test("falls back to CLAUDE.md when AGENTS.md doesn't exist", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "CLAUDE.md"), "# Claude Instructions")
        await Filesystem.write(path.join(dir, "src", "file.ts"), "const x = 1")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const system = await InstructionPrompt.systemPaths()
        expect(system.has(path.join(tmp.path, "CLAUDE.md"))).toBe(true)
      },
    })
  })

  // Concatenation order is the only way to say "more specific wins", so later entries must be deeper directories.
  test("orders results from general to specific", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "a", "AGENTS.md"), "# Shallow")
        await Filesystem.write(path.join(dir, "a", "b", "AGENTS.md"), "# Deep")
        await Filesystem.write(path.join(dir, "a", "b", "file.ts"), "const x = 1")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const results = await InstructionPrompt.resolve([], path.join(tmp.path, "a", "b", "file.ts"), "test-order")
        expect(results.map((r) => r.filepath)).toEqual([
          path.join(tmp.path, "a", "AGENTS.md"),
          path.join(tmp.path, "a", "b", "AGENTS.md"),
        ])
      },
    })
  })

  test("includeSelf walks up starting from the directory itself", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "a", "AGENTS.md"), "# Dir")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const withoutSelf = await InstructionPrompt.resolve([], path.join(tmp.path, "a"), "test-self-off")
        expect(withoutSelf).toEqual([])

        const withSelf = await InstructionPrompt.resolve([], path.join(tmp.path, "a"), "test-self-on", {
          includeSelf: true,
        })
        expect(withSelf.map((r) => r.filepath)).toEqual([path.join(tmp.path, "a", "AGENTS.md")])
      },
    })
  })
})

describe("InstructionPrompt.systemPaths ordering", () => {
  // Each directory picks its own first existing AGENTS/CLAUDE file; picking one filename for the whole chain made an
  // AGENTS.md in a parent hide every CLAUDE.md below it.
  test("picks the first existing filename per directory, not per chain", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "AGENTS.md"), "# Root")
        await Filesystem.write(path.join(dir, "pkg", "CLAUDE.md"), "# Package")
      },
    })
    await Instance.provide({
      directory: path.join(tmp.path, "pkg"),
      fn: async () => {
        const paths = await InstructionPrompt.systemPaths()
        expect(paths.has(path.join(tmp.path, "AGENTS.md"))).toBe(true)
        expect(paths.has(path.join(tmp.path, "pkg", "CLAUDE.md"))).toBe(true)
      },
    })
  })

  test("emits shallow directories before deep ones", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "AGENTS.md"), "# Root")
        await Filesystem.write(path.join(dir, "pkg", "AGENTS.md"), "# Package")
      },
    })
    await Instance.provide({
      directory: path.join(tmp.path, "pkg"),
      fn: async () => {
        const paths = Array.from(await InstructionPrompt.systemPaths())
        expect(paths.indexOf(path.join(tmp.path, "AGENTS.md"))).toBeLessThan(
          paths.indexOf(path.join(tmp.path, "pkg", "AGENTS.md")),
        )
      },
    })
  })
})

describe("InstructionPrompt.system", () => {
  test("loads global CLAUDE.md from the isolated home", async () => {
    await using home = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, ".claude", "CLAUDE.md"), "# Isolated global instructions")
      },
    })
    await using tmp = await tmpdir()
    const original = process.env.MERAKCODE_TEST_HOME
    process.env.MERAKCODE_TEST_HOME = home.path
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const blocks = await InstructionPrompt.system()
          expect(blocks.join("\n")).toContain("# Isolated global instructions")
          expect(await InstructionPrompt.systemPaths()).toContain(path.join(home.path, ".claude", "CLAUDE.md"))
        },
      })
    } finally {
      if (original === undefined) delete process.env.MERAKCODE_TEST_HOME
      else process.env.MERAKCODE_TEST_HOME = original
    }
  })

  test("prepends the precedence note when instructions exist", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "AGENTS.md"), "# Root")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const blocks = await InstructionPrompt.system()
        expect(blocks[0]).toBe(InstructionPrompt.PRECEDENCE_NOTE)
        expect(blocks.length).toBeGreaterThan(1)
      },
    })
  })

  // Without instructions, the precedence note must not be left on its own.
  test("stays empty when there are no instructions", async () => {
    await using globalTmp = await tmpdir()
    await using tmp = await tmpdir()

    const originalConfigDir = process.env["MERAKCODE_CONFIG_DIR"]
    delete process.env["MERAKCODE_CONFIG_DIR"]
    const originalGlobalConfig = Global.Path.config
    ;(Global.Path as { config: string }).config = globalTmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect(await InstructionPrompt.system()).toEqual([])
        },
      })
    } finally {
      ;(Global.Path as { config: string }).config = originalGlobalConfig
      if (originalConfigDir !== undefined) process.env["MERAKCODE_CONFIG_DIR"] = originalConfigDir
    }
  })
})

describe("InstructionPrompt.systemPaths MERAKCODE_CONFIG_DIR", () => {
  let originalConfigDir: string | undefined

  beforeEach(() => {
    originalConfigDir = process.env["MERAKCODE_CONFIG_DIR"]
  })

  afterEach(() => {
    if (originalConfigDir === undefined) {
      delete process.env["MERAKCODE_CONFIG_DIR"]
    } else {
      process.env["MERAKCODE_CONFIG_DIR"] = originalConfigDir
    }
  })

  test("prefers MERAKCODE_CONFIG_DIR AGENTS.md over global when both exist", async () => {
    await using profileTmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "AGENTS.md"), "# Profile Instructions")
      },
    })
    await using globalTmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "AGENTS.md"), "# Global Instructions")
      },
    })
    await using projectTmp = await tmpdir()

    process.env["MERAKCODE_CONFIG_DIR"] = profileTmp.path
    const originalGlobalConfig = Global.Path.config
    ;(Global.Path as { config: string }).config = globalTmp.path

    try {
      await Instance.provide({
        directory: projectTmp.path,
        fn: async () => {
          const paths = await InstructionPrompt.systemPaths()
          expect(paths.has(path.join(profileTmp.path, "AGENTS.md"))).toBe(true)
          expect(paths.has(path.join(globalTmp.path, "AGENTS.md"))).toBe(false)
        },
      })
    } finally {
      ;(Global.Path as { config: string }).config = originalGlobalConfig
    }
  })

  test("falls back to global AGENTS.md when MERAKCODE_CONFIG_DIR has no AGENTS.md", async () => {
    await using profileTmp = await tmpdir()
    await using globalTmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "AGENTS.md"), "# Global Instructions")
      },
    })
    await using projectTmp = await tmpdir()

    process.env["MERAKCODE_CONFIG_DIR"] = profileTmp.path
    const originalGlobalConfig = Global.Path.config
    ;(Global.Path as { config: string }).config = globalTmp.path

    try {
      await Instance.provide({
        directory: projectTmp.path,
        fn: async () => {
          const paths = await InstructionPrompt.systemPaths()
          expect(paths.has(path.join(profileTmp.path, "AGENTS.md"))).toBe(false)
          expect(paths.has(path.join(globalTmp.path, "AGENTS.md"))).toBe(true)
        },
      })
    } finally {
      ;(Global.Path as { config: string }).config = originalGlobalConfig
    }
  })

  test("uses global AGENTS.md when MERAKCODE_CONFIG_DIR is not set", async () => {
    await using globalTmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "AGENTS.md"), "# Global Instructions")
      },
    })
    await using projectTmp = await tmpdir()

    delete process.env["MERAKCODE_CONFIG_DIR"]
    const originalGlobalConfig = Global.Path.config
    ;(Global.Path as { config: string }).config = globalTmp.path

    try {
      await Instance.provide({
        directory: projectTmp.path,
        fn: async () => {
          const paths = await InstructionPrompt.systemPaths()
          expect(paths.has(path.join(globalTmp.path, "AGENTS.md"))).toBe(true)
        },
      })
    } finally {
      ;(Global.Path as { config: string }).config = originalGlobalConfig
    }
  })
})
