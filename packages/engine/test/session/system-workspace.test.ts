import { afterEach, describe, expect, test } from "vitest"
import { Instance } from "@merakcode/engine/project/instance"
import { SystemPrompt } from "@merakcode/engine/session/system"
import { tmpdir } from "../fixture/fixture"

describe("SystemPrompt.userContext multi-root", () => {
  afterEach(async () => {
    await Instance.disposeAll().catch(() => undefined)
  })

  test("single root shows only the working directory, without a workspace folder list", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ctx = await SystemPrompt.userContext()
        const text = ctx.join("\n")
        expect(text).toContain(`Working directory: ${Instance.directory}`)
        expect(text).not.toContain("Workspace folders:")
        expect(text).not.toContain("Primary working directory:")
      },
    })
  })

  test("multiple roots list every folder and the primary", async () => {
    await using a = await tmpdir({ git: true })
    await using b = await tmpdir({ git: true })
    await Instance.provide({
      directory: a.path,
      workspace: {
        folders: [
          { name: "alpha", path: a.path },
          { name: "beta", path: b.path },
        ],
      },
      fn: async () => {
        const ctx = await SystemPrompt.userContext()
        const text = ctx.join("\n")
        expect(text).toContain("Primary working directory:")
        expect(text).toContain("Workspace folders:")
        expect(text).toContain("alpha:")
        expect(text).toContain("beta:")
        expect(text).toContain(a.path)
        expect(text).toContain(b.path)
      },
    })
  })
})
