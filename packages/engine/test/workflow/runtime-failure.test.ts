import { describe, expect, test } from "vitest"
import { Instance } from "@merakcode/engine/infra/project/instance"
import { WorkflowRuntime } from "@merakcode/engine/app/task/workflow/runtime"
import { WorkflowScriptParser } from "@merakcode/engine/app/task/workflow/script"
import { tmpdir } from "../fixture/fixture"

/**
 * When the workflow body throws at runtime (e.g. "require is not defined" from a generated script using Node APIs),
 * the final metadata must settle on failed. A last hooks.update still reporting running means the run got stuck.
 */
describe("WorkflowRuntime failure state", () => {
  test("final hooks.update reports failed when the body throws (require is not defined)", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const script = WorkflowScriptParser.parse({
          script:
            `export const meta = { name: "t", description: "d" }\n` +
            `const fs = require('fs'); fs.writeFileSync('x','y')`,
        })
        const updates: Array<{ status: string; error?: string }> = []
        try {
          await WorkflowRuntime.run({
            script,
            args: undefined,
            sessionID: "s-" + Math.random().toString(36).slice(2),
            messageID: "m",
            abort: new AbortController().signal,
            defaultModel: { providerID: "x", modelID: "y" },
            hooks: {
              update: async (m) => {
                updates.push({ status: m.status, error: m.error })
              },
            },
          })
        } catch {
          // run rethrows after the update
        }
        console.log("UPDATES:", JSON.stringify(updates))
        expect(updates.at(-1)?.status).toBe("failed")
        expect(updates.at(-1)?.error).toContain("require is not defined")
        // The error is rewritten to explain the sandbox restriction
        expect(updates.at(-1)?.error?.toLowerCase()).toContain("sandbox")
      },
    })
  })
})

describe("WorkflowRuntime.explainWorkflowError", () => {
  test("adds a sandbox note when Node globals such as require or process are undefined", () => {
    const r1 = WorkflowRuntime.explainWorkflowError("ReferenceError: require is not defined")
    expect(r1).toContain("require is not defined")
    expect(r1.toLowerCase()).toContain("sandbox")
    expect(r1.toLowerCase()).toContain("child agent")
    const r2 = WorkflowRuntime.explainWorkflowError("process is not defined")
    expect(r2.toLowerCase()).toContain("sandbox")
  })

  test("returns other errors unchanged so script typos are not blamed on the sandbox", () => {
    expect(WorkflowRuntime.explainWorkflowError("boom")).toBe("boom")
    expect(WorkflowRuntime.explainWorkflowError("myLocalVar is not defined")).toBe("myLocalVar is not defined")
  })
})
