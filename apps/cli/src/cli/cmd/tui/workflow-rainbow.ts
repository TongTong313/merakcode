import { RGBA } from "@opentui/core"

export const WORKFLOW_RAINBOW_RULES = [
  ["extmark.workflow.rainbow.red", RGBA.fromInts(235, 95, 87)],
  ["extmark.workflow.rainbow.orange", RGBA.fromInts(245, 139, 87)],
  ["extmark.workflow.rainbow.yellow", RGBA.fromInts(250, 195, 95)],
  ["extmark.workflow.rainbow.green", RGBA.fromInts(145, 200, 130)],
  ["extmark.workflow.rainbow.blue", RGBA.fromInts(130, 170, 220)],
  ["extmark.workflow.rainbow.indigo", RGBA.fromInts(155, 130, 200)],
  ["extmark.workflow.rainbow.violet", RGBA.fromInts(200, 130, 180)],
] as const

export const WORKFLOW_RAINBOW_SCOPES = WORKFLOW_RAINBOW_RULES.map(([scope]) => scope)
