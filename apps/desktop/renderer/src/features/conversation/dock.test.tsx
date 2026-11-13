import { type JSX } from "solid-js"
import { render } from "solid-js/web"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { PermissionRequest, QuestionRequest } from "@merakcode/sdk/client"
import { setLocale } from "../../i18n"
import { Approval, Question } from "./dock"
vi.mock("undici", () => ({
  Agent: class {},
  fetch: async () => Response.json({ status: "unsupported", installable: true, reason: "Needs setup" }),
}))

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

test.each([
  [false, true, "是否生成官方计划？", 0],
  [true, true, "是否更新官方计划？", 3],
  [true, false, "是否更新官方计划？", 3],
] as const)("official plan approval shows update=%s and isolation=%s", (update, sandboxReady, title, revision) => {
  const host = mount(() => (
    <Approval
      request={{
        ...approval,
        permission: "plan_generate",
        patterns: ["/official.md"],
        sandboxReady,
        metadata: { planPath: "/official.md", update, expectedRevision: revision },
      }}
      more={0}
      directory="/p"
    />
  ))
  expect(host.querySelector(".what")?.textContent).toBe(title)
  expect(host.querySelector(".command")?.textContent).toContain(`${revision} → ${revision + 1}`)
  if (!sandboxReady) {
    expect(host.textContent).toContain("当前操作未隔离")
    expect(host.textContent).toContain("允许后将保存本次计划")
    expect(host.textContent).toContain("配置沙箱")
    expect(host.textContent).not.toContain("已启动")
    expect(
      [...host.querySelectorAll(".approval-actions button")]
        .filter((button) => button.querySelector("kbd"))
        .map((button) => button.textContent),
    ).toEqual([expect.stringContaining("允许这一次"), expect.stringContaining("拒绝")])
  }
})

test("leaving the sandbox uses the leave-sandbox title", () => {
  const host = mount(() => (
    <Approval
      request={{
        ...approval,
        permission: "bash",
        patterns: ["node -e 1"],
        sandboxReady: false,
        metadata: { command: "node -e 1", unsandboxed: true },
      }}
      more={0}
      directory="/p"
    />
  ))
  expect(host.querySelector(".what")?.textContent).toBe("要在沙箱外运行这条命令")
})
