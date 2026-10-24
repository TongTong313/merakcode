import { type JSX } from "solid-js"
import { render } from "solid-js/web"
import { afterEach, beforeEach, expect, test } from "vitest"
import { setLocale } from "../../i18n"
import { setUi, ui } from "../../state/ui"
import { MemberList, type Product, type SeatDraft, type Seat } from "./members"

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

const seats: Seat[] = [
  { id: "s1", name: "小主", role: "", duty: "负责分派", product: "merak", leader: true },
  { id: "s2", name: "小红", role: "产品经理", duty: "负责登录", product: "claude", leader: false },
]
const products: Product[] = [
  { id: "merak", title: "MerakCode", connected: true, enabled: true, builtin: true, source: "builtin" },
  { id: "claude", title: "Claude Code", connected: true, enabled: true, builtin: true, source: "builtin" },
]

const button = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll("button")].find((item) => item.textContent?.trim() === name)
/** One row per member; the row toggles that member open */
const rows = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")]
const field = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll("label")]
    .find((item) => item.textContent?.startsWith(label))!
    .querySelector("input, textarea") as HTMLInputElement
const type = (element: HTMLInputElement, value: string) => {
  element.value = value
  element.dispatchEvent(new InputEvent("input", { bubbles: true }))
}

test("clicking a member opens its name, role and duty; role and duty can be cleared and a long duty is kept", () => {
  const saved: SeatDraft[] = []
  const host = mount(() => (
    <MemberList
      seats={seats}
      products={products}
      onSave={(_seat, draft) => saved.push(draft)}
      onAdd={() => undefined}
      onRemove={() => undefined}
    />
  ))
  rows(host)[1]!.click()
  const duty = "负责登录模块。\n".repeat(40)
  type(field(host, "角色"), "")
  type(field(host, "职责"), duty)
  button(host, "保存")!.click()
  expect(saved).toEqual([{ name: "小红", role: "", duty: duty.trim(), product: "claude" }])
})

test("the leader cannot be removed and another member can", () => {
  const removed: string[] = []
  const host = mount(() => (
    <MemberList
      seats={seats}
      products={products}
      onSave={() => undefined}
      onAdd={() => undefined}
      onRemove={(seat) => removed.push(seat.name)}
    />
  ))
  rows(host)[0]!.click()
  expect(button(host, "移出")).toBeUndefined()
  rows(host)[1]!.click()
  button(host, "移出")!.click()
  expect(removed).toEqual(["小红"])
})

test("a new member needs a single-word name nobody else uses; the reason is shown", () => {
  const added: SeatDraft[] = []
  const host = mount(() => (
    <MemberList
      seats={seats}
      products={products}
      onSave={() => undefined}
      onAdd={(draft) => added.push(draft)}
      onRemove={() => undefined}
    />
  ))
  button(host, "添加成员")!.click()
  const join = () => button(host, "加入")!
  expect(join().disabled).toBe(true)
  type(field(host, "姓名"), "小 刚")
  expect(host.textContent).toContain("姓名里不能有空格或 @")
  expect(join().disabled).toBe(true)
  type(field(host, "姓名"), "小红")
  expect(host.textContent).toContain("已有成员叫这个名字")
  type(field(host, "姓名"), "小刚")
  join().click()
  expect(added).toEqual([{ name: "小刚", role: "", duty: "", product: "claude" }])
})

test("the product picker leaves out what is turned off, marks what does not run as unavailable, and links to why", () => {
  setUi("newTeam", true)
  const host = mount(() => (
    <MemberList
      seats={seats}
      products={[
        ...products,
        {
          id: "codex",
          title: "Codex",
          connected: false,
          enabled: true,
          builtin: true,
          source: "builtin",
          reason: "spawn codex.exe ENOENT",
        },
        { id: "opencode", title: "OpenCode", connected: true, enabled: false, builtin: true, source: "builtin" },
      ]}
      onSave={() => undefined}
      onAdd={() => undefined}
      onRemove={() => undefined}
    />
  ))
  button(host, "添加成员")!.click()
  host
    .querySelector("button[aria-haspopup]")!
    .dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, pointerType: "mouse" }))
  const options = [...document.querySelectorAll("[role=option]")]
  expect(options.some((item) => item.textContent?.includes("OpenCode"))).toBe(false)
  const codex = options.find((item) => item.textContent?.includes("Codex"))!
  expect(codex.getAttribute("aria-disabled")).toBe("true")
  expect(codex.textContent).toContain("不可用")
  expect(codex.textContent).not.toContain("ENOENT")
  button(host, "部分产品不可用 · 查看原因")!.click()
  expect(ui.settings).toBe("collaboration")
  expect(ui.newTeam).toBe(false)
})

test("while the products are still being checked, the leader reads as MerakCode and the form says it is checking", () => {
  const host = mount(() => (
    <MemberList
      seats={seats}
      products={[]}
      onSave={() => undefined}
      onAdd={() => undefined}
      onRemove={() => undefined}
    />
  ))
  expect(rows(host)[0]!.textContent).toContain("MerakCode")
  button(host, "添加成员")!.click()
  expect(host.textContent).toContain("正在检测本机的 CLI…")
  expect(button(host, "加入")!.disabled).toBe(true)
})

test("the add form closes with its own × and has no second cancel", () => {
  const host = mount(() => (
    <MemberList
      seats={seats}
      products={products}
      onSave={() => undefined}
      onAdd={() => undefined}
      onRemove={() => undefined}
    />
  ))
  button(host, "添加成员")!.click()
  expect(button(host, "取消")).toBeUndefined()
  host.querySelector<HTMLButtonElement>("button[aria-label='取消添加']")!.click()
  expect(button(host, "加入")).toBeUndefined()
  expect(button(host, "添加成员")).toBeDefined()
})

test("an older CLI is still offered, with its version and a hint to upgrade", () => {
  const host = mount(() => (
    <MemberList
      seats={seats}
      products={[
        ...products,
        {
          id: "codex",
          title: "Codex",
          connected: true,
          enabled: true,
          builtin: true,
          source: "builtin",
          version: "codex-cli 0.77.0",
          recommended: "0.164.0",
          upgrade: "codex update",
          outdated: true,
        },
      ]}
      onSave={() => undefined}
      onAdd={() => undefined}
      onRemove={() => undefined}
    />
  ))
  button(host, "添加成员")!.click()
  host
    .querySelector("button[aria-haspopup]")!
    .dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, pointerType: "mouse" }))
  const codex = [...document.querySelectorAll("[role=option]")].find((item) => item.textContent?.includes("Codex"))!
  expect(codex.getAttribute("aria-disabled")).not.toBe("true")
  expect(codex.textContent).toContain("codex-cli 0.77.0 · 版本较低，建议升级")
  ;(codex as HTMLElement).dispatchEvent(
    new PointerEvent("pointerup", { button: 0, bubbles: true, pointerType: "mouse" }),
  )
  ;(codex as HTMLElement).click()
  expect(host.textContent).toContain("当前 codex-cli 0.77.0，建议升级到 0.164.0 及以上以保证正常运行（codex update）")
})
