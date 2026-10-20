import { describe, expect, test } from "vitest"
import {
  findWorkflowTriggerDisplayPositions,
  findWorkflowTriggerPositions,
} from "../../../src/cli/cmd/tui/component/prompt/workflow-trigger"

describe("workflow prompt trigger", () => {
  test("finds standalone workflow keywords", () => {
    expect(findWorkflowTriggerPositions("run a workflow for hot news")).toEqual([{ start: 6, end: 14 }])
    expect(findWorkflowTriggerPositions("WORKFLOW please")).toEqual([{ start: 0, end: 8 }])
  })

  test("ignores slash commands and path-like words", () => {
    expect(findWorkflowTriggerPositions("/workflow")).toEqual([])
    expect(findWorkflowTriggerPositions("open ./workflow/file")).toEqual([])
    expect(findWorkflowTriggerPositions("run ci-workflow")).toEqual([])
    expect(findWorkflowTriggerPositions("workflow?")).toEqual([])
  })

  test("ignores quoted and non-standalone occurrences", () => {
    expect(findWorkflowTriggerPositions("search 'workflow'")).toEqual([])
    expect(findWorkflowTriggerPositions("search [workflow]")).toEqual([])
    expect(findWorkflowTriggerPositions("workflows")).toEqual([])
    expect(findWorkflowTriggerPositions("myworkflow")).toEqual([])
  })

  test("highlights only workflow when adjacent to non-ascii words", () => {
    expect(findWorkflowTriggerPositions("\u8dd1\u4e00\u4e2aworkflow to analyze")).toEqual([{ start: 3, end: 11 }])
    expect(
      findWorkflowTriggerPositions("\u8fd0\u884c\u4e00\u4e2aworkflow\u53bb\u5b8c\u6210\u529f\u80fd\u4f18\u5316"),
    ).toEqual([{ start: 4, end: 12 }])
    expect(findWorkflowTriggerPositions("run workflow\u5206\u6790")).toEqual([{ start: 4, end: 12 }])
    expect(findWorkflowTriggerPositions("\u8dd1\u4e00\u4e2a workflow to analyze")).toEqual([{ start: 4, end: 12 }])
  })

  test("returns display-cell ranges for tui extmarks", () => {
    expect(findWorkflowTriggerDisplayPositions("\u8fd0\u884c\u4e00\u4e2aworkflow\u6765\u5b8c\u6210")).toEqual([
      { start: 8, end: 16 },
    ])
    expect(findWorkflowTriggerDisplayPositions("\u8dd1\u4e00\u4e2aworkflow to analyze")).toEqual([
      { start: 6, end: 14 },
    ])
  })

  test("supports keyword detection without agent routing", () => {
    expect(findWorkflowTriggerPositions("run a workflow for hot news")).toHaveLength(1)
    expect(findWorkflowTriggerPositions("search today's hot news")).toEqual([])
  })
})
