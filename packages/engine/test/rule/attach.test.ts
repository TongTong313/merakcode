import { describe, expect, test } from "vitest"
import path from "path"
import { ContextAttach } from "@merakcode/engine/agent/context/context-attach"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { tmpdir } from "../fixture/fixture"
import { isolate, nativeRule } from "./isolate"
import { Filesystem } from "@merakcode/util/filesystem"

async function attach(filepath: string, overrides: Partial<ContextAttach.Input> = {}) {
  return ContextAttach.forFile({
    filepath,
    trigger: "read",
    messageID: "msg-" + Math.random().toString(36).slice(2),
    messages: [],
    ...overrides,
  })
}

describe("ContextAttach rules provider", () => {
  test("ships the rules provider alongside the AGENTS.md one", () => {
    expect(ContextAttach.registered().map((p) => p.id)).toContain("rules")
    expect(ContextAttach.registered().map((p) => p.id)).toContain("agents-md")
  })

  test("does not attach glob rules onto tool output", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await nativeRule(dir, "tsx.mdc", "alwaysApply: false\nglobs: src/**/*.tsx", "只写函数组件")
          await Filesystem.write(path.join(dir, "src", "a.tsx"), "export const A = () => null")
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const items = await attach(path.join(tmp.path, "src", "a.tsx"))
          expect(items.filter((item) => item.reason === "glob")).toEqual([])
        },
      })
    })
  })

  test("still attaches nested AGENTS.md", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Filesystem.write(path.join(dir, "pkg", "sub", "AGENTS.md"), "AGENTS")
          await Filesystem.write(path.join(dir, "pkg", "sub", "a.ts"), "const x = 1")
        },
      })
      await Instance.provide({
        directory: path.join(tmp.path, "pkg"),
        fn: async () => {
          const items = await attach(path.join(tmp.path, "pkg", "sub", "a.ts"))
          expect(ContextAttach.render(items)).toContain("AGENTS")
        },
      })
    })
  })
})

describe("ContextAttach.forSearchHits", () => {
  test("does not attach glob rules from search hits", async () => {
    await isolate(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await nativeRule(dir, "ts.mdc", "alwaysApply: false\nglobs: src/**/*.ts", "TS 规范")
          await Filesystem.write(path.join(dir, "src", "a.ts"), "const a = 1")
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const items = await ContextAttach.forSearchHits({
            files: [path.join(tmp.path, "src", "a.ts")],
            messageID: "msg-search",
            messages: [],
          })
          expect(items.filter((item) => item.reason === "glob")).toEqual([])
          ContextAttach.clear("msg-search")
        },
      })
    })
  })
})
