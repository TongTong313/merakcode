import { type JSX } from "solid-js"
import { render } from "solid-js/web"
import { afterEach, beforeEach, expect, test } from "vitest"
import { setLocale } from "../../i18n"
import { GroupTodo } from "./group-todo"

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

const todo = (content: string, status: string) => ({ id: content, content, status, priority: "medium" })

test("the pinned todo shows progress and the current item, and opens into a checklist without cancelled items", () => {
  const host = mount(() => (
    <GroupTodo
      todos={[
        todo("@小红 做登录 (src/auth/**)", "completed"),
        todo("@abc 做支付 (src/pay/**)", "in_progress"),
        todo("补退款说明", "pending"),
        todo("旧方案", "cancelled"),
      ]}
    />
  ))
  const head = host.querySelector("button")!
  expect(head.textContent).toContain("待办 1/3")
  expect(head.textContent).toContain("正在做 @abc 做支付 (src/pay/**)")
  expect(host.querySelectorAll("li")).toHaveLength(0)
  head.click()
  expect([...host.querySelectorAll("li")].map((item) => [item.dataset.status, item.textContent])).toEqual([
    ["completed", "@小红 做登录 (src/auth/**)"],
    ["in_progress", "@abc 做支付 (src/pay/**)"],
    ["pending", "补退款说明"],
  ])
})

test("no todo, no bar", () => {
  const host = mount(() => <GroupTodo todos={[todo("旧方案", "cancelled")]} />)
  expect(host.textContent).toBe("")
})
