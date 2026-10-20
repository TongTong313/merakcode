import { describe, expect, test } from "vitest"
import fs from "fs/promises"
import path from "path"
import { MemoryManage } from "@merakcode/engine/memory/manage"
import { MemoryPath } from "@merakcode/engine/memory/path"
import { MemoryPrompt } from "@merakcode/engine/memory/prompt"
import { MemoryRecall } from "@merakcode/engine/memory/recall"
import { Instance } from "@merakcode/engine/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

/**
 * Extraction defaults to signals (extract only when needed) and recall defaults to off. Without an Instance nothing
 * is injected, so tests without context do not turn memory on by accident.
 */
describe("memory defaults", () => {
  test("does not recall or inject memory instructions without an Instance", async () => {
    expect(await MemoryRecall.enabled()).toBe(false)
    expect(await MemoryPrompt.maybeSystem()).toEqual([])
  })

  test("extraction is on by default, so memory instructions are injected while recall stays off", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await MemoryRecall.enabled()).toBe(false)
        const prompt = await MemoryPrompt.maybeSystem()
        expect(prompt.length).toBeGreaterThan(0)
        expect(prompt[0]).toContain("auto memory")
      },
    })
  })

  test("does not recall when extraction is off, even with a leftover auto_recall=true", async () => {
    await using tmp = await tmpdir({
      config: { memory: { auto_extract: false, auto_recall: true } },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await MemoryRecall.enabled()).toBe(false)
      },
    })
  })

  test("after deletion the main session instructions neither list the entry nor forbid recreating it", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const rel = "feedback/use-bun.md"
        const root = MemoryPath.directory()
        await fs.mkdir(path.join(root, "feedback"), { recursive: true })
        await Filesystem.write(
          path.join(root, rel),
          ["---", "name: 使用Bun作为包管理器", "description: bun", "type: feedback", "---", "", "bun"].join("\n"),
        )
        await MemoryManage.remove(path.join(root, rel))

        const prompt = (await MemoryPrompt.maybeSystem())[0] ?? ""
        expect(prompt).not.toContain("User-deleted")
        expect(prompt).not.toContain("使用Bun作为包管理器")
      },
    })
  })

  test("does not inject memory instructions when extraction is off and recall is not enabled", async () => {
    await using tmp = await tmpdir({
      config: { memory: { auto_extract: false } },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await MemoryPrompt.maybeSystem()).toEqual([])
        expect(await MemoryRecall.enabled()).toBe(false)
      },
    })
  })
})
