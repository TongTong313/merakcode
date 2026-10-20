import { describe, expect, test } from "vitest"
import path from "path"
import fs from "fs/promises"
import { Rule } from "@merakcode/engine/rule/rule"
import { RuleWatch } from "@merakcode/engine/rule/watch"
import { Instance } from "@merakcode/engine/project/instance"
import { tmpdir } from "../fixture/fixture"
import { cursorRule, isolate, nativeRule } from "./isolate"
import { Filesystem } from "@merakcode/util/filesystem"

describe("RuleWatch", () => {
  test("flushGlobal returns true when changes are pending", async () => {
    RuleWatch.__testingQueueGlobal()
    expect(await RuleWatch.__testingFlushGlobal()).toBe(true)
  })

  test("flushGlobal returns false on an empty queue", async () => {
    expect(await RuleWatch.__testingFlushGlobal()).toBe(false)
  })

  test("flushProject invalidates the cache so Rule.all reflects deletions on disk", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: (dir) => nativeRule(dir, "watch-rule.mdc", "alwaysApply: true"),
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect((await Rule.all()).some((rule) => rule.name === "watch-rule")).toBe(true)

          await fs.rm(path.join(tmp.path, ".merakcode", "rules", "watch-rule.mdc"), { force: true })
          expect((await Rule.all()).some((rule) => rule.name === "watch-rule")).toBe(true)

          RuleWatch.__testingQueueProject(Instance.directory)
          expect(await RuleWatch.__testingFlushProject(Instance.directory)).toBe(true)
          expect((await Rule.all()).some((rule) => rule.name === "watch-rule")).toBe(false)
        },
      })
    })
  })

  test("snapshot detects a previously missing .cursor/rules being created", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: (dir) => nativeRule(dir, "native.mdc", "alwaysApply: true"),
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const before = await RuleWatch.__testingSnapshot()
          await cursorRule(tmp.path, "legacy.mdc", "alwaysApply: true")
          const after = await RuleWatch.__testingSnapshot()
          expect(RuleWatch.__testingDiffers(before, after)).toBe(true)
          expect([...after.keys()].some((filepath) => filepath.endsWith("legacy.mdc"))).toBe(true)
        },
      })
    })
  })

  test("snapshot detects AGENTS.md being created and deleted", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: (dir) => nativeRule(dir, "native.mdc", "alwaysApply: true"),
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const agents = path.join(tmp.path, "AGENTS.md")
          const before = await RuleWatch.__testingSnapshot()
          await Filesystem.write(agents, "# project\n")
          const created = await RuleWatch.__testingSnapshot()
          expect(RuleWatch.__testingDiffers(before, created)).toBe(true)
          expect([...created.keys()].some((filepath) => path.basename(filepath) === "AGENTS.md")).toBe(true)

          await fs.rm(agents, { force: true })
          const removed = await RuleWatch.__testingSnapshot()
          expect(RuleWatch.__testingDiffers(created, removed)).toBe(true)
          expect([...removed.keys()].some((filepath) => path.basename(filepath) === "AGENTS.md")).toBe(false)
        },
      })
    })
  })

  test("after flush, an empty .cursor/rules is not shadowed; only one with .mdc files is", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await nativeRule(dir, "native.mdc", "alwaysApply: true")
          await fs.mkdir(path.join(dir, ".cursor", "rules"), { recursive: true })
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect(await Rule.shadowed()).toEqual([])

          await cursorRule(tmp.path, "legacy.mdc", "alwaysApply: true")
          expect(await Rule.shadowed()).toEqual([])
          RuleWatch.__testingQueueProject(Instance.directory)
          expect(await RuleWatch.__testingFlushProject(Instance.directory)).toBe(true)
          expect((await Rule.shadowed()).length).toBe(1)

          await fs.rm(path.join(tmp.path, ".cursor", "rules", "legacy.mdc"), { force: true })
          RuleWatch.__testingQueueProject(Instance.directory)
          expect(await RuleWatch.__testingFlushProject(Instance.directory)).toBe(true)
          expect(await Rule.shadowed()).toEqual([])
        },
      })
    })
  })
})
