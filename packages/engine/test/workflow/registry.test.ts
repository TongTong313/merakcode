import { describe, expect, test } from "vitest"
import fs from "fs/promises"
import path from "path"
import { Instance } from "@merakcode/engine/project/instance"
import { WorkflowRegistry } from "@merakcode/engine/workflow/registry"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

describe("WorkflowRegistry", () => {
  test("loads valid workflows and reports parse errors by file name", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, ".merakcode", "workflows"), { recursive: true })
        await Filesystem.write(
          path.join(dir, ".merakcode", "workflows", "valid-by-file.js"),
          [
            "export const meta = {",
            "  name: 'valid-workflow',",
            "  description: 'Valid workflow'",
            "}",
            "return 'ok'",
          ].join("\n"),
        )
        await Filesystem.write(
          path.join(dir, ".merakcode", "workflows", "broken-workflow.js"),
          [
            "export const meta = {",
            "  name: 'broken-workflow',",
            "  description: 'Broken workflow'",
            "}",
            "export default async function () {}",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect((await WorkflowRegistry.get("valid-workflow"))?.name).toBe("valid-workflow")
        expect((await WorkflowRegistry.get("valid-by-file"))?.name).toBe("valid-workflow")

        const error = await WorkflowRegistry.getLoadError("broken-workflow")
        expect(error?.path).toContain("broken-workflow.js")
        expect(error?.error).toContain("import or export")
      },
    })
  })

  test("list returns all loaded workflows and valid scripts have no load error", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, ".merakcode", "workflows"), { recursive: true })
        await Filesystem.write(
          path.join(dir, ".merakcode", "workflows", "alpha.js"),
          ["export const meta = {", "  name: 'alpha',", "  description: 'Alpha workflow'", "}", "return 'ok'"].join(
            "\n",
          ),
        )
        await Filesystem.write(
          path.join(dir, ".merakcode", "workflows", "beta.js"),
          ["export const meta = {", "  name: 'beta',", "  description: 'Beta workflow'", "}", "return 'ok'"].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const scripts = await WorkflowRegistry.list()
        const names = scripts.map((script) => script.name).toSorted()
        expect(names).toEqual(["alpha", "beta"])

        expect(await WorkflowRegistry.getLoadError("alpha")).toBeUndefined()
      },
    })
  })

  test("get returns undefined for an unknown workflow name", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await WorkflowRegistry.get("does-not-exist")).toBeUndefined()
        expect(await WorkflowRegistry.getLoadError("does-not-exist")).toBeUndefined()
      },
    })
  })

  test("trims a leading slash when resolving workflow by name", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, ".merakcode", "workflows"), { recursive: true })
        await Filesystem.write(
          path.join(dir, ".merakcode", "workflows", "slashy.js"),
          ["export const meta = {", "  name: 'slashy',", "  description: 'Slashy workflow'", "}", "return 'ok'"].join(
            "\n",
          ),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // get() strips a leading '/' and still matches by name
        expect((await WorkflowRegistry.get("/slashy"))?.name).toBe("slashy")
      },
    })
  })
})
