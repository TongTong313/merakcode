import { type JSX } from "solid-js"
import { render } from "solid-js/web"
import { afterEach, beforeEach, expect, test } from "vitest"
import type { CollaborationGroup } from "@merakcode/sdk/client"
import { setLocale } from "../../i18n"
import { MemberColumn } from "./member-column"

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

const group: CollaborationGroup = {
  seats: [
    { id: "s1", name: "小主", role: "", duty: "", product: "merak", leader: true },
    { id: "s2", name: "小红", role: "产品经理", duty: "", product: "claude", leader: false },
  ],
  events: [],
  results: [],
  baseline: [],
  seq: 3,
}

test("collapsed, the column shows one avatar per member; clicking one asks to expand on that member", () => {
  const calls: unknown[] = []
  const host = mount(() => (
    <MemberColumn
      sessionID="s"
      directory="/project"
      group={group}
      products={[]}
      busy={(seatID) => seatID === "s2"}
      collapsed
      onCollapsed={(collapsed) => calls.push({ collapsed })}
      onOpen={(request) => calls.push({ target: request.target })}
    />
  ))
  const aside = host.querySelector("aside")!
  expect(aside.getAttribute("aria-label")).toBe("群成员")
  expect(aside.querySelector("input, textarea")).toBeNull()
  const faces = [...aside.querySelectorAll("button")].filter((item) =>
    ["小主", "小红"].includes(item.getAttribute("aria-label") ?? ""),
  )
  expect(faces.map((item) => item.getAttribute("aria-label"))).toEqual(["小主", "小红"])
  expect(aside.textContent).not.toContain("产品经理")
  faces[1]!.click()
  expect(calls).toEqual([{ target: "s2" }])
})

test("open, the column is titled Members; the count is shown once, on the top bar", () => {
  const host = mount(() => (
    <MemberColumn
      sessionID="s"
      directory="/project"
      group={group}
      products={[]}
      busy={() => false}
      collapsed={false}
      onCollapsed={() => {}}
      onOpen={() => {}}
    />
  ))
  expect(host.querySelector(".members-title")!.textContent).toBe("成员")
})
