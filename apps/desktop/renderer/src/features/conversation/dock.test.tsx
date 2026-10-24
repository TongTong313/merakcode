import { type JSX } from "solid-js"
import { render } from "solid-js/web"
import { afterEach, beforeEach, expect, test } from "vitest"
import type { PermissionRequest, QuestionRequest } from "@merakcode/sdk/client"
import { setLocale } from "../../i18n"
import { Approval, Question } from "./dock"

let cleanup = () => {}

beforeEach(() => setLocale("zh"))

afterEach(() => {
  cleanup()
  cleanup = () => {}
})

function mount(node: () => JSX.Element) {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(node, host)
  cleanup = () => {
    dispose()
    host.remove()
  }
  return host
}

const approval = {
  id: "per_1",
  sessionID: "g",
  permission: "network",
  patterns: ["example.com"],
  metadata: { url: "https://example.com" },
  always: true,
  grants: [],
} as unknown as PermissionRequest

const question = {
  id: "que_1",
  sessionID: "g",
  questions: [{ question: "用哪个数据库？", header: "数据库", options: [{ label: "SQLite", description: "" }] }],
} as unknown as QuestionRequest

test("an approval and a question from a member say which member asks", () => {
  const asked = mount(() => <Approval request={approval} more={0} directory="/p" from="小明 · Claude Code" />)
  expect(asked.querySelector(".approval-from")?.textContent).toBe("小明 · Claude Code 请求")
  cleanup()
  const questioned = mount(() => <Question request={question} directory="/p" from="小明 · Claude Code" />)
  expect(questioned.querySelector(".approval-from")?.textContent).toBe("小明 · Claude Code 提问")
})

test("without a member the approval reads as before", () => {
  const host = mount(() => <Approval request={approval} more={0} directory="/p" />)
  expect(host.querySelector(".approval-from")).toBeNull()
})
