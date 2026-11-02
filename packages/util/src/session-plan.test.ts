import { expect, test } from "vitest"
import { startsSessionPlan } from "./session-plan"

test.each([
  "开始执行",
  " 开始实施！",
  "按最新计划执行。",
  "EXECUTE THE PLAN!",
  "Execute the latest saved session plan.",
])("recognizes an explicit plan start %s", (text) => expect(startsSessionPlan(text)).toBe(true))
test.each(["", "Review the plan", "开始执行前先分析", "start implementing after review"])(
  "keeps a non-start message %s",
  (text) => expect(startsSessionPlan(text)).toBe(false),
)
