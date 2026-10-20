import { describe, expect, test } from "vitest"
import { WorkflowScriptParser } from "@merakcode/engine/workflow/script"

describe("WorkflowScriptParser", () => {
  test("parses literal meta and body", () => {
    const parsed = WorkflowScriptParser.parse({
      script: `
				// leading trivia
				export const meta = {
					name: 'demo',
					description: 'Demo workflow',
					concurrency: 3,
					phases: ['Plan', { title: 'Build', detail: 'write code', model: 'provider/model' }]
				}

				phase('Plan')
			`,
    })
    expect(parsed.name).toBe("demo")
    expect(parsed.description).toBe("Demo workflow")
    expect(parsed.maxConcurrentAgents).toBe(3)
    expect(parsed.phases).toEqual([
      { title: "Plan" },
      { title: "Build", detail: "write code", model: "provider/model" },
    ])
    expect(parsed.body).toContain("phase('Plan')")
  })

  test("rejects invalid concurrency", () => {
    expect(() =>
      WorkflowScriptParser.parse({
        script: `
					export const meta = { name: 'demo', description: 'Demo', concurrency: 0 }
				`,
      }),
    ).toThrow("concurrency")
  })

  test("rejects non-literal meta", () => {
    expect(() =>
      WorkflowScriptParser.parse({
        script: `
					export const meta = {
						name: 'demo',
						description: getDescription()
					}
				`,
      }),
    ).toThrow("literal")
  })

  test("rejects imports and exports in body", () => {
    expect(() =>
      WorkflowScriptParser.parse({
        script: `
					export const meta = { name: 'demo', description: 'Demo' }
					export const other = 1
				`,
      }),
    ).toThrow("import or export")
  })

  test("explains that only the leading meta export is allowed", () => {
    expect(() =>
      WorkflowScriptParser.parse({
        script: `
					export const meta = { name: 'demo', description: 'Demo' }
					import path from 'path'
				`,
      }),
    ).toThrow("only allowed export")
  })

  test("rejects export default function wrappers", () => {
    expect(() =>
      WorkflowScriptParser.parse({
        script: `
					export const meta = { name: 'demo', description: 'Demo' }
					export default async function ({ agent }) {
						return await agent('scan')
					}
				`,
      }),
    ).toThrow("import or export")
  })

  test("allows import and export words inside prompt strings", () => {
    const parsed = WorkflowScriptParser.parse({
      script: `
				export const meta = { name: 'demo', description: 'Demo' }
				const prompt = 'explain import and export syntax'
				await log(prompt)
			`,
    })
    expect(parsed.body).toContain("import and export")
  })

  test("rejects nondeterministic APIs", () => {
    expect(() =>
      WorkflowScriptParser.parse({
        script: `
					export const meta = { name: 'demo', description: 'Demo' }
					const now = Date.now()
				`,
      }),
    ).toThrow("deterministic")
  })

  test("allows forbidden words inside prompt strings", () => {
    const parsed = WorkflowScriptParser.parse({
      script: `
				export const meta = { name: 'demo', description: 'Demo' }
				const prompt = 'process each item without mentioning constructor details'
				await log(prompt)
			`,
    })
    expect(parsed.body).toContain("process each item")
  })

  test("allows host/global identifiers and leaves runtime sandboxing to vm context", () => {
    const parsed = WorkflowScriptParser.parse({
      script: `
				export const meta = { name: 'demo', description: 'Demo' }
				const escape = this.constructor
				const prompt = \`value: \${process.env.HOME}\`
			`,
    })
    expect(parsed.body).toContain("this.constructor")
    expect(parsed.body).toContain("process.env.HOME")
  })

  test("tolerates a leading BOM and block comments around meta", () => {
    // skipTrivia skips both the BOM (0xFEFF) and block comments, so the header is still recognized
    const bom = "﻿"
    const parsed = WorkflowScriptParser.parse({
      script: `${bom}/* file header */\nexport const meta = { name: 'bom', description: 'BOM + block comment' }\nreturn 1`,
    })
    expect(parsed.name).toBe("bom")
    expect(parsed.body).toContain("return 1")
  })

  test("rejects spread elements in meta object", () => {
    expect(() =>
      WorkflowScriptParser.parse({
        script: `export const meta = { name: 'demo', description: 'Demo', ...extra }`,
      }),
    ).toThrow("spread or computed keys")
  })

  test("rejects computed keys in meta object", () => {
    expect(() =>
      WorkflowScriptParser.parse({
        script: `export const meta = { name: 'demo', description: 'Demo', ['dyn']: 1 }`,
      }),
    ).toThrow("spread or computed keys")
  })

  test("rejects phases whose entries lack a title", () => {
    expect(() =>
      WorkflowScriptParser.parse({
        script: `export const meta = { name: 'demo', description: 'Demo', phases: [{ detail: 'no title' }] }`,
      }),
    ).toThrow("must have a title")
  })

  test("rejects empty string phase entries", () => {
    expect(() =>
      WorkflowScriptParser.parse({
        script: `export const meta = { name: 'demo', description: 'Demo', phases: ['  '] }`,
      }),
    ).toThrow("must have a title")
  })

  test("rejects meta without a name", () => {
    expect(() =>
      WorkflowScriptParser.parse({
        script: `export const meta = { description: 'Demo' }`,
      }),
    ).toThrow("name must be a non-empty string")
  })

  test("rejects meta without a description", () => {
    expect(() =>
      WorkflowScriptParser.parse({
        script: `export const meta = { name: 'demo' }`,
      }),
    ).toThrow("description must be a non-empty string")
  })

  test("rejects non-array phases", () => {
    expect(() =>
      WorkflowScriptParser.parse({
        script: `export const meta = { name: 'demo', description: 'Demo', phases: 'Plan' }`,
      }),
    ).toThrow("phases must be an array")
  })

  test("rejects concurrency above the upper bound", () => {
    expect(() =>
      WorkflowScriptParser.parse({
        script: `export const meta = { name: 'demo', description: 'Demo', concurrency: 1001 }`,
      }),
    ).toThrow("concurrency")
  })
})
