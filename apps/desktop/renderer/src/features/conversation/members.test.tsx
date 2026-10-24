import { type JSX } from "solid-js"
import { render } from "solid-js/web"
import { afterEach, expect, test } from "vitest"
import type { Part } from "@merakcode/sdk/client"
import { askedBy, Avatar, mentionChoices, type Product } from "./members"

let cleanup = () => {}

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

const avatar = (id: string, name: string) => {
  const host = mount(() => <Avatar id={id} name={name} />)
  const span = host.querySelector("span")!
  const result = { text: span.textContent, hue: Number(span.style.getPropertyValue("--hue")) }
  cleanup()
  return result
}

test("an avatar shows the last two characters of a Chinese name and the first letter of a Latin one", () => {
  expect(avatar("s2", "小红").text).toBe("小红")
  expect(avatar("s3", "欧阳小明").text).toBe("小明")
  expect(avatar("s4", "abc").text).toBe("A")
})

test("members added one after another get clearly different colors, and a rename keeps the color", () => {
  const hues = ["s2", "s3", "s4"].map((id) => avatar(id, "小红").hue)
  for (const [index, hue] of hues.entries()) {
    const other = hues[(index + 1) % hues.length]!
    expect(Math.min(Math.abs(hue - other), 360 - Math.abs(hue - other))).toBeGreaterThan(40)
  }
  expect(avatar("s2", "小芳").hue).toBe(hues[0])
})

test("@ lists members with product and role, and does not offer a product that has no member", () => {
  const seats = [
    { name: "小红", product: "claude", role: "产品经理" },
    { name: "小刚", product: "claude", role: "" },
    { name: "小主", product: "merak", role: "" },
  ]
  const products: Product[] = [
    { id: "merak", title: "MerakCode", connected: true, enabled: true, builtin: true, source: "builtin" },
    { id: "claude", title: "Claude Code", connected: true, enabled: true, builtin: true, source: "builtin" },
    { id: "codex", title: "Codex", connected: true, enabled: true, builtin: true, source: "builtin" },
    { id: "opencode", title: "OpenCode", connected: false, enabled: true, builtin: true, source: "builtin" },
  ]
  expect(mentionChoices("", seats, products)).toEqual([
    { name: "小红", detail: "Claude Code · 产品经理" },
    { name: "小刚", detail: "Claude Code" },
    { name: "小主", detail: "MerakCode" },
  ])
  expect(mentionChoices("红", seats, products)).toEqual([{ name: "小红", detail: "Claude Code · 产品经理" }])
  expect(mentionChoices("codex", seats, products)).toEqual([])
})

test("a request from a member's call names the member and its product; the leader's own requests name no one", () => {
  const seats = [
    { id: "s1", name: "小主", role: "", duty: "", product: "merak", leader: true },
    { id: "s2", name: "小明", role: "产品经理", duty: "", product: "claude", leader: false },
  ]
  const products: Product[] = [
    { id: "claude", title: "Claude Code", connected: true, enabled: true, builtin: true, source: "builtin" },
  ]
  const parts = [
    { type: "tool", tool: "delegate", callID: "c1", state: { input: { seat: "小明" }, metadata: { seatID: "s2" } } },
    { type: "tool", tool: "bash", callID: "c2", state: { input: { command: "ls" } } },
  ] as unknown as Part[]
  expect(askedBy("c1", parts, seats, products)).toBe("小明 · Claude Code · 产品经理")
  expect(askedBy("c2", parts, seats, products)).toBeUndefined()
  expect(askedBy(undefined, parts, seats, products)).toBeUndefined()
})
